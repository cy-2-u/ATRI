export interface Commitment {
  id: string;
  content: string;
  sources: string[];
  kind: 'reminder' | 'concern' | 'promise';
  dueAt: number;
  recurring: 'none' | 'day' | 'week' | 'month' | 'year';
  state: 'open' | 'resolved' | 'expired';
  askedAt: number;
  createdAt: number;
}

// 日历递进采用 UTC 构造的墙上时间；二月二十九日在平年取二月末。
export function nextYearAfter(timestamp: number, now: number): number {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime()) || !Number.isFinite(now)) throw new TypeError('日期无效');
  let year = Math.max(date.getUTCFullYear() + 1, new Date(now).getUTCFullYear());
  for (;;) {
    const month = date.getUTCMonth();
    const day = Math.min(date.getUTCDate(), new Date(Date.UTC(year, month + 1, 0)).getUTCDate());
    const result = Date.UTC(
      year,
      month,
      day,
      date.getUTCHours(),
      date.getUTCMinutes(),
      date.getUTCSeconds(),
      date.getUTCMilliseconds(),
    );
    if (result > now) return result;
    year++;
  }
}

/** 周期约定的下一次发生时刻（beta nextOccurrence 的 main 语义）：day/week
 *  加天数、month/year 加月数，月末溢出 clamp 到月末（1/31 → 2/28，闰日
 *  → 平年 2/28），时分秒毫秒保持不变。返回值恒 > after。 */
export function nextOccurrence(
  timestamp: number,
  unit: 'day' | 'week' | 'month' | 'year',
  after: number,
): number {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime()) || !Number.isFinite(after)) throw new TypeError('日期无效');
  if (unit === 'day' || unit === 'week') {
    const step = unit === 'week' ? 7 : 1;
    let result = Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate() + step,
      date.getUTCHours(),
      date.getUTCMinutes(),
      date.getUTCSeconds(),
      date.getUTCMilliseconds(),
    );
    while (result <= after) result += step * 86_400_000;
    return result;
  }
  const monthsPerStep = unit === 'year' ? 12 : 1;
  let count = 1;
  for (;;) {
    const total = date.getUTCFullYear() * 12 + date.getUTCMonth() + count * monthsPerStep;
    const year = Math.floor(total / 12);
    const month = total % 12;
    const day = Math.min(date.getUTCDate(), new Date(Date.UTC(year, month + 1, 0)).getUTCDate());
    const result = Date.UTC(
      year,
      month,
      day,
      date.getUTCHours(),
      date.getUTCMinutes(),
      date.getUTCSeconds(),
      date.getUTCMilliseconds(),
    );
    if (result > after) return result;
    count++;
  }
}
