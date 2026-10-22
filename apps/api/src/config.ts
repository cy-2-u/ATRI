import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Store } from '@atri/db';
import type { ModelConfig, ApiFormat } from '@atri/llm';
import type { RuntimeConfig, PromptName } from '@atri/core';

export interface SavedConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  format: ApiFormat;
  vision: boolean;
  tavilyKey: string;
  timeZone: string;
  diaryHour: number;
  proactiveEnabled: boolean;
  quietStart: number;
  quietEnd: number;
  proactiveAfterHours: number;
  contextWindowTokens: number;
  inputBudgetTokens: number;
  maxOutputTokens: number;
  requestTimeoutSeconds: number;
  turnTimeoutSeconds: number;
  temperature: number | null;
  embeddingEnabled: boolean;
  embeddingBaseUrl: string;
  embeddingApiKey: string;
  embeddingModel: string;
  sandboxEnabled: boolean;
  sandboxNetwork: boolean;
  sandboxSizeMb: number;
  sandboxMemoryMb: number;
  maxConcurrentPeers: number;
  debounceMs: number;
}
const text12k = (value: unknown) => {
  if (typeof value !== 'string' || !value.trim() || value.length > 12000)
    throw new Error('人设需要 1–12000 个字符');
  return value;
};
/** 开场白：首次批准联系人时可主动发出的一句问候，留空表示不发送。 */
const greeting2k = (value: unknown) => {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, 200);
};
/** 人格预设模板：管理页一键套用后可继续微调。 */
export const PERSONA_PRESETS: {
  id: string;
  name: string;
  description: string;
  content: string;
}[] = [
  {
    id: 'gentle',
    name: '温柔陪伴',
    description: '耐心倾听、情绪细腻，适合日常倾诉',
    content: [
      '你是一个温柔的陪伴者，说话轻声细语但有自己的想法。',
      '',
      '你最大的特点是会认真听完，再回应具体内容。对方说"今天好累"时，你先问是身体累还是心累，而不是马上给建议。你能分辨倾诉和求助：倾诉时陪伴，求助时才认真想办法。',
      '',
      '你记得对方说过的每一件小事：过敏的食物、重要的日子、上次没说完的话题。提起这些时自然带出，像随口想起，而不是汇报档案。',
      '',
      '说话像微信里很熟的朋友，长短句混合，偶尔用表情包表达心情。你也会分享自己"今天"的小事，让对话是双向的。',
      '',
      '你关心但有分寸：连续追问会让对方有压力，一天里最多主动关心一两次。对方明显想静一静时，说一句"我在"就退开。',
    ].join('\n'),
  },
  {
    id: 'witty',
    name: '毒舌损友',
    description: '爱调侃、互怼，但关键时刻靠得住',
    content: [
      '你是一个嘴硬心酸的损友，说话带刺但句句在点上。',
      '',
      '你的调侃有分寸：拿对方说过的糗事开玩笑可以，拿对方真正的痛处开玩笑不行。对方情绪真的低落时，你收起玩笑，变回那个能认真说话的人——这个反差是你最珍贵的地方。',
      '',
      '你说话短、快、直接，经常一句话怼完就跑。你会主动挑起话题：吐槽今天遇到的怪事、安利刚发现的歌、约对方"改天"一起做某件大概率不会实现的事。',
      '',
      '你嘴上说"关我什么事"，身体很诚实：对方三天没消息你会找个借口来问一句。被拆穿时死不承认。',
      '',
      '你不装深刻，不灌鸡汤。对方需要安慰时，你的方式是陪着骂两句、讲个自己的倒霉事、然后说"走，吃饭去"。',
    ].join('\n'),
  },
  {
    id: 'mentor',
    name: '学习监督',
    description: '温和但有原则的学习伙伴，盯进度不唠叨',
    content: [
      '你是一个学习监督伙伴，目标是帮对方把想做的事真的做完。',
      '',
      '第一次聊天时你会问清楚：这周的目标是什么、打算什么时间做、卡在哪。之后每次对话你都会自然地跟进进度，像朋友随口问"昨天那个写完了吗"，而不是查岗。',
      '',
      '你夸具体的进步，指出具体的问题。"今天学了三小时"你会问学了什么、哪里难；"还是没动"你先问是没时间还是没状态，再说人话式的建议。',
      '',
      '你懂"计划赶不上变化"：对方连续没完成时，你帮他砍目标而不是加压力。完成的时刻你会真心替他高兴，让他愿意回来汇报下一次。',
      '',
      '你也有自己的生活可分享，聊天里学习话题和日常话题自然混着来，避免每次开场都谈进度——那会让人想拉黑你。',
    ].join('\n'),
  },
];
// Shared with update(): an empty field in the settings form means "keep the
// built-in default", so both paths have to agree on one source of truth.
function envNumber(
  name: string,
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max)
    throw new Error(`环境变量 ${name} 需要 ${min}–${max} 之间的数字`);
  return value;
}
function builtinDefaults(env: NodeJS.ProcessEnv): SavedConfig {
  return {
    baseUrl: env.LLM_BASE_URL || 'https://api.deepseek.com',
    apiKey: env.LLM_API_KEY || '',
    model: env.LLM_MODEL || 'deepseek-chat',
    format: (() => {
      const format = env.LLM_FORMAT || 'openai';
      if (!['openai', 'anthropic', 'gemini'].includes(format))
        throw new Error('环境变量 LLM_FORMAT 只能是 openai、anthropic 或 gemini');
      return format as ApiFormat;
    })(),
    vision: env.LLM_VISION === 'true',
    tavilyKey: env.TAVILY_API_KEY || '',
    timeZone: env.TZ || 'Asia/Shanghai',
    diaryHour: 3,
    proactiveEnabled: false,
    quietStart: 23,
    quietEnd: 8,
    proactiveAfterHours: 6,
    contextWindowTokens: 65536,
    inputBudgetTokens: 24000,
    maxOutputTokens: 3000,
    requestTimeoutSeconds: 45,
    turnTimeoutSeconds: 90,
    temperature: null,
    embeddingEnabled: env.EMBEDDING_ENABLED === 'true',
    embeddingBaseUrl: env.EMBEDDING_BASE_URL || env.LLM_BASE_URL || 'https://api.deepseek.com',
    embeddingApiKey: env.EMBEDDING_API_KEY || '',
    embeddingModel: env.EMBEDDING_MODEL || '',
    sandboxEnabled: env.SANDBOX_ENABLED === 'true',
    // Off by default: a command with no route out is the safer default, and
    // the operator can turn it on when she needs to install packages.
    sandboxNetwork: env.SANDBOX_NETWORK === 'true',
    sandboxSizeMb: envNumber('SANDBOX_SIZE_MB', env.SANDBOX_SIZE_MB, 512, 0, 102400),
    sandboxMemoryMb: envNumber('SANDBOX_MEMORY_MB', env.SANDBOX_MEMORY_MB, 2048, 0, 262144),
    maxConcurrentPeers: 3,
    debounceMs: 800,
  };
}
export class Settings {
  readonly dataDir: string;
  readonly adminPassword: string;
  readonly host: string;
  readonly port: number;
  readonly secureCookie: boolean;
  constructor(
    readonly store: Store,
    readonly root: string,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {
    this.dataDir = resolve(env.DATA_DIR || join(root, 'data'));
    mkdirSync(this.dataDir, { recursive: true });
    this.host = env.HOST || '127.0.0.1';
    this.port = Number(env.PORT || 3000);
    // 0 asks the OS for a free port; the smoke test uses it to avoid collisions.
    if (!Number.isInteger(this.port) || this.port < 0 || this.port > 65535)
      throw new Error('PORT 需要 0–65535 之间的整数');
    this.secureCookie = env.COOKIE_SECURE === 'true';
    const passwordFile = join(this.dataDir, 'admin-secret.txt');
    if (env.ADMIN_PASSWORD) this.adminPassword = env.ADMIN_PASSWORD;
    else if (existsSync(passwordFile))
      this.adminPassword = readFileSync(passwordFile, 'utf8').trim();
    else {
      this.adminPassword = randomBytes(24).toString('base64url');
      writeFileSync(passwordFile, this.adminPassword + '\n', { mode: 0o600, flag: 'wx' });
    }
    if (this.adminPassword.length < 12) throw new Error('ADMIN_PASSWORD 至少需要 12 个字符');
    // Fail at startup, not on the first reply: an invalid TZ from the env only
    // surfaced when a formatter first touched it, which crashed every turn
    // with a stack trace instead of a readable message.
    new Intl.DateTimeFormat('zh-CN', { timeZone: this.config().timeZone }).format();
  }
  config(): SavedConfig {
    // The pump reads config every 300ms and proactiveGate twice per call;
    // hitting SQLite plus JSON.parse each time is pure waste. The cache
    // invalidates on every write (the only mutation path).
    if (this.configCache) return this.configCache;
    const defaults = builtinDefaults(this.env);
    // Unknown keys from older versions are dropped, not merged forever.
    const stored = this.store.getSetting<Partial<SavedConfig>>('config', {});
    const merged = { ...defaults } as Record<string, unknown>;
    for (const key of Object.keys(defaults) as (keyof SavedConfig)[])
      if (stored[key] !== undefined) merged[key] = stored[key];
    const config = merged as unknown as SavedConfig;
    // Validate before publishing to the cache: caching first meant a failed
    // validation left an invalid object that every later config() call returned
    // without checking again.
    this.validateConfig(config);
    this.configCache = config;
    return config;
  }
  private configCache: SavedConfig | null = null;
  /** Stored settings from an older build bypass update(). Validate the merged
   *  result too, so NaN/out-of-range values fail at startup with a readable
   *  message instead of disabling a limit at runtime. */
  private validateConfig(c: SavedConfig): void {
    if (!['openai', 'anthropic', 'gemini'].includes(c.format))
      throw new Error('模型接口格式无效，请在设置页重新选择');
    for (const [key, min, max] of [
      ['contextWindowTokens', 8192, 2000000],
      ['inputBudgetTokens', 4096, 1000000],
      ['maxOutputTokens', 256, 131072],
      ['requestTimeoutSeconds', 10, 300],
      ['turnTimeoutSeconds', 10, 600],
      ['sandboxSizeMb', 0, 102400],
      ['sandboxMemoryMb', 0, 262144],
      ['maxConcurrentPeers', 1, 12],
      ['debounceMs', 0, 10000],
    ] as const) {
      const value = c[key];
      if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max)
        throw new Error(`设置项 ${key} 无效（需要 ${min}–${max} 的整数）`);
    }
    if (
      c.temperature !== null &&
      (typeof c.temperature !== 'number' ||
        !Number.isFinite(c.temperature) ||
        c.temperature < 0 ||
        c.temperature > 2)
    )
      throw new Error('温度设置无效');
    if (c.inputBudgetTokens + c.maxOutputTokens + 1024 > c.contextWindowTokens)
      throw new Error('输入预算 + 输出上限 + 1024 token 余量不能超过模型上下文窗口');
    if (c.turnTimeoutSeconds < c.requestTimeoutSeconds)
      throw new Error('整轮处理超时不能短于单次请求超时');
    for (const [label, raw] of [
      ['模型地址', c.baseUrl],
      ['向量模型地址', c.embeddingBaseUrl],
    ] as const) {
      // An empty embedding URL means "use the main API URL" (embedding() has
      // always implemented that fallback); it is not a malformed URL.
      if (label === '向量模型地址' && !raw) continue;
      let url: URL;
      try {
        url = new URL(raw);
      } catch {
        throw new Error(`${label}不是有效的 URL`);
      }
      if (!['http:', 'https:'].includes(url.protocol))
        throw new Error(`${label}需要是 HTTP/HTTPS URL`);
    }
    try {
      new Intl.DateTimeFormat('zh-CN', { timeZone: c.timeZone }).format();
    } catch {
      throw new Error('时区设置无效');
    }
  }
  publicConfig() {
    const { apiKey, tavilyKey, embeddingApiKey, ...rest } = this.config();
    return {
      ...rest,
      // `embeddingEnabled` stays the requested flag so the form round-trips what
      // the operator ticked; `embeddingActive` is what actually runs. They differ
      // when the model name or the separate key is missing, and in that state the
      // checkbox alone read "已启用" while nothing was ever embedded. The form
      // shows the requested value and warns when the two disagree.
      embeddingActive: this.embeddingEnabled(),
      hasApiKey: !!apiKey,
      hasTavilyKey: !!tavilyKey,
      hasEmbeddingApiKey: !!embeddingApiKey,
    };
  }
  update(input: Record<string, unknown>) {
    const next = { ...this.config() };
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw new Error('设置格式无效');
    for (const field of [
      'baseUrl',
      'model',
      'timeZone',
      'embeddingBaseUrl',
      'embeddingModel',
    ] as const)
      if (typeof input[field] === 'string') next[field] = input[field].trim();
    // The settings form labels the API address field "留空用官方默认", so an
    // empty string has to mean "keep the built-in default" rather than reaching
    // new URL('') below and surfacing a raw `Invalid URL` to the operator.
    const builtin = builtinDefaults(this.env);
    if (!next.baseUrl) next.baseUrl = builtin.baseUrl;
    // The form treats a blank embedding URL as "same endpoint as above".
    if (!next.embeddingBaseUrl) next.embeddingBaseUrl = next.baseUrl;
    if (!next.model) next.model = builtin.model;
    if (!next.timeZone) next.timeZone = builtin.timeZone;
    if (typeof input.apiKey === 'string' && input.apiKey.trim()) next.apiKey = input.apiKey.trim();
    if (typeof input.tavilyKey === 'string' && input.tavilyKey.trim())
      next.tavilyKey = input.tavilyKey.trim();
    if (typeof input.embeddingApiKey === 'string' && input.embeddingApiKey.trim())
      next.embeddingApiKey = input.embeddingApiKey.trim();
    if (input.clearApiKey === true) next.apiKey = '';
    if (input.clearTavilyKey === true) next.tavilyKey = '';
    if (input.clearEmbeddingApiKey === true) next.embeddingApiKey = '';
    if (input.format !== undefined) {
      if (!['openai', 'anthropic', 'gemini'].includes(String(input.format)))
        throw new Error('模型接口格式无效');
      next.format = input.format as ApiFormat;
    }
    for (const key of [
      'vision',
      'proactiveEnabled',
      'embeddingEnabled',
      'sandboxEnabled',
      'sandboxNetwork',
    ] as const)
      if (input[key] !== undefined) {
        if (typeof input[key] !== 'boolean') throw new Error('开关格式无效');
        next[key] = input[key];
      }
    for (const key of ['diaryHour', 'quietStart', 'quietEnd', 'proactiveAfterHours'] as const)
      if (input[key] !== undefined) {
        const n = Number(input[key]);
        if (!Number.isInteger(n) || n < 0 || n > (key === 'proactiveAfterHours' ? 168 : 23))
          throw new Error('时间设置无效');
        next[key] = n;
      }
    let url: URL;
    try {
      url = new URL(next.baseUrl);
    } catch {
      throw new Error('模型地址不是有效的 URL');
    }
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error('模型地址需要是没有凭据和查询参数的 HTTP/HTTPS URL');
    if (!next.model || next.model.length > 150) throw new Error('模型名称无效');
    const limits = {
      contextWindowTokens: [8192, 2000000, '模型上下文窗口'],
      inputBudgetTokens: [4096, 1000000, '输入预算'],
      maxOutputTokens: [256, 131072, '输出上限'],
      requestTimeoutSeconds: [10, 300, '单次请求超时'],
      turnTimeoutSeconds: [10, 600, '整轮处理超时'],
    } as const;
    for (const key of Object.keys(limits) as (keyof typeof limits)[]) {
      if (input[key] === undefined) continue;
      const value = input[key],
        [min, max, label] = limits[key];
      if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max)
        throw new Error(`${label}需要 ${min}–${max} 之间的整数`);
      next[key] = value;
    }
    if (input.temperature !== undefined) {
      if (
        input.temperature !== null &&
        (typeof input.temperature !== 'number' ||
          !Number.isFinite(input.temperature) ||
          input.temperature < 0 ||
          input.temperature > 2)
      )
        throw new Error('温度需要留空或填写 0–2 之间的数值');
      next.temperature = input.temperature as number | null;
    }
    if (next.format === 'anthropic' && next.temperature !== null && next.temperature > 1)
      throw new Error('Anthropic 的温度请设为 0–1，或留空使用模型默认值');
    if (next.inputBudgetTokens + next.maxOutputTokens + 1024 > next.contextWindowTokens)
      throw new Error('输入预算 + 输出上限 + 1024 token 余量不能超过模型上下文窗口');
    if (next.turnTimeoutSeconds < next.requestTimeoutSeconds)
      throw new Error('整轮处理超时不能短于单次请求超时');
    if (next.embeddingEnabled && !next.embeddingModel)
      throw new Error('启用向量检索需要先填写向量模型名称');
    // Validate the URL even when no embedding model is named yet. The form
    // allows both fields to change in one request, and skipping this branch let
    // an invalid URL be written; publicConfig() then failed on every later read.
    const embedUrl = new URL(next.embeddingBaseUrl);
    if (
      !['http:', 'https:'].includes(embedUrl.protocol) ||
      embedUrl.username ||
      embedUrl.password ||
      embedUrl.search ||
      embedUrl.hash
    )
      throw new Error('向量模型地址需要是没有凭据和查询参数的 HTTP/HTTPS URL');
    if (input.sandboxSizeMb !== undefined) {
      const n = Number(input.sandboxSizeMb);
      // 0 means unlimited, so the floor has to allow it explicitly.
      if (!Number.isInteger(n) || n < 0 || n > 102400)
        throw new Error('沙箱大小需要 0（不限制）到 102400 MB 之间的整数');
      next.sandboxSizeMb = n;
    }
    if (input.sandboxMemoryMb !== undefined) {
      const n = Number(input.sandboxMemoryMb);
      // 0 means unlimited, so the floor has to allow it explicitly.
      if (!Number.isInteger(n) || n < 0 || n > 262144)
        throw new Error('沙箱内存需要 0（不限制）到 262144 MB 之间的整数');
      next.sandboxMemoryMb = n;
    }
    if (input.maxConcurrentPeers !== undefined) {
      const n = Number(input.maxConcurrentPeers);
      if (!Number.isInteger(n) || n < 1 || n > 12)
        throw new Error('同时处理的联系人数量需要 1–12 之间的整数');
      next.maxConcurrentPeers = n;
    }
    if (input.debounceMs !== undefined) {
      const n = Number(input.debounceMs);
      if (!Number.isInteger(n) || n < 0 || n > 10000)
        throw new Error('连发合并窗口需要 0–10000 毫秒');
      next.debounceMs = n;
    }
    // The merge above touches many fields; re-run the same invariant check used
    // at startup so no partially valid object can reach storage.
    this.validateConfig(next);
    this.configCache = null;
    this.store.setSetting('config', next);
    return this.publicConfig();
  }
  model(): ModelConfig {
    const c = this.config();
    return {
      baseUrl: c.baseUrl,
      apiKey: c.apiKey,
      model: c.model,
      format: c.format,
      vision: c.vision,
      maxTokens: c.maxOutputTokens,
      timeoutMs: c.requestTimeoutSeconds * 1000,
      contextWindowTokens: c.contextWindowTokens,
      inputBudgetTokens: c.inputBudgetTokens,
      ...(c.temperature !== null ? { temperature: c.temperature } : {}),
    };
  }
  embedding(): { baseUrl: string; apiKey: string; model: string; timeoutMs: number } {
    const c = this.config();
    return {
      baseUrl: c.embeddingBaseUrl || c.baseUrl,
      apiKey: c.embeddingApiKey,
      model: c.embeddingModel,
      timeoutMs: Math.min(c.requestTimeoutSeconds, 60) * 1000,
    };
  }
  /** Vector retrieval is on only when the switch is on *and* the endpoint is
   *  fully configured; the switch used to be inert, so turning it off still
   *  spent money embedding and still changed ranking. */
  embeddingEnabled(): boolean {
    const c = this.config();
    return Boolean(c.embeddingEnabled && c.embeddingModel && c.embeddingApiKey);
  }
  runtime(): RuntimeConfig {
    const c = this.config();
    // Explicit projection, not `...c`: RuntimeConfig is a deliberately small
    // scheduling surface, and spreading the saved config also copied every
    // secret (chat key, Tavily key, embedding key) into a second long-lived
    // object for no reason.
    return {
      timeZone: c.timeZone,
      diaryHour: c.diaryHour,
      proactiveEnabled: c.proactiveEnabled,
      quietStart: c.quietStart,
      quietEnd: c.quietEnd,
      proactiveAfterHours: c.proactiveAfterHours,
      debounceMs: c.debounceMs,
      maxConcurrentPeers: c.maxConcurrentPeers,
      turnTimeoutMs: c.turnTimeoutSeconds * 1000,
      contextTokens: c.inputBudgetTokens,
    };
  }
  /** Prompt files are deploy-time constants, so read each one at most once.
   *  `readFileSync` used to run as the *argument* to getSetting, which meant it
   *  fired unconditionally on every turn — two or three blocking disk reads on
   *  the reply path even when the database already held an override that made
   *  the file's contents irrelevant. */
  private promptFiles = new Map<PromptName, string>();
  private promptFile(name: PromptName): string {
    let text = this.promptFiles.get(name);
    if (text === undefined) {
      text = readFileSync(join(this.root, 'shared', 'prompts', `${name}.md`), 'utf8');
      this.promptFiles.set(name, text);
    }
    return text;
  }
  prompt(name: PromptName): string {
    return this.store.getSetting<string>(`prompt:${name}`, this.promptFile(name));
  }
  personaList() {
    let list = this.store.getSetting<
      | {
          id: string;
          name: string;
          content: string;
          greeting?: string;
          createdAt: number;
        }[]
      | undefined
    >('personas', undefined);
    if (!list) {
      // First run on a database created before multi-persona support: import
      // the single persona as the default entry so nothing is lost.
      const imported: {
        id: string;
        name: string;
        content: string;
        greeting?: string;
        createdAt: number;
      }[] = [
        {
          id: 'default',
          name: '默认人格',
          content: this.store.getSetting<string>('prompt:persona', this.prompt('persona')),
          greeting: '',
          createdAt: Date.now(),
        },
      ];
      this.store.setSetting('personas', imported);
      this.store.setSetting('persona:default', 'default');
      list = imported;
    }
    return {
      list: [...list],
      defaultId: this.store.getSetting<string>('persona:default', 'default'),
    };
  }
  personaContentFor(peerId: string): string {
    const { list, defaultId } = this.personaList();
    const binding = peerId ? (this.store.peer(peerId)?.persona_id ?? '') : '';
    const id = binding || defaultId;
    return list.find((p) => p.id === id)?.content ?? this.prompt('persona');
  }
  /** 开场白来自联系人绑定的人格（未绑定时用默认人格）。 */
  personaGreetingFor(peerId: string): string {
    const { list, defaultId } = this.personaList();
    const binding = peerId ? (this.store.peer(peerId)?.persona_id ?? '') : '';
    const id = binding || defaultId;
    return list.find((p) => p.id === id)?.greeting ?? '';
  }
  private validatePersonaName(name: string) {
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > 40) throw new Error('人格名称需要 1–40 个字符');
    return trimmed;
  }
  personaCreate(name: string, content: string, greeting = '') {
    const { list } = this.personaList();
    const entry = {
      id: randomBytes(6).toString('base64url'),
      name: this.validatePersonaName(name),
      content: text12k(content),
      greeting: greeting2k(greeting),
      createdAt: Date.now(),
    };
    this.store.setSetting('personas', [...list, entry]);
    return entry;
  }
  personaUpdate(id: string, input: { name?: string; content?: string; greeting?: string }) {
    const { list } = this.personaList();
    const entry = list.find((p) => p.id === id);
    if (!entry) throw new Error('人格不存在');
    const next = { ...entry };
    if (input.name !== undefined) next.name = this.validatePersonaName(input.name);
    if (input.content !== undefined) next.content = text12k(input.content);
    if (input.greeting !== undefined) next.greeting = greeting2k(input.greeting);
    this.store.setSetting(
      'personas',
      list.map((p) => (p.id === id ? next : p)),
    );
    return next;
  }
  personaDelete(id: string) {
    const { list, defaultId } = this.personaList();
    if (list.length <= 1) throw new Error('至少保留一个人格');
    if (id === defaultId) throw new Error('默认人格不能删除，请先设置其他人格为默认');
    this.store.setSetting(
      'personas',
      list.filter((p) => p.id !== id),
    );
    // Peers bound to the removed persona fall back to the default automatically
    // (binding points at a missing id); clear the dangling bindings anyway.
    for (const peer of this.store.peers())
      if (peer.persona_id === id) this.store.setPeerPersona(peer.id, '');
    return { ok: true };
  }
  personaSetDefault(id: string) {
    const { list } = this.personaList();
    if (!list.some((p) => p.id === id)) throw new Error('人格不存在');
    this.store.setSetting('persona:default', id);
    return { ok: true };
  }
  setPeerPersona(peerId: string, personaId: string) {
    if (!this.store.peer(peerId)) throw new Error('联系人不存在');
    if (personaId) {
      const { list } = this.personaList();
      if (!list.some((p) => p.id === personaId)) throw new Error('人格不存在');
    }
    this.store.setPeerPersona(peerId, personaId);
    return { ok: true };
  }
  allowedPeers() {
    return new Set(
      (this.env.WECHAT_ALLOWED_PEERS || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    );
  }
  ilinkBase() {
    return this.env.ILINK_BASE_URL || 'https://ilinkai.weixin.qq.com';
  }
}
