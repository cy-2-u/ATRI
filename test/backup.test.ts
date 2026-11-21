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
  const madeDirs = new Set<string>();
  const isMadeDir = (path: string) => madeDirs.has(path.slice(0, -1)) || madeDirs.has(path);
  const calls: { method: string; url: string }[] = [];
  const handler = (method: string, url: string, body?: Buffer) => {
    calls.push({ method, url });
    const path = url.replace(/^https?:\/\/dav\.test\//, '');
    // 仿真网盘：PUT 的目标目录（去掉文件名后的父路径）未建立时回 409——
    // w.webav.us.ci 实测行为，钉死"子目录必须先 MKCOL"。
    const parent = path.replace(/[^/]+$/, '');
    if (method === 'PUT' && parent && !objects.has(`${parent}.keep`)) {
      const known = [...objects.keys()].some((k) => k.startsWith(parent));
      if (!known && parent !== 'dav/atri-backup/' && !isMadeDir(parent)) return { status: 409 };
    }
    if (method === 'PUT') {
      objects.set(path, body ?? Buffer.alloc(0));
      return { status: 201 };
    }
    if (method === 'MKCOL') {
      madeDirs.add(path);
      objects.set(`${path}.keep`, Buffer.alloc(0));
      return { status: objects.has(path) ? 405 : 201 };
    }
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
  // 她的作品：墙图（平铺）+ 沙箱（pictures/、diary/ 两层嵌套）。
  mkdirSync(join(dir, 'wall'), { recursive: true });
  writeFileSync(join(dir, 'wall', 'note-1.png'), Buffer.from('wall-bytes'));
  const sandbox = mkdtempSync(join(tmpdir(), 'atri-backup-sandbox-'));
  mkdirSync(join(sandbox, 'pictures'), { recursive: true });
  mkdirSync(join(sandbox, 'diary'), { recursive: true });
  writeFileSync(join(sandbox, 'pictures', 'jelly.png'), Buffer.from('jelly-bytes'));
  writeFileSync(join(sandbox, 'diary', '2026-11-19.md'), Buffer.from('diary-bytes'));
  const dav = fakeDav();
  stubFetch(dav);
  return {
    dav,
    dir,
    sandbox,
    backup: new WebDavBackup(
      dir,
      () => ({ url: 'https://dav.test/dav', user: 'u', password: 'p' }),
      () => 'Asia/Shanghai',
      () => {},
      sandbox,
    ),
    close() {
      globalThis.fetch = originalFetch;
      rmSync(dir, { recursive: true, force: true });
      rmSync(sandbox, { recursive: true, force: true });
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
    // 作品目录也进了备份：墙图平铺、沙箱两层嵌套原样镜像。
    assert.equal(
      env.dav.objects.get('dav/atri-backup/2023-11-15/wall/note-1.png')!.toString(),
      'wall-bytes',
    );
    assert.equal(
      env.dav.objects.get('dav/atri-backup/2023-11-15/sandbox/pictures/jelly.png')!.toString(),
      'jelly-bytes',
    );
    assert.equal(
      env.dav.objects.get('dav/atri-backup/2023-11-15/sandbox/diary/2026-11-19.md')!.toString(),
      'diary-bytes',
    );
    // 同一日期再跑一次：目录已存在（405 幂等），备份照常成功。
    await env.backup.run(1_700_000_000_000 + 60_000);
    assert.equal(puts.length * 2, env.dav.calls.filter((c) => c.method === 'PUT').length);
  } finally {
    env.close();
  }
});

test('WebDAV 备份：深层嵌套的作品照样镜像（截断回归钉）', async () => {
  const env = backupFixture();
  try {
    // 旧实现 depth=2：a/b/ 之下的文件被静默不备份而 ok:true 照报——
    // ok 的备份必须完整，这条断言钉死"嵌套深度不是丢数据的暗门"。
    mkdirSync(join(env.sandbox, 'works', '2026'), { recursive: true });
    writeFileSync(join(env.sandbox, 'works', '2026', 'jelly.png'), 'deep-bytes');
    await env.backup.run(1_700_000_000_000);
    assert.equal(
      env.dav.objects.get('dav/atri-backup/2023-11-15/sandbox/works/2026/jelly.png')!.toString(),
      'deep-bytes',
    );
  } finally {
    env.close();
  }
});

test('WebDAV 备份：作品文件超上限明确报错（不静默截断）', async () => {
  const env = backupFixture();
  const original = WebDavBackup.MAX_FILES;
  WebDavBackup.MAX_FILES = 5;
  try {
    for (let i = 0; i < 6; i++) writeFileSync(join(env.sandbox, `f${i}.txt`), 'x');
    await assert.rejects(() => env.backup.run(1_700_000_000_000), /作品文件过多/);
    // 作品一件都没上传（数据库的两笔 PUT 发生在清点之前，属正常）。
    const artworkPuts = env.dav.calls.filter(
      (c) => c.method === 'PUT' && (c.url.includes('/wall/') || c.url.includes('/sandbox/')),
    );
    assert.equal(artworkPuts.length, 0);
  } finally {
    WebDavBackup.MAX_FILES = original;
    env.close();
  }
});

test('WebDAV 备份：进行中的备份拒绝第二个并发 run（重入钉）', async () => {
  const env = backupFixture();
  try {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stub = globalThis.fetch;
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      // 卡住数据库上传：第一个 run 进入"进行中"，第二个必须被拒。
      if (String(input).includes('atri.db.gz')) await gate;
      return stub(input as never, init);
    };
    try {
      const first = env.backup.run(1_700_000_000_000);
      await assert.rejects(() => env.backup.run(1_700_000_000_000 + 60_000), /备份正在进行中/);
      release();
      await first;
    } finally {
      globalThis.fetch = stub;
    }
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
    // 手动重跑（管理页按钮走 run，闸门不拦），成功后状态即时更新——
    // 全新实例手动备份也必须拿到 at，前端"备份完成：undefined"是 bug。
    const fresh = new WebDavBackup(
      env.dir,
      () => ({ url: 'https://dav.test/dav', user: 'u', password: 'p' }),
      () => 'Asia/Shanghai',
      () => {},
    );
    await fresh.run(1_700_000_000_000 + 2_000);
    assert.equal(fresh.state.at, '2023-11-15');
    assert.ok(env.dav.calls.filter((c) => c.method === 'PUT').length > putsAfterFirst);
  } finally {
    env.close();
  }
});

test('WebDAV 闸门：凌晨 4 点前不备（tick 语义与注释一致）', async () => {
  const env = backupFixture();
  try {
    // 1_700_000_000_000 = 上海 2023-11-15 06:13 → 会备；取当天凌晨 2 点不备。
    const before4 = Date.parse('2023-11-15T02:00:00+08:00');
    const state = await env.backup.tick(before4);
    assert.equal(state.at, undefined);
    assert.equal(env.dav.calls.filter((c) => c.method === 'PUT').length, 0);
    // 4 点过第一个 tick 立刻补上。
    const after4 = await env.backup.tick(Date.parse('2023-11-15T04:00:00+08:00') + 1);
    assert.equal(after4.at, '2023-11-15');
  } finally {
    env.close();
  }
});

test('WebDAV 备份：重定向不当成功（PUT 301 静默丢数据的回归钉）', async () => {
  const env = backupFixture();
  try {
    // 假服务器对 PUT 回 301：旧实现把它当成功（res.status < 400），
    // 内容根本没存进去却报 ok——这条断言钉死"只有 2xx 算数"。
    const originalHandler = env.dav.handler;
    env.dav.handler = (method, url, body) => {
      if (method === 'PUT') return { status: 301 };
      return originalHandler(method, url, body);
    };
    await assert.rejects(() => env.backup.run(1_700_000_000_000), /HTTP 301/);
    assert.ok(!env.dav.objects.has('dav/atri-backup/2023-11-15/atri.db.gz'));
    // run() 只做动作不记状态：诊断经 POST 响应的 {ok:false,error} 当场返回。
  } finally {
    env.close();
  }
});

test('WebDAV 备份：清理失败不炸主流程（坚果云不删非空目录的场景）', async () => {
  const env = backupFixture();
  try {
    // 塞满 31 份历史目录逼出 prune 的 DELETE，再把 DELETE 一律 403：
    // 备份主流程必须照样成功（坚果云这类网盘删非空目录就是 403）。
    for (let d = 1; d <= 31; d++) {
      const day = `2023-10-${String(d).padStart(2, '0')}`;
      env.dav.objects.set(`dav/atri-backup/${day}/atri.db.gz`, Buffer.alloc(0));
    }
    const originalHandler = env.dav.handler;
    env.dav.handler = (method, url, body) => {
      if (method === 'DELETE') return { status: 403 };
      return originalHandler(method, url, body);
    };
    await env.backup.run(1_700_000_000_000);
    assert.ok(env.dav.objects.has('dav/atri-backup/2023-11-15/atri.db.gz'));
    assert.equal(env.backup.state.at, '2023-11-15');
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
