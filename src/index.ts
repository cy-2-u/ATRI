import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { Journal } from './storage/journal.js';
import { Settings } from './settings.js';
import { ModelRouter } from './model/router.js';
import { httpTransport } from './model/http.js';
import { Mind } from './domain/mind.js';
import { LifeMaterial } from './domain/material.js';
import { lifeTools, TOOL_SETS } from './domain/tools.js';
import { EmbeddingClient, dripBackfill } from './domain/embeddings.js';
import { beatDelay } from './domain/state.js';
import { dayKeyOf, minutesOfDay, nextWakeAfter } from './domain/rhythm.js';
import { Runtime } from './runtime/runtime.js';
import { WechatBridge } from './wechat/bridge.js';
import { Stickers } from './stickers.js';
import { Sandbox } from './sandbox.js';
import { TavilyWeb } from './web.js';
import { createServer } from './server.js';

/** 装配层：把内核、身体、感官与管理面接成一个可运行的进程。
 *  她的一切都在这里获得宿主：数据库、人格、心跳、夜与手眼。 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const dataDir = resolve(process.env.XING_DATA_DIR || join(root, 'data'));
mkdirSync(dataDir, { recursive: true });

const readPrompt = (name: string, fallback: string): string => {
  try {
    return readFileSync(join(root, 'shared', 'prompts', name), 'utf8');
  } catch {
    return fallback;
  }
};

const journal = new Journal(join(dataDir, 'atri.db'));
const settings = new Settings(journal, process.env, {
  persona: readPrompt('persona.md', '你叫亚托莉，生活在虚拟世界中，有自己的兴趣、记忆和选择。'),
});
const config = () => settings.get();

const stickers = new Stickers(root, dataDir, journal);
// 沙箱目录独立于数据目录：nsjail 会把 /data 遮蔽成空 tmpfs，她的工作
// 目录必须活在遮蔽之外，否则命令 cwd 直接消失。
const sandboxDir = process.env.XING_SANDBOX_DIR || join(dataDir, 'sandbox');
const sandbox = config().sandbox.enabled
  ? new Sandbox(sandboxDir, {
      enabled: () => config().sandbox.enabled,
      sizeLimitBytes: () => config().sandbox.sizeLimitMb * 1024 * 1024,
      timeoutMs: () => config().sandbox.timeoutMs,
      memoryLimitMb: () => config().sandbox.memoryLimitMb,
      timeZone: () => config().timezone,
      network: () => config().sandbox.network,
    })
  : undefined;
const web = new TavilyWeb(() => config().webSearchKey);
const embeddings = new EmbeddingClient(() => ({
  baseUrl: config().embedding?.baseUrl ?? '',
  apiKey: config().embedding?.apiKey ?? '',
  model: config().embedding?.model ?? '',
}));

const onError = (error: unknown): void => {
  console.error('[xing]', error instanceof Error ? error.message : error);
};

const router = new ModelRouter(() => settings.routes(), httpTransport, {
  observe: ({ channel, model, completion, error }) => {
    if (completion)
      journal.recordUsage(
        channel,
        model,
        completion.usage.input,
        completion.usage.output,
        completion.usage.cached,
      );
    else if (error) journal.recordUsage(`${channel}:failed`, model, 0, 0, 0);
  },
});

const mind = new Mind(
  router,
  journal,
  lifeTools(journal, { sandbox, web: config().webSearchKey ? web : undefined }),
  readPrompt('life.md', ''),
  () => config().primary.inputTokens,
  TOOL_SETS,
);

const material = new LifeMaterial({
  journal,
  stickers,
  timeZone: () => config().timezone,
  sandboxEnabled: () => Boolean(sandbox?.enabled),
  webConfigured: () => Boolean(config().webSearchKey),
  vision: () => config().primary.vision,
  embeddings: config().embedding ? embeddings : undefined,
  now: Date.now,
});

const bridge = new WechatBridge(journal, onError, {
  stickers,
  sandbox,
  dataDir,
  vision: () => config().primary.vision,
});

// 下一拍：人格节拍 + 抖动 + 睡眠窗。心跳关掉就不再排拍。
const nextBeat = (): number | undefined => {
  const c = config();
  if (!c.heartbeat) return undefined;
  const due = Date.now() + beatDelay(journal.self(), Date.now(), c.closeness);
  return nextWakeAfter(due, c.timezone, c.sleepStart, c.sleepEnd);
};

const runtime = new Runtime(journal, mind, {
  persona: () => config().persona,
  material: (turn) => material.build(turn.peer, turn).then((built) => built.material),
  send: (peer, part) => bridge.send(peer, part),
  nextBeat,
  onComposing: (peer, active) => bridge.composing(peer, active),
  onError,
  timeoutMs: () => config().turnTimeoutMs,
  debounceMs: () => config().debounceMs,
  concurrency: () => config().concurrency,
  pacing: () => true,
  stickerSlugs: () => new Set(stickers.list().map((item) => item.slug)),
  vision: () => config().primary.vision,
  readFile: (_peer: string, path: string, maxBytes: number) =>
    Promise.resolve(bridge.readMedia(path, maxBytes)),
});

/** 夜间任务排期：日记与整理各自每天一次（日记点 + 1 小时）。幂等：
 *  有排期或正在跑就不动；到点被领走后这里会排向下一个 occurrence。 */
function ensureNightJobs(): void {
  const c = config();
  const now = Date.now();
  for (const peer of journal.peers()) {
    for (const kind of ['diary', 'tidy'] as const) {
      if (journal.jobs().some((job) => job.peer === peer && job.kind === kind)) continue;
      if (journal.turnRunning(peer, kind)) continue;
      const hour = kind === 'diary' ? c.diaryHour : (c.diaryHour + 1) % 24;
      journal.schedule(peer, kind, nextLocalHour(now, hour, c.timezone));
    }
  }
}

/** 目标时区里下一个 hour 点整。DST 变更日最多偏一小时，中国时区无此问题。 */
function nextLocalHour(now: number, hour: number, timeZone: string): number {
  const midnightGuess = Date.parse(`${dayKeyOf(now, timeZone)}T00:00:00Z`);
  const midnight = midnightGuess - minutesOfDay(midnightGuess, timeZone) * 60000;
  let candidate = midnight + hour * 3_600_000;
  if (candidate <= now) candidate += 86_400_000;
  return candidate;
}

// 管理密码：环境变量优先；没有就生成一次并写进数据目录。
function adminPassword(): string {
  if (process.env.ADMIN_PASSWORD && process.env.ADMIN_PASSWORD.length >= 12)
    return process.env.ADMIN_PASSWORD;
  const secretPath = join(dataDir, 'admin-secret.txt');
  if (existsSync(secretPath)) {
    const saved = readFileSync(secretPath, 'utf8').trim();
    if (saved.length >= 12) return saved;
  }
  const secret = randomBytes(12).toString('base64url');
  writeFileSync(secretPath, secret, { mode: 0o600 });
  return secret;
}

const app = createServer({
  password: adminPassword(),
  settings,
  journal,
  router,
  runtime,
  bridge,
  stickers,
  sandbox,
  webConfigured: () => Boolean(config().webSearchKey),
  staticRoot: join(root, 'public'),
  assetsRoot: join(root, 'assets', 'stickers'),
});

const port = Number(process.env.XING_PORT || 3000);
const host = process.env.XING_BIND || '127.0.0.1';

function startBackgroundMaintenance(): void {
  // 夜间排期与向量滴灌都是分钟级维护：低频定时器，空闲时零开销。
  const night = setInterval(ensureNightJobs, 10 * 60_000);
  night.unref();
  ensureNightJobs();
  const drip = setInterval(() => {
    const client = config().embedding ? embeddings : undefined;
    if (!client?.configured) return;
    for (const peer of journal.peers()) dripBackfill(journal, client, peer).catch(onError);
  }, 5 * 60_000);
  drip.unref();
}

app
  .listen({ port, host })
  .then(() => {
    console.log(`xing listening on http://${host}:${port}`);
    bridge.start(runtime);
    runtime.start();
    startBackgroundMaintenance();
  })
  .catch((error) => {
    onError(error);
    process.exit(1);
  });

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await runtime.stop();
    await bridge.stop();
    sandbox?.dispose();
    journal.close();
  } finally {
    process.exit(0);
  }
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
