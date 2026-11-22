import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Config } from './config.ts';
import { publicConfig, mergeConfig, configured } from './config.ts';
import { Store } from './store.ts';
import { Files, mimeOf } from './files.ts';
import { Runtime } from './runtime.ts';
import { QQ } from './qq.ts';
import { Models } from './model.ts';
import { Backups } from './backup.ts';
import { object, string, errorText } from './types.ts';

interface Session { csrf: string; until: number }
export interface ServerOptions {
  host: string; port: number; password: string; publicDir: string;
  store: Store; files: Files; runtime: Runtime; qq: QQ; models: Models; backups: Backups;
  config: () => Config; update: (config: Config) => void;
}
class RequestError extends Error { status: number; constructor(status: number, message: string) { super(message); this.status = status; } }

export class AdminServer {
  private options: ServerOptions;
  private server: Server;
  private sessions = new Map<string, Session>();
  private attempts = new Map<string, { count: number; until: number }>();
  private salt = randomBytes(16);
  private password: Buffer;
  constructor(options: ServerOptions) {
    this.options = options; this.password = scryptSync(options.password, this.salt, 32);
    this.server = createServer((req, res) => { void this.handle(req, res); });
    this.server.requestTimeout = 30000; this.server.headersTimeout = 10000; this.server.maxHeadersCount = 64;
  }
  async listen(): Promise<number> {
    await new Promise<void>((resolve, reject) => { this.server.once('error', reject); this.server.listen(this.options.port, this.options.host, () => { this.server.removeListener('error', reject); resolve(); }); });
    return (this.server.address() as { port: number }).port;
  }
  async close(): Promise<void> { this.server.closeAllConnections(); await new Promise<void>((resolve, reject) => this.server.close(error => error ? reject(error) : resolve())); }

  private headers(res: ServerResponse): void {
    res.setHeader('x-content-type-options', 'nosniff'); res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('x-frame-options', 'DENY'); res.setHeader('cache-control', 'no-store');
    res.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  }
  private json(res: ServerResponse, value: unknown, status = 200): void { res.statusCode = status; res.setHeader('content-type', 'application/json; charset=utf-8'); res.end(JSON.stringify(value)); }
  private safeError(error: unknown): string {
    let text = errorText(error);
    const c = this.options.config();
    for (const secret of [c.primary.key, c.fallback.key, c.embedding.key, c.qq.secret, c.web.key, c.image.key, c.backup.password]) if (secret) text = text.replaceAll(secret, '[密钥已隐藏]');
    return text.slice(0, 2000);
  }
  private verifyHost(req: IncomingMessage): void {
    const host = req.headers.host ?? '', address = this.server.address();
    if (!address || typeof address === 'string') throw new RequestError(503, '服务尚未监听');
    const configured = this.options.host, port = address.port;
    if (configured === '0.0.0.0' || configured === '::') {
      // 通配监听（如容器端口映射）：宿主对外端口容器不可知，放行任意 IP/localhost 直连；
      // 仍拒绝陌生域名，DNS rebinding（依赖域名解析）无法通过。
      const bare = host.startsWith('[') ? host.slice(1, host.indexOf(']')) : host.slice(0, Math.max(host.indexOf(':'), 0) || undefined);
      if (bare !== 'localhost' && isIP(bare) === 0) throw new RequestError(403, 'Host 不允许；通配监听仅接受 IP 或 localhost 直连，域名访问请将 ATRI_HOST 设为该域名');
    } else {
      const allowed = new Set([`${configured.includes(':') ? `[${configured}]` : configured}:${port}`]);
      if (['127.0.0.1', '::1', 'localhost'].includes(configured)) { allowed.add(`localhost:${port}`); allowed.add(`127.0.0.1:${port}`); allowed.add(`[::1]:${port}`); }
      if (!allowed.has(host.toLowerCase())) throw new RequestError(403, 'Host 不允许；远程部署请明确设置 ATRI_HOST 或由反向代理保留本机 Host');
    }
    const origin = req.headers.origin;
    if (origin && ![`http://${host}`, `https://${host}`].includes(origin)) throw new RequestError(403, '跨站请求被拒绝');
    if (req.headers['sec-fetch-site'] === 'cross-site') throw new RequestError(403, '跨站请求被拒绝');
  }
  private session(req: IncomingMessage): Session | undefined {
    const token = (req.headers.cookie ?? '').split(';').map(s => s.trim()).find(s => s.startsWith('atri_session='))?.slice(13);
    const session = token ? this.sessions.get(token) : undefined;
    if (session && session.until > Date.now()) return session;
    if (token) this.sessions.delete(token);
    return undefined;
  }
  private async body(req: IncomingMessage, max = 2 * 1024 * 1024): Promise<Record<string, unknown>> {
    if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) throw new RequestError(415, '需要 application/json');
    if (Number(req.headers['content-length'] ?? 0) > max) throw new RequestError(413, '请求过大');
    const chunks: Buffer[] = []; let size = 0;
    for await (const value of req) { const chunk = Buffer.from(value as Uint8Array); size += chunk.length; if (size > max) throw new RequestError(413, '请求过大'); chunks.push(chunk); }
    try { return object(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { throw new RequestError(400, 'JSON 无效'); }
  }
  private async login(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const ip = req.socket.remoteAddress ?? 'unknown', now = Date.now();
    const attempt = this.attempts.get(ip);
    if (attempt && attempt.until > now && attempt.count >= 10) throw new RequestError(429, '登录尝试过多，请15分钟后再试');
    const body = await this.body(req, 4096);
    if (typeof body.password !== 'string' || body.password.length > 1024 || !timingSafeEqual(scryptSync(body.password, this.salt, 32), this.password)) {
      if (this.attempts.size > 256) this.attempts.clear();
      this.attempts.set(ip, { count: attempt && attempt.until > now ? attempt.count + 1 : 1, until: now + 900000 });
      throw new RequestError(401, '管理密码不正确');
    }
    this.attempts.delete(ip);
    for (const [key, value] of this.sessions) if (value.until <= now) this.sessions.delete(key);
    if (this.sessions.size >= 128) this.sessions.delete(this.sessions.keys().next().value!);
    const token = randomBytes(32).toString('hex'), csrf = randomBytes(24).toString('hex');
    this.sessions.set(token, { csrf, until: now + 12 * 3600000 });
    res.setHeader('set-cookie', `atri_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`);
    this.json(res, { ok: true, csrf });
  }
  private peer(url: URL): string {
    const peer = url.searchParams.get('peer') ?? '';
    if (!this.options.store.peer(peer)) throw new RequestError(404, '会话不存在');
    return peer;
  }
  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.headers(res);
    try {
      this.verifyHost(req);
      const url = new URL(req.url ?? '/', 'http://local.invalid'), path = url.pathname, method = req.method ?? 'GET';
      const o = this.options, store = o.store;
      if (method === 'GET' && path === '/health') { this.json(res, { ok: true }); return; }
      if (method === 'POST' && path === '/api/login') { await this.login(req, res); return; }
      if (method === 'GET' && ['/', '/app.js', '/app.css', '/atri.webp'].includes(path)) {
        const file = path === '/' ? 'index.html' : path.slice(1);
        res.setHeader('content-type', file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.js') ? 'text/javascript; charset=utf-8' : file.endsWith('.css') ? 'text/css; charset=utf-8' : 'image/webp');
        res.end(await readFile(join(o.publicDir, file))); return;
      }
      const session = this.session(req);
      if (!session) throw new RequestError(401, '请先登录');
      if (method !== 'GET' && req.headers['x-csrf-token'] !== session.csrf) throw new RequestError(403, '请求校验失败，请重新登录');
      if (method === 'GET') {
        if (path === '/api/session') this.json(res, { csrf: session.csrf });
        else if (path === '/api/status') this.json(res, { qq: o.qq.status(), runtime: o.runtime.status(), backup: o.backups.status(), peers: store.peers().length });
        else if (path === '/api/config') this.json(res, publicConfig(o.config()));
        else if (path === '/api/peers') this.json(res, store.peers());
        else if (path === '/api/inner') {
          const peerId = this.peer(url);
          this.json(res, {
            self: store.self(peerId),
            feeling: store.feeling(peerId),
            moodTrail: store.get<unknown[]>(`moodlog:${peerId}`, []).slice(-8),
            impressions: store.impressions(peerId),
          });
        }
        else if (path === '/api/events') this.json(res, store.recent(this.peer(url), 200, Number(url.searchParams.get('before') ?? Number.MAX_SAFE_INTEGER)));
        else if (path === '/api/memories') this.json(res, store.memories(this.peer(url)));
        else if (path === '/api/thoughts') this.json(res, store.thoughts(this.peer(url)));
        else if (path === '/api/commitments') this.json(res, store.commitments(this.peer(url)));
        else if (path === '/api/deliveries') this.json(res, store.deliveries(url.searchParams.has('peer') ? this.peer(url) : undefined, 200));
        else if (path === '/api/jobs') this.json(res, store.jobs());
        else if (path === '/api/usage') this.json(res, store.usage(Math.max(0, store.now() - Math.min(365, Number(url.searchParams.get('days') ?? 1)) * 86400000)));
        else if (path === '/api/wall') this.json(res, store.wall(url.searchParams.has('peer') ? this.peer(url) : undefined));
        else if (path === '/api/stickers') this.json(res, store.get('stickers', []));
        else if (path === '/api/sticker') {
          const slug = string(url.searchParams.get('slug'), '表情标识', 64);
          if (!/^[a-zA-Z0-9_-]+$/.test(slug)) throw new RequestError(400, '表情标识无效');
          const sticker = store.get<{ slug: string; path: string; description: string }[]>('stickers', []).find(s => s.slug === slug);
          if (!sticker) throw new RequestError(404, '表情不存在');
          const bytes = await o.files.read(sticker.path, 20 * 1024 * 1024);
          res.setHeader('content-type', mimeOf(bytes, sticker.path)); res.setHeader('cache-control', 'private, max-age=300'); res.end(bytes);
        }
        else if (path === '/api/files') this.json(res, await (await o.files.scope(this.peer(url))).list(url.searchParams.get('path') ?? '.'));
        else if (path === '/api/file') {
          const bytes = await (await o.files.scope(this.peer(url))).read(string(url.searchParams.get('path'), '文件路径'), 20 * 1024 * 1024);
          res.setHeader('content-type', mimeOf(bytes, url.searchParams.get('path') ?? '')); res.setHeader('content-disposition', 'attachment'); res.end(bytes);
        } else throw new RequestError(404, '接口不存在');
        return;
      }
      if (method !== 'POST') throw new RequestError(405, '方法不允许');
      const body = await this.body(req, path === '/api/stickers' ? 30 * 1024 * 1024 : 2 * 1024 * 1024);
      if (path === '/api/logout') { for (const [key, value] of this.sessions) if (value === session) this.sessions.delete(key); res.setHeader('set-cookie', 'atri_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'); this.json(res, { ok: true }); }
      else if (path === '/api/config') {
        const before = o.config(), next = mergeConfig(before, body.patch);
        if (next.qq.enabled && (!next.qq.appId || !next.qq.secret)) throw new RequestError(400, '启用QQ前请填写AppID和AppSecret');
        o.update(next); this.json(res, publicConfig(next));
      } else if (path === '/api/peer') {
        const id = string(body.id, '会话ID'), old = store.peer(id); if (!old) throw new RequestError(404, '会话不存在');
        const patch = object(body.patch); if (Object.keys(patch).some(k => !['name', 'enabled', 'autonomous', 'activeAllowed'].includes(k))) throw new RequestError(400, '不允许修改此会话字段');
        if (patch.name !== undefined) patch.name = string(patch.name, '会话名称', 100);
        for (const key of ['enabled', 'autonomous']) if (patch[key] !== undefined && typeof patch[key] !== 'boolean') throw new RequestError(400, '开关必须是布尔值');
        if (patch.activeAllowed !== undefined && patch.activeAllowed !== null && typeof patch.activeAllowed !== 'boolean') throw new RequestError(400, '主动权限无效');
        const peer = { ...old, ...patch }; store.savePeer(peer); o.runtime.reconfigure(); this.json(res, peer);
      } else if (path === '/api/delivery') {
        if (typeof body.accepted !== 'boolean') throw new RequestError(400, '请确认实际接收结果');
        this.json(res, { ok: store.resolveSend(string(body.id, '投递ID'), body.accepted) }); o.runtime.wake();
      } else if (path === '/api/commitment') {
        const peer = string(body.peer, '会话ID'), id = string(body.id, '约定ID');
        if (!store.peer(peer) || !store.commitment(peer, id)) throw new RequestError(404, '约定不存在');
        if (!['complete', 'cancel'].includes(String(body.op))) throw new RequestError(400, '仅允许人工确认履约或取消');
        const event = store.append(peer, 'received', { author: '管理员确认', text: body.op === 'complete' ? `人工确认约定已完成：${id}` : `人工取消约定：${id}` })!;
        const commitment = store.changeCommitment(peer, { op: body.op as 'complete' | 'cancel', id, sources: [event.id] }); this.json(res, commitment); o.runtime.wake();
      } else if (path === '/api/qq/probe') {
        this.json(res, await o.qq.probe(AbortSignal.timeout(20000)));
      } else if (path === '/api/model/probe') {
        const fallback = body.channel === 'fallback';
        const channel = fallback ? o.config().fallback : o.config().primary;
        if (!configured(channel)) throw new RequestError(400, fallback ? '备用渠道未配置' : '请先配置主模型渠道');
        // primary 探测不带 only：真实语义是"她能不能说话"（failover 有效）；
        // fallback 带 only：独立体检，不会被 failover 掩盖。
        const options = { signal: AbortSignal.timeout(30000), purpose: 'probe', cacheKey: fallback ? 'probe-fallback' : 'probe', final: true, ...(fallback ? { only: channel } : {}) };
        if (body.mode === 'system') {
          // system 提示哨兵：渠道丢弃 system 时人设无法工作，必须显式测出来。
          const reply = await o.models.complete([{ role: 'system', content: '无论对方说什么，只回复四个字：哨兵有效' }, { role: 'user', content: '你是什么角色？' }], [], options);
          this.json(res, { ok: true, follows: reply.message.content.includes('哨兵有效'), reply: reply.message.content });
        } else {
          const reply = await o.models.complete([{ role: 'user', content: '仅回复OK' }], [], options); this.json(res, { ok: true, reply: reply.message.content, usage: reply.usage });
        }
      } else if (path === '/api/model/list') {
        // 拉取模型目录不需要已填模型名——拉目录就是为了选模型；地址+密钥即可。
        const fallback = body.channel === 'fallback';
        const stored = fallback ? o.config().fallback : o.config().primary;
        const url = typeof body.url === 'string' ? body.url.trim() : '', key = typeof body.key === 'string' ? body.key.trim() : '';
        const endpoint = { ...stored, format: body.format === 'anthropic' ? 'anthropic' as const : 'openai' as const, ...(url ? { url } : {}), ...(key ? { key } : {}) };
        if (!endpoint.url || !endpoint.key) throw new RequestError(400, '请先填写地址和密钥');
        this.json(res, { models: await o.models.list(endpoint, AbortSignal.timeout(30000)) });
      } else if (path === '/api/preview') {
        // 预演通道：UI 无入口，e2e 测试驱动器（HTTP→runtime.receive 全真链路，不出 QQ）。
        if (!(configured(o.config().primary) || configured(o.config().fallback))) throw new RequestError(400, '本地预演需先配置模型渠道');
        const target = { kind: 'c2c' as const, id: 'preview' }, peer = store.ensurePeer(target); store.savePeer({ ...peer, enabled: true, name: '本地预演（不发送QQ）' });
        o.runtime.receive({ key: randomBytes(16).toString('hex'), target, messageId: `preview-${Date.now()}`, author: '本地管理员', text: string(body.text, '消息', 20000), at: store.now(), attachments: [] }); this.json(res, { ok: true, peer: peer.id });
      } else if (path === '/api/stickers') {
        const slug = string(body.slug, '表情标识', 64); if (!/^[a-zA-Z0-9_-]+$/.test(slug) || typeof body.bytes !== 'string') throw new RequestError(400, '表情标识或内容无效');
        const bytes = Buffer.from(body.bytes, 'base64'), mime = mimeOf(bytes); if (!mime.startsWith('image/') || bytes.length > 20 * 1024 * 1024) throw new RequestError(400, '需要20MB以内真实图片');
        const old = store.get<{ slug: string; path: string; description: string }[]>('stickers', []); if (old.some(s => s.slug === slug)) throw new RequestError(409, '标识已存在，请使用新标识');
        const path2 = `stickers/${slug}.${mime === 'image/jpeg' ? 'jpg' : mime.slice(6)}`; await o.files.write(path2, bytes); store.set('stickers', [...old, { slug, path: path2, description: string(body.description, '表情描述', 300) }]); this.json(res, { ok: true });
      } else if (path === '/api/backup') {
        this.json(res, { ok: true, name: await o.backups.run() });
      } else throw new RequestError(404, '接口不存在');
    } catch (error) {
      if (res.headersSent) { res.destroy(); return; }
      this.json(res, { error: this.safeError(error) }, error instanceof RequestError ? error.status : error instanceof TypeError ? 400 : 500);
    }
  }
}
