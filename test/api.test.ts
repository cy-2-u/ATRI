import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { TestContext } from 'node:test';
import { Store } from '../src/db/index.js';
import { Settings } from '../src/api/config.js';
import { Stickers } from '../src/api/stickers.js';
import { createServer } from '../src/api/server.js';
import type { WeChatBridge } from '../src/api/wechat.js';
import type { Runtime } from '../src/core/index.js';
import { projectRoot, cleanup } from './helpers.js';

/** HTTP 层：鉴权、配置校验与持久化、人格、表情、联系人、任务动作、备份。 */

interface ApiResponse {
  statusCode: number;
  body: string;
  json: () => any;
  headers: Record<string, string | string[] | undefined>;
}

function apiFixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'atri-api-'));
  cleanup(t, () => {
    try {
      rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    } catch {
      /* Windows 句柄延迟释放时留给系统临时目录清理 */
    }
  });
  const store = new Store(join(directory, 'atri.db'));
  cleanup(t, () => store.close());
  // DATA_DIR 指向临时目录：Settings 构造时会建数据目录并生成管理密码，
  // 不指过去的话每次跑测试都会在项目根重建 data/ 残留。
  const settings = new Settings(store, projectRoot, { ...process.env, DATA_DIR: directory });
  const stickers = new Stickers(projectRoot, directory, store);
  const bridge = {
    status: () => ({ status: '未登录' }),
    login: () => ({ status: '未登录' }),
    logout: () => undefined,
    stop: () => undefined,
    send: async () => {},
  } as unknown as WeChatBridge;
  const runtime = { pump: () => {}, queueDiary: () => undefined } as unknown as Runtime;
  const app = createServer({ store, settings, stickers, bridge, runtime });
  const password = settings.adminPassword;
  const inject = (
    method: string,
    url: string,
    payload?: unknown,
    extra: Record<string, unknown> = {},
  ): Promise<ApiResponse> =>
    app.inject({
      method,
      url,
      payload: payload as Record<string, unknown> | undefined,
      ...extra,
    } as never) as unknown as Promise<ApiResponse>;
  const call = (path: string, method = 'GET', body?: unknown) =>
    inject(method, path, body, {
      headers: { authorization: 'Bearer ' + password },
    });
  return { store, settings, stickers, call, inject, password };
}

test('鉴权：未登录 401、错误密码 401、Cookie 会话可用、健康检查公开', async (t) => {
  const f = apiFixture(t);
  assert.equal((await f.inject('GET', '/api/config')).statusCode, 401);
  assert.equal(
    (await f.inject('POST', '/api/login', { password: 'wrong-password-xxx' })).statusCode,
    401,
  );
  const health = await f.inject('GET', '/healthz');
  assert.equal(health.statusCode, 200);
  const ok = await f.inject('POST', '/api/login', { password: f.password });
  assert.equal(ok.statusCode, 200);
  assert.match(String(ok.headers['set-cookie']), /HttpOnly/);
  const cookie = /atri_session=([^;]+)/.exec(String(ok.headers['set-cookie']))?.[1]!;
  const withCookie = await f.inject('GET', '/api/config', undefined, {
    cookies: { atri_session: cookie },
  });
  assert.equal(withCookie.statusCode, 200);
});

test('配置校验：预算和、温度上限、URL 形状、跨来源写保护', async (t) => {
  const f = apiFixture(t);
  const put = (body: unknown) => f.call('/api/config', 'PUT', body);
  assert.equal(
    (
      await put({
        contextWindowTokens: 8192,
        inputBudgetTokens: 8000,
        maxOutputTokens: 2000,
      })
    ).statusCode,
    400,
    '预算和超窗口',
  );
  assert.equal((await put({ temperature: 3 })).statusCode, 400);
  assert.equal((await put({ baseUrl: 'file:///etc' })).statusCode, 400);
  assert.equal((await put({ maxConcurrentPeers: 99 })).statusCode, 400);
  const saved = await put({
    contextWindowTokens: 65536,
    inputBudgetTokens: 24000,
    maxOutputTokens: 3000,
    temperature: 0.7,
    sandboxEnabled: true,
  });
  assert.equal(saved.statusCode, 200);
  const body = saved.json();
  assert.equal(body.temperature, 0.7);
  assert.equal(body.hasApiKey, false, '密钥不回显');
  assert.equal(body.embeddingActive, false, '向量开关与实际生效分开');
  const csrf = await f.inject(
    'PUT',
    '/api/config',
    {},
    { headers: { authorization: 'Bearer ' + f.password, origin: 'https://evil.example' } },
  );
  assert.equal(csrf.statusCode, 403);
});

test('人格：CRUD、默认、按联系人绑定、预设带正文', async (t) => {
  const f = apiFixture(t);
  const created = await f.call('/api/personas', 'POST', {
    name: '测试人格',
    content: '你是一个测试。',
  });
  assert.equal(created.json().name, '测试人格');
  const id = created.json().id;
  const presets = await f.call('/api/persona-presets');
  assert.ok(presets.json().length >= 3);
  assert.ok(
    presets.json().every((p: { content: string }) => p.content.length > 20),
    '预设带可用正文',
  );
  await f.call(`/api/personas/${id}`, 'PUT', { greeting: '' });
  assert.equal((await f.call('/api/personas')).json().list.length, 2);
  f.store.ensurePeer('p9', 'preview', '同学', '', true);
  await f.call('/api/peers/p9/persona', 'PUT', { personaId: id });
  assert.equal((await f.call('/api/personas')).json().bindings['p9'], id);
  assert.equal(f.settings.personaGreetingFor('p9'), '');
  assert.equal((await f.call(`/api/personas/${id}/default`, 'PUT')).statusCode, 200);
  assert.equal((await f.call(`/api/personas/${id}`, 'DELETE')).statusCode, 400, '默认人格不能删');
});

test('表情：列表含内置、上传校验、停用与启用、上传可删', async (t) => {
  const f = apiFixture(t);
  const list = await f.call('/api/stickers');
  const slugs = list.json().map((s: { slug: string }) => s.slug);
  assert.ok(slugs.includes('happy'), '内置表情在场');
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').toString('base64');
  assert.equal(
    (
      await f.call('/api/stickers', 'POST', {
        slug: 'mine',
        description: '我的表情',
        tags: ['标签'],
        base64: png,
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (
      await f.call('/api/stickers', 'POST', {
        slug: 'bad!',
        description: 'x',
        tags: [],
        base64: png,
      })
    ).statusCode,
    400,
    '非法 slug',
  );
  assert.equal((await f.call('/api/stickers/mine', 'DELETE')).statusCode, 200, '停用可逆');
  const afterDisable = (await f.call('/api/stickers')).json();
  const mineRow = afterDisable.find((s: { slug: string }) => s.slug === 'mine');
  assert.equal(mineRow.disabled, true, '停用后标记为 disabled（列表含全部，前端过滤）');
  assert.equal((await f.call('/api/stickers/mine/enable', 'POST')).statusCode, 200);
  assert.equal((await f.call('/api/stickers/mine/file', 'DELETE')).statusCode, 200, '上传可删');
  assert.equal((await f.call('/api/stickers/happy/image')).statusCode, 200);
});

test('联系人：批准/删除/试聊预览保护', async (t) => {
  const f = apiFixture(t);
  f.store.ensurePeer('wechat:w1', 'wechat', 'w1', 'ctx', false);
  assert.equal((await f.call('/api/peers/wechat%3Aw1', 'PUT', { approved: true })).statusCode, 200);
  assert.equal(f.store.peer('wechat:w1')!.approved, 1);
  assert.equal(
    (await f.call('/api/peers/preview%3Adefault', 'DELETE')).statusCode,
    400,
    '试聊联系人不可删',
  );
  assert.equal((await f.call('/api/peers/nope', 'DELETE')).statusCode, 400, '删除不静默');
  const gone = await f.call('/api/peers/wechat%3Aw1', 'DELETE');
  assert.equal(gone.statusCode, 200);
  assert.equal(f.store.peer('wechat:w1'), undefined);
});

test('任务与投递动作：只有失败可重试/忽略，投递动作校验', async (t) => {
  const f = apiFixture(t);
  f.store.ensurePeer('preview:default', 'preview', '本地试聊', '', true);
  const task = f.store.enqueue('preview:default', 'notes', 'n:1', { through: 1 });
  assert.equal(
    (await f.call(`/api/tasks/${task}/retry`, 'POST')).statusCode,
    400,
    '排队中不可重试',
  );
  f.store.finish(task, 'failed', 'x');
  assert.equal((await f.call(`/api/tasks/${task}/retry`, 'POST')).statusCode, 200);
  f.store.finish(task, 'failed', 'x');
  assert.equal((await f.call(`/api/tasks/${task}/dismiss`, 'POST')).statusCode, 200);
  assert.equal(f.store.taskById(task)!.state, 'done');
  assert.equal(
    (await f.call('/api/deliveries/none', 'POST', { action: 'confirmed' })).statusCode,
    400,
  );
  assert.equal((await f.call('/api/deliveries/x', 'POST', { action: 'bad' })).statusCode, 400);
});

test('备份与沙箱端点', async (t) => {
  const f = apiFixture(t);
  const result = await f.call('/api/backup', 'POST');
  assert.equal(result.statusCode, 200);
  assert.equal(result.json().messages, 0);
  assert.ok(result.json().directory.length > 0);
  const sandbox = await f.call('/api/sandbox');
  assert.equal(sandbox.json().enabled, false);
  assert.equal((await f.call('/api/sandbox/clear', 'POST')).statusCode, 400);
});
