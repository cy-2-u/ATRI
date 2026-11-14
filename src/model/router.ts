import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import {
  abortCheck,
  checkRequest,
  RequestError,
  type Channel,
  type Completion,
  type Endpoint,
  type Message,
  type Model,
  type RequestOptions,
  type Tool,
} from './types.js';

export interface Routes {
  primary: Endpoint;
  fallback?: Endpoint;
}

export interface Circuit {
  failures: number;
  cooldownUntil: number;
}

interface State extends Circuit {
  fingerprint: string;
  probe: boolean;
  generation: number;
}

export interface RouterOptions {
  now?: () => number;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
  restore?: (fingerprint: string) => Circuit | undefined;
  persist?: (fingerprint: string, circuit: Circuit) => void;
  observe?: (event: {
    channel: Channel;
    model: string;
    completion?: Completion;
    error?: unknown;
  }) => void;
}

export type Transport = (
  endpoint: Endpoint,
  messages: Message[],
  tools: Tool[],
  options: RequestOptions,
) => Promise<Completion>;

// 路由器与进程同寿命；熔断只属于渠道，不限制她是否思考或表达。
export class ModelRouter implements Model {
  private state?: State;
  private readonly now: () => number;
  private readonly sleep: NonNullable<RouterOptions['sleep']>;

  constructor(
    private readonly routes: () => Routes,
    private readonly transport: Transport,
    private readonly options: RouterOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms, signal) => delay(ms, undefined, { signal }));
  }

  private current(endpoint: Endpoint): State {
    const fingerprint = createHash('sha256')
      .update(JSON.stringify([endpoint.format, endpoint.baseUrl, endpoint.model, endpoint.apiKey]))
      .digest('hex');
    if (this.state?.fingerprint !== fingerprint) {
      const restored = this.options.restore?.(fingerprint);
      this.state = {
        fingerprint,
        failures: restored?.failures ?? 0,
        cooldownUntil: restored?.cooldownUntil ?? 0,
        probe: false,
        generation: 0,
      };
    }
    return this.state;
  }

  status(): Circuit & { probing: boolean } {
    const state = this.current(this.routes().primary);
    return { failures: state.failures, cooldownUntil: state.cooldownUntil, probing: state.probe };
  }

  private save(state: State): void {
    this.options.persist?.(state.fingerprint, {
      failures: state.failures,
      cooldownUntil: state.cooldownUntil,
    });
  }

  private async attempt(
    channel: Channel,
    endpoint: Endpoint,
    messages: Message[],
    tools: Tool[],
    options: RequestOptions,
  ): Promise<Completion> {
    checkRequest(endpoint, messages, tools);
    let failure: unknown;
    for (let index = 0; index <= endpoint.retries; index++) {
      abortCheck(options, this.now());
      try {
        const completion = await this.transport(endpoint, messages, tools, options);
        abortCheck(options, this.now());
        const result = { ...completion, channel, model: endpoint.model };
        this.options.observe?.({ channel, model: endpoint.model, completion: result });
        return result;
      } catch (error) {
        options.signal?.throwIfAborted();
        if (this.now() >= options.deadlineAt) throw error;
        failure = error;
        if (!(error instanceof RequestError) || !error.retryable || index >= endpoint.retries)
          break;
        const backoff =
          error.retryAfterMs ??
          Math.round(400 * 2 ** index * (0.75 + (this.options.random ?? Math.random)() * 0.5));
        if (this.now() + backoff + 100 >= options.deadlineAt) break;
        await this.sleep(backoff, options.signal);
      }
    }
    this.options.observe?.({ channel, model: endpoint.model, error: failure });
    throw failure;
  }

  async complete(messages: Message[], tools: Tool[], options: RequestOptions): Promise<Completion> {
    abortCheck(options, this.now());
    const routes = this.routes();
    const state = this.current(routes.primary);
    const cooled = state.cooldownUntil > this.now();
    const recovering = state.cooldownUntil !== 0 && !cooled;
    let primaryError: unknown;
    if (!cooled && !(recovering && state.probe)) {
      if (recovering) state.probe = true;
      const generation = state.generation;
      const remaining = options.deadlineAt - this.now();
      const reserve = routes.fallback
        ? Math.min(routes.fallback.timeoutMs, Math.floor(remaining / 2))
        : 0;
      const primaryOptions = { ...options, deadlineAt: options.deadlineAt - reserve };
      try {
        const result = await this.attempt(
          'primary',
          routes.primary,
          messages,
          tools,
          primaryOptions,
        );
        if (generation === state.generation) {
          state.failures = 0;
          state.cooldownUntil = 0;
          state.generation++;
          this.save(state);
        }
        return result;
      } catch (error) {
        options.signal?.throwIfAborted();
        primaryError = error;
        if (
          error instanceof RequestError &&
          error.channelFailure &&
          generation === state.generation
        ) {
          state.failures++;
          if (state.failures >= 3) {
            state.cooldownUntil = this.now() + 3_600_000;
            state.generation++;
          }
          this.save(state);
        }
      } finally {
        if (recovering) state.probe = false;
      }
    }
    abortCheck(options, this.now());
    if (!routes.fallback) {
      if (primaryError) throw primaryError;
      throw new RequestError('主渠道冷却中，尚未配置备用渠道', 'capability');
    }
    try {
      return await this.attempt('fallback', routes.fallback, messages, tools, options);
    } catch (error) {
      if (primaryError)
        throw new AggregateError([primaryError, error], '主渠道与备用渠道均未完成请求');
      throw error;
    }
  }
}
