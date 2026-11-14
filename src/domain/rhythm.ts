/** 心跳的确定性部分：节拍间隔、睡眠窗口与时刻感知。
 *  这些是"生理"，永远是代码；"要不要说话"永远是模型。睡眠窗是她的身体
 *  （睡着时没有"她"在做决定），不是对表达的拦截；醒着的每一拍，说不说、
 *  说几次，都由她自己定。 */

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
 *  ±45 分钟。同一天内稳定，跨天缓慢变化——她不会每天在同一分钟睡着。
 *  startMin === endMin 仍表示整日不眠，抖动不得凭空造出睡眠窗。 */
export function jitteredSleepWindow(
  day: string,
  startMin: number,
  endMin: number,
): { startMin: number; endMin: number } {
  if (startMin === endMin) return { startMin, endMin };
  let hash = 2166136261;
  for (let i = 0; i < day.length; i++) {
    hash ^= day.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const unsigned = hash >>> 0;
  return {
    startMin: startMin + ((unsigned % 91) - 45),
    endMin: endMin + ((Math.floor(unsigned / 91) % 91) - 45),
  };
}

/** 分钟版睡眠判定：startMin === endMin 仍为不眠；跨午夜窗口同规则。 */
export function inSleepMinutes(minute: number, startMin: number, endMin: number): boolean {
  return startMin === endMin
    ? false
    : startMin < endMin
      ? minute >= startMin && minute < endMin
      : minute >= startMin || minute < endMin;
}

export function dayKeyOf(at: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(at));
}

const sleepWindowCache = new Map<string, { startMin: number; endMin: number }>();
/** 抖动后的当日睡眠窗（按天缓存：同一天内每次询问得到同一结果）。 */
export function sleepWindow(
  at: number,
  timeZone: string,
  startMin: number,
  endMin: number,
): { startMin: number; endMin: number } {
  const day = dayKeyOf(at, timeZone);
  const key = `${day}|${startMin}|${endMin}`;
  let window = sleepWindowCache.get(key);
  if (!window) {
    window = jitteredSleepWindow(day, startMin, endMin);
    if (sleepWindowCache.size > 64) sleepWindowCache.clear();
    sleepWindowCache.set(key, window);
  }
  return window;
}

/** 给定时刻之后最近的"醒来"时刻：due 落在睡眠窗内就推到窗结束。
 *  分钟加法对时刻戳成立（比较都用 minutesOfDay），跨午夜窗两个时段
 *  （尾段到今日 e 点、首段到明日 e 点）统一由 delta 覆盖。 */
export function nextWakeAfter(
  due: number,
  timeZone: string,
  startMin: number,
  endMin: number,
): number {
  if (startMin === endMin) return due;
  const { startMin: s, endMin: e } = sleepWindow(due, timeZone, startMin, endMin);
  const minute = minutesOfDay(due, timeZone);
  if (!inSleepMinutes(minute, s, e)) return due;
  let delta = e - minute;
  if (delta <= 0) delta += 1440;
  return due + delta * 60000;
}
