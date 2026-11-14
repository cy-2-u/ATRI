import test from 'node:test';
import assert from 'node:assert/strict';
import {
  affect,
  evolveSelf,
  initialSelf,
  motives,
  projectMemory,
  projectSelf,
  rehearseMemory,
  sleepContains,
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

test('睡眠窗支持负起点及跨午夜抖动，结束边界不算睡眠', () => {
  assert.equal(sleepContains(1435, -20, 400), true);
  assert.equal(sleepContains(0, -20, 400), true);
  assert.equal(sleepContains(400, -20, 400), false);
  assert.equal(sleepContains(700, -20, 400), false);
  assert.equal(sleepContains(60, 1380, 420), true);
  assert.equal(sleepContains(60, 60, 60), false);
});
