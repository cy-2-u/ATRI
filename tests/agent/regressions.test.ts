import test from 'node:test';
import assert from 'node:assert/strict';
import { Store, addYear } from '@atri/db';
import { recentStickerUse, rotateStickers, renderMood } from '@atri/core';
import { parseReply } from '@atri/core';
import { fixture, FakeModel, completion } from '../helpers.js';

// ---------- P0-1 表情窗口：提示词里的每一张都必须能被解析接受 ----------

test('P0-1 提示词展示的表情全部能被解析层接受，不会静默消失', () => {
  const PROMPT_STICKERS = 32;
  const all = Array.from({ length: 100 }, (_, i) => ({
    slug: 's' + String(i).padStart(3, '0'),
    description: '表情' + i,
    tags: [],
    file: 'f.png',
  }));
  // 100 天里，提示词给出的每一张表情都必须出现在校验列表中。
  for (let day = 0; day < 100; day++) {
    const window = rotateStickers(all, [], Date.parse('2026-01-01T00:00:00Z') + day * 86400000);
    for (const sticker of window) {
      const reply = parseReply(
        JSON.stringify({
          messages: ['早呀', { type: 'sticker', slug: sticker.slug }],
          memoryUpdates: [],
        }),
        window,
      );
      assert.ok(
        reply.parts.some((p) => p.type === 'sticker' && p.slug === sticker.slug),
        `第 ${day} 天的表情 ${sticker.slug} 被丢弃了`,
      );
    }
  }
});

test('P0-1 端到端：轮换出的表情经完整对话流程仍然发出', async (t) => {
  const stickers = Array.from({ length: 40 }, (_, i) => ({
    slug: 's' + String(i).padStart(3, '0'),
    description: '表情' + i,
    tags: [],
    file: 'f.png',
  }));
  // 让轮换窗口与目录前 32 张不同：取一个窗口里靠后的 slug。
  const f = fixture(t);
  (f.runtime.agent as any).o.stickers = () => stickers;
  const target = stickers.find((s) => !stickers.slice(0, 32).some((v) => v.slug === s.slug))!;
  f.store.ingest('p1', 'e1', '在吗');
  f.store.enqueueChat('p1', 1, 0);
  (f.model as any).handle = () =>
    completion({
      messages: ['在的', { type: 'sticker', slug: target.slug }],
      memoryUpdates: [],
    });
  await f.runtime.drain();
  const sent = f.store.history('p1', 20).map((m) => m.content);
  assert.ok(
    sent.some((c) => c.includes(`[表情：${target.description}]`)),
    '目录后段的表情没有出现在消息里',
  );
});

// ---------- P0-2 情绪关键词方向 ----------

test('P0-2 "不开心" 判为负面，不被当成开心', (t) => {
  const f = fixture(t);
  const now = Date.now();
  for (const text of ['今天不开心', '我今天不开心', '不开心']) {
    f.store.pulseMoodFromExchange(
      'p1',
      { user: text, assistant: '怎么了', userAt: now },
      now,
      'Asia/Shanghai',
    );
    const mood = f.store.mood('p1');
    assert.ok(mood.valence < 0, `"${text}" 应为负面，实际 ${mood.valence}`);
    assert.equal(mood.reason, '对方提到了不开心的事');
  }
});

test('P0-2 感谢与正向表达仍判为正面', (t) => {
  const f = fixture(t);
  const now = Date.now();
  f.store.pulseMoodFromExchange(
    'p1',
    { user: '谢谢你', assistant: '不客气', userAt: now },
    now,
    'Asia/Shanghai',
  );
  assert.ok(f.store.mood('p1').valence > 0, '感谢应提升心情');
  assert.equal(f.store.mood('p1').reason, '对方表达了感谢');

  const g = fixture(t);
  g.store.pulseMoodFromExchange(
    'p1',
    { user: '哈哈哈好开心', assistant: '嗯嗯', userAt: now },
    now,
    'Asia/Shanghai',
  );
  assert.ok(g.store.mood('p1').valence > 0, '开心应提升心情');
});

// ---------- P0-3 表情防重复按 slug 比对 ----------

test('P0-3 recentStickerUse 把描述解析成 slug，轮换过滤真正生效', () => {
  const catalog = [
    { slug: 'cat053', description: '猫猫挥手', tags: ['猫', '打招呼'], file: 'c.png' },
    { slug: 'dog012', description: '小狗摇尾巴', tags: ['狗'], file: 'd.png' },
  ];
  const history = [
    {
      id: 'm1',
      role: 'assistant' as const,
      content: '你好呀[表情：猫猫挥手]',
      media: [],
      status: 'sent',
      seq: 1,
      peer_id: 'p1',
      created_at: Date.now(),
    },
  ];
  const uses = recentStickerUse(history as any, catalog);
  assert.deepEqual(
    uses.map((u) => u.slug),
    ['cat053'],
    '描述必须映射为 slug',
  );

  // 目录（40）大于窗口（32），且除了 cat053 之外全都没用过。
  // 修复前：used 集合被整个从窗口里剔除，模型永远看不到自己刚发过的表情，
  // "防重复"也就变回了"直接从可用集里删掉"，一旦用过的数量够多就等于静默丢失。
  const all = [
    catalog[0],
    ...Array.from({ length: 39 }, (_, i) => ({
      slug: 'x' + i,
      description: '表情' + i,
      tags: [],
      file: 'f.png',
    })),
  ];
  const now = Date.now();
  // Explicit window: this asserts the sink behaviour, not the current tuning.
  const window = 24;
  const rotated = rotateStickers(all, uses, now, window);
  const rotatedSlugs = new Set(rotated.map((s) => s.slug));

  assert.equal(rotated.length, window, `窗口应保持 ${window} 张`);
  assert.ok(rotatedSlugs.has('cat053'), '最近用过的表情不应被移出窗口');
  assert.equal(
    rotated.filter((s) => s.slug !== 'cat053').length,
    window - 1,
    '为它保留位置后，其余位置仍应给未用过的表情',
  );

  // 轮换本身仍然是活的：换一个日子，窗口里的表情集合应该跟着移动，
  // 也就是目录尾部（这里 x30~x38）真的能被轮到。
  const tomorrow = rotateStickers(all, uses, now + 86400000, window);
  assert.notDeepEqual(
    tomorrow.map((s) => s.slug),
    rotated.map((s) => s.slug),
    '按天轮换应改变窗口内容',
  );

  // 同一天必须稳定，否则提示词每次组装都在抖。
  assert.deepEqual(
    rotateStickers(all, uses, now, window).map((s) => s.slug),
    rotated.map((s) => s.slug),
    '同一天的轮换结果应稳定',
  );
});

test('P0-3 未知名称不进入防重复列表（避免提示词里出现对不上的描述）', () => {
  const catalog = [{ slug: 'cat053', description: '猫猫挥手', tags: [], file: 'c.png' }];
  const history = [
    {
      id: 'm1',
      role: 'assistant' as const,
      content: '[表情：早已删除的表情]',
      media: [],
      status: 'sent',
      seq: 1,
      peer_id: 'p1',
      created_at: Date.now(),
    },
  ];
  assert.deepEqual(recentStickerUse(history as any, catalog), []);
});

// ---------- P1-4 用量归档的平均耗时 ----------

test('P1-4 归档后的平均耗时按调用数加权，不被近期调用覆盖', (t) => {
  const f = fixture(t);
  const old = Date.now() - 40 * 86400000;
  f.store.sql
    .prepare(
      'INSERT INTO usage(peer_id,task_id,purpose,input_tokens,output_tokens,duration_ms,created_at) VALUES(?,?,?,?,?,?,?)',
    )
    .run('p1', 'old', 'chat', 100, 10, 9000, old);
  f.store.recordUsage('p1', 'new', 'chat', 100, 10, 3000);
  const row = f.store.usage().find((u) => u.purpose === 'chat')!;
  assert.equal(Number(row.calls), 2);
  // (9000 + 3000) / 2 = 6000，不是近期的 3000
  assert.equal(Number(row.average_ms), 6000, '平均耗时应被归档数据修正');
});

// ---------- P1-5 年度循环按日历推进 ----------

test('P1-5 年度循环保持月日，闰日落到 2 月 28 日', () => {
  const zone = 'Asia/Shanghai';
  const leap = Date.parse('2028-02-29T10:00:00Z');
  const next = addYear(leap, zone);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(next));
  assert.equal(parts, '2029-02-28');
  // 普通日期月日不变，且跨过 365 天窗口后仍正确
  const normal = addYear(Date.parse('2026-10-18T10:00:00Z'), zone);
  const p2 = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(normal));
  assert.equal(p2, '2027-10-18');
});

test('P1-5 resolveOpenLoop 年度循环不漂移', (t) => {
  const f = fixture(t);
  const msg = f.store.ingest('p1', 'e1', '生日').message;
  const due = Date.parse('2028-02-29T10:00:00Z');
  f.store.addOpenLoop('p1', { content: '生日', dueAt: due, sources: [msg.id] }, Date.now());
  f.store.sql.prepare("UPDATE open_loops SET recurring='yearly' WHERE peer_id='p1'").run();
  const loop = f.store.openLoops('p1')[0];
  f.store.resolveOpenLoop('p1', loop.id, Date.now(), 'Asia/Shanghai');
  const after = f.store.openLoops('p1')[0];
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  assert.equal(fmt.format(new Date(after.due_at)), '2029-02-28');
});

// ---------- P1-7 情绪脉冲边际递减 ----------

test('P1-7 连续负面脉冲不会钉死状态（主动联系门控保持可用）', (t) => {
  const f = fixture(t);
  const base = Date.now() - 5 * 3600000;
  for (let i = 0; i < 6; i++)
    f.store.pulseMood('p1', { valence: -0.3, energy: -0.2 }, base + i * 3600000);
  const mood = f.store.mood('p1');
  assert.ok(mood.energy > -0.6, `energy ${mood.energy} 不应把主动联系锁死`);
  assert.ok(mood.valence > -1, 'valence 不应钉死在 -1');
});

// ---------- P2-10 陈旧 reason 不残留 ----------

test('P2-10 正面脉冲清除上一轮的负面归因', (t) => {
  const f = fixture(t);
  const now = Date.now();
  f.store.pulseMood(
    'p1',
    { valence: -0.5, energy: -0.3, reason: '对方提到了不开心的事' },
    now - 3600000,
  );
  f.store.pulseMood('p1', { valence: 0.4, energy: 0.2 }, now);
  assert.equal(f.store.mood('p1').reason, '', 'reason 属于上一轮，必须清空');
});

// ---------- P2-11 开场白留空不绕门控 ----------

test('P2-11 空开场白不跳过主动联系门控', async (t) => {
  const f = fixture(t, new FakeModel(), { proactiveEnabled: false });
  f.store.ensurePeer('wechat:a', 'wechat', 'a', 'ctx', true);
  // 空字符串开场白：应走常规门控（未开启主动联系 → 直接结束）
  f.store.enqueue('wechat:a', 'proactive', 'greeting-blank', { greeting: '' }, Date.now());
  await f.runtime.drain();
  assert.equal(f.delivered.length, 0, '未开启主动联系时，空开场白不应发出消息');
  const task = f.store.sql
    .prepare("SELECT state FROM tasks WHERE dedupe_key='greeting-blank'")
    .get() as any;
  assert.equal(task.state, 'superseded', '被门控否决的任务按取代处理，不冒充成功');
});

test('P2-11 非空开场白仍然跳过门控（保留原行为）', async (t) => {
  const f = fixture(
    t,
    new FakeModel(() => completion({ messages: ['你好呀。'], memoryUpdates: [] })),
    {
      proactiveEnabled: false,
    },
  );
  f.store.ensurePeer('wechat:a', 'wechat', 'a', 'ctx', true);
  f.store.enqueue(
    'wechat:a',
    'proactive',
    'greeting-real',
    { greeting: '嗨，我是亚托莉' },
    Date.now(),
  );
  await f.runtime.drain();
  const row = f.store.sql
    .prepare('SELECT state,error FROM tasks WHERE dedupe_key=?')
    .get('greeting-real') as any;
  assert.equal(f.delivered.length, 1, `非空开场白应照常发出（实际错误：${row?.error}）`);
});

// ---------- P2-13 工具轮与生成轮分账 ----------

test('P2-13 工具查询与最终生成分别计费', async (t) => {
  const f = fixture(t);
  let turn = 0;
  (f.model as any).handle = () => {
    turn++;
    if (turn === 1)
      return completion({}, [{ id: 'c1', name: 'search_memory', arguments: { query: '生日' } }]);
    return completion({ messages: ['记得的。'], memoryUpdates: [] });
  };
  f.store.ingest('p1', 'e1', '你还记得我生日吗');
  f.store.enqueueChat('p1', 1, 0);
  await f.runtime.drain();
  const rows = f.store.sql
    .prepare('SELECT purpose,count(*) n FROM usage GROUP BY purpose')
    .all() as any[];
  const purposes = rows.map((r) => r.purpose).sort();
  assert.ok(purposes.includes('chat_tool'), '应存在 chat_tool 计费');
  assert.ok(purposes.includes('chat'), '应存在 chat 生成计费');
});
