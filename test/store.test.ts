import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.js';
import {
  OPEN_LOOP_EXPIRE_DAYS,
  SOFT_THREAD_MAX,
  detailDecayRate,
  detailIntegrity,
  isForgotten,
  significance,
  traceOf,
  consolidationGain,
} from '../src/db/index.js';

const DAY = 86400000;
const HOUR = 3600000;

// ---------- 记忆六变量的数学不变量：这套公式是产品的人格底层 ----------

test('遗忘速率：情绪护住、巩固放慢、干扰加速', () => {
  const base = detailDecayRate(0, 0, 0);
  assert.ok(detailDecayRate(-0.9, 0, 0) < base, '情绪越强忘得越慢');
  assert.ok(detailDecayRate(0, 0.8, 0) < base, '巩固越深忘得越慢');
  assert.ok(detailDecayRate(0, 0, 0.8) > base, '干扰越大忘得越快');
  assert.ok(detailDecayRate(0, 0, 0) > 0);
});

test('细节衰减：回想重置时钟但不重置意义', () => {
  const now = Date.now();
  const raw = {
    importance: 0.8,
    emotion: 0,
    consolidation: 0,
    interference: 0,
    created_at: now - 10 * DAY,
    last_hit_at: now - 2 * DAY,
  };
  const state = traceOf(raw);
  const d = detailIntegrity(state, now);
  // 2 天前的回想：细节从那一刻重新起算，比重照 10 年前算要清晰得多。
  assert.ok(d > 0.7, `回想后细节应较完整，实际 ${d.toFixed(2)}`);
  // 意义按写入起算：回想不重置。
  const aged = traceOf({ ...raw, last_hit_at: now });
  assert.equal(significance(state, now), significance(aged, now), '回想不重置意义');
  // 符号保留：难受的事淡了还是难受的方向。
  const sad = traceOf({ ...raw, emotion: -0.6 });
  const residue = traceOf({ ...raw, emotion: -0.6, created_at: now });
  assert.ok(significance(sad, now) > 0);
  assert.equal(Math.sign(residue.emotion), -1);
});

test('遗忘判定：细节与意义双低才算想不起来', () => {
  const now = Date.now();
  const old = {
    importance: 0.2,
    emotion: 0,
    consolidation: 0,
    interference: 0,
    created_at: now - 60 * DAY,
    last_hit_at: 0,
  };
  assert.equal(isForgotten(traceOf(old), now), true, '又轻又旧又没演练 → 想不起来');
  const pinned = {
    importance: 0.9,
    emotion: 0,
    consolidation: 0,
    interference: 0,
    created_at: now - 60 * DAY,
    last_hit_at: 0,
  };
  assert.equal(isForgotten(traceOf(pinned), now), false, '重要的事淡了也在');
});

test('间隔效应：隔得越久回想留下的巩固越多，且封顶', () => {
  assert.ok(consolidationGain(10 * 60000) < consolidationGain(4 * DAY));
  assert.ok(consolidationGain(10 * DAY) <= 0.15 + 1e-9);
  assert.ok(consolidationGain(0) > 0, '同拍重看也涨一点点');
});

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

test('在追的事：设置、重复不刷新起点、放下归零', (t) => {
  const f = fixture(t);
  const now = Date.now();
  const first = f.store.updateSelf({ pursuit: '在读深海热泉的资料' }, now);
  assert.equal(first.pursuit, '在读深海热泉的资料');
  assert.equal(first.pursuit_since, now, '新起点是设置时刻');
  // 内容没变就不动起点："追了三天"不能被重写成"追了一瞬间"。
  const again = f.store.updateSelf({ pursuit: '在读深海热泉的资料' }, now + HOUR);
  assert.equal(again.pursuit_since, now);
  // 更新说法：起点随内容变化移动。
  const updated = f.store.updateSelf({ pursuit: '在读深海热泉的论文' }, now + 2 * HOUR);
  assert.equal(updated.pursuit_since, now + 2 * HOUR);
  // 放下：清空并归零。
  const cleared = f.store.updateSelf({ pursuitClear: true }, now + 3 * HOUR);
  assert.equal(cleared.pursuit, '');
  assert.equal(cleared.pursuit_since, 0);
  // 超长截断到 120 字。
  assert.equal(
    f.store.updateSelf({ pursuit: '追'.repeat(200) }, now).pursuit.length,
    120,
    'pursuit 截断',
  );
});

test('夜间整理候选：相近记忆配对，遗忘与置顶不参与', (t) => {
  const f = fixture(t);
  const now = Date.now();
  const { message } = f.store.ingest('p1', 'e1', '我不吃香菜', [], now);
  f.store.addMemory(
    'p1',
    { content: '他不吃香菜', kind: 'stated', sources: [message.id] },
    f.store.peer('p1')!.version,
  );
  f.store.addMemory(
    'p1',
    { content: '他不爱吃香菜', kind: 'interpretation', sources: [message.id] },
    f.store.peer('p1')!.version,
  );
  f.store.addMemory(
    'p1',
    { content: '他喜欢喝茶', kind: 'stated', sources: [message.id] },
    f.store.peer('p1')!.version,
  );
  const candidates = f.store.consolidationCandidates('p1');
  assert.equal(candidates.length, 1, '香菜的两条相近成对，茶不参与');
  assert.ok(candidates[0]!.similarity >= 0.3);
  // 置顶行不参与：把其中一条置顶后，剩下的对消失。
  const first = candidates[0]!;
  f.store.setMemoryPinned('p1', first.a.id, true);
  assert.equal(f.store.consolidationCandidates('p1').length, 0, '置顶不参与整理');
});

test('节律统计：心跳开口、气泡形状、连发', (t) => {
  const f = fixture(t);
  const now = Date.now();
  f.store.ingest('p1', 'e1', '嗨', [], now - 2 * DAY);
  // 一轮聊天回复：两个气泡（文本 + 表情）。显式传 created_at：默认时钟
  // 会让所有气泡落进同一连发窗。
  const chat = f.store.enqueue('p1', 'chat', 'c1', {}, now - 2 * DAY);
  f.store.claim('p1');
  f.store.saveReply(
    f.store.taskById(chat)!,
    [
      { type: 'text', text: '你好呀，今天过得怎么样？' },
      { type: 'sticker', slug: 'happy', description: '开心' },
    ],
    [],
    now - 2 * DAY,
  );
  // 一拍心跳开口。
  const beat = f.store.enqueue('p1', 'pulse', 'b1', { beat: true }, now - DAY);
  f.store.claim('p1');
  f.store.saveReply(f.store.taskById(beat)!, [{ type: 'text', text: '在干嘛' }], [], now - DAY);
  for (const d of f.store.pendingDeliveries('p1')) f.store.markDelivery(d.id, 'sent');
  const stats = f.store.rhythmStats('p1', 7, 'Asia/Shanghai');
  assert.equal(stats.days, 7);
  assert.equal(stats.beats, 1);
  assert.equal(stats.beatSpeaks, 1, '发出过气泡的拍算开口');
  assert.equal(stats.proactiveMsgs, 1, '只有心跳那条是主动');
  assert.equal(stats.userMsgs, 1);
  assert.equal(stats.bubbles, 3);
  assert.equal(stats.stickers, 1);
  assert.ok(stats.avgLen > 0 && stats.lenStdev > 0, '长度有均值有方差');
  assert.equal(stats.maxBurst, 2, '同一轮的两个气泡在连发窗内');
  assert.ok(stats.perDay.length >= 1 && stats.perDay[0]!.bubbles >= 1);
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
