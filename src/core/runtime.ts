import type { Store, Peer, ReplyPart, Task, Media, MemoryUpdate } from '../db/index.js';
import { hourFormatter } from '../db/index.js';
import { Agent, type AgentOptions } from './agent.js';
import { renderMessage } from './prompt-blocks.js';
import { estimateTextTokens, cosineSimilarity } from '../llm.js';
import { residuePulse } from './memory-context.js';
import { createHash } from 'node:crypto';
import { boredom, longing, tickMotives, type MotiveTick } from './motives.js';
import {
  inSleepMinutes,
  jitteredSleepWindow,
  minutesOfDay,
  isHisActiveHour,
  nextBeatDelayMs,
} from './pulse.js';
import {
  NOTES_MIN_MESSAGES,
  NOTES_WINDOW,
  NOTES_BUDGET_SHARE,
  NOTES_TAIL_EXEMPT,
  DIARY_MAX_CHARS,
  EMBED_BACKFILL_BATCH,
  SIMILARITY_SUPERSEDE,
  BEAT_RANGES_MS,
  PULSE_ANOMALY_PER_HOUR,
  BOOT_BEAT_GRACE_MS,
} from './constants.js';

/** 调度主干：泵队列、投递气泡、她的心跳、日记与向量回填。
 *
 *  她是自由的：代码没有"审批闸门"，也不熔断她的表达。代码只负责两件
 *  事——让心跳按节律发生（睡眠/黏人度/走神），把真实材料递给模型；
 *  异常模式（一小时多条无回应）只记日志给人看，不改变她的行为。
 *  想不想说、说什么、连不连续说，永远是她在真实材料上的决定。 */

export interface Embedder {
  configured: boolean;
  model: string;
  /** 运维是否真的想要向量（独立于配置是否齐全的开关）。 */
  enabled?: boolean;
  embed(texts: string[], signal?: AbortSignal): Promise<Float32Array[]>;
}
export interface RuntimeConfig {
  timeZone: string;
  diaryHour: number;
  proactiveEnabled: boolean;
  /** 她的睡眠时段。 */
  sleepStart: number;
  sleepEnd: number;
  /** 黏人度 0–100：心跳基准密度。 */
  clinginess: number;
  debounceMs: number;
  maxConcurrentPeers: number;
  turnTimeoutMs: number;
  contextTokens: number;
}
export interface Transport {
  send(peer: Peer, part: ReplyPart, clientId: string): Promise<void>;
  typing?(peer: Peer, active: boolean): Promise<void>;
}
export class DeliveryError extends Error {
  constructor(
    message: string,
    /** 确定性失败（重试无意义）；不确定的失败暂停队列等运维裁决。 */
    readonly certainFailure = false,
  ) {
    super(message);
  }
}
export interface RuntimeOptions extends AgentOptions {
  config: () => RuntimeConfig;
  transport: Transport;
  log?: (message: string, details?: unknown) => void;
  embedder?: Embedder;
}

const dayFormatters = new Map<string, Intl.DateTimeFormat>();
export function dayAt(at: number, timeZone: string): string {
  let formatter = dayFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    dayFormatters.set(timeZone, formatter);
  }
  const p = formatter.formatToParts(new Date(at));
  return ['year', 'month', 'day'].map((t) => p.find((v) => v.type === t)!.value).join('-');
}
function hourAt(at: number, timeZone: string) {
  return Number(hourFormatter(timeZone).format(new Date(at)));
}
/** 非聊天任务的失败退避：1/2/4…分钟，30 分钟封顶。 */
export function taskBackoffMs(attempts: number): number {
  return Math.min(30, 2 ** Math.max(0, attempts - 1)) * 60000;
}
/** 单联系人单泵周期的工作预算（含投递轮）。 */
const MAX_WORK_ITERATIONS = 12;
/** 可中断的暂停：shutdown/supersede 不用陪完剩余延迟。 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

const thoughtKey = (thought: string) =>
  `thought:${createHash('sha256').update(thought).digest('hex').slice(0, 12)}`;

/** beat 档位 → 有界毫秒区间内随机取值。停不停由语义决定，代码只画边界。 */
function beatPauseMs(part: ReplyPart): number | undefined {
  if (!part.beat) return undefined;
  const [lo, hi] = BEAT_RANGES_MS[part.beat];
  return lo + Math.random() * (hi - lo);
}

export class Runtime {
  readonly agent: Agent;
  readonly store: Store;
  private active = new Map<
    string,
    { promise: Promise<void>; controller: AbortController; kind?: string }
  >();
  private timer?: ReturnType<typeof setInterval>;
  private scheduleTimer?: ReturnType<typeof setInterval>;
  private embedTimer?: ReturnType<typeof setInterval>;
  private embedding = false;
  private stopped = false;
  /** 每个联系人的下一次心跳时刻（内存态；重启后从"很快"重新起算）。 */
  private nextBeatAt = new Map<string, number>();
  /** 任务产出与投递结果之间的挂起效果（asked 标记），崩溃安全。 */
  private pendingEffects = new Map<string, { loops: string[]; threads: string[] }>();
  private backfillController = new AbortController();
  private backfills = new Set<Promise<void>>();
  /** 进程启动时刻：首拍宽限的起点（0 = 未启动，宽限不生效——测试直接
   *  new Runtime 不经 start()，不受宽限影响）。 */
  private startedAt = 0;

  constructor(private readonly options: RuntimeOptions) {
    this.agent = new Agent(options);
    this.store = options.store;
  }

  start() {
    this.store.recover();
    this.stopped = false;
    this.startedAt = Date.now();
    this.timer = setInterval(() => {
      try {
        this.pump();
      } catch (error) {
        this.options.log?.('队列泵失败，本轮跳过', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }, 300);
    this.scheduleTimer = setInterval(() => {
      try {
        this.schedule();
      } catch (error) {
        this.options.log?.('调度器失败，本轮跳过', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }, 60000);
    // 向量回填：启动时一次全量排空（大导入不该靠 64 行滴灌），之后每
    // 5 分钟滴灌增量，不与聊天抢时段。
    if (this.options.embedder) {
      this.backfillController = new AbortController();
      this.trackBackfill(false);
      this.embedTimer = setInterval(() => this.trackBackfill(true), 300000);
    }
    this.schedule();
    this.pump();
  }
  async stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.scheduleTimer) clearInterval(this.scheduleTimer);
    if (this.embedTimer) clearInterval(this.embedTimer);
    this.backfillController.abort();
    for (const a of this.active.values()) a.controller.abort();
    await Promise.allSettled([
      ...[...this.active.values()].map((a) => a.promise),
      ...this.backfills,
    ]);
  }
  private trackBackfill(quick: boolean): void {
    let promise: Promise<void>;
    promise = this.backfillEmbeddings(quick)
      .catch((error) => {
        this.options.log?.('向量索引更新失败，将在下个周期重试', {
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => this.backfills.delete(promise));
    this.backfills.add(promise);
  }
  /** 给缺向量的内容建索引；尽力而为、绝不阻塞聊天。quick 限制单联系人
   *  批量（周期滴灌）；全量一次排空。 */
  private async backfillEmbeddings(quick = true) {
    const embedder = this.options.embedder;
    if (!embedder || this.embedding || this.stopped || !embedder.configured) return;
    if (embedder.enabled === false) return;
    this.embedding = true;
    try {
      for (const peer of this.store.peers()) {
        if (this.stopped) return;
        // 换嵌入模型后旧向量永不刷新也不可比：清掉，由正常回填补齐。
        for (const stale of this.store.staleEmbeddingModels(peer.id, embedder.model)) {
          this.store.dropEmbeddingsOfModel(stale);
          this.options.log?.('检测到向量模型更换，已清理旧向量', {
            from: stale,
            to: embedder.model,
          });
        }
        for (;;) {
          const pending = this.store.pendingEmbeddings(peer.id, quick ? EMBED_BACKFILL_BATCH : 512);
          if (!pending.length) break;
          const vectors = await embedder.embed(
            pending.map((p) => p.content),
            this.backfillController.signal,
          );
          if (this.stopped) return;
          // 静默丢行的提供商会把全量回填变成死循环。
          if (vectors.length !== pending.length)
            throw new Error(`嵌入返回条数不匹配：期望 ${pending.length}，收到 ${vectors.length}`);
          this.store.setEmbeddings(
            vectors.map((vector, i) => ({
              id: pending[i]!.id,
              peer: peer.id,
              kind: pending[i]!.kind,
              vector,
              model: embedder.model,
            })),
          );
          if (quick) break;
        }
      }
    } catch (error) {
      if (!this.stopped && !this.backfillController.signal.aborted)
        this.options.log?.('向量索引更新失败，将在下个周期重试', {
          error: error instanceof Error ? error.message : String(error),
        });
    } finally {
      this.embedding = false;
    }
  }

  /** 入口：消息与任务同事务落库，可靠保存后推进游标。 */
  accept(
    peer: string,
    eventKey: string,
    content: string,
    media: Media[] = [],
    timestamp = Date.now(),
  ) {
    const result = this.store.transaction(() => {
      const event = this.store.ingest(peer, eventKey, content, media, timestamp);
      const taskId = !event.duplicate
        ? this.store.enqueueChat(peer, event.message.seq, this.options.config().debounceMs)
        : undefined;
      return { ...event, taskId };
    });
    const active = this.active.get(peer);
    // 只有产出用户可见输出的轮次值得取消（它的回复会答一条已被取代的
    // 消息）；日记/笔记是后台写入，取消只会让它们永远重启。
    if (!result.duplicate && active && (active.kind === 'chat' || active.kind === 'pulse'))
      active.controller.abort();
    // 新消息是一次真实的刺激：无聊归零、社交电量消耗。
    if (!result.duplicate) this.settleMotives(peer, { now: timestamp, exchanges: 1 });
    this.pump();
    return result;
  }

  pump() {
    if (this.stopped) return;
    for (const peer of this.store.readyPeers()) {
      if (this.active.has(peer)) continue;
      if (this.active.size >= this.options.config().maxConcurrentPeers) break;
      const controller = new AbortController();
      const entry = {
        promise: Promise.resolve(),
        controller,
        kind: undefined as string | undefined,
      };
      this.active.set(peer, entry);
      entry.promise = this.work(peer, entry)
        .catch((error) => this.options.log?.('会话处理失败', { peer, error: String(error) }))
        .finally(() => {
          this.active.delete(peer);
          if (!this.stopped) queueMicrotask(() => this.pump());
        });
    }
  }
  async drain(timeoutMs = 10000) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      this.pump();
      if (!this.active.size && !this.store.readyPeers().length) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('等待队列处理超时');
  }

  private async work(peerId: string, entry: { controller: AbortController; kind?: string }) {
    for (let n = 0; n < MAX_WORK_ITERATIONS && !this.stopped; n++) {
      const peer = this.store.peer(peerId);
      if (!peer) return;
      if (!peer.approved) return;
      const deliveries = this.store.pendingDeliveries(peerId);
      if (deliveries.length) {
        entry.kind = 'delivery';
        const task = this.store.taskById(deliveries[0].task_id);
        if (!task) {
          // 任务行被清掉但气泡还在：退役孤儿而不是让整个队列崩掉。
          this.store.markDelivery(deliveries[0].id, 'cancelled', '所属任务已被清理');
          this.discardPendingEffects(deliveries[0].task_id);
          continue;
        }
        if (task.version !== peer.version && this.store.cancelUnsent(task)) {
          this.discardPendingEffects(task.id);
          continue;
        }
        const own = deliveries.filter((d) => d.task_id === task.id);
        let deliveredAny = false;
        let failedDelivery: string | undefined;
        for (let i = 0; i < own.length; i++) {
          // 新用户消息会在气泡之间中止本轮：停顿早醒后不能再发旧回复。
          if (entry.controller.signal.aborted) return;
          const current = this.store.peer(peerId);
          if (!current || current.version !== peer.version) {
            this.store.cancelUnsent(task);
            this.discardPendingEffects(task.id);
            break;
          }
          const delivery = own[i]!;
          // 发送前的停顿：模型可用 beat 表达"这条之前自然停一下"（沉重的
          // 话先沉默几秒再开口）；没写 beat 就按内容长度自动——长气泡停久
          // 一点，绝不机关枪。首气泡默认即时。
          const beatPause = beatPauseMs(delivery.part);
          if (beatPause !== undefined || i > 0) {
            const chars = delivery.part.type === 'text' ? (delivery.part.text?.length ?? 0) : 6;
            const pauseMs = beatPause ?? Math.min(2500, 400 + Math.min(80, chars) * 25);
            await sleep(pauseMs, entry.controller.signal);
            if (entry.controller.signal.aborted) return;
          }
          // 运维可能在上个气泡发送期间确认/取消了这行：不再是 pending 就跳过。
          if (!this.store.startDelivery(delivery.id)) continue;
          try {
            await this.options.transport.send(current, delivery.part, delivery.id);
            this.store.markDelivery(delivery.id, 'sent');
            deliveredAny = true;
            this.commitPendingEffects(task.id);
          } catch (error) {
            const certain = error instanceof DeliveryError && error.certainFailure;
            const message = error instanceof Error ? error.message : '发送失败';
            this.store.markDelivery(delivery.id, certain ? 'failed' : 'uncertain', message);
            if (!certain) {
              // 气泡可能已到对方：停止整批而不是冒险重复，交给运维裁决。
              this.commitPendingEffects(task.id);
              return;
            }
            failedDelivery ??= message;
            if (!deliveredAny) {
              // 这条回复一个气泡都没发出去：发尾巴会留下半截答案。
              this.store.cancelPendingForTask(task.id, delivery.id, message);
              this.discardPendingEffects(task.id);
              break;
            }
            // 后面的气泡失败（如表情不可用）而文字已送达：继续发剩余文字，
            // 在这里取消会永久截断回复。
          }
        }
        if (failedDelivery) this.store.finish(task.id, 'failed', failedDelivery);
        this.maybeLateNight(peerId);
        this.maybeNotes(peerId);
        continue;
      }
      const task = this.store.claim(peerId);
      if (!task) return;
      entry.kind = task.kind;
      if (entry.controller.signal.aborted) entry.controller = new AbortController();
      const signal = AbortSignal.any([
        entry.controller.signal,
        AbortSignal.timeout(this.options.config().turnTimeoutMs),
      ]);
      try {
        if (task.kind === 'chat') {
          await this.runChat(task, peer, signal);
        } else if (task.kind === 'pulse') {
          await this.runPulse(task, peer, signal);
        } else await this.agent.reflect(task, signal);
      } catch (error) {
        if (this.stopped || entry.controller.signal.aborted) {
          // 新消息已排了更新的轮次：重排这条被中断的会让用户收到旧消息
          // 和新消息各一份答案；更新的轮次取代它。
          const through = typeof task.payload.through === 'number' ? task.payload.through : -1;
          if (this.store.newerChatQueued(task.peer_id, through)) {
            this.store.finish(task.id, 'superseded');
          } else {
            this.store.finish(task.id, 'interrupted');
            this.store.retry(task.id, task.kind === 'chat' ? 0 : 60000);
          }
        } else {
          this.store.finish(task.id, 'failed', error instanceof Error ? error.message : '任务失败');
          this.options.log?.('任务失败', { task: task.id, kind: task.kind, error: String(error) });
          // 退避而不是立刻重排：系统性失败的任务不该每分钟烧一次模型
          // 调用。state 保持 failed（待办可见、可被新回复取代），手动重试
          // 从 /api/tasks/:id/retry 进。
          this.store.deferFailed(task.id, taskBackoffMs(task.attempts));
        }
      }
    }
  }

  /** 聊天轮：生成 → 落库 → 挂起效果 → 记忆。 */
  private async runChat(task: Task, peer: Peer, signal: AbortSignal) {
    const typing = this.options.transport.typing?.(peer, true).catch(() => {});
    try {
      const reply = await this.agent.reply(task, signal);
      // 气泡先落库、先进投递；记忆去重要一次嵌入请求，不挡回复。
      const saved = this.store.saveReply(task, reply.parts, []);
      if (saved) {
        const loops = this.applyOpenLoops(task, reply);
        const threads = this.applySoftThreads(task, reply);
        if (loops.length || threads.length) {
          this.pendingEffects.set(task.id, { loops, threads });
          // 崩溃在保存与投递之间时由 outbox 重试气泡，asked 状态
          // 必须随行，否则提醒可能发两次。
          this.store.setSetting(`pending_effects:${task.id}`, { loops, threads });
        }
        // 聊天中形成的想法落库（"这个改天想跟他说"）。来源校验用对话
        // 可见的 ID 集，模型引用没见过的来源直接淘汰。想法不触发任何
        // 立即评估——它们会在心跳时自己浮上来。
        if (reply.initiatives.length) {
          const available = new Set([
            ...this.store.history(task.peer_id, 40).map((m) => m.id),
            ...(reply.pickedMemoryIds ?? []),
          ]);
          for (const input of reply.initiatives) {
            if (!input.sources.every((s) => available.has(s))) continue;
            this.store.upsertInitiative(task.peer_id, input, Date.now());
          }
        }
        // 记忆写入后置，版本不匹配时整体放弃。
        await this.dedupeMemories(task.peer_id, reply.memories, signal);
        this.store.applyMemoryUpdates(task.peer_id, task.version, reply.memories);
        // 每次进提示词都是一次演练：巩固按间隔增长、细节时钟重置；
        // 带情绪残留的记忆被想起时泛化成此刻的心情。
        if (reply.pickedMemoryIds?.length && reply.parts.length) {
          const residues = this.store.markMemoriesUsed(task.peer_id, reply.pickedMemoryIds);
          const pulse = residuePulse(residues);
          if (pulse)
            this.store.pulseMood(
              task.peer_id,
              { valence: pulse.valence, reason: pulse.reason },
              Date.now(),
            );
        }
        if (reply.moodPulse) this.store.pulseMood(task.peer_id, { ...reply.moodPulse }, Date.now());
        for (const description of reply.descriptions) {
          const msg = this.store.getMessage(task.peer_id, description.messageId);
          if (msg) {
            this.store.updateMedia(
              task.peer_id,
              msg.id,
              msg.media.map((m) =>
                m.kind === 'image' ? { ...m, description: description.description } : m,
              ),
            );
          }
        }
        // 她开口说话也是一次刺激。
        if (reply.parts.length)
          this.settleMotives(task.peer_id, {
            now: Date.now(),
            exchanges: 1,
            moodEvent: reply.moodPulse ? Math.abs(reply.moodPulse.valence) : 0,
          });
      }
    } finally {
      void Promise.resolve(typing)
        .then(() => this.options.transport.typing?.(peer, false))
        .catch(() => {});
    }
  }

  /** 心跳轮：开场白 / 到期承诺 / 她自己的一拍。 */
  private async runPulse(task: Task, peer: Peer, signal: AbortSignal) {
    const now = Date.now();
    const isGreeting =
      typeof task.payload.greeting === 'string' && (task.payload.greeting as string).trim() !== '';
    const loopId = typeof task.payload.loop === 'string' ? task.payload.loop : '';
    if (loopId) {
      // 排队中的开环提醒只是排队那一刻的判断：期间它可能被聊天轮
      // 了结、被别的提醒问过、或已滑出询问窗口——照发就会"提醒"
      // 用户刚处理完的事。
      const loop = this.store.dueOpenLoops(peer.id, now).find((l) => l.id === loopId);
      if (!loop) {
        this.store.finish(task.id, 'done');
        return;
      }
      this.store.updateSelf({ lastStimulusAt: now }, now);
      await this.generatePulse(task, peer, signal, {
        loopContent: loop.content,
      });
      return;
    }
    if (isGreeting) {
      await this.generatePulse(task, peer, signal, {});
      return;
    }
    // 她自己的一拍（beat）。守门只剩物理：总开关与睡眠。之后想不想说、
    // 说几次，完全是她的决定——代码不设任何"不许再发"的闸门。
    if (!this.options.config().proactiveEnabled) {
      this.store.finish(task.id, 'superseded');
      return;
    }
    const c = this.options.config();
    // 睡眠窗带生理抖动（按本地日期稳定）：她不会每天在同一分钟睡着。
    const window = jitteredSleepWindow(dayAt(now, c.timeZone), c.sleepStart, c.sleepEnd);
    if (inSleepMinutes(minutesOfDay(now, c.timeZone), window.startMin, window.endMin)) {
      // 她在睡觉：这一拍不发生。superseded 让同键任务可被明天复用。
      this.store.finish(task.id, 'superseded');
      return;
    }
    // 异常观察（不是闸门）：一小时多条无回应的主动消息，多数时候是对方
    // 真的忙，少数时候是程序故障。记一条日志给运维判断与处置，她的心跳
    // 照常进行——连续发或不再发，都是她的决定。
    if (
      this.store.recentPulseSends(peer.id, 3600000, now) >= PULSE_ANOMALY_PER_HOUR &&
      this.store.unansweredPulseStreak(peer.id) >= 2
    )
      this.options.log?.('心跳异常观察：一小时多条主动消息未获回应（仅记录，不拦截）', {
        peer: peer.id,
      });
    await this.generatePulse(task, peer, signal, { beat: true });
  }

  /** 生成并落库一轮主动输出；beats 与 loop/greeting 共用。 */
  private async generatePulse(
    task: Task,
    peer: Peer,
    signal: AbortSignal,
    mode: { beat?: boolean; loopContent?: string },
  ) {
    const typing = this.options.transport.typing?.(peer, true).catch(() => {});
    try {
      let parts: ReplyPart[] = [];
      if (mode.beat) {
        const beat = await this.agent.pulseBeat(task, signal);
        // 她这拍真实做成的事 → 生活流水；对自己状态的更新 → self。
        if (beat.activity) this.store.logLife('did', beat.activity, '', Date.now());
        if (beat.selfActivity || beat.activity) {
          this.store.updateSelf(
            {
              ...(beat.selfActivity ? { activity: beat.selfActivity } : {}),
              ...(beat.activity && !beat.selfActivity ? { activity: beat.activity } : {}),
              activitySince: Date.now(),
            },
            Date.now(),
          );
        }
        // 在追的事：有值=设置/更新，空串=放下；起点由 store 按内容是否
        // 变化自动处理（重复同一句不会把"追了三天"改写成"追了一瞬间"）。
        if (beat.pursuit !== undefined)
          this.store.updateSelf(
            beat.pursuit ? { pursuit: beat.pursuit } : { pursuitClear: true },
            Date.now(),
          );
        if (beat.action === 'muse' && beat.thought) {
          // 念头存进想法池：同一念头不会重复立项。
          this.store.upsertInitiative(
            task.peer_id,
            {
              topicKey: thoughtKey(beat.thought),
              kind: 'muse',
              meaning: beat.thought,
              sources: [],
            },
            Date.now(),
          );
        }
        if (beat.resolveLoops.length)
          for (const id of beat.resolveLoops)
            this.store.resolveOpenLoop(
              task.peer_id,
              id,
              Date.now(),
              this.options.config().timeZone,
            );
        this.settleMotives(task.peer_id, {
          now: Date.now(),
          exchanges: 0,
          didSomething: Boolean(beat.activity),
          moodEvent: beat.moodPulse ? Math.abs(beat.moodPulse.valence) : 0,
        });
        if (beat.moodPulse) this.store.pulseMood(task.peer_id, { ...beat.moodPulse }, Date.now());
        await this.dedupeMemories(task.peer_id, beat.memories, signal);
        this.store.applyMemoryUpdates(task.peer_id, task.version, beat.memories);
        if (beat.action !== 'speak') {
          this.store.finish(task.id);
          return;
        }
        parts = beat.parts;
        // 说出口的心跳进生活流水：下一次心跳她知道自己说过什么。
        const spoken = parts
          .map((p) =>
            p.type === 'text'
              ? (p.text ?? '')
              : p.type === 'image'
                ? `[图片：${p.path ?? ''}]`
                : `[表情：${p.description ?? p.slug}]`,
          )
          .join(' ')
          .trim();
        if (spoken) this.store.logLife('said', spoken, '', Date.now());
      } else {
        const reply = await this.agent.reply(task, signal);
        this.store.updateSelf({ lastStimulusAt: Date.now() }, Date.now());
        if (reply.resolveLoops.length)
          for (const id of reply.resolveLoops)
            this.store.resolveOpenLoop(
              task.peer_id,
              id,
              Date.now(),
              this.options.config().timeZone,
            );
        if (reply.moodPulse) this.store.pulseMood(task.peer_id, { ...reply.moodPulse }, Date.now());
        await this.dedupeMemories(task.peer_id, reply.memories, signal);
        this.store.applyMemoryUpdates(task.peer_id, task.version, reply.memories);
        if (typeof task.payload.initiative === 'string') {
          // 这次主动真的说出了那个想法——说完即退场；模型选择跳过时
          // 同样释放并留痕，同一版本不会再被自动重问。
          const initiativeId = task.payload.initiative as string;
          this.store.releaseInitiative(task.peer_id, initiativeId, Date.now());
          if (!reply.parts.length)
            this.store.sql
              .prepare("UPDATE initiatives SET origin='生成时选择跳过' WHERE id=?")
              .run(initiativeId);
        }
        parts = reply.parts;
        const loops = this.applyOpenLoops(task, reply);
        if (loops.length) {
          this.pendingEffects.set(task.id, { loops, threads: [] });
          this.store.setSetting(`pending_effects:${task.id}`, { loops, threads: [] });
        }
        if (reply.parts.length) {
          const spoken = reply.parts
            .map((p) =>
              p.type === 'text'
                ? (p.text ?? '')
                : p.type === 'image'
                  ? `[图片：${p.path ?? ''}]`
                  : `[表情：${p.description ?? p.slug}]`,
            )
            .join(' ')
            .trim();
          if (spoken) this.store.logLife('said', spoken, '', Date.now());
        }
      }
      // 气泡先落库、先进投递（无人回应也照走同一套乐观锁与崩溃安全）。
      const saved = this.store.saveReply(task, parts, []);
      if (!saved && !parts.length) this.store.finish(task.id);
    } finally {
      void Promise.resolve(typing)
        .then(() => this.options.transport.typing?.(peer, false))
        .catch(() => {});
    }
  }

  /** 动机结转：任何刺激（收发消息、做成事、心情事件）都从这里进 self。 */
  private settleMotives(
    peerId: string,
    input: { now: number; exchanges: number; didSomething?: boolean; moodEvent?: number },
  ) {
    try {
      const self = this.store.self();
      const tick: MotiveTick = {
        now: input.now,
        exchanges: input.exchanges,
        didSomething: Boolean(input.didSomething),
        moodEvent: Math.max(0, Math.min(1, input.moodEvent ?? 0)),
      };
      const next = tickMotives(
        {
          social: self.social,
          express: self.express,
          lastStimulusAt: self.last_stimulus_at,
          updatedAt: self.updated_at || input.now,
        },
        tick,
      );
      this.store.updateSelf(next, input.now);
    } catch (error) {
      this.options.log?.('动机结转失败（不影响消息）', {
        peer: peerId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** 语义去重：模型用新说法重述已知事实却不填 supersedes；入库前嵌入并
   *  在落在既有活跃记忆 SIMILARITY_SUPERSEDE 内时自动替代旧行。 */
  private async dedupeMemories(peer: string, updates: MemoryUpdate[], signal?: AbortSignal) {
    const embedder = this.options.embedder;
    if (!updates.length || !embedder || embedder.enabled === false || !embedder.configured) return;
    const memories = this.store.embeddings(peer, 'memory');
    if (!memories.length) return;
    const contents = updates.map((u) => u.content.trim());
    let vectors: (Float32Array | undefined)[];
    try {
      vectors = await embedder.embed(contents, signal);
    } catch {
      return;
    }
    for (let i = 0; i < updates.length; i++) {
      const vector = vectors[i];
      if (!vector?.some((v) => v !== 0)) continue;
      let bestId = '',
        bestSim = 0;
      for (const row of memories) {
        if (row.dims !== vector.length || row.model !== embedder.model) continue;
        const sim = cosineSimilarity(vector, row.vector);
        if (sim > bestSim) {
          bestSim = sim;
          bestId = row.id;
        }
      }
      if (bestSim >= SIMILARITY_SUPERSEDE) {
        const superseded = new Set([...(updates[i].supersedes ?? []), bestId]);
        updates[i].supersedes = [...superseded].slice(0, 12);
      }
    }
  }
  /** asked 标记在投递结果明确后落库（发出，或不确定到重试会更糟）。 */
  private commitPendingEffects(taskId: string): void {
    const key = `pending_effects:${taskId}`;
    const effects =
      this.pendingEffects.get(taskId) ??
      this.store.getSetting<{ loops: string[]; threads: string[] } | undefined>(key, undefined);
    this.pendingEffects.delete(taskId);
    this.store.removeSetting(key);
    if (!effects) return;
    const peer = this.store.taskById(taskId)?.peer_id;
    if (!peer) return;
    for (const id of effects.loops) this.store.markLoopAsked(peer, id);
    for (const id of effects.threads) this.store.markSoftThreadAsked(peer, id);
  }
  private discardPendingEffects(taskId: string): void {
    this.pendingEffects.delete(taskId);
    this.store.removeSetting(`pending_effects:${taskId}`);
  }

  /** 开环：了结对方刚回答的、记录新的、标记真正问到的、过期退场。 */
  private applyOpenLoops(
    task: Task,
    reply: {
      openLoops?: { content: string; dueAt: number; dueText?: string; sources: string[] }[];
      resolveLoops?: string[];
      askedLoops?: string[];
      parts?: { type: string }[];
    },
  ): string[] {
    const store = this.store,
      peer = task.peer_id,
      now = Date.now();
    store.expireOpenLoops(peer, now, this.options.config().timeZone);
    const due = new Map(store.dueOpenLoops(peer, now).map((l) => [l.id, l]));
    const explicit = (reply.askedLoops ?? []).filter((id) => due.has(id));
    // 主动消息没有用户轮次垫底：在那里新建或了结有日期的安排等于凭旧
    // 消息发明承诺；同规则也适用于挂念。主动轮只能标记它真正提到的。
    if (task.kind !== 'chat') {
      // 没说话（模型选择跳过）什么都没问；聊别的也什么都没问。只标模型
      // 声明提到的——契约要求显式声明，说没问就是没问。
      const spoken =
        reply.parts?.map((p) => ('text' in p ? String(p.text ?? '') : '')).join(' ') ?? '';
      if (!spoken.trim()) return [];
      return [...new Set(explicit)];
    }
    for (const id of reply.resolveLoops ?? [])
      store.resolveOpenLoop(peer, id, now, this.options.config().timeZone);
    for (const loop of reply.openLoops ?? []) {
      if (!Number.isFinite(loop.dueAt) || loop.dueAt < now - 86400000) continue;
      if (!loop.sources.length) continue;
      store.addOpenLoop(peer, loop, now);
    }
    // 聊天轮自然问到到期安排时同样要标记，否则调度器会再问一遍。
    return [...new Set(explicit)];
  }
  /** 挂念：记录、了结、标记真正问到的。它们从不变成任务或主动消息。 */
  private applySoftThreads(
    task: Task,
    reply: {
      threads?: {
        content: string;
        kind: 'concern' | 'promise';
        revisitAfter?: number;
        sources: string[];
      }[];
      resolveThreads?: string[];
      askedThreads?: string[];
    },
  ): string[] {
    const store = this.store,
      peer = task.peer_id,
      now = Date.now();
    store.expireSoftThreads(peer, now);
    // 主动消息没有用户轮次垫底：在那里新写挂念等于凭空发明担心。
    if (task.kind !== 'chat') return [];
    for (const id of reply.resolveThreads ?? []) store.resolveSoftThread(peer, id, now);
    for (const thread of reply.threads ?? []) {
      if (!thread.sources.length) continue;
      store.addSoftThread(peer, thread, now);
    }
    const open = new Set(store.softThreads(peer, true).map((t) => t.id));
    return [...new Set((reply.askedThreads ?? []).filter((id) => open.has(id)))];
  }

  /** 深夜还在聊天，她自己的能量自然流失。情绪不靠消息长短或关键词推断
   *  ——语义层由 moodPulse 负责、残留泛化在演练里完成；这是唯一保留的
   *  确定性规则，且是关于她自己身体的事实。 */
  private maybeLateNight(peerId: string) {
    const hour = hourAt(Date.now(), this.options.config().timeZone);
    if (hour >= 1 && hour < 7)
      this.store.pulseMood(peerId, { energy: -0.1, reason: '这个点还没睡' }, Date.now());
  }

  private maybeNotes(peerId: string) {
    const peer = this.store.peer(peerId)!;
    const recent = this.store.historyAfter(peerId, peer.notes_until, Number.MAX_SAFE_INTEGER, 200);
    if (
      recent.length < NOTES_MIN_MESSAGES ||
      (recent.length < NOTES_WINDOW &&
        recent.reduce((n, m) => n + estimateTextTokens(renderMessage(m)), 0) <
          this.options.config().contextTokens * NOTES_BUDGET_SHARE)
    )
      return;
    // 最新 13 条豁免：把还在进行的轮次总结进去，笔记描述的就是进行时。
    const cutoff = recent.length - NOTES_TAIL_EXEMPT - 1;
    if (cutoff < 0) return;
    const through = recent[cutoff]!.seq;
    if (through > peer.notes_until)
      this.store.enqueue(peerId, 'notes', String(through), { through });
  }

  queueDiary(peerId: string, force = false, now = Date.now()): string | undefined {
    const after = this.store.getSetting<number>(`diary_cursor:${peerId}`, 0);
    const today = dayAt(now, this.options.config().timeZone);
    const records = this.store
      .historyAfter(peerId, after, Number.MAX_SAFE_INTEGER, 200)
      .filter((m) => force || dayAt(m.created_at, this.options.config().timeZone) < today);
    const size = records.reduce((n, m) => n + estimateTextTokens(renderMessage(m)), 0);
    if (!records.length || (!force && size < DIARY_MAX_CHARS * 0.05)) return;
    const picked: typeof records = [];
    let chars = 0;
    for (const m of [...records].reverse()) {
      const size = renderMessage(m).length;
      if (picked.length && chars + size > DIARY_MAX_CHARS) break;
      picked.push(m);
      chars += size;
    }
    const through = picked.at(-1)!.seq;
    const id = this.store.enqueue(
      peerId,
      'diary',
      `${dayAt(now, this.options.config().timeZone)}:${through}`,
      {
        day: dayAt(now, this.options.config().timeZone),
        through,
        after: Math.max(after, 0),
        ids: picked.map((m) => m.id),
      },
    );
    this.pump();
    return id;
  }

  /** 每分钟的调度 tick：日记、到期承诺、她的心跳。
   *  这里没有任何"该不该说话"的判断——只有"该不该发生一拍意识"。 */
  schedule(now = Date.now()) {
    if (this.stopped) return;
    const c = this.options.config(),
      hour = hourAt(now, c.timeZone);
    // 例行清理搭每分钟调度 tick 的便车；单个坏联系人不能让后面的全部饿死。
    try {
      this.store.pruneTasks(now);
      this.store.pruneInitiatives(now);
    } catch (error) {
      this.options.log?.('清理旧任务失败，本轮跳过', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    // 睡眠窗带生理抖动（按本地日期稳定）：她不会每天在同一分钟睡着、
    // 同一分钟醒来。窗口算一次，本 tick 内所有联系人共用。
    const window = jitteredSleepWindow(dayAt(now, c.timeZone), c.sleepStart, c.sleepEnd);
    const asleep = inSleepMinutes(minutesOfDay(now, c.timeZone), window.startMin, window.endMin);
    for (const peer of this.store.peers().filter((p) => p.approved)) {
      try {
        if (hour >= c.diaryHour) this.queueDiary(peer.id, false, now);
        // 夜间整理拍：日记写完后的两小时窗里，把相近/矛盾的记忆对交给
        // 模型理顺。只在有候选时入队，去重键按天（done 行占键，天然幂等）。
        if (hour >= c.diaryHour && hour < c.diaryHour + 2) {
          const consolidateKey = `consolidate:${dayAt(now, c.timeZone)}`;
          if (
            !this.store.hasPendingTask(peer.id, 'consolidate', consolidateKey) &&
            this.store.consolidationCandidates(peer.id, 1).length
          )
            this.store.enqueue(peer.id, 'consolidate', consolidateKey, {}, now);
        }
        this.store.expireOpenLoops(peer.id, now, c.timeZone);
        this.store.expireSoftThreads(peer.id, now);
        // 到期承诺：她自己的记性，不等心跳碰运气。
        if (c.proactiveEnabled) {
          const dueLoops = this.store.dueOpenLoops(peer.id, now);
          for (const loop of dueLoops) {
            const key = `${this.store.loopTaskKey(loop)}:${dayAt(now, c.timeZone)}`;
            if (this.store.hasPendingTask(peer.id, 'pulse', key)) continue;
            this.store.enqueue(
              peer.id,
              'pulse',
              key,
              { loop: loop.id, loopContent: loop.content },
              now,
            );
          }
        }
        // 心跳：睡眠中不发生；醒着时按节律排下一拍。
        if (!c.proactiveEnabled || asleep) continue;
        // 两条不变式，都由测试钉住：
        // 1. nextBeatAt 只在拍真的排下去（入队）时才写；未排时把"下一拍"
        //    推到未来会让 now < next 永远成立，第一拍永远来不了。
        // 2. beat 键是一次性的（beat:时间戳）：拍完成后 done 行仍占着
        //    UNIQUE 键，固定键会让 INSERT OR IGNORE 静默失败。
        if (this.store.hasPendingBeat(peer.id)) continue;
        const next = this.nextBeatAt.get(peer.id);
        if (next !== undefined && now < next) continue;
        // 启动宽限：部署重启不让她"恰好醒来"。宽限期内不排拍，把下一拍
        // 压到宽限结束——之后 now < next 不再成立，拍自然接上（不会永远
        // 卡住：入队路径就在这个判断后面）。
        const graceEnd = this.startedAt ? this.startedAt + BOOT_BEAT_GRACE_MS : 0;
        if (graceEnd && now < graceEnd) {
          this.nextBeatAt.set(peer.id, graceEnd);
          continue;
        }
        const self = this.store.self();
        const delay = nextBeatDelayMs({
          clinginess: c.clinginess,
          // 动机数学与体感同源（motives.ts）：节拍密度与材料措辞必须是
          // 同一份生理。想念含对方活跃时段加成，与 beatMaterial 一致。
          motives: {
            bored: boredom(self.last_stimulus_at, now),
            miss: longing(
              this.store.lastSpokeAt(peer.id),
              now,
              isHisActiveHour(this.store.activityRhythm(peer.id, c.timeZone), hour),
            ),
            social: self.social,
            express: self.express,
          },
          sinceLastExchangeMs: peer.last_user_at ? now - peer.last_user_at : Infinity,
        });
        this.nextBeatAt.set(peer.id, now + delay);
        this.store.enqueue(peer.id, 'pulse', `beat:${now}`, { beat: true }, now);
        this.pump();
      } catch (error) {
        this.options.log?.('联系人调度失败，跳过', {
          peer: peer.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}
