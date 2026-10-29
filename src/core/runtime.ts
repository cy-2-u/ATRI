import type { Store, Peer, ReplyPart, Task, Media, MemoryUpdate } from '../db/index.js';
import { hourFormatter } from '../db/index.js';
import { Agent, type AgentOptions } from './agent.js';
import { renderMessage } from './prompt-blocks.js';
import { estimateTextTokens, cosineSimilarity } from '../llm.js';
import { residuePulse } from './memory-context.js';
import {
  NOTES_MIN_MESSAGES,
  NOTES_WINDOW,
  NOTES_BUDGET_SHARE,
  NOTES_TAIL_EXEMPT,
  DIARY_MAX_CHARS,
  EMBED_BACKFILL_BATCH,
  SIMILARITY_SUPERSEDE,
  BEAT_RANGES_MS,
  MUSE_SILENCE_MIN_HOURS,
  MUSE_COOLDOWN_DAYS,
} from './constants.js';
import { considerInitiatives } from './initiative.js';

/** 调度主干：泵队列、投递气泡、排日记与主动联系、向量回填。 */

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
  quietStart: number;
  quietEnd: number;
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
/** 读空气刹车：连续无回应时按 3→6→12→14 天封顶拉长——这是打扰保护，
 *  不是性格；对方一开口立即解除。 */
export function silenceCooldownMs(streak: number): number {
  const days = Math.min(14, 3 * 2 ** Math.max(0, streak - 2));
  return days * 86400000;
}
export function inQuietHours(hour: number, start: number, end: number) {
  return start === end
    ? false
    : start < end
      ? hour >= start && hour < end
      : hour >= start || hour < end;
}
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
/** beat 档位 → 有界毫秒区间内随机取值。停不停由语义决定，代码只画边界。 */
function beatPauseMs(part: ReplyPart): number | undefined {
  if (!part.beat) return undefined;
  const [lo, hi] = BEAT_RANGES_MS[part.beat];
  return lo + Math.random() * (hi - lo);
}

export class Runtime {
  readonly agent: Agent;
  private active = new Map<
    string,
    { promise: Promise<void>; controller: AbortController; kind?: string }
  >();
  private timer?: ReturnType<typeof setInterval>;
  private scheduleTimer?: ReturnType<typeof setInterval>;
  private embedTimer?: ReturnType<typeof setInterval>;
  private embedding = false;
  private stopped = false;
  /** 有新用户事件待评估想法的联系人；schedule() 消费后移除。按联系人
   *  记账：A 的新消息不该触发 B 的想法评估，也不能被 B 的评估清掉。 */
  private pendingIdeaEvents = new Set<string>();
  /** 想法评估进行中的联系人：评估是异步模型调用，护栏防止调度器
   *  在它完成前反复重新发起同一批评估。 */
  private considering = new Set<string>();
  /** 全部进行中的回填（不止启动那次）：停机关库前要等它们全部落地。 */
  private readonly backfills = new Set<Promise<void>>();
  private backfillController = new AbortController();
  /** 气泡真正发出去之前不可见的 asked 标记；发送失败就弄丢承诺。 */
  private pendingEffects = new Map<string, { loops: string[]; threads: string[] }>();

  constructor(readonly options: RuntimeOptions) {
    this.agent = new Agent(options);
  }
  get store(): Store {
    return this.options.store;
  }

  start() {
    this.store.recover();
    this.stopped = false;
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
    if (!result.duplicate && active && (active.kind === 'chat' || active.kind === 'proactive'))
      active.controller.abort();
    // 主动 v2：对方的新消息是真实事件——正在 waiting 的想法可能因此
    // 释放（"忙完了"），也可能让 fold 的想法重新值得单独说。事件到达
    // 后交给调度器统一评估（不在消息路径里做模型调用）。
    if (!result.duplicate) this.pendingIdeaEvents.add(peer);
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
            const pause = beatPause ?? Math.min(2500, 400 + Math.min(80, chars) * 25);
            await sleep(pause, entry.controller.signal);
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
        if (task.kind === 'chat' || task.kind === 'proactive') {
          // 排队中的开环提醒只是排队那一刻的判断：期间它可能被聊天轮
          // 了结、被别的提醒问过、或已滑出询问窗口——照发就会"提醒"
          // 用户刚处理完的事。
          if (task.kind === 'proactive') {
            const loopId = typeof task.payload?.loop === 'string' ? task.payload.loop : '';
            if (
              loopId &&
              !this.store.dueOpenLoops(peer.id, Date.now()).some((l) => l.id === loopId)
            ) {
              this.store.finish(task.id, 'done');
              continue;
            }
          }
          // 开场白任务是批准联系人时的首次问候：普通门控对从未说话的
          // 联系人必然否决，非空开场白跳过它；空串是"没配开场白"。
          const isGreeting =
            task.kind === 'proactive' &&
            typeof task.payload.greeting === 'string' &&
            (task.payload.greeting as string).trim() !== '';
          if (
            task.kind === 'proactive' &&
            !isGreeting &&
            !this.proactiveGate(task, peer, Date.now())
          ) {
            // superseded 而不是 done：否决的常见原因是到期点落进安静时段
            // （或竞速的提醒吃掉了当日配额），done 会把去重键烧掉一整天。
            this.store.finish(task.id, 'superseded');
            continue;
          }
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
              // 主动 v2：聊天中形成的想法落库（"这个改天想跟他说"）。
              // 来源校验用对话可见的 ID 集（最近消息 + 记忆），模型引用
              // 没见过的来源直接淘汰。
              if (reply.initiatives.length) {
                const available = new Set([
                  ...this.store.history(peerId, 40).map((m) => m.id),
                  ...(reply.pickedMemoryIds ?? []),
                ]);
                for (const input of reply.initiatives) {
                  if (!input.sources.every((s) => available.has(s))) continue;
                  this.store.upsertInitiative(peerId, input, Date.now());
                }
                // 新想法是事件：schedule 的下一拍会评估它。
                this.pendingIdeaEvents.add(peerId);
              }
              // 记忆写入后置，版本不匹配时整体放弃。
              await this.dedupeMemories(peerId, reply.memories, signal);
              this.store.applyMemoryUpdates(peerId, task.version, reply.memories);
              // 主动 v2：这次主动真的说出了那个想法——说完即退场，同一
              // 由头不会被同一句话反复消费。模型选择跳过（无气泡）时
              // 释放但标记已表达过：同一版本不再自动重评，防止没完没了
              // 地拿同一个念头打扰；新事件仍会带来新版本。
              if (task.kind === 'proactive' && typeof task.payload.initiative === 'string') {
                const initiativeId = task.payload.initiative as string;
                this.store.releaseInitiative(peerId, initiativeId, Date.now());
                if (!reply.parts.length)
                  this.store.sql
                    .prepare("UPDATE initiatives SET origin='生成时选择跳过' WHERE id=?")
                    .run(initiativeId);
              }
              // 每次进提示词都是一次演练：巩固按间隔增长、细节时钟重置；
              // 带情绪残留的记忆被想起时泛化成此刻的心情。被跳过的主动
              // 联系（没产出气泡）不算演练。
              if (reply.pickedMemoryIds?.length && reply.parts.length) {
                const residues = this.store.markMemoriesUsed(peerId, reply.pickedMemoryIds);
                const pulse = residuePulse(residues);
                if (pulse)
                  this.store.pulseMood(
                    peerId,
                    { valence: pulse.valence, reason: pulse.reason },
                    Date.now(),
                  );
              }
              if (reply.moodPulse) this.store.pulseMood(peerId, { ...reply.moodPulse }, Date.now());
              for (const description of reply.descriptions) {
                const msg = this.store.getMessage(peerId, description.messageId);
                if (msg) {
                  this.store.updateMedia(
                    peerId,
                    msg.id,
                    msg.media.map((m) =>
                      m.kind === 'image' ? { ...m, description: description.description } : m,
                    ),
                  );
                }
              }
            }
          } finally {
            void Promise.resolve(typing)
              .then(() => this.options.transport.typing?.(peer, false))
              .catch(() => {});
          }
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
    if (task.kind !== 'proactive') {
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
    // 没说话（模型选择跳过）什么都没问；聊别的也什么都没问。只标模型
    // 声明提到的——契约要求显式声明（缺席会被 agent 修一轮），说没问
    // 就是没问，第二天自然会再给一次机会，不用词面匹配去猜。
    const spoken =
      reply.parts?.map((p) => ('text' in p ? String(p.text ?? '') : '')).join(' ') ?? '';
    if (!spoken.trim()) return [];
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
    if (task.kind === 'proactive') return [];
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
    if (!records.length) return;
    // 纯沉默日（只有她自己发过的主动问候）不写日记：没有可回看的经历，
    // 任务注定返回空 sections。这些日子直接越过游标；手动整理交给模型。
    let start = 0;
    let skippedThrough = after;
    while (start < records.length) {
      const day = dayAt(records[start]!.created_at, this.options.config().timeZone);
      let end = start;
      while (
        end < records.length &&
        dayAt(records[end]!.created_at, this.options.config().timeZone) === day
      )
        end++;
      if (force || records.slice(start, end).some((m) => m.role === 'user')) break;
      skippedThrough = records[end - 1]!.seq;
      start = end;
    }
    if (skippedThrough > after) this.store.setSetting(`diary_cursor:${peerId}`, skippedThrough);
    if (start >= records.length) return;
    const day = dayAt(records[start]!.created_at, this.options.config().timeZone);
    let chars = 0;
    const picked = [];
    for (let i = start; i < records.length; i++) {
      const m = records[i]!;
      if (dayAt(m.created_at, this.options.config().timeZone) !== day) break;
      const size = renderMessage(m).length;
      if (picked.length && chars + size > DIARY_MAX_CHARS) break;
      picked.push(m);
      chars += size;
    }
    const through = picked.at(-1)!.seq;
    const id = this.store.enqueue(peerId, 'diary', `${day}:${through}`, {
      day,
      through,
      after: Math.max(after, skippedThrough),
      ids: picked.map((m) => m.id),
    });
    this.pump();
    return id;
  }

  /** 主动消息的硬护栏（发送前的最后闸门）。想不想说、说什么由想法与
   *  模型决定；代码只负责：安静时段不吵、读空气刹车、渠道许可。没有
   *  每日上限、没有两小时间隔——那些是配额，不是性格；防重复靠想法
   *  的生命周期（同源不重发、说过即退场），防打扰靠这一道闸门。 */
  proactiveAllowed(peer: Peer, now: number): boolean {
    const c = this.options.config(),
      hour = hourAt(now, c.timeZone);
    if (!(
      c.proactiveEnabled &&
      !!peer.approved &&
      !!peer.context_token &&
      peer.channel === 'wechat' &&
      peer.last_user_at > 0 &&
      !inQuietHours(hour, c.quietStart, c.quietEnd)
    ))
      return false;
    const streak = this.store.unansweredProactiveStreak(peer.id);
    if (streak >= 2) return now - peer.last_proactive_at >= silenceCooldownMs(streak);
    return true;
  }
  /** 主动任务的门槛分流：带 payload.loop 的走开环独立通道（承诺优先于
   *  读空气与日常分享），其余走日常闸门。 */
  private proactiveGate(task: Task, peer: Peer, now: number): boolean {
    if (typeof task.payload?.loop === 'string') return this.loopPingAllowed(peer, now);
    return this.proactiveAllowed(peer, now);
  }
  /** 到期开环的独立通道：承诺优先于日常闲聊与读空气刹车（对方明确托付的
   *  约定不该被冷落饿死）；安静时段仍然有效。不受"上次主动两小时内"
   *  限制：早上八点的闲聊问候不该把"今天提醒我"拖到晚上。 */
  loopPingAllowed(peer: Peer, now: number): boolean {
    const c = this.options.config(),
      hour = hourAt(now, c.timeZone);
    return Boolean(
      c.proactiveEnabled &&
      !!peer.approved &&
      !!peer.context_token &&
      peer.channel === 'wechat' &&
      peer.last_user_at > 0 &&
      !inQuietHours(hour, c.quietStart, c.quietEnd),
    );
  }

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
    for (const peer of this.store.peers().filter((p) => p.approved)) {
      try {
        if (hour >= c.diaryHour) this.queueDiary(peer.id, false, now);
        // 到期开环优先且与日常互斥：一次调度最多花一条主动消息。
        const dueLoops = this.store.dueOpenLoops(peer.id, now);
        const loop =
          dueLoops.length > 0 && this.loopPingAllowed(peer, now)
            ? dueLoops.find(
                (candidate) =>
                  !this.store.hasPendingTask(
                    peer.id,
                    'proactive',
                    `${this.store.loopTaskKey(candidate)}:${dayAt(now, c.timeZone)}`,
                  ),
              )
            : undefined;
        if (loop) {
          // 到期的约定不挑时间——承诺不该等作息，也不做行为抖动。
          this.store.enqueue(
            peer.id,
            'proactive',
            // 到期日在 key 里：yearly 滚动靠它区分。
            `${this.store.loopTaskKey(loop)}:${dayAt(now, c.timeZone)}`,
            { loop: loop.id },
            now,
          );
          this.pump();
          continue;
        }
        // 主动 v2：想法评估由事件驱动（新用户消息置 pendingIdeaEvents，
        // 或者存在尚未评估过的新想法）。没有事件与未处理变化时不调用
        // 模型——时间流逝本身不再制造聊天理由。
        if (!c.proactiveEnabled || !this.proactiveAllowed(peer, now)) continue;
        this.seedIdleMuse(peer, now);
        const ideaEvent = this.pendingIdeaEvents.has(peer.id);
        // "新鲜"= 值得再评一轮：从未评估过（origin 空）。hold 的想法不在
        // 此列：条件没满足时不该被反复重问。
        const hasFresh = this.store
          .activeInitiatives(peer.id)
          .some(
            (idea) =>
              !this.store.hasPendingTask(peer.id, 'proactive', `idea:${idea.id}:${idea.version}`) &&
              idea.origin === '',
          );
        if (!ideaEvent && !hasFresh) continue;
        if (this.considering.has(peer.id)) continue;
        this.evaluateInitiatives(peer.id, now);
      } catch (error) {
        this.options.log?.('联系人调度失败，本轮跳过', {
          peer: peer.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    this.pump();
  }

  /** 空闲碎碎念（图灵审查修复 #1）：事件驱动的想法评估在"对方一直不说话"
   *  时是死的——真人一个月里总有几次手痒（想起一个梗、看到海、单纯想他了），
   *  一个永远等对方先开口的人比任何口癖都像机器人。这里按低频时间通道给
   *  沉默注入一条 muse 想法（无来源，meaning 只是"想说一句"的冲动），
   *  立项后仍走完整评估链路：模型在评估时说"安静"就安静，说"说"才说。
   *  频率：距对方上次消息 ≥ MUSE_SILENCE_MIN_HOURS 且距上次立项 ≥
   *  MUSE_COOLDOWN_DAYS 天，每天至多一条；安静时段与读空气刹车照常拦在
   *  评估与发送之前。 */
  private seedIdleMuse(peer: Peer, now: number): void {
    if (this.pendingIdeaEvents.has(peer.id)) return;
    if (peer.last_user_at <= 0) return;
    const sinceUser = now - peer.last_user_at;
    if (sinceUser < MUSE_SILENCE_MIN_HOURS * 3600000) return;
    const lastSeeded = this.store.getSetting<number>(`muse_seeded_at:${peer.id}`, 0);
    if (now - lastSeeded < MUSE_COOLDOWN_DAYS * 86400000) return;
    // 已经有活跃的 muse 轮在等评估时不再叠一条。
    if (this.store.activeInitiatives(peer.id).some((idea) => idea.kind === 'muse')) return;
    const day = dayAt(now, this.options.config().timeZone);
    const topicKey = `idle-muse:${day}`;
    if (this.store.activeInitiativeByTopic(peer.id, topicKey)) return;
    // 冲动措辞带一点当下感，模型评估时只当"想说一句"的素材，不保证说。
    const hours = Math.floor(sinceUser / 3600000);
    const meaning = `他安静了挺久了（约 ${hours} 小时没说话）。此刻就是有点想他/想找个话头，没有具体的事——要不要随口说一句`;
    this.store.upsertInitiative(peer.id, { topicKey, kind: 'muse', meaning, sources: [] }, now);
    this.store.setSetting(`muse_seeded_at:${peer.id}`, now);
    this.pendingIdeaEvents.add(peer.id);
  }

  /** 把当前想法交给模型评估一轮。每个想法版本只评估一次（幂等键 =
   *  ideaId:version），评估结束清事件标记；评估在后台异步完成，期间
   *  用 considering 护栏挡住调度器的重复发起。 */
  private evaluateInitiatives(peerId: string, now: number): void {
    if (this.considering.has(peerId)) return;
    const initiatives = this.store.activeInitiatives(peerId);
    this.pendingIdeaEvents.delete(peerId);
    if (!initiatives.length) return;
    // 清理来源已失效的想法（消息被删、记忆被替代）。
    this.store.expireInitiatives(peerId, (id) => !!this.sourceExists(peerId, id), now);
    const pending = this.store
      .activeInitiatives(peerId)
      .filter(
        (idea) =>
          !this.store.hasPendingTask(peerId, 'proactive', `idea:${idea.id}:${idea.version}`),
      );
    if (!pending.length) return;
    this.considering.add(peerId);
    const consider = considerInitiatives({
      store: this.store,
      agent: this.agent,
      peerId,
      initiatives: pending,
      log: this.options.log,
    })
      .catch((error) => {
        this.options.log?.('想法评估异常', {
          peer: peerId,
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        this.considering.delete(peerId);
        this.pump();
      });
    // 评估是异步模型调用：完成后若入队了主动消息，泵会把它消费掉。
    void consider;
  }
  /** 想法来源是否仍然有效：消息在历史里、记忆活跃、或约定/挂念开着。 */
  private sourceExists(peerId: string, sourceId: string): boolean {
    if (this.store.getMessage(peerId, sourceId)) return true;
    if (this.store.memories(peerId).some((m) => m.id === sourceId && m.status === 'active'))
      return true;
    if (this.store.openLoops(peerId).some((l) => l.id === sourceId && l.status === 'open'))
      return true;
    if (this.store.softThreads(peerId).some((t) => t.id === sourceId && t.status === 'open'))
      return true;
    return false;
  }
}
