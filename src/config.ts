import { object } from './types.ts';

export interface Endpoint {
  url: string;
  key: string;
  model: string;
  format: 'openai' | 'anthropic';
  contextTokens: number;
  outputTokens: number;
  timeoutMs: number;
  vision: boolean;
  json: boolean;
  completionTokens: boolean;
  cache: 'automatic' | 'openai' | 'anthropic';
  cacheRetention: 'default' | '24h' | '1h';
  temperature?: number;
  /** 强制 SSE 的渠道（如 openference 免费档）必须开：传输层聚合，对思考循环透明。 */
  stream: boolean;
  inputPrice: number;
  cachedPrice: number;
  cacheWritePrice: number;
  outputPrice: number;
}

export interface Config {
  primary: Endpoint;
  fallback: Endpoint;
  embedding: { url: string; key: string; model: string };
  qq: { appId: string; secret: string; enabled: boolean; sandbox: boolean; certified: boolean; passiveMinutes: number };
  life: {
    timezone: string;
    enabled: boolean;
    /** 心跳基准（分钟）：黏人度 0 时的拍长；黏人度 1 时约取 1/5。 */
    beatMinutes: number;
    /** 夜间整理轮的本地钟点（0–23）。 */
    diaryHour: number;
    sleepStart: number;
    sleepEnd: number;
    turnTimeoutMs: number;
    debounceMs: number;
    maxToolSteps: number;
  };
  web: { key: string; enabled: boolean };
  image: { enabled: boolean; engine: 'gpt' | 'nai'; gpt: { url: string; key: string; model: string }; nai: { url: string; key: string; model: string; steps: number } };
  execution: { enabled: boolean; image: string; timeoutMs: number; network: boolean };
  backup: { enabled: boolean; url: string; user: string; password: string; intervalHours: number };
  persona: string;
}

const endpoint = (): Endpoint => ({
  url: '', key: '', model: '', format: 'openai', contextTokens: 32768,
  outputTokens: 4096, timeoutMs: 120000, vision: true, json: false,
  completionTokens: false, cache: 'automatic', cacheRetention: 'default', stream: false,
  temperature: 1, inputPrice: 0, cachedPrice: 0, cacheWritePrice: 0, outputPrice: 0,
});

export const defaults = (persona = ''): Config => ({
  primary: endpoint(), fallback: endpoint(), embedding: { url: '', key: '', model: '' },
  qq: { appId: '', secret: '', enabled: false, sandbox: false, certified: true, passiveMinutes: 60 },
  life: {
    timezone: 'Asia/Shanghai', enabled: true, beatMinutes: 90, diaryHour: 23,
    sleepStart: 60, sleepEnd: 480, turnTimeoutMs: 300000, debounceMs: 700, maxToolSteps: 24,
  },
  web: { key: '', enabled: false }, image: { enabled: false, engine: 'gpt', gpt: { url: '', key: '', model: '' }, nai: { url: '', key: '', model: 'nai-diffusion-4-5-full', steps: 28 } },
  execution: { enabled: false, image: 'python:3.13-alpine', timeoutMs: 120000, network: false },
  backup: { enabled: false, url: '', user: '', password: '', intervalHours: 24 },
  persona,
});

const secretPaths = new Set(['primary.key', 'fallback.key', 'embedding.key', 'qq.secret', 'web.key', 'image.gpt.key', 'image.nai.key', 'backup.password']);

export function mergeConfig(current: Config, patch: unknown): Config {
  const input = object(patch);
  const next = structuredClone(current) as unknown as Record<string, unknown>;
  const merge = (target: Record<string, unknown>, source: Record<string, unknown>, prefix = ''): void => {
    for (const [key, value] of Object.entries(source)) {
      if (!Object.hasOwn(target, key)) throw new TypeError(`未知配置项 ${prefix}${key}`);
      const path = prefix + key;
      if (secretPaths.has(path) && value === '') continue;
      if (target[key] && typeof target[key] === 'object') merge(object(target[key]), object(value), `${path}.`);
      else target[key] = value;
    }
  };
  merge(next, input);
  return validateConfig(next as unknown as Config);
}

export function validateConfig(c: Config): Config {
  const num = (v: unknown, name: string, min: number, max: number): void => {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) throw new TypeError(`${name} 范围 ${min}–${max}`);
  };
  const bool = (v: unknown): void => { if (typeof v !== 'boolean') throw new TypeError('开关必须是布尔值'); };
  const url = (v: unknown): void => {
    if (typeof v !== 'string') throw new TypeError('地址必须是文本');
    if (!v) return;
    const parsed = new URL(v);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new TypeError('服务地址必须是无凭证、无查询参数的 HTTP(S) 地址');
  };
  for (const e of [c.primary, c.fallback]) {
    url(e.url);
    if (typeof e.key !== 'string' || typeof e.model !== 'string') throw new TypeError('模型配置无效');
    if (!['openai', 'anthropic'].includes(e.format) || !['automatic', 'openai', 'anthropic'].includes(e.cache) || !['default', '24h', '1h'].includes(e.cacheRetention)) throw new TypeError('模型协议或缓存配置无效');
    num(e.contextTokens, '上下文容量', 4096, 2000000);
    num(e.outputTokens, '最大输出', 256, 131072);
    if (e.outputTokens >= e.contextTokens) throw new TypeError('输出容量必须小于上下文容量');
    num(e.timeoutMs, '请求超时', 1000, 3600000);
    for (const v of [e.vision, e.json, e.completionTokens, e.stream]) bool(v);
    for (const v of [e.inputPrice, e.cachedPrice, e.cacheWritePrice, e.outputPrice]) num(v, '价格', 0, 100000);
    if (e.temperature !== undefined) num(e.temperature, 'temperature', 0, 2);
    if (e.cache === 'anthropic' && e.format !== 'anthropic') throw new TypeError('显式 Anthropic 缓存需要 Anthropic 协议');
    if (e.cacheRetention === '24h' && e.cache !== 'openai') throw new TypeError('24h 缓存必须由渠道明确支持 OpenAI 缓存字段');
    if (e.cacheRetention === '1h' && e.cache !== 'anthropic') throw new TypeError('1h 缓存需要显式 Anthropic 缓存');
  }
  for (const s of [c.embedding, c.image.gpt, c.image.nai]) { url(s.url); if (typeof s.key !== 'string' || typeof s.model !== 'string') throw new TypeError('工具渠道配置无效'); }
  if (!['gpt', 'nai'].includes(c.image.engine)) throw new TypeError('画笔引擎无效');
  num(c.image.nai.steps, 'NAI 步数', 1, 28); // 免费额度：28 步封顶，超出按全价计费
  if (typeof c.qq.appId !== 'string' || typeof c.qq.secret !== 'string') throw new TypeError('QQ 凭证无效');
  for (const v of [c.qq.enabled, c.qq.sandbox, c.qq.certified, c.life.enabled, c.web.enabled, c.image.enabled, c.execution.enabled, c.execution.network, c.backup.enabled]) bool(v);
  num(c.qq.passiveMinutes, 'QQ 被动回复有效期', 1, 60);
  try { new Intl.DateTimeFormat('en', { timeZone: c.life.timezone }).format(); } catch { throw new TypeError('时区无效'); }
  num(c.life.beatMinutes, '心跳基准', 15, 720);
  num(c.life.diaryHour, '日记钟点', 0, 23);
  num(c.life.sleepStart, '入睡分钟', 0, 1439); num(c.life.sleepEnd, '醒来分钟', 0, 1439);
  num(c.life.turnTimeoutMs, '思考超时', 1000, 7200000);
  num(c.life.debounceMs, '连发合并等待', 0, 10000);
  num(c.life.maxToolSteps, '每轮工具资源上限', 1, 256);
  if (!Number.isInteger(c.life.maxToolSteps)) throw new TypeError('工具上限必须为整数');
  if (typeof c.web.key !== 'string') throw new TypeError('搜索密钥无效');
  if (typeof c.execution.image !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]*$/.test(c.execution.image)) throw new TypeError('容器镜像名称无效');
  num(c.execution.timeoutMs, '执行超时', 1000, 3600000);
  url(c.backup.url); num(c.backup.intervalHours, '备份间隔', 1, 720);
  if (typeof c.backup.user !== 'string' || typeof c.backup.password !== 'string') throw new TypeError('备份凭证无效');
  if (typeof c.persona !== 'string' || !c.persona.trim() || c.persona.length > 30000) throw new TypeError('人格内容不能为空或超过 30000 字符');
  return c;
}

export function publicConfig(c: Config): Record<string, unknown> {
  const out = structuredClone(c) as unknown as Record<string, unknown>;
  for (const path of secretPaths) {
    const parts = path.split('.') as [string, ...string[]];
    const leaf = parts.at(-1)!, target = parts.slice(0, -1).reduce<Record<string, unknown>>((node, key) => object(node[key]), out);
    target[`${leaf}Configured`] = Boolean(target[leaf]);
    target[leaf] = '';
  }
  return out;
}

export const configured = (e: { url: string; key: string; model: string }): boolean => !!(e.url && e.key && e.model);

/** 当前引擎的画图渠道：双份配置各存一套，engine 只决定用哪份。 */
export const imageEndpoint = (c: Config): { url: string; key: string; model: string } => c.image.engine === 'nai' ? c.image.nai : c.image.gpt;

export function apiBase(url: string): string {
  const base = url.replace(/\/+$/, '');
  return /\/v\d+(?:beta)?$/.test(base) ? base : `${base}/v1`;
}
