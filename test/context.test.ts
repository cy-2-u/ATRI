import test from 'node:test';
import assert from 'node:assert/strict';
import { fitContext } from '../src/domain/context.js';
import { requestEstimate, RequestError, type Message } from '../src/model/types.js';

test('预算裁剪保留稳定人格、最新输入和动态状态，按完整旧轮次移除', () => {
  const messages: Message[] = [
    { role: 'system', content: 'person', cache: true },
    { role: 'user', content: 'old '.repeat(1000) },
    { role: 'assistant', content: 'old reply' },
    { role: 'user', content: 'latest question' },
    { role: 'assistant', content: 'recent answer' },
    { role: 'user', content: '{"mode":"beat","material":{"activity":"reading"}}' },
  ];
  const fitted = fitContext(messages, [], 500);
  assert.equal(fitted[0]!.content, 'person');
  assert.deepEqual(
    fitted.slice(1).map((message) => message.content),
    messages.slice(3).map((message) => message.content),
  );
  assert.ok(requestEstimate(fitted, []) <= 500);
  assert.equal(fitted.at(-2)!.cache, true);
  assert.equal(messages.length, 6);
});

test('必要输入本身超预算时本地拒绝，不静默截断最新消息', () => {
  assert.throws(
    () =>
      fitContext(
        [
          { role: 'system', content: 'person' },
          { role: 'user', content: 'latest '.repeat(1000) },
          { role: 'user', content: '{"mode":"chat"}' },
        ],
        [],
        500,
      ),
    RequestError,
  );
});
