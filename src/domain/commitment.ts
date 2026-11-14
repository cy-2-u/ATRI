export interface Commitment {
  id: string;
  content: string;
  sources: string[];
  kind: 'reminder' | 'concern' | 'promise';
  dueAt: number;
  recurring: 'none' | 'yearly';
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
