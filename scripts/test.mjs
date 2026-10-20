// Single entry point for every check in the repo.
//
//   node scripts/test.mjs          unit tests + management-UI/API pairing
//   node scripts/test.mjs --smoke  built-server smoke test (run `npm run build` first)
//   node scripts/test.mjs --all    both, in that order
//
// The API pairing check and the smoke test used to be separate scripts. One
// entry keeps the documented command list short and gives a new check an
// obvious home; the flags keep the expensive path opt-in because `npm test`
// runs inside `npm run check` before `npm run build`.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

const args = new Set(process.argv.slice(2));
const wantSmoke = args.has('--smoke') || args.has('--all');
const wantUnit = !args.has('--smoke') || args.has('--all');

function testFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? testFiles(join(dir, entry.name))
      : entry.name.endsWith('.test.ts')
        ? [join(dir, entry.name)]
        : [],
  );
}

function unitTests() {
  console.log('\n# Unit tests');
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', '--test', ...testFiles('packages'), ...testFiles('tests')],
    { stdio: 'inherit' },
  );
  return result.status === 0;
}

// --- Management UI vs. Fastify routes ---------------------------------------
// The UI side used to be a hand-maintained list of paths, which drifted every
// time a route changed and reported live routes as dead. Now both sides are
// read from source: routes from server.ts, calls from app.js.

const VERBS = '(get|post|put|delete)';

/** Routes: inline `app.get('/x', ...)` plus the split form where the path wraps. */
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

/** Split an argument list at top-level commas, respecting nesting and strings. */
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

/**
 * Expand the branches of a ternary so a call like
 *   `'/x/' + enc(id) + (off ? '/enable' : '')`
 * yields both `/x/:p/enable` (POST) and `/x/:p` (DELETE).
 * Returns every reachable reading, capped so a pathological expression cannot
 * blow up the search.
 */
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

/** Every `api(...)` call in the UI, as [method, path]. */
function uiCalls(appJs) {
  const calls = [];
  const re = /\bapi\(/g;
  let m;
  while ((m = re.exec(appJs))) {
    // Skip the `async function api(path, method, body)` declaration itself.
    if (/function\s+$/.test(appJs.slice(Math.max(0, m.index - 20), m.index))) continue;

    const callArgs = splitArgs(appJs, m.index + m[0].length);
    if (!callArgs[0]) continue;

    // A path is built from string literals and `enc(id)` calls. Substituting a
    // quoted sentinel first keeps the placeholders in the right order; pulling
    // only the quoted literals afterwards would silently drop every `enc()`.
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
    // Path and method branches come from the same condition, so pair them by
    // index instead of forming a cross product — `x ? '/enable' : ''` with
    // `x ? 'POST' : 'DELETE'` must not yield POST-with-no-enable.
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

/** `:param` matches exactly one non-empty segment. */
function matches(routePath, callPath) {
  const r = routePath.split('/');
  const c = callPath.split('?')[0].split('/');
  if (r.length !== c.length) return false;
  return r.every((seg, i) => (seg.startsWith(':') ? c[i].length > 0 : seg === c[i]));
}

function apiPairs() {
  console.log('# Management UI / API pairing');
  const server = readFileSync('apps/api/src/server.ts', 'utf8');
  const appJs = readFileSync('apps/api/public/app.js', 'utf8');
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

  // A route with no UI caller is either dead or a documented API for scripts.
  const API_ONLY = new Set([
    'GET /healthz',
    'GET /',
    'GET /app.js',
    'GET /app.css',
    'GET /atri.webp',
    // Built dynamically by the sticker panel (`/api/stickers/${slug}/image`);
    // the call never appears as a literal path in app.js.
    'GET /api/stickers/:slug/image',
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

// --- Built-server smoke -------------------------------------------------------

async function smoke() {
  console.log('\n# Smoke test');
  const serverEntry = 'dist/server.js';
  if (!existsSync(serverEntry)) {
    throw new Error(`${serverEntry} 不存在，先运行 npm run build`);
  }
  const directory = mkdtempSync(join(tmpdir(), 'atri-smoke-'));
  const password = 'smoke-test-password-only';
  let calls = 0;
  let child;
  let logs = '';
  let lastRequest;
  const upstream = createServer(async (request, response) => {
    try {
      let data = '';
      for await (const chunk of request) data += chunk;
      const body = JSON.parse(data);
      lastRequest = body;
      calls++;
      const sourceText = body.messages
        .map((m) => (typeof m.content === 'string' ? m.content : ''))
        .join('\n');
      const sources = [
        ...new Set([...sourceText.matchAll(/\[来源 ([^\s|]+) \|/g)].map((m) => m[1])),
      ];
      const diary = body.messages[0].content.includes('"sections"');
      const result = diary
        ? {
            sections: [{ content: '今天听他说起喜欢的茶，我认真记住了。', sources }],
            memoryUpdates: [],
          }
        : {
            messages: ['我记住啦，你喜欢喝茶。'],
            memoryUpdates: [{ content: '喜欢喝茶', kind: 'stated', sources: sources.slice(-1) }],
          };
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: JSON.stringify(result) } }],
          usage: { prompt_tokens: 100, completion_tokens: 30 },
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
      cwd: process.cwd(),
      env: {
        ...process.env,
        APP_ROOT: process.cwd(),
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
    async function task(id) {
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        const result = await api('/api/tasks/' + encodeURIComponent(id));
        if (result.state === 'done') return;
        if (['failed', 'superseded'].includes(result.state))
          throw new Error(JSON.stringify(result));
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error('任务未完成');
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
    const chat = await api('/api/chat', 'POST', {
      content: '我喜欢喝茶',
      eventId: 'smoke-message',
    });
    await task(chat.taskId);
    const history = await api('/api/peers/preview%3Adefault/history');
    assert.equal(history.length, 2);
    assert.equal(history[1].role, 'assistant');
    assert.equal(calls, 1);
    assert.equal(lastRequest.max_tokens, 1024);
    assert.equal(lastRequest.temperature, 0.4);
    await api('/api/chat', 'POST', { content: '我喜欢喝茶', eventId: 'smoke-message' });
    assert.equal(calls, 1);
    const memories = await api('/api/peers/preview%3Adefault/memories');
    assert.equal(memories.length, 1);
    const diary = await api('/api/peers/preview%3Adefault/diary', 'POST');
    await task(diary.taskId);
    assert.equal(lastRequest.max_tokens, 1024);
    assert.equal((await api('/api/peers/preview%3Adefault/diaries')).length, 1);
    assert.equal((await api('/api/status')).recentUsage.length, 2);
    const backup = await api('/api/backup', 'POST');
    assert.equal(backup.messages, 2);
    console.log(
      'Smoke passed: built server, login, artwork, live model settings, durable chat, dedup, memory, diary, usage, backup.',
    );
    if (process.argv.includes('--serve')) {
      console.log(`UI test preview: ${base}`);
      await new Promise((resolveWait) => {
        const done = () => {
          clearTimeout(timer);
          process.removeListener('SIGINT', done);
          process.removeListener('SIGTERM', done);
          resolveWait();
        };
        const timer = setTimeout(done, 20 * 60000);
        process.once('SIGINT', done);
        process.once('SIGTERM', done);
      });
    }
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
