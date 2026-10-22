import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMood, renderRhythm, type Sticker } from '@atri/core';
import { parseOpenLoops, parseReply, parseSoftThreads } from '@atri/core';
import {
  OPEN_LOOP_EXPIRE_DAYS,
  PROACTIVE_IGNORE_COOLDOWN_DAYS,
  SOFT_THREAD_EXPIRE_DAYS,
  SOFT_THREAD_MAX,
  SOFT_THREAD_REVISIT_DAYS,
} from '@atri/db';
import { fixture, FakeModel, completion, promptText } from '../helpers.js';

const stickers: Sticker[] = [
  { slug: 'happy', description: '开心', tags: ['开心'], file: 'happy.png' },
];

test('记忆置顶后永远参与排序，取消置顶恢复自然衰减', (t) => {
  const f = fixture(t);
  const source = f.store.ingest('p1', 'src', '聊过重要约定').message;
  const version = f.store.peer('p1')!.version;
  f.store.addMemory('p1', { content: '忌讳的话题', kind: 'stated', sources: [source.id] }, version);
  const pinned = f.store.memories('p1')[0]!;
  // 一条很新、高权重的记忆来挤它
  f.store.addMemory('p1', { content: '新鲜记忆', kind: 'stated', sources: [source.id] }, version);
  f.store.sql
    .prepare("UPDATE memories SET created_at=? WHERE content='忌讳的话题'")
    .run(Date.now() - 60 * 86400000);
  assert.equal(f.store.rankedMemories('p1', 1)[0]!.content, '新鲜记忆');
  f.store.setMemoryPinned('p1', pinned.id, true);
  assert.equal(f.store.rankedMemories('p1', 1)[0]!.content, '忌讳的话题');
  f.store.setMemoryPinned('p1', pinned.id, false);
  assert.equal(f.store.rankedMemories('p1', 1)[0]!.content, '新鲜记忆');
  assert.throws(() => f.store.setMemoryPinned('p1', 'missing', true));
});

test('开环：到期后进入提示词，proactive 问过一次就不再问，了结/过期静默退场', async (t) => {
  const now = Date.now();
  const f = fixture(t);
  const source = f.store.ingest('p1', 'src', '我明天面试').message;
  const loop = f.store.addOpenLoop(
    'p1',
    { content: '面试怎么样', dueAt: now - 3600000, dueText: '明天', sources: [source.id] },
    now - 7200000,
  );
  assert.equal(f.store.dueOpenLoops('p1', now).length, 1);
  // 问过一次后不再进入到期清单
  f.store.markLoopAsked('p1', loop.id);
  assert.equal(f.store.dueOpenLoops('p1', now).length, 0);
  // 了结
  f.store.resolveOpenLoop('p1', loop.id, now);
  assert.equal(f.store.openLoops('p1', true).length, 0);
  // 过期：超过窗口后静默退场，不再打扰
  const stale = f.store.addOpenLoop(
    'p1',
    {
      content: '迟到的约定',
      dueAt: now - (OPEN_LOOP_EXPIRE_DAYS + 1) * 86400000,
      sources: [source.id],
    },
    now,
  );
  assert.equal(f.store.dueOpenLoops('p1', now).length, 0, '过期的不进入到期清单');
  f.store.expireOpenLoops('p1', now);
  assert.equal(f.store.openLoops('p1').find((l) => l.id === stale.id)!.status, 'expired');
});

test('模型输出 openLoops/resolveLoops 经来源校验后落库', async (t) => {
  const now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const model = new FakeModel((messages) => {
    const system = String(messages[0]?.content ?? '');
    const asked = system.includes('未完的约定');
    const userText = messages.at(-1)!.content;
    if (asked && userText.includes('面试'))
      return completion({
        messages: ['怎么样啦？'],
        memoryUpdates: [],
        openLoops: [],
        resolveLoops: [],
      });
    return completion({
      messages: ['加油！'],
      memoryUpdates: [],
      openLoops: [
        {
          content: '对方明天面试',
          dueAt: now + 86400000,
          dueText: '明天',
          sources: [],
        },
      ],
      resolveLoops: [],
    });
  });
  const f = fixture(t, model);
  const event = f.runtime.accept('p1', 'e1', '我明天要去面试');
  assert.ok(event.taskId);
  await f.runtime.drain();
  // 无有效来源的 openLoops 被丢弃（来源校验生效）
  assert.equal(f.store.openLoops('p1').length, 0);
  const source = f.store.history('p1').find((m) => m.role === 'user')!;
  // 带真实来源的 openLoops 会落库
  model.handle = () =>
    completion({
      messages: ['记住了'],
      memoryUpdates: [],
      openLoops: [
        {
          content: '对方明天面试',
          dueAt: now + 86400000,
          dueText: '明天',
          sources: [source.id],
        },
      ],
      resolveLoops: [],
    });
  f.runtime.accept('p1', 'e2', '别忘了，我明天面试');
  await f.runtime.drain();
  const loops = f.store.openLoops('p1');
  assert.equal(loops.length, 1);
  assert.equal(loops[0]!.content, '对方明天面试');
  assert.equal(loops[0]!.status, 'open');
});

test('parseReply 对 openLoops/resolveLoops 的格式校验', () => {
  const now = Date.now();
  const parsed = parseReply(
    JSON.stringify({
      messages: ['好'],
      memoryUpdates: [],
      openLoops: [
        { content: '明天叫我', dueAt: now + 86400000, dueText: '明早', sources: ['a'] },
        { content: '胡编的时间', dueAt: 123, dueText: '明早', sources: ['a'] },
        { content: '缺时间', sources: ['a'] },
        '垃圾',
      ],
      resolveLoops: ['loop-1', 42],
    }),
    stickers,
  );
  assert.equal(parsed.openLoops.length, 1);
  assert.equal(parsed.openLoops[0]!.content, '明天叫我');
  assert.deepEqual(parsed.resolveLoops, ['loop-1']);
  assert.equal(parseOpenLoops('不是数组', new Set(['a'])).length, 0);
});

test('parseSoftThreads：来源校验、kind 与 revisitAfter 夹取', () => {
  const parsed = parseSoftThreads(
    [
      { content: '他在赶项目', kind: 'concern', sources: ['a'] },
      { content: '答应下次讲那个故事', kind: 'promise', revisitAfter: 30, sources: ['a'] },
      { content: '马上问', revisitAfter: 0, sources: ['a'] },
      { content: '没有依据', kind: 'concern', sources: [] },
    ],
    new Set(['a']),
  );
  assert.equal(parsed.length, 3);
  assert.equal(parsed[0]!.kind, 'concern');
  assert.equal(parsed[0]!.revisitAfter, SOFT_THREAD_REVISIT_DAYS);
  assert.equal(parsed[1]!.kind, 'promise');
  assert.equal(parsed[1]!.revisitAfter, 7);
  assert.equal(parsed[2]!.revisitAfter, 1);
  // 来源不在本轮可见集合内 → 丢弃
  assert.equal(parseSoftThreads([{ content: 'x', sources: ['b'] }], new Set(['a'])).length, 0);

  const reply = parseReply(
    JSON.stringify({
      messages: ['嗯'],
      memoryUpdates: [],
      threads: [{ content: '他在赶项目', kind: 'concern', sources: ['a'] }],
      resolveThreads: ['t1', 2],
      askedThreads: ['t2'],
    }),
    stickers,
  );
  assert.equal(reply.threads.length, 1);
  assert.deepEqual(reply.resolveThreads, ['t1']);
  assert.deepEqual(reply.askedThreads, ['t2']);
});

test('挂念：到期前不出现，上限 3 条，了结与 14 天过期', (t) => {
  const now = Date.now();
  const f = fixture(t);
  const source = f.store.ingest('p1', 'src', '这周在赶项目，压力很大').message;
  const thread = f.store.addSoftThread(
    'p1',
    { content: '他在赶项目', kind: 'concern', sources: [source.id] },
    now - 86400000,
  );
  assert.equal(f.store.ripeSoftThreads('p1', now).length, 0, '一天还不够');
  assert.equal(f.store.ripeSoftThreads('p1', now + 2 * 86400000).length, 1);
  assert.equal(f.store.dueOpenLoops('p1', now + 2 * 86400000).length, 0, '挂念不占开环的到期配额');
  f.store.markSoftThreadAsked('p1', thread.id);
  assert.equal(f.store.ripeSoftThreads('p1', now + 2 * 86400000)[0]!.asked, 1);
  f.store.resolveSoftThread('p1', thread.id, now);
  assert.equal(f.store.softThreads('p1', true).length, 0);

  // 上限：第 4 条挤掉最旧的一条
  for (let i = 0; i < 4; i++)
    f.store.addSoftThread(
      'p1',
      { content: '挂念' + i, kind: 'concern', sources: [source.id] },
      now - 86400000 + i * 1000,
    );
  const open = f.store.softThreads('p1', true);
  assert.equal(open.length, SOFT_THREAD_MAX);
  assert.equal(
    open.some((x) => x.content === '挂念0'),
    false,
  );

  // 14 天后静默过期，不再进入提示
  f.store.expireSoftThreads('p1', now + (SOFT_THREAD_EXPIRE_DAYS + 1) * 86400000);
  assert.equal(f.store.softThreads('p1', true).length, 0);
});

test('删除来源会让挂念失效，不再进入提示词', (t) => {
  const now = Date.now();
  const f = fixture(t);
  const source = f.store.ingest('p1', 'src', '我在准备答辩').message;
  const thread = f.store.addSoftThread(
    'p1',
    { content: '他在准备答辩', kind: 'concern', sources: [source.id] },
    now - 2 * 86400000,
  );
  assert.equal(f.store.ripeSoftThreads('p1', now).length, 1);
  f.store.forget('p1', source.id);
  const after = f.store.softThreads('p1').find((x) => x.id === thread.id)!;
  assert.equal(after.status, 'expired');
  assert.equal(after.content, '');
  assert.equal(f.store.ripeSoftThreads('p1', now).length, 0);
});

test('挂念经来源校验落库，只在到期后的聊天提示里出现，问了就标记', async (t) => {
  let clock = Date.now();
  t.mock.method(Date, 'now', () => clock);
  let phase = 0;
  let seenPrompt = '';
  const model = new FakeModel((messages) => {
    if (phase === 0)
      return completion({
        messages: ['嗯'],
        memoryUpdates: [],
        threads: [{ content: '他在赶项目', kind: 'concern', sources: [] }],
      });
    if (phase === 1)
      return completion({
        messages: ['辛苦啦'],
        memoryUpdates: [],
        threads: [{ content: '他在赶项目', kind: 'concern', sources: [sourceId] }],
      });
    seenPrompt = promptText(messages);
    const id = f.store.softThreads('p1', true)[0]?.id;
    if (phase === 2) return completion({ messages: ['还在忙吗'], memoryUpdates: [] });
    if (phase === 3)
      return completion({
        messages: ['后来那个项目怎么样了？'],
        memoryUpdates: [],
        askedThreads: id ? [id] : [],
      });
    return completion({
      messages: ['那就好'],
      memoryUpdates: [],
      resolveThreads: id ? [id] : [],
    });
  });
  const f = fixture(t, model);
  let sourceId = '';

  f.runtime.accept('p1', 'e1', '这周在赶项目，压力很大');
  await f.runtime.drain();
  // 没有来源的挂念被丢弃
  assert.equal(f.store.softThreads('p1', true).length, 0);
  sourceId = f.store.history('p1').find((m) => m.role === 'user')!.id;

  phase = 1;
  f.runtime.accept('p1', 'e2', '嗯，还是有点累');
  await f.runtime.drain();
  const thread = f.store.softThreads('p1', true)[0]!;
  assert.equal(thread.content, '他在赶项目');
  assert.equal(thread.status, 'open');

  // 三天后，普通聊天提示里出现“还没放下的事”
  clock += 3 * 86400000;
  phase = 2;
  f.runtime.accept('p1', 'e3', '今天好点');
  await f.runtime.drain();
  assert.match(seenPrompt, /还没放下的事/);
  assert.match(seenPrompt, /他在赶项目/);
  assert.equal(f.store.dueOpenLoops('p1', clock).length, 0, '不会变成主动提醒');

  // 问过一次后，提示里标明别再追问
  phase = 3;
  f.runtime.accept('p1', 'e4', '项目交了');
  await f.runtime.drain();
  assert.equal(f.store.softThreads('p1', true)[0]!.asked, 1);

  phase = 4;
  f.runtime.accept('p1', 'e5', '嗯');
  await f.runtime.drain();
  assert.match(seenPrompt, /已经问过一次/);
  assert.equal(f.store.softThreads('p1', true).length, 0);
});

test('读空气：连发长笑不算长回复，折叠重复字符后触发收着说', async (t) => {
  const model = new FakeModel(() => completion({ messages: ['嗯。'], memoryUpdates: [] }));
  const f = fixture(t, model);
  // 三条"哈哈哈哈哈哈"——原始长度 6，折叠后是 2 ≤ 4，应触发收着点说
  f.runtime.accept('p1', 'h1', '哈哈哈哈哈哈');
  await f.runtime.drain();
  f.runtime.accept('p1', 'h2', '哈哈哈哈哈哈');
  await f.runtime.drain();
  f.runtime.accept('p1', 'h3', '哈哈哈哈哈哈');
  await f.runtime.drain();
  const last = promptText(model.calls.at(-1)!.messages);
  assert.match(String(last), /收着点说/, '折叠重复字符后 terse 模式生效');
});

test('读空气：连续无回应的主动消息冷却拉长到几天', (t) => {
  const f = fixture(t, undefined, { proactiveEnabled: true });
  const now = Date.parse('2026-09-13T06:00:00Z');
  f.store.ensurePeer('wechat:p', 'wechat', 'p', 'context', true);
  f.store.ingest('wechat:p', 'old', '在吗', [], now - 30 * 3600000);
  const peerId = 'wechat:p';
  const injectProactive = (at: number, id: string) => {
    f.store.sql
      .prepare(
        "INSERT INTO tasks(id,peer_id,kind,dedupe_key,state,payload,run_at,created_at) VALUES(?,?,'proactive',?,'done','{}',?,?)",
      )
      .run(id, peerId, id, at, at);
    f.store.sql
      .prepare(
        "INSERT INTO messages(id,peer_id,role,content,status,created_at) VALUES(?,?, 'assistant', '在忙吗', 'sent', ?)",
      )
      .run('msg-' + id, peerId, at);
    f.store.sql
      .prepare(
        "INSERT INTO outbox(id,task_id,peer_id,ordinal,part,status,created_at) VALUES(?,?,?,0,'{}','sent',?)",
      )
      .run('msg-' + id, id, peerId, at);
  };
  // 一次没回应：照常允许
  injectProactive(now - 26 * 3600000, 't1');
  f.store.sql
    .prepare('UPDATE peers SET last_proactive_at=? WHERE id=?')
    .run(now - 26 * 3600000, peerId);
  assert.equal(f.runtime.proactiveAllowed(f.store.peer(peerId)!, now), true);
  // 连续两次无回应：进入多天冷却
  injectProactive(now - 2 * 3600000, 't2');
  f.store.sql
    .prepare('UPDATE peers SET last_proactive_at=? WHERE id=?')
    .run(now - 2 * 3600000, peerId);
  assert.equal(f.runtime.proactiveAllowed(f.store.peer(peerId)!, now), false);
  assert.equal(
    f.runtime.proactiveAllowed(
      f.store.peer(peerId)!,
      now + (PROACTIVE_IGNORE_COOLDOWN_DAYS - 1) * 86400000,
    ),
    false,
  );
  assert.equal(
    f.runtime.proactiveAllowed(
      f.store.peer(peerId)!,
      now + PROACTIVE_IGNORE_COOLDOWN_DAYS * 86400000,
    ),
    true,
  );
  // 用户回复后立刻解除刹车（streak 只数晚于最后一条用户消息的 ping）
  f.store.ingest(
    'wechat:p',
    'back',
    '我回来啦',
    [],
    now + PROACTIVE_IGNORE_COOLDOWN_DAYS * 86400000,
  );
  assert.equal(
    f.runtime.proactiveAllowed(
      f.store.peer(peerId)!,
      now + PROACTIVE_IGNORE_COOLDOWN_DAYS * 86400000 + 25 * 3600000,
    ),
    true,
  );
});

test('轻量心情：事件打脉冲、时间衰减、渲染成体感文字而非数值', (t) => {
  const f = fixture(t);
  const now = Date.now();
  f.store.pulseMood('p1', { valence: -0.5, energy: -0.4, reason: '吵架' }, now - 2 * 3600000);
  const mood = f.store.mood('p1');
  assert.ok(mood.valence < 0 && mood.valence > -0.5, '离线期间向中性衰减');
  const prose = renderMood(mood, now);
  assert.match(prose, /低落/);
  assert.match(prose, /2 小时前/);
  assert.doesNotMatch(prose, /-?0\.\d+/);
  // 回到中性后不渲染
  assert.equal(renderMood({ valence: 0, energy: 0, at: now }, now), '');
  // 规则推断：抱怨降情绪，感谢升情绪
  f.store.pulseMoodFromExchange(
    'p1',
    { user: '今天被领导骂了一顿，好烦', assistant: '怎么了，跟我说说', userAt: now },
    now,
  );
  assert.ok(f.store.mood('p1').valence <= -0.2);
  const before = f.store.mood('p1').valence;
  f.store.pulseMoodFromExchange(
    'p1',
    { user: '谢谢你陪我聊，开心多了哈哈哈', assistant: '那当然', userAt: now + 60000 },
    now + 60000,
  );
  assert.ok(f.store.mood('p1').valence > before, '感谢与开心让情绪回升');
});

test('作息节律：活跃时段渲染成时间段提示', () => {
  const buckets = new Array(24).fill(0);
  buckets[9] = 5;
  buckets[10] = 8;
  buckets[22] = 4;
  const text = renderRhythm(buckets, 14);
  assert.match(text, /9–10 点/);
  assert.match(text, /22 点/);
  assert.match(text, /不是对方常聊的时间/);
  assert.equal(renderRhythm(new Array(24).fill(0), 14), '');
});

test('主动联系提示词包含惦记的事与节律，回复长度镜像写入基础提示词', async (t) => {
  const now = Date.now();
  const model = new FakeModel(() => completion({ messages: ['还在忙吗'], memoryUpdates: [] }));
  // 用例基于真实时钟取 now，安静时段随运行时刻变化，这里直接停用。
  const f = fixture(t, model, { proactiveEnabled: true, quietStart: 0, quietEnd: 0 });
  f.store.ensurePeer('wechat:p', 'wechat', 'p', 'context', true);
  const source = f.store.ingest('wechat:p', 'src', '我明天面试', [], now - 26 * 3600000).message;
  f.store.addOpenLoop(
    'wechat:p',
    { content: '问面试结果', dueAt: now - 3600000, dueText: '明天', sources: [source.id] },
    now - 7200000,
  );
  f.store.pulseMood('wechat:p', { valence: -0.6, reason: '工作不顺' }, now - 1800000);
  t.mock.method(Date, 'now', () => now);
  t.mock.method(Math, 'random', () => 0);
  f.runtime.schedule(now);
  await f.runtime.drain();
  assert.ok(model.calls.length >= 1);
  // diary 也可能排在前面，找 proactive 那次调用（带“主动联系”标记）
  const proactiveCall = model.calls.find((c) => promptText(c.messages).includes('主动联系'));
  assert.ok(proactiveCall, 'proactive 任务调用了模型');
  const system = promptText(proactiveCall!.messages);
  assert.match(system, /未完的约定/);
  assert.match(system, /问面试结果/);
  assert.match(system, /心情还有些低落/);
  assert.match(system, /回复长度参照对方/);
  assert.doesNotMatch(system, /-0\.6/);
});

test('到期开环让 proactive 在沉默期照常触发且了结后归于安静', async (t) => {
  const now = Date.now();
  t.mock.method(Date, 'now', () => now);
  t.mock.method(Math, 'random', () => 0);
  const model = new FakeModel(() => completion({ messages: ['面试顺利吗'], memoryUpdates: [] }));
  const f = fixture(t, model, { proactiveEnabled: true, quietStart: 0, quietEnd: 0 });
  f.store.ensurePeer('wechat:p', 'wechat', 'p', 'context', true);
  const source = f.store.ingest('wechat:p', 'src', '我明天面试', [], now - 26 * 3600000).message;
  f.store.addOpenLoop(
    'wechat:p',
    { content: '问面试结果', dueAt: now - 1800000, dueText: '明天', sources: [source.id] },
    now - 3600000,
  );
  f.runtime.schedule(now);
  await f.runtime.drain();
  assert.equal(f.delivered.length, 1, '到期开环触发主动问候');
  assert.equal(f.store.dueOpenLoops('wechat:p', now).length, 0, '问过一次即标记');
});
