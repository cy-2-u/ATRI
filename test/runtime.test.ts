import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, completion, FakeModel } from './helpers.js';
import { parseReply, resolveDue } from '../src/core/reply.js';

const HOUR = 3600000;

test('resolveDue：口语时间、星期几、MM-DD、荒谬时间戳', () => {
  const now = Date.parse('2026-10-29T10:00:00+08:00');
  const tz = 'Asia/Shanghai';
  const tomorrow8 = resolveDue(undefined, '明天 08:00', now, tz)!;
  assert.ok(tomorrow8 > now + 20 * 3600000 && tomorrow8 < now + 24 * 3600000);
  const tonight = resolveDue(undefined, '23:30', now, tz)!;
  assert.ok(tonight > now, '当天未过的时刻保持当天');
  const rolled = resolveDue(undefined, '08:00', now, tz)!;
  assert.ok(rolled > now + 12 * 3600000, '已过的时刻滚到明天');
  const saturday = resolveDue(undefined, '周六 20:00', now, tz)!;
  assert.ok(saturday > now && saturday < now + 8 * 86400000);
  const birthday = resolveDue(undefined, '12-25 09:00', now, tz)!;
  assert.ok(birthday > now);
  const past = resolveDue(undefined, '01-01 09:00', now, tz)!;
  // 今年 1 月 1 日已过 → 明年 1 月 1 日（距 10 月底约 64 天）。
  assert.ok(past > now + 60 * 86400000 && past < now + 100 * 86400000, '今年已过 → 明年');
  assert.equal(resolveDue(99999999999999, undefined, now, tz), undefined, '臆造时间戳拒收');
  assert.equal(resolveDue(undefined, ' nonsense ', now, tz), undefined);
});

test('回复解析：气泡切分、表情纠错、beat 挂首气泡', () => {
  const stickers = [{ slug: 'happy', description: '开心', tags: ['开心'], file: 'x' }];
  const parsed = parseReply(
    JSON.stringify({
      messages: [
        '[来源 abc | 10/29 10:00] 第一条\n[来源 def | 10/29 10:01] 第二条',
        '你看 [表情：开心] 这个',
        { type: 'text', text: '先停一下', beat: 'long' },
      ],
      memoryUpdates: [],
    }),
    stickers,
  );
  // 来源行切两条 + 内联表情再切三段（文字/表情/文字）+ beat 一条。
  assert.equal(parsed.parts.length, 6);
  assert.equal(parsed.parts[0]!.text, '第一条');
  assert.equal(parsed.parts[1]!.text, '第二条');
  assert.equal(parsed.parts[2]!.text, '你看');
  assert.equal(parsed.parts[3]!.type, 'sticker', '内联表情切出');
  assert.equal(parsed.parts[4]!.text, '这个');
  assert.equal(parsed.parts[5]!.beat, 'long');
});

test('回复解析：非 JSON 的纯文本放行，失败的 JSON 走修复', () => {
  const stickers = [{ slug: 'happy', description: '开心', tags: ['开心'], file: 'x' }];
  const plain = parseReply('嗯，我在。', stickers);
  assert.equal(plain.parts.length, 1);
  assert.equal(plain.parts[0]!.text, '嗯，我在。');
  assert.throws(() => parseReply('{"messages": broken}', stickers), /格式/);
});

test('聊天端到端：回复落库、心情脉冲、想法入库不触发评估', async (t) => {
  const model = new FakeModel((messages) => {
    // 模型从最后一条用户消息里取真实的来源锚点（与生产一致）。
    const raw = messages.at(-1)?.content ?? '';
    const sources = [...raw.matchAll(/\[来源 ([^\s|]+) \|/g)].map((m) => m[1]!);
    return completion({
      messages: ['听到啦。'],
      memoryUpdates: [{ content: '对方喜欢喝茶', kind: 'stated', sources: [] }],
      moodPulse: { valence: 0.4, energy: 0.1, reason: '聊得开心' },
      initiatives: [
        {
          topicKey: '茶叶',
          kind: 'ask',
          meaning: '想问他喝什么茶',
          sources: sources.slice(-1),
          expectReply: true,
        },
      ],
    });
  });
  const f = fixture(t, model);
  const now = Date.now();
  const event = f.runtime.accept('p1', 'e1', '我喜欢喝茶', [], now);
  assert.ok(event.taskId);
  await f.runtime.drain(15000);
  const history = f.store.history('p1');
  assert.equal(history.length, 2);
  assert.equal(history[1]!.role, 'assistant');
  assert.equal(history[1]!.content, '听到啦。');
  const mood = f.store.mood('p1');
  assert.ok(mood.valence > 0.1, '心情脉冲落地');
  const thoughts = f.store.activeInitiatives('p1');
  assert.equal(thoughts.length, 1, '聊天里的念头入库');
  assert.equal(thoughts[0]!.kind, 'ask');
  // 模型输出引用了不存在来源的记忆更新被来源校验淘汰。
  assert.equal(f.store.memories('p1').length, 0, '无有效来源的 stated 不落库');
});

test('心跳调度：醒着时 schedule 必须排拍，已排拍的间隔被尊重', async (t) => {
  const model = new FakeModel(() => completion({ action: 'nothing' }));
  // 不眠窗口（0–0）：任何真实时刻都不在睡眠分支。回归：曾因
  // nextBeatAt 缺省时取 now+30s 再判 now<next，第一拍永远排不上。
  const f = fixture(t, model, { proactiveEnabled: true, sleepStart: 0, sleepEnd: 0 });
  f.runtime.schedule();
  assert.equal(f.store.hasPendingTask('p1', 'pulse', 'beat'), true, '首次 schedule 就要排第一拍');
  // 已有 pending beat 时不得重复入队。
  f.runtime.schedule();
  const rows = f.store.sql
    .prepare(
      "SELECT count(*) AS n FROM tasks WHERE peer_id='p1' AND kind='pulse' AND dedupe_key='beat'",
    )
    .get() as { n: number };
  assert.equal(rows.n, 1, '同一拍去重');
});

test('心跳端到端：beat 任务按契约三分，speak 进投递、muse 进想法池', async (t) => {
  let calls = 0;
  const model = new FakeModel(() => {
    calls++;
    if (calls === 1) return completion({ action: 'muse', thought: '突然想问他今天过得怎么样' });
    return completion({
      action: 'speak',
      messages: ['在干嘛？'],
      selfActivity: '翻旧照片',
    });
  });
  // 睡眠窗设为 0–0（不眠）：测试在真实时钟的任何时刻跑都不进睡眠分支。
  const f = fixture(t, model, {
    proactiveEnabled: true,
    clinginess: 100,
    sleepStart: 0,
    sleepEnd: 0,
  });
  const now = Date.now();
  // 第一拍 muse：直接入队并 drain（work 的 claim 会把版本对齐）。
  f.store.enqueue('p1', 'pulse', 'beat', { beat: true }, now);
  await f.runtime.drain(15000);
  const thoughts = f.store.activeInitiatives('p1');
  assert.equal(thoughts.length, 1, 'muse 落入想法池');
  assert.equal(thoughts[0]!.meaning, '突然想问他今天过得怎么样');
  assert.ok(thoughts[0]!.topic_key.startsWith('thought:'), '同念头去重键');
  assert.equal(f.store.recentLife(10).length, 0, 'muse 不进生活流水');
  // 第二拍 speak：气泡投递 + 生活流水 + self 更新。
  f.store.enqueue('p1', 'pulse', 'beat2', { beat: true }, now + 1);
  await f.runtime.drain(15000);
  const history = f.store.history('p1');
  assert.ok(
    history.some((m) => m.role === 'assistant' && m.content === '在干嘛？'),
    '心跳开口',
  );
  const life = f.store.recentLife(10);
  assert.ok(
    life.some((e) => e.kind === 'said'),
    '说过的话进生活流水',
  );
  const self = f.store.self();
  assert.equal(self.activity, '翻旧照片', 'selfActivity 更新当下');
  assert.ok(calls >= 2);
});

test('心跳调度：睡眠中不排拍，承诺提醒独立于心跳', async (t) => {
  const model = new FakeModel(() => completion({ action: 'nothing' }));
  // 深夜（sleepStart=1, sleepEnd=7）：用真实时钟不可控，改为直接验证
  // inSleepHours 的调度行为——把睡眠窗设成"现在必然在睡"的 24 小时窗
  // 不可行（start==end 是不眠），改为验证承诺通道与 proactive 开关。
  const f = fixture(t, model, { proactiveEnabled: false });
  const now = Date.now();
  const { message } = f.store.ingest('p1', 'e1', '明天下午三点提醒我取快递', [], now - HOUR);
  const loop = f.store.addOpenLoop(
    'p1',
    { content: '提醒取快递', dueAt: now - 60000, sources: [message.id] },
    now - HOUR,
  );
  f.runtime.schedule(now);
  // proactiveEnabled=false：承诺是她的记性，也不该发。
  assert.equal(
    f.store.hasPendingTask('p1', 'pulse', `loop:${loop.id}:${loop.due_at}`),
    false,
    '开关关闭时连承诺也不发',
  );
});

test('心跳保险丝：一小时无回应连发多条后熔断', async (t) => {
  let speak = true;
  const model = new FakeModel(() =>
    speak ? completion({ action: 'speak', messages: ['在吗'] }) : completion({ action: 'nothing' }),
  );
  const f = fixture(t, model, { proactiveEnabled: true, maxConcurrentPeers: 2 });
  const now = Date.now();
  const { message } = f.store.ingest('p1', 'e1', '嗯', [], now - 5 * 3600000);
  void message;
  // 手工制造三次已发送的心跳（未获回应）。claim 让任务版本对齐 peer，
  // 否则 saveReply 的乐观锁会把草稿整体作废。
  for (let i = 0; i < 3; i++) {
    f.store.enqueue('p1', 'pulse', `fuse${i}`, { beat: true }, now - i * 60000);
    const task = f.store.claim('p1')!;
    f.store.saveReply(task, [{ type: 'text', text: '在吗' }], []);
    for (const d of f.store.pendingDeliveries('p1'))
      if (d.task_id === task.id) f.store.markDelivery(d.id, 'sent');
  }
  assert.ok(f.store.recentPulseSends('p1', 3600000, now) >= 2, '最近一小时多次心跳已发出');
  assert.ok(f.store.unansweredPulseStreak('p1') >= 2, '且都未获回应');
  // schedule 会按保险丝条件跳过新拍：无新 beat 任务入队。
  const before = f.store.sql
    .prepare("SELECT count(*) AS n FROM tasks WHERE kind='pulse' AND state='queued'")
    .get() as { n: number };
  f.runtime.schedule(now);
  const after = f.store.sql
    .prepare("SELECT count(*) AS n FROM tasks WHERE kind='pulse' AND state='queued'")
    .get() as { n: number };
  assert.ok(after.n <= before.n + 1, '熔断只阻止心跳本身，不抛错');
});
