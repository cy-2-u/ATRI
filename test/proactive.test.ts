import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, FakeModel, completion, promptText } from './helpers.js';
import { inQuietHours, silenceCooldownMs } from '../src/core/index.js';

/** 主动联系与分寸：门控、开环独立配额、挂念、读空气、askedLoops 契约。 */

test('安静时段、防连发与每日上限', (t) => {
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
    '上海凌晨零点是安静时段',
  );
  f.store.sql
    .prepare('UPDATE peers SET last_proactive_at=? WHERE id=?')
    .run(now - 3600000, 'wechat:p');
  assert.equal(
    f.runtime.proactiveAllowed(f.store.peer('wechat:p')!, now),
    false,
    '2 小时内不连发',
  );
});

test('刚聊完一小时也可能主动（不再有沉默小时门槛）', (t) => {
  const f = fixture(t, undefined, { proactiveEnabled: true });
  const now = Date.parse('2026-09-13T06:00:00Z');
  f.store.ensurePeer('wechat:p', 'wechat', 'p', 'context', true);
  // 上一条用户消息在 2 小时前、上次主动在 3 小时前：旧规则（沉默 6 小时）否决。
  f.store.ingest('wechat:p', 'old', '在忙', [], now - 2 * 3600000);
  f.store.sql
    .prepare('UPDATE peers SET last_proactive_at=? WHERE id=?')
    .run(now - 3 * 3600000, 'wechat:p');
  assert.equal(
    f.runtime.proactiveAllowed(f.store.peer('wechat:p')!, now),
    true,
    '沉默时长不再是硬门槛',
  );
});

test('每日主动上限：三条之后当天不再探询', (t) => {
  const f = fixture(t, undefined, { proactiveEnabled: true, quietStart: 0, quietEnd: 0 });
  const now = Date.parse('2026-09-13T06:00:00Z');
  f.store.ensurePeer('wechat:p', 'wechat', 'p', 'context', true);
  // 4 小时前的用户消息：不在读空气冷却（它要求主动消息晚于最后一条用户消息）。
  f.store.ingest('wechat:p', 'old', '在忙', [], now - 4 * 3600000);
  // 注入三条今天已投递的主动消息（都晚于最后一条用户消息 → 凑成 streak=3，
  // 但冷却起点是 last_proactive_at=最新一条，冷却 3 天未满 → 落到每日上限判断）。
  for (let i = 0; i < 3; i++) {
    const at = now - (3 - i) * 3600000;
    f.store.sql
      .prepare(
        "INSERT INTO tasks(id,peer_id,kind,dedupe_key,state,payload,run_at,created_at) VALUES(?,?,'proactive',?,'done','{}',?,?)",
      )
      .run(`t${i}`, 'wechat:p', `impulse:day:${i}`, at, at);
    f.store.sql
      .prepare(
        "INSERT INTO messages(id,peer_id,role,content,status,created_at) VALUES(?,?,'assistant','在吗','sent',?)",
      )
      .run(`m${i}`, 'wechat:p', at);
    f.store.sql
      .prepare(
        "INSERT INTO outbox(id,task_id,peer_id,ordinal,part,status,created_at) VALUES(?,?,?,0,'{}','sent',?)",
      )
      .run(`m${i}`, `t${i}`, 'wechat:p', at);
  }
  f.store.sql
    .prepare('UPDATE peers SET last_proactive_at=? WHERE id=?')
    .run(now - 3600000, 'wechat:p');
  assert.equal(
    f.runtime.proactiveAllowed(f.store.peer('wechat:p')!, now),
    false,
    '每日上限用尽',
  );
  // 昨天的主动不算今天。
  f.store.sql
    .prepare("UPDATE outbox SET created_at=? WHERE id LIKE 'm%'")
    .run(now - 30 * 3600000);
  f.store.sql
    .prepare("UPDATE messages SET created_at=? WHERE id LIKE 'm%'")
    .run(now - 30 * 3600000);
  f.store.sql
    .prepare('UPDATE peers SET last_proactive_at=? WHERE id=?')
    .run(now - 30 * 3600000, 'wechat:p');
  assert.equal(f.runtime.proactiveAllowed(f.store.peer('wechat:p')!, now), true, '隔日恢复');
});

test('到期开环走独立配额：当天已主动过仍可问结果', async (t) => {
  let clock = Date.parse('2026-10-15T00:00:00Z');
  const realNow = Date.now;
  t.after(() => (Date.now = realNow));
  Date.now = () => clock;
  t.mock.method(Math, 'random', () => 0);
  const model = new FakeModel((messages) => {
    const text = promptText(messages);
    if (/缺少 askedLoops 字段/.test(text)) {
      const id = /\[id:([^\]]+)\] 问面试结果/.exec(text)?.[1] ?? '';
      return completion({
        messages: ['面试顺利吗'],
        memoryUpdates: [],
        askedLoops: id ? [id] : [],
      });
    }
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
  f.runtime.schedule(clock);
  await f.runtime.drain();
  assert.equal(f.store.dueOpenLoops('wechat:p', clock).length, 0, '未到期不进入到期清单');
  const later = clock + 13 * 3600000;
  f.store.sql
    .prepare("UPDATE open_loops SET due_at=? WHERE peer_id='wechat:p'")
    .run(later - 1800000);
  f.store.sql
    .prepare('UPDATE peers SET last_proactive_at=?, last_user_at=? WHERE id=?')
    .run(clock - 3600000, clock - 30 * 3600000, 'wechat:p');
  clock = later;
  f.runtime.schedule(later);
  await f.runtime.drain();
  assert.ok(f.delivered.length >= 1, '开环用独立配额再次触发');
  assert.equal(f.store.dueOpenLoops('wechat:p', later).length, 0, '问过一次即标记');
});

test('askedLoops 缺席触发修复轮，显式空数组不标记', async (t) => {
  const now = Date.parse('2026-09-13T06:00:00Z');
  t.mock.method(Date, 'now', () => now);
  t.mock.method(Math, 'random', () => 0);
  let sawRepair = false;
  const model = new FakeModel((messages) => {
    const text = promptText(messages);
    if (/缺少 askedLoops 字段/.test(text)) {
      sawRepair = true;
      const interview = /\[id:([^\]]+)\] 面试情况/.exec(text)?.[1] ?? '';
      return completion({
        messages: ['面试怎么样啦？'],
        memoryUpdates: [],
        askedLoops: interview ? [interview] : [],
      });
    }
    return completion({ messages: ['面试怎么样啦？'], memoryUpdates: [] });
  });
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
    '明天面试，后天体检',
    [],
    now - 26 * 3600000,
  ).message;
  f.store.addOpenLoop('wechat:p', { content: '面试情况', dueAt: now - 1000, sources: [source.id] });
  f.store.addOpenLoop('wechat:p', { content: '体检安排', dueAt: now - 900, sources: [source.id] });
  f.runtime.schedule(now);
  await f.runtime.drain();
  assert.ok(sawRepair, '缺席 askedLoops 触发定向修复轮');
  const loops = f.store.openLoops('wechat:p');
  assert.equal(loops.find((l) => l.content === '面试情况')!.asked, 1, '声明问到的被标记');
  assert.equal(loops.find((l) => l.content === '体检安排')!.asked, 0, '没提到的保持待问');
});

test('主动消息聊别的事且声明没问：不误标开环', async (t) => {
  const now = Date.parse('2026-09-13T06:00:00Z');
  t.mock.method(Date, 'now', () => now);
  t.mock.method(Math, 'random', () => 0);
  const model = new FakeModel((messages) => {
    const text = promptText(messages);
    if (/缺少 askedLoops 字段/.test(text))
      return completion({ messages: ['今天天气不错'], memoryUpdates: [], askedLoops: [] });
    return completion({ messages: ['今天天气不错'], memoryUpdates: [] });
  });
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
  assert.equal(f.store.openLoops('wechat:p')[0]!.asked, 0, '说没问就是没问，不用词面猜');
  assert.equal(f.store.dueOpenLoops('wechat:p', now).length, 1);
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
  f.store.enqueue('wechat:p', 'proactive', f.store.loopTaskKey(loop), { loop: loop.id }, now);
  f.store.resolveOpenLoop('wechat:p', loop.id, now);
  await f.runtime.drain();
  assert.equal(f.delivered.length, 0, '了结的开环不再被问');
  assert.equal(model.calls.length, 0, '无效任务不消耗模型调用');
});

test('yearly 开环了结即滚到明年同日（跨闰日）', (t) => {
  const f = fixture(t);
  const source = f.store.ingest('p1', 'bd', '我生日 2 月 29', [], Date.now() - 3600000).message;
  const loop = f.store.addOpenLoop(
    'p1',
    {
      content: '生日',
      dueAt: Date.parse('2028-02-29T00:00:00+08:00'),
      sources: [source.id],
      recurring: 'yearly',
    },
    Date.now() - 7200000,
  );
  f.store.resolveOpenLoop('p1', loop.id, Date.now());
  const after = f.store.openLoops('p1')[0];
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  assert.equal(fmt.format(new Date(after.due_at)), '2029-02-28', '闰日生日映射到平年 2 月 28');
  assert.equal(after.status, 'open', '生日从不"了结"，只是滚到明年');
});

test('挂念：记录、成熟浮现、话题中了结、上限与过期', async (t) => {
  const model = new FakeModel((messages) => {
    const text = promptText(messages);
    const ids = [...text.matchAll(/\[id:([^\]]+)\]/g)].map((m) => m[1]);
    const inThreads = text.includes('还没放下的事');
    if (/赶项目|答辩|毕业设计/.test(text) && ids.length)
      return completion({
        messages: ['项目怎么样了？'],
        memoryUpdates: [],
        ...(inThreads ? { askedThreads: [ids[0]!] } : {}),
      });
    return completion({ messages: ['嗯嗯。'], memoryUpdates: [] });
  });
  const f = fixture(t, model, { proactiveEnabled: true });
  const clock = Date.now();
  const source = f.store.ingest('p1', 'src', '这周在赶毕业设计', [], clock - 3 * 86400000).message;
  f.store.addSoftThread(
    'p1',
    { content: '他在赶项目', kind: 'concern', revisitAfter: 2, sources: [source.id] },
    clock - 3 * 86400000,
  );
  // 未成熟不出现（revisit=2 天，成熟点在创建后 48 小时）
  assert.equal(f.store.ripeSoftThreads('p1', clock - 86400000 - 3600000).length, 0);
  assert.equal(f.store.ripeSoftThreads('p1', clock).length, 1, '两天后成熟');
  f.runtime.accept('p1', 'e1', '今天也在改论文');
  await f.runtime.drain();
  assert.ok(
    f.model.calls.some((c) => promptText(c.messages).includes('他在赶项目')),
    '挂念随话题相关进入提示词',
  );
  assert.equal(f.store.softThreads('p1', true)[0]!.asked, 1, '真正问到的标记');
  f.store.resolveSoftThread('p1', f.store.softThreads('p1', true)[0]!.id);
  assert.equal(f.store.softThreads('p1', true).length, 0);
  // 上限淘汰最旧的
  for (let i = 0; i < 4; i++) {
    const s = f.store.ingest('p1', `s${i}`, `事${i}`, [], Date.now() + i).message;
    f.store.addSoftThread(
      'p1',
      { content: `挂念${i}`, kind: 'concern', sources: [s.id] },
      Date.now() + i,
    );
  }
  assert.equal(f.store.softThreads('p1', true).length, 3, '最多同时 3 条');
  // 14 天过期
  f.store.sql
    .prepare("UPDATE soft_threads SET created_at=? WHERE peer_id='p1'")
    .run(clock - 20 * 86400000);
  f.store.expireSoftThreads('p1');
  assert.equal(f.store.softThreads('p1', true).length, 0);
});

test('读空气刹车：3→6→12→14 天，回复即解除', (t) => {
  const DAY = 86400000;
  assert.equal(silenceCooldownMs(2), 3 * DAY);
  assert.equal(silenceCooldownMs(3), 6 * DAY);
  assert.equal(silenceCooldownMs(4), 12 * DAY);
  assert.equal(silenceCooldownMs(6), 14 * DAY, '封顶：偶尔想起，不成骚扰');
  const f = fixture(t, undefined, { proactiveEnabled: true, quietStart: 0, quietEnd: 0 });
  const now = Date.parse('2026-09-13T06:00:00Z');
  const peerId = 'wechat:p';
  f.store.ensurePeer(peerId, 'wechat', 'p', 'context', true);
  f.store.ingest(peerId, 'old', '在吗', [], now - 30 * 3600000);
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
  injectProactive(now - 26 * 3600000, 't1');
  f.store.sql
    .prepare('UPDATE peers SET last_proactive_at=? WHERE id=?')
    .run(now - 26 * 3600000, peerId);
  assert.equal(f.runtime.proactiveAllowed(f.store.peer(peerId)!, now), true, '一次没回应照常');
  injectProactive(now - 2 * 3600000, 't2');
  f.store.sql
    .prepare('UPDATE peers SET last_proactive_at=? WHERE id=?')
    .run(now - 2 * 3600000, peerId);
  assert.equal(f.runtime.proactiveAllowed(f.store.peer(peerId)!, now), false, '两次进入多天冷却');
  assert.equal(
    f.runtime.proactiveAllowed(f.store.peer(peerId)!, now + 2 * 86400000),
    false,
    '冷却期内不放行',
  );
  assert.equal(
    f.runtime.proactiveAllowed(f.store.peer(peerId)!, now + 3 * 86400000),
    true,
    '冷却期满放行',
  );
  f.store.ingest(peerId, 'back', '我回来啦', [], now + 3 * 86400000);
  assert.equal(
    f.runtime.proactiveAllowed(f.store.peer(peerId)!, now + 3 * 86400000 + 25 * 3600000),
    true,
    '对方一开口立即解除',
  );
});

test('低能量不再一票否决主动联系', (t) => {
  const f = fixture(t, undefined, { proactiveEnabled: true, quietStart: 0, quietEnd: 0 });
  const now = Date.parse('2026-09-13T06:00:00Z');
  f.store.ensurePeer('wechat:p', 'wechat', 'p', 'context', true);
  f.store.ingest('wechat:p', 'old', '在吗', [], now - 30 * 3600000);
  f.store.pulseMood('wechat:p', { energy: -0.8, patience: -0.7, reason: '太累了' }, now - 60000);
  assert.equal(
    f.runtime.proactiveAllowed(f.store.peer('wechat:p')!, now),
    true,
    '累不累由她看着状态决定，模型可以自己跳过',
  );
});

test('用户刚说过话时到期的开环不插入；跳过的开环次日再试', async (t) => {
  const now = Date.parse('2026-09-13T06:00:00Z');
  t.mock.method(Date, 'now', () => now);
  t.mock.method(Math, 'random', () => 0);
  // 探询模型说"不想"：新机制下日常探询会问一次，热聊中被拒绝是常态。
  const model = new FakeModel((messages) => {
    const text = promptText(messages);
    if (text.includes('是否想主动联系对方')) return completion({ want: false });
    return completion({ messages: ['面试顺利吗'], memoryUpdates: [] });
  });
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
  await new Promise((r) => setTimeout(r, 50)); // 探询异步完成
  assert.equal(f.delivered.length, 0, '热聊中开环提醒不插入，探询也说不想');
  assert.equal(f.store.dueOpenLoops('wechat:p', now).length, 1, '开环保留');
});

test('心搏探询：她说想就入队主动消息，由头带进任务', async (t) => {
  const now = Date.parse('2026-09-13T06:00:00Z');
  t.mock.method(Date, 'now', () => now);
  t.mock.method(Math, 'random', () => 0);
  const model = new FakeModel((messages) => {
    const text = promptText(messages);
    if (text.includes('是否想主动联系对方'))
      return completion({ want: true, angle: '想起他说的桂花糕' });
    return completion({ messages: ['路过糕点铺，想起你说桂花糕了。'], memoryUpdates: [] });
  });
  const f = fixture(t, model, {
    proactiveEnabled: true,
    quietStart: 0,
    quietEnd: 0,
    diaryHour: 23,
  });
  f.store.ensurePeer('wechat:p', 'wechat', 'p', 'context', true);
  f.store.ingest('wechat:p', 'old', '老家有种桂花糕', [], now - 8 * 3600000);
  f.runtime.schedule(now);
  await f.runtime.drain();
  await new Promise((r) => setTimeout(r, 50));
  const probeCall = model.calls.find((c) =>
    promptText(c.messages).includes('是否想主动联系对方'),
  );
  assert.ok(probeCall, '探询调用发生过');
  assert.ok(promptText(probeCall!.messages).includes('距上一条消息'), '探询带时间语境');
  assert.equal(f.delivered.length, 1, '她说想 → 主动消息真的发出');
  const text = f.delivered[0]!.part.type === 'text' ? (f.delivered[0]!.part.text ?? '') : '';
  assert.ok(/桂花糕/.test(text), '回复内容与探询的由头一致');
});

test('心搏探询节拍：一个间隔只探一次，说不想不烧掉后面的拍子', async (t) => {
  let clock = Date.parse('2026-09-13T06:00:00Z');
  const realNow = Date.now;
  t.after(() => (Date.now = realNow));
  Date.now = () => clock;
  t.mock.method(Math, 'random', () => 0);
  const model = new FakeModel((messages) =>
    completion(
      promptText(messages).includes('是否想主动联系对方')
        ? { want: false }
        : { messages: ['嗯'], memoryUpdates: [] },
    ),
  );
  const f = fixture(t, model, {
    proactiveEnabled: true,
    quietStart: 0,
    quietEnd: 0,
    diaryHour: 23,
    impulseIntervalMinutes: 30,
  });
  f.store.ensurePeer('wechat:p', 'wechat', 'p', 'context', true);
  f.store.ingest('wechat:p', 'old', '在忙', [], clock - 8 * 3600000);
  f.runtime.schedule(clock);
  await f.runtime.drain();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(model.calls.length, 1, '第一拍探询一次');
  clock += 10 * 60000;
  f.runtime.schedule(clock);
  await f.runtime.drain();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(model.calls.length, 1, '间隔内不重复探询');
  clock += 31 * 60000;
  f.runtime.schedule(clock);
  await f.runtime.drain();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(model.calls.length, 2, '拒绝之后下一拍照常再探');
});
