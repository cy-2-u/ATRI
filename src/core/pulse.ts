import {
  PULSE_AFTER_CHAT_MINUTES,
  SILENCE_HOURS_THRESHOLD,
  RHYTHM_MIN_BUCKET,
} from './constants.js';

/** 心跳的确定性部分：节拍间隔、睡眠窗口、动机的体感措辞。
 *  这些是"生理"，永远是代码；"要不要说话"永远是模型。 */

export interface MotiveFeel {
  bored: number;
  miss: number;
  social: number;
  express: number;
}

/** 她的睡眠窗口（配置语义：她真的在睡，不是"拦截时段"）。
 *  start === end 表示整日不眠（不推荐）。 */
export function inSleepHours(hour: number, start: number, end: number): boolean {
  return start === end
    ? false
    : start < end
      ? hour >= start && hour < end
      : hour >= start || hour < end;
}

/** 判断是否对方的惯常活跃时段（作息数据 24 桶）。 */
export function isHisActiveHour(buckets: number[], hour: number): boolean {
  const total = buckets.reduce((n, v) => n + v, 0);
  if (!total) return false;
  const peak = Math.max(RHYTHM_MIN_BUCKET, Math.ceil(total / 24 / 2));
  return (buckets[hour] ?? 0) >= Math.min(peak, RHYTHM_MIN_BUCKET * 2);
}

export interface BeatTiming {
  /** 黏人度 0–100（人格参数）。 */
  clinginess: number;
  motives: MotiveFeel;
  /** 距上一次往来消息多少毫秒（聊天刚结束 → 余韵未散）。 */
  sinceLastExchangeMs: number;
}

/** 下一拍还有多久。基准由黏人度决定，状态让它伸缩，走神让它抖动；
 *  这里没有任何"不许发"的分支——密度是节律，不是闸门。 */
export function nextBeatDelayMs(input: BeatTiming): number {
  const base = 90 - (72 * Math.max(0, Math.min(100, input.clinginess))) / 100; // 90→18 分钟
  let minutes = base;
  // 余韵：刚聊完的几分钟里意识还挂在刚才的话题上。
  if (input.sinceLastExchangeMs < PULSE_AFTER_CHAT_MINUTES * 60000) minutes = Math.min(minutes, 5);
  // 饥饿的动机让意识更频繁地转起来。
  if (input.motives.miss >= 0.7 || input.motives.bored >= 0.75) minutes *= 0.55;
  // 社交电量见底：她需要一个人待着，念头转得慢。
  if (input.motives.social <= 0.25) minutes *= 1.6;
  // 走神抖动 ±25%。
  minutes *= 0.75 + Math.random() * 0.5;
  return Math.max(3 * 60000, Math.min(4 * 3600000, Math.round(minutes * 60000)));
}

const level = (v: number, low: number, high: number) => (v < low ? 0 : v < high ? 1 : 2);

/** 动机的体感措辞：数值从不出现，强度用措辞分层。空串表示"无感"。 */
export function renderMotives(feel: MotiveFeel): string {
  const parts: string[] = [];
  const bored = level(feel.bored, 0.35, 0.7);
  if (bored === 1) parts.push('有点闲，做事提不起劲');
  if (bored === 2) parts.push('闲得发慌，手机拿起来又放下');
  const miss = level(feel.miss, 0.3, 0.65);
  if (miss === 1) parts.push('有点想他');
  if (miss === 2) parts.push('很想他，忍不住想找他说说话');
  if (feel.social <= 0.25)
    parts.push('社交电量见底，此刻不太想应付任何人——但真正重要的关心仍然要说');
  else if (feel.social >= 0.85) parts.push('社交电量满，挺想找人说话');
  if (feel.express >= 0.6) parts.push('心里有话憋着，不吐不快');
  return parts.join('；');
}

/** 心跳材料里对静默时长的分档提醒（与聊天共用同一套体感阈值）。 */
export function silenceNote(minutes: number): string {
  if (minutes < SILENCE_HOURS_THRESHOLD * 60) return '';
  return `距上一条消息已经有一段明显的空白（约 ${Math.floor(minutes / 60)} 小时）。`;
}
