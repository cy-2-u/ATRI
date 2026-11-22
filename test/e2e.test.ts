import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const until = async (fn: () => boolean | Promise<boolean>, ms = 15000, what = '条件'): Promise<void> => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return; await new Promise(r => setTimeout(r, 150)); }
  assert.fail(`${what} 超时`);
};

test('端到端：入站 → 思考 → 校验修复 → 落账 → 预演投递 → 用量入账', async () => {
  // 假 LLM：OpenAI 兼容渠道。第一次回复有效；第二次埋一个伪造 feeling 来源，
  // 观察系统能否走修复回路；收到"校验失败"后给有效回复。
  let calls = 0;
  const llm: Server = createServer((req, res) => {
    if (req.method === 'GET' && (req.url ?? '').endsWith('/models')) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data: [{ id: 'fake' }, { id: 'fake-pro' }, { id: 'fake' }] })); // 含重复，验证去重
      return;
    }
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      calls++;
      // system 哨兵探针：渠道需要如实回哨兵词
      if (body.includes('哨兵有效')) {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ id: `c${calls}`, choices: [{ index: 0, message: { role: 'assistant', content: '哨兵有效' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 4 } }));
        return;
      }
      const needsRepair = body.includes('校验失败');
      const content = needsRepair || calls !== 2
        ? JSON.stringify({ parts: [{ type: 'text', text: calls === 1 ? '在的，怎么了？' : '好' }] })
        : JSON.stringify({ parts: [{ type: 'text', text: '坏回复' }], feeling: { label: '平静', valence: 0.1, arousal: 0, patience: 0, reason: '伪造来源', sources: ['bogus-id'] } });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ id: `c${calls}`, choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 120, completion_tokens: 20 } }));
    });
  });
  await new Promise<void>(r => llm.listen(0, '127.0.0.1', r));
  const llmPort = (llm.address() as { port: number }).port;
  const dataDir = mkdtempSync(join(tmpdir(), 'atri-e2e-data-'));
  const child = spawn(process.execPath, [join('src', 'index.ts')], {
    cwd: root,
    env: { ...process.env, ATRI_DATA_DIR: dataDir, ATRI_PORT: '0', ATRI_ADMIN_PASSWORD: 'e2e-password-123456' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  child.stdout.on('data', c => { stdout += c; });
  let stderr = '';
  child.stderr.on('data', c => { stderr += c; });
  try {
    await until(() => /127\.0\.0\.1:(\d+)/.test(stdout), 10000, '服务启动');
    const port = Number(stdout.match(/127\.0\.0\.1:(\d+)/)![1]);
    const base = `http://127.0.0.1:${port}`;
    // 登录
    const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'e2e-password-123456' }) });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    const csrf = (await login.json() as { csrf: string }).csrf;
    const auth = { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' };
    // 配置模型渠道
    const cfg = await fetch(`${base}/api/config`, { method: 'POST', headers: auth, body: JSON.stringify({ patch: { primary: { url: `http://127.0.0.1:${llmPort}`, key: 'k', model: 'fake' } } }) });
    assert.equal(cfg.status, 200, await cfg.text());
    // 预演：第一条消息 → 正常回复
    const p1 = await fetch(`${base}/api/preview`, { method: 'POST', headers: auth, body: JSON.stringify({ text: '在吗', confirmExternal: true }) });
    assert.equal(p1.status, 200, await p1.text());
    let accepted1: { status: string; text?: string } | undefined;
    await until(async () => {
      const list = await (await fetch(`${base}/api/deliveries?peer=c2c:preview`, { headers: { cookie } })).json() as { status: string; part: { text?: string } }[];
      accepted1 = list.find(d => d.status === 'accepted') ? { status: 'accepted', text: list.find(d => d.status === 'accepted')!.part.text } : undefined;
      return !!accepted1;
    }, 15000, '第一条回复投递');
    assert.equal(accepted1!.text, '在的，怎么了？');
    // 第二条：触发校验失败 → 修复回路 → 有效回复
    await fetch(`${base}/api/preview`, { method: 'POST', headers: auth, body: JSON.stringify({ text: '再陪我聊两句', confirmExternal: true }) });
    await until(async () => {
      const list = await (await fetch(`${base}/api/deliveries?peer=c2c:preview`, { headers: { cookie } })).json() as { status: string; part: { text?: string } }[];
      return list.some(d => d.status === 'accepted' && d.part.text === '好');
    }, 15000, '修复后回复投递');
    // 坏回复绝不能发出去
    const all = await (await fetch(`${base}/api/deliveries?peer=c2c:preview`, { headers: { cookie } })).json() as { status: string; part: { text?: string } }[];
    assert.ok(!all.some(d => d.part.text === '坏回复' && d.status === 'accepted'), '校验失败的输出被投递出去了');
    // 模型确实被调用 ≥3 次（含修复轮），用量入账
    assert.ok(calls >= 3, `模型调用次数 ${calls}`);
    const usage = await (await fetch(`${base}/api/usage?days=1`, { headers: { cookie } })).json() as { calls: number };
    assert.ok(usage.calls >= 3, `usage 入账 ${usage.calls}`);
    // 判据（审计 BUG-2）：预演会话绝不能常驻心跳/夜间拍——那是真金白银的 token
    const jobs = await (await fetch(`${base}/api/jobs`, { headers: { cookie } })).json() as { peer: string; kind: string }[];
    const previewJobs = jobs.filter(j => j.peer === 'c2c:preview');
    assert.deepEqual(previewJobs, [], `预演会话泄漏了常驻任务: ${JSON.stringify(previewJobs)}`);
    // 模型目录拉取（去重后按序）与 system 哨兵探针
    const list = await (await fetch(`${base}/api/model/list`, { method: 'POST', headers: auth, body: JSON.stringify({ confirmExternal: true, url: `http://127.0.0.1:${llmPort}`, key: 'k' }) })).json() as { models: string[] };
    assert.deepEqual(list.models, ['fake', 'fake-pro']);
    const probe = await (await fetch(`${base}/api/model/probe`, { method: 'POST', headers: auth, body: JSON.stringify({ mode: 'system', confirmExternal: true }) })).json() as { ok: boolean; follows: boolean; reply: string };
    assert.equal(probe.ok, true);
    assert.equal(probe.follows, true, `system 哨兵未生效：${probe.reply}`);
    // 备用渠道配置后可被独立探测（only 通道，不走 failover）
    const fb = await fetch(`${base}/api/config`, { method: 'POST', headers: auth, body: JSON.stringify({ patch: { fallback: { url: `http://127.0.0.1:${llmPort}`, key: 'k', model: 'fake' } } }) });
    assert.equal(fb.status, 200, await fb.text());
    const fbProbe = await (await fetch(`${base}/api/model/probe`, { method: 'POST', headers: auth, body: JSON.stringify({ channel: 'fallback', confirmExternal: true }) })).json() as { ok: boolean; reply: string };
    assert.equal(fbProbe.ok, true);
    // 备用渠道同样可测 system 哨兵
    const fbSystem = await (await fetch(`${base}/api/model/probe`, { method: 'POST', headers: auth, body: JSON.stringify({ channel: 'fallback', mode: 'system', confirmExternal: true }) })).json() as { ok: boolean; follows: boolean };
    assert.equal(fbSystem.follows, true);
  } finally {
    child.kill();
    llm.closeIdleConnections(); // undici keep-alive 不主动断，server.close 会等它到天荒地老
    llm.close();
    await new Promise(r => llm.close(r));
    try { rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* Windows 文件锁，尽力清理 */ }
    if (stderr && !/ExperimentalWarning/.test(stderr)) process.stderr.write(`[e2e stderr] ${stderr.slice(0, 800)}\n`);
  }
});
