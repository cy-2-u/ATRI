/** 内稳态：动机（motives）。参考模拟人生 needs-based AI 的机制——
 *  会衰减、会被满足的身体状态——但意义与决策永远交给模型。
 *
 *  分工是这套系统的底线：
 *  - 代码只负责生理：数值随时间与事件涨落（确定性、可测试）；
 *  - 模型负责把这些数值翻译成体感并决定要不要行动；
 *  - 动机永远不禁止任何行为。它影响"她此刻的感觉"，不设"不许说话"的闸门。
 *
 *  四个动机中，无聊与想念是纯时间导出量（随时可算，无需存积分），
 *  社交电量与表达欲是真状态积分（随事件消耗/抬升，随时间恢复/消退），
 *  因此入库的只有后两者加两个时间戳。 */

export interface MotiveState {
  /** 社交电量 0–1：聊天消耗，独处恢复。低了想一个人待着。 */
  social: number;
  /** 表达欲 0–1：心情事件抬升，说完话消退。 */
  express: number;
  /** 上次有任何刺激（聊天往来/做成一件事）的时刻，无聊从它起算。 */
  lastStimulusAt: number;
  /** 上次积分结转的时刻。 */
  updatedAt: number;
}

export interface MotiveTick {
  now: number;
  /** 自上次结转以来的往来消息条数（收+发）。 */
  exchanges: number;
  /** 期间她做成了自己的事（生活流水有新条目）。 */
  didSomething: boolean;
  /** 期间的心情事件强度 0–1（|moodPulse| 的最大值）。 */
  moodEvent: number;
}

/** 单调多少分钟无聊拉满。 */
export const BORED_SATURATION_MINUTES = 240;
/** 与某人断了联系多少小时想念拉满。 */
export const LONGING_SATURATION_HOURS = 20;
/** 对方惯常活跃的时段里，想念爬得更快——晚上想起一个人是真实的生理。 */
export const LONGING_PEAK_BOOST = 1.4;
/** 独处多少小时社交电量回满。 */
export const SOCIAL_RECOVERY_HOURS = 6;
/** 每条往来消息消耗的社交电量。 */
export const SOCIAL_COST_PER_MESSAGE = 0.05;
/** 表达欲的半衰期（小时）。 */
export const EXPRESS_HALFLIFE_HOURS = 2;
/** 做成一件事对无聊的即时缓解（占当前值的比例）。 */
export const ACCOMPLISHMENT_BOREDOM_RELIEF = 0.5;
/** 做成一件事对表达欲的抬升。 */
export const ACCOMPLISHMENT_EXPRESS_BUMP = 0.2;

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** 无聊：单调（没有任何往来也没有做成事）时间的确定函数。 */
export function boredom(lastStimulusAt: number, now: number): number {
  if (!lastStimulusAt) return 1;
  const minutes = (now - lastStimulusAt) / 60000;
  return clamp01(minutes / BORED_SATURATION_MINUTES);
}

/** 想念：距上次和他说话的时间导出量；他的活跃时段爬得更快。 */
export function longing(lastSpokeAt: number, now: number, hisActiveHour: boolean): number {
  if (!lastSpokeAt) return 0.5;
  const hours = (now - lastSpokeAt) / 3600000;
  return clamp01((hours / LONGING_SATURATION_HOURS) * (hisActiveHour ? LONGING_PEAK_BOOST : 1));
}

/** 结转一轮积分状态：恢复、消耗、衰减与事件抬升。无聊不在此处计算——
 *  它是时间导出量，调用方在渲染时用 boredom(lastStimulusAt, now) 现算；
 *  这里只负责把"做成了事"折进单调起算点。 */
export function tickMotives(prev: MotiveState, tick: MotiveTick): MotiveState {
  const elapsedHours = Math.max(0, (tick.now - prev.updatedAt) / 3600000);
  const social = clamp01(
    prev.social + elapsedHours / SOCIAL_RECOVERY_HOURS - tick.exchanges * SOCIAL_COST_PER_MESSAGE,
  );
  const express = clamp01(
    prev.express * Math.pow(0.5, elapsedHours / EXPRESS_HALFLIFE_HOURS) +
      tick.moodEvent * 0.3 +
      (tick.didSomething ? ACCOMPLISHMENT_EXPRESS_BUMP : 0),
  );
  const stimulated = tick.exchanges > 0 || tick.didSomething;
  return {
    social,
    express,
    lastStimulusAt: stimulated ? tick.now : prev.lastStimulusAt,
    updatedAt: tick.now,
  };
}

/** 结转后的即时无聊：当前单调值按"做成了事"缓解一部分。 */
export function boredomAfter(prev: MotiveState, tick: MotiveTick, now: number): number {
  const base = boredom(prev.lastStimulusAt, now);
  return tick.didSomething ? base * (1 - ACCOMPLISHMENT_BOREDOM_RELIEF) : base;
}
