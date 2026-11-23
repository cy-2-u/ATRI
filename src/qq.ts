import { createHash } from 'node:crypto';
import type { Config } from './config.ts';
import type { Incoming, Peer, Target, Attachment, Envelope } from './types.ts';
import { object, errorText } from './types.ts';
import { Store } from './store.ts';
import { HttpError, jsonRequest, sleep, publicUpload } from './net.ts';
import { dayStart } from './state.ts';

export class QQError extends Error {
  code: number;
  status: number;
  uncertain: boolean;
  retryAfter: number;
  constructor(message: string, code = 0, status = 0, uncertain = false, retryAfter = 0) { super(message); this.code = code; this.status = status; this.uncertain = uncertain; this.retryAfter = retryAfter; }
  get expired(): boolean { return [304103, 40034005, 40034128].includes(this.code); }
  get forbidden(): boolean { return [40034105, 40054004, 40054013, 40034101, 40054002, 40054003].includes(this.code); }
  get limited(): boolean { return this.status === 429 || this.code === 40034100; }
}

export interface QQEvent { op: number; s?: number; t?: string; id?: string; d?: unknown }

export function normalizeEvent(event: QQEvent, now = Date.now()): Incoming | undefined {
  // 她只属于一个人：只收私聊消息，群聊事件一律不进她的世界。
  if (event.t !== 'C2C_MESSAGE_CREATE') return undefined;
  const d = object(event.d), author = object(d.author);
  if (author.bot === true || !d.id) return undefined;
  const authorId = String(author.user_openid ?? author.id ?? '');
  if (!authorId) return undefined;
  const target: Target = { kind: 'c2c', id: authorId };
  const scene = d.message_scene ? object(d.message_scene) : {};
  const ext = Array.isArray(scene.ext) ? scene.ext.filter((v): v is string => typeof v === 'string') : [];
  const field = (name: string): string | undefined => ext.find(v => v.startsWith(`${name}=`))?.slice(name.length + 1);
  const messageId = String(d.id), messageIndex = field('msg_idx');
  const attachments: Attachment[] = Array.isArray(d.attachments) ? d.attachments.map((value, i) => {
    const a = object(value);
    return { id: createHash('sha256').update(`${target.kind}:${authorId}:${messageId}:${i}`).digest('hex').slice(0, 32), name: String(a.filename ?? `attachment-${i}`), mime: String(a.content_type ?? 'application/octet-stream'), url: typeof a.url === 'string' ? (/^https?:\/\//.test(a.url) ? a.url : `https://${a.url}`) : undefined, size: typeof a.size === 'number' ? a.size : undefined, transcript: typeof a.asr_refer_text === 'string' ? a.asr_refer_text : undefined };
  }) : [];
  const referenceId = field('ref_msg_idx');
  const findReference = (elements: unknown[], depth = 0): Record<string, unknown> | undefined => {
    if (depth > 8) return undefined;
    for (const value of elements) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const e = object(value);
      if (referenceId && String(e.msg_idx ?? '') === referenceId) return e;
      if (Array.isArray(e.msg_elements)) { const found = findReference(e.msg_elements, depth + 1); if (found) return found; }
    }
    return undefined;
  };
  const element = Array.isArray(d.msg_elements) ? findReference(d.msg_elements) : undefined;
  const stamp = typeof d.timestamp === 'string' ? Date.parse(d.timestamp) : NaN;
  return { key: messageIndex ? `${messageId}:${messageIndex}` : messageId, target, messageId, author: authorId, text: String(d.content ?? ''), at: Number.isFinite(stamp) ? stamp : now,
    ...(referenceId ? { reference: { id: referenceId, ...(element ? { text: String(element.content ?? '') } : {}) } } : {}), attachments };
}

const waitToken = (promise: Promise<string>, signal: AbortSignal): Promise<string> => new Promise((resolve, reject) => {
  signal.throwIfAborted();
  const abort = (): void => reject(signal.reason);
  signal.addEventListener('abort', abort, { once: true });
  void promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
});

export class QQ {
  private config: () => Config;
  private store: Store;
  private onEvent: (event: QQEvent) => Promise<void>;
  private onError: (error: unknown) => void;
  private socketFactory: (url: string) => WebSocket;
  private uploader: typeof publicUpload;
  private token?: { value: string; until: number; identity: string };
  private tokenFlight?: { identity: string; promise: Promise<string> };
  private socket?: WebSocket;
  private connection?: AbortController;
  private lifetime?: AbortController;
  private loop?: Promise<void>;
  private session?: string;
  private seq?: number;
  private currentIdentity = '';
  private gateway?: { url: string; at: number };
  private online = false;
  private error = '';
  private stopped = true;
  private generation = 0;

  constructor(config: () => Config, store: Store, onEvent: (event: QQEvent) => Promise<void>, onError: (error: unknown) => void, socketFactory = (url: string): WebSocket => new WebSocket(url), uploader = publicUpload) {
    this.config = config; this.store = store; this.onEvent = onEvent; this.onError = onError; this.socketFactory = socketFactory; this.uploader = uploader;
  }

  status(): Record<string, unknown> { return { online: this.online, enabled: this.config().qq.enabled, error: this.error, session: !!this.session }; }

  private identity(): string { const c = this.config().qq; return createHash('sha256').update(`${c.appId}:${c.secret}:${c.sandbox}`).digest('hex'); }
  private base(): string { return this.config().qq.sandbox ? 'https://sandbox.api.sgroup.qq.com' : 'https://api.bot.qq.com'; }

  async accessToken(signal: AbortSignal, force = false): Promise<string> {
    signal.throwIfAborted();
    const c = this.config().qq, identity = this.identity();
    if (!force && this.token?.identity === identity && this.token.until > this.store.now() + 45000) return this.token.value;
    if (this.tokenFlight?.identity === identity) return waitToken(this.tokenFlight.promise, signal);
    if (!c.appId || !c.secret) throw new QQError('QQ AppID 或 AppSecret 未配置');
    const flight = { identity, promise: Promise.resolve('') };
    flight.promise = (async () => {
      const { data } = await jsonRequest('https://api.bot.qq.com/app/getAppAccessToken', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ appId: c.appId, clientSecret: c.secret }), signal: AbortSignal.timeout(10000) });
      if (data.code && data.code !== 0) throw new QQError(`QQ 凭证错误 ${data.code}`, Number(data.code));
      const expires = Number(data.expires_in);
      if (typeof data.access_token !== 'string' || !data.access_token || !Number.isFinite(expires) || expires <= 0) throw new QQError('QQ 凭证回包无效');
      if (this.identity() !== identity) throw new QQError('QQ 配置已改变，旧凭证不再用于新请求');
      this.token = { value: data.access_token, until: this.store.now() + expires * 1000, identity };
      return data.access_token;
    })().finally(() => { if (this.tokenFlight === flight) this.tokenFlight = undefined; });
    this.tokenFlight = flight;
    return waitToken(flight.promise, signal);
  }

  async api(path: string, method: string, body: unknown, signal: AbortSignal, sending = false): Promise<Record<string, unknown>> {
    const identity = this.identity();
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.accessToken(signal, attempt > 0);
      if (this.identity() !== identity) throw new QQError('QQ 配置改变，请求已取消');
      try {
        const { data } = await jsonRequest(`${this.base()}${path}`, { method, headers: { authorization: `QQBot ${token}`, 'X-Union-Appid': this.config().qq.appId, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.any([signal, AbortSignal.timeout(sending ? 20000 : 45000)]) });
        if (typeof data.code === 'number' && data.code !== 0) throw new QQError(`QQ API 错误 ${data.code}`, data.code, 200, sending && data.code === 40054005);
        return data;
      } catch (error) {
        if (error instanceof HttpError && error.status === 401 && attempt === 0 && !signal.aborted) { this.token = undefined; continue; }
        if (error instanceof QQError) throw error;
        if (error instanceof HttpError) throw new QQError(error.message, Number(error.data?.code ?? 0), error.status, sending && (error.status >= 500 || error.status >= 200 && error.status < 300 || error.data?.code === 40054005), error.retryAfter);
        throw new QQError(`QQ 请求失败：${errorText(error)}`, 0, 0, sending);
      }
    }
    throw new QQError('QQ 鉴权失败', 0, 401);
  }

  reconfigure(): void { void this.stop().then(() => this.start()).catch(this.onError); }

  private saveSession(): void { this.store.set('qq-session', { identity: this.currentIdentity, session: this.session ?? null, seq: this.seq ?? null }); }
  private clearSession(): void { this.session = undefined; this.seq = undefined; this.saveSession(); }

  start(): void {
    if (!this.stopped || !this.config().qq.enabled) return;
    const identity = this.identity();
    if (identity !== this.currentIdentity) {
      this.token = undefined; this.gateway = undefined; this.currentIdentity = identity;
      const saved = this.store.get<{ identity: string; session: string | null; seq: number | null } | null>('qq-session', null);
      this.session = saved?.identity === identity ? saved.session ?? undefined : undefined;
      this.seq = saved?.identity === identity ? saved.seq ?? undefined : undefined;
    }
    this.stopped = false; this.lifetime = new AbortController();
    this.loop = this.run(++this.generation, this.lifetime.signal).catch(error => { if (!this.stopped) this.onError(error); });
  }

  private async run(gen: number, signal: AbortSignal): Promise<void> {
    let failures = 0;
    while (!this.stopped && gen === this.generation && this.config().qq.enabled) {
      const controller = new AbortController(); this.connection = controller;
      try {
        if (!this.gateway || this.store.now() - this.gateway.at > 3600000) {
          const gateway = await this.api('/gateway/bot', 'GET', undefined, controller.signal);
          if (typeof gateway.url !== 'string' || !gateway.url.startsWith('wss://')) throw new QQError('网关地址无效');
          this.gateway = { url: gateway.url, at: this.store.now() };
        }
        await this.connect(this.gateway.url, controller.signal);
        failures = 0;
      } catch (error) {
        if (!this.stopped && !controller.signal.aborted) { this.error = errorText(error); this.onError(error); failures++; }
        // 鉴权/配置类关闭码，重连无解（码位与 Discord 网关同构：4002 无效 Token；4010-4014 无效
        // shard/intents/版本，其中 4013 是无效 intents 而非限流；4914-4915 服务器已关闭；
        // 100007/100016/10004 为 API 鉴权错误）——停机等配置变更，而不是退避空转。
        if (error instanceof QQError && [100007, 100016, 10004, 4001, 4002, 4010, 4011, 4012, 4013, 4014, 4914, 4915].includes(error.code)) { this.stopped = true; break; }
      }
      this.online = false;
      if (!this.stopped && gen === this.generation) await sleep(Math.min(30000, 1000 * 2 ** Math.min(failures, 5)) * (0.8 + Math.random() * 0.4), signal);
    }
  }

  private async connect(url: string, signal: AbortSignal): Promise<void> {
    const token = await this.accessToken(signal);
    return new Promise((resolve, reject) => {
      const ws = this.socketFactory(url); this.socket = ws;
      let heartbeat: ReturnType<typeof setInterval> | undefined, acknowledged = true, ended = false;
      let chain = Promise.resolve();
      const settle = (error?: unknown): void => { if (ended) return; ended = true; cleanup(); if (error) reject(error); else resolve(); };
      const helloTimeout = setTimeout(() => { ws.close(); settle(new QQError('QQ 网关握手超时')); }, 15000);
      const cleanup = (): void => { clearTimeout(helloTimeout); if (heartbeat) clearInterval(heartbeat); signal.removeEventListener('abort', abort); this.online = false; };
      const abort = (): void => { ws.close(); void chain.then(() => settle(), settle); };
      const send = (payload: unknown): void => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload)); };
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) { abort(); return; }
      ws.addEventListener('message', e => {
        if (ended) return;
        let event: QQEvent;
        try {
          const text = String(e.data);
          if (text.length > 2 * 1024 * 1024) throw new QQError('QQ 网关消息过大');
          event = JSON.parse(text) as QQEvent;
          if (!Number.isInteger(event.op)) throw new QQError('QQ 网关操作码无效');
        } catch (error) { ws.close(); settle(error); return; }
        // ACK 不能排在业务处理之后，否则慢业务会造成假失联。
        if (event.op === 11) { acknowledged = true; return; }
        chain = chain.then(async () => {
          if (ended) return;
          if (event.op === 10) {
            clearTimeout(helloTimeout);
            const interval = Number(object(event.d).heartbeat_interval);
            if (!Number.isFinite(interval) || interval < 1000) throw new QQError('QQ 心跳间隔无效');
            send(this.session && this.seq !== undefined ? { op: 6, d: { token: `QQBot ${token}`, session_id: this.session, seq: this.seq } } : { op: 2, d: { token: `QQBot ${token}`, intents: 1 << 25, shard: [0, 1], properties: { $os: process.platform, $browser: 'atri', $device: 'atri' } } });
            if (heartbeat) clearInterval(heartbeat);
            heartbeat = setInterval(() => { if (!acknowledged) { ws.close(); return; } acknowledged = false; send({ op: 1, d: this.seq ?? null }); }, interval);
          } else if (event.op === 1) { acknowledged = false; send({ op: 1, d: this.seq ?? null }); }
          else if (event.op === 7) ws.close();
          else if (event.op === 9) { if (event.d !== true) this.clearSession(); ws.close(); }
          else if (event.op === 0) {
            if (event.t === 'READY') { const id = object(event.d).session_id; if (typeof id !== 'string' || !id) throw new QQError('QQ 会话 ID 无效'); this.session = id; this.online = true; this.error = ''; }
            else if (event.t === 'RESUMED') { this.online = true; this.error = ''; }
            else await this.onEvent(event);
            if (Number.isSafeInteger(event.s) && Number(event.s) >= 0) this.seq = event.s;
            this.saveSession();
          }
        }).catch(error => { this.onError(error); ws.close(); settle(error); });
      });
      ws.addEventListener('error', () => { this.error = 'QQ 网关连接失败'; ws.close(); settle(new QQError(this.error)); });
      ws.addEventListener('close', e => {
        cleanup();
        void chain.then(() => {
          if ([4006, 4007].includes(e.code) || e.code >= 4900 && e.code <= 4913) this.clearSession();
          settle(e.code >= 4000 ? new QQError(`QQ 网关关闭 ${e.code}`, e.code) : undefined);
        }, settle);
      });
    });
  }

  async stop(): Promise<void> { this.stopped = true; this.generation++; this.lifetime?.abort(); this.connection?.abort(); this.socket?.close(); await this.loop; this.online = false; }

  passiveRequest(envelope: Envelope, peer: Peer, reserve = false): Record<string, unknown> {
    if (envelope.request) return envelope.request;
    const part = envelope.part;
    const reply = part.reply ? this.store.evidence(peer.id, [part.reply]).find(e => e.kind === 'received') : this.store.recent(peer.id, 60).findLast(e => e.kind === 'received');
    if (part.reply && !reply) throw new QQError('引用入站消息不存在');
    const key = reply ? `reply-seq:${peer.id}:${reply.data.messageId}` : '';
    const stored = key ? this.store.get<{ used: number; at: number } | number>(key, 0) : 0;
    const used = typeof stored === 'number' ? stored : stored.used; // 旧版存裸数字，新版存对象——读到旧数据也能对上
    const usable = reply && this.store.now() - reply.at < this.config().qq.passiveMinutes * 60000 && used < (peer.target.kind === 'c2c' ? 4 : 5);
    const request: Record<string, unknown> = part.type === 'text' ? { msg_type: 0, content: part.text } : { msg_type: 7 };
    if (usable) { request.msg_id = reply.data.messageId; request.msg_seq = used + 1; if (reserve) this.store.set(key, { used: used + 1, at: this.store.now() }); }
    return request;
  }

  allowedAt(peer: Peer, active: boolean): number {
    const now = this.store.now();
    if (!active) return now;
    const c = this.config().qq;
    const windowAt = (key: string, length: number, limit: number): number => {
      const history = this.store.get<number[]>(key, []).filter(t => now - t < length);
      return history.length >= limit ? history[history.length - limit]! + length : now;
    };
    const day = dayStart(now, 'Asia/Shanghai');
    const count = this.store.get<{ day: number; count: number }>(`qq-day:${peer.id}`, { day, count: 0 });
    return Math.max(windowAt(`qq-active:${peer.id}`, 60000, 20), windowAt('qq-active:bot:c2c', 1000, c.certified ? 10 : 5), !c.certified ? windowAt('qq-active:bot:c2c', 60000, 30) : now, count.day === day && count.count >= 1000 ? day + 86400000 : now);
  }

  recordActive(peer: Peer): void {
    const now = this.store.now(), day = dayStart(now, 'Asia/Shanghai');
    for (const key of [`qq-active:${peer.id}`, 'qq-active:bot:c2c']) this.store.set(key, [...this.store.get<number[]>(key, []).filter(t => now - t < 60000), now]);
    const count = this.store.get<{ day: number; count: number }>(`qq-day:${peer.id}`, { day, count: 0 });
    this.store.set(`qq-day:${peer.id}`, { day, count: (count.day === day ? count.count : 0) + 1 });
  }

  async send(target: Target, request: Record<string, unknown>, signal: AbortSignal): Promise<string> {
    const path = `/v2/users/${encodeURIComponent(target.id)}/messages`;
    const data = await this.api(path, 'POST', request, signal, true);
    if (typeof data.id !== 'string' || !data.id) throw new QQError('QQ 未返回消息 ID，接收结果未知', 0, 200, true);
    return data.id;
  }

  async upload(target: Target, bytes: Buffer, filename: string, type: number, signal: AbortSignal): Promise<string> {
    if (!bytes.length || bytes.length > 200 * 1024 * 1024 || ![1, 2, 3, 4].includes(type)) throw new QQError('媒体大小或类型无效');
    const key = `${target.kind}:${target.id}:${type}:${createHash('sha256').update(bytes).digest('hex')}`;
    const cached = this.store.cachedMedia(key);
    if (typeof cached?.file_info === 'string') return cached.file_info;
    const root = `/v2/users/${encodeURIComponent(target.id)}`;
    const digest = (alg: string, data: Buffer): string => createHash(alg).update(data).digest('hex');
    const prepared = await this.api(`${root}/upload_prepare`, 'POST', { file_type: type, file_size: String(bytes.length), file_name: filename, md5: digest('md5', bytes), sha1: digest('sha1', bytes), md5_10m: digest('md5', bytes.subarray(0, 10002432)) }, signal);
    if (typeof prepared.upload_id !== 'string' || !Array.isArray(prepared.parts)) throw new QQError('QQ 预上传结果无效');
    // QQ 的分片计划是权威：每个 part 自带 block_size 与 presigned_url，不必也不该假设均匀切分。
    // 实测：index 从 1 开始（官方文档说 0，以实测为准）；单片场景 block_size 等于整文件大小。
    const parts = prepared.parts.map(object).sort((a, b) => Number(a.index) - Number(b.index));
    const total = parts.reduce((n, p) => n + Number(p.block_size), 0);
    parts.forEach((p, i) => { if (Number(p.index) !== Number(parts[0]!.index) + i || typeof p.presigned_url !== 'string' || !Number.isSafeInteger(Number(p.block_size)) || Number(p.block_size) <= 0) throw new QQError('QQ 分片计划无效'); });
    if (total !== bytes.length) throw new QQError(`QQ 分片计划总长 ${total} 与文件 ${bytes.length} 不符`);
    let offset = 0;
    for (const part of parts) {
      const size = Number(part.block_size), chunk = bytes.subarray(offset, offset + size);
      offset += size;
      for (let attempt = 0; ; attempt++) {
        try { await this.uploader(String(part.presigned_url), chunk, signal); break; }
        catch (error) { signal.throwIfAborted(); if (attempt === 2 || error instanceof HttpError && error.status < 500 && error.status !== 429) throw error; await sleep(1000 * 2 ** attempt, signal); }
      }
      await this.api(`${root}/upload_part_finish`, 'POST', { upload_id: prepared.upload_id, part_index: Number(part.index), block_size: String(chunk.length), md5: digest('md5', chunk) }, signal);
    }
    const data = await this.api(`${root}/files`, 'POST', { file_type: type, file_name: filename, upload_id: prepared.upload_id, srv_send_msg: false }, signal);
    const ttl = Number(data.ttl);
    if (typeof data.file_info !== 'string' || !Number.isFinite(ttl) || ttl < 0) throw new QQError('QQ 上传缺少有效 file_info/ttl');
    this.store.cacheMedia(key, data, ttl);
    return data.file_info;
  }

  async probe(signal: AbortSignal): Promise<Record<string, unknown>> {
    const me = await this.api('/users/@me', 'GET', undefined, signal);
    return { ok: true, bot: { id: me.id, username: me.username } };
  }
}
