import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, FakeModel, completion, promptText } from './helpers.js';
import { inQuietHours, silenceCooldownMs } from '../src/core/index.js';

/** 主动联系 v2：想法生命周期、事件驱动评估、安静时段、读空气、askedLoops。 */

test('安静时段与渠道许可仍是硬边界', (t) => {
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
});

test('想法：落库、同主题合并、版本抬升与幂等', (t) => {
  const f = fixture(t);
  const now = Date.now();
  const source = f.store.ingest('p1', 's1', '我下周去海边', [], now - 3600000).message;
  const first = f.store.upsertInitiative(
    'p1',
    { topicKey: '海边旅行', kind: 'share', meaning: '想问他海边的事', sources: [source.id] },
    now,
  );
  assert.equal(first.created, true);
  // 同主题同来源：幂等，不新建不抬版本。
  const replay = f.store.upsertInitiative(
    'p1',
    { topicKey: '海边旅行', kind: 'share', meaning: '换句话再说一遍', sources: [source.id] },
    now + 60000,
  );
  assert.equal(replay.created, false);
  assert.equal(replay.initiative.id, first.initiative.id);
  assert.equal(replay.initiative.version, 1, '同一来源的重放不抬版本');
  // 新进展（来源集合变了）：更新含义、抬版本。
  const source2 = f.store.ingest('p1', 's2', '订好票了', [], now).message;
  const bump = f.store.upsertInitiative(
    'p1',
    {
      topicKey: '海边旅行',
      kind: 'share',
      meaning: '他订好票了，想聊聊行程',
      sources: [source2.id],
    },
    now + 120000,
  );
  assert.equal(bump.created, false);
  assert.equal(bump.initiative.version, 2, '新进展抬版本');
  assert.equal(bump.initiative.meaning, '他订好票了，想聊聊行程');
  assert.equal(f.store.activeInitiatives('p1').length, 1, '同主题只有一条活跃想法');
});

test('想法：说了即退场，同由头不再消费', (t) => {
  const f = fixture(t);
  const source = f.store.ingest('p1', 's1', '最近在学吉他', []).message;
  const { initiative } = f.store.upsertInitiative('p1', {
    topicKey: '吉他',
    kind: 'share',
    meaning: '想问学得怎么样',
    sources: [source.id],
  });
  f.store.releaseInitiative('p1', initiative.id);
  assert.equal(f.store.activeInitiatives('p1').length, 0, '表达过即退场');
  assert.equal(f.store.initiativeById('p1', initiative.id)!.state, 'expressed');
});

test('读空气刹车：3→6→12→14 天封顶，回复即解除', (t) => {
  const DAY = 86400000;
  assert.equal(silenceCooldownMs(2), 3 * DAY);
  assert.equal(silenceCooldownMs(3), 6 * DAY);
  assert.equal(silenceCooldownMs(4), 12 * DAY);
  assert.equal(silenceCooldownMs(6), 14 * DAY, '封顶：偶尔想起，不成骚扰');
  assert.equal(silenceCooldownMs(10), 14 * DAY, '超过封顶不再增长');
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
  assert.equal(f.runtime.proactiveAllowed(f.store.peer(peerId)!, now), false, '两次进入冷却');
  assert.equal(
    f.runtime.proactiveAllowed(f.store.peer(peerId)!, now + 2 * 86400000),
    false,
    '冷却期内不放行',
  );
  f.store.ingest(peerId, 'back', '我回来啦', [], now + 3 * 86400000);
  assert.equal(
    f.runtime.proactiveAllowed(f.store.peer(peerId)!, now + 3 * 86400000 + 25 * 3600000),
    true,
    '对方一开口立即解除（last_user_at 刷新）',
  );
});

test('事件驱动：想法评估说"说"就入队，说完释放想法', async (t) => {
  const now = Date.parse('2026-09-13T06:00:00Z');
  t.mock.method(Date, 'now', () => now);
  const model = new FakeModel((messages) => {
    const text = promptText(messages);
    if (text.includes('decisions'))
      return completion({
        decisions: [
          {
            id: /\[([^\]]+)\] 想问起/.exec(text)?.[1] ?? '',
            action: 'speak',
            reason: '正好想问',
          },
        ],
      });
    return completion({ messages: ['吉他学得怎么样啦？'], memoryUpdates: [] });
  });
  const f = fixture(t, model, { proactiveEnabled: true, quietStart: 0, quietEnd: 0 });
  f.store.ensurePeer('wechat:p', 'wechat', 'p', 'context', true);
  const source = f.store.ingest('wechat:p', 's1', '最近在学吉他', [], now - 8 * 3600000).message;
  f.store.upsertInitiative(
    'wechat:p',
    { topicKey: '吉他', kind: 'ask', meaning: '想问吉他学得怎么样', sources: [source.id] },
    now - 3600000,
  );
  f.runtime.schedule(now);
  await f.runtime.drain();
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(
    model.calls.some((c) => promptText(c.messages).includes('decisions')),
    '评估调用发生过',
  );
  assert.equal(f.delivered.length, 1, '说 → 主动消息真的发出');
  const text = f.delivered[0]!.part.type === 'text' ? (f.delivered[0]!.part.text ?? '') : '';
  assert.ok(/吉他/.test(text), '回复内容与想法由头一致');
  assert.equal(f.store.activeInitiatives('wechat:p').length, 0, '说完即退场，同一由头不会再次触发');
});

test('事件驱动：评估说"放"的想法不被发送，说"等"的转 waiting', async (t) => {
  const now = Date.parse('2026-09-13T06:00:00Z');
  t.mock.method(Date, 'now', () => now);
  const f = fixture(t, undefined, { proactiveEnabled: true, quietStart: 0, quietEnd: 0 });
  f.store.ensurePeer('wechat:p', 'wechat', 'p', 'context', true);
  const source = f.store.ingest('wechat:p', 's1', '随口一提', [], now - 9 * 3600000).message;
  const stale = f.store.upsertInitiative(
    'wechat:p',
    { topicKey: '旧话题', kind: 'muse', meaning: '过时的话头', sources: [source.id] },
    now - 3600000,
  ).initiative;
  const pending = f.store.upsertInitiative(
    'wechat:p',
    { topicKey: '忙完再聊', kind: 'care', meaning: '想等他忙完', sources: [source.id] },
    now - 3500000,
  ).initiative;
  // 模型对"旧话题"说放、对"忙完再聊"说等：按 id 精确对应，不依赖材料顺序。
  f.model.handle = (messages) => {
    const text = promptText(messages);
    if (text.includes(stale.id) && text.includes('decisions'))
      return completion({
        decisions: [
          { id: stale.id, action: 'drop', reason: '过时了' },
          { id: pending.id, action: 'hold', reason: '等他忙完这周' },
        ],
      });
    return completion({ messages: ['嗯'], memoryUpdates: [] });
  };
  f.runtime.schedule(now);
  await f.runtime.drain();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(f.delivered.length, 0, 'drop/hold 都不发送');
  assert.equal(f.store.initiativeById('wechat:p', stale.id)!.state, 'dropped');
  const held = f.store.initiativeById('wechat:p', pending.id)!;
  assert.equal(held.state, 'waiting');
  assert.equal(held.origin, '等他忙完这周', '等待条件被记录');
});

test('没有想法时事件驱动不调用模型', async (t) => {
  const now = Date.parse('2026-09-13T06:00:00Z');
  t.mock.method(Date, 'now', () => now);
  const model = new FakeModel(() => completion({ messages: ['嗯'], memoryUpdates: [] }));
  const f = fixture(t, model, { proactiveEnabled: true, quietStart: 0, quietEnd: 0 });
  f.store.ensurePeer('wechat:p', 'wechat', 'p', 'context', true);
  f.store.ingest('wechat:p', 'old', '在忙', [], now - 8 * 3600000);
  f.runtime.schedule(now);
  await f.runtime.drain();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(model.calls.length, 0, '无想法不空转探询');
  assert.equal(f.delivered.length, 0);
});

test('到期开环走独立通道：刚主动过仍可问结果', async (t) => {
  let clock = Date.parse('2026-10-15T00:00:00Z');
  const realNow = Date.now;
  t.after(() => (Date.now = realNow));
  Date.now = () => clock;
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
  // 一小时前刚主动过：旧机制要求距上次主动 2 小时，新机制承诺优先。
  f.store.sql
    .prepare('UPDATE peers SET last_proactive_at=?, last_user_at=? WHERE id=?')
    .run(later - 3600000, clock - 30 * 3600000, 'wechat:p');
  clock = later;
  f.runtime.schedule(later);
  await f.runtime.drain();
  assert.ok(f.delivered.length >= 1, '承诺优先于日常间隔');
  assert.equal(f.store.dueOpenLoops('wechat:p', later).length, 0, '问过一次即标记');
});

test('askedLoops 缺席触发修复轮，显式空数组不标记', async (t) => {
  const now = Date.parse('2026-09-13T06:00:00Z');
  t.mock.method(Date, 'now', () => now);
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

test('空闲碎碎念：对方沉默 36 小时后自动立项 muse 想法', async (t) => {
  const now = Date.parse('2026-09-13T06:00:00Z');
  t.mock.method(Date, 'now', () => now);
  let sawDecision = false;
  const model = new FakeModel((messages) => {
    const text = promptText(messages);
    if (text.includes('decisions')) {
      sawDecision = true;
      const id = /1\. \[([^\]]+)\] 想说一句/.exec(text)?.[1] ?? '';
      return completion({
        decisions: [{ id, action: 'speak', reason: '就是想说说' }],
      });
    }
    return completion({ messages: ['刷到一部纪录片想起你'], memoryUpdates: [] });
  });
  const f = fixture(t, model, { proactiveEnabled: true, quietStart: 0, quietEnd: 0 });
  f.store.ensurePeer('wechat:p', 'wechat', 'p', 'context', true);
  f.store.ingest('wechat:p', 'old', '晚安', [], now - 40 * 3600000);
  f.runtime.schedule(now);
  await f.runtime.drain();
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(sawDecision, '沉默触发了想法评估');
  const muses = f.store.activeInitiatives('wechat:p').filter((i) => i.kind === 'muse');
  assert.equal(muses.length, 0, '说出口即退场');
  assert.ok(f.delivered.length >= 1, '碎碎念变成主动消息');
  // 4 天冷却：紧接着再调度不再立项。
  const after = now + 24 * 3600000;
  const callsBefore = model.calls.length;
  f.runtime.schedule(after);
  await f.runtime.drain();
  await new Promise((r) => setTimeout(r, 50));
  const seededAgain = f.store
    .activeInitiatives('wechat:p')
    .some((i) => i.kind === 'muse' && i.origin === '');
  assert.equal(seededAgain, false, '冷却期内不重复立项');
  assert.ok(model.calls.length >= callsBefore, '后续调度照常');
});

test('空闲碎碎念：沉默不足 36 小时不立项', async (t) => {
  const now = Date.parse('2026-09-13T06:00:00Z');
  t.mock.method(Date, 'now', () => now);
  const model = new FakeModel(() => completion({ messages: ['嗯'], memoryUpdates: [] }));
  const f = fixture(t, model, { proactiveEnabled: true, quietStart: 0, quietEnd: 0 });
  f.store.ensurePeer('wechat:p', 'wechat', 'p', 'context', true);
  f.store.ingest('wechat:p', 'old', '在忙', [], now - 10 * 3600000);
  f.runtime.schedule(now);
  await f.runtime.drain();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(
    f.store.activeInitiatives('wechat:p').filter((i) => i.kind === 'muse').length,
    0,
    '刚聊过不找话',
  );
  assert.equal(model.calls.length, 0, '没有想法就没有评估调用');
});

test('空闲碎碎念：评估说安静就安静，想法留存', async (t) => {
  const now = Date.parse('2026-09-13T06:00:00Z');
  t.mock.method(Date, 'now', () => now);
  const model = new FakeModel((messages) => {
    const text = promptText(messages);
    if (text.includes('decisions')) {
      const id = /1\. \[([^\]]+)\] 想说一句/.exec(text)?.[1] ?? '';
      return completion({
        decisions: [{ id, action: 'fold', reason: '没由头，硬找话反而怪' }],
      });
    }
    return completion({ messages: ['嗯'], memoryUpdates: [] });
  });
  const f = fixture(t, model, { proactiveEnabled: true, quietStart: 0, quietEnd: 0 });
  f.store.ensurePeer('wechat:p', 'wechat', 'p', 'context', true);
  f.store.ingest('wechat:p', 'old', '晚安', [], now - 40 * 3600000);
  f.runtime.schedule(now);
  await f.runtime.drain();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(f.delivered.length, 0, 'fold 不发送');
  const muses = f.store
    .activeInitiatives('wechat:p')
    .filter((i) => i.kind === 'muse' && i.origin === '');
  assert.equal(muses.length, 0, 'fold 的想法带 origin 留痕，不会被"从没评过"反复重问');
});
