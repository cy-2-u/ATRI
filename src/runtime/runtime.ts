import type { Message, RequestOptions } from '../model/types.js';
import { Mind, type Thought } from '../domain/mind.js';
import { Journal, type Bubble, type Turn } from '../storage/journal.js';
import { evolveSelf } from '../domain/state.js';
import { Wakeup, type TimerClock } from './wakeup.js';

export interface RuntimeOptions {
  persona(): string;
  material(turn: Turn): Promise<unknown> | unknown;
  send(peer: string, part: Bubble): Promise<'sent' | 'unknown' | 'failed'>;
  nextBeat(peer: string): number | undefined;
  onComposing?(peer: string, active: boolean): Promise<void>;
  onError(error: unknown): void;
  timeoutMs: number | (() => number);
  /** 入站消息的可用时刻；缺省 now+debounce。注入时完全接管——睡眠窗
   *  把深夜消息推迟到醒来是装配层的事，内核不懂时区与睡眠。 */
  incomingDue?(): number;
  debounceMs?: number | (() => number);
  concurrency: number | (() => number);
  /** 气泡间隔的行走时间：第 2 条起按长度停顿，像在打字。 */
  pacing: boolean | (() => boolean);
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
      this.options.incomingDue?.() ?? Date.now() + numeric(this.options.debounceMs ?? 0),
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
    const envelopes = this.journal.blocked(peer) ? [] : this.journal.pending(peer);
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
    for (const envelope of envelopes) {
      if (signal.aborted || this.stopped) return;
      if (pacingOn && !first) {
        // 气泡间隔在占用发送位之前进行：被取消就保持待发，下次接着发。
        await composing(true);
        await delay(pacingMs(envelope.part), signal);
        if (signal.aborted || this.stopped) return;
      }
      await composing(false);
      if (!this.journal.startDelivery(envelope.id)) return;
      first = false;
      let status: 'sent' | 'unknown' | 'failed';
      try {
        status = await this.options.send(peer, envelope.part);
      } catch {
        status = 'unknown';
      }
      this.journal.delivery(envelope.id, status);
      if (status !== 'sent') return;
    }
    if (signal.aborted || this.stopped) return;
    const job = this.journal.jobs().find((job) => job.peer === peer && job.due_at <= Date.now());
    if (!job) return;
    const turn = this.journal.claim(peer, job.kind);
    if (!turn) return;
    const showsTyping = turn.kind !== 'diary' && turn.kind !== 'tidy';
    // true 也必须等待：火后不管的 true 走网络慢了会迟到——false 清完指示
    // 它才到，把指示重新点亮，气泡发完了"输入中"还挂着。
    if (showsTyping) await composing(true);
    try {
      await this.think(turn, signal);
    } finally {
      // 没有就绪气泡（决定不说/失败/被打断）时把指示收掉，别让"输入中"
      // 挂死；有气泡则由下一轮投递在到达前清除。
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
      const thought = await this.mind.think(
        turn,
        this.options.persona(),
        // 夜里的 diary/tidy 自带完整材料（当日窗口/记忆清单），对话历史
        // 对它们只是白拖的 token；对外的轮次照旧带全量对话。
        turn.kind === 'diary' || turn.kind === 'tidy' ? [] : await this.history(turn.peer),
        material,
        options,
      );
      signal.throwIfAborted();
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
      if (thought.thought)
        this.journal.appendEvent(turn.peer, turn.id, 'muse', { content: thought.thought });
    } catch (error) {
      this.journal.fail(turn, error instanceof Error ? error.message : '思考失败');
      if (!signal.aborted) {
        this.options.onError(error);
        // 思考一失败就终态会吞掉他刚说的话（模型超时、网络抖动都算）：
        // 给 chat 轮一次 60 秒后的重试——重排 job 而不是回滚 turn，期间
        // 他若有新消息，重试轮会连着新消息一起作答。重试再失败保持终态。
        if (turn.kind === 'chat') this.journal.schedule(turn.peer, 'chat', Date.now() + 60_000);
      }
    } finally {
      if (!this.stopped) {
        // 心跳节拍与提醒的重排：beat 由人格参数决定下一拍，reminder 重算
        // 到期约定（问过的退场，没问到的保持到期状态）。
        if (turn.kind === 'beat') {
          const next = this.options.nextBeat(turn.peer);
          if (next !== undefined) this.journal.schedule(turn.peer, 'beat', next);
        } else if (turn.kind === 'reminder') {
          this.journal.rearmReminders(turn.peer);
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
