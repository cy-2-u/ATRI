import test from 'node:test';
import assert from 'node:assert/strict';
import { ModelRouter, type Transport } from '../src/model/router.js';
import { decode, encode } from '../src/model/http.js';
import { RequestError, type Completion, type Endpoint, type Message } from '../src/model/types.js';

const endpoint = (model: string): Endpoint => ({
  format: 'openai',
  baseUrl: 'https://example.org',
  apiKey: 'test-secret',
  model,
  vision: false,
  timeoutMs: 1000,
  maxTokens: 100,
  inputTokens: 2000,
  retries: 2,
});
const messages: Message[] = [
  { role: 'system', content: 'stable', cache: true },
  { role: 'user', content: 'hello' },
];
const completion = (): Completion => ({
  message: { role: 'assistant', content: 'ok' },
  usage: { input: 10, output: 1, cached: 5 },
});

function setup(transport: Transport) {
  let now = 1000;
  const routes = { primary: endpoint('primary'), fallback: endpoint('fallback') };
  const router = new ModelRouter(() => routes, transport, {
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    random: () => 0.5,
  });
  return {
    router,
    routes,
    options: () => ({ deadlineAt: now + 30_000 }),
    advance: (ms: number) => {
      now += ms;
    },
  };
}

test('主渠道重试耗尽后使用备用，连续三轮失败冷却一小时，恢复成功清零', async () => {
  const calls: string[] = [];
  let healthy = false;
  const env = setup(async (config) => {
    calls.push(config.model);
    if (config.model === 'primary' && !healthy) throw new RequestError('offline', 'transport');
    return completion();
  });
  for (let i = 0; i < 3; i++)
    assert.equal((await env.router.complete(messages, [], env.options())).channel, 'fallback');
  assert.equal(calls.filter((value) => value === 'primary').length, 9);
  assert.equal(env.router.status().failures, 3);
  const cooldown = env.router.status().cooldownUntil;
  await env.router.complete(messages, [], env.options());
  assert.equal(calls.filter((value) => value === 'primary').length, 9);
  env.advance(3_600_001);
  healthy = true;
  assert.equal((await env.router.complete(messages, [], env.options())).channel, 'primary');
  assert.ok(cooldown > 0);
  assert.deepEqual(env.router.status(), { failures: 0, cooldownUntil: 0, probing: false });
});

test('成功切断连续失败，配置更改重置渠道状态', async () => {
  let fail = true;
  const env = setup(async (config) => {
    if (config.model === 'primary' && fail) throw new RequestError('offline', 'transport');
    return completion();
  });
  await env.router.complete(messages, [], env.options());
  fail = false;
  await env.router.complete(messages, [], env.options());
  assert.equal(env.router.status().failures, 0);
  fail = true;
  await env.router.complete(messages, [], env.options());
  env.routes.primary.model = 'replacement';
  assert.equal(env.router.status().failures, 0);
});

test('用户取消不重试、不调用备用、不增加失败计数', async () => {
  const controller = new AbortController();
  let calls = 0;
  const env = setup(async () => {
    calls++;
    controller.abort();
    throw new Error('aborted');
  });
  await assert.rejects(
    env.router.complete(messages, [], { ...env.options(), signal: controller.signal }),
    { name: 'AbortError' },
  );
  assert.equal(calls, 1);
  assert.equal(env.router.status().failures, 0);
});

test('主渠道能力或预算不匹配可走备用，不污染故障计数', async () => {
  let calls = 0;
  const env = setup(async () => {
    calls++;
    return completion();
  });
  env.routes.fallback.vision = true;
  env.routes.fallback.inputTokens = 8000;
  const result = await env.router.complete(
    [{ role: 'user', content: 'image', images: ['data:image/png;base64,YQ=='] }],
    [],
    env.options(),
  );
  assert.equal(result.channel, 'fallback');
  assert.equal(calls, 1);
  assert.equal(env.router.status().failures, 0);
});

test('HTTP 401 不重试，仍可备用', async () => {
  const calls: string[] = [];
  const env = setup(async (config) => {
    calls.push(config.model);
    if (config.model === 'primary') throw new RequestError('unauthorized', 'http', 401);
    return completion();
  });
  await env.router.complete(messages, [], env.options());
  assert.deepEqual(calls, ['primary', 'fallback']);
});

test('主渠道接近截止仍给备用保留一次请求时间', async () => {
  let now = 1000;
  const deadlines: number[] = [];
  const primary = endpoint('primary');
  const fallback = endpoint('fallback');
  const router = new ModelRouter(
    () => ({ primary, fallback }),
    async (config, _messages, _tools, options) => {
      deadlines.push(options.deadlineAt);
      if (config.model === 'primary') {
        now = options.deadlineAt;
        throw new RequestError('timeout', 'transport');
      }
      return completion();
    },
    { now: () => now },
  );
  const result = await router.complete(messages, [], { deadlineAt: 6000 });
  assert.equal(result.channel, 'fallback');
  assert.deepEqual(deadlines, [5000, 6000]);
});

test('跨协议回放工具调用只携带目标协议需要的字段', () => {
  const history: Message[] = [
    ...messages,
    {
      role: 'assistant',
      content: '',
      calls: [{ id: 'tool-1', name: 'read', arguments: { path: 'a' } }],
      provider: 'gemini',
      native: [
        {
          functionCall: { name: 'read', args: { path: 'a' } },
          thoughtSignature: 'private-signature',
        },
      ],
    },
    { role: 'tool', content: '{"result":"data"}', callId: 'tool-1', name: 'read' },
  ];
  const config = endpoint('test');
  config.format = 'anthropic';
  const anthropic = encode(config, history, []);
  assert.ok(JSON.stringify(anthropic.body).includes('tool_use'));
  assert.ok(!JSON.stringify(anthropic.body).includes('private-signature'));
  config.format = 'gemini';
  const gemini = encode(config, history, []);
  assert.ok(JSON.stringify(gemini.body).includes('private-signature'));
  config.format = 'openai';
  const openai = encode(config, history, []);
  assert.ok(!JSON.stringify(openai.body).includes('private-signature'));
  assert.equal(openai.body.messages[2].tool_calls[0].function.arguments, '{"path":"a"}');
});

test('三种协议统一用量和工具结构，拒绝空内容', () => {
  const config = endpoint('test');
  const openai = decode(config, {
    choices: [{ message: { content: '<think>hidden</think>hello' } }],
    usage: { prompt_tokens: 12, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 8 } },
  });
  assert.equal(openai.message.content, 'hello');
  assert.deepEqual(openai.usage, { input: 12, output: 3, cached: 8 });
  config.format = 'anthropic';
  const anthropic = decode(config, {
    content: [{ type: 'tool_use', id: 'a', name: 'read', input: {} }],
    usage: {
      input_tokens: 3,
      cache_read_input_tokens: 8,
      cache_creation_input_tokens: 2,
      output_tokens: 1,
    },
  });
  assert.equal(anthropic.usage.input, 13);
  assert.equal(anthropic.message.calls?.[0]?.name, 'read');
  config.format = 'gemini';
  assert.equal(
    decode(config, {
      candidates: [{ content: { parts: [{ text: 'hidden', thought: true }, { text: 'hello' }] } }],
    }).message.content,
    'hello',
  );
  assert.throws(() => decode(config, {}), RequestError);
});
