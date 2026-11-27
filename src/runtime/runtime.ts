import type { Message, RequestOptions } from '../model/types.js';
import { Mind, type Thought } from '../domain/mind.js';
import { Journal, type Bubble, type Turn } from '../storage/journal.js';
import { evolveSelf } from '../domain/state.js';
import { Wakeup, type TimerClock } from './wakeup.js';

export interface RuntimeOptions {
  persona(): string;
  material(turn: Turn): Promise<unknown> | unknown;
  /** 返回投递结果；failed 时第二个返回值（可选）是失败原因，落
   *  last_error 供材料还原"为什么没送到"。 */
  send(
    peer: string,
    part: Bubble,
  ): Promise<'sent' | 'unknown' | 'failed' | ['failed' | 'unknown', string]>;
  nextBeat(peer: string): number | undefined;
  /** 提醒重排的时刻下限：装配层把睡眠窗折进来（内核不懂时区）——凌晨
   *  到期的提醒推到她醒来，而不是整夜空转。 */
  reminderFloor?(): number;
  onComposing?(peer: string, active: boolean): Promise<void>;
  onError(error: unknown): void;
  timeoutMs: number | (() => number);
  /** 入站消息的可用时刻；参数是这条消息的文本（半句判定用）。缺省
   *  now+debounce。注入时完全接管——睡眠窗把深夜消息推迟到醒来、
   *  半句话多等一拍，都是装配层的事，内核不懂时区与语感。 */
  incomingDue?(content: string): number;
  debounceMs?: number | (() => number);
  concurrency: number | (() => number);
  /** 气泡间隔的行走时间：第 2 条起按长度停顿，像在打字。 */
  pacing: boolean | (() => boolean);
  /** 开口反应时长：思考产出首个气泡后到发送前停顿的一小段（她"想了
   *  一下"才说，与思考并行不串行）。装配层按对话账面算热冷注入
   *  （reactionDelay：2 分钟内有来往 0.8–2s，冷启动/心跳 1–4s）；
   *  不注入则气泡闭合即发（测试直连）。 */
  reactionMs?(peer: string): number;
  /** 当前可用的表情 slug（发送前校验，目录外的贴纸不投递）。 */
  stickerSlugs(): Set<string>;
  /** 视觉开启时，历史里的图片以 data URI 随消息注入。 */
  vision(): boolean;
  readFile(peer: string, path: string, maxBytes: number): Promise<Buffer | undefined>;
  /** 定时时钟：模拟与测试注入假钟，生产留空用真实定时器。 */
  clock?: TimerClock;
}

const numeric = (value: number | (() => number)): number =>
  typeof value === 'function' ? value() : value;
const delay = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

/** 气泡间隔：长度即打字时间。短气泡接得快，长气泡让人等——节奏是人味
 *  的一部分，不是限流。 */
function pacingMs(part: Bubble, random: () => number = Math.random): number {
  const length = part.type === 'text' ? (part.text ?? '').length : 8;
  const base = length <= 10 ? 1400 : length <= 30 ? 2400 : length <= 80 ? 4200 : 6800;
  return Math.round(base * (0.85 + random() * 0.3));
}

/** 开口反应时长（beta reactionMs 语义）：2 分钟内有来往 0.8–2s（热对话，
 *  接得快），冷启动/心跳 1–4s（她想了一下才说）。热冷判定读对话账面的
 *  最近一条 created_at，received/said 都算来往。 */
export function reactionDelay(
  lastContactAt: number | undefined,
  now: number,
  random: () => number = Math.random,
): number {
  const warm = lastContactAt !== undefined && now - lastContactAt < 120_000;
  return Math.round(warm ? 800 + random() * 1200 : 1000 + random() * 3000);
}

/** 气泡清洗：即时聊天把 markdown 原样显示（**加粗**、`代码`、# 标题），
 *  模型偶尔夹带的排版符号会变成字面噪声；句末句号在即时聊天里是疏离感，
 *  连续句号收敛成一个后整体剥掉——「好。」变成「好」，省略号保留。
 *  只剥表面记号不动内容。beta 实测的私聊质感。 */
export function cleanBubbleText(text: string): string {
  const cleaned = text
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|\s)\*([^*\s][^*]*)\*(?=\s|$|[。，！？、,.!?])/g, '$1$2')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1');
  return cleaned.replace(/[。]+$/u, '').trimEnd();
}

export class Runtime {
  private readonly active = new Map<
    string,
    { controller: AbortController; promise: Promise<void> }
  >();
  private readonly wakeup: Wakeup;
  private stopped = true;

  constructor(
    private readonly journal: Journal,
    private readonly mind: Mind,
    private readonly options: RuntimeOptions,
  ) {
    this.wakeup = options.clock
      ? new Wakeup(() => this.scan(), options.onError, options.clock)
      : new Wakeup(() => this.scan(), options.onError);
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.journal.recover();
    this.wakeup.wake();
  }

  receive(peer: string, key: string, content: string): boolean {
    const accepted = this.journal.receive(
      peer,
      key,
      content,
      this.options.incomingDue?.(content) ?? Date.now() + numeric(this.options.debounceMs ?? 0),
    );
    if (accepted) {
      this.active.get(peer)?.controller.abort();
      this.wakeup.wake();
    }
    return accepted;
  }

  schedule(peer: string, dueAt: number): void {
    this.journal.schedule(peer, 'beat', dueAt);
    this.wakeup.wake();
  }

  resolveDelivery(id: string, status: 'sent' | 'failed'): boolean {
    const changed = this.journal.delivery(id, status);
    if (changed) this.wakeup.wake();
    return changed;
  }

  private async scan(): Promise<number | undefined> {
    if (this.stopped) return;
    const jobs = this.journal.jobs();
    const peers = new Set([
      ...this.journal.deliveryPeers(),
      ...jobs.filter((job) => job.due_at <= Date.now()).map((job) => job.peer),
    ]);
    for (const peer of peers) {
      if (this.active.size >= Math.max(1, numeric(this.options.concurrency))) break;
      if (this.active.has(peer)) continue;
      if (
        this.journal.blocked(peer) &&
        !jobs.some((job) => job.peer === peer && job.due_at <= Date.now())
      )
        continue;
      const controller = new AbortController();
      // 微任务启动，确保同步完成路径也能在 finally 前注册 active。
      const promise = Promise.resolve()
        .then(() => this.work(peer, controller.signal))
        .catch(this.options.onError)
        .finally(() => {
          this.active.delete(peer);
          if (!this.stopped) this.wakeup.wake();
        });
      this.active.set(peer, { controller, promise });
    }
    const future = jobs.filter((job) => !this.active.has(job.peer) && job.due_at > Date.now());
    return future.length ? Math.min(...future.map((job) => job.due_at)) : undefined;
  }

  /** 历史消息：received/said 事件还原成对话；视觉开启时**最近两条**
   *  含图消息的图片以 data URI 注入（每条 ≤2 张、≤5 MB，读不到就只留
   *  文字标记）。更早的图只留标记：人不会记得三个月前那张图的样子，
   *  而历史图片每拍全价计费等于反复为同一张图买单。 */
  private async history(peer: string): Promise<Message[]> {
    const vision = this.options.vision();
    const conversation = this.journal.conversation(peer, 160);
    const visualIds = new Set<string>();
    if (vision)
      for (let i = conversation.length - 1; i >= 0 && visualIds.size < 2; i--) {
        const event = conversation[i]!;
        if (event.kind === 'received' && event.content.includes('"media"')) visualIds.add(event.id);
      }
    const messages: Message[] = [];
    for (const event of conversation) {
      if (event.kind === 'received') {
        let content = event.content;
        const images: string[] = [];
        try {
          const parsed = JSON.parse(event.content) as {
            text?: string;
            media?: { path?: string; mime?: string }[];
          };
          if (parsed && typeof parsed === 'object' && typeof parsed.text === 'string') {
            content = parsed.text;
            if (vision && visualIds.has(event.id) && parsed.media?.length)
              for (const item of parsed.media.slice(0, 2)) {
                if (!item.path || !item.mime?.startsWith('image/')) continue;
                try {
                  const bytes = await this.options.readFile(peer, item.path, 5 * 1024 * 1024);
                  if (bytes) images.push(`data:${item.mime};base64,${bytes.toString('base64')}`);
                } catch {
                  /* 读不到的图片只留文字标记 */
                }
              }
          }
        } catch {
          /* 纯文本事件 */
        }
        messages.push({ role: 'user', content, ...(images.length ? { images } : {}) });
        continue;
      }
      let content = event.content;
      try {
        const part = JSON.parse(event.content) as Bubble;
        content =
          part.type === 'text' ? (part.text ?? '') : `[${part.type}:${part.slug ?? part.path}]`;
      } catch {
        /* 原样 */
      }
      messages.push({ role: 'assistant', content });
    }
    return messages;
  }

  private async work(peer: string, signal: AbortSignal): Promise<void> {
    // "输入中"的生命周期 = 从她开始想到气泡说出口：思考（含主动拍）一
    // 开始就显示——想的时候就是在打字（v3 语义）；气泡到达前清除；多气
    // 泡之间重新显示并按长度停顿。夜里独处的 diary/tidy 不显示。
    // 打字请求带 8 秒硬顶：fetch 偶发挂起时不守 timeout，一条卡住的指示
    // 请求曾把整条思考链冻在 active 里，她对谁都再也不回。
    const composing = (active: boolean): Promise<void> =>
      Promise.race([
        Promise.resolve(this.options.onComposing?.(peer, active)).then(
          () => undefined,
          () => undefined,
        ),
        delay(8000),
      ]);
    const pacingOn =
      typeof this.options.pacing === 'function' ? this.options.pacing() : this.options.pacing;
    let first = true;
    /** 发送 pending 队首件（pacing/开口反应/清洗/落账一条龙）。返回 false
     *  表示停止发送：unknown 封通道、领件失败或被打断。 */
    const tryDeliver = async (): Promise<boolean> => {
      const envelope = this.journal.pending(peer)[0];
      if (!envelope) return true;
      if (pacingOn && !first) {
        // 气泡间隔在占用发送位之前进行：被取消就保持待发，下次接着发。
        await composing(true);
        await delay(pacingMs(envelope.part), signal);
        if (signal.aborted || this.stopped) return false;
      }
      if (first && this.options.reactionMs) {
        // 首气泡的开口反应（她"想了一下"才说）：与思考并行时这是免费的
        // 停顿——生成还在进行，不串行加时；等 think 收口后才走到这里
        // （全量路径）就是一小段人类节奏的延迟。
        await delay(Math.max(0, this.options.reactionMs(peer)), signal);
        if (signal.aborted || this.stopped) return false;
      }
      await composing(false);
      if (!this.journal.startDelivery(envelope.id)) return false;
      first = false;
      // 发送前的同一把清洗尺：渐进与全量路径的气泡都在这里去 markdown
      // 记号与句末句号——洗的是投递面，账面（历史/回执）保留原样可核实。
      const part =
        envelope.part.type === 'text'
          ? { ...envelope.part, text: cleanBubbleText(envelope.part.text ?? '') }
          : envelope.part;
      let status: 'sent' | 'unknown' | 'failed';
      let reason: string | undefined;
      try {
        const result = await this.options.send(peer, part);
        if (Array.isArray(result)) [status, reason] = result;
        else status = result;
      } catch (error) {
        status = 'unknown';
        reason = error instanceof Error ? error.message : String(error);
      }
      this.journal.delivery(envelope.id, status, reason);
      // 只有 unknown（服务器可能已投递）才停发后面的气泡——继续发可能
      // 造成乱序重复；failed 是确定性死亡，同轮后续气泡照发。
      return status !== 'unknown';
    };
    /** 排干当前 pending。返回 false 表示发送链被打断（unknown/领件失败），
     *  调用方据此决定是否继续后续动作。 */
    const drain = async (): Promise<boolean> => {
      while (!signal.aborted && !this.stopped && this.journal.pending(peer).length)
        if (!(await tryDeliver())) return false;
      return true;
    };
    // 投递泵（#4）：与思考并行跑，渐进气泡闭合即入队、泵立刻领发——
    // 生成与投递重叠，这是渐进投递的完整意图（beta 双泵的最小等价物）。
    // 40ms 是空队列的歇息粒度，一整轮思考的空转开销可忽略。
    let pumping = false;
    const pump = async (): Promise<void> => {
      pumping = true;
      try {
        while (pumping && !signal.aborted && !this.stopped) {
          if (!this.journal.pending(peer).length) {
            await delay(40, signal);
            continue;
          }
          if (!(await tryDeliver())) return;
        }
      } finally {
        pumping = false;
      }
    };
    // 先清上一轮的残件（前次 work 中断没发完的件），发链断了就整段让路。
    if (!(await drain())) return;
    if (signal.aborted || this.stopped) return;
    const job = this.journal.jobs().find((job) => job.peer === peer && job.due_at <= Date.now());
    if (!job) return;
    const turn = this.journal.claim(peer, job.kind);
    if (!turn) return;
    const showsTyping = turn.kind !== 'diary' && turn.kind !== 'tidy';
    // true 也必须等待：火后不管的 true 走网络慢了会迟到——false 清完指示
    // 它才到，把指示重新点亮，气泡发完了"输入中"还挂着。
    if (showsTyping) await composing(true);
    const pumpPromise = pump();
    try {
      await this.think(turn, signal);
    } finally {
      // 停泵并排干本轮残件：think 返回时泵可能停在歇息点上；收尾 drain
      // 把渐进已入队未领的尾巴与全量 draft 的气泡一次发完。失败的思考
      // 不回滚已入队的气泡——已经说出口（或已入队）的话是真话。
      pumping = false;
      await pumpPromise.catch(() => undefined);
      await drain();
      // 没有就绪气泡（决定不说/失败/被打断）时把指示收掉，别让"输入中"
      // 挂死；有气泡则刚被 drain 发完，指示已在发送前清过。
      if (showsTyping && !this.journal.pending(peer).length) await composing(false);
    }
  }

  /** 思考产出落库：心情、在做、在追先记账（她此刻的状态），然后草稿。
   *  表达效果（念头退场、约定已问）由 journal.draft 绑定气泡与证据。 */
  private settleSelf(peer: string, thought: Thought): void {
    const now = Date.now();
    if (thought.moodPulse) this.journal.setMood(peer, { ...thought.moodPulse, at: now });
    if (thought.activity !== undefined)
      this.journal.setSetting(
        'self',
        evolveSelf(this.journal.self(), now, { kind: 'activity', value: thought.activity }),
      );
    if (thought.pursuit !== undefined)
      this.journal.setSetting(
        'self',
        evolveSelf(this.journal.self(), now, { kind: 'pursuit', value: thought.pursuit }),
      );
  }

  private async think(turn: Turn, signal: AbortSignal): Promise<void> {
    const options: RequestOptions = {
      signal,
      deadlineAt: Date.now() + numeric(this.options.timeoutMs),
      sessionId: turn.peer,
    };
    try {
      const material = await this.options.material(turn);
      // 渐进投递：气泡闭合即入队，与思考并行发出。sink.draft 返回 false
      // （轮次被新消息作废）时 Mind 自行降级为纯全量路径。
      const thought = await this.mind.think(
        turn,
        this.options.persona(),
        // 夜里的 diary/tidy 自带完整材料（当日窗口/记忆清单），对话历史
        // 对它们只是白拖的 token；对外的轮次照旧带全量对话。
        turn.kind === 'diary' || turn.kind === 'tidy' ? [] : await this.history(turn.peer),
        material,
        options,
        {
          draft: (ordinal, part) => this.journal.draftOne(turn, ordinal, part),
        },
      );
      signal.throwIfAborted();
      // 渐进已收口的轮次（finishDraft 已绑效果）跳过全量 draft；
      // 表情白名单的静默过滤只走全量路径（渐进轻校验已做）。
      if (this.journal.turnState(turn.id) === 'running') {
        // 目录外的表情不是她的表情：静默丢弃，别让一次幻觉变成发不出的死信。
        const slugs = this.options.stickerSlugs();
        const parts = thought.parts.filter(
          (part) => part.type !== 'sticker' || slugs.has(part.slug ?? ''),
        );
        if (thought.action === 'speak' && parts.length !== thought.parts.length && !parts.length) {
          this.journal.fail(turn, '表情不在目录中，气泡全部失效');
          return;
        }
        this.settleSelf(turn.peer, thought);
        this.journal.draft(turn, parts, thought.effects);
      } else {
        this.settleSelf(turn.peer, thought);
      }
      if (thought.thought)
        this.journal.appendEvent(turn.peer, turn.id, 'muse', { content: thought.thought });
    } catch (error) {
      this.journal.fail(turn, error instanceof Error ? error.message : '思考失败');
      if (!signal.aborted) {
        this.options.onError(error);
        // 思考一失败就终态会吞掉他刚说的话（模型超时、网络抖动都算）：
        // 给 chat 轮一次 60 秒后的重试——重排 job 而不是回滚 turn，期间
        // 他若有新消息，重试轮会连着新消息一起作答。窗口内除当前这条
        // 外还有失败记录，说明这是重试链的第二次：到此为止，渠道持续
        // 故障不该变成每分钟一次的无限烧钱循环（fail 落库在先，这里数得到）。
        if (
          turn.kind === 'chat' &&
          this.journal.eventsBetween(
            turn.peer,
            ['failure'],
            Date.now() - 15 * 60_000,
            Date.now() + 1,
          ).length <= 1
        )
          this.journal.schedule(turn.peer, 'chat', Date.now() + 60_000);
      }
    } finally {
      if (!this.stopped) {
        // 心跳节拍与提醒的重排：beat 由人格参数决定下一拍，reminder 重算
        // 到期约定（问过的退场，没问到的保持到期状态）。
        if (turn.kind === 'beat') {
          const next = this.options.nextBeat(turn.peer);
          if (next !== undefined) this.journal.schedule(turn.peer, 'beat', next);
        } else if (turn.kind === 'reminder') {
          this.journal.rearmReminders(turn.peer, this.options.reminderFloor?.() ?? 0);
        }
      }
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const active of this.active.values()) active.controller.abort();
    await this.wakeup.stop();
    await Promise.allSettled([...this.active.values()].map((active) => active.promise));
  }
}
