import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detailDecayRate,
  detailIntegrity,
  isForgotten,
  significance,
  traceOf,
  consolidationGain,
} from '../src/db/index.js';

/** 记忆六变量的数学不变量：这套公式是产品的人格底层，任何改动都要
 *  先过这里。 */

const DAY = 86400000;

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
