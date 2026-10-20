import Fastify from 'fastify';
import QRCode from 'qrcode';
import { createHash, randomBytes, timingSafeEqual, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Store } from '@atri/db';
import { createBackup } from '@atri/db';
import { EmbeddingClient, HttpModel } from '@atri/llm';
import type { Runtime } from '@atri/core';
import { sniffMediaMime } from '@atri/ilink';
import type { Settings } from './config.js';
import { PERSONA_PRESETS } from './config.js';
import type { Stickers } from './stickers.js';
import type { Sandbox } from './sandbox.js';
import type { WeChatBridge } from './wechat.js';

export interface ServerOptions {
  store: Store;
  settings: Settings;
  runtime: Runtime;
  bridge: WeChatBridge;
  stickers: Stickers;
  sandbox?: Sandbox;
}
const digest = (v: string) => createHash('sha256').update(v).digest();
/** Short stable digest for building task dedupe keys. */
const hashGreeting = (v: string) => createHash('sha256').update(v).digest('hex').slice(0, 12);
const text = (v: unknown, max = 12000) => {
  if (typeof v !== 'string' || !v.trim() || v.length > max)
    throw new Error(`文本需要 1–${max} 个字符`);
  return v.trim();
};
/** Same as text() but accepts '' — for optional fields where clearing the value
 *  is a real intention ("no opening line"). */
const optionalText = (v: unknown, max = 12000) => {
  if (typeof v !== 'string' || v.length > max) throw new Error(`文本需要在 ${max} 个字符以内`);
  return v.trim();
};
export function createServer(o: ServerOptions) {
  const app = Fastify({ bodyLimit: 5 * 1024 * 1024, logger: false });
  const sessions = new Map<string, number>(),
    failures = new Map<string, { count: number; until: number }>();
  const publicDir = join(o.settings.root, 'apps', 'api', 'public');
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
    const bearer = request.headers.authorization?.replace(/^Bearer /, '') ?? '';
    const token = /\batri_session=([^;]+)/.exec(request.headers.cookie ?? '')?.[1];
    const validBearer = !!bearer && timingSafeEqual(digest(bearer), credentials);
    if (!validBearer && (!token || (sessions.get(token) ?? 0) < Date.now()))
      return reply.code(401).send({ error: '请先登录管理页' });
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
    // 业务校验抛的是普通 Error，约定回 400；框架自身错误（解析失败、404）
    // 自带 statusCode 会原样透传，不会被这里覆盖。
    reply
      .code(e.statusCode && e.statusCode >= 400 && e.statusCode < 600 ? e.statusCode : 400)
      .send({ error: e.message.slice(0, 300) });
  });
  app.get('/healthz', () => ({ ok: true }));
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
      ip = request.ip,
      attempt = failures.get(ip);
    if (attempt && attempt.until > now && attempt.count >= 8)
      return reply.code(429).send({ error: '尝试次数较多，请一分钟后再试' });
    if (
      typeof request.body?.password !== 'string' ||
      !timingSafeEqual(digest(request.body.password), credentials)
    ) {
      failures.set(ip, {
        count: attempt && attempt.until > now ? attempt.count + 1 : 1,
        until: now + 60000,
      });
      if (failures.size > 1000)
        for (const [key, value] of failures) if (value.until < now) failures.delete(key);
      return reply.code(401).send({ error: '管理密码不正确' });
    }
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
      // Read-only view of "how is she doing": mood, next proactive window,
      // loops waiting. Previously this data was invisible in the admin UI.
      // `vectors` used to be computed here with a GROUP BY over the whole
      // embeddings table on every poll (the UI polls /api/status every 2.5 s)
      // and was never rendered; the vector count lives on /api/sandbox-adjacent
      // debug endpoints instead.
      states: o.store.peers().map((peer) => {
        const mood = o.store.mood(peer.id);
        const dueLoops = o.store.dueOpenLoops(peer.id, Date.now());
        return {
          peerId: peer.id,
          address: peer.address,
          approved: !!peer.approved,
          mood: mood.at ? mood : undefined,
          dueLoops: dueLoops.length,
          // Drives "她多久没来了" in the UI, which is the one field here the
          // operator actually needs to judge whether a peer is still alive.
          lastUserAt: peer.last_user_at,
          lastProactiveAt: peer.last_proactive_at,
        };
      }),
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
    o.settings.update(request.body),
  );
  // Sandbox status for the settings page: enabled flag, what the directory
  // currently holds, and what isolation this host actually provides.
  app.get('/api/sandbox', async () => {
    const sandbox = o.sandbox;
    return {
      enabled: Boolean(sandbox?.enabled),
      root: sandbox ? sandbox.root : '',
      usage: sandbox ? sandbox.usage() : { files: 0, bytes: 0 },
      sizeLimitBytes: sandbox ? sandbox.sizeLimit : 0,
      memoryLimitMb: o.settings.config().sandboxMemoryMb,
      isolation: sandbox ? await sandbox.isolationInfo() : undefined,
    };
  });
  app.post('/api/sandbox/clear', () => {
    if (!o.sandbox) throw new Error('沙箱未配置');
    o.sandbox.clear();
    return { ok: true };
  });
  // The single-persona endpoints (GET/PUT /api/persona) were superseded by
  // /api/personas when per-peer personas landed and no client has called them
  // since; they are gone rather than kept as a second write path into the same
  // setting.
  app.get('/api/personas', () => {
    const { list, defaultId } = o.settings.personaList();
    const bindings = Object.fromEntries(o.store.peers().map((p) => [p.id, p.persona_id ?? '']));
    return { list, defaultId, bindings };
  });
  // `content` is included on purpose: the create form builds the new persona
  // straight from the chosen preset, and without the text every template
  // silently produced the placeholder.
  app.get('/api/persona-presets', () => PERSONA_PRESETS);
  app.post<{ Body: { name: string; content: string } }>('/api/personas', (request) =>
    o.settings.personaCreate(text(request.body.name, 40), text(request.body.content)),
  );
  app.put<{ Params: { id: string }; Body: { name?: string; content?: string; greeting?: string } }>(
    '/api/personas/:id',
    (request) => {
      const input = request.body ?? {};
      if (input.name === undefined && input.content === undefined && input.greeting === undefined)
        throw new Error('没有需要保存的修改');
      return o.settings.personaUpdate(request.params.id, {
        ...(input.name !== undefined ? { name: text(input.name, 40) } : {}),
        ...(input.content !== undefined ? { content: text(input.content) } : {}),
        // Empty is a meaningful value here — "no opening line" — so this uses
        // the permissive sanitiser rather than text(), which rejects ''.
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
      if (typeof request.body.personaId !== 'string') throw new Error('人格选择无效');
      return o.settings.setPeerPersona(request.params.id, request.body.personaId);
    },
  );
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
    const body = (await response.json().catch(() => null)) as {
      data?: { id?: unknown }[];
      error?: { message?: unknown };
    } | null;
    if (!response.ok)
      throw new Error(
        `拉取模型列表失败（HTTP ${response.status}）：${
          (body?.error?.message as string) || (await response.text().catch(() => '')).slice(0, 200)
        }`,
      );
    const ids = [...new Set((body?.data ?? []).map((m) => String(m?.id ?? '')).filter(Boolean))];
    return { models: ids.sort((a, b) => a.localeCompare(b)) };
  });
  app.post('/api/test-llm', async () => {
    const c = o.settings.config();
    if (!c.apiKey || !c.model) throw new Error('请先保存模型名称和 API 密钥');
    // Use the same request builder as every real turn. The old endpoint
    // hand-rolled three providers here, so a protocol fix could land in
    // HttpModel and leave the connection test passing against different code.
    const model = new HttpModel(o.settings.model());
    const started = Date.now();
    await model.complete([{ role: 'user', content: 'hi' }], [], {
      maxTokens: 1,
      signal: AbortSignal.timeout(Math.min(c.requestTimeoutSeconds, 60) * 1000),
    });
    return {
      ok: true,
      latencyMs: Date.now() - started,
      model: c.model,
      format: c.format,
    };
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
  app.get('/api/peers', () =>
    // ensurePeer once at startup instead of on every GET: a read endpoint that
    // writes on each call also gave DNS-rebinding probes a free DB write.
    o.store.peers().map(({ context_token, ...peer }) => peer),
  );
  app.put<{ Params: { id: string }; Body: { approved: boolean } }>('/api/peers/:id', (request) => {
    if (typeof request.body.approved !== 'boolean' || !o.store.peer(request.params.id))
      throw new Error('联系人或设置无效');
    const peer = o.store.peer(request.params.id)!;
    o.store.approve(request.params.id, request.body.approved);
    // First approval of a real contact: queue a one-shot greeting task. An empty
    // greeting means the operator asked for no opener, so nothing is enqueued.
    // The version-qualified dedupe key lets a later re-approval send the updated
    // greeting: the previous key's task is already `done`, and enqueue only
    // revives failed/superseded/interrupted rows, so reusing "greeting" froze
    // every new opener behind the finished task.
    if (request.body.approved && !peer.approved && peer.channel === 'wechat') {
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
  // Removes the peer and every record attached to them. Deliberately not
  // idempotent-by-silence: a missing peer is an error, because the operator
  // should learn the row was already gone rather than believe they deleted it.
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
      o.store.correctMemory(
        request.params.peer,
        request.params.id,
        text(request.body.content, 800),
      );
      return { ok: true };
    },
  );
  app.put<{ Params: { peer: string; id: string }; Body: { pinned: boolean } }>(
    '/api/peers/:peer/memories/:id/pinned',
    (request) => {
      if (typeof request.body.pinned !== 'boolean') throw new Error('置顶状态无效');
      o.store.setMemoryPinned(request.params.peer, request.params.id, request.body.pinned);
      return { ok: true };
    },
  );
  app.get<{ Params: { id: string } }>('/api/peers/:id/loops', (request) => {
    const peer = request.params.id;
    // The journal tab is the one place an operator can see both kinds of
    // unfinished business. Expiring here keeps "expired" honest even if no
    // message arrived in the last two weeks.
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
  // 试聊 uses the preview peer; created once at startup so GET /api/peers
  // never needs to write, and re-ensured here (cheap upsert) before a chat.
  app.post<{ Body: { content: string; eventId?: string } }>('/api/chat', (request, reply) => {
    const peer = o.store.ensurePeer('preview:default', 'preview', '本地试聊', '', true);
    const event = o.runtime.accept(
      peer.id,
      request.body.eventId ? text(request.body.eventId, 100) : randomUUID(),
      text(request.body.content),
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
    // Without this a task that exhausted its retries sat in issues() until
    // pruneTasks aged it out, which kept the admin bell permanently non-zero.
    // An operator who has read the error and decided it needs no action must be
    // able to clear it — otherwise they learn to ignore the bell, and a real
    // delivery failure scrolls past unnoticed.
    const task = o.store.taskById(request.params.id);
    if (!task || task.state !== 'failed') throw new Error('只有失败任务可以忽略');
    o.store.finish(task.id, 'done');
    o.runtime.pump();
    return { ok: true };
  });
  app.post<{ Params: { id: string }; Body: { action: string } }>(
    '/api/deliveries/:id',
    (request) => {
      // Look the delivery up directly: issues() caps at 100 rows, so anything
      // older was reported as "不存在" exactly when it was blocking a peer.
      if (
        !['confirmed', 'retry', 'skip'].includes(String(request.body?.action)) ||
        !o.store.deliveryById(request.params.id)
      )
        throw new Error('待处理的发送记录不存在');
      const status =
        request.body.action === 'confirmed'
          ? 'sent'
          : request.body.action === 'retry'
            ? 'pending'
            : 'cancelled';
      o.store.markDelivery(request.params.id, status);
      o.runtime.pump();
      return { ok: true };
    },
  );
  app.get('/api/stickers', () => {
    // `custom` lets the UI offer the right verb: an upload can be deleted, a
    // bundled sticker can only be switched off.
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
    // DELETE has always meant "stop using this one", and the card's button says
    // 停用 — so it must stay reversible. Deleting an upload (row + file) is a
    // separate, irreversible action with its own route so the two can never be
    // confused by a label mismatch.
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
