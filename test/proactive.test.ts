import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, FakeModel, completion, promptText } from './helpers.js';
import { inQuietHours, silenceCooldownMs } from '../src/core/index.js';

/** 主动联系与分寸：门控、开环独立配额、挂念、读空气、askedLoops 契约。 */

test('安静时段、静默时间与每日次数', (t) => {
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
    '12 小时内不连发',
  );
});

test('同一天已主动过不再排队第二次', async (t) => {
  const now = Date.parse('2026-09-13T06:00:00Z');
  t.mock.method(Date, 'now', () => now);
  t.mock.method(Math, 'random', () => 0);
  const model = new FakeModel(() => completion({ messages: [], memoryUpdates: [] }));
  const f = fixture(t, model, {
    proactiveEnabled: true,
    diaryHour: 23,
    quietStart: 0,
    quietEnd: 0,
  });
  f.store.ensurePeer('wechat:p', 'wechat', 'p', 'context', true);
  f.store.ingest('wechat:p', 'old', '下周面试', [], now - 8 * 3600000);
  f.runtime.schedule(now);
  await f.runtime.drain();
  f.runtime.schedule(now);
  await f.runtime.drain();
  assert.equal(model.calls.length, 1, '模型只被叫一次');
  assert.equal(f.delivered.length, 0, '模型选择跳过则什么都不发');
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
  assert.equal(f.delivered.length, 0, '刚聊过天不插入提醒');
  assert.equal(model.calls.length, 0);
  assert.equal(f.store.dueOpenLoops('wechat:p', now).length, 1, '开环保留等沉默期');
});
