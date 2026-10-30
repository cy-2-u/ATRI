// 测试统一入口：
//   node test/run.mjs          单元测试 + 管理页/路由配对检查
//   node test/run.mjs --smoke  编译后服务冒烟（先 npm run build）
//   node test/run.mjs --all    两者都跑
// 由仓库根的 npm test 调用，也可直接运行。
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = resolve(fileURLToPath(new URL('.', import.meta.url)));
const project = resolve(here, '..');
const args = new Set(process.argv.slice(2));
const wantSmoke = args.has('--smoke') || args.has('--all');
const wantUnit = !args.has('--smoke') || args.has('--all');

function unitTests() {
  console.log('\n# Unit tests');
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--test',
      ...readdirSync(here)
        .filter((f) => f.endsWith('.test.ts'))
        .map((f) => join(here, f)),
    ],
    { stdio: 'inherit', cwd: project },
  );
  return result.status === 0;
}

// --- 管理页调用 ↔ Fastify 路由 配对：两侧都从源码读取，改一边漏一边立刻报 ---

const VERBS = '(get|post|put|delete)';

function serverRoutes(server) {
  const routes = new Set();
  let pendingVerb = null;
  for (const line of server.split('\n')) {
    const inline = line.match(new RegExp(`app\\.${VERBS}\\s*(<[\\s\\S]*?>)?\\s*\\(\\s*'([^']+)'`));
    if (inline) {
      routes.add(inline[1].toUpperCase() + ' ' + inline[3]);
      pendingVerb = null;
      continue;
    }
    const open = line.match(new RegExp(`app\\.${VERBS}\\s*(<[\\s\\S]*?>)?\\s*\\(\\s*$`));
    if (open) {
      pendingVerb = open[1];
      continue;
    }
    const p = line.match(/^\s*'((?:\/api|\/healthz)[^']*)'/);
    if (p && pendingVerb) {
      routes.add(pendingVerb.toUpperCase() + ' ' + p[1]);
      pendingVerb = null;
    }
  }
  return routes;
}

/** 顶层逗号切分参数表，尊重嵌套与字符串。 */
function splitArgs(src, start) {
  const result = [];
  let depth = 0;
  let inString = null;
  let argStart = start;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === inString) inString = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      inString = ch;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') {
      if (depth === 0) {
        result.push(src.slice(argStart, i));
        return result;
      }
      depth--;
    } else if (ch === ',' && depth === 0) {
      result.push(src.slice(argStart, i));
      argStart = i + 1;
    }
  }
  return result;
}

/** 展开三元分支：`'/x/'+id+(off?'/enable':'')` 得到两条路径。 */
function expandTernaries(expr, limit = 8) {
  const result = [];
  const queue = [expr];
  while (queue.length && result.length < limit) {
    const current = queue.shift();
    const m = current.match(
      /\(?\s*([^()?:]*)\?\s*((?:'[^']*'|[^()?:])*?)\s*:\s*((?:'[^']*'|[^()?:])*?)\s*\)?$/,
    );
    const simple = current.match(/([^()?:]*)\?\s*('[^']*'|[^()?:]*?)\s*:\s*('[^']*'|[^()?:]*)/);
    const hit = m ?? simple;
    if (!hit) {
      if (!result.includes(current)) result.push(current);
      continue;
    }
    const at = current.indexOf(hit[0]);
    const before = current.slice(0, at);
    const after = current.slice(at + hit[0].length);
    const cleaned = (s) => s.replace(/^\(?\s*/, '').replace(/\s*\)?$/, '');
    queue.push(before + cleaned(hit[2]) + after, before + cleaned(hit[3]) + after);
  }
  return result;
}

/** 前端全部 api(...) 调用，形如 [method, path]。 */
function uiCalls(appJs) {
  const calls = [];
  const re = /\bapi\(/g;
  let m;
  while ((m = re.exec(appJs))) {
    if (/function\s+$/.test(appJs.slice(Math.max(0, m.index - 20), m.index))) continue;
    const callArgs = splitArgs(appJs, m.index + m[0].length);
    if (!callArgs[0]) continue;
    const pathBranches = [];
    for (const rawArg of expandTernaries(callArgs[0])) {
      const raw = rawArg.replace(/\benc\([^)]*\)/g, "'__ID__'");
      const path = raw
        .match(/'[^']*'|"[^"]*"|`[^`]*`/g)
        ?.map((s) => s.slice(1, -1).replaceAll('__ID__', ':p'))
        .join('');
      if (path?.startsWith('/api') && !pathBranches.includes(path)) pathBranches.push(path);
    }
    if (!pathBranches.length) continue;
    const verbSource = callArgs[1]?.trim() ?? '';
    const verbBranches = expandTernaries(verbSource)
      .map((v) => v.trim().match(/^(['"])([A-Z]+)\1$/)?.[2])
      .filter((v) => v);
    // 路径与方法分支同源：按下标配对而不是做叉积。
    const paired = verbBranches.length > 1 && pathBranches.length === verbBranches.length;
    const verbs = verbBranches.length ? verbBranches : ['GET'];
    for (let i = 0; i < pathBranches.length; i++) {
      const path = pathBranches[i];
      if (paired) calls.push(verbs[i] + ' ' + path);
      else for (const verb of verbs) calls.push(verb + ' ' + path);
    }
  }
  return [...new Set(calls)];
}

/** :param 恰好匹配一个非空段。 */
function matches(routePath, callPath) {
  const r = routePath.split('/');
  const c = callPath.split('?')[0].split('/');
  if (r.length !== c.length) return false;
  return r.every((seg, i) => (seg.startsWith(':') ? c[i].length > 0 : seg === c[i]));
}

function apiPairs() {
  console.log('# Management UI / API pairing');
  const server = readFileSync(join(project, 'src', 'api', 'server.ts'), 'utf8');
  const appJs = readFileSync(join(project, 'public', 'app.js'), 'utf8');
  const routes = [...serverRoutes(server)];
  const calls = uiCalls(appJs);
  let bad = 0;
  for (const call of calls) {
    const at = call.indexOf(' ');
    const method = call.slice(0, at);
    const path = call.slice(at + 1);
    const ok = routes.some((route) => {
      const rat = route.indexOf(' ');
      return route.slice(0, rat) === method && matches(route.slice(rat + 1), path);
    });
    if (!ok) {
      console.log('UNMATCHED UI CALL:', method, path);
      bad++;
    }
  }
  // 没有 UI 调用者的路由要么是死代码、要么是给脚本用的公开 API。
  const API_ONLY = new Set([
    'GET /healthz',
    'GET /',
    'GET /app.js',
    'GET /app.css',
    'GET /atri.webp',
    // 表情面板动态拼接（`/api/stickers/${slug}/image`），app.js 里没有字面量路径。
    'GET /api/stickers/:slug/image',
    // 她的状态面板数据源（states 抽屉与 /api/self 共用）。
    'GET /api/self',
  ]);
  for (const route of routes) {
    if (API_ONLY.has(route)) continue;
    const at = route.indexOf(' ');
    const method = route.slice(0, at);
    const path = route.slice(at + 1);
    const used = calls.some((call) => {
      const cat = call.indexOf(' ');
      return call.slice(0, cat) === method && matches(path, call.slice(cat + 1));
    });
    if (!used) console.log('backend route unused by UI:', route);
  }
  console.log(`routes: ${routes.length}, ui calls: ${calls.length}`);
  console.log(
    bad === 0
      ? `OK: all ${calls.length} UI calls have a backend route`
      : `${bad} UI call(s) have no backend route`,
  );
  return bad === 0;
}

// --- 编译后服务冒烟 ---

async function smoke() {
  console.log('\n# Smoke test');
  const serverEntry = join(project, 'dist', 'server.js');
  if (!existsSync(serverEntry)) throw new Error('dist/server.js 不存在，先 npm run build');
  const directory = mkdtempSync(join(tmpdir(), 'atri-smoke-'));
  const password = 'smoke-test-password-only';
  let child;
  let logs = '';
  const upstream = createServer(async (_request, response) => {
    try {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          choices: [
            { message: { role: 'assistant', content: JSON.stringify({ messages: ['嗯。'] }) } },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 2 },
        }),
      );
    } catch (error) {
      response.writeHead(500);
      response.end(String(error));
    }
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  try {
    const modelPort = upstream.address().port;
    child = spawn(process.execPath, [serverEntry], {
      cwd: project,
      env: {
        ...process.env,
        APP_ROOT: project,
        DATA_DIR: directory,
        HOST: '127.0.0.1',
        PORT: '0',
        ADMIN_PASSWORD: password,
        LLM_BASE_URL: `http://127.0.0.1:${modelPort}`,
        LLM_API_KEY: 'smoke-only',
        LLM_MODEL: 'fixture-model',
        LLM_FORMAT: 'openai',
        LLM_VISION: 'false',
        TAVILY_API_KEY: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const base = await new Promise((resolveBase, reject) => {
      const timeout = setTimeout(() => reject(new Error('服务启动超时：' + logs)), 15000);
      const receive = (chunk) => {
        logs += chunk.toString();
        const match = /http:\/\/127\.0\.0\.1:\d+/.exec(logs);
        if (match) {
          clearTimeout(timeout);
          resolveBase(match[0]);
        }
      };
      child.stdout.on('data', receive);
      child.stderr.on('data', (chunk) => (logs += chunk.toString()));
      child.once('error', reject);
      child.once('exit', (code) => {
        clearTimeout(timeout);
        reject(new Error(`服务提前退出 ${code}: ${logs}`));
      });
    });
    async function api(path, method = 'GET', body) {
      const response = await fetch(base + path, {
        method,
        headers: {
          authorization: 'Bearer ' + password,
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await response.json();
      assert.ok(response.ok, JSON.stringify(data));
      return data;
    }
    assert.equal((await fetch(base + '/healthz')).status, 200);
    const page = await fetch(base + '/');
    assert.match(await page.text(), /与她有关的一切/);
    assert.equal((await fetch(base + '/api/config')).status, 401);
    const login = await fetch(base + '/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    assert.equal(login.status, 200);
    assert.match(login.headers.get('set-cookie'), /HttpOnly/);
    const saved = await api('/api/config', 'PUT', {
      contextWindowTokens: 32768,
      inputBudgetTokens: 18000,
      maxOutputTokens: 1024,
      temperature: 0.4,
      requestTimeoutSeconds: 30,
      turnTimeoutSeconds: 60,
    });
    assert.equal(saved.maxOutputTokens, 1024);
    assert.equal((await api('/api/config')).inputBudgetTokens, 18000);
    const artwork = await fetch(base + '/atri.webp');
    assert.equal(artwork.status, 200);
    assert.equal(artwork.headers.get('content-type'), 'image/webp');
    assert.equal((await api('/api/status')).recentUsage.length, 0);
    const backup = await api('/api/backup', 'POST');
    assert.equal(backup.messages, 0);
    console.log('Smoke passed: built server, login, artwork, live model settings, config, backup.');
  } finally {
    if (child && child.exitCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      await exited;
    }
    upstream.closeAllConnections();
    await new Promise((r) => upstream.close(r));
    const absolute = resolve(directory);
    if (!absolute.startsWith(resolve(tmpdir()) + sep + 'atri-smoke-'))
      throw new Error('测试清理路径无效');
    rmSync(absolute, { recursive: true, force: true });
  }
}

let failed = false;
if (wantUnit) {
  if (!apiPairs()) failed = true;
  if (!unitTests()) failed = true;
}
if (wantSmoke) {
  try {
    await smoke();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    failed = true;
  }
}
process.exit(failed ? 1 : 0);
