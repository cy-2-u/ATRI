import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, FakeModel, completion } from './helpers.js';
import {
  detailDecayRate,
  detailIntegrity,
  isForgotten,
  significance,
  traceOf,
  consolidationGain,
  type Store,
} from '../src/db/index.js';
import {
  gistOf,
  renderMemories,
  renderMood,
  renderHitLine,
  renderDiarySection,
  diaryResidues,
  renderTimeGap,
  residuePulse,
  nextRhythmSlot,
} from '../src/core/index.js';
import type { SearchHit } from '../src/db/index.js';

const DAY = 86400000;
const bust = (f: { store: Store }) =>
  f.store.sql.prepare("UPDATE peers SET version=version+1 WHERE id='p1'").run();

// ---------- 六变量数学 ----------

test('遗忘速率：情绪护住、巩固放慢、干扰加速', () => {
  const base = detailDecayRate(0, 0, 0);
  assert.ok(detailDecayRate(-0.9, 0, 0) < base, '情绪越强忘得越慢');
  assert.ok(detailDecayRate(0, 0.8, 0) < base, '巩固越深忘得越慢');
  assert.ok(detailDecayRate(0, 0, 0.8) > base, '干扰越大忘得越快');
  assert.ok(detailDecayRate(0, 0, 0) > 0);
});

test('分层渲染：清晰、大致记得、有印象', () => {
  const now = Date.now();
  const base = {
    id: 'm',
    content: '她不吃香菜，闻到就会挑出来',
    kind: 'stated' as const,
    importance: 0.8,
    emotion: 0,
    consolidation: 0,
    interference: 0,
  };
  assert.match(renderMemories([{ ...base, created_at: now, last_hit_at: 0 }]), /^- 她不吃香菜/);
  const vague = { ...base, id: 'm2', created_at: now - 6 * DAY, last_hit_at: now - 6 * DAY };
  assert.match(renderMemories([vague]), /大致记得：她不吃香菜/);
  assert.match(renderMemories([vague]), /细节有些模糊/);
  const lost = { ...base, id: 'm3', created_at: now - 20 * DAY, last_hit_at: now - 20 * DAY };
  assert.match(renderMemories([lost]), /有印象：/);
  assert.match(renderMemories([lost]), /很多细节想不起来/);
  assert.match(
    gistOf(
      '那天下午我们去看了海，风很大，她说她从没见过这么蓝的海面，浪打在礁石上让她一直笑个不停。后来天黑了才回去。',
    ),
    /^那天下午我们去看了海，风很大/,
  );
});

test('想不起来 = 细节与意义同时塌陷：退出排序池但可被线索提取', (t) => {
  const f = fixture(t);
  const source = f.store.ingest('p1', 'a', '随口提到过一次的事').message;
  f.store.addMemory(
    'p1',
    {
      content: '对方随口提到的碎事',
      kind: 'interpretation',
      sources: [source.id],
      importance: 0.2,
    },
    f.store.peer('p1')!.version,
  );
  f.store.sql
    .prepare("UPDATE memories SET created_at=?, last_hit_at=? WHERE peer_id='p1'")
    .run(Date.now() - 300 * DAY, Date.now() - 300 * DAY);
  bust(f);
  assert.equal(f.store.rankedMemories('p1').length, 0, '排序池不再给它位置');
  const hits = f.store.search('p1', '碎事', 5, 'memory');
  assert.equal(hits.length, 1, '带线索仍能找到（提取优于自发回忆）');
  assert.ok((hits[0].detail ?? 1) < 0.35);
});

test('演练：间隔效应增长巩固，冷却限流', (t) => {
  const f = fixture(t);
  const source = f.store.ingest('p1', 'a', '我不吃辣').message;
  f.store.addMemory(
    'p1',
    { content: '对方不吃辣', kind: 'stated', sources: [source.id] },
    f.store.peer('p1')!.version,
  );
  const id = f.store.memories('p1')[0].id;
  assert.ok(consolidationGain(0) < consolidationGain(5 * DAY));
  f.store.markMemoriesUsed('p1', [id]);
  const fresh = f.store.memories('p1')[0].consolidation;
  assert.ok(fresh > 0 && fresh < 0.05, '刚想起过就再想起，巩固几乎不涨');
  f.store.sql.prepare('UPDATE memories SET last_hit_at=? WHERE id=?').run(Date.now() - 5 * DAY, id);
  bust(f);
  f.store.markMemoriesUsed('p1', [id]);
  assert.ok(f.store.memories('p1')[0].consolidation - fresh >= 0.1, '隔几天再想起明显增长');
});

test('带情绪的记忆被想起时，残留泛化成此刻的心情', (t) => {
  const f = fixture(t, new FakeModel(() => completion({ messages: ['嗯。'], memoryUpdates: [] })));
  const source = f.store.ingest('p1', 'a', '我奶奶生病住院了').message;
  f.store.addMemory(
    'p1',
    {
      content: '对方的奶奶生病住院',
      kind: 'stated',
      sources: [source.id],
      emotion: -0.8,
      emotionReason: '奶奶生病',
    },
    f.store.peer('p1')!.version,
  );
  const id = f.store.memories('p1')[0].id;
  f.store.sql
    .prepare("UPDATE memories SET created_at=?, last_hit_at=0 WHERE peer_id='p1'")
    .run(Date.now() - 10 * DAY);
  bust(f);
  const residues = f.store.markMemoriesUsed('p1', [id]);
  assert.equal(residues.length, 1);
  assert.ok(residues[0].emotion <= -0.35, '残留仍然强到能被感觉到');
  const pulse = residuePulse(residues);
  assert.ok(pulse && pulse.valence < 0);
  f.store.pulseMood('p1', { valence: pulse!.valence, reason: pulse!.reason });
  assert.ok(f.store.mood('p1').valence < 0, '想起来了，心情真的会低一点');
});

test('端到端：带情绪的记忆进提示词，心情随之变化', async (t) => {
  const f = fixture(
    t,
    new FakeModel(() => completion({ messages: ['在的。'], memoryUpdates: [] })),
  );
  const source = f.store.ingest('p1', 'a', '我考试没考好').message;
  f.store.addMemory(
    'p1',
    {
      content: '对方考试失利，情绪低落',
      kind: 'stated',
      sources: [source.id],
      emotion: -0.9,
      emotionReason: '考试失利',
    },
    f.store.peer('p1')!.version,
  );
  f.runtime.accept('p1', 'b', '在吗');
  await f.runtime.drain();
  assert.ok(f.store.mood('p1').valence < 0, '想起了难过的事，状态铺上底色');
});

test('相似新记忆写入会推高旧记忆的干扰', (t) => {
  const f = fixture(t);
  const first = f.store.ingest('p1', 'a', '我最喜欢乌龙茶').message;
  f.store.addMemory(
    'p1',
    { content: '对方最喜欢乌龙茶', kind: 'stated', sources: [first.id] },
    f.store.peer('p1')!.version,
  );
  const before = f.store.memories('p1')[0].interference;
  const second = f.store.ingest('p1', 'b', '我最近只喝乌龙茶').message;
  f.store.addMemory(
    'p1',
    { content: '对方最近只喝乌龙茶', kind: 'stated', sources: [second.id] },
    f.store.peer('p1')!.version,
  );
  const after = f.store.memories('p1').find((m) => m.content === '对方最喜欢乌龙茶')!.interference;
  assert.ok(after > before, '同类记忆越多，旧的细节被挤得越快');
});

test('心境一致性：难过时难过的旧事更容易浮上来', (t) => {
  const f = fixture(t);
  const source = f.store.ingest('p1', 'a', '露营很开心，后来猫走丢了').message;
  const version = () => f.store.peer('p1')!.version;
  f.store.addMemory(
    'p1',
    {
      content: '一起露营很开心',
      kind: 'stated',
      sources: [source.id],
      importance: 0.7,
      emotion: 0.8,
    },
    version(),
  );
  f.store.addMemory(
    'p1',
    {
      content: '他的猫走丢了',
      kind: 'stated',
      sources: [source.id],
      importance: 0.7,
      emotion: -0.8,
    },
    version(),
  );
  const both = f.store.rankedMemoriesScored('p1', 2);
  assert.equal(both.length, 2);
  f.store.pulseMood('p1', { valence: -0.6, reason: '心情不好' });
  assert.equal(
    f.store.rankedMemoriesScored('p1', 2, f.store.mood('p1').valence)[0]!.memory.content,
    '他的猫走丢了',
    '与心情同号的记忆排前',
  );
  f.store.pulseMood('p1', { valence: 0.6, reason: '心情不错' });
  assert.equal(
    f.store.rankedMemoriesScored('p1', 2, f.store.mood('p1').valence)[0]!.memory.content,
    '一起露营很开心',
    '开心时想起的是开心的事',
  );
  assert.equal(
    f.store.rankedMemoriesScored('p1', 2, 0.05)[0]!.memory.id,
    both[0]!.memory.id,
    '心情很淡时不偏不倚',
  );
});

// ---------- 日记淡忘与回看泛化 ----------

test('日记命中与重逢回看都按同一套阈值分层', () => {
  const fmt = (h: SearchHit) => `${h.content}（日记，id:${h.id}）`;
  const base: SearchHit = {
    id: 'd1',
    kind: 'diary',
    content: '他拿到了 offer，我们聊到很晚',
    created_at: Date.now(),
    score: 1,
  };
  assert.doesNotMatch(renderHitLine({ ...base, detail: 0.9 }, fmt), /那天的日记/);
  assert.match(renderHitLine({ ...base, id: 'd2', detail: 0.5 }, fmt), /^- 那天的日记，大致记得：/);
  assert.match(renderHitLine({ ...base, id: 'd3', detail: 0.2 }, fmt), /^- 那天的日记，只剩印象：/);
  assert.match(
    renderHitLine({ ...base, id: 'm1', kind: 'memory', detail: 0.2 }, fmt),
    /^- 模糊印象：/,
  );
  const now = Date.now();
  const fresh = {
    id: 'd1',
    day: '2026-10-20',
    content: '他拿到了 offer。',
    emotion: 0.8,
    created_at: now - 2 * DAY,
  };
  assert.match(renderDiarySection(fresh, now), /^2026-10-20（id:d1）：他拿到了 offer/);
  const lost = { ...fresh, id: 'd3', created_at: now - 30 * DAY };
  assert.match(renderDiarySection(lost, now), /只剩印象/);
  assert.equal(diaryResidues([fresh], now).length, 1, '两三天前的开心还在泛化');
  assert.equal(diaryResidues([lost], now).length, 0, '一个月前已经淡出');
  const pulse = residuePulse(diaryResidues([{ ...fresh, emotion: -0.8 }], now));
  assert.ok(pulse && pulse.valence < 0, '翻到难受的旧日记，此刻真的会有点难受');
});

test('日记段落携带情绪底色并进入检索', async (t) => {
  const f = fixture(t);
  const source = f.store.ingest('p1', 'a', '今天聊到了离开的事').message;
  f.store.enqueue('p1', 'diary', 'day', { through: source.seq });
  const task = f.store.claim('p1')!;
  f.store.saveDiary(
    task,
    '2026-09-12',
    [{ content: '说到离开，心里闷闷的。', sources: [source.id], emotion: -0.6 }],
    [],
  );
  assert.equal(f.store.diaries('p1')[0].emotion, -0.6);
  const hit = f.store.search('p1', '离开', 3, 'diary')[0];
  assert.ok((hit.residue ?? 0) < -0.3, '召回的日记带着情绪');
  assert.ok(hit.detail !== undefined, '日记命中带细节快照供分层渲染');
});

// ---------- 心情状态 ----------

test('心情折叠：同向边际递减、反向直达、reason 归属', (t) => {
  const f = fixture(t);
  const base = Date.now() - 5 * 3600000;
  for (let i = 0; i < 6; i++)
    f.store.pulseMood('p1', { valence: -0.3, energy: -0.2 }, base + i * 3600000);
  const mood = f.store.mood('p1');
  assert.ok(mood.energy > -0.6, '连续负面脉冲不会钉死状态');
  assert.ok(mood.valence > -1);
  f.store.pulseMood(
    'p1',
    { valence: -0.5, energy: -0.3, reason: '对方提到了不开心的事' },
    Date.now() - 3600000,
  );
  f.store.pulseMood('p1', { valence: 0.4, energy: 0.2 }, Date.now());
  assert.equal(f.store.mood('p1').reason, '', '正面脉冲清掉上一轮的负面归因');
  assert.ok(f.store.mood('p1').valence > 0, '反向脉冲直达新值');
});

test('renderMood：体感文字、陈旧标注、同档多套措辞、从不报数', () => {
  const now = Date.now();
  assert.equal(renderMood({ valence: 0, energy: 0, patience: 0, at: now }, now, 0), '');
  const baseline = renderMood({ valence: 0, energy: 0, patience: 0, at: now }, now, -0.2);
  assert.match(baseline, /说不上具体原因/);
  const tired = renderMood({ valence: 0, energy: -0.6, reason: '加班', at: now - 60000 }, now);
  assert.match(tired, /有点累/);
  assert.doesNotMatch(tired, /精力挺足/);
  const stale = renderMood({ valence: -0.5, energy: 0, at: now - 2 * 3600000 }, now);
  assert.match(stale, /2 小时前/);
  assert.doesNotMatch(stale, /-?0\.\d+/);
  const a = renderMood({ valence: -0.6, energy: 0, patience: 0, reason: '吵架', at: now }, now);
  const b = renderMood(
    { valence: -0.6, energy: 0, patience: 0, reason: '吵架', at: now + 60000 },
    now + 60000,
  );
  assert.notEqual(a, b, '新的状态换新的说法');
  assert.match(a, /低落/);
  assert.match(b, /低落/);
});

test('深夜还在聊天，她自己的能量流失（按配置时区）', async (t) => {
  // UTC 18:00 = 上海凌晨 2 点，纽约下午 2 点
  const at = Date.parse('2026-09-13T18:00:00Z');
  t.mock.method(Date, 'now', () => at);
  const shanghai = fixture(t, new FakeModel(), { timeZone: 'Asia/Shanghai' });
  shanghai.runtime.accept('p1', 'a', '睡不着', [], at - 60000);
  await shanghai.runtime.drain();
  assert.ok(shanghai.store.mood('p1').energy <= -0.1, '上海凌晨 2 点能量流失');
  const ny = fixture(t, new FakeModel(), { timeZone: 'America/New_York' });
  ny.runtime.accept('p1', 'a', '在忙', [], at - 60000);
  await ny.runtime.drain();
  assert.ok(Math.abs(ny.store.mood('p1').energy) < 0.01, '纽约下午没有深夜能耗');
});

test('情绪基线钳在 ±0.3，且不解释原因', (t) => {
  const f = fixture(t);
  const source = f.store.ingest('p1', 'a', '难过的事一件接一件').message;
  for (let i = 0; i < 8; i++)
    f.store.addMemory(
      'p1',
      {
        content: `难过的事 ${i}`,
        kind: 'stated',
        sources: [source.id],
        emotion: -0.9,
        emotionReason: '难受',
      },
      f.store.peer('p1')!.version,
    );
  assert.ok(f.store.emotionalBaseline('p1') >= -0.3);
  assert.ok(f.store.emotionalBaseline('p1') < 0);
});

test('闪回候选：意义重、带残留、久未想起', (t) => {
  const f = fixture(t);
  const source = f.store.ingest('p1', 'a', '我养了一只猫叫团子').message;
  f.store.addMemory(
    'p1',
    {
      content: '对方养的猫叫团子',
      kind: 'stated',
      sources: [source.id],
      importance: 0.7,
      emotion: 0.6,
      emotionReason: '喜欢猫',
    },
    f.store.peer('p1')!.version,
  );
  f.store.sql
    .prepare("UPDATE memories SET created_at=?, last_hit_at=0 WHERE peer_id='p1'")
    .run(Date.now() - 10 * DAY);
  bust(f);
  const candidates = f.store.flashbackCandidates('p1');
  assert.equal(candidates.length, 1);
  assert.match(candidates[0]!.content, /团子/);
});

// ---------- 时间感知 ----------

test('久别带时段锚点，连续聊天不带', () => {
  const lastAt = Date.parse('2026-09-11T18:30:00+08:00');
  const now = Date.parse('2026-09-14T15:00:00+08:00');
  const weekday = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    weekday: 'long',
  }).format(new Date(lastAt));
  const text = renderTimeGap(now, lastAt, 'Asia/Shanghai');
  assert.match(text, /已有 3 天/);
  assert.match(text, new RegExp(`上次聊天是${weekday}晚上`));
  const recent = renderTimeGap(now, now - 5 * 60000, 'Asia/Shanghai');
  assert.match(recent, /是连续聊天/);
  assert.doesNotMatch(recent, /上次聊天/);
});

test('作息择时：主动闲聊落在对方活跃时段', () => {
  const buckets = new Array(24).fill(0) as number[];
  buckets[21] = 10;
  buckets[22] = 8;
  const now = Date.parse('2026-10-25T10:00:00+08:00');
  const slot = nextRhythmSlot(buckets, now, 'Asia/Shanghai', 20);
  assert.ok(slot);
  const hour = Number(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Shanghai',
      hour: '2-digit',
      hourCycle: 'h23',
    }).format(new Date(slot!)),
  );
  assert.ok(hour === 21 || hour === 22, `落在活跃时段，实际 ${hour} 点`);
  const late = Date.parse('2026-10-25T23:30:00+08:00');
  const tomorrow = nextRhythmSlot(buckets, late, 'Asia/Shanghai', 20);
  assert.ok(tomorrow && tomorrow > late + 12 * 3600000, '已过活跃时段排到明天');
  assert.equal(
    nextRhythmSlot(new Array(24).fill(0) as number[], now, 'Asia/Shanghai', 20),
    undefined,
    '没有作息数据退回随机延迟',
  );
});

// ---------- 六变量纯函数快检 ----------

test('回想重置细节时钟但不重置意义', () => {
  const now = Date.now();
  const raw = {
    importance: 0.8,
    emotion: 0,
    consolidation: 0.3,
    interference: 0,
    created_at: now - 10 * DAY,
    last_hit_at: now - 1 * DAY,
  };
  const state = traceOf(raw);
  assert.ok(detailIntegrity(state, now) > 0.7);
  const never = traceOf({ ...raw, last_hit_at: 0 });
  assert.ok(detailIntegrity(never, now) < detailIntegrity(state, now));
  assert.equal(significance(state, now), significance(never, now), '意义按写入起算');
  assert.ok(
    isForgotten(
      traceOf({
        importance: 0.1,
        emotion: 0,
        consolidation: 0,
        interference: 0,
        created_at: now - 300 * DAY,
        last_hit_at: 0,
      }),
      now,
    ),
  );
});
