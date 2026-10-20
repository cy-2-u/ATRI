import { resolve, join } from 'node:path';
import { Store } from '@atri/db';
import { HttpModel, EmbeddingClient } from '@atri/llm';
import { Runtime, TavilyWeb } from '@atri/core';
import { Settings } from './config.js';
import { Stickers } from './stickers.js';
import { Sandbox } from './sandbox.js';
import { WeChatBridge } from './wechat.js';
import { createServer } from './server.js';

// Keep SQLite, WAL/SHM and any media created by the process private even when
// the host runs with a permissive umask. The data directory contains raw chat
// logs and model keys; backups already use explicit 0600/0700 modes.
process.umask(0o077);
const root = resolve(process.env.APP_ROOT || process.cwd());
const dataDir = resolve(process.env.DATA_DIR || join(root, 'data'));
const store = new Store(join(dataDir, 'atri.db'));
const settings = new Settings(store, root);
const stickers = new Stickers(root, dataDir, store);
const bridge = new WeChatBridge(store, settings, stickers, (message) => console.warn(message));
const embeddings = new EmbeddingClient(() => settings.embedding());
// The sandbox lives outside DATA_DIR on purpose: nsjail hides the app's data
// directory behind an empty tmpfs, and the working directory has to survive that.
const sandbox = new Sandbox(resolve(dataDir, '..', 'sandbox'), {
  enabled: () => settings.config().sandboxEnabled,
  network: () => settings.config().sandboxNetwork,
  sizeLimitBytes: () => settings.config().sandboxSizeMb * 1024 * 1024,
  // Address space cap only; nsjail needs no cgroup access for rlimits, and a
  // cgroup-backed limit would require --cgroupns=host on the host, which would
  // break the "just docker compose up" promise. 0 = unlimited.
  memoryLimitMb: () => settings.config().sandboxMemoryMb,
  timeZone: () => settings.config().timeZone,
});
/** The runtime treats `enabled` as a hard off switch, separate from creds. */
const embedder = {
  get configured() {
    return embeddings.configured;
  },
  get model() {
    return embeddings.model;
  },
  get enabled() {
    return settings.embeddingEnabled();
  },
  embed: (texts: string[], signal?: AbortSignal) => embeddings.embed(texts, signal),
};
const runtime = new Runtime({
  store,
  config: () => settings.runtime(),
  model: () => new HttpModel(settings.model()),
  prompt: (name) => settings.prompt(name),
  personaFor: (peerId) => settings.personaContentFor(peerId),
  stickers: () => stickers.list(),
  web: new TavilyWeb(() => settings.config().tavilyKey),
  timeZone: () => settings.config().timeZone,
  contextTokens: () => settings.runtime().contextTokens,
  turnTimeoutMs: () => settings.runtime().turnTimeoutMs,
  images: (message, signal) => bridge.images(message, signal),
  transport: bridge,
  log: (message, details) => console.warn(message, details),
  embedder,
  sandbox,
  embedQuery: async (query, signal) => {
    if (!settings.embeddingEnabled()) return undefined;
    const [vector] = await embeddings.embed([query], signal);
    return vector && vector.some((v) => v !== 0) ? vector : undefined;
  },
  embeddingModel: () => settings.embedding().model,
});
const app = createServer({ store, settings, stickers, bridge, runtime, sandbox });
// The 试聊 preview peer must exist before the admin UI lists contacts, so the
// contacts GET stays write-free.
store.ensurePeer('preview:default', 'preview', '本地试聊', '', true);
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  bridge.stop();
  // A wedged provider/transport must not hold the container past Docker's
  // stop grace period and get SIGKILLed with an open SQLite WAL. Give the
  // graceful path a hard ceiling, then leave without touching the store.
  const graceful = (async () => {
    await runtime.stop();
    await app.close();
  })();
  const timedOut = await Promise.race([
    graceful.then(() => false),
    new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(true), 30000);
      timer.unref();
    }),
  ]);
  if (timedOut) {
    console.error('关闭超时，强制退出');
    process.exit(1);
  }
  sandbox.dispose();
  store.close();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
const address = await app.listen({ host: settings.host, port: settings.port });
runtime.start();
bridge.start(runtime);
console.log(`ATRI 已启动：${address}`);
if (!process.env.ADMIN_PASSWORD)
  console.log(`首次管理密码保存在 ${join(dataDir, 'admin-secret.txt')}，请在服务器上读取。`);
