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

const minuteFormatters = new Map<string, Intl.DateTimeFormat>();
/** 本地时钟的当天分钟数（0–1439）：抖动后的睡眠窗不再是整点，判定要用分。 */
export function minutesOfDay(at: number, timeZone: string): number {
  let formatter = minuteFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    minuteFormatters.set(timeZone, formatter);
  }
  const [h, m] = formatter.format(new Date(at)).split(':');
  return Number(h) * 60 + Number(m);
}

/** 当天睡眠窗口的生理抖动：按本地日期哈希把入睡与醒来时刻各平移
 *  ±45 分钟。同一天内稳定（每分钟的调度检查得到同一结果），跨天缓慢
 *  变化——她不会每天在同一分钟睡着、同一分钟醒来。start===end 仍表示
 *  整日不眠，抖动不得凭空造出睡眠窗。
 *
 *  边界说明：睡眠窗是她的身体（睡着时没有"她"在做决定），不是对表达
 *  的拦截；醒着的每一拍，说不说、说几次，都由她自己定。 */
export function jitteredSleepWindow(
  day: string,
  startHour: number,
  endHour: number,
): { startMin: number; endMin: number } {
  if (startHour === endHour) return { startMin: startHour * 60, endMin: endHour * 60 };
  let hash = 2166136261;
  for (let i = 0; i < day.length; i++) {
    hash ^= day.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const unsigned = hash >>> 0;
  const offsetStart = (unsigned % 91) - 45;
  const offsetEnd = (Math.floor(unsigned / 91) % 91) - 45;
  return { startMin: startHour * 60 + offsetStart, endMin: endHour * 60 + offsetEnd };
}

/** 分钟版的睡眠判定（抖动后窗口带小数时刻，整点判定会漏边缘）。
 *  startMin === endMin 仍为不眠；跨午夜窗口与整数版同规则。 */
export function inSleepMinutes(minute: number, startMin: number, endMin: number): boolean {
  return startMin === endMin
    ? false
    : startMin < endMin
      ? minute >= startMin && minute < endMin
      : minute >= startMin || minute < endMin;
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
