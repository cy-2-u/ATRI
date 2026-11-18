import test from 'node:test';
import assert from 'node:assert/strict';
import { Journal } from '../src/storage/journal.js';
import { Settings } from '../src/settings.js';
import { ModelRouter } from '../src/model/router.js';
import { Mind } from '../src/domain/mind.js';
import { Runtime } from '../src/runtime/runtime.js';
import { createServer } from '../src/server.js';
import { Wall } from '../src/wall.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function fixture() {
  const journal = new Journal(':memory:');
  const wallDir = mkdtempSync(join(tmpdir(), 'atri-server-wall-'));
  const settings = new Settings(journal, { LLM_API_KEY: 'primary-secret' });
  const router = new ModelRouter(
    () => settings.routes(),
    async () => {
      throw new Error('not called');
    },
  );
  const runtime = new Runtime(journal, new Mind(router, journal), {
    persona: () => '',
    material: () => ({}),
    send: async () => 'failed',
    nextBeat: () => undefined,
    onError: () => {},
    timeoutMs: 1000,
    debounceMs: 0,
    concurrency: 1,
    pacing: false,
    stickerSlugs: () => new Set(),
    vision: () => false,
    readFile: () => Promise.resolve(undefined),
  });
  const bridge = { status: () => ({ status: '未登录' }), contacts: () => [] } as never;
  const stickers = { list: () => [] } as never;
  const app = createServer({
    password: 'test-password-123',
    settings,
    journal,
    router,
    runtime,
    bridge,
    stickers,
    webConfigured: () => false,
    channelProbe: async () => ({ ok: true, latencyMs: 1, model: 'm', format: 'openai' }),
    systemProbe: async () => ({ ok: true, reply: 'SYSTEMOK' }),
    embeddingProbe: async () => ({ ok: true, latencyMs: 1, dims: 3, model: 'm' }),
    staticRoot: '.',
    assetsRoot: '.',
    customStickersRoot: '.',
    wall: new Wall(journal.db, wallDir),
  });
  await app.ready();
  const login = await app.inject({
    method: 'POST',
    url: '/api/login',
    payload: { password: 'test-password-123' },
  });
  const cookie = String(login.headers['set-cookie']).split(';')[0]!;
  return {
    app,
    cookie,
    journal,
    async close() {
      await app.close();
      await runtime.stop();
      journal.close();
      rmSync(wallDir, { recursive: true, force: true });
    },
  };
}

test('管理 API 鉴权、同源保护和主备密钥脱敏', async () => {
  const env = await fixture();
  try {
    assert.equal((await env.app.inject('/api/status')).statusCode, 401);
    const rejected = await env.app.inject({
      method: 'PUT',
      url: '/api/config',
      headers: { cookie: env.cookie, origin: 'https://untrusted.example' },
      payload: { closeness: 80 },
    });
    assert.equal(rejected.statusCode, 403);
    const saved = await env.app.inject({
      method: 'PUT',
      url: '/api/config',
      headers: { cookie: env.cookie },
      payload: { fallback: { model: 'backup', apiKey: 'backup-secret' } },
    });
    assert.equal(saved.statusCode, 200);
    assert.ok(!saved.body.includes('primary-secret'));
    assert.ok(!saved.body.includes('backup-secret'));
    assert.equal(saved.json().fallback.hasApiKey, true);
    const invalid = await env.app.inject({
      method: 'PUT',
      url: '/api/config',
      headers: { cookie: env.cookie },
      payload: { concurrency: 0 },
    });
    assert.equal(invalid.statusCode, 400);
  } finally {
    await env.close();
  }
});

test('留言墙免登录：页面/列表/发布公开可达，管理 API 仍需登录', async () => {
  const env = await fixture();
  try {
    const page = await env.app.inject('/wall');
    assert.equal(page.statusCode, 200);
    assert.ok(page.body.includes('wall.css'));
    // 未登录直接发布与读取。
    const posted = await env.app.inject({
      method: 'POST',
      url: '/api/wall',
      payload: { text: '验收官第一条留言' },
    });
    assert.equal(posted.statusCode, 200);
    assert.equal(posted.json().from, 'him');
    const list = await env.app.inject('/api/wall');
    assert.equal(list.statusCode, 200);
    assert.equal(list.json().length, 1);
    assert.equal(list.json()[0]!.text, '验收官第一条留言');
    // 空文本与超长拒。
    assert.equal(
      (await env.app.inject({ method: 'POST', url: '/api/wall', payload: { text: '  ' } }))
        .statusCode,
      400,
    );
    // 管理 API 依然要登录（wall 放行不能漏成全局放行）。
    assert.equal((await env.app.inject('/api/status')).statusCode, 401);
    // 图片名不存在的 404。
    assert.equal((await env.app.inject('/api/wall/images/nope.png')).statusCode, 404);
    assert.equal((await env.app.inject('/api/wall/images/..%2Fsecret')).statusCode, 404);
  } finally {
    await env.close();
  }
});

test('人工确认未知送达走统一提交路径，重复确认返回冲突', async () => {
  const env = await fixture();
  try {
    env.journal.receive('peer', 'one', 'hello');
    const turn = env.journal.begin('peer', 'chat');
    env.journal.draft(turn, [{ type: 'text', text: 'hi' }]);
    const envelope = env.journal.pending('peer')[0]!;
    env.journal.startDelivery(envelope.id);
    env.journal.delivery(envelope.id, 'unknown');
    const request = {
      method: 'POST' as const,
      url: `/api/deliveries/${envelope.id}/resolve`,
      headers: { cookie: env.cookie },
      payload: { status: 'sent' },
    };
    assert.equal((await env.app.inject(request)).statusCode, 200);
    assert.equal(env.journal.events('peer').at(-1)!.kind, 'said');
    assert.equal((await env.app.inject(request)).statusCode, 409);
  } finally {
    await env.close();
  }
});

test('渠道体检端点需要登录，命中注入的探针', async () => {
  const env = await fixture();
  try {
    assert.equal((await env.app.inject({ method: 'POST', url: '/api/test-llm' })).statusCode, 401);
    const llm = await env.app.inject({
      method: 'POST',
      url: '/api/test-llm',
      headers: { cookie: env.cookie },
    });
    assert.equal(llm.statusCode, 200);
    assert.deepEqual(llm.json(), { ok: true, latencyMs: 1, model: 'm', format: 'openai' });
    const system = await env.app.inject({
      method: 'POST',
      url: '/api/test-system',
      headers: { cookie: env.cookie },
    });
    assert.deepEqual(system.json(), { ok: true, reply: 'SYSTEMOK' });
    const embedding = await env.app.inject({
      method: 'POST',
      url: '/api/test-embedding',
      headers: { cookie: env.cookie },
    });
    assert.deepEqual(embedding.json(), { ok: true, latencyMs: 1, dims: 3, model: 'm' });
  } finally {
    await env.close();
  }
});
