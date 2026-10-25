import { resolve, join } from 'node:path';
import { Store } from './db/index.js';
import { HttpModel, EmbeddingClient } from './llm.js';
import { Runtime, TavilyWeb } from './core/index.js';
import { Settings } from './api/config.js';
import { Stickers } from './api/stickers.js';
import { Sandbox } from './api/sandbox.js';
import { WeChatBridge } from './api/wechat.js';
import { createServer } from './api/server.js';

/** 入口：装配全部模块并启动。SQLite/WAL/媒体按 077 反掩码保持私有
 *  （数据目录里有原始聊天记录与模型密钥）。 */
process.umask(0o077);
const root = resolve(process.env.APP_ROOT || process.cwd());
const dataDir = resolve(process.env.DATA_DIR || join(root, 'data'));
const store = new Store(join(dataDir, 'atri.db'));
const settings = new Settings(store, root);
const stickers = new Stickers(root, dataDir, store);
const bridge = new WeChatBridge(store, settings, stickers, (message) => console.warn(message));
const embeddings = new EmbeddingClient(() => settings.embedding());
// 沙箱刻意放在 DATA_DIR 外：nsjail 会把数据目录遮蔽成空 tmpfs，工作
// 目录必须在遮蔽之外才能存活。
const sandbox = new Sandbox(resolve(dataDir, '..', 'sandbox'), {
  enabled: () => settings.config().sandboxEnabled,
  network: () => settings.config().sandboxNetwork,
  sizeLimitBytes: () => settings.config().sandboxSizeMb * 1024 * 1024,
  // 只限地址空间：rlimit 不需要 cgroup 权限，cgroup 方案要求宿主
  // --cgroupns=host，会破坏"docker compose up 就能跑"的承诺。0 不限制。
  memoryLimitMb: () => settings.config().sandboxMemoryMb,
  timeoutMs: () => settings.config().sandboxTimeoutSeconds * 1000,
  timeZone: () => settings.config().timeZone,
});
/** runtime 把 enabled 当硬开关，与凭据配置分开。 */
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
// 试聊的 preview 联系人要先存在，管理页列联系人时 GET 保持无写入。
store.ensurePeer('preview:default', 'preview', '本地试聊', '', true);
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  bridge.stop();
  // 卡死的提供商/传输不能拖过 Docker 的停止宽限期、带着打开的 WAL 被
  // SIGKILL：优雅路径给 30 秒硬顶，超时直接退出、不碰 store。
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
