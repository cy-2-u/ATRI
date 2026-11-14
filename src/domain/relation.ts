import type { Journal } from '../storage/journal.js';
import { clamp } from './state.js';
import { dayKeyOf, minutesOfDay } from './rhythm.js';

/** 关系是长出来的，不是设置出来的：黏人度（closeness）是她自己的属性，
 *  每个本地日根据真实的相处统计走一小步。配置里的数值只是第一次的种子。
 *  这是对依恋研究里"贴近强度从互动史中长出、靠回应维系"的直接落实：
 *  密度与回应把它推近，单方面开口落空把它推远，但底色永远不为零——
 *  她在意他这个事实不随安静消失。 */

const BURST_MS = 5 * 60000; // 与材料层的连发判定同窗：连发的"说"算一次开口。
const ANSWER_MS = 12 * 3600000; // 开口后半天内有回应都算被接住——隔夜回复是常态。
const DRIFT = 0.06; // 每天最多走目标差距的 6%：急不来的东西才像关系。
const FLOOR = 0.15;

function localMidnight(at: number, timeZone: string): number {
  const guess = Date.parse(`${dayKeyOf(at, timeZone)}T00:00:00Z`);
  return guess - minutesOfDay(guess, timeZone) * 60000;
}

/** 配置值只在第一次起作用：之后它就不是旋钮了。 */
export function seedCloseness(journal: Journal, seedPercent: number): void {
  const raw = journal.setting<{ closeness?: number } | undefined>('self', undefined);
  if (raw?.closeness !== undefined) return;
  journal.setSetting('self', { ...journal.self(), closeness: clamp(seedPercent / 100) });
}

/** 每个本地日走一步（幂等：同一天重复调用不再写）。统计对象是"他"——
 *  她只属于一个人；万一存在多个联系人，取昨天互动最多的那位。 */
export function evolveCloseness(journal: Journal, now: number, timeZone: string): void {
  const self = journal.self();
  const day = dayKeyOf(now, timeZone);
  if (self.closenessDay === day) return;
  const from = localMidnight(now, timeZone) - 86_400_000;
  const to = from + 86_400_000;
  const stats = journal
    .peers()
    .map((peer) => ({
      peer,
      events: journal.eventsBetween(peer, ['received', 'said'], from, to, 500),
    }))
    .sort((a, b) => b.events.length - a.events.length);
  const events = stats[0]?.events ?? [];
  const received = events.filter((event) => event.kind === 'received').length;
  const said = events.filter((event) => event.kind === 'said').length;
  const density = clamp((received + said) / 16);
  const reciprocity = received ? clamp(said / received) : 0;
  let initiatives = 0;
  let answered = 0;
  for (let i = 0; i < events.length; i++) {
    const event = events[i]!;
    if (event.kind !== 'said') continue;
    const previous = events[i - 1];
    if (!previous || previous.kind !== 'said' || event.created_at - previous.created_at >= BURST_MS)
      initiatives++;
    if (
      events
        .slice(i + 1)
        .some(
          (later) => later.kind === 'received' && later.created_at - event.created_at <= ANSWER_MS,
        )
    )
      answered++;
  }
  const fallingFlat = initiatives ? 1 - answered / initiatives : 0;
  const target = clamp(0.25 + 0.45 * density + 0.3 * reciprocity - 0.15 * fallingFlat);
  const closeness = clamp(self.closeness + (target - self.closeness) * DRIFT, FLOOR, 1);
  journal.setSetting('self', { ...self, closeness, closenessDay: day });
}
