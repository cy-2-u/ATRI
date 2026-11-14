import test from 'node:test';
import assert from 'node:assert/strict';
import { Journal } from '../src/storage/journal.js';
import { Settings } from '../src/settings.js';
import { ModelRouter } from '../src/model/router.js';
import { Mind } from '../src/domain/mind.js';
import { Runtime } from '../src/runtime/runtime.js';
import { createServer } from '../src/server.js';

async function fixture() {
  const journal = new Journal(':memory:');
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
    staticRoot: '.',
    assetsRoot: '.',
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
