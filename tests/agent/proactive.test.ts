import test from 'node:test';
import assert from 'node:assert/strict';
import { inQuietHours } from '@atri/core';
import { fixture, FakeModel, completion, promptText } from '../helpers.js';

test('跨午夜安静时段、静默时间和每日次数限制', (t) => {
  assert.equal(inQuietHours(1, 23, 8), true);
  assert.equal(inQuietHours(8, 23, 8), false);
  assert.equal(inQuietHours(23, 23, 8), true);
  const f = fixture(t, undefined, { proactiveEnabled: true });
  const now = Date.parse('2026-09-13T06:00:00Z');
  f.store.ensurePeer('wechat:p', 'wechat', 'p', 'context', true);
  f.store.ingest('wechat:p', 'old', '下周面试', [], now - 8 * 3600000);
  assert.equal(f.runtime.proactiveAllowed(f.store.peer('wechat:p')!, now), true);
  assert.equal(
    f.runtime.proactiveAllowed(f.store.peer('wechat:p')!, Date.parse('2026-09-13T16:00:00Z')),
    false,
  );
  f.store.sql
    .prepare('UPDATE peers SET last_proactive_at=? WHERE id=?')
    .run(now - 3600000, 'wechat:p');
  assert.equal(f.runtime.proactiveAllowed(f.store.peer('wechat:p')!, now), false);
});
test('同一天主动联系可跳过，不反复调用模型', async (t) => {
  const now = Date.parse('2026-09-13T06:00:00Z');
  t.mock.method(Date, 'now', () => now);
  t.mock.method(Math, 'random', () => 0);
  const model = new FakeModel(() => completion({ messages: [], memoryUpdates: [] }));
  const f = fixture(t, model, { proactiveEnabled: true, diaryHour: 23 });
  f.store.ensurePeer('wechat:p', 'wechat', 'p', 'context', true);
  f.store.ingest('wechat:p', 'old', '下周面试', [], now - 8 * 3600000);
  f.runtime.schedule(now);
  await f.runtime.drain();
  f.runtime.schedule(now);
  await f.runtime.drain();
  assert.equal(model.calls.length, 1);
  assert.equal(f.delivered.length, 0);
});

test('用户刚说过话时，到期的开环不会插进来提醒', async (t) => {
  const now = Date.parse('2026-09-13T06:00:00Z');
  t.mock.method(Date, 'now', () => now);
  t.mock.method(Math, 'random', () => 0);
  const model = new FakeModel();
  const f = fixture(t, model, {
    proactiveEnabled: true,
    quietStart: 0,
    quietEnd: 0,
    diaryHour: 23,
  });
  f.store.ensurePeer('wechat:p', 'wechat', 'p', 'context', true);
  const source = f.store.ingest('wechat:p', 'src', '我明天面试', [], now - 3600000).message;
  f.store.addOpenLoop(
    'wechat:p',
    { content: '问面试结果', dueAt: now - 1800000, sources: [source.id] },
    now - 3600000,
  );
  f.runtime.schedule(now);
  await f.runtime.drain();
  assert.equal(f.delivered.length, 0, '刚聊过天不应再主动插入提醒');
  assert.equal(model.calls.length, 0);
  assert.equal(f.store.dueOpenLoops('wechat:p', now).length, 1, '开环仍然保留，等沉默期再问');
});

test('排队期间被了结的开环不再发出提醒', async (t) => {
  const now = Date.parse('2026-09-13T06:00:00Z');
  t.mock.method(Date, 'now', () => now);
  t.mock.method(Math, 'random', () => 0);
  const model = new FakeModel(() => completion({ messages: ['面试顺利吗'], memoryUpdates: [] }));
  const f = fixture(t, model, {
    proactiveEnabled: true,
    quietStart: 0,
    quietEnd: 0,
    diaryHour: 23,
  });
  f.store.ensurePeer('wechat:p', 'wechat', 'p', 'context', true);
  const source = f.store.ingest('wechat:p', 'src', '我明天面试', [], now - 8 * 3600000).message;
  const loop = f.store.addOpenLoop(
    'wechat:p',
    { content: '问面试结果', dueAt: now - 1800000, sources: [source.id] },
    now - 3600000,
  );
  // Enqueue directly instead of schedule(): schedule() pumps immediately, so
  // the turn would start before the loop could be resolved. This reproduces a
  // ping sitting in the jitter window while a chat turn closes the loop.
  f.store.enqueue('wechat:p', 'proactive', f.store.loopTaskKey(loop), { loop: loop.id }, now);
  f.store.resolveOpenLoop('wechat:p', loop.id, now);
  await f.runtime.drain();
  assert.equal(f.delivered.length, 0, '了结的开环不应再被问一次');
  assert.equal(model.calls.length, 0, '无效任务不应消耗模型调用');
  assert.equal(f.store.openLoops('wechat:p', true).length, 0);
});

test('主动消息聊到别的事时，不会把排队中的开环误标为已问', async (t) => {
  const now = Date.parse('2026-09-13T06:00:00Z');
  t.mock.method(Date, 'now', () => now);
  t.mock.method(Math, 'random', () => 0);
  const model = new FakeModel(() => completion({ messages: ['今天天气不错'], memoryUpdates: [] }));
  const f = fixture(t, model, {
    proactiveEnabled: true,
    quietStart: 0,
    quietEnd: 0,
    diaryHour: 23,
  });
  f.store.ensurePeer('wechat:p', 'wechat', 'p', 'context', true);
  const source = f.store.ingest('wechat:p', 'src', '我明天面试', [], now - 8 * 3600000).message;
  f.store.addOpenLoop(
    'wechat:p',
    { content: '问面试结果', dueAt: now - 1800000, sources: [source.id] },
    now - 3600000,
  );
  f.runtime.schedule(now);
  await f.runtime.drain();
  assert.equal(f.delivered.length, 1);
  assert.equal(f.store.openLoops('wechat:p')[0]!.asked, 0, '没提到的约定仍然待问');
  assert.equal(f.store.dueOpenLoops('wechat:p', now).length, 1);
});

test('模型跳过的开环不会被完成标记永久压住，下一天仍可再问', async (t) => {
  const day1 = Date.parse('2026-09-13T06:00:00Z');
  let clock = day1;
  t.mock.method(Date, 'now', () => clock);
  t.mock.method(Math, 'random', () => 0);
  let replies = 0;
  const model = new FakeModel(() => {
    replies++;
    return completion(
      replies === 1
        ? { messages: [], memoryUpdates: [] }
        : { messages: ['面试怎么样？'], memoryUpdates: [] },
    );
  });
  const f = fixture(t, model, {
    proactiveEnabled: true,
    quietStart: 0,
    quietEnd: 0,
    diaryHour: 23,
  });
  f.store.ensurePeer('wechat:p', 'wechat', 'p', 'context', true);
  const source = f.store.ingest('wechat:p', 'src', '我明天面试', [], day1 - 8 * 3600000).message;
  f.store.addOpenLoop(
    'wechat:p',
    { content: '问面试结果', dueAt: day1 - 1800000, sources: [source.id] },
    day1 - 3600000,
  );

  f.runtime.schedule(day1);
  await f.runtime.drain();
  assert.equal(f.delivered.length, 0, '第一次模型选择跳过');
  assert.equal(f.store.dueOpenLoops('wechat:p', day1).length, 1, '跳过不消耗开环，仍然等待被问');

  clock = day1 + 24 * 3600000;
  f.runtime.schedule(clock);
  await f.runtime.drain();
  assert.equal(f.delivered.length, 1, '第二天重新尝试并送达');
  assert.equal(f.store.dueOpenLoops('wechat:p', clock).length, 0, '问到后标记');
});

test('到期开环优先于日常主动，不会被每日配额饿死', async (t) => {
  const day1 = Date.parse('2026-09-13T06:00:00Z');
  let clock = day1;
  t.mock.method(Date, 'now', () => clock);
  t.mock.method(Math, 'random', () => 0);
  const model = new FakeModel(() => completion({ messages: ['面试怎么样？'], memoryUpdates: [] }));
  const f = fixture(t, model, {
    proactiveEnabled: true,
    quietStart: 0,
    quietEnd: 0,
    diaryHour: 23,
  });
  f.store.ensurePeer('wechat:p', 'wechat', 'p', 'context', true);
  const source = f.store.ingest(
    'wechat:p',
    'src',
    '我之后有个面试',
    [],
    day1 - 8 * 3600000,
  ).message;
  f.store.addOpenLoop(
    'wechat:p',
    {
      content: '问面试结果',
      dueAt: day1 + 20 * 3600000,
      dueText: '明天',
      sources: [source.id],
    },
    day1 - 3600000,
  );

  f.runtime.schedule(day1);
  await f.runtime.drain();
  assert.equal(f.delivered.length, 1, '第一天先发日常主动');
  assert.equal(f.store.dueOpenLoops('wechat:p', day1).length, 0, '开环还没到期');

  clock = day1 + 24 * 3600000;
  f.runtime.schedule(clock);
  await f.runtime.drain();
  assert.equal(f.delivered.length, 2);
  assert.equal(
    f.store.dueOpenLoops('wechat:p', clock).length,
    0,
    '日常配额与开环同时可用时，优先问开环并标记已问',
  );
  const proactiveCalls = model.calls.filter((c) => promptText(c.messages).includes('主动联系'));
  assert.equal(proactiveCalls.length, 2);
  assert.match(promptText(proactiveCalls[1]!.messages), /问面试结果/);
});

test('开场白任务跳过主动门控，并使用人格开场白作为 prompt 指引', async (t) => {
  const now = Date.parse('2026-09-13T06:00:00Z');
  t.mock.method(Date, 'now', () => now);
  const model = new FakeModel(() => completion({ messages: ['你好呀，我是新朋友。'] }));
  const f = fixture(t, model);
  // 从未说过话的联系人（last_user_at=0），普通主动门控必然否决
  f.store.ensurePeer('wechat:new', 'wechat', 'new', 'ctx', true);
  f.store.enqueue('wechat:new', 'proactive', 'greeting', { greeting: '嗨，我是亚托莉' });
  await f.runtime.drain();
  assert.equal(f.delivered.length, 1);
  const sent = model.calls[0]!.messages.map((m) => String(m.content)).join('\n');
  assert.match(sent, /第一次主动问候|刚加上好友/);
  assert.match(sent, /嗨，我是亚托莉/);
});
