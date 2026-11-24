import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import type { Endpoint, Config } from './config.ts';
import { apiBase, configured } from './config.ts';
import type { Completion, Message, ToolDefinition, Usage } from './types.ts';
import { object, errorText } from './types.ts';
import { estimate } from './state.ts';
import { HttpError, jsonRequest, readBounded, sleep } from './net.ts';
import type { Store } from './store.ts';

export interface CallOptions {
  signal: AbortSignal; purpose: string; cacheKey: string; final?: boolean; only?: Endpoint;
  /** 流式传输时的正文增量回调（渐进投递：调用方喂给 JsonStreamParser 找气泡边界）。
   *  只有渠道探测为强制流式时才会被调用；非流式请求整包返回，不触发。 */
  onDelta?: (delta: string) => void;
}
export class ModelError extends Error {
  retryable: boolean;
  terminal: boolean;
  constructor(message: string, retryable = false, terminal = false) { super(message); this.retryable = retryable; this.terminal = terminal; }
}
const count = (v: unknown): number => typeof v === 'number' && Number.isFinite(v) ? Math.max(0, v) : 0;

export function requestTokens(messages: Message[], tools: ToolDefinition[]): number {
  return 128 + estimate(JSON.stringify(tools)) + messages.reduce((n, m) => n + 18 + estimate(m.content + (m.reasoning ?? '') + JSON.stringify(m.calls ?? []) + (Array.isArray(m.native) ? JSON.stringify(m.native.filter(b => b?.type !== 'image')) : '')) + (m.images?.length ?? 0) * 2048, 0);
}

export function encode(endpoint: Endpoint, messages: Message[], tools: ToolDefinition[], options: CallOptions): { url: string; headers: Record<string, string>; body: Record<string, unknown> } {
  const base = apiBase(endpoint.url);
  if (endpoint.format === 'anthropic') {
    const blocks = (m: Message): Record<string, unknown>[] => {
      if (m.role === 'tool') return [{ type: 'tool_result', tool_use_id: m.callId, content: m.content }];
      if (Array.isArray(m.native)) return m.native as Record<string, unknown>[];
      return [
        ...(m.content ? [{ type: 'text', text: m.content }] : []),
        ...(m.images ?? []).map(image => {
          const data = /^data:(image\/[\w.+-]+);base64,([\s\S]+)$/.exec(image);
          if (!data) throw new ModelError('图片必须是受控 data URI');
          return { type: 'image', source: { type: 'base64', media_type: data[1], data: data[2] } };
        }),
        ...(m.calls ?? []).map(c => ({ type: 'tool_use', id: c.id, name: c.name, input: c.args })),
      ];
    };
    const cache = endpoint.cache === 'anthropic' ? { type: 'ephemeral', ...(endpoint.cacheRetention === '1h' ? { ttl: '1h' } : {}) } : undefined;
    const system = messages.filter(m => m.role === 'system').map(m => ({ type: 'text', text: m.content, ...(cache ? { cache_control: cache } : {}) }));
    const conversation: { role: string; content: Record<string, unknown>[] }[] = [];
    for (const m of messages.filter(m => m.role !== 'system')) {
      const role = m.role === 'assistant' ? 'assistant' : 'user';
      const content = blocks(m);
      if (!content.length) content.push({ type: 'text', text: ' ' });
      if (conversation.at(-1)?.role === role) conversation.at(-1)!.content.push(...content);
      else conversation.push({ role, content });
    }
    return { url: `${base}/messages`, headers: { 'x-api-key': endpoint.key, 'anthropic-version': '2023-06-01' }, body: { model: endpoint.model, max_tokens: endpoint.outputTokens, system, messages: conversation, ...(endpoint.temperature !== undefined ? { temperature: endpoint.temperature } : {}), ...(tools.length ? { tools: tools.map(t => ({ name: t.name, description: t.description, input_schema: t.parameters })), ...(options.final ? { tool_choice: { type: 'none' } } : {}) } : {}) } };
  }
  return {
    url: `${base}/chat/completions`, headers: { authorization: `Bearer ${endpoint.key}` },
    body: {
      model: endpoint.model,
      [endpoint.completionTokens ? 'max_completion_tokens' : 'max_tokens']: endpoint.outputTokens,
      messages: messages.map(m => m.role === 'tool' ? { role: 'tool', tool_call_id: m.callId, content: m.content } : {
        role: m.role,
        content: m.images?.length ? [{ type: 'text', text: m.content }, ...m.images.map(url => ({ type: 'image_url', image_url: { url, detail: 'auto' } }))] : m.content || (m.calls?.length ? null : ''),
        ...(m.reasoning !== undefined ? { reasoning_content: m.reasoning } : {}),
        ...(m.calls?.length ? { tool_calls: m.calls.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })) } : {}),
      }),
      ...(tools.length ? { tools: tools.map(t => ({ type: 'function', function: t })), tool_choice: options.final ? 'none' : 'auto' } : {}),
      ...(endpoint.json ? { response_format: { type: 'json_object' } } : {}),
      ...(endpoint.temperature !== undefined ? { temperature: endpoint.temperature } : {}),
      ...(endpoint.cache === 'openai' ? { prompt_cache_key: options.cacheKey, ...(endpoint.cacheRetention === '24h' ? { prompt_cache_retention: '24h' } : {}) } : {}),
    },
  };
}

/** 强制流式渠道的 SSE 聚合：delta 增量拼回与非流式同构的回包，decode 照常解析。
 *  只做传输层——校验与投递节奏不变，第一条气泡仍等完整决定过审才出门。 */
export function sseAggregate(raw: string): Record<string, unknown> {
  let content = '', reasoning: string | undefined, finish = '';
  const calls = new Map<number, { id: string; name: string; args: string }>();
  let usage: Record<string, unknown> | undefined;
  for (const line of raw.split('\n')) {
    const m = /^data:\s*(.+?)\s*$/.exec(line);
    if (!m) continue;
    if (m[1] === '[DONE]') break;
    let frame: Record<string, unknown>;
    try { frame = object(JSON.parse(m[1]!)); } catch { continue; }
    const choice = Array.isArray(frame.choices) && frame.choices.length ? object(frame.choices[0]) : undefined;
    if (choice) {
      const delta = choice.delta ? object(choice.delta) : {};
      if (typeof delta.content === 'string') content += delta.content;
      if (typeof delta.reasoning_content === 'string') reasoning = (reasoning ?? '') + delta.reasoning_content;
      if (Array.isArray(delta.tool_calls)) for (const value of delta.tool_calls) {
        const tc = object(value), acc = calls.get(Number(tc.index ?? 0)) ?? { id: '', name: '', args: '' };
        if (typeof tc.id === 'string' && tc.id) acc.id = tc.id;
        const fn = tc.function ? object(tc.function) : {};
        if (typeof fn.name === 'string' && fn.name && !acc.name) acc.name = fn.name; // 名字只在首帧，后续帧是增量 arguments
        if (typeof fn.arguments === 'string') acc.args += fn.arguments;
        calls.set(Number(tc.index ?? 0), acc);
      }
      if (typeof choice.finish_reason === 'string' && choice.finish_reason) finish = choice.finish_reason;
    }
    if (frame.usage && typeof frame.usage === 'object') usage = object(frame.usage);
  }
  const message: Record<string, unknown> = { role: 'assistant', content };
  if (reasoning !== undefined) message.reasoning_content = reasoning;
  const toolCalls = [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.args } }));
  if (toolCalls.length) message.tool_calls = toolCalls;
  const data: Record<string, unknown> = { choices: [{ message, finish_reason: finish }] };
  if (usage) data.usage = usage;
  return data;
}

export function decode(endpoint: Endpoint, data: Record<string, unknown>): Completion {  let message: Message, finish: string;
  let usage: Usage;
  if (endpoint.format === 'anthropic') {
    if (!Array.isArray(data.content)) throw new ModelError('Anthropic 回包缺少 content');
    const blocks = data.content.map(object);
    message = { role: 'assistant', content: blocks.filter(b => b.type === 'text').map(b => String(b.text ?? '')).join(''), native: blocks,
      calls: blocks.filter(b => b.type === 'tool_use').map(b => ({ id: String(b.id ?? ''), name: String(b.name ?? ''), args: object(b.input) })) };
    const u = data.usage ? object(data.usage) : {};
    const cached = count(u.cache_read_input_tokens), cacheWrite = count(u.cache_creation_input_tokens);
    usage = { input: count(u.input_tokens) + cached + cacheWrite, output: count(u.output_tokens), cached, cacheWrite };
    finish = String(data.stop_reason ?? '');
  } else {
    const choices = data.choices;
    if (!Array.isArray(choices) || !choices.length) throw new ModelError('渠道没有返回候选');
    const choice = object(choices[0]), m = object(choice.message);
    const calls = Array.isArray(m.tool_calls) ? m.tool_calls.map(value => {
      const c = object(value), f = object(c.function);
      let args: Record<string, unknown>;
      try { args = object(JSON.parse(String(f.arguments ?? '{}'))); } catch { throw new ModelError('工具参数不是合法 JSON'); }
      return { id: String(c.id ?? ''), name: String(f.name ?? ''), args };
    }) : [];
    if (m.refusal) throw new ModelError('模型渠道拒绝生成', false, true);
    message = { role: 'assistant', content: typeof m.content === 'string' ? m.content : '', ...(typeof m.reasoning_content === 'string' ? { reasoning: m.reasoning_content } : {}), ...(calls.length ? { calls } : {}) };
    const u = data.usage ? object(data.usage) : {};
    const details = u.prompt_tokens_details ? object(u.prompt_tokens_details) : {};
    usage = { input: count(u.prompt_tokens), output: count(u.completion_tokens), cached: count(details.cached_tokens ?? u.prompt_cache_hit_tokens), cacheWrite: 0 };
    finish = String(choice.finish_reason ?? '');
  }
  if (message.calls?.some(c => !c.id || !c.name)) throw new ModelError('工具调用缺少标识');
  if (!message.content && !message.calls?.length) throw new ModelError('模型没有返回正文或工具');
  if (['length', 'max_tokens'].includes(finish)) throw new ModelError('模型输出被容量截断，未执行不完整决定');
  if (['content_filter', 'refusal'].includes(finish)) throw new ModelError('模型渠道拒绝生成', false, true);
  return { message, usage, finish };
}

export function usageCost(endpoint: Endpoint, usage: Partial<Usage>): number | undefined {
  if (usage.input === undefined || usage.output === undefined) return undefined;
  const cached = usage.cached ?? 0, write = usage.cacheWrite ?? 0, fresh = usage.input - cached - write;
  if (fresh < 0 || fresh > 0 && endpoint.inputPrice <= 0 || cached > 0 && endpoint.cachedPrice <= 0 || write > 0 && endpoint.cacheWritePrice <= 0 || usage.output > 0 && endpoint.outputPrice <= 0) return undefined;
  return (fresh * endpoint.inputPrice + cached * endpoint.cachedPrice + write * endpoint.cacheWritePrice + usage.output * endpoint.outputPrice) / 1000000;
}

/** 渠道能力探测结果存 kv（key 含 url+model）：流式是渠道属性不是用户偏好，
 *  测试按钮或运行时自愈写入后永久生效。'optional'=非流式可用；'required'=强制流式。 */
export const streamProbeKey = (endpoint: Endpoint): string => `probe:stream:${endpoint.url}:${endpoint.model}`;

// ---------- 渠道探测（测试按钮三合一；独立裸 HTTP，不走 complete——不碰 finish=length 语义、不污染熔断表） ----------

/** 纯色 PNG 生成（1×1）：识图探测用真实图片，渠道忽略图片照样 200 回文字是假 vision。 */
function solidPng(r: number, g: number, b: number): Buffer {
  const crcTable = [...Array(256)].map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc32 = (chunk: Buffer): number => { let c = 0xffffffff; for (const byte of chunk) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunkOf = (type: string, data: Buffer): Buffer => {
    const head = Buffer.alloc(4); head.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([head, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 2; // 1x1 8bit RGB
  const idat = deflateSync(Buffer.from([0, r, g, b])); // 每行 1 filter 字节 + RGB
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunkOf('IHDR', ihdr), chunkOf('IDAT', idat), chunkOf('IEND', Buffer.alloc(0))]);
}

const COLOR_WORDS = ['红', '赤', '朱', '红红', 'red', '红色'];

export class Probes {
  /** 流式探测：max_tokens=1 的非流式探针。200=非流式可用；400 且错误体提到流式=强制流式。 */
  async stream(endpoint: Endpoint, signal: AbortSignal): Promise<'required' | 'optional'> {
    const request = encode(endpoint, [{ role: 'user', content: '仅回复OK' }], [], { signal, purpose: 'probe', cacheKey: 'probe' });
    const body: Record<string, unknown> = { ...request.body, stream: false };
    if (endpoint.format === 'anthropic') body.max_tokens = 1;
    else body[endpoint.completionTokens ? 'max_completion_tokens' : 'max_tokens'] = 1;
    try {
      await jsonRequest(request.url, { method: 'POST', headers: { 'content-type': 'application/json', ...request.headers }, body: JSON.stringify(body), signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]) });
      return 'optional';
    } catch (error) {
      if (error instanceof HttpError && error.status === 400 && JSON.stringify(error.data ?? '').toLowerCase().includes('stream')) return 'required';
      throw error;
    }
  }

  /** 识图探测：1×1 纯红图问颜色，回复含红色词才算支持。 */
  async vision(endpoint: Endpoint, signal: AbortSignal): Promise<{ ok: boolean; reply: string }> {
    const dataUri = `data:image/png;base64,${solidPng(255, 0, 0).toString('base64')}`;
    const request = encode(endpoint, [{ role: 'user', content: '这张图片是什么颜色？只回答颜色词。', images: [dataUri] }], [], { signal, purpose: 'probe', cacheKey: 'probe' });
    const body: Record<string, unknown> = { ...request.body };
    if (endpoint.format === 'anthropic') body.max_tokens = 16;
    else body[endpoint.completionTokens ? 'max_completion_tokens' : 'max_tokens'] = 16;
    const { data } = await jsonRequest(request.url, { method: 'POST', headers: { 'content-type': 'application/json', ...request.headers }, body: JSON.stringify(body), signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]) });
    const completion = decode(endpoint, data);
    const reply = completion.message.content.trim();
    return { ok: COLOR_WORDS.some(w => reply.toLowerCase().includes(w)), reply };
  }
}

export class Models {
  private config: () => Config;
  private store: Store;
  private failures = new Map<string, { count: number; until: number }>();
  constructor(config: () => Config, store: Store) { this.config = config; this.store = store; }

  async complete(messages: Message[], tools: ToolDefinition[], options: CallOptions): Promise<Completion> {
    const c = this.config();
    const channels = options.only ? [options.only] : [c.primary, c.fallback].filter(configured);
    if (!channels.length) throw new ModelError('请配置模型地址、密钥和名称');
    let last: unknown;
    for (const endpoint of channels) {
      const key = `${endpoint.url}:${endpoint.model}`;
      const failure = this.failures.get(key);
      if (failure && failure.until > Date.now() && channels.length > 1) continue;
      if (requestTokens(messages, tools) + endpoint.outputTokens > endpoint.contextTokens) { last = new ModelError('请求与输出预留超过渠道上下文容量'); continue; }
      if (messages.some(m => m.images?.length) && !endpoint.vision) { last = new ModelError('备用渠道不支持本轮图片，不能静默丢弃'); continue; }
      // 流式是渠道属性：探测为强制 SSE 则走流式（传输层聚合，正文增量喂给渐进投递）；
      // 未探测过则非流式起步，被 400 streaming 拒绝时本轮切流式并记住，永不再问。
      let useStream = this.store.get<string | undefined>(streamProbeKey(endpoint), undefined) === 'required';
      for (let attempt = 0; attempt < 2; attempt++) {
        options.signal.throwIfAborted();
        const started = Date.now();
        const request = encode(endpoint, messages, tools, options);
        let data: Record<string, unknown> | undefined;
        try {
          if (useStream) data = await this.streamOnce(endpoint, request, options);
          else {
            ({ data } = await jsonRequest(request.url, { method: 'POST', headers: { 'content-type': 'application/json', ...request.headers }, body: JSON.stringify(request.body), signal: AbortSignal.any([options.signal, AbortSignal.timeout(endpoint.timeoutMs)]) }));
          }
          const completion = decode(endpoint, data);
          const u = completion.usage;
          const cost = usageCost(endpoint, u);
          this.store.recordUsage({ purpose: options.purpose, model: endpoint.model, endpoint: endpoint.url, status: 'ok', ...(data.usage ? { ...u, cost } : {}), latency: Date.now() - started });
          this.failures.delete(key);
          return completion;
        } catch (error) {
          // 已收到但结构错误的响应仍可能计费，先记录原始 usage。
          let billed: Partial<Usage> = {};
          if (data?.usage) {
            const u = object(data.usage), details = u.prompt_tokens_details ? object(u.prompt_tokens_details) : {};
            billed = endpoint.format === 'anthropic' ? { input: count(u.input_tokens) + count(u.cache_read_input_tokens) + count(u.cache_creation_input_tokens), output: count(u.output_tokens), cached: count(u.cache_read_input_tokens), cacheWrite: count(u.cache_creation_input_tokens) } : { input: count(u.prompt_tokens), output: count(u.completion_tokens), cached: count(details.cached_tokens ?? u.prompt_cache_hit_tokens), cacheWrite: 0 };
          }
          this.store.recordUsage({ purpose: options.purpose, model: endpoint.model, endpoint: endpoint.url, status: options.signal.aborted ? 'cancelled' : 'failed', ...billed, cost: usageCost(endpoint, billed), latency: Date.now() - started, error: errorText(error) });
          options.signal.throwIfAborted(); last = error;
          // 探测错误 ≠ 不支持：只有 400+streaming 这种确定性证据才写回探测结果
          if (!useStream && error instanceof HttpError && error.status === 400 && JSON.stringify(error.data ?? '').toLowerCase().includes('stream')) {
            this.store.set(streamProbeKey(endpoint), 'required');
            useStream = true;
            continue;
          }
          if (error instanceof ModelError && error.terminal) throw error;
          const retryable = error instanceof HttpError ? [408, 429].includes(error.status) || error.status >= 500 : !(error instanceof ModelError);
          const failures = (this.failures.get(key)?.count ?? 0) + 1;
          this.failures.set(key, { count: failures, until: failures >= 3 ? Date.now() + Math.min(60000 * failures, 300000) : 0 });
          if (!retryable || attempt > 0) break;
          await sleep(Math.max(600, error instanceof HttpError ? Math.min(error.retryAfter, 15000) : 600), options.signal);
        }
      }
    }
    throw new ModelError(errorText(last ?? '所有模型渠道暂不可用'), !(last instanceof ModelError));
  }

  /** 强制流式渠道的单次请求：SSE 增量解析出正文喂给 onDelta（渐进投递找气泡边界），
   *  全量 raw 聚合回与非流式同构的回包。失败语义与普通请求一致。 */
  private async streamOnce(endpoint: Endpoint, request: { url: string; headers: Record<string, string>; body: Record<string, unknown> }, options: CallOptions): Promise<Record<string, unknown>> {
    const response = await fetch(request.url, { method: 'POST', headers: { 'content-type': 'application/json', ...request.headers }, body: JSON.stringify({ ...request.body, stream: true, stream_options: { include_usage: true } }), signal: AbortSignal.any([options.signal, AbortSignal.timeout(endpoint.timeoutMs)]) });
    if (!response.ok) {
      const bytes = await readBounded(response, 1024 * 1024);
      let errData: Record<string, unknown> | undefined;
      try { errData = object(JSON.parse(Buffer.from(bytes).toString('utf8'))); } catch { /* 错误体不是 JSON 就只报状态码 */ }
      throw new HttpError(response.status, `HTTP ${response.status}`, Number(response.headers.get('retry-after') ?? 0) * 1000, errData);
    }
    const reader = response.body?.getReader();
    if (!reader) throw new ModelError('渠道流式响应没有正文');
    const decoder = new TextDecoder();
    let raw = '', lineBuf = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        raw += text;
        if (raw.length > 8 * 1024 * 1024) { await reader.cancel(); throw new ModelError('流式响应超过读取上限'); }
        lineBuf += text;
        let idx: number;
        while ((idx = lineBuf.indexOf('\n')) >= 0) {
          const line = lineBuf.slice(0, idx); lineBuf = lineBuf.slice(idx + 1);
          const m = /^data:\s*(.+?)\s*$/.exec(line);
          if (!m || m[1] === '[DONE]') continue;
          try {
            const frame = object(JSON.parse(m[1]!));
            const choice = Array.isArray(frame.choices) && frame.choices.length ? object(frame.choices[0]) : undefined;
            const delta = choice?.delta ? object(choice.delta) : undefined;
            if (typeof delta?.content === 'string' && delta.content) options.onDelta?.(delta.content);
          } catch { /* 坏帧跳过，聚合兜底 */ }
        }
      }
    } finally { reader.releaseLock(); }
    return sseAggregate(raw);
  }

  cacheKey(peer: string, persona: string, tools: ToolDefinition[]): string {
    return `atri:${createHash('sha256').update(peer + persona + JSON.stringify(tools)).digest('hex').slice(0, 32)}`;
  }

  /** 渠道模型目录：OpenAI 与 Anthropic 的 /models 都返回 { data: [{ id }] }。 */
  async list(endpoint: Endpoint, signal: AbortSignal): Promise<string[]> {
    const base = apiBase(endpoint.url);
    const headers: Record<string, string> = endpoint.format === 'anthropic' ? { 'x-api-key': endpoint.key, 'anthropic-version': '2023-06-01' } : { authorization: `Bearer ${endpoint.key}` };
    const { data } = await jsonRequest(`${base}/models`, { headers, signal: AbortSignal.any([signal, AbortSignal.timeout(endpoint.timeoutMs)]) });
    const items = Array.isArray((data as Record<string, unknown>).data) ? (data as { data: Record<string, unknown>[] }).data : [];
    const ids = [...new Set(items.map(item => String(object(item).id ?? '')).filter(Boolean))].sort();
    if (!ids.length) throw new ModelError('渠道返回了空模型列表');
    return ids;
  }
}
