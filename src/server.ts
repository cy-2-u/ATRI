import Fastify from 'fastify';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { resolve, sep, extname } from 'node:path';
import QRCode from 'qrcode';
import { Settings } from './settings.js';
import { Journal } from './storage/journal.js';
import { ModelRouter } from './model/router.js';
import { Runtime } from './runtime/runtime.js';
import { WechatBridge } from './wechat/bridge.js';
import { Stickers } from './stickers.js';
import { Sandbox } from './sandbox.js';
import type { Wall } from './wall.js';
import type { WebDavBackup } from './backup.js';

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
  /** 配置落库后回调：心跳开关打开时这里立刻补种她的下一拍，不等维护定时器。 */
  onConfigChange?: () => void;
  /** 渠道体检：连通（一发最小消息）、角色生效（system 标记探测）、向量连通。
   *  失败随结果对象返回（{ok:false,error}）——探针的诊断就是它的产出，
   *  不走服务端错误兜底。 */
  channelProbe(): Promise<
    { ok: true; latencyMs: number; model: string; format: string } | { ok: false; error: string }
  >;
  systemProbe(): Promise<{ ok: boolean; reply?: string; error?: string }>;
  embeddingProbe(): Promise<
    { ok: true; latencyMs: number; dims: number; model: string } | { ok: false; error: string }
  >;
  staticRoot: string;
  /** 表情等只读资产的根（仅放行 assets/stickers/ 前缀）。 */
  assetsRoot: string;
  /** 自定义表情文件的根（dataDir/custom）：管理页预览用。 */
  customStickersRoot: string;
  /** 留言墙（免登录公开页 /wall）：她 publish、他直接写。 */
  wall?: Wall;
  /** WebDAV 每日备份：管理页透出状态与"立即备份"。 */
  backup?: WebDavBackup;
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
  // cookie 里带的是会话令牌本身，不是"是否登录"布尔：过期/未知令牌在
  // sessions 里查不到，两种门禁（API 401、页面渲染表单）共用这一个事实。
  const sessionToken = (request: { headers: { cookie?: string } }) =>
    (request.headers.cookie ?? '')
      .split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith('atri_session='))
      ?.slice('atri_session='.length);
  const loggedIn = (request: { headers: { cookie?: string } }) => {
    const token = sessionToken(request);
    return token !== undefined && (sessions.get(token) ?? 0) > Date.now();
  };

  app.addHook('onRequest', async (request, reply) => {
    // API 不缓存（响应随状态实时变）；静态页走 no-cache——浏览器可存副本
    // 但每次用 ETag 验证，命中就是无 body 的 304，不再整页重拉。
    reply.header(
      'cache-control',
      request.url.startsWith('/api/') || request.url === '/healthz' ? 'no-store' : 'no-cache',
    );
    reply.header('x-content-type-options', 'nosniff');
    // 页面无内联脚本与样式：default-src 'self' 放行同源脚本/样式/请求，
    // img 加 data:（扫码二维码是 data URI）。此前的 default-src 'none'
    // 会把 app.js 与全部 fetch 一并拦死——管理页在浏览器里从未活过。
    reply.header(
      'content-security-policy',
      "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'",
    );
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
      // 墙公开的只有看：列表与图片。写（POST /api/wall）要登录——from 写死
      // 'him'，裸奔等于任何游客都能冒充他发便签、触发她的提示牌。
      (/^\/api\/wall(\/|$)/.test(request.url) && request.method === 'GET') ||
      !request.url.startsWith('/api/')
    )
      return;
    if (!loggedIn(request)) return reply.code(401).send({ error: '请先登录' });
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
      // assetsRoot 本身就是 assets/stickers：剥壳必须剥到同层——只剥
      // '/assets/' 会多拼一层 stickers，全部表情图 404 成"（自定义文件）"。
      // 前端把 file 编码为 memes%2F002.jpg：resolve 前先解码（解码后的
      // 路径仍要过下面的越界检查，%2e%2e 同样被拦）。自定义表情的
      // custom/ 前缀落在数据目录（stickers.add 只写 dataDir/custom）。
      const rel = decodeURIComponent(raw.slice('/assets/stickers/'.length));
      const base = rel.startsWith('custom/')
        ? { root: options.customStickersRoot, rel: rel.slice('custom/'.length) }
        : { root: options.assetsRoot, rel };
      const target = resolve(base.root, base.rel);
      if (!target.startsWith(resolve(base.root) + sep))
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
    // 文本资源 gzip（~1/4）+ ETag 304：管理页刷新只传空响应。
    const mime = MIME[extname(target)] ?? 'application/octet-stream';
    const bytes = readFileSync(target);
    const gzipped =
      /^(text\/|application\/(json|javascript|xhtml))/i.test(mime) &&
      String(request.headers['accept-encoding'] ?? '').includes('gzip');
    const payload = gzipped ? gzipSync(bytes) : bytes;
    const etag = `"${createHash('sha1').update(payload).digest('base64')}"`;
    reply.header('etag', etag).header('vary', 'accept-encoding');
    if (request.headers['if-none-match'] === etag) return reply.code(304).send();
    reply.header('content-type', mime);
    if (gzipped) reply.header('content-encoding', 'gzip');
    return reply.send(payload);
  });

  app.get('/healthz', async () => ({ ok: true }));

  // ---------- 留言墙：看对所有人开放，写只属于登录的他 ----------
  const wallRate = new Map<string, { count: number; resetAt: number }>();
  const wallHtml = (signedIn: boolean) => `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>留言墙</title>
<link rel="stylesheet" href="/wall.css"></head>
<body><main id="app">
<header class="head"><h1>我们的留言墙</h1><p class="sub">随手留一句话，有画就挂出来。</p></header>
<ol id="notes" aria-live="polite"></ol>
${
  signedIn
    ? `<form id="post"><textarea id="text" maxlength="500" rows="2" placeholder="写点什么贴上墙…" required></textarea>
<button type="submit">贴上墙</button></form>`
    : '<p class="guest-hint">想留一句话？登录之后才能贴。</p>'
}</main>
<div id="lightbox" hidden><img alt="墙上的图片" src=""><span class="tip">长按图片可保存 · 点任意处关闭</span></div>
<script src="/wall.js"></script></body></html>`;
  const wallGet = async () => options.wall?.list() ?? [];
  app.get('/wall', async (request, reply) => {
    reply.header('content-type', 'text/html; charset=utf-8');
    return wallHtml(loggedIn(request));
  });
  const wallLimit = (
    request: { ip: string },
    reply: { code: (n: number) => { send: (v: unknown) => unknown } },
    weight = 1,
  ) => {
    // 伪造 IP 只会让驱逐逻辑踢掉假桶，真桶计数不受影响（与 login 同款上限）。
    const now = Date.now();
    for (const [key, value] of wallRate) if (value.resetAt <= now) wallRate.delete(key);
    if (wallRate.size >= 1024 && !wallRate.has(request.ip))
      wallRate.delete(wallRate.keys().next().value!);
    const bucket = wallRate.get(request.ip) ?? { count: 0, resetAt: now + 60_000 };
    if (bucket.count + weight > 5) return reply.code(429).send({ error: '太快了，歇一会' });
    bucket.count += weight;
    wallRate.set(request.ip, bucket);
    return undefined;
  };
  app.get('/api/wall', async (request, reply) => {
    // 读也要限速：列表是一次 SQL 查询，公开端点不白送。
    if (wallLimit(request, reply, 0.2) !== undefined) return;
    // 公开页的每次浏览都是"他看过墙"的事实：她作品的回执数据面。
    options.wall?.markHisView();
    return wallGet();
  });
  app.post('/api/wall', async (request, reply) => {
    if (!options.wall) return reply.code(404).send({ error: '没有墙' });
    // 登录门禁在 onRequest hook（放行只给 GET）；这里再挡一次不是冗余：
    // from 写死 'him'，这行的存在本身声明"能走到这的都是他"。
    if (!loggedIn(request)) return reply.code(401).send({ error: '登录后才能贴便签' });
    if (wallLimit(request, reply) !== undefined) return;
    const body = request.body as { text?: unknown } | undefined;
    if (typeof body?.text !== 'string' || !body.text.trim())
      throw new TypeError('留言必须是非空文本');
    if (body.text.length > 500) throw new TypeError('留言最长 500 字');
    return options.wall.post('him', body.text);
  });
  app.get('/api/wall/images/:name', async (request, reply) => {
    const name = String((request.params as { name: string }).name);
    const file = options.wall?.imageFile(name);
    if (!file) return reply.code(404).send({ error: '不存在' });
    // no-cache + ETag：图可被原位替换（修复重传），长 max-age 会让浏览器
    // 拿着旧字节演 24 小时（真机实锤：换图后用户端仍冻结）。ETag 命中即 304。
    const bytes = readFileSync(file);
    const etag = `"${createHash('sha1').update(bytes).digest('base64')}"`;
    if (request.headers['if-none-match'] === etag)
      return reply.code(304).header('etag', etag).header('cache-control', 'no-cache').send();
    // 扩展名决定 content-type：表情包 jpg/gif/webp 上墙后浏览器要按真类型渲染。
    const types: Record<string, string> = {
      png: 'image/png',
      jpg: 'image/jpeg',
      gif: 'image/gif',
      webp: 'image/webp',
    };
    return reply
      .header('content-type', types[file.split('.').pop() ?? ''] ?? 'image/png')
      .header('etag', etag)
      .header('cache-control', 'no-cache')
      .send(bytes);
  });

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
      `atri_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200${options.secureCookie ? '; Secure' : ''}`,
    );
    return { ok: true };
  });
  app.post('/api/logout', async (request, reply) => {
    const token = sessionToken(request);
    if (token) sessions.delete(token);
    reply.header('set-cookie', 'atri_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
    return { ok: true };
  });

  // 配置
  app.get('/api/config', async () => options.settings.public());
  app.put('/api/config', async (request) => {
    options.settings.update(request.body);
    options.onConfigChange?.();
    return options.settings.public();
  });

  // 渠道体检（v5 时代的按钮回归）：走与真实轮次同一套 transport，测的
  // 就是聊天真正会走的那条路。
  app.post('/api/test-llm', async () => options.channelProbe());
  app.post('/api/test-system', async () => options.systemProbe());
  app.post('/api/test-embedding', async () => options.embeddingProbe());

  // WebDAV 备份：状态给管理页，"立即备份"绕过每日闸门当场跑一轮。
  // 失败随 200 返回 {ok:false,error}——真实诊断就是产出，不走 500 兜底。
  app.get('/api/backup', async () => ({
    configured: options.backup?.configured ?? false,
    ...(options.backup?.state ?? {}),
  }));
  app.post('/api/backup', async () => {
    if (!options.backup) throw new TypeError('备份未装配');
    if (!options.backup.configured) throw new TypeError('请先在系统设置里填写 WebDAV');
    try {
      await options.backup.run(Date.now());
      return { ok: true, ...options.backup.state };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  // 拉取模型列表（v5 回归）：主渠道必须是 OpenAI 兼容接口才有 /models。
  app.get('/api/models', async () => {
    const endpoint = options.settings.get().primary;
    if (endpoint.format !== 'openai') throw new TypeError('模型列表拉取仅支持 OpenAI 兼容接口');
    if (!endpoint.apiKey) throw new TypeError('请先保存模型密钥');
    const base = endpoint.baseUrl.replace(/\/+$/, '');
    const url = /\/v\d+$/.test(base) ? `${base}/models` : `${base}/v1/models`;
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${endpoint.apiKey}` },
      signal: AbortSignal.timeout(15_000),
    });
    // 读一次再用：response.json() 会吃掉 body，错误分支的 text() 只剩空串。
    const raw = await response.text().catch(() => '');
    type ModelListBody = { data?: { id?: unknown }[]; error?: { message?: unknown } };
    let body: ModelListBody | null = null;
    try {
      body = raw ? (JSON.parse(raw) as ModelListBody) : null;
    } catch {
      body = null;
    }
    if (!response.ok)
      throw new TypeError(
        `拉取模型列表失败（HTTP ${response.status}）：${(body?.error?.message as string) || raw.slice(0, 200) || '无响应内容'}`,
      );
    const ids = (body?.data ?? [])
      .filter((m): m is { id: string } => typeof m?.id === 'string')
      .map((m) => m.id);
    return { models: [...new Set(ids)].sort((a, b) => a.localeCompare(b)) };
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

  // 她的生活（单联系人主用第一个 peer）
  const firstPeer = () => options.journal.peers()[0] ?? '';
  app.get('/api/events', async (request) => {
    const peer = (request.query as { peer?: string } | undefined)?.peer || firstPeer();
    // kinds 过滤：管理页"内心"各分区只要自己那类事件，别让一次切换拖全量。
    const requested = String((request.query as { kinds?: string } | undefined)?.kinds ?? '');
    const kinds = requested
      .split(',')
      .map((kind) => kind.trim())
      .filter((kind) =>
        ['received', 'said', 'diary', 'muse', 'failure', 'experienced', 'attempted'].includes(kind),
      );
    const limit = Number((request.query as { limit?: string } | undefined)?.limit ?? 500);
    return options.journal.events(
      peer,
      kinds.length ? kinds : undefined,
      Number.isFinite(limit) ? limit : 500,
    );
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
    return options.journal.usage(Number.isFinite(days) ? days : 7, options.settings.get().timezone);
  });
  app.get('/api/embeddings', async (request) => {
    const peer = (request.query as { peer?: string } | undefined)?.peer || firstPeer();
    const model = options.settings.get().embedding?.model ?? '';
    if (!model) return { model: '', pending: 0 };
    return { model, pending: options.journal.searchablePendingCount(peer, model) };
  });

  return app;
}
