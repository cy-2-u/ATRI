import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { defaults, mergeConfig, validateConfig, type Config } from './config.ts';
import { Store } from './store.ts';
import { Models } from './model.ts';
import { Recall } from './memory.ts';
import { Files } from './files.ts';
import { tools } from './tools.ts';
import { Context } from './context.ts';
import { Mind } from './mind.ts';
import { Runtime } from './runtime.ts';
import { QQ, normalizeEvent, type QQEvent } from './qq.ts';
import { AdminServer } from './server.ts';
import { Backups } from './backup.ts';
import { object, errorText } from './types.ts';
import { seedStickers } from './seed.ts';

const location = dirname(fileURLToPath(import.meta.url));
const root = location.endsWith(`${process.platform === 'win32' ? '\\' : '/'}dist${process.platform === 'win32' ? '\\' : '/'}src`) ? resolve(location, '../..') : resolve(location, '..');
const data = resolve(process.env.ATRI_DATA_DIR || join(root, 'data'));
await mkdir(data, { recursive: true, mode: 0o700 });
const store = new Store(join(data, 'atri.db'));
let config = store.get<Config>('config', defaults(await readFile(join(root, 'prompts', 'persona.md'), 'utf8')));
config.primary.cacheWritePrice ??= 0; config.fallback.cacheWritePrice ??= 0;
config.primary.temperature ??= 1; config.fallback.temperature ??= 1; // 存量配置无此键：mergeConfig 的 hasOwn 检查要求键必须存在
config.primary.stream ??= false; config.fallback.stream ??= false; // 同上：流式开关，旧配置默认非流式
config.image.enabled ??= false; // 旧存量配置无此键：默认关——她没有画笔，直到你打开开关
config.image.engine ??= 'gpt';
if (!config.image.gpt) {
  // 一次性迁移：旧扁平 image {url,key,model,naiSteps} → image.gpt 承接（双份配置各存一套）
  const old = config.image as unknown as Record<string, unknown>;
  config.image.gpt = { url: String(old.url ?? ''), key: String(old.key ?? ''), model: String(old.model ?? '') };
  config.image.nai = { url: '', key: '', model: 'nai-diffusion-4-5-full', steps: Number(old.naiSteps ?? 28) };
}
config.image.nai.steps ??= 28;
const patch: Record<string, unknown> = {};
if (!config.qq.appId && process.env.QQ_APP_ID) patch.qq = { appId: process.env.QQ_APP_ID, secret: process.env.QQ_APP_SECRET ?? '' };
if (!config.primary.url && process.env.LLM_BASE_URL) patch.primary = { url: process.env.LLM_BASE_URL, key: process.env.LLM_API_KEY ?? '', model: process.env.LLM_MODEL ?? '' };
config = Object.keys(patch).length ? mergeConfig(config, patch) : validateConfig(config);
store.set('config', config);
const privateFile = async (name: string, create: () => string): Promise<string> => {
  const path = join(data, name);
  try { return (await readFile(path, 'utf8')).trim(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const value = create(); await writeFile(path, `${value}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' }); return value;
  }
};
const password = process.env.ATRI_ADMIN_PASSWORD || await privateFile('admin-secret.txt', () => randomBytes(24).toString('base64url'));
if (password.length < 12) throw new Error('管理密码至少12字符');
const backupKey = Buffer.from(await privateFile('backup-key.txt', () => randomBytes(32).toString('hex')), 'hex');
if (backupKey.length !== 32) throw new Error('备份密钥格式无效');
const getConfig = (): Config => config;
const logError = (error: unknown): void => {
  let text = errorText(error);
  for (const secret of [config.primary.key, config.fallback.key, config.qq.secret, config.embedding.key, config.web.key, config.image.gpt.key, config.image.nai.key, config.backup.password]) if (secret) text = text.replaceAll(secret, '[已隐藏]');
  console.error(text);
};
const files = new Files(join(data, 'works'), getConfig); await files.init();
const seeded = await seedStickers(data, root, (key, fallback) => store.get(key, fallback), (key, value) => store.set(key, value));
if (seeded) console.log(`表情库入库：新增 ${seeded} 个（assets/stickers → 数据目录）`);
const models = new Models(getConfig, store), recall = new Recall(store, getConfig);
const context = new Context(store, getConfig, models, files, recall);
const mind = new Mind(store, getConfig, models, context, tools(store, getConfig, files, recall));
let runtime: Runtime;
const event = async (payload: QQEvent): Promise<void> => {
  const input = normalizeEvent(payload, store.now());
  if (input) { runtime.receive(input); return; }
  const d = payload.d && typeof payload.d === 'object' ? object(payload.d) : {};
  const type = payload.t ?? '';
  const id = String(d.user_openid ?? (d.author ? object(d.author).user_openid : '') ?? '');
  if (!id) return;
  // 她只属于一个人：陌生私聊的关系事件不进她的世界（与 runtime.receive 同一条绑定规则）。
  const bound = store.peers().find(p => p.id !== 'c2c:preview');
  if (bound && bound.id !== `c2c:${id}`) return;
  store.transaction(() => {
    const peer = store.ensurePeer({ kind: 'c2c', id });
    if (type === 'C2C_MSG_REJECT') store.savePeer({ ...peer, activeAllowed: false });
    else if (type === 'C2C_MSG_RECEIVE') store.savePeer({ ...peer, activeAllowed: true });
    else if (type === 'FRIEND_DEL') { store.savePeer({ ...peer, enabled: false, autonomous: false, activeAllowed: false }); store.dropJobs(peer.id); }
    store.append(peer.id, 'action', { platformEvent: type, succeeded: true, text: `平台关系状态：${type}` }, undefined, payload.id ? `qq-event:${payload.id}` : payload.s !== undefined ? `qq-event:${type}:${payload.s}` : undefined);
  });
  runtime.reconfigure();
};
const qq = new QQ(getConfig, store, event, logError);
runtime = new Runtime(store, getConfig, mind, qq, files, logError);
const backups = new Backups(store, getConfig, data, backupKey);
const host = process.env.ATRI_HOST || '127.0.0.1', port = Number(process.env.ATRI_PORT || 3010);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('端口无效');
const server = new AdminServer({ host, port, password, publicDir: join(root, 'public'), store, files, runtime, qq, models, backups, config: getConfig, update: next => {
  const changedQQ = JSON.stringify(next.qq) !== JSON.stringify(config.qq);
  config = next; store.set('config', config); runtime.reconfigure(); if (changedQQ) qq.reconfigure(); backups.reconfigure();
} });
const listening = await server.listen();
runtime.start(); qq.start(); backups.start();
console.log(`ATRI 管理界面：http://${host.includes(':') ? `[${host}]` : host}:${listening}`);
console.log(`管理密码来源：${process.env.ATRI_ADMIN_PASSWORD ? 'ATRI_ADMIN_PASSWORD 环境变量' : join(data, 'admin-secret.txt')}（不会打印密码）`);
console.log('新联系人默认不启用；请在管理界面明确批准。备份解密密钥请离线保管 backup-key.txt。');
let shuttingDown = false;
const shutdown = async (): Promise<void> => {
  if (shuttingDown) return; shuttingDown = true;
  await Promise.all([runtime.stop(), qq.stop(), backups.stop(), server.close()]); store.close();
};
process.once('SIGINT', () => { void shutdown().catch(logError); });
process.once('SIGTERM', () => { void shutdown().catch(logError); });
