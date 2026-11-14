import { randomUUID } from 'node:crypto';
import {
  abortCheck,
  RequestError,
  type Call,
  type Completion,
  type Endpoint,
  type Message,
  type RequestOptions,
  type Tool,
} from './types.js';

type ObjectValue = Record<string, any>;
const object = (value: unknown): ObjectValue =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as ObjectValue) : {};
const array = (value: unknown): ObjectValue[] => (Array.isArray(value) ? value : []);
const count = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0;

function argumentsOf(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') return object(value);
  try {
    return object(JSON.parse(value));
  } catch {
    throw new RequestError('模型工具参数不是有效 JSON', 'protocol');
  }
}

function imageData(image: string): { mime: string; data: string } {
  const match = /^data:(image\/[\w.+-]+);base64,([A-Za-z0-9+/=\r\n]+)$/.exec(image);
  if (!match) throw new RequestError('图片必须是受控的 data URL', 'capability');
  return { mime: match[1]!, data: match[2]! };
}

function openai(messages: Message[], tools: Tool[], endpoint: Endpoint): ObjectValue {
  return {
    model: endpoint.model,
    max_tokens: endpoint.maxTokens,
    ...(endpoint.temperature === undefined ? {} : { temperature: endpoint.temperature }),
    messages: messages.map((message) => ({
      role: message.role,
      content: message.images?.length
        ? [
            { type: 'text', text: message.content },
            ...message.images.map((image) => ({ type: 'image_url', image_url: { url: image } })),
          ]
        : message.content,
      ...(message.calls?.length
        ? {
            tool_calls: message.calls.map((call) => ({
              id: call.id,
              type: 'function',
              function: { name: call.name, arguments: JSON.stringify(call.arguments) },
            })),
          }
        : {}),
      ...(message.role === 'tool' ? { tool_call_id: message.callId } : {}),
    })),
    ...(tools.length ? { tools: tools.map((tool) => ({ type: 'function', function: tool })) } : {}),
  };
}

function anthropic(messages: Message[], tools: Tool[], endpoint: Endpoint): ObjectValue {
  const output: { role: string; content: ObjectValue[] }[] = [];
  for (const message of messages.filter((message) => message.role !== 'system')) {
    const role = message.role === 'assistant' ? 'assistant' : 'user';
    let blocks: ObjectValue[];
    if (message.role === 'tool')
      blocks = [{ type: 'tool_result', tool_use_id: message.callId, content: message.content }];
    else if (message.provider === 'anthropic' && Array.isArray(message.native))
      blocks = structuredClone(message.native);
    else
      blocks = [
        ...(message.content ? [{ type: 'text', text: message.content }] : []),
        ...(message.images ?? []).map((image) => {
          const data = imageData(image);
          return {
            type: 'image',
            source: { type: 'base64', media_type: data.mime, data: data.data },
          };
        }),
        ...(message.calls ?? []).map((call) => ({
          type: 'tool_use',
          id: call.id,
          name: call.name,
          input: call.arguments,
        })),
      ];
    if (!blocks.length) blocks.push({ type: 'text', text: ' ' });
    if (message.cache)
      blocks[blocks.length - 1] = { ...blocks.at(-1), cache_control: { type: 'ephemeral' } };
    if (output.at(-1)?.role === role) output.at(-1)!.content.push(...blocks);
    else output.push({ role, content: blocks });
  }
  return {
    model: endpoint.model,
    max_tokens: endpoint.maxTokens,
    ...(endpoint.temperature === undefined ? {} : { temperature: endpoint.temperature }),
    system: messages
      .filter((message) => message.role === 'system')
      .map((message) => ({
        type: 'text',
        text: message.content,
        cache_control: { type: 'ephemeral' },
      })),
    messages: output,
    ...(tools.length
      ? {
          tools: tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            input_schema: tool.parameters,
          })),
        }
      : {}),
  };
}

function gemini(messages: Message[], tools: Tool[], endpoint: Endpoint): ObjectValue {
  const contents: { role: string; parts: ObjectValue[] }[] = [];
  for (const message of messages.filter((message) => message.role !== 'system')) {
    const role = message.role === 'assistant' ? 'model' : 'user';
    let parts: ObjectValue[];
    if (message.role === 'tool') {
      let response: ObjectValue;
      try {
        response = object(JSON.parse(message.content));
      } catch {
        response = { result: message.content };
      }
      parts = [{ functionResponse: { name: message.name, response } }];
    } else if (message.provider === 'gemini' && Array.isArray(message.native))
      parts = structuredClone(message.native);
    else
      parts = [
        ...(message.content ? [{ text: message.content }] : []),
        ...(message.images ?? []).map((image) => {
          const data = imageData(image);
          return { inlineData: { mimeType: data.mime, data: data.data } };
        }),
        ...(message.calls ?? []).map((call) => ({
          functionCall: { name: call.name, args: call.arguments },
        })),
      ];
    if (!parts.length) parts.push({ text: ' ' });
    if (contents.at(-1)?.role === role) contents.at(-1)!.parts.push(...parts);
    else contents.push({ role, parts });
  }
  return {
    systemInstruction: {
      parts: messages
        .filter((message) => message.role === 'system')
        .map((message) => ({ text: message.content })),
    },
    contents,
    generationConfig: {
      maxOutputTokens: endpoint.maxTokens,
      ...(endpoint.temperature === undefined ? {} : { temperature: endpoint.temperature }),
    },
    ...(tools.length ? { tools: [{ functionDeclarations: tools }] } : {}),
  };
}

export function encode(
  endpoint: Endpoint,
  messages: Message[],
  tools: Tool[],
): { url: string; headers: Record<string, string>; body: ObjectValue } {
  const base = endpoint.baseUrl.replace(/\/+$/, '');
  if (endpoint.format === 'anthropic')
    return {
      url: `${base.endsWith('/v1') ? base : `${base}/v1`}/messages`,
      headers: { 'x-api-key': endpoint.apiKey, 'anthropic-version': '2023-06-01' },
      body: anthropic(messages, tools, endpoint),
    };
  if (endpoint.format === 'gemini')
    return {
      url: `${/\/v1(?:beta)?$/.test(base) ? base : `${base}/v1beta`}/models/${encodeURIComponent(endpoint.model)}:generateContent`,
      headers: { 'x-goog-api-key': endpoint.apiKey },
      body: gemini(messages, tools, endpoint),
    };
  return {
    url: `${base.endsWith('/v1') ? base : `${base}/v1`}/chat/completions`,
    headers: { authorization: `Bearer ${endpoint.apiKey}` },
    body: openai(messages, tools, endpoint),
  };
}

export function decode(endpoint: Endpoint, data: ObjectValue): Completion {
  let text = '',
    calls: Call[] = [],
    native: unknown;
  let input = 0,
    output = 0,
    cached = 0;
  if (endpoint.format === 'anthropic') {
    if (!Array.isArray(data.content))
      throw new RequestError('Anthropic 响应缺少 content', 'protocol');
    native = data.content;
    for (const block of array(data.content)) {
      if (block.type === 'text') text += String(block.text ?? '');
      if (block.type === 'tool_use')
        calls.push({
          id: String(block.id),
          name: String(block.name),
          arguments: argumentsOf(block.input),
        });
    }
    const usage = object(data.usage);
    cached = count(usage.cache_read_input_tokens);
    input = count(usage.input_tokens) + count(usage.cache_creation_input_tokens) + cached;
    output = count(usage.output_tokens);
  } else if (endpoint.format === 'gemini') {
    const candidate = array(data.candidates)[0];
    if (!candidate || !Array.isArray(candidate.content?.parts))
      throw new RequestError('Gemini 响应缺少候选内容', 'protocol');
    native = candidate.content.parts;
    for (const part of array(native)) {
      if (typeof part.text === 'string' && !part.thought) text += part.text;
      if (part.functionCall)
        calls.push({
          id: randomUUID(),
          name: String(part.functionCall.name),
          arguments: argumentsOf(part.functionCall.args),
        });
    }
    const usage = object(data.usageMetadata);
    input = count(usage.promptTokenCount);
    output = count(usage.candidatesTokenCount) + count(usage.thoughtsTokenCount);
    cached = count(usage.cachedContentTokenCount);
  } else {
    const message = array(data.choices)[0]?.message;
    if (!message || typeof message !== 'object')
      throw new RequestError('OpenAI 响应缺少 message', 'protocol');
    text = typeof message.content === 'string' ? message.content : '';
    calls = array(message.tool_calls).map((call) => ({
      id: String(call.id ?? randomUUID()),
      name: String(call.function?.name ?? ''),
      arguments: argumentsOf(call.function?.arguments),
    }));
    const usage = object(data.usage);
    input = count(usage.prompt_tokens);
    output = count(usage.completion_tokens);
    cached = count(usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens);
  }
  text = text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<\/?think>/gi, '')
    .trim();
  if (!text && !calls.length) throw new RequestError('模型没有返回正文或工具调用', 'protocol');
  if (calls.some((call) => !call.name || !call.id))
    throw new RequestError('模型工具调用缺少标识', 'protocol');
  return {
    message: {
      role: 'assistant',
      content: text,
      ...(calls.length ? { calls } : {}),
      ...(native ? { provider: endpoint.format, native } : {}),
    },
    usage: { input, output, cached },
  };
}

async function boundedJson(response: Response): Promise<ObjectValue> {
  const reader = response.body?.getReader();
  if (!reader) throw new RequestError('模型响应为空', 'protocol');
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.length;
      if (length > 8 * 1024 * 1024) {
        await reader.cancel();
        throw new RequestError('模型响应超过 8 MiB', 'protocol');
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return object(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  } catch {
    throw new RequestError('模型响应不是有效 JSON', 'protocol');
  }
}

export async function httpTransport(
  endpoint: Endpoint,
  messages: Message[],
  tools: Tool[],
  options: RequestOptions,
): Promise<Completion> {
  abortCheck(options);
  const request = encode(endpoint, messages, tools);
  const timeout = AbortSignal.timeout(
    Math.max(1, Math.min(endpoint.timeoutMs, options.deadlineAt - Date.now())),
  );
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  try {
    const response = await fetch(request.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...request.headers },
      body: JSON.stringify(request.body),
      signal,
      redirect: 'error',
    });
    if (!response.ok) {
      const retry = response.headers.get('retry-after');
      const retryAfterMs = retry
        ? Math.min(
            60_000,
            Math.max(
              0,
              /^\d+(\.\d+)?$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - Date.now(),
            ),
          )
        : undefined;
      await response.body?.cancel();
      throw new RequestError(
        `模型渠道返回 HTTP ${response.status}`,
        'http',
        response.status,
        Number.isFinite(retryAfterMs) ? retryAfterMs : undefined,
      );
    }
    return decode(endpoint, await boundedJson(response));
  } catch (error) {
    options.signal?.throwIfAborted();
    if (error instanceof RequestError) throw error;
    throw new RequestError(timeout.aborted ? '模型渠道请求超时' : '模型渠道连接失败', 'transport');
  }
}
