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
  debounceMs: number | (() => number);
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
      Date.now() + numeric(this.options.debounceMs),
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

  /** 历史消息：received/said 事件还原成对话；视觉开启时收到的图片以
   *  data URI 随消息注入（≤2 张、≤5 MB，读不到就只留文字标记）。 */
  private async history(peer: string): Promise<Message[]> {
    const vision = this.options.vision();
    const messages: Message[] = [];
    for (const event of this.journal.conversation(peer, 160)) {
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
            if (vision && parsed.media?.length)
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
    let first = true;
    const pacingOn =
      typeof this.options.pacing === 'function' ? this.options.pacing() : this.options.pacing;
    for (const envelope of envelopes) {
      if (signal.aborted || this.stopped) return;
      if (!first && pacingOn) {
        // 气泡间隔在占用发送位之前进行：被取消就保持待发，下次接着发。
        await this.options.onComposing?.(peer, true).catch(() => undefined);
        await delay(pacingMs(envelope.part), signal);
        await this.options.onComposing?.(peer, false).catch(() => undefined);
        if (signal.aborted || this.stopped) return;
      }
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
    await this.think(turn, signal);
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
        await this.history(turn.peer),
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
      if (!signal.aborted) this.options.onError(error);
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
