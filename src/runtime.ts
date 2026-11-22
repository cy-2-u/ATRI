import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import type { Config } from './config.ts';
import { configured } from './config.ts';
import { publicDownload } from './net.ts';
import { Store, type Turn } from './store.ts';
import type { Incoming, Peer, Thought, Envelope, CommitmentInput, Part } from './types.ts';
import { errorText, peerKey } from './types.ts';
import { beatDelay, eveningArousalMinutes, dayKey, dayStart, nextWakeAfter, instant } from './state.ts';
import { Mind } from './mind.ts';
import { Files, mimeOf } from './files.ts';
import { QQError } from './qq.ts';
import { ModelError } from './model.ts';

export interface Transport {
  passiveRequest(envelope: Envelope, peer: Peer, reserve?: boolean): Record<string, unknown>;
  allowedAt(peer: Peer, active: boolean): number;
  recordActive(peer: Peer): void;
  send(target: Peer['target'], request: Record<string, unknown>, signal: AbortSignal): Promise<string>;
  upload(target: Peer['target'], bytes: Buffer, filename: string, type: number, signal: AbortSignal): Promise<string>;
}

/** 气泡间隔：长度即打字时间。短气泡接得快，长气泡让人等——节奏是人味的一部分。 */
function pacingMs(part: Part, random: () => number = Math.random): number {
  const length = part.type === 'text' ? (part.text ?? '').length : 8;
  const base = length <= 10 ? 1400 : length <= 30 ? 2400 : length <= 80 ? 4200 : 6800;
  return Math.round(base * (0.85 + random() * 0.3));
}

export class Runtime {
  private store: Store;
  private config: () => Config;
  private mind: Pick<Mind, 'think'>;
  private transport: Transport;
  private files: Files;
  private onError: (error: unknown) => void;
  private timer?: ReturnType<typeof setTimeout>;
  private work?: Promise<void>;
  private active?: { peer: string; controller: AbortController };
  private lifetime = new AbortController();
  private started = false;
  private dirty = false;

  constructor(store: Store, config: () => Config, mind: Pick<Mind, 'think'>, transport: Transport, files: Files, onError: (error: unknown) => void = console.error) {
    this.store = store; this.config = config; this.mind = mind; this.transport = transport; this.files = files; this.onError = onError;
  }

  status(): Record<string, unknown> { return { running: this.started, thinking: this.active?.peer ?? null, queued: this.store.jobs().length }; }

  start(): void { if (!this.started) { this.started = true; this.lifetime = new AbortController(); this.reconfigure(); } }

  reconfigure(): void {
    const c = this.config();
    for (const peer of this.store.peers()) {
      if (!peer.enabled || !c.life.enabled) { this.store.dropJobs(peer.id); if (this.active?.peer === peer.id) this.active.controller.abort(new Error('会话已停用')); continue; }
      if (peer.autonomous) this.ensureLife(peer);
      else this.store.dropJobs(peer.id, 'beat'), this.store.dropJobs(peer.id, 'night');
      if (this.store.latestReceived(peer.id) > this.store.get(`seen:${peer.id}`, 0) && !this.store.jobs(peer.id).some(j => j.kind === 'chat')) this.store.schedule(`chat:${peer.id}`, peer.id, 'chat', '尚未处理的入站', this.store.now(), {}, true);
      for (const item of this.store.commitments(peer.id)) if (item.status === 'open' && item.dueAt > 0) this.store.schedule(`commitment:${item.id}:${item.version}`, peer.id, 'commitment', item.content, item.dueAt, { id: item.id, version: item.version, due: item.dueAt });
    }
    this.wake();
  }

  receive(input: Incoming): boolean {
    // 她只属于一个人：群消息不进她的世界；第一个私聊即绑定，其余陌生私聊不再接收（预演不受限）。
    if (input.target.kind === 'group') return false;
    const id = peerKey(input.target);
    if (id !== 'c2c:preview') {
      const bound = this.store.peers().find(p => p.target.kind === 'c2c' && p.id !== 'c2c:preview');
      if (bound && bound.id !== id) return false;
    }
    const event = this.store.receive(input, this.config().life.debounceMs);
    if (!event) return false;
    if (this.active?.peer === event.peer) this.active.controller.abort(new Error('新消息到达'));
    this.wake();
    return true;
  }

  wake(): void {
    if (!this.started) return;
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    this.dirty = true;
    if (this.work) return;
    this.work = this.drain().catch(this.onError).finally(() => { this.work = undefined; if (this.dirty && this.started) this.wake(); else this.arm(); });
  }

  async idle(): Promise<void> { while (this.work) await this.work; }

  private ready(): boolean { const c = this.config(); return c.life.enabled && (configured(c.primary) || configured(c.fallback)); }

  /** 心跳与夜间整理：黏人度决定拍长，睡眠窗推走落在睡里的拍。 */
  private ensureLife(peer: Peer): void {
    const c = this.config(), now = this.store.now(), tz = c.life.timezone;
    const self = this.store.dailySelf(peer.id, tz);
    if (!this.store.jobs(peer.id).some(j => j.kind === 'beat')) {
      const raw = now + beatDelay(self, now, c.life.beatMinutes);
      // replace=true：只会在无 pending 拍时走到这里，顺带清掉 failed/done 旧行——心跳绝不静默死亡。
      this.store.schedule(`beat:${peer.id}`, peer.id, 'beat', '独处的心跳：可以自由安排，也可以什么都不做', this.throughSleep(peer.id, raw), { planned: raw }, true);
    }
    if (peer.target.kind === 'c2c' && !this.store.jobs(peer.id).some(j => j.kind === 'night')) {
      const day = dayKey(now, tz), seed = createHash('sha256').update(`${peer.id}:${day}`).digest();
      const jitter = (seed[0]! % 41) - 20;
      let candidate = dayStart(now, tz) + (c.life.diaryHour * 60 + jitter) * 60000;
      if (candidate <= now + 900000) candidate += 86400000;
      this.store.schedule(`night:${peer.id}:${dayKey(candidate, tz)}`, peer.id, 'night', '夜深了：整理自己的一天与记忆', this.throughSleep(peer.id, candidate), {}, true);
    }
  }

  /** due 落进今晚睡眠窗就推到窗结束；熬夜的夜（18 点后经历多）入睡更晚。 */
  private throughSleep(peerId: string, due: number): number {
    const c = this.config(), tz = c.life.timezone;
    if (c.life.sleepStart === c.life.sleepEnd) return due;
    const sleepDay = dayKey(due - 12 * 3600000, tz);
    const midnight = dayStart(Date.parse(`${sleepDay}T12:00:00Z`), tz);
    const events = this.store.eventsBetween(peerId, ['received', 'accepted', 'action'], midnight, midnight + 86400000, 300);
    const arousal = eveningArousalMinutes(events.map(e => ({ at: e.at })), sleepDay, tz);
    return nextWakeAfter(due, tz, c.life.sleepStart, c.life.sleepEnd, arousal);
  }

  private async drain(): Promise<void> {
    while (this.started) {
      this.dirty = false;
      // 计量与缓存到期即清（每天一次）：账本本体永不修剪，这两类数据不是经历。
      if (this.store.now() - this.store.get<number>('lastPrune', 0) > 86400000) { this.store.prune(); this.store.set('lastPrune', this.store.now()); }
      const peers = this.store.peers().filter(p => p.enabled);
      const preview = this.store.nextEnvelope('c2c:preview');
      if (preview && peers.some(p => p.id === preview.peer) && this.config().life.enabled) { this.store.startSend(preview.id, {}); this.store.settleSend(preview.id, 'accepted', 'local-preview'); continue; }
      if (this.config().qq.enabled && this.config().life.enabled) {
        const envelope = peers.filter(p => p.id !== 'c2c:preview').map(p => this.store.nextEnvelope(p.id)).filter((e): e is Envelope => !!e).sort((a, b) => a.createdAt - b.createdAt || a.ordinal - b.ordinal)[0];
        if (envelope) { await this.deliver(envelope); continue; }
      }
      if (!this.ready()) return;
      const enabled = new Set(peers.map(p => p.id));
      const job = this.store.jobs().find(j => enabled.has(j.peer) && j.dueAt <= this.store.now());
      if (!job) return;
      const turn = this.store.claim(job.peer);
      if (!turn) continue;
      const controller = new AbortController();
      this.active = { peer: turn.peer, controller };
      const signal = AbortSignal.any([controller.signal, this.lifetime.signal, AbortSignal.timeout(this.config().life.turnTimeoutMs)]);
      try {
        await this.prepareImages(turn, signal);
        const thought = await this.mind.think(turn, signal);
        signal.throwIfAborted();
        if (this.store.stale(turn)) { this.store.finish(turn, 'superseded'); continue; }
        this.apply(turn, thought);
      } catch (error) {
        const stale = this.store.stale(turn);
        this.store.finish(turn, stale ? 'superseded' : 'failed', errorText(error), !stale && !this.lifetime.signal.aborted && !(error instanceof ModelError && error.terminal));
        if (!stale && !this.lifetime.signal.aborted) { this.store.append(turn.peer, 'failure', { text: '这次思考未完成', error: errorText(error) }, turn.id); this.onError(error); }
      } finally {
        this.active = undefined;
        const peer = this.store.peer(turn.peer);
        if (peer?.enabled && peer.autonomous && this.config().life.enabled) this.ensureLife(peer);
      }
    }
  }

  private async prepareImages(turn: Turn, signal: AbortSignal): Promise<void> {
    const c = this.config(), endpoint = configured(c.primary) ? c.primary : c.fallback;
    if (!endpoint.vision) return;
    const workspace = await this.files.scope(turn.peer), seen = this.store.get(`seen:${turn.peer}`, 0);
    const events = this.store.events(turn.peer, seen, turn.snapshot, 10000);
    for (const event of events) {
      if (event.kind !== 'received' || !Array.isArray(event.data.attachments)) continue;
      for (const value of event.data.attachments as { id?: string }[]) {
        const a = value.id ? this.store.attachment(turn.peer, value.id) : undefined;
        if (!a || a.path || !a.url || !a.mime.startsWith('image/')) continue;
        try {
          const downloaded = await publicDownload(a.url, signal, 12 * 1024 * 1024);
          const mime = mimeOf(downloaded.bytes);
          if (!mime.startsWith('image/')) throw new Error('平台附件未返回真实图片');
          a.path = `media/${a.id}.${mime === 'image/jpeg' ? 'jpg' : mime.slice(6)}`;
          await workspace.write(a.path, downloaded.bytes); a.mime = mime; delete a.url; this.store.saveAttachment(turn.peer, a);
        } catch (error) { signal.throwIfAborted(); this.store.append(turn.peer, 'failure', { attachment: a.id, text: '图片预取失败，需要时可用attachment重试', error: errorText(error) }, turn.id); }
      }
    }
  }

  apply(turn: Turn, thought: Thought): void {
    this.store.transaction(() => {
      if (this.store.stale(turn)) throw new Error('过时决定不能落地');
      const now = this.store.now();
      for (const memory of thought.memories) this.store.saveMemory(turn.peer, memory);
      if (thought.feeling) this.store.setFeeling(turn.peer, { ...thought.feeling, at: now });
      if (thought.feeling) this.store.append(turn.peer, 'feeling', { ...thought.feeling, at: now }, turn.id);
      if (thought.reflection) this.store.append(turn.peer, 'reflection', { text: thought.reflection }, turn.id);
      const patch: { activity?: string; pursuit?: string; interests?: string[] } = {};
      if (thought.activity !== undefined) patch.activity = thought.activity;
      if (thought.pursuit !== undefined) patch.pursuit = thought.pursuit;
      if (thought.interests !== undefined) patch.interests = thought.interests;
      if (Object.keys(patch).length) this.store.saveSelfPatch(turn.peer, patch);
      if (thought.diary) {
        const event = this.store.append(turn.peer, 'diary', { ...thought.diary, at: now }, turn.id, `diary:${turn.episode}`);
        if (event) for (const source of thought.diary.sources) turn.allowed.add(source);
      }
      if (thought.impressions) this.store.saveImpressions(turn.peer, { beliefs: thought.impressions.beliefs, updatedAt: now });
      for (const op of thought.thoughts ?? []) this.store.changeThought(turn.peer, op);
      // 目录外的表情不是她的表情：静默剔除，别让幻觉变成死信。
      const slugs = new Set(this.store.get<{ slug: string }[]>('stickers', []).map(s => s.slug));
      const kept = thought.parts.map((part, i) => ({ part, i })).filter(x => x.part.type !== 'sticker' || slugs.has(x.part.slug ?? ''));
      if (thought.parts.length && !kept.length) throw new TypeError('表情不在目录中，气泡全部失效');
      const keptIndex = new Map<number, number>();
      kept.forEach((x, k) => keptIndex.set(x.i, k));
      const effects: Record<string, unknown>[] = kept.map(() => ({}));
      for (const commitment of thought.commitments) {
        const { afterPart, ...input } = commitment;
        if (afterPart === undefined) this.store.changeCommitment(turn.peer, input);
        else {
          const mapped = keptIndex.get(afterPart);
          if (mapped === undefined) throw new TypeError('承诺气泡不存在（被剔除或下标越界）');
          ((effects[mapped]!.commitments ??= []) as CommitmentInput[]).push(input);
        }
      }
      kept.forEach((x, k) => {
        effects[k]!.notified = (x.part.notified ?? []).map(id => { const c = this.store.commitment(turn.peer, id); if (!c) throw new Error('提醒约定不存在'); return { id, version: c.version, due: c.dueAt }; });
      });
      // 气泡节奏：第 2 条起按长度停顿，像在打字。
      const dues: number[] = [];
      let due = now;
      kept.forEach((x, k) => { if (k > 0) due += pacingMs(x.part); dues.push(due); });
      this.store.draft(turn, kept.map(x => x.part), effects, dues);
      for (const intent of thought.intents) {
        const at = instant(intent.at);
        if (at <= this.store.now()) throw new TypeError('未来意图已过期');
        const key = createHash('sha256').update(JSON.stringify({ peer: turn.peer, ...intent })).digest('hex');
        this.store.schedule(`intent:${key}`, turn.peer, 'reflection', intent.reason, at, intent.commitment ? { commitment: intent.commitment } : {});
      }
      this.store.finish(turn, 'done');
    });
  }

  private async deliver(envelope: Envelope): Promise<void> {
    const peer = this.store.peer(envelope.peer);
    if (!peer?.enabled) return;
    let request: Record<string, unknown>, sending = false;
    const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(300000)]);
    try {
      request = this.transport.passiveRequest(envelope, peer);
      const active = !request.msg_id;
      if (active && peer.activeAllowed === false) { this.store.settleSend(envelope.id, 'failed', undefined, '对方已关闭主动接收'); return; }
      const allowed = this.transport.allowedAt(peer, active);
      if (allowed > this.store.now()) { this.store.deferSend(envelope.id, allowed, 'QQ 平台额度等待，不重新思考'); return; }
      if (envelope.part.type !== 'text' && !request.media) {
        const workspace = await this.files.scope(peer.id);
        let path = envelope.part.path;
        if (envelope.part.type === 'sticker') {
          const sticker = this.store.get<{ slug: string; path: string; description: string }[]>('stickers', []).find(s => s.slug === envelope.part.slug);
          if (!sticker) throw new Error('表情不存在');
          const bytes = await this.files.read(sticker.path);
          path = `stickers/${sticker.slug}`;
          await workspace.write(path, bytes);
        }
        if (!path) throw new Error('媒体没有真实路径');
        const bytes = await workspace.read(path, 200 * 1024 * 1024), mime = mimeOf(bytes, path);
        let type = envelope.part.type === 'voice' ? 3 : envelope.part.type === 'file' ? 4 : 1;
        if (type === 1 && !mime.startsWith('image/') || type === 3 && !mime.startsWith('audio/')) throw new Error('媒体内容不符合类型');
        if (bytes.length > (type === 1 || type === 3 ? 20 : type === 2 ? 30 : 200) * 1024 * 1024) type = 4;
        request.media = { file_info: await this.transport.upload(peer.target, bytes, basename(path), type, signal) };
      }
      // 预上传期间可能有新入站取消此草稿。发送与序号分配同事务提交。
      const ready = this.store.startSend(envelope.id, () => {
        const current = this.store.peer(peer.id);
        if (!current?.enabled || !this.config().qq.enabled || !this.config().life.enabled) throw new Error('发送权限已撤销，旧草稿不再发送');
        const reserved = this.transport.passiveRequest({ ...envelope, request: envelope.request }, current, true);
        request = { ...reserved, ...(request.media ? { media: request.media } : {}) };
        if (!request.msg_id && current.activeAllowed === false) throw new Error('主动接收已关闭');
        if (!request.msg_id) this.transport.recordActive(current);
        return request;
      });
      if (!ready) return;
      sending = true;
      const id = await this.transport.send(peer.target, request, signal);
      this.store.settleSend(envelope.id, 'accepted', id);
    } catch (error) {
      const text = errorText(error);
      if (sending && error instanceof QQError && error.expired) {
        const saved = this.store.deliveries(peer.id).find(d => d.id === envelope.id)?.request ?? {};
        const { msg_id: _id, msg_seq: _seq, ...active } = saved;
        if (peer.activeAllowed !== false) this.store.deferSend(envelope.id, Math.max(this.store.now() + 1000, this.transport.allowedAt(peer, true)), text, active);
        else this.store.settleSend(envelope.id, 'failed', undefined, text);
      } else if (error instanceof QQError && error.limited && envelope.attempts < 8) this.store.deferSend(envelope.id, this.store.now() + Math.max(error.retryAfter, 60000), text);
      else if (sending && (!(error instanceof QQError) || error.uncertain)) this.store.settleSend(envelope.id, 'unknown', undefined, text);
      else this.store.settleSend(envelope.id, 'failed', undefined, text);
      if (error instanceof QQError && error.forbidden) this.store.savePeer({ ...this.store.peer(peer.id)!, activeAllowed: false });
      this.store.append(peer.id, 'failure', { delivery: envelope.id, text, uncertain: sending && (!(error instanceof QQError) || error.uncertain) });
    }
  }

  private arm(): void {
    if (!this.started || this.work) return;
    const peers = this.store.peers().filter(p => p.enabled), enabled = new Set(peers.map(p => p.id));
    const times = this.ready() ? this.store.jobs().filter(j => enabled.has(j.peer)).map(j => j.dueAt) : [];
    if (this.config().qq.enabled && this.config().life.enabled) for (const peer of peers) { const at = this.store.nextDeliveryAt(peer.id); if (at !== undefined) times.push(at); }
    if (!times.length) return;
    this.timer = setTimeout(() => { this.timer = undefined; this.wake(); }, Math.max(1, Math.min(2147483647, Math.min(...times) - this.store.now())));
    this.timer.unref();
  }

  async stop(): Promise<void> {
    this.started = false; this.dirty = false;
    if (this.timer) clearTimeout(this.timer);
    this.lifetime.abort(new Error('停止运行')); this.active?.controller.abort(new Error('停止运行'));
    await this.work;
  }
}
