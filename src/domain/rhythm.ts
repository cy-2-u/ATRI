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
/** 某一天的睡眠窗：日期抖动 + 当晚唤醒度推迟入睡。arousalMin 是纯代码
 *  从当天晚间经历算出的推迟分钟数（封顶 60）——热闹的夜晚睡得晚，这
 *  仍是身体，不是模型说了算。startMin === endMin 仍表示整日不眠。 */
export function sleepWindow(
  day: string,
  startMin: number,
  endMin: number,
  arousalMin = 0,
): { startMin: number; endMin: number } {
  const key = `${day}|${startMin}|${endMin}|${arousalMin}`;
  let window = sleepWindowCache.get(key);
  if (!window) {
    const jittered = jitteredSleepWindow(day, startMin, endMin);
    const start = (((jittered.startMin + Math.max(0, arousalMin)) % 1440) + 1440) % 1440;
    window = { startMin: start, endMin: jittered.endMin };
    if (sleepWindowCache.size > 64) sleepWindowCache.clear();
    sleepWindowCache.set(key, window);
  }
  return window;
}

/** 唤醒度的事件日归属：此刻的睡眠若在"夜尾段"（本地分钟早于当天抖动
 *  后的醒来时刻），入睡发生在当天凌晨——那份热闹属于**前一晚**；否则
 *  属于当天晚上。归属边界必须用抖动后的实际终点：配置值 420 的早晨
 *  6:00–7:45 段会跨过它，用配置值切会把"昨晚的入睡"算到今晚头上。 */
export function sleepDayKeyOf(
  at: number,
  timeZone: string,
  startMin: number,
  endMin: number,
): string {
  const day = dayKeyOf(at, timeZone);
  const end = jitteredSleepWindow(day, startMin, endMin).endMin;
  return minutesOfDay(at, timeZone) < end ? dayKeyOf(at - 12 * 3600000, timeZone) : day;
}

/** 当晚唤醒度 → 入睡推迟分钟：18 点后的每段经历（说话、做事）都让身体
 *  多清醒一会儿。封顶一小时——熬夜有代价，但兴奋的夜晚确实睡不着。 */
export function eveningArousalMinutes(
  events: { kind: string; created_at: number }[],
  day: string,
  timeZone: string,
): number {
  let lively = 0;
  for (const event of events)
    if (
      dayKeyOf(event.created_at, timeZone) === day &&
      minutesOfDay(event.created_at, timeZone) >= 1080
    )
      lively++;
  return Math.min(60, lively * 6);
}

/** 给定时刻之后最近的"醒来"时刻：due 落在睡眠窗内就推到窗结束。
 *  判定窗就是 due 所在日历日的窗——睡眠段（夜里入睡段与凌晨尾段）
 *  完整落在同一天，不存在跨归属问题；arousalMin 是调用方按
 *  sleepDayKeyOf 归属好的"今晚"推迟量。 */
export function nextWakeAfter(
  due: number,
  timeZone: string,
  startMin: number,
  endMin: number,
  arousalMin = 0,
): number {
  if (startMin === endMin) return due;
  const { startMin: s, endMin: e } = sleepWindow(
    dayKeyOf(due, timeZone),
    startMin,
    endMin,
    arousalMin,
  );
  const minute = minutesOfDay(due, timeZone);
  if (!inSleepMinutes(minute, s, e)) return due;
  let delta = e - minute;
  if (delta <= 0) delta += 1440;
  return due + delta * 60000;
}
