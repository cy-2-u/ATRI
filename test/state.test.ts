import test from 'node:test';
import assert from 'node:assert/strict';
import {
  affect,
  beatDelay,
  evolveSelf,
  initialSelf,
  motives,
  projectMemory,
  projectSelf,
  rehearseMemory,
  type MemoryStrength,
} from '../src/domain/state.js';

const hour = 3_600_000;

test('改变活动不吞时间积分，分段投影与直接投影一致', () => {
  const start = { ...initialSelf(hour), social: 0.2, expression: 0.8 };
  const activity = evolveSelf(start, hour * 2, { kind: 'activity', value: '整理笔记' });
  const segmented = projectSelf(activity, hour * 3);
  const direct = projectSelf(start, hour * 3);
  assert.ok(Math.abs(segmented.social - direct.social) < 1e-12);
  assert.ok(Math.abs(segmented.expression - direct.expression) < 1e-12);
  assert.equal(segmented.activitySince, hour * 2);
  assert.equal(segmented.activity, '整理笔记');
});

test('单方面表达不重置想念，确实收到回复才重置', () => {
  const received = evolveSelf(initialSelf(hour), hour, { kind: 'received' });
  const before = motives(received, 11 * hour).longing;
  const sent = evolveSelf(received, 11 * hour, { kind: 'delivered' });
  assert.equal(motives(sent, 11 * hour).longing, before);
  assert.equal(sent.lastReceivedAt, hour);
  const answered = evolveSelf(sent, 11 * hour, { kind: 'received' });
  assert.equal(motives(answered, 11 * hour).longing, 0);
});

test('表达消耗表达欲，真实经历增加表达欲', () => {
  const state = evolveSelf(initialSelf(hour), hour, { kind: 'experienced', salience: 1 });
  assert.equal(state.expression, 0.2);
  assert.ok(Math.abs(evolveSelf(state, hour, { kind: 'delivered' }).expression - 0.08) < 1e-12);
});

test('微弱情绪输入只产生微弱变化，重复同号不会固定跃升', () => {
  const mood = { pleasure: 0.5, energy: 0, patience: 0, at: hour };
  const next = affect(mood, { pleasure: 0.001, energy: 0, patience: 0 }, hour);
  assert.ok(next.pleasure > 0.5 && next.pleasure < 0.501);
});

test('回想巩固残存记忆，不恢复已经遗失的细节', () => {
  const memory: MemoryStrength = {
    detail: 1,
    importance: 0.6,
    emotion: 0.2,
    consolidation: 0,
    interference: 0,
    createdAt: hour,
    evaluatedAt: hour,
    lastRehearsedAt: 0,
  };
  const now = hour + 30 * 24 * hour;
  const faded = projectMemory(memory, now);
  const rehearsed = rehearseMemory(memory, now);
  assert.ok(faded.detail < 0.1);
  assert.equal(rehearsed.detail, faded.detail);
  assert.ok(rehearsed.consolidation > faded.consolidation);
  const again = rehearseMemory(rehearsed, now + hour);
  assert.equal(again.consolidation, rehearsed.consolidation);
  assert.ok(again.detail <= rehearsed.detail);
});

test('警觉窗只在他说话而她未接时生效，接完即回正常节拍', () => {
  const now = 100 * hour;
  // 他刚开口、她还没接：短拍警觉（≤5 分钟，抖动后仍在 15 分钟窗内）。
  const waiting = { ...initialSelf(now), lastReceivedAt: now - 60_000, lastDeliveredAt: 0 };
  const alerted = beatDelay(waiting, now, 0.5, 0);
  const normal = beatDelay({ ...initialSelf(now) }, now, 0.5, 0);
  assert.ok(alerted < normal, '未接住时应当比正常节拍更密');
  assert.ok(alerted <= 5 * 60_000 * 1.25 + 60_000, '警觉拍不超过 5 分钟档');
  // 她已经接住（送达晚于收到）：即使收到的消息还在 15 分钟内，也不再警觉。
  const answered = {
    ...initialSelf(now),
    lastReceivedAt: now - 60_000,
    lastDeliveredAt: now - 30_000,
  };
  assert.ok(beatDelay(answered, now, 0.5, 0) >= normal);
});

test('刚主动开过口还没等到回应时收敛，防止连发轰炸', () => {
  const now = 100 * hour;
  // 他两小时前说过话，她三十秒前主动回了——此刻该收敛，不是更急。
  const calm = {
    ...initialSelf(now),
    lastReceivedAt: now - 2 * hour,
    lastDeliveredAt: now - 30_000,
  };
  const baseline = beatDelay({ ...initialSelf(now) }, now, 0.5, 0);
  const delayed = beatDelay(calm, now, 0.5, 0);
  assert.ok(delayed > baseline, '主动后未获回应应当收敛');
  // 等满两小时后收敛解除。
  const settled = beatDelay(calm, now + 3 * hour, 0.5, 0);
  assert.ok(Math.abs(settled - baseline) < 1e-9);
});
