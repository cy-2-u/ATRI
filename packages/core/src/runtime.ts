import type { Store, Peer, ReplyPart, Task, Media, MemoryUpdate } from '@atri/db';
import { hourFormatter } from '@atri/db';
import { Agent, renderMessage, type AgentOptions } from './agent.js';
import { moodPulseFromExchange } from './mood.js';
import { estimateTextTokens, cosineSimilarity } from '@atri/llm';
import {
  NOTES_MIN_MESSAGES,
  NOTES_WINDOW,
  NOTES_BUDGET_SHARE,
  NOTES_TAIL_EXEMPT,
  DIARY_MAX_CHARS,
  PROACTIVE_JITTER_MINUTES,
  EMBED_BACKFILL_BATCH,
  PROACTIVE_IGNORE_LIMIT,
  PROACTIVE_IGNORE_COOLDOWN_DAYS,
  SIMILARITY_SUPERSEDE,
} from './constants.js';

/** Minimal embedding surface the runtime needs; implemented by apps/api. */
export interface Embedder {
  configured: boolean;
  model: string;
  /** Whether the operator wants vectors at all (a switch separate from config). */
  enabled?: boolean;
  embed(texts: string[], signal?: AbortSignal): Promise<Float32Array[]>;
}

export interface RuntimeConfig {
  timeZone: string;
  diaryHour: number;
  proactiveEnabled: boolean;
  quietStart: number;
  quietEnd: number;
  proactiveAfterHours: number;
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
/** Retry backoff for failed non-chat tasks: 1 min, 2, 4, 8… capped at 30 min.
 *  attempt 1 is the first failure, so the Nth failure waits 2^(N-1) minutes. */
export function taskBackoffMs(attempts: number): number {
  return Math.min(30, 2 ** Math.max(0, attempts - 1)) * 60000;
}
/** A user→assistant pair wider than this is not a conversation exchange; the
 *  assistant message is a proactive ping answering silence, so the rule-based
 *  mood pulse must not read the old user message as fresh evidence. */
const REPLY_PAIR_WINDOW_MS = 30 * 60000;
/** A reply can be up to MAX_REPLY_PARTS bubbles. Looking back only two
 *  messages made both of them assistant rows, so the user side of the exchange
 *  disappeared and the mood pulse never ran. */
const MOOD_LOOKBACK_MESSAGES = 16;
/** Per-drain task budget for one peer. Delivery rounds also consume it, so it
 *  bounds one pump cycle rather than one kind of work. */
const MAX_WORK_ITERATIONS = 12;
export function inQuietHours(hour: number, start: number, end: number) {
  return start === end
    ? false
    : start < end
      ? hour >= start && hour < end
      : hour >= start || hour < end;
}
/** Abortable pause: resolves early when `signal` fires, so shutdown and
 *  supersede do not have to sit through the remaining delay. */
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
/** Loose overlap test for "did this message mention that plan": CJK bigrams and
 *  latin words of 3+ characters, ignoring stop-word-ish short tokens. */
function sharesTerm(content: string, spoken: string): boolean {
  const normalize = (text: string) => text.normalize('NFKC').toLowerCase();
  const body = normalize(spoken);
  const terms = normalize(content).match(/[\p{L}\p{N}]+/gu) ?? [];
  return terms.some((word) => {
    if (/\p{Script=Han}/u.test(word)) {
      if (word.length < 2) return false;
      return Array.from({ length: word.length - 1 }, (_, i) => word.slice(i, i + 2)).some((bi) =>
        body.includes(bi),
      );
    }
    return word.length >= 3 && body.includes(word);
  });
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
  /** Every in-flight backfill, not just the startup one. A periodic drip can
   *  still be embedding when shutdown closes the database. */
  private readonly backfills = new Set<Promise<void>>();
  private backfillController = new AbortController();
  /** Asked-state changes that must not become visible until a bubble has
   *  actually left the process. Marking at save time lost a reminder forever
   *  whenever the very first delivery failed permanently. */
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
    // Vector backfill: one full drain at startup (an import of thousands of
    // rows must not take a day of 64-row drips to become searchable), then a
    // 5-minute drip keeps new content indexed without competing with chat.
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
    // A backfill can still be holding the embedder / Store open when shutdown
    // closes the database. Await every tracked run, not only the startup one.
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
  /** Index content that lacks vectors; best-effort, never blocks chat.
   *  `quick` caps the work per peer (periodic drip); a full pass at startup or
   *  after enabling vectors drains the backlog in one go instead of taking
   *  hours of 64-row batches to make a large import searchable. */
  private async backfillEmbeddings(quick = true) {
    const embedder = this.options.embedder;
    if (!embedder || this.embedding || this.stopped || !embedder.configured) return;
    if (embedder.enabled === false) return;
    this.embedding = true;
    try {
      for (const peer of this.store.peers()) {
        if (this.stopped) return;
        // A switched embedding model leaves the old vectors in place: they
        // would never refresh (pendingEmbeddings only sees rows without any
        // vector) and are not comparable with new query vectors. Drop them so
        // the normal backfill re-embeds everything with the current model.
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
          // A provider that silently drops rows would leave `pending` unchanged
          // and the full pass would spin forever. Fail the batch, keep the rest.
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
    // Only a turn that produces user-facing output is worth cancelling: its
    // reply would answer an already-superseded message. Diary and notes are
    // background writes with no visible target — aborting them on every new
    // user message meant a chatty contact's diary restarted forever and never
    // finished (each abort also re-queued it 60s later, burning an LLM call).
    // A duplicate event produced no new message, so there is nothing for the
    // active turn to be stale against; aborting here only burned a rerun.
    if (!result.duplicate && active && (active.kind === 'chat' || active.kind === 'proactive'))
      active.controller.abort();
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
    // A model-supplied moodPulse is the authoritative read on this exchange.
    // Running the coarse rule pulse afterwards as well double-counted the same
    // message (especially patience), so remember which tasks already pulsed.
    const modelMoodTasks = new Set<string>();
    for (let n = 0; n < MAX_WORK_ITERATIONS && !this.stopped; n++) {
      const peer = this.store.peer(peerId);
      if (!peer) return;
      if (!peer.approved) return;
      const deliveries = this.store.pendingDeliveries(peerId);
      if (deliveries.length) {
        entry.kind = 'delivery';
        const task = this.store.taskById(deliveries[0].task_id);
        if (!task) {
          // The task row was pruned while its outbox rows survived. Retire the
          // orphaned bubbles instead of dereferencing undefined and killing the
          // whole peer's queue.
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
          // A new user message aborts the turn between bubbles. Without this
          // check the remaining bubbles of the stale reply were still sent,
          // because sleep() resolves early on abort and the loop continued.
          if (entry.controller.signal.aborted) return;
          const current = this.store.peer(peerId);
          if (!current || current.version !== peer.version) {
            this.store.cancelUnsent(task);
            this.discardPendingEffects(task.id);
            break;
          }
          const delivery = own[i]!;
          // The row may have been confirmed/cancelled by the operator while the
          // previous bubble was sending; never send a bubble that is no longer
          // pending.
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
              // The bubble may have reached the user: stop the batch rather than
              // risk sending the rest twice. The operator resolves this row.
              this.commitPendingEffects(task.id);
              return;
            }
            failedDelivery ??= message;
            if (!deliveredAny) {
              // Nothing from this reply has been delivered. Sending the tail
              // would leave a half-answer, so retire it and surface one failed
              // task for the operator.
              this.store.cancelPendingForTask(task.id, delivery.id, message);
              this.discardPendingEffects(task.id);
              break;
            }
            // A later bubble failed (for example an unavailable sticker) after
            // text was already delivered. Keep going with the remaining text:
            // cancelling it here permanently truncated the reply.
          }
          if (i < own.length - 1) {
            // Human-like pacing: longer bubbles get longer pauses, never a
            // machine-gun burst. Capped so a batch still sends promptly.
            // Compared against `own`, not the whole pending list: another
            // task queued behind this one must not add a pointless pause.
            const next = own[i + 1];
            const chars = next?.part.type === 'text' ? (next.part.text?.length ?? 0) : 6;
            // Interruptible: stop() aborts the controller, and a bare setTimeout
            // here kept the shutdown waiting out every remaining pause.
            await sleep(Math.min(2500, 400 + Math.min(80, chars) * 25), entry.controller.signal);
          }
        }
        if (failedDelivery) this.store.finish(task.id, 'failed', failedDelivery);
        this.maybeMood(peerId, modelMoodTasks.delete(task.id));
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
          // A queued loop ping is only a claim about the moment it was
          // scheduled. The loop may have been resolved by a chat turn, already
          // asked by another ping, or rolled past its due window while this
          // task waited in the queue. Replying anyway would "remind" the user
          // about something they just settled.
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
          // Greeting tasks are the first-contact hello queued on approval; the
          // normal proactive gate (silence clock, quiet hours) would veto a
          // peer that has never messaged, so a non-empty greeting skips it.
          // Blank means "no opener configured" — the server no longer enqueues
          // those, but a legacy row may still exist, and an empty string is
          // falsy so it correctly falls through to the regular gate.
          const isGreeting =
            task.kind === 'proactive' &&
            typeof task.payload.greeting === 'string' &&
            (task.payload.greeting as string).trim() !== '';
          if (
            task.kind === 'proactive' &&
            !isGreeting &&
            !this.proactiveGate(task, peer, Date.now())
          ) {
            // superseded, not done: the usual veto reason is that jitter pushed
            // run_at into quiet hours (or the daily quota was consumed by a
            // racing ping). `done` would burn that dedupe key for the whole
            // day/loop period; `superseded` lets the next scheduler tick
            // re-enqueue and try again inside the remaining window.
            this.store.finish(task.id, 'superseded');
            continue;
          }
          const typing = this.options.transport.typing?.(peer, true).catch(() => {});
          try {
            const reply = await this.agent.reply(task, signal);
            await this.dedupeMemories(peerId, reply.memories, signal);
            const saved = this.store.saveReply(task, reply.parts, reply.memories);
            if (saved) {
              const loops = this.applyOpenLoops(task, reply);
              const threads = this.applySoftThreads(task, reply);
              if (loops.length || threads.length) {
                this.pendingEffects.set(task.id, { loops, threads });
                // Persist across a crash between save and delivery: the outbox
                // retries the bubbles after restart, and the asked-state must
                // travel with them or the reminder can be sent twice.
                this.store.setSetting(`pending_effects:${task.id}`, { loops, threads });
              }
              // Every prompt inclusion is a memory "use", not only tool hits —
              // otherwise the hits-based ranking sees a fraction of reality.
              if (reply.pickedMemoryIds?.length)
                this.store.markMemoriesUsed(peerId, reply.pickedMemoryIds);
              if (reply.moodPulse) {
                this.store.pulseMood(peerId, { ...reply.moodPulse }, Date.now());
                modelMoodTasks.add(task.id);
              }
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
          // A new user message already queued a newer chat turn. Re-queueing
          // this aborted one as well made both run: the user got an answer to
          // the old message and then a second answer to the new one. The newer
          // turn supersedes it; the same applies to a proactive ping that was
          // interrupted by the reply it was waiting for.
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
          // Backoff, not an immediate re-queue: a systematically failing task
          // (bad model output, persona over budget) must not burn one LLM call
          // per scheduler minute. state stays 'failed' so issues() keeps listing
          // it and a newer user reply can still supersede it; manual retry via
          // /api/tasks/:id/retry resets run_at to now and re-queues.
          this.store.deferFailed(task.id, taskBackoffMs(task.attempts));
        }
      }
    }
  }
  /** Semantic duplicate guard: models restate known facts in new wording and
   *  only sometimes fill supersedes. Before persisting, embed each new memory
   *  and, when it lands within SIMILARITY_SUPERSEDE of an active memory vector,
   *  auto-supersede the old row so recall stays clean. Failures (no embedder,
   *  embedding error) keep the model-provided supersedes untouched. */
  private async dedupeMemories(peer: string, updates: MemoryUpdate[], signal?: AbortSignal) {
    const embedder = this.options.embedder;
    if (!updates.length || !embedder || embedder.enabled === false || !embedder.configured) return;
    const memories = this.store.embeddings(peer, 'memory');
    if (!memories.length) return;
    // One batched call instead of one HTTP round trip per update: this ran
    // before saveReply, so every serial embed was added to the visible reply
    // latency.
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
  /** Commit asked-state once delivery is known (sent, or uncertain enough that
   *  retrying would double-ask). Certain failure/cancel discards it. */
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
  /** Open loops: resolve loops the user just answered, record new ones,
   *  mark due loops as asked only when the model actually brought them up,
   *  and expire old ones. */
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
    // A proactive message has no user turn behind it. Letting the model create
    // or resolve dated plans there invents commitments out of old messages;
    // the same rule already applies to soft threads. Proactive turns may only
    // mark the due loop they actually mentioned.
    if (task.kind !== 'proactive') {
      for (const id of reply.resolveLoops ?? [])
        store.resolveOpenLoop(peer, id, now, this.options.config().timeZone);
      for (const loop of reply.openLoops ?? []) {
        if (!Number.isFinite(loop.dueAt) || loop.dueAt < now - 86400000) continue;
        if (!loop.sources.length) continue;
        store.addOpenLoop(peer, loop, now);
      }
      // Normal chat turns were previously excluded from asked-state entirely:
      // if she naturally asked about a due plan while replying, the loop stayed
      // open and was asked again by the scheduler.
      return [...new Set(explicit)];
    }
    // A ping that says nothing (the model chose to skip) asked nothing; a ping
    // that talks about something else also asked nothing. Mark only what the
    // model reports mentioning, so "每件只问一次" holds.
    const spoken =
      reply.parts?.map((p) => ('text' in p ? String(p.text ?? '') : '')).join(' ') ?? '';
    if (!spoken.trim()) return [];
    const matched = explicit.length
      ? explicit
      : // The prompt asks for askedLoops; a model that omits it gets one
        // fallback only: what the sent text actually mentions. Trusting the
        // task's loop id here marked the reminder as asked even when the model
        // talked about something else, silently dropping the promise.
        [...due.values()].filter((loop) => sharesTerm(loop.content, spoken)).map((loop) => loop.id);
    return [...new Set(matched)];
  }
  /** Undated concerns/promises: record, resolve, and mark the one this reply
   *  actually brought up. They never create tasks or pings; the scheduler only
   *  ever sees `open_loops`. */
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
    // A proactive message has no user turn behind it; letting the model write
    // new concerns there would let it invent worries out of nothing.
    if (task.kind === 'proactive') return [];
    for (const id of reply.resolveThreads ?? []) store.resolveSoftThread(peer, id, now);
    for (const thread of reply.threads ?? []) {
      if (!thread.sources.length) continue;
      store.addSoftThread(peer, thread, now);
    }
    const open = new Set(store.softThreads(peer, true).map((t) => t.id));
    return [...new Set((reply.askedThreads ?? []).filter((id) => open.has(id)))];
  }
  /** After a delivered exchange, pulse the light mood state from the last
   *  user/assistant pair; runs at most once per finished task batch. */
  private maybeMood(peerId: string, skipRulePulse = false) {
    // The model already supplied an explicit pulse for this task. Running the
    // rule pulse on top would either double the same signal or overwrite the
    // model's reason with a coarse keyword guess.
    if (skipRulePulse) return;
    const peer = this.store.peer(peerId);
    if (!peer) return;
    const recent = this.store.history(peerId, MOOD_LOOKBACK_MESSAGES);
    // Find the newest assistant bubble first, then the user message it answers.
    // Looking back only two rows (or picking each role independently) breaks as
    // soon as the reply is split into multiple bubbles: the latest rows are all
    // assistant and the user side is no longer in the window.
    const assistant = [...recent].reverse().find((m) => m.role === 'assistant');
    const user = assistant
      ? [...recent].reverse().find((m) => m.role === 'user' && m.created_at <= assistant.created_at)
      : undefined;
    // Only a genuine exchange pulses: the user message must be inside the reply
    // window before the assistant turn. Without this guard, a proactive ping
    // paired itself with a days-old user message and re-injected the same stale
    // mood (last week's "好累") on every ping.
    if (
      user &&
      assistant &&
      user.created_at <= assistant.created_at &&
      assistant.created_at - user.created_at <= REPLY_PAIR_WINDOW_MS
    ) {
      const recentUserTexts = recent
        .filter((m) => m.role === 'user' && m.created_at <= assistant.created_at)
        .slice(-6)
        .map((m) => m.content);
      const pulse = moodPulseFromExchange({
        user: user.content,
        assistant: assistant.content,
        hour: hourAt(user.created_at, this.options.config().timeZone),
        recentUserTexts,
      });
      if (pulse) this.store.pulseMood(peerId, pulse, Date.now());
    }
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
    // Keep the newest NOTES_TAIL_EXEMPT messages out of the summary. The old
    // index left only 12, so a compliant summary always swallowed one extra
    // recent message and the context notes described a turn still in flight.
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
    const day = dayAt(records[0].created_at, this.options.config().timeZone);
    let chars = 0;
    const picked = [];
    for (const m of records) {
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
      after,
      ids: picked.map((m) => m.id),
    });
    this.pump();
    return id;
  }
  proactiveAllowed(peer: Peer, now: number): boolean {
    const c = this.options.config(),
      hour = hourAt(now, c.timeZone);
    if (!(
      c.proactiveEnabled &&
      !!peer.approved &&
      !!peer.context_token &&
      peer.channel === 'wechat' &&
      peer.last_user_at > 0 &&
      now - peer.last_user_at >= c.proactiveAfterHours * 3600000 &&
      now - peer.last_proactive_at >= 12 * 3600000 &&
      !inQuietHours(hour, c.quietStart, c.quietEnd) &&
      (!peer.last_proactive_at ||
        dayAt(peer.last_proactive_at, c.timeZone) !== dayAt(now, c.timeZone))
    ))
      return false;
    // 读空气 brake: unanswered pings stretch the cooldown from hours to days.
    const streak = this.store.unansweredProactiveStreak(peer.id);
    if (streak >= PROACTIVE_IGNORE_LIMIT)
      return now - peer.last_proactive_at >= PROACTIVE_IGNORE_COOLDOWN_DAYS * 86400000;
    // Very low energy or a fed-up mood means she would not start a
    // conversation at all; this is the mood doing something, not just tinting
    // sentences. A due loop still gets through (loopPingAllowed), because a
    // promise outranks a mood.
    const mood = this.store.mood(peer.id);
    return mood.energy > -0.6 && mood.patience > -0.6;
  }
  /** Which gate a claimed proactive task must pass: loop pings (payload.loop)
   *  use the dedicated due-loop quota, casual pings the daily one. */
  private proactiveGate(task: Task, peer: Peer, now: number): boolean {
    if (typeof task.payload?.loop === 'string') return this.loopPingAllowed(peer, now);
    return this.proactiveAllowed(peer, now);
  }
  /** A due open loop may ping even when the daily casual quota is spent —
   *  remembering beats small talk — but silence, quiet hours and the brake
   *  still hold. The independent quota only exempts the calendar-day check;
   *  it must not turn a promise into an interruption while the user is here. */
  loopPingAllowed(peer: Peer, now: number): boolean {
    const c = this.options.config(),
      hour = hourAt(now, c.timeZone);
    if (!(
      c.proactiveEnabled &&
      !!peer.approved &&
      !!peer.context_token &&
      peer.channel === 'wechat' &&
      peer.last_user_at > 0 &&
      now - peer.last_user_at >= c.proactiveAfterHours * 3600000 &&
      !inQuietHours(hour, c.quietStart, c.quietEnd)
    ))
      return false;
    const streak = this.store.unansweredProactiveStreak(peer.id);
    if (streak >= PROACTIVE_IGNORE_LIMIT)
      return now - peer.last_proactive_at >= PROACTIVE_IGNORE_COOLDOWN_DAYS * 86400000;
    // The due-loop quota is independent of the daily casual one on purpose — a
    // promise outranks small talk, so a loop may still be asked on a day the
    // casual ping already went out. The 12-hour spacing is what bounds the
    // write rate here; tying it to the calendar day as well made the two gates
    // identical and the "independent quota" a no-op.
    return now - peer.last_proactive_at >= 12 * 3600000;
  }
  schedule(now = Date.now()) {
    if (this.stopped) return;
    const c = this.options.config(),
      hour = hourAt(now, c.timeZone);
    // Housekeeping piggybacks on the one-minute scheduler tick instead of
    // having its own timer. It must never take the scheduler down with it: one
    // failing sweep (a constraint, a locked row) used to throw out of the
    // setInterval callback, which stops every diary, ping and loop reminder —
    // and, unhandled, exited the process.
    try {
      this.store.pruneTasks(now);
    } catch (error) {
      this.options.log?.('清理旧任务失败，本轮跳过', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    for (const peer of this.store.peers().filter((p) => p.approved)) {
      // One broken peer row must not starve every contact after it in the list.
      try {
        if (hour >= c.diaryHour) this.queueDiary(peer.id, false, now);
        // A due loop is checked first and wins over casual small talk. The old
        // order only looked at loops when the daily casual quota was already
        // spent, so a due loop could be starved forever on days the casual ping
        // went out first. Keeping them mutually exclusive also spends at most
        // one proactive message per scheduler pass.
        // dueOpenLoops already filters asked=0 in SQL; re-filtering here did
        // nothing except suggest the query was untrusted.
        const dueLoops = this.store.dueOpenLoops(peer.id, now);
        // Pick the first loop whose ping is not already queued. Selecting
        // dueLoops[0] unconditionally meant one loop waiting behind another
        // (or failing repeatedly) starved every later due promise.
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
        const casual = !loop && this.proactiveAllowed(peer, now);
        if (loop || casual) {
          // Randomized delay so proactive pings do not land at the same minute
          // every day — a small step toward a human-like rhythm.
          const jitter = Math.floor(Math.random() * PROACTIVE_JITTER_MINUTES) * 60000;
          this.store.enqueue(
            peer.id,
            'proactive',
            // The due date is part of the key: a yearly loop rolled forward must
            // produce a new task instead of hitting last year's finished one.
            // The day is included too: a model that skips ("send nothing") leaves
            // the promise open, and without a per-day key that finished task
            // would suppress every future attempt for the same due date.
            loop
              ? `${this.store.loopTaskKey(loop)}:${dayAt(now, c.timeZone)}`
              : `casual:${dayAt(now, c.timeZone)}`,
            loop ? { loop: loop.id } : {},
            now + jitter,
          );
        }
      } catch (error) {
        this.options.log?.('联系人调度失败，本轮跳过', {
          peer: peer.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    this.pump();
  }
}
