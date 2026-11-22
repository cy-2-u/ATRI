import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpRoot } from './tmp.ts';
import { Store } from '../src/store.ts';
import { AdminServer } from '../src/server.ts';
import { Runtime } from '../src/runtime.ts';
import { QQ } from '../src/qq.ts';
import { Models } from '../src/model.ts';
import { Backups } from '../src/backup.ts';
import { Files } from '../src/files.ts';
import { validateConfig, defaults, type Config } from '../src/config.ts';

const config: Config = validateConfig(defaults('测试人格'));
const getConfig = (): Config => config;

async function withServer(run: (base: string, store: Store) => Promise<void>): Promise<void> {
  const dir = tmpRoot('atri-server-');
  const store = new Store(join(dir, 'atri.db'));
  const files = new Files(join(dir, 'works'), getConfig); await files.init();
  const publicDir = join(dir, 'public');
  await mkdir(publicDir, { recursive: true });
  await writeFile(join(publicDir, 'index.html'), '<!doctype html><html lang="zh-CN"><body>ATRI 测试页</body></html>');
  const runtime = new Runtime(store, getConfig, { think: async () => { throw new Error('x'); } } as never, {} as never, files, () => undefined);
  const qq = new QQ(getConfig, store, async () => undefined, () => undefined);
  const models = new Models(getConfig, store);
  const backups = new Backups(store, getConfig, dir, Buffer.alloc(32, 1));
  const server = new AdminServer({ host: '127.0.0.1', port: 0, password: '管理密码至少12字符', publicDir, store, files, runtime, qq, models, backups, config: getConfig, update: () => undefined });
  const port = await server.listen();
  try { await run(`http://127.0.0.1:${port}`, store); }
  finally { await server.close(); store.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
}

const login = async (base: string): Promise<{ cookie: string; csrf: string }> => {
  const response = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: '管理密码至少12字符' }) });
  assert.equal(response.status, 200);
  const setCookie = response.headers.get('set-cookie')!;
  const csrf = (await response.json() as { csrf: string }).csrf;
  return { cookie: setCookie.split(';')[0]!, csrf };
};

test('管理端：登录限速、CSRF、静态资源、状态接口', async () => {
  await withServer(async (base, store) => {
    // 未登录 401
    assert.equal((await fetch(`${base}/api/status`)).status, 401);
    // 错误密码 401
    assert.equal((await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: '错误密码明显不够长' }) })).status, 401);
    const { cookie, csrf } = await login(base);
    const auth = { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' };
    // 缺 CSRF 的 POST 被拒
    assert.equal((await fetch(`${base}/api/logout`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}' })).status, 403);
    const status = await (await fetch(`${base}/api/status`, { headers: { cookie } })).json() as Record<string, unknown>;
    assert.equal(status.qq !== undefined && status.runtime !== undefined, true);
    assert.equal(((await (await fetch(`${base}/api/config`, { headers: { cookie } })).json()) as { persona: string }).persona, '测试人格');
    // 内心接口（无数据空态）
    store.ensurePeer({ kind: 'c2c', id: 'u1' });
    const inner = await (await fetch(`${base}/api/inner?peer=c2c:u1`, { headers: { cookie } })).json() as { self: { closeness: number } };
    assert.ok(inner.self.closeness >= 0);
    // 不存在的会话 404
    assert.equal((await fetch(`${base}/api/inner?peer=c2c:nope`, { headers: { cookie } })).status, 404);
    // 会话字段白名单
    const rejected = await fetch(`${base}/api/peer`, { method: 'POST', headers: auth, body: JSON.stringify({ id: 'c2c:u1', patch: { hack: true } }) });
    assert.equal(rejected.status, 400);
    const ok = await fetch(`${base}/api/peer`, { method: 'POST', headers: auth, body: JSON.stringify({ id: 'c2c:u1', patch: { name: '小张', enabled: true } }) });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json() as { name: string }).name, '小张');
  });
});

test('管理端：配置合并与校验', async () => {
  await withServer(async (base) => {
    const { cookie, csrf } = await login(base);
    const auth = { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' };
    // 启用 QQ（确认闸已删：保存动作即知情）
    const enabled = await fetch(`${base}/api/config`, { method: 'POST', headers: auth, body: JSON.stringify({ patch: { qq: { enabled: true, appId: 'a', secret: 'b' } } }) });
    assert.equal(enabled.status, 200);
    assert.equal(((await enabled.json()) as { qq: { enabled: boolean } }).qq.enabled, true);
    // 非法配置值 → 400
    const invalid = await fetch(`${base}/api/config`, { method: 'POST', headers: auth, body: JSON.stringify({ patch: { life: { beatMinutes: 3 } } }) });
    assert.equal(invalid.status, 400);
    // 未知键 → 400
    const unknown = await fetch(`${base}/api/config`, { method: 'POST', headers: auth, body: JSON.stringify({ patch: { nope: 1 } }) });
    assert.equal(unknown.status, 400);
  });
});

test('管理端：表情图片通道（/api/sticker）', async () => {
  await withServer(async (base) => {
    // 未登录 401
    assert.equal((await fetch(`${base}/api/sticker?slug=x`)).status, 401);
    const { cookie, csrf } = await login(base);
    const auth = { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' };
    // 不存在的表情 404
    assert.equal((await fetch(`${base}/api/sticker?slug=nope`, { headers: { cookie } })).status, 404);
    // 非法 slug 400
    assert.equal((await fetch(`${base}/api/sticker?slug=..%2Fx`, { headers: { cookie } })).status, 400);
    // 上传一张最小 PNG，再经 /api/sticker 读回：字节一致、mime 正确
    const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(16, 7)]);
    const upload = await fetch(`${base}/api/stickers`, { method: 'POST', headers: auth, body: JSON.stringify({ slug: 'test-sticker', description: '测试表情', bytes: png.toString('base64') }) });
    assert.equal(upload.status, 200);
    const image = await fetch(`${base}/api/sticker?slug=test-sticker`, { headers: { cookie } });
    assert.equal(image.status, 200);
    assert.equal(image.headers.get('content-type'), 'image/png');
    assert.ok(Buffer.from(await image.arrayBuffer()).equals(png));
  });
});

test('管理端：探针在渠道未配置时拒绝，模型目录只认地址密钥', async () => {
  await withServer(async (base) => {
    const { cookie, csrf } = await login(base);
    const auth = { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' };
    // 模型目录：无地址密钥 400（不再要求 confirmExternal 与模型名）
    assert.equal((await fetch(`${base}/api/model/list`, { method: 'POST', headers: auth, body: JSON.stringify({}) })).status, 400);
    // 探针：默认配置无渠道 → 400
    assert.equal((await fetch(`${base}/api/model/probe`, { method: 'POST', headers: auth, body: JSON.stringify({ mode: 'system' }) })).status, 400);
    // 备用渠道未配置时禁止探测
    assert.equal((await fetch(`${base}/api/model/probe`, { method: 'POST', headers: auth, body: JSON.stringify({ channel: 'fallback' }) })).status, 400);
  });
});

test('管理端：Host 校验与登录页可达', async () => {
  await withServer(async (base, _store) => {
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /ATRI/);
    const health = await fetch(`${base}/health`);
    assert.equal(((await health.json()) as { ok: boolean }).ok, true);
    // 伪造 Host 被拒：fetch 会丢弃 Host 头，必须用原生 http 客户端
    const port = Number(new URL(base).port);
    const spoofed = await new Promise<{ status: number; body: string }>(resolve => {
      const req = request({ host: '127.0.0.1', port, path: '/health', headers: { host: 'evil.example.com' }, agent: false }, res => {
        const chunks: Buffer[] = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
      });
      req.end();
    });
    assert.equal(spoofed.status, 403);
    assert.match(spoofed.body, /Host 不允许/);
  });
});

test('管理端：通配监听放行 IP/localhost Host、拒绝域名（容器端口映射场景）', async () => {
  const dir = tmpRoot('atri-server-');
  const store = new Store(join(dir, 'atri.db'));
  const files = new Files(join(dir, 'works'), getConfig); await files.init();
  const publicDir = join(dir, 'public');
  await mkdir(publicDir, { recursive: true });
  await writeFile(join(publicDir, 'index.html'), '<!doctype html><html lang="zh-CN"><body>ATRI 测试页</body></html>');
  const runtime = new Runtime(store, getConfig, { think: async () => { throw new Error('x'); } } as never, {} as never, files, () => undefined);
  const qq = new QQ(getConfig, store, async () => undefined, () => undefined);
  const models = new Models(getConfig, store);
  const backups = new Backups(store, getConfig, dir, Buffer.alloc(32, 1));
  const server = new AdminServer({ host: '0.0.0.0', port: 0, password: '管理密码至少12字符', publicDir, store, files, runtime, qq, models, backups, config: getConfig, update: () => undefined });
  const port = await server.listen();
  try {
    // IP 形式 Host（宿主端口 ≠ 监听端口也不限）→ 放行
    const viaIp = await new Promise<{ status: number; body: string }>(resolve => {
      const req = request({ host: '127.0.0.1', port, path: '/health', headers: { host: '203.0.113.9:3000' }, agent: false }, res => {
        const chunks: Buffer[] = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
      });
      req.end();
    });
    assert.equal(viaIp.status, 200);
    // 陌生域名（DNS rebinding 形态）→ 403
    const spoofed = await new Promise<{ status: number; body: string }>(resolve => {
      const req = request({ host: '127.0.0.1', port, path: '/health', headers: { host: 'evil.example.com' }, agent: false }, res => {
        const chunks: Buffer[] = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
      });
      req.end();
    });
    assert.equal(spoofed.status, 403);
    assert.match(spoofed.body, /通配监听仅接受 IP 或 localhost/);
  } finally { await server.close(); store.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
});
