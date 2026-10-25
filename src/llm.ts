import { randomUUID } from 'node:crypto';

/** 模型接口适配层：OpenAI 兼容 / Anthropic / Gemini 三种格式、跨提供商的
 *  保守 token 估算、向量嵌入客户端。 */

export type ApiFormat = 'openai' | 'anthropic' | 'gemini';
export interface ModelConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  format: ApiFormat;
  maxTokens: number;
  timeoutMs: number;
  temperature?: number;
  vision: boolean;
  contextWindowTokens?: number;
  inputBudgetTokens?: number;
}
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}
export interface ModelMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  images?: string[];
  calls?: ToolCall[];
  callId?: string;
  name?: string;
  /** 回放用的原始负载（清洗后的 assistant 消息）。 */
  raw?: unknown;
  /** 可复用前缀的最后一条消息：Anthropic 需要显式 cache_control 标记，
   *  OpenAI 兼容与 Gemini 端点自动缓存最长相同前缀、忽略此标记。 */
  cacheBreakpoint?: boolean;
}
export interface Completion {
  text: string;
  calls: ToolCall[];
  continuation: ModelMessage;
  inputTokens: number;
  outputTokens: number;
}
export interface Model {
  complete(
    messages: ModelMessage[],
    tools?: ToolDefinition[],
    options?: {
      signal?: AbortSignal;
      sessionId?: string;
      maxTokens?: number;
      /** 整轮截止时刻：放不进剩余时间的重试直接放弃，让原始错误浮出来。 */
      deadlineAt?: number;
    },
  ): Promise<Completion>;
}

export class ModelError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly headers?: Record<string, string>,
    /** 传输层故障（DNS/重置/超时），无 HTTP 状态。 */
    readonly network = false,
  ) {
    super(message);
    this.name = 'ModelError';
  }
  /** 值得退避重试的临时故障：网络错误、408/429、5xx；其余 4xx 是配置错误。 */
  static transient(status?: number, network = false): boolean {
    if (network) return true;
    if (status === undefined) return false;
    return status === 408 || status === 429 || (status >= 500 && status <= 599);
  }
}

// ---------- token 估算（保守、跨提供商，不是专用 tokenizer） ----------

export function estimateTextTokens(text: string): number {
  let ascii = 0,
    other = 0;
  for (const character of text) {
    if (character.codePointAt(0)! < 128) ascii++;
    else other++;
  }
  return Math.ceil(ascii / 3 + other * 2);
}

export function estimateRequestTokens(
  messages: ModelMessage[],
  tools: ToolDefinition[] = [],
): number {
  return (
    128 +
    (tools.length ? estimateTextTokens(JSON.stringify(tools)) : 0) +
    messages.reduce(
      (total, message) =>
        total +
        32 +
        estimateTextTokens(
          message.raw === undefined
            ? message.content + (message.calls ? JSON.stringify(message.calls) : '')
            : JSON.stringify(message.raw),
        ) +
        (message.images?.length ?? 0) * 4096,
      0,
    )
  );
}

/** 二分截断到估算预算内，避免切开 UTF-16 代理对。 */
export function trimToTokens(text: string, budget: number): string {
  if (budget <= 0) return '';
  if (estimateTextTokens(text) <= budget) return text;
  let low = 0,
    high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (estimateTextTokens(text.slice(0, middle)) <= budget) low = middle;
    else high = middle - 1;
  }
  if (low && /[\uD800-\uDBFF]/.test(text[low - 1]!)) low--;
  return text.slice(0, low);
}

// ---------- 内部工具 ----------

type Json = Record<string, any>;

function isJsonObject(value: unknown): value is Json {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new ModelError('模型请求超时或已取消'));
    const onAbort = () => {
      clearTimeout(timer);
      reject(new ModelError('模型请求超时或已取消'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function argumentsOf(value: unknown): Record<string, unknown> {
  if (isJsonObject(value)) return value;
  try {
    const parsed = JSON.parse(String(value));
    return isJsonObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Gemini 的 functionResponse.response 必须是对象，纯文本包成 {result}。 */
function toolResponseOf(content: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
      return parsed as Record<string, unknown>;
  } catch {
    /* plain text */
  }
  return { result: content };
}

/** 部分模型把推理内联成 <think>…</think>：成对删除后再清残留的孤立标签。 */
function stripThinkTags(text: string): string {
  let out = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
  out = out.replace(/<\/?think>/gi, '');
  return out.trimStart();
}

function imageParts(message: ModelMessage, format: ApiFormat): unknown[] {
  const parts: unknown[] = message.content
    ? [{ text: message.content, ...(format === 'anthropic' ? { type: 'text' } : {}) }]
    : [];
  for (const image of message.images ?? []) {
    const match = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(image);
    if (!match) continue;
    parts.push(
      format === 'anthropic'
        ? { type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } }
        : { inlineData: { mimeType: match[1], data: match[2] } },
    );
  }
  return parts;
}

/** 流式读取响应并限制总量，防止异常网关把进程内存吃穿。 */
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
async function readResponseText(response: Response): Promise<string> {
  const body = response.body;
  if (!body) return response.text();
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`响应超过 ${MAX_RESPONSE_BYTES} 字节上限`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
}

// ---------- HttpModel ----------

export class HttpModel implements Model {
  constructor(
    readonly config: ModelConfig,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async complete(
    messages: ModelMessage[],
    tools: ToolDefinition[] = [],
    options: {
      signal?: AbortSignal;
      sessionId?: string;
      maxTokens?: number;
      deadlineAt?: number;
    } = {},
  ): Promise<Completion> {
    const c = this.config;
    if (!c.apiKey || !c.model) throw new ModelError('请先配置模型名称和 API 密钥');
    const base = c.baseUrl.replace(/\/+$/, '');
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (options.sessionId) headers['x-zg-session-id'] = options.sessionId;
    const maxTokens = Math.min(options.maxTokens ?? c.maxTokens, c.maxTokens);
    const inputLimit = Math.min(
      c.inputBudgetTokens ?? Infinity,
      (c.contextWindowTokens ?? Infinity) - maxTokens - 1024,
    );
    const estimatedInput = estimateRequestTokens(messages, tools);
    if (estimatedInput > inputLimit)
      throw new ModelError(
        `本次输入估算 ${estimatedInput} token，超过 ${inputLimit} 的预算，请在调试页调整上下文或缩短消息。`,
      );

    let url: string, body: Json;
    if (c.format === 'anthropic') {
      url = `${/\/v\d+$/.test(base) ? base : base + '/v1'}/messages`;
      headers['x-api-key'] = c.apiKey;
      headers['anthropic-version'] = '2023-06-01';
      const converted: Json[] = [];
      // 断点标记在消息并入时就挂上：同角色消息会追加进同一 content 块，
      // 事后标记会把断点挪到每轮都在变的内容上。
      const markCached = (entry: Json) => {
        const tail = Array.isArray(entry.content) ? entry.content.at(-1) : undefined;
        if (tail && typeof tail === 'object' && !Array.isArray(tail))
          tail.cache_control = { type: 'ephemeral' };
      };
      for (const m of messages.filter((m) => m.role !== 'system')) {
        const role = m.role === 'assistant' ? 'assistant' : 'user';
        const content =
          m.role === 'tool'
            ? [{ type: 'tool_result', tool_use_id: m.callId, content: m.content }]
            : m.role === 'assistant' && m.raw
              ? m.raw
              : imageParts(m, 'anthropic');
        const last = converted.at(-1);
        if (last?.role === role) {
          last.content.push(...(content as unknown[]));
          if (m.cacheBreakpoint) markCached(last);
        } else {
          const entry: Json = { role, content };
          converted.push(entry);
          if (m.cacheBreakpoint) markCached(entry);
        }
      }
      const systemText = messages
        .filter((m) => m.role === 'system')
        .map((m) => m.content)
        .join('\n\n');
      body = {
        model: c.model,
        max_tokens: maxTokens,
        messages: converted,
        // system 块是逐字节稳定的最高价值缓存断点。
        ...(systemText
          ? { system: [{ type: 'text', text: systemText, cache_control: { type: 'ephemeral' } }] }
          : {}),
      };
      if (tools.length)
        body.tools = tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.parameters,
        }));
    } else if (c.format === 'gemini') {
      url = `${/\/v\d+(beta)?$/.test(base) ? base : base + '/v1beta'}/models/${encodeURIComponent(c.model)}:generateContent`;
      headers['x-goog-api-key'] = c.apiKey;
      // Gemini 要求 user/model 严格交替：连续同角色消息与工具结果都要合并。
      const contents: Json[] = [];
      for (const m of messages) {
        if (m.role === 'system') continue;
        const role = m.role === 'assistant' ? 'model' : 'user';
        const parts =
          m.role === 'tool'
            ? [{ functionResponse: { name: m.name, response: toolResponseOf(m.content) } }]
            : (m.raw ?? imageParts(m, 'gemini'));
        const last = contents.at(-1);
        if (last?.role === role) last.parts.push(...(parts as unknown[]));
        else contents.push({ role, parts });
      }
      const systemText = messages
        .filter((m) => m.role === 'system')
        .map((m) => m.content)
        .join('\n\n');
      body = {
        ...(systemText ? { systemInstruction: { parts: [{ text: systemText }] } } : {}),
        contents,
        generationConfig: { maxOutputTokens: maxTokens },
      };
      if (tools.length)
        body.tools = [
          {
            functionDeclarations: tools.map((t) => ({
              name: t.name,
              description: t.description,
              parametersJsonSchema: t.parameters,
            })),
          },
        ];
      if (c.temperature !== undefined) body.generationConfig.temperature = c.temperature;
    } else {
      url = `${/\/v\d+$/.test(base) || /\/chat\/completions$/.test(base) ? base : base + '/v1'}`;
      if (!url.endsWith('/chat/completions')) url += '/chat/completions';
      headers.authorization = `Bearer ${c.apiKey}`;
      body = {
        model: c.model,
        messages: messages.map((m) => {
          if (m.role === 'assistant' && m.raw) return m.raw;
          if (m.role === 'tool')
            return { role: 'tool', tool_call_id: m.callId, content: m.content };
          const content = m.images?.length
            ? [
                { type: 'text', text: m.content },
                ...m.images.map((url) => ({
                  type: 'image_url',
                  image_url: { url, detail: 'auto' },
                })),
              ]
            : m.content;
          return { role: m.role, content };
        }),
      };
      body[/^(gpt-5|o[134])/.test(c.model) ? 'max_completion_tokens' : 'max_tokens'] = maxTokens;
      if (tools.length)
        body.tools = tools.map((t) => ({
          type: 'function',
          function: { name: t.name, description: t.description, parameters: t.parameters },
        }));
    }
    if (c.format !== 'gemini' && c.temperature !== undefined) body.temperature = c.temperature;
    // JSON 模式（OpenAI 兼容）：弱模型对提示词里的格式契约遵从度差，
    // response_format 直接在协议层强制。端点可能不支持：400 时摘掉
    // 重试一次并记住（按端点+模型缓存，调用方每次请求新建 HttpModel
    // 也不会丢探测结果），后续请求不再带。
    const jsonModeKey = `${c.baseUrl}|${c.model}|${c.format}`;
    let jsonMode = c.format === 'openai' && JSON_MODE_SUPPORTED.get(jsonModeKey) !== false;
    if (jsonMode) body.response_format = { type: 'json_object' };

    // 瞬时故障两次指数退避重试（Retry-After 优先）；每次尝试都有完整的
    // 单请求超时，放不进整轮截止时间的重试直接放弃。
    const outer = options.signal;
    let lastError: ModelError;
    for (let attempt = 0; ; attempt++) {
      try {
        const result = await this.attempt(url, headers, body, outer, c);
        if (jsonMode) JSON_MODE_SUPPORTED.set(jsonModeKey, true);
        return result;
      } catch (error) {
        lastError =
          error instanceof ModelError
            ? error
            : new ModelError(error instanceof Error ? error.message : '未知错误');
        if (outer?.aborted) throw new ModelError('模型请求超时或已取消');
        if (jsonMode && lastError.status === 400) {
          // 大概率是端点不认 response_format：摘掉原样重发，不耗重试次数。
          jsonMode = false;
          JSON_MODE_SUPPORTED.set(jsonModeKey, false);
          delete body.response_format;
          continue;
        }
        if (attempt >= 2 || !ModelError.transient(lastError.status, lastError.network))
          throw lastError;
      }
      const retryAfter = Number(lastError.headers?.['retry-after']);
      const delayBase =
        Number.isFinite(retryAfter) && retryAfter >= 0
          ? Math.min(retryAfter, 30) * 1000
          : Math.min(1000 * 2 ** attempt, 8000);
      const delay = delayBase * (0.8 + Math.random() * 0.4);
      const deadline = options.deadlineAt;
      if (typeof deadline === 'number' && Date.now() + delay + c.timeoutMs > deadline)
        throw lastError;
      await pause(delay, outer);
    }
  }

  private async attempt(
    url: string,
    headers: Record<string, string>,
    body: Json,
    outer: AbortSignal | undefined,
    c: ModelConfig,
  ): Promise<Completion> {
    const signal = outer
      ? AbortSignal.any([outer, AbortSignal.timeout(c.timeoutMs)])
      : AbortSignal.timeout(c.timeoutMs);
    let response: Response;
    try {
      response = await this.fetcher(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      if (outer?.aborted) throw new ModelError('模型请求超时或已取消');
      if (signal.aborted) throw new ModelError('模型请求超时', undefined, undefined, true);
      throw new ModelError(
        `模型连接失败：${error instanceof Error ? error.message : '未知错误'}`,
        undefined,
        undefined,
        true,
      );
    }
    let data: Json;
    let payload = '';
    try {
      payload = await readResponseText(response);
    } catch (error) {
      if (outer?.aborted || signal.aborted)
        throw new ModelError('模型请求超时', undefined, undefined, true);
      throw new ModelError(
        `读取模型响应失败：${error instanceof Error ? error.message : '未知错误'}`,
        response.status,
        undefined,
        true,
      );
    }
    const retryHeader = () =>
      response.headers.get('retry-after') === null
        ? undefined
        : { 'retry-after': response.headers.get('retry-after')! };
    try {
      data = JSON.parse(payload) as Json;
    } catch {
      // 网关的 HTML 502 属于临时故障，不是"无效响应"。
      if (!response.ok)
        throw new ModelError(
          `模型请求失败（HTTP ${response.status}）：${payload.slice(0, 200) || '上游错误'}`,
          response.status,
          retryHeader(),
        );
      throw new ModelError(`模型返回了无效响应（HTTP ${response.status}）`, response.status);
    }
    if (!data || typeof data !== 'object' || Array.isArray(data))
      throw new ModelError(
        `模型返回了无效响应（HTTP ${response.status}）`,
        response.status,
        retryHeader(),
      );
    if (!response.ok)
      throw new ModelError(
        `模型请求失败（HTTP ${response.status}）：${String(
          data.error?.message ?? data.error ?? '上游错误',
        )
          .replaceAll(c.apiKey, '[已隐藏]')
          .slice(0, 200)}`,
        response.status,
        retryHeader(),
      );

    let text = '',
      calls: ToolCall[] = [],
      raw: unknown,
      inputTokens = 0,
      outputTokens = 0;
    if (c.format === 'anthropic') {
      const content: Json[] = Array.isArray(data.content) ? data.content : [];
      raw = content;
      text = content
        .filter((p) => p && typeof p === 'object' && p.type === 'text')
        .map((p) => String(p.text ?? ''))
        .join('');
      calls = content
        .filter((p) => isJsonObject(p) && p.type === 'tool_use')
        .map((p) => {
          // 部分网关缺 tool_use.id：合成一个并写回原始块，配对才能成立。
          const id = typeof p.id === 'string' && p.id ? p.id : `call_${randomUUID()}`;
          p.id = id;
          return { id, name: String(p.name), arguments: argumentsOf(p.input) };
        });
      inputTokens =
        Number(data.usage?.input_tokens ?? 0) +
        Number(data.usage?.cache_creation_input_tokens ?? 0) +
        Number(data.usage?.cache_read_input_tokens ?? 0);
      outputTokens = Number(data.usage?.output_tokens ?? 0);
    } else if (c.format === 'gemini') {
      const parts: Json[] = Array.isArray(data.candidates?.[0]?.content?.parts)
        ? data.candidates[0].content.parts
        : [];
      raw = parts;
      text = parts
        .filter((p) => p && typeof p === 'object' && !p.thought && typeof p.text === 'string')
        .map((p) => p.text)
        .join('');
      calls = parts
        .filter((p) => isJsonObject(p) && isJsonObject(p.functionCall))
        .map((p) => {
          const id =
            typeof p.functionCall.id === 'string' && p.functionCall.id
              ? p.functionCall.id
              : `call_${randomUUID()}`;
          p.functionCall.id = id;
          return {
            id,
            name: String(p.functionCall.name),
            arguments: argumentsOf(p.functionCall.args),
          };
        });
      inputTokens = Number(data.usageMetadata?.promptTokenCount ?? 0);
      outputTokens = Number(data.usageMetadata?.candidatesTokenCount ?? 0);
    } else {
      const candidate = data.choices?.[0]?.message;
      const message: Json = candidate && typeof candidate === 'object' ? candidate : {};
      // 思考模型的推理字段绝不进入回放历史。
      delete message.reasoning_content;
      delete message.reasoning;
      const rawText =
        typeof message.content === 'string'
          ? message.content
          : Array.isArray(message.content)
            ? message.content
                .filter((p: Json) => p.type === 'text')
                .map((p: Json) => p.text ?? '')
                .join('')
            : '';
      text = stripThinkTags(rawText);
      raw = { ...message, content: text };
      const toolCalls: Json[] = Array.isArray(message.tool_calls)
        ? message.tool_calls.filter(isJsonObject)
        : [];
      calls = toolCalls.map((t: Json) => {
        const id = typeof t.id === 'string' && t.id ? t.id : `call_${randomUUID()}`;
        t.id = id;
        return {
          id,
          name: String(t.function?.name),
          arguments: argumentsOf(t.function?.arguments),
        };
      });
      inputTokens = Number(data.usage?.prompt_tokens ?? 0);
      outputTokens = Number(data.usage?.completion_tokens ?? 0);
    }
    if (!text.trim() && !calls.length) throw new ModelError('模型没有返回可用内容');
    return {
      text,
      calls,
      continuation: { role: 'assistant', content: text, calls, raw },
      inputTokens,
      outputTokens,
    };
  }
}

/** response_format 探测结果（模块级，按 端点|模型|格式 缓存）。 */
const JSON_MODE_SUPPORTED = new Map<string, boolean>();

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || !a.length) return 0;
  let dot = 0,
    normA = 0,
    normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  return normA && normB ? dot / (Math.sqrt(normA) * Math.sqrt(normB)) : 0;
}

// ---------- 嵌入客户端 ----------

/** 提供商可能无视 encoding_format 返回 base64 小端 float32，两种都接受。 */
function decodeEmbedding(value: unknown): Float32Array {
  if (Array.isArray(value)) {
    if (!value.length || value.some((n) => typeof n !== 'number' || !Number.isFinite(n)))
      throw new Error('向量服务返回了无效向量');
    return Float32Array.from(value as number[]);
  }
  if (typeof value === 'string' && value.length) {
    const buf = Buffer.from(value, 'base64');
    if (!buf.length || buf.length % 4) throw new Error('向量服务返回了无效的 base64 向量');
    const out = new Float32Array(buf.length / 4);
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    for (let i = 0; i < out.length; i++) out[i] = view.getFloat32(i * 4, true);
    if (out.some((n) => !Number.isFinite(n))) throw new Error('向量服务返回了无效向量');
    return out;
  }
  throw new Error('向量服务返回了无效向量');
}

/** OpenAI 兼容 /embeddings 客户端。 */
export class EmbeddingClient {
  constructor(
    private readonly getConfig: () => {
      baseUrl?: string;
      apiKey?: string;
      model?: string;
      timeoutMs?: number;
    },
    private readonly fetcher: typeof fetch = fetch,
  ) {}
  get configured(): boolean {
    const c = this.getConfig();
    return !!(c.model && c.apiKey && c.baseUrl);
  }
  get model(): string {
    return this.getConfig().model ?? '';
  }
  async embed(texts: string[], signal?: AbortSignal): Promise<Float32Array[]> {
    const c = this.getConfig();
    if (!c.model || !c.apiKey || !c.baseUrl) throw new Error('向量模型尚未配置');
    if (!texts.length) return [];
    const usable = texts.map((t) => t.slice(0, 6000)).map((t) => (t.trim() ? t : '(空)'));
    const base = c.baseUrl.replace(/\/+$/, '').replace(/\/embeddings$/, '');
    const endpoint = `${/\/v\d+$/.test(base) ? base : `${base}/v1`}/embeddings`;
    const timeoutMs = c.timeoutMs ?? 30000;
    let response: Response | undefined;
    let lastError: Error | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        response = await this.fetcher(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${c.apiKey}` },
          body: JSON.stringify({ model: c.model, input: usable, encoding_format: 'float' }),
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
            : AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        if (signal?.aborted) throw new Error('向量请求已取消');
        lastError = new Error(
          `向量服务连接失败：${error instanceof Error ? error.message : '未知错误'}`,
        );
      }
      if (response) {
        if (response.ok) break;
        const body = (await readResponseText(response).catch(() => '')).slice(0, 200);
        lastError = new Error(`向量服务请求失败（HTTP ${response.status}）：${body}`);
        if (![408, 429].includes(response.status) && response.status < 500) throw lastError;
      }
      if (attempt < 2) await pause(500 * 2 ** attempt, signal);
      response = undefined;
    }
    if (!response?.ok) throw lastError ?? new Error('向量服务请求失败');
    let data: { data?: { index?: number; embedding?: unknown }[] };
    try {
      data = JSON.parse(await readResponseText(response)) as typeof data;
    } catch {
      throw new Error('向量服务返回了无效 JSON');
    }
    if (!Array.isArray(data.data) || data.data.length !== usable.length)
      throw new Error('向量服务返回条数不符');
    const out = new Array<Float32Array>(usable.length);
    for (const item of data.data) {
      if (!isJsonObject(item)) throw new Error('向量服务返回了无效条目');
      const index = typeof item.index === 'number' ? item.index : out.findIndex((v) => !v);
      if (index < 0 || index >= out.length || out[index]) throw new Error('向量服务返回索引无效');
      out[index] = decodeEmbedding(item.embedding);
    }
    if (out.some((v) => !v)) throw new Error('向量服务返回不完整');
    return out;
  }
}
