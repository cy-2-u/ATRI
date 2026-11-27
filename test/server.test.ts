import test from 'node:test';
import assert from 'node:assert/strict';
import { Journal } from '../src/storage/journal.js';
import { Settings } from '../src/settings.js';
import { ModelRouter } from '../src/model/router.js';
import { Mind } from '../src/domain/mind.js';
import { Runtime } from '../src/runtime/runtime.js';
import { createServer } from '../src/server.js';
import { Wall } from '../src/wall.js';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
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
    channelProbe: async () => ({
      ok: true,
      latencyMs: 1,
      model: 'm',
      format: 'openai',
      persona: { ok: true, reply: 'SYSTEMOK' },
    }),
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
  const wall = new Wall(journal.db, wallDir);
  return {
    app,
    cookie,
    journal,
    wallDir,
    wall,
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

test('留言墙：看对游客开放，写只认登录 cookie，管理 API 仍需登录', async () => {
  const env = await fixture();
  try {
    // 游客：页面可看（无表单、有提示），列表可读，写被拒。
    const page = await env.app.inject('/wall');
    assert.equal(page.statusCode, 200);
    assert.ok(page.body.includes('wall.css'));
    assert.ok(!page.body.includes('id="post"'), '游客页不渲染发布表单');
    assert.ok(page.body.includes('guest-hint'), '游客页有登录提示');
    assert.equal(
      (
        await env.app.inject({
          method: 'POST',
          url: '/api/wall',
          payload: { text: '冒充他的留言' },
        })
      ).statusCode,
      401,
      '游客 POST 被拒——from 写死 him，裸奔等于身份伪造',
    );
    const list = await env.app.inject('/api/wall');
    assert.equal(list.statusCode, 200);
    assert.equal(list.json().length, 0);
    // 登录后：页面有表单，发布走 him。
    const signedPage = await env.app.inject({ url: '/wall', headers: { cookie: env.cookie } });
    assert.ok(signedPage.body.includes('id="post"'), '登录页渲染发布表单');
    const posted = await env.app.inject({
      method: 'POST',
      url: '/api/wall',
      headers: { cookie: env.cookie },
      payload: { text: '验收官第一条留言' },
    });
    assert.equal(posted.statusCode, 200);
    assert.equal(posted.json().from, 'him');
    // 空文本与超长拒（已登录）。
    assert.equal(
      (
        await env.app.inject({
          method: 'POST',
          url: '/api/wall',
          headers: { cookie: env.cookie },
          payload: { text: '  ' },
        })
      ).statusCode,
      400,
    );
    // 管理 API 依然要登录（wall 放行不能漏成全局放行）。
    assert.equal((await env.app.inject('/api/status')).statusCode, 401);
    // 放行前缀必须带路径边界：/api/wall-admin 这类同名前缀端点不能裸奔。
    assert.equal((await env.app.inject('/api/wall-admin')).statusCode, 401);
    assert.equal((await env.app.inject('/api/wallx')).statusCode, 401);
    // 图片名不存在的 404。
    assert.equal((await env.app.inject('/api/wall/images/nope.png')).statusCode, 404);
    assert.equal((await env.app.inject('/api/wall/images/..%2Fsecret')).statusCode, 404);
    // 图片走 no-cache + ETag：原位替换后浏览器立即见新字节（长 max-age 曾让
    // 换图后用户端冻结 24h——真机实锤）。命中 ETag 返回 304 空 body。
    // 直接往 wall 目录放一个合法 PNG 魔数的占位文件 + 走 wall.post 造带图留言
    //（post 只校验魔数，图片路由只查文件存在，无需沙箱）。
    const png = Buffer.from(
      '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001',
      'hex',
    );
    writeFileSync(join(env.wallDir, 'fake.png'), png);
    await env.wall.post('him', '带图留言', 'fake.png', {
      readFile: () => Promise.resolve({ bytes: png }),
    } as never);
    const listWithImage = await env.app.inject('/api/wall');
    const imageUrl = listWithImage
      .json()
      .map((n: { image?: string }) => n.image)
      .find(Boolean);
    assert.ok(imageUrl, '留言应带图');
    const first = await env.app.inject(`/api/wall/images/${imageUrl}`);
    assert.equal(first.statusCode, 200);
    assert.equal(first.headers['cache-control'], 'no-cache');
    const etag = first.headers.etag;
    assert.ok(etag, '应下发 ETag');
    const revalidated = await env.app.inject({
      method: 'GET',
      url: `/api/wall/images/${imageUrl}`,
      headers: { 'if-none-match': etag },
    });
    assert.equal(revalidated.statusCode, 304);
    assert.equal(revalidated.body.length, 0);
    // 超长文本（>500 字）在服务端也被拒，不只靠前端 maxlength——
    // 趁限速额度没打满先测（它同样计权）。
    assert.equal(
      (
        await env.app.inject({
          method: 'POST',
          url: '/api/wall',
          headers: { cookie: env.cookie },
          payload: { text: 'a'.repeat(600) },
        })
      ).statusCode,
      400,
    );
    // 发布限速：额度打满后 429（读按 0.2 计权，不挤占写额度）。
    for (let i = 0; i < 1; i++) {
      const more = await env.app.inject({
        method: 'POST',
        url: '/api/wall',
        headers: { cookie: env.cookie },
        payload: { text: `灌水 ${i}` },
      });
      assert.equal(more.statusCode, 200);
    }
    assert.equal(
      (
        await env.app.inject({
          method: 'POST',
          url: '/api/wall',
          headers: { cookie: env.cookie },
          payload: { text: '第 6 条' },
        })
      ).statusCode,
      429,
    );
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

test('渠道体检端点需要登录，命中注入的探针（一键双测含角色结果）', async () => {
  const env = await fixture();
  try {
    assert.equal((await env.app.inject({ method: 'POST', url: '/api/test-llm' })).statusCode, 401);
    const llm = await env.app.inject({
      method: 'POST',
      url: '/api/test-llm',
      headers: { cookie: env.cookie },
    });
    assert.equal(llm.statusCode, 200);
    assert.deepEqual(llm.json(), {
      ok: true,
      latencyMs: 1,
      model: 'm',
      format: 'openai',
      persona: { ok: true, reply: 'SYSTEMOK' },
    });
    // /api/test-system 已并入 test-llm 的双测：端点退役（404 由 fastify 默认给）。
    assert.equal(
      (
        await env.app.inject({
          method: 'POST',
          url: '/api/test-system',
          headers: { cookie: env.cookie },
        })
      ).statusCode,
      404,
    );
    const embedding = await env.app.inject({
      method: 'POST',
      url: '/api/test-embedding',
      headers: { cookie: env.cookie },
    });
    assert.deepEqual(embedding.json(), { ok: true, latencyMs: 1, dims: 3, model: 'm' });
    // 渠道参数：合法值透传，非法值 400。
    const fallback = await env.app.inject({
      method: 'POST',
      url: '/api/test-llm',
      headers: { cookie: env.cookie },
      payload: { channel: 'fallback' },
    });
    assert.equal(fallback.statusCode, 200);
    const bad = await env.app.inject({
      method: 'POST',
      url: '/api/test-llm',
      headers: { cookie: env.cookie },
      payload: { channel: 'side' },
    });
    assert.equal(bad.statusCode, 400);
    // /api/models：渠道参数校验；备用渠道未配置时报人话。
    assert.equal(
      (
        await env.app.inject({
          method: 'GET',
          url: '/api/models?channel=side',
          headers: { cookie: env.cookie },
        })
      ).statusCode,
      400,
    );
    const noFallback = await env.app.inject({
      method: 'GET',
      url: '/api/models?channel=fallback',
      headers: { cookie: env.cookie },
    });
    assert.equal(noFallback.statusCode, 400); // TypeError → 400 + error 字段
    assert.match(noFallback.json().error, /请先启用并保存备用渠道/);
  } finally {
    await env.close();
  }
});

test('管理页/路由配对：备用渠道按钮在 HTML 与 app.js 两端成对出现', () => {
  // 静态文件配对测试：单测前端做不到（无浏览器），这里锁「HTML 有按钮、
  // JS 有绑定」的一致性——历史上 v5 回归就是按钮在 HTML 里丢了 id。
  const html = readFileSync('public/index.html', 'utf8');
  const js = readFileSync('public/app.js', 'utf8');
  // 备用渠道面板的完整绑定面：拉取/体检按钮 + 全字段输入。
  const ids = [
    'fetch-models-fallback',
    'test-llm-fallback',
    'fallback-vision',
    'fallback-temp',
    'fallback-timeout',
    'fallback-max-tokens',
    'fallback-retries',
    'fallback-model',
    'fallback-url',
    'fallback-key',
    'fallback-format',
    'fallback-on',
    'fallback-fields',
  ];
  for (const id of ids) {
    assert.ok(html.includes(`id="${id}"`), `index.html 缺 #${id}（按钮/字段丢失）`);
    assert.ok(js.includes(`'${id}'`) || js.includes(`"${id}"`), `app.js 未绑定 #${id}`);
  }
  // 一键双测后 test-system 退役：HTML 不得再有测试角色按钮，JS 不得再调旧端点。
  assert.ok(!html.includes('test-system'), 'test-system 按钮应已随双测合并移除');
  assert.ok(!js.includes('/api/test-system'), '/api/test-system 端点应已退役');
  // 主渠道的按钮仍要与端点成对：防把端点参数改了忘了 JS。
  for (const endpoint of ['/api/models', '/api/test-llm']) {
    assert.ok(js.includes(endpoint), `app.js 未调用 ${endpoint}`);
  }
  // 备用渠道的拉取必须带渠道参数——不带就是拿主渠道凭据拉备用列表。
  assert.ok(js.includes('/api/models?channel=fallback'), '备用拉取模型缺 channel 参数');
  assert.ok(js.includes("channel: 'fallback'"), '备用体检缺 channel 参数');
  // 画笔双引擎：两套字段组与切换下拉在 HTML/JS 两端成对。
  for (const id of [
    'image-engine',
    'image-gpt-fields',
    'image-nai-fields',
    'image-nai-model',
    'image-nai-steps',
    'image-nai-url',
    'image-nai-key',
  ]) {
    assert.ok(html.includes(`id="${id}"`), `index.html 缺 #${id}（画笔字段丢失）`);
    assert.ok(js.includes(`'${id}'`) || js.includes(`"${id}"`), `app.js 未绑定 #${id}`);
  }
});
