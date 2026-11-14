export type Format = 'openai' | 'anthropic' | 'gemini';
export type Channel = 'primary' | 'fallback';

export interface Endpoint {
  format: Format;
  baseUrl: string;
  apiKey: string;
  model: string;
  vision: boolean;
  timeoutMs: number;
  maxTokens: number;
  inputTokens: number;
  retries: number;
  temperature?: number;
}

export interface Call {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  images?: string[];
  calls?: Call[];
  callId?: string;
  name?: string;
  cache?: boolean;
  provider?: Format;
  native?: unknown;
}

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface Completion {
  message: Message;
  usage: { input: number; output: number; cached: number };
  channel?: Channel;
  model?: string;
}

export interface RequestOptions {
  signal?: AbortSignal;
  deadlineAt: number;
  sessionId?: string;
}

export interface Model {
  complete(messages: Message[], tools: Tool[], options: RequestOptions): Promise<Completion>;
}

export class RequestError extends Error {
  constructor(
    message: string,
    readonly kind: 'transport' | 'http' | 'protocol' | 'budget' | 'capability',
    readonly status?: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'RequestError';
  }

  get retryable(): boolean {
    return (
      this.kind === 'transport' ||
      this.status === 408 ||
      this.status === 429 ||
      (this.status !== undefined && this.status >= 500)
    );
  }

  get channelFailure(): boolean {
    return this.kind === 'transport' || this.kind === 'http' || this.kind === 'protocol';
  }
}

export function tokenEstimate(text: string): number {
  let count = 0;
  for (const char of text) count += char.codePointAt(0)! < 128 ? 1 / 3 : 2;
  return Math.ceil(count);
}

export function requestEstimate(messages: Message[], tools: Tool[]): number {
  return (
    128 +
    tokenEstimate(JSON.stringify(tools)) +
    messages.reduce(
      (sum, message) =>
        sum +
        24 +
        tokenEstimate(message.content + JSON.stringify(message.calls ?? [])) +
        (message.images?.length ?? 0) * 4096,
      0,
    )
  );
}

export function checkRequest(endpoint: Endpoint, messages: Message[], tools: Tool[]): void {
  if (messages.some((message) => message.images?.length) && !endpoint.vision)
    throw new RequestError('当前渠道不支持图片输入', 'capability');
  if (requestEstimate(messages, tools) > endpoint.inputTokens)
    throw new RequestError('请求超过渠道输入预算', 'budget');
}

export function abortCheck(options: RequestOptions, now = Date.now()): void {
  options.signal?.throwIfAborted();
  if (now >= options.deadlineAt) throw new DOMException('整轮思考已超时', 'TimeoutError');
}
