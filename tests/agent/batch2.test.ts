import test from 'node:test';
import assert from 'node:assert/strict';
import {
  renderMemories,
  rotateStickers,
  resolveDue,
  parseMoodPulse,
  parseOpenLoops,
  parseReply,
  type Sticker,
} from '@atri/core';
import { fixture, FakeModel, completion, promptText } from '../helpers.js';

const stickers: Sticker[] = [
  { slug: 'happy', description: '开心', tags: ['开心'], file: 'happy.png' },
];

test('resolveDue 解析本地时间字符串，时区正确', () => {
  const now = Date.parse('2026-09-13T10:00:00+08:00'); // 北京时间 18:00
  const tomorrow8 = resolveDue(undefined, '明天 08:00', now, 'Asia/Shanghai');
  assert.equal(tomorrow8, Date.parse('2026-09-14T08:00:00+08:00'));
  const timeOnly = resolveDue(undefined, '23:30', now, 'Asia/Shanghai');
  assert.equal(timeOnly, Date.parse('2026-09-13T23:30:00+08:00'));
  const passed = resolveDue(undefined, '07:00', now, 'Asia/Shanghai');
  assert.equal(passed, Date.parse('2026-09-14T07:00:00+08:00'), '已过时刻顺延到明天');
  const md = resolveDue(undefined, '12-25 09:00', now, 'Asia/Shanghai');
  assert.equal(md, Date.parse('2026-12-25T09:00:00+08:00'));
  assert.equal(
    resolveDue(now + 3600000, undefined, now, 'Asia/Shanghai'),
    now + 3600000,
    '合理范围的数字时间戳直接采用',
  );
  assert.equal(resolveDue(undefined, '说不清', now, 'Asia/Shanghai'), undefined);
});

test('resolveDue 拒绝语义上不可能的时间戳（JSON 合法但胡编）', () => {
  const now = Date.parse('2026-09-13T10:00:00+08:00');
  // 1970 年附近的原始小数字、9999 年的远期时间戳都是模型幻觉产物
  assert.equal(resolveDue(12345, undefined, now, 'Asia/Shanghai'), undefined, '过去太远');
  assert.equal(
    resolveDue(now + 10 * 365 * 86400000, undefined, now, 'Asia/Shanghai'),
    undefined,
    '未来超过 5 年',
  );
  assert.ok(
    resolveDue(now - 3600000, undefined, now, 'Asia/Shanghai'),
    '1 天内的过去时间允许（时钟偏差）',
  );
  assert.equal(
    resolveDue(undefined, '1970-01-01 08:00', now, 'Asia/Shanghai'),
    undefined,
    'ISO 日期同样受范围约束',
  );
});

test('parseOpenLoops 接受 due 字符串与 yearly 标记', () => {
  const now = Date.parse('2026-09-13T10:00:00+08:00');
  const loops = parseOpenLoops(
    [
      {
        content: '对方生日',
        due: '09-20 10:00',
        dueText: '9月20日',
        sources: ['a'],
        recurring: 'yearly',
      },
      { content: '无时间', sources: ['a'] },
    ],
    new Set(['a']),
    now,
    'Asia/Shanghai',
  );
  assert.equal(loops.length, 1);
  assert.equal(loops[0]!.recurring, 'yearly');
  assert.ok(loops[0]!.dueAt > now);
});

test('yearly 开环了结后排到明年而不是关闭', (t) => {
  const f = fixture(t);
  const source = f.store.ingest('p1', 'src', '我生日快到了').message;
  const now = Date.now();
  const loop = f.store.addOpenLoop(
    'p1',
    {
      content: '祝生日快乐',
      dueAt: now - 86400000,
      dueText: '9月20日',
      sources: [source.id],
      recurring: 'yearly',
    },
    now,
  );
  f.store.resolveOpenLoop('p1', loop.id, now);
  const after = f.store.openLoops('p1', true)[0]!;
  assert.equal(after.status, 'open');
  assert.ok(after.due_at > loop.due_at, '到期时间推进一年');
  assert.equal(after.asked, 0);
});

test('普通开环提前汇报结果也能了结（不用等到期）', (t) => {
  const f = fixture(t);
  const source = f.store.ingest('p1', 'src', '我下周面试').message;
  const now = Date.now();
  const loop = f.store.addOpenLoop(
    'p1',
    { content: '问面试结果', dueAt: now + 5 * 86400000, sources: [source.id] },
    now,
  );
  assert.equal(f.store.openLoops('p1', true).length, 1);
  f.store.resolveOpenLoop('p1', loop.id, now);
  assert.equal(f.store.openLoops('p1', true).length, 0);
  assert.equal(f.store.openLoops('p1').find((l) => l.id === loop.id)!.status, 'resolved');
});

test('记忆渲染为条目式，不含 hits 与时间戳', () => {
  const text = renderMemories([
    { id: 'm1', content: '不吃香菜', kind: 'stated', pinned: 1 },
    { id: 'm2', content: '最近工作压力大', kind: 'interpretation' },
  ]);
  assert.match(text, /- 不吃香菜（id:m1，对话确认，置顶）/);
  assert.match(text, /id:m2，主观理解/);
  assert.doesNotMatch(text, /hits|created_at/);
  assert.equal(renderMemories([]), '暂无');
});

test('提示词记忆与召回去重，同一条不出现两次', async (t) => {
  const model = new FakeModel(() => completion({ messages: ['嗯。'], memoryUpdates: [] }));
  const f = fixture(t, model);
  const source = f.store.ingest('p1', 'old', '我最喜欢乌龙茶').message;
  f.store.addMemory(
    'p1',
    { content: '喜欢喝乌龙茶', kind: 'stated', sources: [source.id] },
    f.store.peer('p1')!.version,
  );
  f.runtime.accept('p1', 'q', '我喜欢喝什么茶来着');
  await f.runtime.drain();
  const system = promptText(model.calls[0]!.messages);
  const count = (system.match(/喜欢喝乌龙茶/g) ?? []).length;
  assert.ok(count <= 1, `记忆与召回去重，实际出现 ${count} 次`);
});

test('表情目录按天轮换，窗口外的表情可达且近期用过的靠后', () => {
  const all: Sticker[] = Array.from({ length: 60 }, (_, i) => ({
    slug: 'cat' + String(i).padStart(3, '0'),
    description: '表情' + i,
    tags: [],
    file: 'x.png',
  }));
  const now = Date.now();
  // The window is passed explicitly: this test is about the rotation
  // mechanism, so it must not break every time PROMPT_STICKERS is retuned.
  const window = 24;
  const day1 = rotateStickers(all, [], now, window);
  const day2 = rotateStickers(all, [], now + 86400000, window);
  assert.equal(day1.length, window);
  assert.notDeepEqual(
    day1.map((s) => s.slug),
    day2.map((s) => s.slug),
    '隔天窗口不同',
  );
  assert.ok(day1.every((s) => all.includes(s)));
  const used = rotateStickers(all, [{ slug: 'cat000' }], now, window);
  assert.ok(
    used.findIndex((s) => s.slug === 'cat000') > used.length / 2 ||
      !used.some((s) => s.slug === 'cat000'),
    '近期用过的表情不占前排',
  );
  assert.deepEqual(rotateStickers(stickers, [], now), stickers, '目录小于窗口时原样返回');
});

test('usage 滚动归档：旧明细进日汇总，usage() 合并统计', (t) => {
  const f = fixture(t);
  const old = Date.now() - 40 * 86400000;
  f.store.sql
    .prepare(
      'INSERT INTO usage(peer_id,task_id,purpose,input_tokens,output_tokens,duration_ms,created_at) VALUES(?,?,?,?,?,?,?)',
    )
    .run('p1', 't1', 'chat', 100, 50, 900, old);
  f.store.sql
    .prepare(
      'INSERT INTO usage(peer_id,task_id,purpose,input_tokens,output_tokens,duration_ms,created_at) VALUES(?,?,?,?,?,?,?)',
    )
    .run('p1', 't2', 'chat', 100, 50, 900, old);
  f.store.recordUsage('p1', 't3', 'chat', 10, 5, 100);
  const stats = f.store.usage().find((u) => u.purpose === 'chat')!;
  assert.equal(Number(stats.calls), 3);
  assert.equal(Number(stats.input_tokens), 210);
  const remaining = f.store.sql.prepare('SELECT count(*) AS n FROM usage').get()!.n;
  assert.equal(Number(remaining), 1, '旧明细已归档');
  assert.ok(Number(f.store.sql.prepare('SELECT count(*) AS n FROM usage_daily').get()!.n) > 0);
});

test('提示词收录的记忆会累计 hits（item 14 回归）', async (t) => {
  const model = new FakeModel(() => completion({ messages: ['记得。'], memoryUpdates: [] }));
  const f = fixture(t, model);
  const source = f.store.ingest('p1', 'src', '我生日在三月').message;
  f.store.addMemory(
    'p1',
    { content: '生日在三月', kind: 'stated', sources: [source.id] },
    f.store.peer('p1')!.version,
  );
  const before = f.store.memories('p1')[0]!.hits;
  f.runtime.accept('p1', 'q', '你知道我的生日吗');
  await f.runtime.drain();
  assert.ok(f.store.memories('p1')[0]!.hits > before, '进过提示词的记忆 hits 增加');
});

test('到期开环独立配额：当天已主动联系过仍可问结果', async (t) => {
  // 基准北京时间 08:00，+13h 后是 21:00，避开安静时段（23–8 点）
  let clock = Date.parse('2026-10-15T00:00:00Z');
  const realNow = Date.now;
  t.after(() => (Date.now = realNow));
  Date.now = () => clock;
  t.mock.method(Math, 'random', () => 0);
  let calls = 0;
  const model = new FakeModel(() => {
    calls++;
    return completion({ messages: ['面试顺利吗'], memoryUpdates: [] });
  });
  const f = fixture(t, model, { proactiveEnabled: true });
  f.store.ensurePeer('wechat:p', 'wechat', 'p', 'context', true);
  const source = f.store.ingest('wechat:p', 'src', '我明天面试', [], clock - 30 * 3600000).message;
  f.store.addOpenLoop(
    'wechat:p',
    { content: '问面试结果', dueAt: clock + 6 * 3600000, dueText: '明天', sources: [source.id] },
    clock - 3600000,
  );
  // 第一次 schedule：casual ping，loop 还没到期不会被问
  f.runtime.schedule(clock);
  await f.runtime.drain();
  const firstCalls = calls;
  assert.ok(firstCalls >= 1);
  assert.equal(f.store.dueOpenLoops('wechat:p', clock).length, 0, '未到期不进入到期清单');
  // 模拟 casual ping 后 13 小时（次日 21:00），loop 已到期
  const later = clock + 13 * 3600000;
  f.store.sql
    .prepare("UPDATE open_loops SET due_at=? WHERE peer_id='wechat:p'")
    .run(later - 1800000);
  f.store.sql
    .prepare('UPDATE peers SET last_proactive_at=?, last_user_at=? WHERE id=?')
    .run(clock - 3600000, clock - 30 * 3600000, 'wechat:p');
  assert.equal(f.store.dueOpenLoops('wechat:p', later).length, 1, 'loop 现在到期');
  clock = later;
  f.runtime.schedule(later);
  await f.runtime.drain();
  assert.ok(calls > firstCalls, '开环用独立配额再次触发主动联系');
  assert.equal(f.store.dueOpenLoops('wechat:p', later).length, 0, '问过一次即标记');
});

test('moodPulse 从模型输出解析并入状态', async (t) => {
  const model = new FakeModel(() =>
    completion({
      messages: ['抱抱。'],
      memoryUpdates: [],
      moodPulse: { valence: -0.4, energy: -0.2, reason: '工作不顺' },
    }),
  );
  const f = fixture(t, model);
  f.runtime.accept('p1', 'q', '今天被领导骂了');
  await f.runtime.drain();
  const mood = f.store.mood('p1');
  assert.ok(mood.valence <= -0.2, '模型自评脉冲生效');
  assert.equal(mood.reason, '工作不顺');
  assert.equal(parseMoodPulse(null), undefined);
  assert.equal(parseMoodPulse({ valence: 0, energy: 0 }), undefined);
  assert.equal(parseMoodPulse({ valence: 5, energy: 0 })!.valence, 1, '限幅');
});

test('来源标注泄漏：剥除前缀，多来源块拆成独立气泡', () => {
  // 纯文本兜底路径：一段文本混了三个来源块
  const leaked = [
    '[来源 e0d0a9be-2f70:0 | 10/18 00:24]',
    '第一段话',
    '',
    '[来源 e0d0a9be-2f70:1 | 10/18 00:24]',
    '第二段话',
    '',
    '[来源 e0d0a9be-2f70:2 | 10/18 00:24]',
    '第三段话',
  ].join('\n');
  const plain = parseReply(leaked, stickers);
  assert.deepEqual(
    plain.parts,
    [
      { type: 'text', text: '第一段话' },
      { type: 'text', text: '第二段话' },
      { type: 'text', text: '第三段话' },
    ],
    '兜底路径按来源块拆分',
  );
  // JSON 路径：单个字符串里带前缀
  const json = parseReply(
    JSON.stringify({ messages: ['[来源 abc:0 | 10/18 00:24]开场的回应'] }),
    stickers,
  );
  assert.deepEqual(json.parts, [{ type: 'text', text: '开场的回应' }]);
  // 与表情混排：剥掉来源前缀，表情照常转换
  const mixed = parseReply('[来源 a:0 | 10/18 00:24]好耶[表情：开心]！', stickers);
  assert.deepEqual(
    mixed.parts,
    [
      { type: 'text', text: '好耶' },
      { type: 'sticker', slug: 'happy', description: '开心' },
      { type: 'text', text: '！' },
    ],
    '正文剥掉来源前缀，并按原文顺序保留表情两侧的文字',
  );
  // 正常输出不受影响：没有标注时保持原样
  const clean = parseReply('普通的一句回复', stickers);
  assert.deepEqual(clean.parts, [{ type: 'text', text: '普通的一句回复' }]);
});
