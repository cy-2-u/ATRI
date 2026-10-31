import test from 'node:test';
import assert from 'node:assert/strict';
import {
  boredom,
  boredomAfter,
  longing,
  tickMotives,
  BORED_SATURATION_MINUTES,
  SOCIAL_RECOVERY_HOURS,
} from '../src/core/motives.js';
import {
  nextBeatDelayMs,
  inSleepMinutes,
  renderMotives,
  type MotiveFeel,
} from '../src/core/pulse.js';
import { parsePulseOutput, type Sticker } from '../src/core/reply.js';

/** 动机（内稳态）与心跳节律的数学：生理归代码，决策归模型。 */

const MIN = 60000;
const HOUR = 3600000;
const now = 1_800_000_000_000;

test('无聊：单调时间导出，有刺激归零', () => {
  assert.equal(boredom(0, now), 1, '从未有过刺激 = 彻底闲着');
  assert.equal(boredom(now - 10 * MIN, now), 10 / BORED_SATURATION_MINUTES);
  assert.equal(boredom(now - 999 * MIN, now), 1, '封顶');
  assert.equal(boredom(now, now), 0, '刚有刺激');
});

test('想念：按小时爬升，对方活跃时段更快', () => {
  const idle10h = now - 10 * HOUR;
  const calm = longing(idle10h, now, false);
  const peak = longing(idle10h, now, true);
  assert.ok(peak > calm, '活跃时段想念爬得更快');
  assert.equal(longing(now, now, true), 0, '刚说完话不想念');
  assert.equal(longing(now - 999 * HOUR, now, true), 1, '封顶');
});

test('社交电量：聊天消耗、独处恢复、有界', () => {
  const full = { social: 1, express: 0, lastStimulusAt: now, updatedAt: now };
  const after = tickMotives(full, {
    now: now + HOUR,
    exchanges: 0,
    didSomething: false,
    moodEvent: 0,
  });
  assert.equal(after.social, 1, '满电不溢出');
  const chatted = tickMotives(full, {
    now: now + 60000,
    exchanges: 10,
    didSomething: false,
    moodEvent: 0,
  });
  assert.ok(chatted.social < 1, '聊天掉电');
  const recovered = tickMotives(
    { ...chatted, updatedAt: now + 60000 },
    {
      now: now + 60000 + SOCIAL_RECOVERY_HOURS * HOUR,
      exchanges: 0,
      didSomething: false,
      moodEvent: 0,
    },
  );
  assert.equal(recovered.social, 1, `独处 ${SOCIAL_RECOVERY_HOURS} 小时回满`);
});

test('表达欲：事件抬升、按半衰消退', () => {
  const base = { social: 1, express: 0, lastStimulusAt: now, updatedAt: now };
  const bumped = tickMotives(base, {
    now: now + MIN,
    exchanges: 0,
    didSomething: true,
    moodEvent: 0,
  });
  assert.ok(bumped.express > 0, '做成一件事想分享');
  const decayed = tickMotives(
    { ...bumped, updatedAt: now + MIN },
    {
      now: now + MIN + 24 * HOUR,
      exchanges: 0,
      didSomething: false,
      moodEvent: 0,
    },
  );
  assert.ok(decayed.express < bumped.express, '随时间消退');
  assert.ok(decayed.express >= 0, '不越界');
});

test('做成一件事缓解无聊', () => {
  const idle = {
    social: 1,
    express: 0,
    lastStimulusAt: now - 120 * MIN,
    updatedAt: now - 120 * MIN,
  };
  const after = tickMotives(idle, { now: now, exchanges: 0, didSomething: true, moodEvent: 0 });
  const relief = boredomAfter(idle, { now, exchanges: 0, didSomething: true, moodEvent: 0 }, now);
  const plain = boredom(idle.lastStimulusAt, now);
  assert.ok(relief < plain, '做事后没那么无聊了');
  assert.equal(after.lastStimulusAt, now, '刺激时刻被推新');
});

test('体感措辞：按强度分层，无感为空', () => {
  const feel: MotiveFeel = { bored: 0, miss: 0, social: 0.5, express: 0 };
  assert.equal(renderMotives(feel), '', '平静无感不说话');
  const restless = renderMotives({ bored: 0.9, miss: 0.8, social: 0.1, express: 0.8 });
  assert.match(restless, /发慌/);
  assert.match(restless, /很想他/);
  assert.match(restless, /社交电量见底/);
  assert.match(restless, /不吐不快/);
  // 满电也值得说：但低语与满语不同向。
  assert.match(renderMotives({ bored: 0, miss: 0, social: 1, express: 0 }), /社交电量满/);
});

test('心跳间隔：黏人度决定基准，饥饿加速，社交没电减速，有界', () => {
  const motives: MotiveFeel = { bored: 0.2, miss: 0.2, social: 1, express: 0 };
  const loner = nextBeatDelayMs({ clinginess: 0, motives, sinceLastExchangeMs: Infinity });
  const clinger = nextBeatDelayMs({ clinginess: 100, motives, sinceLastExchangeMs: Infinity });
  assert.ok(loner > clinger * 2, '黏人度 0 与 100 的基准应差数倍');
  for (let i = 0; i < 20; i++) {
    const ms = nextBeatDelayMs({ clinginess: 50, motives, sinceLastExchangeMs: Infinity });
    assert.ok(ms >= 3 * MIN && ms <= 4 * HOUR, '间隔永远有界');
  }
  const mean = (samples: number[]) => samples.reduce((a, b) => a + b, 0) / samples.length;
  const hungryMean = mean(
    Array.from({ length: 40 }, () =>
      nextBeatDelayMs({
        clinginess: 50,
        motives: { bored: 0.9, miss: 0.9, social: 1, express: 0 },
        sinceLastExchangeMs: Infinity,
      }),
    ),
  );
  const calmMean = mean(
    Array.from({ length: 40 }, () =>
      nextBeatDelayMs({
        clinginess: 50,
        motives: { bored: 0, miss: 0, social: 1, express: 0 },
        sinceLastExchangeMs: Infinity,
      }),
    ),
  );
  // 饥饿加速 ×0.55，抖动 ±25%：均值比应显著小于 1（统计断言抗抖动）。
  assert.ok(hungryMean < calmMean * 0.7, `饥饿均值 ${hungryMean} 应远小于平静均值 ${calmMean}`);
  const afterChat = nextBeatDelayMs({
    clinginess: 0,
    motives,
    sinceLastExchangeMs: 60000,
  });
  assert.ok(afterChat <= 5 * MIN * 1.26 + 1000, '余韵未散时节拍加密到几分钟');
});

test('睡眠窗口：跨午夜区间与整日不眠（分钟版，抖动后窗口不再整点）', () => {
  assert.equal(inSleepMinutes(3 * 60, 60, 420), true);
  assert.equal(inSleepMinutes(8 * 60, 60, 420), false);
  assert.equal(inSleepMinutes(23 * 60, 23 * 60, 420), true);
  assert.equal(inSleepMinutes(12 * 60, 23 * 60, 420), false);
  assert.equal(inSleepMinutes(4 * 60, 420, 420), false, 'start==end 是不眠设定');
});

// ---------- 心跳输出契约 ----------

const stickers: Sticker[] = [{ slug: 'happy', description: '开心', tags: [], file: 'x.png' }];

test('心跳输出：speak/muse/nothing 三种合法形状', () => {
  const speak = parsePulseOutput(
    { action: 'speak', messages: ['在干嘛', { type: 'sticker', slug: 'happy' }] },
    stickers,
  );
  assert.equal(speak.action, 'speak');
  assert.equal(speak.parts.length, 2);
  assert.equal(speak.parts[1]!.type, 'sticker');

  const muse = parsePulseOutput({ action: 'muse', thought: '改天问他那件事' }, stickers);
  assert.equal(muse.action, 'muse');
  assert.equal(muse.thought, '改天问他那件事');

  const nothing = parsePulseOutput({ action: 'nothing' }, stickers);
  assert.equal(nothing.action, 'nothing');
  assert.equal(nothing.parts.length, 0);
});

test('心跳输出：非法形状必须抛错而不是被猜', () => {
  assert.throws(() => parsePulseOutput({}, stickers), /action/);
  assert.throws(() => parsePulseOutput({ action: 'dance' }, stickers), /action/);
  assert.throws(() => parsePulseOutput({ action: 'speak', messages: [] }, stickers), /speak/);
  assert.throws(() => parsePulseOutput({ action: 'muse' }, stickers), /muse/);
  assert.throws(
    () => parsePulseOutput({ action: 'nothing', messages: ['不该有'] }, stickers),
    /messages/,
  );
  const ok = parsePulseOutput(
    { action: 'speak', messages: ['hi'], activity: '跑通了脚本' },
    stickers,
  );
  assert.equal(ok.activity, '跑通了脚本');
});
