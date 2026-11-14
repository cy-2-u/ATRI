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

export interface Config {
  primary: Endpoint;
  fallback?: Endpoint;
  embedding?: EmbeddingConfig;
  heartbeat: boolean;
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
    'clearApiKey',
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
  if (patch.clearApiKey !== undefined) boolean(patch.clearApiKey, 'clearApiKey');
  if (patch.apiKey !== undefined && typeof patch.apiKey !== 'string')
    throw new TypeError('密钥必须是字符串');
  const apiKey =
    patch.clearApiKey === true
      ? ''
      : typeof patch.apiKey === 'string' && patch.apiKey.trim()
        ? patch.apiKey.trim()
        : previous.apiKey;
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
      inputTokens: 24_000,
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
    const base: Config = {
      primary,
      ...(fallback ? { fallback } : {}),
      ...(embedding ? { embedding } : {}),
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
    const { webSearchKey, embedding, ...rest } = this.get();
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
