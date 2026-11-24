import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sseAggregate, decode } from '../src/model.ts';
import type { Endpoint } from '../src/config.ts';

const openaiEndpoint = (overrides: Partial<Endpoint> = {}): Endpoint => ({
  url: 'https://x.example/v1', key: 'k', model: 'm', format: 'openai', contextTokens: 32768,
  outputTokens: 4096, timeoutMs: 120000, vision: true, json: false, completionTokens: false,
  cache: 'automatic', cacheRetention: 'default', stream: false, inputPrice: 0, cachedPrice: 0,
  cacheWritePrice: 0, outputPrice: 0, ...overrides,
});

test('sseAggregate：纯文本分帧聚合 + usage 末帧 + [DONE]', () => {
  const raw = [
    'data: {"choices":[{"delta":{"role":"assistant","content":"你"}}]}',
    '',
    'data: {"choices":[{"delta":{"content":"好呀"}}]}',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
    'data: {"usage":{"prompt_tokens":24,"completion_tokens":9}}',
    'data: [DONE]',
  ].join('\n');
  const data = sseAggregate(raw);
  const completion = decode(openaiEndpoint(), data);
  assert.equal(completion.message.content, '你好呀');
  assert.equal(completion.finish, 'stop');
  assert.equal(completion.usage.input, 24);
  assert.equal(completion.usage.output, 9);
});

test('sseAggregate：tool_calls 增量拼接（arguments 分帧、index 排序、reasoning 累积）', () => {
  const raw = [
    'data: {"choices":[{"delta":{"reasoning_content":"想一想"}}]}',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","type":"function","function":{"name":"recall","arguments":""}}]}}]}',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"query\\":"}}]}}]}',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"阿嘻\\"}"}}]}}]}',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"c2","type":"function","function":{"name":"history","arguments":"{}"}}]}}]}',
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
    'data: [DONE]',
  ].join('\n');
  const data = sseAggregate(raw);
  const completion = decode(openaiEndpoint(), data);
  assert.equal(completion.finish, 'tool_calls');
  assert.equal(completion.message.reasoning, '想一想');
  assert.deepEqual(completion.message.calls?.map(c => [c.id, c.name, c.args]), [['c1', 'recall', { query: '阿嘻' }], ['c2', 'history', {}]]);
});

test('sseAggregate：坏帧与非 data 行跳过，无 content 无 calls 时 decode 报「没有返回正文」', () => {
  const raw = [
    ': keep-alive 注释行',
    'data: not-json',
    'data: {"choices":[{"delta":{"content":""}}]}',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
  ].join('\n');
  const data = sseAggregate(raw);
  assert.throws(() => decode(openaiEndpoint(), data), /没有返回正文或工具/);
});
