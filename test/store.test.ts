import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.js';
import { OPEN_LOOP_EXPIRE_DAYS, SOFT_THREAD_MAX } from '../src/db/index.js';

const DAY = 86400000;
const HOUR = 3600000;

test('消息：event_key 去重，history 有序', (t) => {
  const f = fixture(t);
  const now = Date.now();
  const first = f.store.ingest('p1', 'e1', '你好', [], now);
  assert.equal(first.duplicate, false);
  const again = f.store.ingest('p1', 'e1', '你好', [], now + 1);
  assert.equal(again.duplicate, true, '同一事件键只落一次');
  f.store.ingest('p1', 'e2', '在吗', [], now + HOUR);
  const history = f.store.history('p1');
  assert.equal(history.length, 2);
  assert.equal(history[0]!.content, '你好');
  assert.equal(history[1]!.content, '在吗');
});

test('记忆：stated 必须有对方原话，同文重述合并巩固', (t) => {
  const f = fixture(t);
  const now = Date.now();
  const { message } = f.store.ingest('p1', 'e1', '我对芒果过敏', [], now);
  const written = f.store.addMemory(
    'p1',
    { content: '对方对芒果过敏', kind: 'stated', sources: [message.id] },
    f.store.peer('p1')!.version,
  );
  assert.equal(written, true);
  // 没有来源的记忆不成立。
  assert.equal(
    f.store.addMemory('p1', { content: '凭空记忆', kind: 'stated', sources: ['nope'] }, 99),
    false,
    '版本不匹配也写不进',
  );
  // 同文重述：合并为一行并巩固。
  const again = f.store.addMemory(
    'p1',
    { content: '对方对芒果过敏', kind: 'stated', sources: [message.id] },
    f.store.peer('p1')!.version,
  );
  assert.equal(again, true);
  assert.equal(f.store.memories('p1').length, 1, '同文不产生第二行');
});

test('supersede 链：替代退出活跃集，删除传播到固定点', (t) => {
  const f = fixture(t);
  const now = Date.now();
  const { message } = f.store.ingest('p1', 'e1', '我喜欢喝茶', [], now);
  f.store.addMemory(
    'p1',
    { content: '对方喜欢喝茶', kind: 'stated', sources: [message.id] },
    f.store.peer('p1')!.version,
  );
  const mem = f.store.memories('p1')[0]!;
  // 管理页更正写 system 消息为证并替代旧行。
  f.store.correctMemory('p1', mem.id, '对方喜欢咖啡');
  const active = f.store.memories('p1');
  assert.equal(active.length, 1);
  assert.equal(active[0]!.content, '对方喜欢咖啡');
  assert.equal(mem.status, 'active', '旧行对象是快照');
  const reloaded = f.store.sql.prepare('SELECT status FROM memories WHERE id=?').get(mem.id) as {
    status: string;
  };
  assert.equal(reloaded.status, 'superseded', '旧行退出活跃集');
  // 删除更正所依赖的 system 更正消息：更正失去证据，整链失效。
  // （system 行状态是 note，不进 history()，直接查表。）
  const correction = f.store.sql
    .prepare(
      "SELECT id FROM messages WHERE peer_id='p1' AND role='system' AND content LIKE '%对方喜欢咖啡%'",
    )
    .get() as { id: string } | undefined;
  assert.ok(correction, '更正消息在场');
  f.store.forget('p1', correction.id);
  assert.equal(f.store.memories('p1').length, 0, '依赖链随来源消失');
});

test('删除联系人：子表全部连带（含想法外键回归）', (t) => {
  const f = fixture(t);
  const now = Date.now();
  const { message } = f.store.ingest('p1', 'e1', '我下周去海边', [], now - HOUR);
  f.store.upsertInitiative(
    'p1',
    { topicKey: '海边旅行', kind: 'share', meaning: '想问他海边的事', sources: [message.id] },
    now,
  );
  f.store.addOpenLoop(
    'p1',
    { content: '提醒他防晒', dueAt: now + DAY, sources: [message.id] },
    now,
  );
  const removed = f.store.deletePeer('p1');
  assert.ok(removed);
  assert.equal(f.store.peer('p1'), undefined);
  assert.equal(f.store.activeInitiatives('p1').length, 0, '想法随联系人清空');
  assert.equal(f.store.openLoops('p1').length, 0, '开环随联系人清空');
  assert.equal(f.store.deletePeer('p1'), undefined, '重复删除返回 undefined');
});

test('账号迁移：bot 标识变化时联系人及全部数据搬到新 id', (t) => {
  const f = fixture(t);
  const now = Date.now();
  const { message } = f.store.ingest('p1', 'e1', '我下周去海边', [], now - HOUR);
  f.store.addOpenLoop(
    'p1',
    { content: '提醒他防晒', dueAt: now + DAY, sources: [message.id] },
    now,
  );
  const ok = f.store.migratePeerAccount('p1', 'p2');
  assert.ok(ok, '迁移应成功');
  assert.equal(f.store.peer('p1'), undefined);
  assert.ok(f.store.peer('p2'), '联系人已在新 id');
  assert.equal(f.store.history('p2').length, 1, '消息随行');
  assert.equal(f.store.openLoops('p2').length, 1, '开环随行');
  assert.equal(f.store.migratePeerAccount('p2', 'p2'), false, '同名不迁移');
  assert.equal(f.store.migratePeerAccount('ghost', 'p3'), false, '源不存在不迁移');
});

test('开环：合并、到期窗口、yearly 滚动、过期退场', (t) => {
  const f = fixture(t);
  const now = Date.now();
  const { message } = f.store.ingest('p1', 'e1', '明天九点叫我', [], now);
  const sources = [message.id];
  const a = f.store.addOpenLoop(
    'p1',
    { content: '叫他起床', dueAt: now + 20 * HOUR, sources },
    now,
  );
  const b = f.store.addOpenLoop(
    'p1',
    { content: '叫他起床', dueAt: now + 20.5 * HOUR, sources },
    now,
  );
  assert.equal(a.id, b.id, '同一安排一小时窗内合并');
  f.store.markLoopAsked('p1', a.id);
  assert.equal(f.store.dueOpenLoops('p1', now).length, 0, '问过就不再到期待问');
  // yearly：了结滚明年而不是关闭。
  const birthday = f.store.addOpenLoop(
    'p1',
    { content: '生日快乐', dueAt: now + DAY, sources, recurring: 'yearly' },
    now,
  );
  f.store.resolveOpenLoop('p1', birthday.id, now + DAY, 'Asia/Shanghai');
  const rolled = f.store.openLoopById('p1', birthday.id);
  assert.equal(rolled.status, 'open', 'yearly 不了结');
  assert.ok(rolled.due_at > now + 300 * DAY, '滚到明年');
  // 过期退场。
  const stale = f.store.addOpenLoop(
    'p1',
    { content: '过期的事', dueAt: now - (OPEN_LOOP_EXPIRE_DAYS + 1) * DAY, sources },
    now,
  );
  f.store.expireOpenLoops('p1', now, 'Asia/Shanghai');
  assert.equal(f.store.openLoopById('p1', stale.id).status, 'expired');
});

test('挂念：上限淘汰最旧，重提合并来源', (t) => {
  const f = fixture(t);
  const now = Date.now();
  const { message } = f.store.ingest('p1', 'e1', '这周在赶项目', [], now);
  const sources = [message.id];
  for (let i = 0; i < SOFT_THREAD_MAX; i++)
    f.store.addSoftThread('p1', { content: `挂念${i}`, kind: 'concern', sources }, now);
  const extra = f.store.addSoftThread('p1', { content: '新挂念', kind: 'promise', sources }, now);
  const open = f.store.softThreads('p1', true);
  assert.equal(open.length, SOFT_THREAD_MAX, '超限淘汰最旧');
  assert.ok(
    open.some((x) => x.id === extra.id),
    '新的在场',
  );
  const merged = f.store.addSoftThread('p1', { content: '新挂念', kind: 'promise', sources }, now);
  assert.equal(merged.id, extra.id, '重提合并');
});

test('想法：topicKey 去重，hash 相同幂等，说了即退场', (t) => {
  const f = fixture(t);
  const now = Date.now();
  const { message } = f.store.ingest('p1', 'e1', '我下周去海边', [], now);
  const sources = [message.id];
  const first = f.store.upsertInitiative(
    'p1',
    { topicKey: '海边', kind: 'ask', meaning: '问他订了没', sources },
    now,
  );
  assert.equal(first.created, true);
  const dup = f.store.upsertInitiative(
    'p1',
    { topicKey: '海边', kind: 'ask', meaning: '问他订了没', sources },
    now + 1,
  );
  assert.equal(dup.created, false, '同主题同进展不重复立项');
  const evolvedSourcesId = f.store.ingest('p1', 'e2', '机票订好啦', [], now + 1500000).message.id;
  const evolved = f.store.upsertInitiative(
    'p1',
    { topicKey: '海边', kind: 'ask', meaning: '订好了，想问天气', sources: [evolvedSourcesId] },
    now + 2000000,
  );
  assert.equal(evolved.created, false);
  assert.equal(evolved.initiative.version, 2, '新来源（新进展）抬版本');
  f.store.releaseInitiative('p1', first.initiative.id, now + 3);
  assert.equal(f.store.activeInitiatives('p1').length, 0, '说完退场');
});

test('她的当下与生活流水：单行状态 + 环形裁剪', (t) => {
  const f = fixture(t);
  const now = Date.now();
  assert.equal(f.store.self().activity, '', '初始为空');
  const self = f.store.updateSelf({ activity: '画画', activitySince: now, social: 0.5 }, now);
  assert.equal(self.activity, '画画');
  assert.equal(self.social, 0.5);
  // 越界钳制。
  assert.equal(f.store.updateSelf({ social: 5 }, now).social, 1);
  for (let i = 0; i < 260; i++) f.store.logLife('did', `事情${i}`, '', now + i);
  const recent = f.store.recentLife(300);
  assert.ok(recent.length <= 200, '环形保留上限');
  assert.equal(recent[0]!.text, '事情259', '最新在前');
});

test('混合检索：命中带角色与来源，近度不掩盖精确', (t) => {
  const f = fixture(t);
  const now = Date.now();
  f.store.ingest('p1', 'e1', '我最爱的年糕店关门了', [], now - 10 * DAY);
  f.store.ingest('p1', 'e2', '年糕真好吃', [], now);
  const hits = f.store.search('p1', '年糕', 5);
  assert.ok(hits.length >= 2, '两条都该被找到');
  assert.ok(hits[0]!.role === 'user');
  const message = hits.find((h) => h.content.includes('关门'));
  assert.ok(message, '旧但精确的命中仍在');
});
