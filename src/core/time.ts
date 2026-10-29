import { hourFormatter, epochOfWallTime } from '../db/index.js';
import {
  SILENCE_NOTIFY_MINUTES,
  SILENCE_HOURS_THRESHOLD,
  RHYTHM_MIN_BUCKET,
  RHYTHM_PEAK_BUCKETS,
} from './constants.js';

/** 时间感知：她知道现在是什么时候、隔了多久、上次聊天挂在哪个时段。 */

const cache = <T>(make: (timeZone: string) => T) => {
  const store = new Map<string, T>();
  return (timeZone: string): T => {
    let value = store.get(timeZone);
    if (!value) {
      value = make(timeZone);
      store.set(timeZone, value);
    }
    return value;
  };
};

export const sourceFormatter = cache(
  (tz) =>
    new Intl.DateTimeFormat('zh-CN', {
      timeZone: tz,
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }),
);
export const momentFormatter = cache(
  (tz) => new Intl.DateTimeFormat('zh-CN', { timeZone: tz, dateStyle: 'full', timeStyle: 'short' }),
);
const dayKeyFormatter = cache(
  (tz) =>
    new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }),
);
const weekdayFormatter = cache(
  (tz) => new Intl.DateTimeFormat('zh-CN', { timeZone: tz, weekday: 'long' }),
);

/** 本地日历日期（YYYY-MM-DD）。 */
export function dayKey(at: number, timeZone: string): string {
  return dayKeyFormatter(timeZone).format(new Date(at));
}
/** 两个时刻相差的本地日历天数（周一 23:00 → 周三 00:30 是"隔了两天"）。 */
export function calendarDays(from: number, to: number, timeZone: string): number {
  const day = (at: number) => Date.parse(dayKey(at, timeZone) + 'T00:00:00Z');
  return Math.round((day(to) - day(from)) / 86400000);
}
/** 一天里的时段：人对久别的记忆挂在"周五晚上"，不挂在小时数上。 */
export function daypart(at: number, timeZone: string): string {
  const hour = Number(hourFormatter(timeZone).format(new Date(at)));
  if (hour < 5) return '凌晨';
  if (hour < 11) return '早上';
  if (hour < 13) return '中午';
  if (hour < 18) return '下午';
  return '晚上';
}

/** 同一 burst（连发）内的消息间隔上限。 */
export const BURST_WINDOW_MS = 5 * 60000;
/** 日级天数的口语模糊化（图灵审查修复 #8）：人报"隔了几天"是估的，
 *  "第三天""整整八天"这种分毫不差的计数是系统读表。数字 >=3 天时按
 *  邻近天数渲染为"约 N 天"或"好几天"，让模型的措辞带上容差；小时与
 *  分钟是体感更准的量级，保持精确。 */
export function vagueDays(days: number): string {
  if (days < 3) return `${days} 天`;
  if (days === 3) return '约三天';
  if (days <= 5) return '好几天';
  if (days <= 9) return '一周左右';
  if (days <= 13) return '十来天';
  if (days <= 20) return '两周多';
  return '快一个月';
}
/** 本轮打断的静默真正开始的时刻：与最新一条比永远是 ~0（它就是触发者），
 *  要回溯过整段连发，找到连发开始之前的那一条。主动消息的间隔从对方
 *  最后一条算起；聊天轮同理——若连发之前只有她自己发过的主动消息
 *  （对方一直没回），对方体验到的静默从对方最后一条算起，久别重逢的
 *  锚点挂在对方最后说话的时刻，而不是她的 ping。 */
export function silenceBasis(
  history: { role: string; created_at: number }[],
  proactive: boolean,
): number | undefined {
  if (!history.length) return undefined;
  const lastUser = [...history].reverse().find((m) => m.role === 'user')?.created_at;
  if (proactive) return lastUser;
  let i = history.length - 1;
  while (i > 0 && history[i]!.created_at - history[i - 1]!.created_at < BURST_WINDOW_MS) i--;
  // 越过未获回应的主动消息：静默从对方最后一条用户消息起算。
  let j = i;
  while (j > 0 && history[j - 1]!.role === 'assistant') j--;
  if (j > 0 && history[j - 1]!.role === 'user') return history[j - 1]!.created_at;
  return i > 0 ? history[i - 1]!.created_at : undefined;
}

/** 时间感知的分档渲染：连续聊天 / 几小时 / 隔天（带时段锚点）…… */
export function renderTimeGap(now: number, lastAt: number, timeZone: string): string {
  const gapMs = Math.max(0, now - lastAt);
  const minutes = Math.floor(gapMs / 60000);
  const moment = `现在是${momentFormatter(timeZone).format(new Date(now))}`;
  if (gapMs < SILENCE_NOTIFY_MINUTES * 60000)
    return `${moment}（距上一条消息不到 ${Math.max(1, Math.ceil(gapMs / 60000))} 分钟，是连续聊天）`;
  if (gapMs < 24 * 3600000) {
    const hours = Math.floor(gapMs / 3600000);
    const text = hours >= 1 ? `${hours} 小时` : `${minutes} 分钟`;
    const note = gapMs >= SILENCE_HOURS_THRESHOLD * 3600000 ? '，中间有一段明显的空白' : '';
    return `${moment}（距上一条消息约 ${text}${note}）`;
  }
  const days = Math.max(1, calendarDays(lastAt, now, timeZone));
  const anchor = `${weekdayFormatter(timeZone).format(new Date(lastAt))}${daypart(lastAt, timeZone)}`;
  return `${moment}（距上一条消息已有${vagueDays(days)}，上次聊天是${anchor}，中间没有聊过天）`;
}

/** 对方的习惯活跃时段（近 14 天 24 桶）。 */
export function renderRhythm(buckets: number[], hour: number): string {
  const total = buckets.reduce((n, v) => n + v, 0);
  if (!total) return '';
  // 相对阈值随总量浮动：轻聊天的活跃时段用绝对值永远判不出来。
  const peak = Math.max(RHYTHM_MIN_BUCKET, Math.ceil(total / 24 / 2));
  const threshold = Math.min(peak, RHYTHM_MIN_BUCKET * 2);
  const habitual = buckets
    .map((n, h) => ({ n, h }))
    .filter((b) => b.n >= threshold)
    .sort((a, b) => b.n - a.n)
    .slice(0, RHYTHM_PEAK_BUCKETS)
    .map((b) => b.h)
    .sort((a, b) => a - b);
  if (!habitual.length) return '';
  const bands: string[] = [];
  let start = habitual[0]!,
    prev = habitual[0]!;
  for (const h of habitual.slice(1)) {
    if (h === prev + 1) {
      prev = h;
      continue;
    }
    bands.push(start === prev ? `${start} 点` : `${start}–${prev} 点`);
    start = h;
    prev = h;
  }
  bands.push(start === prev ? `${start} 点` : `${start}–${prev} 点`);
  const activeNow = buckets[hour]! >= threshold;
  return `对方通常活跃时段：${bands.join('、')}。${
    activeNow
      ? '现在正处于活跃时段。'
      : `现在（${hour} 点）不是对方常聊的时间，主动联系时可以提一句"这个点还没休息？"之类。`
  }`;
}

/** 某本地日期零点的时间戳：两次探测覆盖 DST 边界。 */
export function localMidnight(at: number, timeZone: string): number {
  const key = dayKey(at, timeZone);
  const [y, m, d] = key.split('-').map(Number) as [number, number, number];
  return epochOfWallTime(y, m, d, 0, 0, timeZone);
}

/** 下一个适合主动联系的时刻：优先落在对方习惯活跃的时段里。没有作息
 *  数据返回 undefined（调用方退回随机延迟）。视野 30 小时，覆盖"今天
 *  已过、排到明天最活跃时段"。 */
export function nextRhythmSlot(
  buckets: number[],
  now: number,
  timeZone: string,
  jitterMinutes: number,
  maxHorizonHours = 30,
): number | undefined {
  const total = buckets.reduce((n, v) => n + v, 0);
  if (!total) return undefined;
  const peak = Math.max(RHYTHM_MIN_BUCKET, Math.ceil(total / 24 / 2));
  const good = buckets
    .map((n, h) => ({ n, h }))
    .filter((b) => b.n >= Math.min(peak, RHYTHM_MIN_BUCKET * 2))
    .map((b) => b.h);
  if (!good.length) return undefined;
  const hourNow = Number(hourFormatter(timeZone).format(new Date(now)));
  const horizon = now + maxHorizonHours * 3600000;
  const jitter = () => Math.floor(Math.random() * jitterMinutes) * 60000;
  // 今天剩余的合适时段按活跃度挑一个；都过了排到明天最活跃的时段。
  const remaining = good.filter((h) => h > hourNow).sort((a, b) => buckets[b]! - buckets[a]!);
  if (remaining.length) {
    const picked = remaining[Math.floor(Math.random() * Math.min(2, remaining.length))]!;
    const at = localMidnight(now, timeZone) + picked * 3600000 + jitter();
    return at > now && at <= horizon ? at : undefined;
  }
  const best = [...good].sort((a, b) => buckets[b]! - buckets[a]!)[0]!;
  const at = localMidnight(now + 86400000, timeZone) + best * 3600000 + jitter();
  return at <= horizon ? at : undefined;
}
