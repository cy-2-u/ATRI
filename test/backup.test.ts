import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { Journal } from '../src/storage/journal.js';
import { Settings } from '../src/settings.js';
import { WebDavBackup } from '../src/backup.js';
import { createServer } from '../src/server.js';
import { Wall } from '../src/wall.js';
import { ModelRouter } from '../src/model/router.js';
import { Mind } from '../src/domain/mind.js';
import { Runtime } from '../src/runtime/runtime.js';

/** 极简 WebDAV 假服务器：记录每个请求（方法/路径/正文），内存对象存储。 */
function fakeDav() {
  const objects = new Map<string, Buffer>();
  const calls: { method: string; url: string }[] = [];
  const handler = (method: string, url: string, body?: Buffer) => {
    calls.push({ method, url });
    const path = url.replace(/^https?:\/\/dav\.test\//, '');
    if (method === 'PUT') {
      objects.set(path, body ?? Buffer.alloc(0));
      return { status: 201 };
    }
    if (method === 'MKCOL') return { status: objects.has(path) ? 405 : 201 };
    if (method === 'PROPFIND') {
      const xml = [...objects.keys()].map((p) => `<D:href>/dav/${p}</D:href>`).join('');
      return { status: 207, text: xml };
    }
    if (method === 'DELETE') {
      for (const key of [...objects.keys()]) if (key.startsWith(path)) objects.delete(key);
      return { status: 204 };
    }
    return { status: 405 };
  };
  return { objects, calls, handler };
}

// fetch 打桩：URL 命中 dav.test 就走假服务器。
function stubFetch(dav: ReturnType<typeof fakeDav>): void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (!url.startsWith('https://dav.test/')) return original(input as never, init);
    const status = dav.handler(
      (init?.method as string) ?? 'GET',
      url,
      init?.body ? Buffer.from(init.body as Uint8Array) : undefined,
    );
    return new Response(status.text ?? null, { status: status.status });
  }) as typeof fetch;
}

function backupFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'atri-backup-'));
  mkdirSync(join(dir, 'custom'), { recursive: true });
  writeFileSync(join(dir, 'atri.db'), Buffer.from('db-bytes'));
  writeFileSync(join(dir, 'custom', 'meme.png'), Buffer.from('png-bytes'));
  const dav = fakeDav();
  stubFetch(dav);
  return {
    dav,
    dir,
    backup: new WebDavBackup(
      dir,
      () => ({ url: 'https://dav.test/dav', user: 'u', password: 'p' }),
      () => 'Asia/Shanghai',
      () => {},
    ),
    close() {
      globalThis.fetch = originalFetch;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
const originalFetch = globalThis.fetch;

test('WebDAV 备份：目录创建、数据库 gzip 上传、表情逐文件、重复跑同日幂等', async () => {
  const env = backupFixture();
  try {
    await env.backup.run(1_700_000_000_000);
    const puts = env.dav.calls.filter((c) => c.method === 'PUT');
    assert.ok(env.dav.calls.some((c) => c.method === 'MKCOL' && c.url.includes('atri-backup/')));
    assert.equal(
      gunzipSync(env.dav.objects.get('dav/atri-backup/2023-11-15/atri.db.gz')!).toString(),
      'db-bytes',
    );
    assert.equal(
      env.dav.objects.get('dav/atri-backup/2023-11-15/custom/meme.png')!.toString(),
      'png-bytes',
    );
    // 同一日期再跑一次：目录已存在（405 幂等），备份照常成功。
    await env.backup.run(1_700_000_000_000 + 60_000);
    assert.equal(puts.length * 2, env.dav.calls.filter((c) => c.method === 'PUT').length);
  } finally {
    env.close();
  }
});

test('WebDAV 备份：每日闸门同日只跑一次，失败留错误不丢旧 at', async () => {
  const env = backupFixture();
  try {
    const first = await env.backup.tick(1_700_000_000_000);
    assert.equal(first.at, '2023-11-15');
    const again = await env.backup.tick(1_700_000_000_000 + 1_000);
    assert.equal(again.at, '2023-11-15');
    const putsAfterFirst = env.dav.calls.filter((c) => c.method === 'PUT').length;
    // 强制重跑（管理页按钮走 run，闸门不拦）。
    await env.backup.run(1_700_000_000_000 + 2_000);
    assert.ok(env.dav.calls.filter((c) => c.method === 'PUT').length > putsAfterFirst);
  } finally {
    env.close();
  }
});

test('WebDAV 备份：失败落 error 状态；未配置直接拒绝', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'atri-backup-fail-'));
  try {
    writeFileSync(join(dir, 'atri.db'), Buffer.from('db'));
    const dav = fakeDav();
    // 服务器对 PUT 一律 500：模拟网盘故障。
    dav.handler = (method, url, body) =>
      method === 'PUT' ? { status: 500 } : fakeDav().handler(method, url, body);
    stubFetch(dav);
    const backup = new WebDavBackup(
      dir,
      () => ({ url: 'https://dav.test/dav', user: '', password: 'p' }),
      () => 'Asia/Shanghai',
      () => {},
    );
    const state = await backup.tick(1_700_000_000_000);
    assert.ok(state.error?.includes('HTTP 500'));
    assert.equal(state.failedAt, '2023-11-15');
    assert.ok(backup.state.error);
    const empty = new WebDavBackup(
      dir,
      () => undefined,
      () => 'Asia/Shanghai',
    );
    await assert.rejects(() => empty.run(0), /未配置/);
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('WebDAV 设置：往返保存、密码脱敏、半空沿用旧值、清空关闭', async () => {
  const journal = new Journal(':memory:');
  const settings = new Settings(journal, {});
  settings.update({
    webdav: { url: 'https://dav.jianguoyun.com/dav/', user: 'me', password: 'secret' },
  });
  assert.equal(settings.get().webdav?.url, 'https://dav.jianguoyun.com/dav');
  const pub = settings.public() as { webdav?: { url: string; user: string; hasPassword: boolean } };
  assert.equal(pub.webdav?.url, 'https://dav.jianguoyun.com/dav');
  assert.equal(pub.webdav?.user, 'me');
  assert.equal(pub.webdav?.hasPassword, true);
  assert.ok(!JSON.stringify(pub).includes('secret'));
  // 密码留空保持旧值。
  settings.update({ webdav: { url: 'https://dav.jianguoyun.com/dav/', user: 'me' } });
  assert.equal(settings.get().webdav?.password, 'secret');
  // 首次配置缺密码：干净实例上才测得出"缺项报错"（有旧值时语义是沿用）。
  const fresh = new Settings(new Journal(':memory:'), {});
  assert.throws(() => fresh.update({ webdav: { url: 'https://x.test/dav' } }), /密码/);
  // 清空 = 关闭。
  settings.update({ webdav: null });
  assert.equal(settings.get().webdav, undefined);
  assert.equal((settings.public() as { webdav: unknown }).webdav, null);
  journal.close();
});

test('备份端点：未登录 401，登录后状态可见，未配置时立即备份被拒', async () => {
  const journal = new Journal(':memory:');
  const wallDir = mkdtempSync(join(tmpdir(), 'atri-backup-server-'));
  const settings = new Settings(journal, {});
  const runtime = new Runtime(
    journal,
    new Mind(
      new ModelRouter(
        () => settings.routes(),
        async () => {
          throw new Error('not called');
        },
      ),
      journal,
    ),
    {
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
    },
  );
  const backup = new WebDavBackup(
    wallDir,
    () => settings.get().webdav,
    () => settings.get().timezone,
  );
  const app = createServer({
    password: 'test-password-123',
    settings,
    journal,
    router: undefined as never,
    runtime,
    bridge: { status: () => ({ status: '未登录' }) } as never,
    stickers: { list: () => [] } as never,
    webConfigured: () => false,
    channelProbe: async () => ({ ok: true, latencyMs: 1, model: 'm', format: 'openai' }),
    systemProbe: async () => ({ ok: true, reply: 'SYSTEMOK' }),
    embeddingProbe: async () => ({ ok: true, latencyMs: 1, dims: 3, model: 'm' }),
    staticRoot: '.',
    assetsRoot: '.',
    customStickersRoot: '.',
    wall: new Wall(journal.db, wallDir),
    backup,
  });
  await app.ready();
  try {
    assert.equal((await app.inject('/api/backup')).statusCode, 401);
    const login = await app.inject({
      method: 'POST',
      url: '/api/login',
      payload: { password: 'test-password-123' },
    });
    const cookie = String(login.headers['set-cookie']).split(';')[0]!;
    const state = await app.inject({ url: '/api/backup', headers: { cookie } });
    assert.equal(state.statusCode, 200);
    assert.equal(state.json().configured, false);
    const denied = await app.inject({ method: 'POST', url: '/api/backup', headers: { cookie } });
    assert.equal(denied.statusCode, 400);
    assert.ok(denied.json().error.includes('WebDAV'));
  } finally {
    await app.close();
    await runtime.stop();
    journal.close();
    rmSync(wallDir, { recursive: true, force: true });
  }
});
