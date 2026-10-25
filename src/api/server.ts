import Fastify from 'fastify';
import QRCode from 'qrcode';
import { createHash, randomBytes, timingSafeEqual, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Store } from '../db/index.js';
import { createBackup } from '../db/index.js';
import { EmbeddingClient, HttpModel } from '../llm.js';
import type { Runtime } from '../core/index.js';
import { sniffMediaMime } from '../ilink/media.js';
import type { Settings } from './config.js';
import { PERSONA_PRESETS } from './config.js';
import type { Stickers } from './stickers.js';
import type { Sandbox } from './sandbox.js';
import type { WeChatBridge } from './wechat.js';

/** HTTP 层：管理 API（Cookie/Bearer 双通道鉴权）、静态管理页、全部运维
 *  动作。业务校验抛普通 Error 约定回 400，框架错误透传自带状态码。 */

export interface ServerOptions {
  store: Store;
  settings: Settings;
  runtime: Runtime;
  bridge: WeChatBridge;
  stickers: Stickers;
  sandbox?: Sandbox;
}
const digest = (v: string) => createHash('sha256').update(v).digest();
/** 任务去重键用的短稳定摘要。 */
const hashGreeting = (v: string) => createHash('sha256').update(v).digest('hex').slice(0, 12);
const text = (v: unknown, max = 12000) => {
  if (typeof v !== 'string' || !v.trim() || v.length > max)
    throw new Error(`文本需要 1–${max} 个字符`);
  return v.trim();
};
/** 接受空串：可选字段的"清空"是真实意图（如"不要开场白"）。 */
const optionalText = (v: unknown, max = 12000) => {
  if (typeof v !== 'string' || v.length > max) throw new Error(`文本需要在 ${max} 个字符以内`);
  return v.trim();
};

export function createServer(o: ServerOptions) {
  const app = Fastify({ bodyLimit: 5 * 1024 * 1024, logger: false });
  const sessions = new Map<string, number>(),
    failures = new Map<string, { count: number; until: number }>();
  const blocked = (ip: string, now = Date.now()) => {
    const attempt = failures.get(ip);
    return Boolean(attempt && attempt.until > now && attempt.count >= 8);
  };
  const recordFailure = (ip: string, now = Date.now()) => {
    const attempt = failures.get(ip);
    failures.set(ip, {
      count: attempt && attempt.until > now ? attempt.count + 1 : 1,
      until: now + 60000,
    });
    if (failures.size > 1000)
      for (const [key, value] of failures) if (value.until < now) failures.delete(key);
  };
  const publicDir = join(o.settings.root, 'public');
  const staticCache = new Map<string, Buffer>();
  const asset = (name: string) => {
    let bytes = staticCache.get(name);
    if (!bytes) {
      bytes = readFileSync(join(publicDir, name));
      staticCache.set(name, bytes);
    }
    return bytes;
  };
  let qrKey: string | undefined, qrDataUrl: string | undefined;
  const qrData = async (content: string) => {
    if (qrKey !== content) {
      qrKey = content;
      qrDataUrl = await QRCode.toDataURL(content, { width: 256, margin: 2 });
    }
    return qrDataUrl!;
  };
  const credentials = digest(o.settings.adminPassword);
  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-content-type-options', 'nosniff').header('referrer-policy', 'same-origin');
    reply.header(
      'content-security-policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    );
    if (request.url.startsWith('/api/')) reply.header('cache-control', 'no-store');
    if (!request.url.startsWith('/api/') || request.url === '/api/login') return;
    const now = Date.now();
    const bearer = request.headers.authorization?.replace(/^Bearer /, '') ?? '';
    const token = /\batri_session=([^;]+)/.exec(request.headers.cookie ?? '')?.[1];
    const validBearer = !!bearer && timingSafeEqual(digest(bearer), credentials);
    const cookieValid = Boolean(token && (sessions.get(token) ?? 0) >= now);
    if (!validBearer && !cookieValid) {
      // Bearer 请求绕过 /api/login 也就绕过了它的限流：这里补计数。
      if (bearer) {
        if (blocked(request.ip, now))
          return reply.code(429).send({ error: '尝试次数较多，请一分钟后再试' });
        recordFailure(request.ip, now);
      }
      return reply.code(401).send({ error: '请先登录管理页' });
    }
    if (!['GET', 'HEAD'].includes(request.method) && request.headers.origin) {
      try {
        if (new URL(request.headers.origin).host !== request.headers.host)
          return reply.code(403).send({ error: '请求来源不匹配' });
      } catch {
        return reply.code(403).send({ error: '请求来源无效' });
      }
    }
  });
  app.setErrorHandler((error, _request, reply) => {
    const e = error as Error & { statusCode?: number };
    reply
      .code(e.statusCode && e.statusCode >= 400 && e.statusCode < 600 ? e.statusCode : 400)
      .send({ error: e.message.slice(0, 300) });
  });
  app.get('/healthz', (_request, reply) => {
    try {
      // 连不上 SQLite 的进程不算健康（磁盘满、WAL 损坏、库已关）。
      o.store.sql.prepare('SELECT 1').get();
      return { ok: true };
    } catch {
      return reply.code(503).send({ ok: false });
    }
  });
  app.get('/', (_request, reply) =>
    reply.type('text/html; charset=utf-8').send(asset('index.html')),
  );
  app.get('/app.js', (_request, reply) =>
    reply.type('application/javascript; charset=utf-8').send(asset('app.js')),
  );
  app.get('/app.css', (_request, reply) =>
    reply.type('text/css; charset=utf-8').send(asset('app.css')),
  );
  app.get('/atri.webp', (_request, reply) =>
    reply
      .type('image/webp')
      .header('cache-control', 'public, max-age=86400')
      .send(asset('atri.webp')),
  );

  app.post<{ Body: { password?: string } }>('/api/login', async (request, reply) => {
    if (request.headers.origin) {
      try {
        if (new URL(request.headers.origin).host !== request.headers.host)
          return reply.code(403).send({ error: '请求来源不匹配' });
      } catch {
        return reply.code(403).send({ error: '请求来源无效' });
      }
    }
    const now = Date.now(),
      ip = request.ip;
    if (blocked(ip, now)) return reply.code(429).send({ error: '尝试次数较多，请一分钟后再试' });
    const password = typeof request.body?.password === 'string' ? request.body.password : '';
    if (!password || !timingSafeEqual(digest(password), credentials)) {
      recordFailure(ip, now);
      return reply.code(401).send({ error: '管理密码不正确' });
    }
    failures.delete(ip);
    const token = randomBytes(32).toString('base64url');
    sessions.set(token, now + 12 * 3600000);
    if (sessions.size > 100) sessions.delete(sessions.keys().next().value!);
    reply.header(
      'set-cookie',
      `atri_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200${o.settings.secureCookie ? '; Secure' : ''}`,
    );
    return { ok: true };
  });
  app.post('/api/logout', (request, reply) => {
    const token = /\batri_session=([^;]+)/.exec(request.headers.cookie ?? '')?.[1];
    if (token) sessions.delete(token);
    reply.header('set-cookie', 'atri_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
    return { ok: true };
  });

  app.get('/api/status', async () => {
    const status = o.bridge.status();
    return {
      wechat: {
        ...status,
        qrContent: undefined,
        qrData: status.qrContent ? await qrData(status.qrContent) : undefined,
      },
      config: o.settings.publicConfig(),
      usage: o.store.usage(),
      recentUsage: o.store.recentUsage(),
      issues: o.store.issues(),
      // "她最近怎么样"的只读视图：心情、待问的约定、多久没来。
      states: (() => {
        const moods = o.store.moods();
        const due = o.store.dueLoopCounts();
        return o.store.peers().map((peer) => {
          const mood = moods.get(peer.id) ?? { valence: 0, energy: 0, patience: 0, at: 0 };
          return {
            peerId: peer.id,
            address: peer.address,
            approved: !!peer.approved,
            mood: mood.at ? mood : undefined,
            dueLoops: due.get(peer.id) ?? 0,
            lastUserAt: peer.last_user_at,
            lastProactiveAt: peer.last_proactive_at,
          };
        });
      })(),
    };
  });
  app.post('/api/wechat/login', () => o.bridge.login());
  app.post('/api/wechat/logout', () => {
    o.bridge.logout();
    return { ok: true };
  });
  app.get('/api/config', () => o.settings.publicConfig());
  app.post('/api/backup', async () => {
    const result = await createBackup(o.store, o.settings.dataDir);
    return {
      directory: result.directory,
      files: result.manifest.files.length,
      messages: result.manifest.messages,
    };
  });
  app.put<{ Body: Record<string, unknown> }>('/api/config', (request) =>
    o.settings.update(request.body ?? {}),
  );
  app.get('/api/sandbox', async () => {
    const sandbox = o.sandbox;
    return {
      enabled: Boolean(sandbox?.enabled),
      root: sandbox ? sandbox.root : '',
      usage: sandbox ? sandbox.usage() : { files: 0, bytes: 0 },
      sizeLimitBytes: sandbox ? sandbox.sizeLimit : 0,
      memoryLimitMb: o.settings.config().sandboxMemoryMb,
      timeoutSeconds: o.settings.config().sandboxTimeoutSeconds,
      isolation: sandbox ? await sandbox.isolationInfo() : undefined,
    };
  });
  app.post('/api/sandbox/clear', () => {
    if (!o.sandbox) throw new Error('沙箱未配置');
    o.sandbox.clear();
    return { ok: true };
  });

  // ---------- 人格 ----------

  app.get('/api/personas', () => {
    const { list, defaultId } = o.settings.personaList();
    const bindings = Object.fromEntries(o.store.peers().map((p) => [p.id, p.persona_id ?? '']));
    return { list, defaultId, bindings };
  });
  // content 一并返回：新建表单直接从预设起步，没有文本的模板只会产出占位符。
  app.get('/api/persona-presets', () => PERSONA_PRESETS);
  app.post<{ Body: { name: string; content: string } }>('/api/personas', (request) => {
    const input = request.body ?? {};
    return o.settings.personaCreate(text(input.name, 40), text(input.content));
  });
  app.put<{ Params: { id: string }; Body: { name?: string; content?: string; greeting?: string } }>(
    '/api/personas/:id',
    (request) => {
      const input = request.body ?? {};
      if (input.name === undefined && input.content === undefined && input.greeting === undefined)
        throw new Error('没有需要保存的修改');
      return o.settings.personaUpdate(request.params.id, {
        ...(input.name !== undefined ? { name: text(input.name, 40) } : {}),
        ...(input.content !== undefined ? { content: text(input.content) } : {}),
        // 空串在这里有意义（"不要开场白"），用宽松校验。
        ...(input.greeting !== undefined ? { greeting: optionalText(input.greeting, 200) } : {}),
      });
    },
  );
  app.delete<{ Params: { id: string } }>('/api/personas/:id', (request) =>
    o.settings.personaDelete(request.params.id),
  );
  app.put<{ Params: { id: string } }>('/api/personas/:id/default', (request) =>
    o.settings.personaSetDefault(request.params.id),
  );
  app.put<{ Params: { id: string }; Body: { personaId: string } }>(
    '/api/peers/:id/persona',
    (request) => {
      const input = request.body ?? {};
      if (typeof input.personaId !== 'string') throw new Error('人格选择无效');
      return o.settings.setPeerPersona(request.params.id, input.personaId);
    },
  );

  // ---------- 模型连通性 ----------

  app.get('/api/models', async () => {
    const c = o.settings.config();
    if (c.format !== 'openai') throw new Error('模型列表拉取仅支持 OpenAI 兼容接口');
    if (!c.apiKey) throw new Error('请先保存模型密钥');
    const base = c.baseUrl.replace(/\/+$/, '');
    const url = /\/v\d+$/.test(base) ? `${base}/models` : `${base}/v1/models`;
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${c.apiKey}` },
      signal: AbortSignal.timeout(15000),
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
      throw new Error(
        `拉取模型列表失败（HTTP ${response.status}）：${
          (body?.error?.message as string) || raw.slice(0, 200) || '无响应内容'
        }`,
      );
    const data = Array.isArray(body?.data) ? body.data : [];
    const ids = [
      ...new Set(
        data
          .filter((m) => m && typeof m === 'object')
          .map((m) => (typeof m.id === 'string' ? m.id.trim() : ''))
          .filter(Boolean),
      ),
    ];
    return { models: ids.sort((a, b) => a.localeCompare(b)) };
  });
  app.post('/api/test-llm', async () => {
    const c = o.settings.config();
    if (!c.apiKey || !c.model) throw new Error('请先保存模型名称和 API 密钥');
    // 与真实轮次同一个请求构造器：手搓三套协议会让连接测试通过、聊天
    // 却在另一套代码上失败。
    const model = new HttpModel(o.settings.model());
    const started = Date.now();
    await model.complete([{ role: 'user', content: 'hi' }], [], {
      maxTokens: 1,
      signal: AbortSignal.timeout(Math.min(c.requestTimeoutSeconds, 60) * 1000),
    });
    return { ok: true, latencyMs: Date.now() - started, model: c.model, format: c.format };
  });
  app.post('/api/test-embedding', async () => {
    const e = o.settings.embedding();
    if (!e.model) throw new Error('请先保存向量模型名称');
    if (!e.apiKey) throw new Error('请先填写并保存向量模型密钥');
    if (!e.baseUrl) throw new Error('请先填写并保存向量模型地址（或上方 API 地址）');
    const started = Date.now();
    const vectors = await new EmbeddingClient(() => e).embed(['连通性测试']);
    return {
      ok: true,
      latencyMs: Date.now() - started,
      dims: vectors[0]?.length ?? 0,
      model: e.model,
    };
  });

  // ---------- 联系人 ----------

  app.get('/api/peers', () =>
    // 试聊联系人在启动时 ensurePeer：读接口逐次写入还会给 DNS 重绑探测
    // 白送一次数据库写。
    o.store.peers().map(({ context_token, ...peer }) => peer),
  );
  app.put<{ Params: { id: string }; Body: { approved: boolean } }>('/api/peers/:id', (request) => {
    const input = request.body ?? {};
    if (typeof input.approved !== 'boolean' || !o.store.peer(request.params.id))
      throw new Error('联系人或设置无效');
    const peer = o.store.peer(request.params.id)!;
    o.store.approve(request.params.id, input.approved);
    // 首次批准真实联系人：排一次开场白任务。空开场白表示不问候。
    // key 带版本与内容摘要：重批准时更新过的开场白能再发一次。
    if (input.approved && !peer.approved && peer.channel === 'wechat') {
      const greeting = o.settings.personaGreetingFor(peer.id);
      if (greeting.trim())
        o.store.enqueue(
          peer.id,
          'proactive',
          `greeting:${peer.version}:${hashGreeting(greeting)}`,
          { greeting },
          Date.now(),
        );
    }
    o.runtime.pump();
    return { ok: true };
  });
  // 删除联系人与其全部记录。不静默幂等：行已不在时该报错，让运维知道
  // 删的是已经不存在的东西。
  app.delete<{ Params: { id: string } }>('/api/peers/:id', (request) => {
    if (request.params.id.startsWith('preview:')) throw new Error('本地试聊是内置联系人，不能删除');
    const removed = o.store.deletePeer(request.params.id);
    if (!removed) throw new Error('联系人不存在');
    o.runtime.pump();
    return { ok: true, removed };
  });
  app.get<{ Params: { id: string } }>('/api/peers/:id/history', (request) =>
    o.store.history(request.params.id, 100).map(({ media, ...m }) => ({
      ...m,
      media: media.map(({ kind, description }) => ({ kind, description })),
    })),
  );
  app.get<{ Params: { id: string } }>('/api/peers/:id/memories', (request) =>
    o.store.memories(request.params.id),
  );
  app.get<{ Params: { id: string } }>('/api/peers/:id/diaries', (request) =>
    o.store.diaries(request.params.id),
  );
  app.get<{ Params: { id: string }; Querystring: { ids?: string } }>(
    '/api/peers/:id/sources',
    (request) => o.store.sources(request.params.id, text(request.query.ids, 4000).split(',')),
  );
  app.post<{ Params: { id: string } }>('/api/peers/:id/diary', (request) => {
    if (!o.store.peer(request.params.id)?.approved) throw new Error('请先允许此联系人使用');
    const taskId = o.runtime.queueDiary(request.params.id, true);
    return { taskId: taskId ?? null };
  });
  app.put<{ Params: { peer: string; id: string }; Body: { content: string } }>(
    '/api/peers/:peer/memories/:id',
    (request) => {
      const input = request.body ?? {};
      o.store.correctMemory(request.params.peer, request.params.id, text(input.content, 800));
      return { ok: true };
    },
  );
  app.put<{ Params: { peer: string; id: string }; Body: { pinned: boolean } }>(
    '/api/peers/:peer/memories/:id/pinned',
    (request) => {
      const input = request.body ?? {};
      if (typeof input.pinned !== 'boolean') throw new Error('置顶状态无效');
      o.store.setMemoryPinned(request.params.peer, request.params.id, input.pinned);
      return { ok: true };
    },
  );
  app.get<{ Params: { id: string } }>('/api/peers/:id/loops', (request) => {
    const peer = request.params.id;
    // 日记页是唯一能看到两种未完事的地方；顺手过期保证"expired"诚实。
    o.store.expireSoftThreads(peer, Date.now());
    o.store.expireOpenLoops(peer, Date.now(), o.settings.config().timeZone);
    return [
      ...o.store.openLoops(peer).map((loop) => ({ ...loop, type: 'loop' as const })),
      ...o.store.softThreads(peer).map((thread) => ({ ...thread, type: 'thread' as const })),
    ];
  });
  app.post<{ Params: { peer: string; id: string } }>(
    '/api/peers/:peer/loops/:id/resolve',
    (request) => {
      if (!o.store.peer(request.params.peer)) throw new Error('联系人不存在');
      o.store.resolveOpenLoop(
        request.params.peer,
        request.params.id,
        Date.now(),
        o.settings.config().timeZone,
      );
      return { ok: true };
    },
  );
  app.post<{ Params: { peer: string; id: string } }>(
    '/api/peers/:peer/threads/:id/resolve',
    (request) => {
      if (!o.store.peer(request.params.peer)) throw new Error('联系人不存在');
      o.store.resolveSoftThread(request.params.peer, request.params.id);
      return { ok: true };
    },
  );
  app.delete<{ Params: { peer: string; id: string } }>(
    '/api/peers/:peer/records/:id',
    (request) => {
      o.store.forget(request.params.peer, request.params.id);
      return { ok: true };
    },
  );

  // ---------- 试聊与任务 ----------

  // 试聊用 preview 联系人：启动时建好，GET /api/peers 无需写入。
  app.post<{ Body: { content: string; eventId?: string } }>('/api/chat', (request, reply) => {
    const peer = o.store.ensurePeer('preview:default', 'preview', '本地试聊', '', true);
    const input = request.body ?? {};
    const event = o.runtime.accept(
      peer.id,
      input.eventId ? text(input.eventId, 100) : randomUUID(),
      text(input.content),
    );
    reply.code(202);
    return { peerId: peer.id, messageId: event.message.id, taskId: event.taskId ?? null };
  });
  app.get<{ Params: { id: string } }>('/api/tasks/:id', (request) => {
    const task = o.store.taskById(request.params.id);
    if (!task) throw new Error('任务不存在');
    return { id: task.id, state: task.state, error: task.error };
  });
  app.post<{ Params: { id: string } }>('/api/tasks/:id/retry', (request) => {
    const task = o.store.taskById(request.params.id);
    if (!task || task.state !== 'failed') throw new Error('只有失败任务可以重试');
    o.store.retry(task.id);
    o.runtime.pump();
    return { ok: true };
  });
  app.post<{ Params: { id: string } }>('/api/tasks/:id/dismiss', (request) => {
    // 没有它，耗尽重试的任务会一直挂在待办里直到被清理——运维学会无视
    // 铃铛之后，真正的投递失败就没人看了。
    const task = o.store.taskById(request.params.id);
    if (!task || task.state !== 'failed') throw new Error('只有失败任务可以忽略');
    o.store.finish(task.id, 'done');
    o.runtime.pump();
    return { ok: true };
  });
  app.post<{ Params: { id: string }; Body: { action: string } }>(
    '/api/deliveries/:id',
    (request) => {
      // 直接查行：issues() 有 100 行上限，更老的会被误报"不存在"。
      const action = String(request.body?.action);
      const delivery = o.store.deliveryById(request.params.id);
      if (
        !['confirmed', 'retry', 'skip'].includes(action) ||
        !delivery ||
        !['failed', 'uncertain'].includes(delivery.status)
      )
        throw new Error('待处理的发送记录不存在或状态已变化');
      const status = action === 'confirmed' ? 'sent' : action === 'retry' ? 'pending' : 'cancelled';
      if (!o.store.markDelivery(request.params.id, status))
        throw new Error('发送记录状态已变化，请刷新后重试');
      o.runtime.pump();
      return { ok: true };
    },
  );

  // ---------- 表情 ----------

  app.get('/api/stickers', () => {
    // custom 让前端给出正确的动词：上传可删，内置只能停用。
    const custom = new Set(
      o.store.getSetting<{ slug: string }[]>('stickers:custom', []).map((s) => s.slug),
    );
    return o.stickers.list(true).map(({ file, ...s }) => ({ ...s, custom: custom.has(s.slug) }));
  });
  app.get<{ Params: { slug: string } }>('/api/stickers/:slug/image', (request, reply) => {
    const bytes = o.stickers.bytes(request.params.slug);
    return reply
      .type(sniffMediaMime(bytes) ?? 'application/octet-stream')
      .header('cache-control', 'public, max-age=86400')
      .send(bytes);
  });
  app.post<{ Body: { slug: string; description: string; tags: string[]; base64: string } }>(
    '/api/stickers',
    (request) => {
      const b = request.body;
      if (!b || !Array.isArray(b.tags) || b.tags.some((t) => typeof t !== 'string'))
        throw new Error('表情标签无效');
      o.stickers.add({
        slug: text(b.slug, 40),
        description: text(b.description, 200),
        tags: b.tags,
        base64: text(b.base64, 4 * 1024 * 1024),
      });
      return { ok: true };
    },
  );
  app.delete<{ Params: { slug: string } }>('/api/stickers/:slug', (request) => {
    // DELETE 一直是"停用这个"，卡片按钮也这么写——必须可逆。删除上传
    // 文件是不可逆动作，单独一条路由，两者不会被文案混淆。
    o.stickers.disable(request.params.slug);
    return { ok: true };
  });
  app.delete<{ Params: { slug: string } }>('/api/stickers/:slug/file', (request) => {
    o.stickers.remove(request.params.slug);
    return { ok: true };
  });
  app.post<{ Params: { slug: string } }>('/api/stickers/:slug/enable', (request) => {
    o.stickers.enable(request.params.slug);
    return { ok: true };
  });
  return app;
}
