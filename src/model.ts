import { createHash } from 'node:crypto';
import type { Endpoint, Config } from './config.ts';
import { apiBase, configured } from './config.ts';
import type { Completion, Message, ToolDefinition, Usage } from './types.ts';
import { object, errorText } from './types.ts';
import { estimate } from './state.ts';
import { HttpError, jsonRequest, sleep } from './net.ts';
import type { Store } from './store.ts';

export interface CallOptions { signal: AbortSignal; purpose: string; cacheKey: string; final?: boolean; only?: Endpoint }
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

export function decode(endpoint: Endpoint, data: Record<string, unknown>): Completion {
  let message: Message, finish: string;
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
      for (let attempt = 0; attempt < 2; attempt++) {
        options.signal.throwIfAborted();
        const started = Date.now();
        const request = encode(endpoint, messages, tools, options);
        let data: Record<string, unknown> | undefined;
        try {
          ({ data } = await jsonRequest(request.url, { method: 'POST', headers: { 'content-type': 'application/json', ...request.headers }, body: JSON.stringify(request.body), signal: AbortSignal.any([options.signal, AbortSignal.timeout(endpoint.timeoutMs)]) }));
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
