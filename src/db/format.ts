/** 时区相关的日期工具：按 zone 缓存 Intl 格式器；本地墙钟时间与 UTC 的
 *  换算用两次探测覆盖 DST 边界（UTC 零点不是本地零点）。 */

const hourFormatters = new Map<string, Intl.DateTimeFormat>();
export function hourFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = hourFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hourCycle: 'h23' });
    hourFormatters.set(timeZone, formatter);
  }
  return formatter;
}

const dateFormatters = new Map<string, Intl.DateTimeFormat>();
function dateParts(at: number, timeZone: string) {
  let formatter = dateFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    dateFormatters.set(timeZone, formatter);
  }
  return formatter
    .formatToParts(new Date(at))
    .reduce<Record<string, string>>((acc, p) => ({ ...acc, [p.type]: p.value }), {});
}

/** 同一本地墙钟时刻一年后的时间戳。固定 +365 天会漂移：2 月 29 日生日
 *  会变成 2 月 28 日再来回摆；此处映射到目标月的真实末日。 */
export function addYear(at: number, timeZone = 'Asia/Shanghai'): number {
  const p = dateParts(at, timeZone);
  const [year, month, day, hour, minute, second] = [
    Number(p.year),
    Number(p.month),
    Number(p.day),
    Number(p.hour),
    Number(p.minute),
    Number(p.second),
  ];
  const daysInTargetMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
  const targetDay = Math.min(day, daysInTargetMonth(year + 1, month));
  const asUtc = Date.UTC(year + 1, month - 1, targetDay, hour, minute, second);
  let result = asUtc;
  for (let i = 0; i < 2; i++) {
    const offsetName = new Intl.DateTimeFormat('en-GB', { timeZone, timeZoneName: 'longOffset' })
      .formatToParts(new Date(result))
      .find((x) => x.type === 'timeZoneName')!.value;
    const match = /GMT([+-])(\d{2}):?(\d{2})?/.exec(offsetName);
    const sign = match?.[1] === '-' ? -1 : 1;
    const oh = Number(match?.[2] ?? 0),
      om = Number(match?.[3] ?? 0);
    result = asUtc - sign * (oh * 3600000 + om * 60000);
  }
  return result;
}

/** 供 DST 探测复用的偏移解析：epoch = 墙钟 UTC 值 − 该时区偏移。 */
export function epochOfWallTime(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): number {
  const utc = Date.parse(
    `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00Z`,
  );
  let result = utc;
  for (let i = 0; i < 2; i++) {
    const name = new Intl.DateTimeFormat('en-GB', { timeZone, timeZoneName: 'longOffset' })
      .formatToParts(new Date(result))
      .find((p) => p.type === 'timeZoneName')!.value;
    const match = /GMT([+-])(\d{2}):?(\d{2})?/.exec(name);
    const sign = match?.[1] === '-' ? -1 : 1;
    result = utc - sign * (Number(match?.[2] ?? 0) * 3600000 + Number(match?.[3] ?? 0) * 60000);
  }
  return result;
}
