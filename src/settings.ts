import type { Endpoint, Format } from './model/types.js';
import type { Routes } from './model/router.js';
import { Journal } from './storage/journal.js';

export interface SandboxConfig {
  enabled: boolean;
  network: boolean;
  sizeLimitMb: number;
  memoryLimitMb: number;
  timeoutMs: number;
}

export interface EmbeddingConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** 她的画笔：OpenAI 兼容 images/generations 端点，GPT 与 NAI 双引擎
 *  各存一套凭据（切换零重填）。NAI 走 rinko 兼容中转，请求体多一层
 *  parameters（步数免费档 28 封顶），提示词格式也不同（danbooru tag）。 */
export interface ImageConfig {
  engine: 'gpt' | 'nai';
  baseUrl: string;
  apiKey: string;
  model: string;
  nai?: { baseUrl: string; apiKey: string; model: string; steps: number };
}

/** WebDAV 每日备份的目的地：地址/账号/密码，填齐即启用。 */
export interface WebDavConfig {
  url: string;
  user: string;
  password: string;
}

export interface Config {
  primary: Endpoint;
  fallback?: Endpoint;
  embedding?: EmbeddingConfig;
  image?: ImageConfig;
  webdav?: WebDavConfig;
  heartbeat: boolean;
  /** 黏人度种子：只在第一次启动时种进她的自我，此后由相处演化（relation.ts）。 */
  closeness: number;
  timezone: string;
  sleepStart: number;
  sleepEnd: number;
  diaryHour: number;
  turnTimeoutMs: number;
  debounceMs: number;
  concurrency: number;
  persona: string;
  webSearchKey: string;
  sandbox: SandboxConfig;
}

function integer(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max)
    throw new TypeError(`${name} 必须是 ${min}–${max} 的整数`);
  return value;
}

function boolean(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') throw new TypeError(`${name} 必须是布尔值`);
  return value;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError('配置必须是对象');
  return value as Record<string, unknown>;
}

function endpoint(value: unknown, previous: Endpoint): Endpoint {
  const patch = record(value);
  const allowed = new Set([
    'format',
    'baseUrl',
    'apiKey',
    'model',
    'vision',
    'timeoutMs',
    'maxTokens',
    'inputTokens',
    'retries',
    'temperature',
  ]);
  for (const key of Object.keys(patch))
    if (!allowed.has(key)) throw new TypeError(`未知渠道配置项：${key}`);
  const merged = { ...previous, ...patch };
  if (!['openai', 'anthropic', 'gemini'].includes(String(merged.format)))
    throw new TypeError('模型协议无效');
  // 地址留空保持旧值（与密钥同一语义）；首次连旧值都没有才报人话，
  // 不让用户对着裸 Invalid URL 猜。
  if (!String(merged.baseUrl).trim()) {
    if (!previous.baseUrl) throw new TypeError('请填写渠道地址');
    merged.baseUrl = previous.baseUrl;
  }
  const url = new URL(String(merged.baseUrl));
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new TypeError('渠道地址必须是无凭据、查询参数和片段的 HTTP 地址');
  if (typeof merged.model !== 'string' || !merged.model.trim() || merged.model.length > 200)
    throw new TypeError('模型名称无效');
  if (patch.apiKey !== undefined && typeof patch.apiKey !== 'string')
    throw new TypeError('密钥必须是字符串');
  // 留空保持旧密钥；换密钥直接贴新的。"清除已存密钥"入口已删——
  // 换钥匙是常态，拔钥匙不是。
  const apiKey =
    typeof patch.apiKey === 'string' && patch.apiKey.trim() ? patch.apiKey.trim() : previous.apiKey;
  const result: Endpoint = {
    format: merged.format as Format,
    baseUrl: url.toString().replace(/\/+$/, ''),
    apiKey,
    model: merged.model.trim(),
    vision: boolean(merged.vision, 'vision'),
    timeoutMs: integer(merged.timeoutMs, 'timeoutMs', 1000, 180_000),
    maxTokens: integer(merged.maxTokens, 'maxTokens', 128, 32_768),
    inputTokens: integer(merged.inputTokens, 'inputTokens', 1024, 1_000_000),
    retries: integer(merged.retries, 'retries', 0, 4),
  };
  // 温度留空 = 1：各上游的默认值五花八门，显式钉住她的说话手感。
  result.temperature = 1;
  if (merged.temperature !== undefined) {
    if (
      typeof merged.temperature !== 'number' ||
      !Number.isFinite(merged.temperature) ||
      merged.temperature < 0 ||
      merged.temperature > 2
    )
      throw new TypeError('temperature 必须在 0–2 之间');
    result.temperature = merged.temperature;
  }
  return result;
}

function sandboxConfig(value: unknown, previous: SandboxConfig): SandboxConfig {
  const patch = record(value);
  const merged = { ...previous, ...patch };
  return {
    enabled: boolean(merged.enabled, 'sandbox.enabled'),
    network: boolean(merged.network, 'sandbox.network'),
    sizeLimitMb: integer(merged.sizeLimitMb, 'sandbox.sizeLimitMb', 0, 65536),
    memoryLimitMb: integer(merged.memoryLimitMb, 'sandbox.memoryLimitMb', 0, 65536),
    timeoutMs: integer(merged.timeoutMs, 'sandbox.timeoutMs', 0, 1_800_000),
  };
}

function embeddingConfig(
  value: unknown,
  previous: EmbeddingConfig | undefined,
): EmbeddingConfig | undefined {
  if (value === null) return undefined;
  const patch = record(value ?? {});
  const merged = { baseUrl: '', apiKey: '', model: '', ...(previous ?? {}), ...patch };
  for (const key of ['baseUrl', 'apiKey', 'model'] as const)
    if (merged[key] !== undefined && merged[key] !== '' && typeof merged[key] !== 'string')
      throw new TypeError(`embedding.${key} 必须是字符串`);
  if (!merged.model && !merged.apiKey) return undefined;
  if (!merged.model || !merged.apiKey) throw new TypeError('向量检索需要 model 与 apiKey 同时配置');
  // baseUrl 留空保持旧值（前端另有"退主渠道地址"的兜底，这里守 API 直调）。
  if (!String(merged.baseUrl).trim()) {
    if (!previous?.baseUrl) throw new TypeError('请填写向量服务地址');
    merged.baseUrl = previous.baseUrl;
  }
  const url = new URL(String(merged.baseUrl));
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new TypeError('向量地址必须是无凭据的 HTTP 地址');
  return {
    baseUrl: url.toString().replace(/\/+$/, ''),
    apiKey: String(merged.apiKey),
    model: String(merged.model),
  };
}

function imageConfig(value: unknown, previous: ImageConfig | undefined): ImageConfig | undefined {
  if (value === null) return undefined;
  const patch = record(value ?? {});
  const merged = {
    engine: 'gpt' as string,
    baseUrl: '',
    apiKey: '',
    model: '',
    ...(previous ?? {}),
    ...patch,
  };
  for (const key of ['baseUrl', 'apiKey', 'model'] as const)
    if (merged[key] !== undefined && merged[key] !== '' && typeof merged[key] !== 'string')
      throw new TypeError(`image.${key} 必须是字符串`);
  if (merged.engine !== 'gpt' && merged.engine !== 'nai')
    throw new TypeError("image.engine 必须是 'gpt' 或 'nai'");
  if (!merged.model && !merged.apiKey) return undefined;
  if (!merged.model || !merged.apiKey) throw new TypeError('画图需要 model 与 apiKey 同时配置');
  // baseUrl 留空保持旧值（前端另有"退主渠道地址"的兜底，这里守 API 直调）。
  if (!String(merged.baseUrl).trim()) {
    if (!previous?.baseUrl) throw new TypeError('请填写画图服务地址');
    merged.baseUrl = previous.baseUrl;
  }
  const url = new URL(String(merged.baseUrl));
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new TypeError('画图地址必须是无凭据的 HTTP 地址');
  // NAI 子配置：只校验提交了的字段——空 = 没配（engine 切 nai 时前端先填）。
  let nai: ImageConfig['nai'];
  const rawNai =
    patch.nai === undefined ? (previous?.nai ? { ...previous.nai } : undefined) : patch.nai;
  if (rawNai !== undefined && rawNai !== null) {
    const naiPatch = record(rawNai);
    const naiMerged = { baseUrl: '', apiKey: '', model: '', steps: 28, ...(naiPatch ?? {}) };
    for (const key of ['baseUrl', 'apiKey', 'model'] as const)
      if (
        naiMerged[key] !== undefined &&
        naiMerged[key] !== '' &&
        typeof naiMerged[key] !== 'string'
      )
        throw new TypeError(`image.nai.${key} 必须是字符串`);
    if (naiMerged.model && naiMerged.apiKey) {
      if (!String(naiMerged.baseUrl).trim()) {
        if (!previous?.nai?.baseUrl) throw new TypeError('请填写 NAI 画图服务地址');
        naiMerged.baseUrl = previous.nai.baseUrl;
      }
      const naiUrl = new URL(String(naiMerged.baseUrl));
      if (
        !['http:', 'https:'].includes(naiUrl.protocol) ||
        naiUrl.username ||
        naiUrl.password ||
        naiUrl.search ||
        naiUrl.hash
      )
        throw new TypeError('NAI 画图地址必须是无凭据的 HTTP 地址');
      const steps = Number(naiMerged.steps);
      if (!Number.isInteger(steps) || steps < 1 || steps > 28)
        throw new TypeError('image.nai.steps 必须是 1–28 的整数（免费档 28 步封顶）');
      nai = {
        baseUrl: naiUrl.toString().replace(/\/+$/, ''),
        apiKey: String(naiMerged.apiKey),
        model: String(naiMerged.model),
        steps,
      };
    }
  }
  return {
    engine: merged.engine as ImageConfig['engine'],
    baseUrl: url.toString().replace(/\/+$/, ''),
    apiKey: String(merged.apiKey),
    model: String(merged.model),
    ...(nai ? { nai } : {}),
  };
}

function webdavConfig(
  value: unknown,
  previous: WebDavConfig | undefined,
): WebDavConfig | undefined {
  if (value === null) return undefined;
  const patch = record(value ?? {});
  const merged = { url: '', user: '', password: '', ...(previous ?? {}), ...patch };
  for (const key of ['url', 'user', 'password'] as const)
    if (merged[key] !== undefined && merged[key] !== '' && typeof merged[key] !== 'string')
      throw new TypeError(`webdav.${key} 必须是字符串`);
  // 三项全空 = 没配备份；半空报人话，不让用户对着 HTTP 401 猜。
  if (!String(merged.url).trim() && !String(merged.password).trim()) return undefined;
  if (!String(merged.url).trim()) throw new TypeError('备份需要 WebDAV 地址');
  if (!String(merged.password).trim()) throw new TypeError('备份需要 WebDAV 密码');
  const url = new URL(String(merged.url).trim());
  if (!['http:', 'https:'].includes(url.protocol))
    throw new TypeError('WebDAV 地址必须是 HTTP 地址');
  return {
    url: url.toString().replace(/\/+$/, ''),
    user: String(merged.user ?? '').trim(),
    password: String(merged.password),
  };
}

export class Settings {
  private value: Config;

  constructor(
    private readonly journal: Journal,
    env: NodeJS.ProcessEnv = process.env,
    defaults?: Partial<Config>,
  ) {
    const primary: Endpoint = {
      format: (env.LLM_FORMAT || 'openai') as Format,
      baseUrl: env.LLM_BASE_URL || 'https://api.deepseek.com',
      apiKey: env.LLM_API_KEY || '',
      model: env.LLM_MODEL || 'deepseek-chat',
      vision: env.LLM_VISION === 'true',
      timeoutMs: 45_000,
      maxTokens: 3000,
      // 她的思考一轮 = 人格 + 素材 + 160 条历史 + 工具定义，24000 的预算
      // 连心跳都装不下（生产实锤：连续 budget failure）。
      inputTokens: 256_000,
      retries: 2,
    };
    const fallback = env.FALLBACK_LLM_MODEL
      ? {
          ...primary,
          format: (env.FALLBACK_LLM_FORMAT || 'openai') as Format,
          baseUrl: env.FALLBACK_LLM_BASE_URL || primary.baseUrl,
          apiKey: env.FALLBACK_LLM_API_KEY || '',
          model: env.FALLBACK_LLM_MODEL,
          vision: env.FALLBACK_LLM_VISION === 'true',
        }
      : undefined;
    const embedding =
      env.EMBEDDING_MODEL && env.EMBEDDING_API_KEY
        ? {
            baseUrl: env.EMBEDDING_BASE_URL || primary.baseUrl,
            apiKey: env.EMBEDDING_API_KEY,
            model: env.EMBEDDING_MODEL,
          }
        : undefined;
    const image =
      env.IMAGE_MODEL && env.IMAGE_API_KEY
        ? {
            engine: 'gpt' as const,
            baseUrl: env.IMAGE_BASE_URL || primary.baseUrl,
            apiKey: env.IMAGE_API_KEY,
            model: env.IMAGE_MODEL,
          }
        : undefined;
    const base: Config = {
      primary,
      ...(fallback ? { fallback } : {}),
      ...(embedding ? { embedding } : {}),
      ...(image ? { image } : {}),
      ...(env.WEBDAV_URL && env.WEBDAV_PASSWORD
        ? {
            webdav: {
              url: env.WEBDAV_URL,
              user: env.WEBDAV_USER || '',
              password: env.WEBDAV_PASSWORD,
            },
          }
        : {}),
      heartbeat: false,
      closeness: 50,
      timezone: env.TZ || 'Asia/Shanghai',
      sleepStart: 60,
      sleepEnd: 420,
      diaryHour: 3,
      turnTimeoutMs: 180_000,
      debounceMs: 800,
      concurrency: 3,
      persona: '你叫亚托莉，生活在虚拟世界中，有自己的兴趣、记忆和选择。',
      webSearchKey: env.TAVILY_API_KEY || '',
      sandbox: {
        enabled: env.SANDBOX_ENABLED === 'true',
        network: env.SANDBOX_NETWORK === 'true',
        sizeLimitMb: env.SANDBOX_SIZE_MB ? Number(env.SANDBOX_SIZE_MB) || 512 : 512,
        memoryLimitMb: env.SANDBOX_MEMORY_MB ? Number(env.SANDBOX_MEMORY_MB) || 2048 : 2048,
        timeoutMs: 600_000,
      },
    };
    this.value = base;
    const saved = journal.setting<Record<string, unknown> | undefined>('config', undefined);
    this.value = this.validate({ ...base, ...defaults, ...(saved ?? {}) });
  }

  private validate(value: unknown): Config {
    const patch = record(value);
    const allowed = new Set([
      'primary',
      'fallback',
      'embedding',
      'image',
      'webdav',
      'heartbeat',
      'closeness',
      'timezone',
      'sleepStart',
      'sleepEnd',
      'diaryHour',
      'turnTimeoutMs',
      'debounceMs',
      'concurrency',
      'persona',
      'webSearchKey',
      'sandbox',
    ]);
    for (const key of Object.keys(patch))
      if (!allowed.has(key)) throw new TypeError(`未知配置项：${key}`);
    const previous = this.value;
    const primary = endpoint(patch.primary ?? {}, previous.primary);
    const fallback =
      patch.fallback === null
        ? undefined
        : patch.fallback === undefined
          ? previous.fallback
          : endpoint(patch.fallback, previous.fallback ?? { ...primary, apiKey: '' });
    const embedding =
      patch.embedding === undefined
        ? previous.embedding
        : embeddingConfig(patch.embedding, previous.embedding);
    const image =
      patch.image === undefined ? previous.image : imageConfig(patch.image, previous.image);
    const webdav =
      patch.webdav === undefined ? previous.webdav : webdavConfig(patch.webdav, previous.webdav);
    if (typeof patch.webSearchKey !== 'undefined' && typeof patch.webSearchKey !== 'string')
      throw new TypeError('搜索密钥必须是字符串');
    const webSearchKey =
      typeof patch.webSearchKey === 'string' ? patch.webSearchKey : previous.webSearchKey;
    const sandbox =
      patch.sandbox === undefined
        ? previous.sandbox
        : sandboxConfig(patch.sandbox, previous.sandbox);
    const timezone = typeof patch.timezone === 'string' ? patch.timezone : previous.timezone;
    try {
      new Intl.DateTimeFormat('en', { timeZone: timezone }).format();
    } catch {
      throw new TypeError('时区无效');
    }
    const persona = typeof patch.persona === 'string' ? patch.persona : previous.persona;
    if (!persona.trim() || persona.length > 20_000) throw new TypeError('人格内容无效');
    const turnTimeoutMs = integer(
      mergedNumber(patch, previous, 'turnTimeoutMs'),
      'turnTimeoutMs',
      5000,
      600_000,
    );
    if (turnTimeoutMs < primary.timeoutMs + (fallback?.timeoutMs ?? 0))
      throw new TypeError('整轮超时必须容纳主、备渠道各一次请求');
    const heartbeat =
      patch.heartbeat === undefined ? previous.heartbeat : boolean(patch.heartbeat, 'heartbeat');
    return {
      primary,
      ...(fallback ? { fallback } : {}),
      ...(embedding ? { embedding } : {}),
      ...(image ? { image } : {}),
      ...(webdav ? { webdav } : {}),
      heartbeat,
      closeness: integer(mergedNumber(patch, previous, 'closeness'), 'closeness', 0, 100),
      timezone,
      sleepStart: integer(mergedNumber(patch, previous, 'sleepStart'), 'sleepStart', 0, 1439),
      sleepEnd: integer(mergedNumber(patch, previous, 'sleepEnd'), 'sleepEnd', 0, 1439),
      diaryHour: integer(mergedNumber(patch, previous, 'diaryHour'), 'diaryHour', 0, 23),
      turnTimeoutMs,
      debounceMs: integer(mergedNumber(patch, previous, 'debounceMs'), 'debounceMs', 0, 10_000),
      concurrency: integer(mergedNumber(patch, previous, 'concurrency'), 'concurrency', 1, 16),
      persona: persona.trim(),
      webSearchKey,
      sandbox,
    };
  }

  get(): Config {
    return structuredClone(this.value);
  }
  routes(): Routes {
    return {
      primary: { ...this.value.primary },
      ...(this.value.fallback ? { fallback: { ...this.value.fallback } } : {}),
    };
  }

  public(): Record<string, unknown> {
    const redact = (value: Endpoint) => {
      const { apiKey, ...safe } = value;
      return { ...safe, hasApiKey: Boolean(apiKey) };
    };
    const { webSearchKey, embedding, image, webdav, ...rest } = this.get();
    return {
      ...rest,
      hasWebSearchKey: Boolean(webSearchKey),
      embedding: embedding
        ? {
            baseUrl: embedding.baseUrl,
            model: embedding.model,
            hasApiKey: Boolean(embedding.apiKey),
          }
        : null,
      image: image
        ? {
            engine: image.engine,
            baseUrl: image.baseUrl,
            model: image.model,
            hasApiKey: Boolean(image.apiKey),
            nai: image.nai
              ? {
                  baseUrl: image.nai.baseUrl,
                  model: image.nai.model,
                  steps: image.nai.steps,
                  hasApiKey: Boolean(image.nai.apiKey),
                }
              : null,
          }
        : null,
      webdav: webdav
        ? { url: webdav.url, user: webdav.user, hasPassword: Boolean(webdav.password) }
        : null,
      primary: redact(this.value.primary),
      fallback: this.value.fallback ? redact(this.value.fallback) : null,
      sandbox: { ...this.value.sandbox },
    };
  }

  update(patch: unknown): void {
    const next = this.validate(patch);
    this.journal.setSetting('config', next);
    this.value = next;
  }
}

function mergedNumber(
  patch: Record<string, unknown>,
  previous: Config,
  key: keyof Config & string,
): number {
  const value = patch[key] ?? previous[key];
  if (typeof value !== 'number') throw new TypeError(`${key} 必须是数字`);
  return value;
}
