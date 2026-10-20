import { estimateRequestTokens } from './budget.js';
export { estimateTextTokens, estimateRequestTokens, trimToTokens } from './budget.js';

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
  raw?: unknown;
  /** Last message of a reusable prefix. Anthropic needs an explicit
   *  `cache_control` marker or it caches nothing; OpenAI-compatible and Gemini
   *  endpoints cache the longest identical prefix on their own and ignore this. */
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
      /** Wall-clock deadline of the whole turn. A retry that cannot finish
       *  before it is skipped, so the original upstream error surfaces instead
       *  of being replaced by the caller's timeout. */
      deadlineAt?: number;
    },
  ): Promise<Completion>;
}
export class ModelError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly headers?: Record<string, string>,
    /** Transport-level trouble (DNS, reset, timeout) with no HTTP status. */
    readonly network = false,
  ) {
    super(message);
    this.name = 'ModelError';
  }
  /** Transient upstream trouble (throttle, gateway hiccup, bad server state):
   *  worth retrying with backoff. 4xx except 408/429 are permanent config or
   *  request mistakes — retrying would burn tokens for the same failure.
   *  Network failures carry no status and are exactly the ones a retry fixes. */
  static transient(status?: number, network = false): boolean {
    if (network) return true;
    if (status === undefined) return false;
    return status === 408 || status === 429 || (status >= 500 && status <= 599);
  }
}
type Json = Record<string, any>;
/** Sleep for `ms`, aborting early when the caller cancels (signal optional). */
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
  if (typeof value === 'object' && value !== null && !Array.isArray(value))
    return value as Record<string, unknown>;
  try {
    return JSON.parse(String(value));
  } catch {
    return {};
  }
}
/** Some models inline reasoning as <think>…</think> in content itself instead
 *  of a dedicated field. Strip it — balanced tags removed, then a stray
 *  unmatched tag (often truncated by an output cap) dropped too. */
function stripThinkTags(text: string): string {
  let out = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
  out = out.replace(/<\/?think>/gi, '');
  return out.trimStart();
}
function imageParts(message: ModelMessage, format: ApiFormat): unknown[] {
  const parts: unknown[] = [
    { text: message.content, ...(format === 'anthropic' ? { type: 'text' } : {}) },
  ];
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
    let url: string, body: Json;
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
    if (c.format === 'anthropic') {
      url = `${/\/v\d+$/.test(base) ? base : base + '/v1'}/messages`;
      headers['x-api-key'] = c.apiKey;
      headers['anthropic-version'] = '2023-06-01';
      const converted: Json[] = [];
      // The marker goes on the element that message contributed, attached as
      // soon as it is added: a later same-role message appends to the same
      // block, and marking at the end would move the breakpoint to content that
      // changes every turn.
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
        // Anthropic only caches what is marked explicitly. The system block is
        // the whole stable prefix (persona rules, sticker catalogue), which is
        // identical turn after turn, so it is the highest-value breakpoint.
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
      body = {
        systemInstruction: {
          parts: [
            {
              text: messages
                .filter((m) => m.role === 'system')
                .map((m) => m.content)
                .join('\n\n'),
            },
          ],
        },
        contents: messages
          .filter((m) => m.role !== 'system')
          .map((m) => ({
            role: m.role === 'assistant' ? 'model' : 'user',
            parts:
              m.role === 'tool'
                ? [
                    {
                      functionResponse: {
                        name: m.name,
                        response: { result: argumentsOf(m.content) },
                      },
                    },
                  ]
                : (m.raw ?? imageParts(m, 'gemini')),
          })),
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
    // Two retries with exponential backoff for transient upstream trouble
    // (throttles, gateway hiccups). Abort and permanent 4xx failures throw at
    // once; Retry-After overrides the backoff when the server sends one. The
    // per-request timeout lives inside attempt(), so every try gets its full
    // budget; the caller's signal (turn timeout, cancel) cuts across all of it.
    const outer = options.signal;
    // A retry must fit inside the caller's turn budget. Each attempt gets the
    // full per-request timeout, and with the defaults (45 s x 3 attempts plus
    // backoff) the retries alone outlive the 90 s turn timeout: the third try
    // was always cut off by the caller's signal, so the user saw "no reply"
    // instead of the upstream error that actually caused it.
    let lastError: ModelError;
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.attempt(url, headers, body, outer, c);
      } catch (error) {
        lastError =
          error instanceof ModelError
            ? error
            : new ModelError(error instanceof Error ? error.message : '未知错误');
        if (outer?.aborted) throw new ModelError('模型请求超时或已取消');
        if (attempt >= 2 || !ModelError.transient(lastError.status, lastError.network))
          throw lastError;
      }
      const retryAfter = Number(lastError.headers?.['retry-after']);
      const base =
        Number.isFinite(retryAfter) && retryAfter >= 0
          ? Math.min(retryAfter, 30) * 1000
          : Math.min(1000 * 2 ** attempt, 8000);
      // Full jitter: several peers failing at once must not retry in lockstep
      // and rebuild the same spike that upset the upstream.
      const delay = base * (0.8 + Math.random() * 0.4);
      // A retry that cannot finish inside the turn is worse than no retry: it is
      // aborted mid-flight and reports the cancellation instead of the real
      // upstream failure. Give up with the original error while there is still
      // time to surface it.
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
      // Caller cancellation (turn timeout / shutdown) must never retry.
      if (outer?.aborted) throw new ModelError('模型请求超时或已取消');
      // A per-attempt timeout is its own transient failure: the next try gets
      // a fresh budget, so it belongs in the retryable bucket.
      if (signal.aborted) throw new ModelError('模型请求超时', undefined, undefined, true);
      throw new ModelError(
        `模型连接失败：${error instanceof Error ? error.message : '未知错误'}`,
        undefined,
        undefined,
        true,
      );
    }
    let data: Json;
    try {
      data = (await response.json()) as Json;
    } catch {
      throw new ModelError(`模型返回了无效响应（HTTP ${response.status}）`, response.status);
    }
    if (!response.ok)
      throw new ModelError(
        `模型请求失败（HTTP ${response.status}）：${String(
          data.error?.message ?? data.error ?? '上游错误',
        )
          .replaceAll(c.apiKey, '[已隐藏]')
          .slice(0, 200)}`,
        response.status,
        response.headers.get('retry-after') === null
          ? undefined
          : { 'retry-after': response.headers.get('retry-after')! },
      );
    let text = '',
      calls: ToolCall[] = [],
      raw: unknown,
      inputTokens = 0,
      outputTokens = 0;
    if (c.format === 'anthropic') {
      const content: Json[] = data.content ?? [];
      raw = content;
      text = content
        .filter((p) => p.type === 'text')
        .map((p) => String(p.text ?? ''))
        .join('');
      calls = content
        .filter((p) => p.type === 'tool_use')
        .map((p) => ({ id: String(p.id), name: String(p.name), arguments: argumentsOf(p.input) }));
      inputTokens = Number(data.usage?.input_tokens ?? 0);
      outputTokens = Number(data.usage?.output_tokens ?? 0);
    } else if (c.format === 'gemini') {
      const parts: Json[] = data.candidates?.[0]?.content?.parts ?? [];
      raw = parts;
      text = parts
        .filter((p) => !p.thought && typeof p.text === 'string')
        .map((p) => p.text)
        .join('');
      calls = parts
        .filter((p) => p.functionCall)
        .map((p, i) => ({
          id: String(p.functionCall.id ?? `gemini-${i}`),
          name: String(p.functionCall.name),
          arguments: argumentsOf(p.functionCall.args),
        }));
      inputTokens = Number(data.usageMetadata?.promptTokenCount ?? 0);
      outputTokens = Number(data.usageMetadata?.candidatesTokenCount ?? 0);
    } else {
      const message: Json = data.choices?.[0]?.message ?? {};
      // Thinking models (GLM, DeepSeek-R1, Qwen-W…, and OpenAI-compatible
      // gateways generally) return reasoning in dedicated fields. They must
      // never reach the conversation history: replaying them back inflates
      // every later request, and they are not meant to be shown or stored.
      delete message.reasoning_content;
      delete message.reasoning;
      raw = message;
      text =
        typeof message.content === 'string'
          ? stripThinkTags(message.content)
          : Array.isArray(message.content)
            ? message.content
                .filter((p: Json) => p.type === 'text')
                .map((p: Json) => p.text ?? '')
                .join('')
            : '';
      calls = (message.tool_calls ?? []).map((t: Json) => ({
        id: String(t.id),
        name: String(t.function?.name),
        arguments: argumentsOf(t.function?.arguments),
      }));
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

/** Cosine similarity for equal-length vectors; zero-norm input yields 0. */
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

/**
 * OpenAI-compatible /embeddings client. Works with any provider exposing the
 * standard embeddings endpoint (OpenAI, DeepSeek via compatible gateways,
 * SiliconFlow, local llama.cpp/OLLAMA servers).
 */
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
    const usable = texts.map((t) => t.slice(0, 6000)).map((t) => (t.trim() ? t : '(空)'));
    const base = c.baseUrl.replace(/\/+$/, '').replace(/\/embeddings$/, '');
    const endpoint = `${/\/v\d+$/.test(base) ? base : `${base}/v1`}/embeddings`;
    const timeout = AbortSignal.timeout(c.timeoutMs ?? 30000);
    let response: Response;
    try {
      response = await this.fetcher(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${c.apiKey}` },
        body: JSON.stringify({ model: c.model, input: usable, encoding_format: 'float' }),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (error) {
      throw new Error(`向量服务连接失败：${error instanceof Error ? error.message : '未知错误'}`);
    }
    if (!response.ok)
      throw new Error(
        `向量服务请求失败（HTTP ${response.status}）：${(await response.text().catch(() => '')).slice(0, 200)}`,
      );
    const data = (await response.json()) as {
      data?: { index?: number; embedding: number[] }[];
    };
    if (!Array.isArray(data.data) || data.data.length !== usable.length)
      throw new Error('向量服务返回条数不符');
    const out = new Array<Float32Array>(usable.length);
    for (const item of data.data) {
      const index = typeof item.index === 'number' ? item.index : out.findIndex((v) => !v);
      if (index < 0 || index >= out.length || out[index]) throw new Error('向量服务返回索引无效');
      out[index] = new Float32Array(item.embedding);
    }
    if (out.some((v) => !v)) throw new Error('向量服务返回不完整');
    return out;
  }
}
