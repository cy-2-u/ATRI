import Fastify from 'fastify';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, sep, extname } from 'node:path';
import QRCode from 'qrcode';
import { Settings } from './settings.js';
import { Journal } from './storage/journal.js';
import { ModelRouter } from './model/router.js';
import { Runtime } from './runtime/runtime.js';
import { WechatBridge } from './wechat/bridge.js';
import { Stickers } from './stickers.js';
import { Sandbox } from './sandbox.js';

export interface ServerOptions {
  password: string;
  settings: Settings;
  journal: Journal;
  router: ModelRouter;
  runtime: Runtime;
  bridge: WechatBridge;
  stickers: Stickers;
  sandbox?: Sandbox;
  webConfigured(): boolean;
  staticRoot: string;
  /** 表情等只读资产的根（仅放行 assets/stickers/ 前缀）。 */
  assetsRoot: string;
  secureCookie?: boolean;
}

const digest = (value: string) => createHash('sha256').update(value).digest();

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
};

export function createServer(options: ServerOptions) {
  if (options.password.length < 12) throw new Error('管理密码至少十二个字符');
  const app = Fastify({ logger: false, bodyLimit: 256 * 1024, trustProxy: false });
  const sessions = new Map<string, number>();
  const attempts = new Map<string, { count: number; resetAt: number }>();
  const passwordHash = digest(options.password);

  app.addHook('onRequest', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    reply.header('x-content-type-options', 'nosniff');
    reply.header('content-security-policy', "default-src 'none'; frame-ancestors 'none'");
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      const origin = request.headers.origin;
      if (origin) {
        let host: string;
        try {
          host = new URL(origin).host;
        } catch {
          return reply.code(403).send({ error: '来源无效' });
        }
        if (host !== request.headers.host) return reply.code(403).send({ error: '来源不匹配' });
      }
    }
    if (
      request.url === '/healthz' ||
      request.url === '/api/login' ||
      !request.url.startsWith('/api/')
    )
      return;
    const cookies = (request.headers.cookie ?? '').split(';').map((part) => part.trim());
    const token = cookies
      .find((part) => part.startsWith('xing_session='))
      ?.slice('xing_session='.length);
    if (!token || (sessions.get(token) ?? 0) <= Date.now())
      return reply.code(401).send({ error: '请先登录' });
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof TypeError || error instanceof SyntaxError)
      return reply.code(400).send({ error: error.message });
    const statusCode =
      error instanceof Error && 'statusCode' in error ? Number(error.statusCode) : 500;
    if (Number.isInteger(statusCode) && statusCode >= 400 && statusCode < 500)
      return reply.code(statusCode).send({ error: '请求无效' });
    return reply.code(500).send({ error: '操作失败' });
  });

  // 静态资源（管理页与表情目录）——路径锁定在各自根内。
  app.get('/*', async (request, reply) => {
    if (request.url.startsWith('/api/') || request.url === '/healthz') return reply.callNotFound();
    const raw = request.url.split('?')[0]!;
    if (raw.startsWith('/assets/stickers/')) {
      const target = resolve(options.assetsRoot, raw.slice('/assets/'.length));
      if (!target.startsWith(resolve(options.assetsRoot) + sep))
        return reply.code(403).send({ error: '路径无效' });
      if (!existsSync(target) || !statSync(target).isFile())
        return reply.code(404).send({ error: '不存在' });
      return reply
        .header('content-type', MIME[extname(target)] ?? 'application/octet-stream')
        .header('cache-control', 'public, max-age=86400')
        .send(readFileSync(target));
    }
    const target = resolve(options.staticRoot, raw === '/' ? 'index.html' : raw.replace(/^\//, ''));
    if (target !== options.staticRoot && !target.startsWith(resolve(options.staticRoot) + sep))
      return reply.code(403).send({ error: '路径无效' });
    if (!existsSync(target) || !statSync(target).isFile())
      return reply.code(404).send({ error: '不存在' });
    const bytes = readFileSync(target);
    return reply
      .header('content-type', MIME[extname(target)] ?? 'application/octet-stream')
      .send(bytes);
  });

  app.get('/healthz', async () => ({ ok: true }));
  app.post('/api/login', async (request, reply) => {
    const now = Date.now();
    for (const [token, expiry] of sessions) if (expiry <= now) sessions.delete(token);
    for (const [address, value] of attempts) if (value.resetAt <= now) attempts.delete(address);
    const attempt = attempts.get(request.ip) ?? { count: 0, resetAt: now + 60_000 };
    if (attempt.count >= 8) return reply.code(429).send({ error: '登录过于频繁' });
    const body = request.body as { password?: unknown } | undefined;
    if (
      typeof body?.password !== 'string' ||
      !timingSafeEqual(digest(body.password), passwordHash)
    ) {
      attempt.count++;
      if (attempts.size >= 1024 && !attempts.has(request.ip))
        attempts.delete(attempts.keys().next().value!);
      attempts.set(request.ip, attempt);
      return reply.code(401).send({ error: '密码错误' });
    }
    attempts.delete(request.ip);
    if (sessions.size >= 32) sessions.delete(sessions.keys().next().value!);
    const token = randomBytes(32).toString('hex');
    sessions.set(token, now + 12 * 3_600_000);
    reply.header(
      'set-cookie',
      `xing_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200${options.secureCookie ? '; Secure' : ''}`,
    );
    return { ok: true };
  });
  app.post('/api/logout', async (request, reply) => {
    const token = (request.headers.cookie ?? '')
      .split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith('xing_session='))
      ?.slice(13);
    if (token) sessions.delete(token);
    reply.header('set-cookie', 'xing_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
    return { ok: true };
  });

  // 配置
  app.get('/api/config', async () => options.settings.public());
  app.put('/api/config', async (request) => {
    options.settings.update(request.body);
    return options.settings.public();
  });

  // 状态总览
  app.get('/api/status', async () => ({
    channel: options.router.status(),
    self: options.journal.self(),
    mood: options.journal.mood(options.journal.peers()[0] ?? ''),
    jobs: options.journal.jobs(),
    wechat: options.bridge.status(),
  }));

  // 微信
  app.post('/api/wechat/login', async () => {
    options.bridge.login();
    return { ok: true };
  });
  app.get('/api/wechat/status', async () => {
    const status = options.bridge.status();
    if (!status.qr) return status;
    // 二维码服务端渲染成 data URI：管理页不依赖任何外部服务。
    try {
      return { ...status, qrData: await QRCode.toDataURL(status.qr, { margin: 1, width: 220 }) };
    } catch {
      return status;
    }
  });
  app.post('/api/wechat/logout', async () => {
    await options.bridge.logout();
    return { ok: true };
  });
  app.get('/api/wechat/contacts', async () => options.bridge.contacts());
  app.post('/api/wechat/approve', async (request) => {
    const body = request.body as { address?: unknown } | undefined;
    options.bridge.approve(String(body?.address ?? ''));
    return { ok: true };
  });

  // 她的生活（单联系人主用第一个 peer；列表供 UI 兜底）
  app.get('/api/peers', async () => options.journal.peers());
  const firstPeer = () => options.journal.peers()[0] ?? '';
  app.get('/api/events', async (request) => {
    const peer = (request.query as { peer?: string } | undefined)?.peer || firstPeer();
    return options.journal.events(peer);
  });
  app.get('/api/memories', async (request) => {
    const peer = (request.query as { peer?: string } | undefined)?.peer || firstPeer();
    return options.journal.memories(peer);
  });
  app.get('/api/thoughts', async (request) => {
    const peer = (request.query as { peer?: string } | undefined)?.peer || firstPeer();
    return options.journal.thoughts(peer);
  });
  app.get('/api/commitments', async (request) => {
    const peer = (request.query as { peer?: string } | undefined)?.peer || firstPeer();
    return options.journal.commitments(peer);
  });
  app.get('/api/deliveries', async (request) => {
    const peer = (request.query as { peer?: string } | undefined)?.peer || firstPeer();
    return options.journal.unresolved(peer);
  });
  app.post<{ Params: { id: string } }>('/api/deliveries/:id/resolve', async (request, reply) => {
    const status = (request.body as { status?: unknown } | undefined)?.status;
    if (status !== 'sent' && status !== 'failed')
      throw new TypeError('必须明确确认已送达或发送失败');
    const changed = options.runtime.resolveDelivery(request.params.id, status);
    return changed ? { ok: true } : reply.code(409).send({ error: '当前状态不能确认' });
  });

  // 表情
  app.get('/api/stickers', async () => options.stickers.list(true));
  app.post('/api/stickers', async (request) => {
    const body = request.body as
      { slug?: unknown; description?: unknown; tags?: unknown; base64?: unknown } | undefined;
    options.stickers.add({
      slug: String(body?.slug ?? ''),
      description: String(body?.description ?? ''),
      tags: Array.isArray(body?.tags) ? body.tags.map((tag) => String(tag)) : [],
      base64: String(body?.base64 ?? ''),
    });
    return { ok: true };
  });
  app.post<{ Params: { slug: string } }>('/api/stickers/:slug/disable', async (request) => {
    options.stickers.disable(request.params.slug);
    return { ok: true };
  });
  app.post<{ Params: { slug: string } }>('/api/stickers/:slug/enable', async (request) => {
    options.stickers.enable(request.params.slug);
    return { ok: true };
  });
  app.delete<{ Params: { slug: string } }>('/api/stickers/:slug', async (request) => {
    options.stickers.remove(request.params.slug);
    return { ok: true };
  });

  // 沙箱（她的手）与用量
  app.get('/api/sandbox', async () => {
    if (!options.sandbox) return { enabled: false };
    return {
      enabled: options.sandbox.enabled,
      usage: options.sandbox.usage(),
      sizeLimit: options.sandbox.sizeLimit,
      ...(await options.sandbox.isolationInfo()),
    };
  });
  app.get('/api/sandbox/files', async (request) => {
    if (!options.sandbox) throw new TypeError('沙箱未启用');
    const path = (request.query as { path?: string } | undefined)?.path || '.';
    return options.sandbox.list(path);
  });
  app.get('/api/usage', async (request) => {
    const days = Number((request.query as { days?: string } | undefined)?.days ?? 7);
    return options.journal.usage(Number.isFinite(days) ? days : 7);
  });
  app.get('/api/embeddings', async (request) => {
    const peer = (request.query as { peer?: string } | undefined)?.peer || firstPeer();
    const model = options.settings.get().embedding?.model ?? '';
    if (!model) return { model: '', pending: 0 };
    return { model, pending: options.journal.searchable(peer, model, 4096).length };
  });

  return app;
}
