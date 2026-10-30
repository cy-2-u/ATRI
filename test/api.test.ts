import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TestContext } from 'node:test';

/** fastify inject 的 set-cookie 可能是 string 或 string[]，统一取值。 */
const cookieOf = (headers: unknown): string => {
  const raw = (headers as Record<string, unknown>)['set-cookie'];
  const value = Array.isArray(raw) ? raw[0] : (raw as string);
  return /\batri_session=([^;]+)/.exec(value ?? '')![1];
};
import { Store } from '../src/db/index.js';
import { Runtime } from '../src/core/index.js';
import { Settings } from '../src/api/config.js';
import { Stickers } from '../src/api/stickers.js';
import { createServer } from '../src/api/server.js';
import { cleanup, temporary, FakeModel, completion } from './helpers.js';
import type { WebTools } from '../src/core/web.js';

/** 管理 API：鉴权、配置校验、联系人、她的状态（/api/self）。 */

function apiFixture(t: TestContext) {
  const directory = temporary(t);
  mkdirSync(join(directory, 'app', 'public'), { recursive: true });
  mkdirSync(join(directory, 'app', 'assets', 'stickers'), { recursive: true });
  writeFileSync(join(directory, 'app', 'public', 'index.html'), '<html>atri</html>');
  writeFileSync(join(directory, 'app', 'public', 'app.js'), '// js');
  writeFileSync(join(directory, 'app', 'public', 'app.css'), '/* css */');
  // 表情目录为空：agent 的预算规划会调用 stickers.list()，缺文件直接失败。
  writeFileSync(join(directory, 'app', 'assets', 'stickers', 'catalog.json'), '[]');
  const env = {
    ADMIN_PASSWORD: 'test-admin-password-123',
    HOST: '127.0.0.1',
    PORT: '0',
    DATA_DIR: directory,
  };
  const store = new Store(join(directory, 'atri.db'));
  const settings = new Settings(store, join(directory, 'app'), env as NodeJS.ProcessEnv);
  const stickers = new Stickers(join(directory, 'app'), directory, store);
  const web: WebTools = {
    search: async () => {
      throw new Error('测试不联网');
    },
    open: async () => {
      throw new Error('测试不联网');
    },
  };
  const model = new FakeModel(() => completion({ messages: ['嗯。'], memoryUpdates: [] }));
  const runtime = new Runtime({
    store,
    model: () => model,
    prompt: (name) => {
      if (name === 'persona') return '你是亚托莉。';
      return `${name} 规则`;
    },
    stickers: () => stickers.list(),
    web,
    config: () => settings.runtime(),
    timeZone: () => settings.config().timeZone,
    contextTokens: () => settings.runtime().contextTokens,
    turnTimeoutMs: () => settings.runtime().turnTimeoutMs,
    transport: { send: async () => {} },
  });
  const app = createServer({ store, settings, stickers, bridge: {} as never, runtime });
  // 泵与调度定时器必须真的跑起来：入站任务带 debounce，没有定时泵
  // 就没人把它从队列里取出来。
  runtime.start();
  cleanup(t, async () => {
    await app.close();
    await runtime.stop();
    store.close();
  });
  const call = async (path: string, method = 'GET', body?: unknown) => {
    const response = await app.inject({
      method: method as 'GET',
      url: path,
      ...(body ? { payload: body } : {}),
    });
    let json: unknown;
    try {
      json = response.json();
    } catch {
      json = undefined;
    }
    return { status: response.statusCode, body: json };
  };
  return { store, settings, runtime, app, call, directory };
}

test('鉴权：未登录 401，登录后放行', async (t) => {
  const f = apiFixture(t);
  assert.equal((await f.call('/api/config')).status, 401);
  const login = await f.app.inject({
    method: 'POST',
    url: '/api/login',
    payload: { password: 'test-admin-password-123' },
  });
  assert.equal(login.statusCode, 200);
  const token = cookieOf(login.headers);
  const ok = await f.app.inject({
    method: 'GET',
    url: '/api/config',
    headers: { cookie: `atri_session=${token}` },
  });
  assert.equal(ok.statusCode, 200);
  const bad = await f.app.inject({
    method: 'POST',
    url: '/api/login',
    payload: { password: 'wrong-password-0000' },
  });
  assert.equal(bad.statusCode, 401);
});

test('配置校验：黏人度越界 400，合法值保存', async (t) => {
  const f = apiFixture(t);
  const asAdmin = async (path: string, method: string, body?: unknown) => {
    const login = await f.app.inject({
      method: 'POST',
      url: '/api/login',
      payload: { password: 'test-admin-password-123' },
    });
    const token = cookieOf(login.headers);
    return f.app.inject({
      method: method as 'GET',
      url: path,
      headers: { cookie: `atri_session=${token}` },
      ...(body ? { payload: body } : {}),
    });
  };
  const bad = await asAdmin('/api/config', 'PUT', { clinginess: 500 });
  assert.equal(bad.statusCode, 400);
  const good = await asAdmin('/api/config', 'PUT', {
    clinginess: 80,
    sleepStart: 0,
    sleepEnd: 6,
    proactiveEnabled: true,
  });
  assert.equal(good.statusCode, 200);
  const saved = await asAdmin('/api/config', 'GET');
  assert.equal((saved.json() as { clinginess: number }).clinginess, 80);
  assert.equal((saved.json() as { sleepStart: number }).sleepStart, 0);
});

test('她的状态：/api/self 返回 self、生活流水与想法', async (t) => {
  const f = apiFixture(t);
  const now = Date.now();
  f.store.ensurePeer('p1', 'wechat', '同学', 'tok', true, now);
  f.store.updateSelf({ activity: '整理表情包', activitySince: now, social: 0.6 }, now);
  f.store.logLife('did', '把表情包按颜色分类', '分类.json', now);
  f.store.upsertInitiative(
    'p1',
    { topicKey: 't1', kind: 'muse', meaning: '想随口说一句', sources: [] },
    now,
  );
  const login = await f.app.inject({
    method: 'POST',
    url: '/api/login',
    payload: { password: 'test-admin-password-123' },
  });
  const token = cookieOf(login.headers);
  const response = await f.app.inject({
    method: 'GET',
    url: '/api/self',
    headers: { cookie: `atri_session=${token}` },
  });
  assert.equal(response.statusCode, 200);
  const body = response.json() as {
    self: { activity: string; social: number };
    life: { text: string }[];
    thoughts: { meaning: string }[];
  };
  assert.equal(body.self.activity, '整理表情包');
  assert.equal(body.self.social, 0.6);
  assert.equal(body.life[0]!.text, '把表情包按颜色分类');
  assert.equal(body.thoughts[0]!.meaning, '想随口说一句');
});

test('试聊接口：入队返回 202，任务可查询', async (t) => {
  const f = apiFixture(t);
  const login = await f.app.inject({
    method: 'POST',
    url: '/api/login',
    payload: { password: 'test-admin-password-123' },
  });
  const token = cookieOf(login.headers);
  const sent = await f.app.inject({
    method: 'POST',
    url: '/api/chat',
    headers: { cookie: `atri_session=${token}` },
    payload: { content: '在吗', eventId: 'api-test-1' },
  });
  assert.equal(sent.statusCode, 202);
  const { taskId } = sent.json() as { taskId: string };
  assert.ok(taskId);
  const deadline = Date.now() + 10000;
  let state = '';
  while (Date.now() < deadline) {
    const check = await f.app.inject({
      method: 'GET',
      url: `/api/tasks/${taskId}`,
      headers: { cookie: `atri_session=${token}` },
    });
    state = (check.json() as { state: string }).state;
    if (state === 'done' || state === 'ready') break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(['done', 'ready'].includes(state), `任务完成，实际 ${state}`);
});
