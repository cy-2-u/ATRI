import type { Feeling, Recurrence, Self } from './types.ts';

export const clamp = (value: number, min = 0, max = 1): number => Math.min(max, Math.max(min, value));

export interface LocalTime { year: number; month: number; day: number; hour: number; minute: number; second: number }
const formatters = new Map<string, Intl.DateTimeFormat>();
export function localTime(at: number, timezone: string): LocalTime {
  let f = formatters.get(timezone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
    formatters.set(timezone, f);
  }
  const parts = Object.fromEntries(f.formatToParts(at).filter(p => p.type !== 'literal').map(p => [p.type, Number(p.value)]));
  return parts as unknown as LocalTime;
}
const wallStamp = (p: LocalTime): number => Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);

// 校验本地日历时间；不存在的 DST 时间顺延，重复时间选首次。
export function fromLocal(p: LocalTime, timezone: string): number {
  const desired = wallStamp(p);
  const candidates = new Set<number>();
  for (const offset of [-36, -12, 0, 12, 36]) {
    const probe = desired + offset * 3600000;
    const zoneOffset = wallStamp(localTime(probe, timezone)) - probe;
    candidates.add(desired - zoneOffset);
  }
  const exact = [...candidates].filter(c => wallStamp(localTime(c, timezone)) === desired).sort((a, b) => a - b);
  if (exact.length) return exact[0]!;
  const after = [...candidates].filter(c => wallStamp(localTime(c, timezone)) > desired).sort((a, b) => a - b);
  if (after.length) return after[0]!;
  throw new TypeError('无法解析本地时间');
}

export function dayStart(at: number, timezone: string): number {
  return fromLocal({ ...localTime(at, timezone), hour: 0, minute: 0, second: 0 }, timezone);
}
export function dayKey(at: number, timezone: string): string {
  const p = localTime(at, timezone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}
export function minutesOfDay(at: number, timezone: string): number {
  const p = localTime(at, timezone);
  return p.hour * 60 + p.minute;
}

export function instant(value: unknown): number {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 8640000000000000) return value;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) throw new TypeError('时间需要 Unix 毫秒或带 Z/时区偏移的 ISO 时间，不能使用无时区日期');
  const at = Date.parse(value);
  if (!Number.isFinite(at)) throw new TypeError('时间无效');
  const calendar = value.slice(0, 10);
  const [y, m, d] = calendar.split('-').map(Number) as [number, number, number];
  if (m < 1 || m > 12 || d < 1 || d > new Date(Date.UTC(y, m, 0)).getUTCDate()) throw new TypeError('日期不存在');
  return at;
}

export function nextOccurrence(anchor: number, rule: Recurrence, after: number): number {
  if (!['day', 'week', 'month', 'year'].includes(rule.unit) || !Number.isInteger(rule.interval) || rule.interval < 1 || rule.interval > 100) throw new TypeError('重复规则无效');
  const p = localTime(anchor, rule.timezone);
  const make = (n: number): number => {
    if (rule.unit === 'day' || rule.unit === 'week') {
      const d = new Date(Date.UTC(p.year, p.month - 1, p.day + n * rule.interval * (rule.unit === 'week' ? 7 : 1)));
      return fromLocal({ ...p, year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() }, rule.timezone);
    }
    const months = (rule.unit === 'year' ? 12 : 1) * n * rule.interval;
    const d = new Date(Date.UTC(p.year, p.month - 1 + months, 1));
    const y = d.getUTCFullYear(), m = d.getUTCMonth() + 1;
    return fromLocal({ ...p, year: y, month: m, day: Math.min(p.day, new Date(Date.UTC(y, m, 0)).getUTCDate()) }, rule.timezone);
  };
  let low = 1, high = 1;
  while (make(high) <= after && high < 1048576) high *= 2;
  if (make(high) <= after) throw new TypeError('重复时间超出范围');
  while (low < high) { const mid = Math.floor((low + high) / 2); if (make(mid) <= after) low = mid + 1; else high = mid; }
  return make(low);
}

// ---------- 睡眠窗：她的身体 ----------

export function jitteredSleepWindow(day: string, startMin: number, endMin: number): { startMin: number; endMin: number } {
  if (startMin === endMin) return { startMin, endMin };
  let hash = 2166136261;
  for (let i = 0; i < day.length; i++) { hash ^= day.charCodeAt(i); hash = Math.imul(hash, 16777619); }
  const unsigned = hash >>> 0;
  const normalize = (value: number): number => ((value % 1440) + 1440) % 1440;
  // 只抖入睡点，窗口长度守恒：两端独立抖会把短窗翻成跨午夜，睡眠判定大面积反转。
  const length = normalize(endMin - startMin);
  const start = normalize(startMin + ((unsigned % 91) - 45));
  return { startMin: start, endMin: normalize(start + length) };
}

export function inSleepMinutes(minute: number, startMin: number, endMin: number): boolean {
  return startMin === endMin ? false : startMin < endMin ? minute >= startMin && minute < endMin : minute >= startMin || minute < endMin;
}

export function sleepWindow(day: string, startMin: number, endMin: number, arousalMin = 0): { startMin: number; endMin: number } {
  const jittered = jitteredSleepWindow(day, startMin, endMin);
  const start = (((jittered.startMin + Math.max(0, arousalMin)) % 1440) + 1440) % 1440;
  return { startMin: start, endMin: jittered.endMin };
}

/** 唤醒度的事件日归属：夜尾段（早于醒来时刻）的热闹属于前一晚。 */
export function sleepDayKeyOf(at: number, timezone: string, startMin: number, endMin: number): string {
  const day = dayKey(at, timezone);
  const end = jitteredSleepWindow(day, startMin, endMin).endMin;
  return minutesOfDay(at, timezone) < end ? dayKey(at - 12 * 3600000, timezone) : day;
}

/** 当晚 18 点后的每段经历让身体多清醒一会儿，封顶一小时。 */
export function eveningArousalMinutes(events: { at: number }[], day: string, timezone: string): number {
  let lively = 0;
  for (const event of events)
    if (dayKey(event.at, timezone) === day && minutesOfDay(event.at, timezone) >= 1080) lively++;
  return Math.min(60, lively * 6);
}

/** due 落在睡眠窗内就推到窗结束：身体不是闸门，只是那一刻没有"她"。 */
export function nextWakeAfter(due: number, timezone: string, startMin: number, endMin: number, arousalMin = 0): number {
  if (startMin === endMin) return due;
  const { startMin: s, endMin: e } = sleepWindow(dayKey(due, timezone), startMin, endMin, arousalMin);
  const minute = minutesOfDay(due, timezone);
  if (!inSleepMinutes(minute, s, e)) return due;
  let delta = e - minute;
  if (delta <= 0) delta += 1440;
  return due + delta * 60000;
}

// ---------- 自我状态与动机 ----------

export function initialSelf(now: number): Self {
  return {
    closeness: 0.35, closenessDay: '', social: 0.8, expression: 0,
    integratedAt: now, stimulatedAt: now, lastReceivedAt: 0, lastDeliveredAt: 0,
    activity: '', activitySince: now, pursuit: '', pursuitSince: now, interests: [], updatedAt: now,
  };
}

// 时间积分只依赖 integratedAt；修改正在做的事不会吞掉这段时间。
export function projectSelf(state: Self, now: number): Self {
  const hours = Math.max(0, now - state.integratedAt) / 3600000;
  return { ...state, social: clamp(state.social + hours / 6), expression: state.expression * 2 ** (-hours / 2), integratedAt: Math.max(now, state.integratedAt) };
}

export type SelfEvent =
  | { kind: 'received'; at: number }
  | { kind: 'delivered'; at: number }
  | { kind: 'activity'; value: string; at: number }
  | { kind: 'pursuit'; value: string; at: number };

export function evolveSelf(previous: Self, event: SelfEvent): Self {
  const state = projectSelf(previous, event.at);
  switch (event.kind) {
    case 'received':
      return { ...state, social: clamp(state.social - 0.025), stimulatedAt: event.at, lastReceivedAt: event.at };
    case 'delivered':
      return { ...state, social: clamp(state.social - 0.025), expression: state.expression * 0.4, lastDeliveredAt: event.at };
    case 'activity':
      return state.activity === event.value ? state : { ...state, activity: event.value, activitySince: event.at };
    case 'pursuit':
      return state.pursuit === event.value ? state : { ...state, pursuit: event.value, pursuitSince: event.at };
  }
}

export function motives(state: Self, now: number): { boredom: number; longing: number } {
  return {
    boredom: clamp((now - state.stimulatedAt) / (4 * 3600000)),
    longing: state.lastReceivedAt ? clamp((now - state.lastReceivedAt) / (20 * 3600000)) : 0.5,
  };
}

const BURST_MS = 5 * 60000;
const ANSWER_MS = 12 * 3600000;
const DRIFT = 0.06;
const FLOOR = 0.15;

/** 每个本地日走一步：密度与回应推近，开口落空推远，底色永不为零。
 *  events 是昨天的 received/accepted 事件（按时间升序）。 */
export function evolveCloseness(state: Self, events: { kind: string; at: number }[], day: string): Self {
  if (state.closenessDay === day) return state;
  const received = events.filter(e => e.kind === 'received').length;
  const said = events.filter(e => e.kind === 'accepted').length;
  const density = clamp((received + said) / 16);
  const reciprocity = received ? clamp(said / received) : 0;
  let initiatives = 0;
  for (let i = 0; i < events.length; i++) {
    const event = events[i]!;
    if (event.kind !== 'accepted') continue;
    const previous = events[i - 1];
    if (!previous || previous.kind !== 'accepted' || event.at - previous.at >= BURST_MS) initiatives++;
  }
  let answered = 0;
  let nextReceivedAt = Infinity;
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (event.kind === 'received') nextReceivedAt = event.at;
    else if (nextReceivedAt - event.at <= ANSWER_MS) answered++;
  }
  const fallingFlat = initiatives ? 1 - answered / initiatives : 0;
  const target = clamp(0.25 + 0.45 * density + 0.3 * reciprocity - 0.15 * fallingFlat);
  const closeness = clamp(state.closeness + (target - state.closeness) * DRIFT, FLOOR, 1);
  return { ...state, closeness, closenessDay: day };
}

/** 心跳节拍：黏人度越高拍子越短；刚收到消息未接住时短拍警觉；
 *  刚主动开口未获回应时收敛，不追问成轰炸。 */
export function beatDelay(state: Self, now: number, baseMinutes: number, random = Math.random()): number {
  const needs = motives(state, now);
  let minutes = baseMinutes - (baseMinutes - baseMinutes / 5) * clamp(state.closeness);
  if (state.lastReceivedAt > state.lastDeliveredAt && now - state.lastReceivedAt < 15 * 60000) minutes = Math.min(minutes, 5);
  if (state.lastDeliveredAt > state.lastReceivedAt && now - state.lastDeliveredAt < 2 * 3600000) minutes *= 1.35;
  if (Math.max(needs.boredom, needs.longing, state.expression) > 0.75) minutes *= 0.55;
  if (state.social < 0.3) minutes *= 1.6;
  return Math.round(clamp(minutes * (0.75 + clamp(random) * 0.5), 3, 240) * 60000);
}

// ---------- 记忆六变量 ----------

export interface MemoryStrengthPick { importance: number; emotion: number; detail: number; consolidation: number; interference: number; createdAt: number; evaluatedAt: number; lastRehearsedAt: number }

export function projectMemory(memory: MemoryStrengthPick, now: number): MemoryStrengthPick {
  const days = Math.max(0, now - memory.evaluatedAt) / 86400000;
  const rate = 0.12 * (1 - 0.55 * Math.abs(memory.emotion)) * (1 - 0.65 * memory.consolidation) * (1 + 0.9 * memory.interference);
  return {
    ...memory,
    detail: memory.detail * Math.exp(-Math.max(0.005, rate) * days),
    importance: memory.importance * Math.exp(-0.002 * days),
    emotion: memory.emotion * 2 ** (-days / 10),
    evaluatedAt: Math.max(now, memory.evaluatedAt),
  };
}

export function rehearseMemory(memory: MemoryStrengthPick, now: number): MemoryStrengthPick {
  const current = projectMemory(memory, now);
  if (now - memory.lastRehearsedAt < 180 * 60000) return current;
  return { ...current, consolidation: clamp(current.consolidation + 0.15 * (1 - current.consolidation)), lastRehearsedAt: now };
}

// ---------- 情绪呈现 ----------
//
// 脉冲不随时间做数值衰减：陈旧度由材料里的"这是 N 小时前的状态"标注承担
// （v6 语义——衰减加标注是双重折扣）；记忆残留的底色衰减在 emotionalBaseline。

const pick = (variants: string[], at: number): string => variants[Math.floor(at / 60000) % variants.length]!;

/** 心情呈现成中文短句：省 token，也避免她对着数值说话。
 *  基线（记忆情绪残留）只在脉冲缺席或很弱时显形。 */
export function renderMood(mood: Feeling, now: number, baseline = 0): string {
  const hasPulse = !!mood.at && (Math.abs(mood.valence) >= 0.05 || Math.abs(mood.arousal) >= 0.05 || Math.abs(mood.patience) >= 0.05);
  const hasBaseline = Math.abs(baseline) >= 0.12;
  if (!hasPulse && !hasBaseline) return '';
  const parts: string[] = [];
  if (hasPulse) {
    const hours = (now - mood.at) / 3600000;
    const since = hours >= 1 ? `（这是 ${Math.floor(hours)} 小时前的状态，可能已经变了）` : '';
    if (mood.valence >= 0.3) parts.push(pick(['心情还不错，会更想分享', '状态挺好，话也会多一些', '心里挺敞亮的，想找人说说', '今天状态在线，聊兴不错'], mood.at));
    else if (mood.valence <= -0.3) {
      const because = mood.reason ? `（因为${mood.reason}）` : '';
      parts.push(pick([`心情还有些低落${because}`, `还有些低落，没缓过来${because}`, `情绪沉了些，还压着${because}`, `心里有点空落落的${because}`], mood.at));
    } else if (mood.valence <= -0.12) parts.push(pick(['情绪平平，略有点提不起劲', '兴致不太高，有点蔫', '淡淡的，没什么起伏', '有点没劲，懒懒的'], mood.at));
    if (mood.arousal >= 0.4) parts.push(pick(['有点兴奋，心里不太平静', '有点坐不住，静不下来', '心里有点雀跃', '情绪有点上头，想动起来'], mood.at));
    if (mood.patience <= -0.3)
      parts.push(pick(['有点不想应酬了：回得短、少追问，不是生气，只是没力气维持客套；对方真有难处时仍然要好好接住', '有点聊不动了：话少一点、不追问，不是生气；对方真有难处时仍然要好好接住', '这会儿社交电量告急：回复从简，别硬撑客套；对方真有难处时仍然要好好接住', '有点累了，想安静待着：话点到为止；对方真有难处时仍然要好好接住'], mood.at));
    else if (mood.patience >= 0.3) parts.push(pick(['这会儿挺想聊，愿意多问一句', '现在聊兴不错，可以多关心一句', '有耐心听他讲，接得住话', '状态松弛，可以多陪聊几句'], mood.at));
    if (parts.length) parts[parts.length - 1] += since;
  }
  if (hasBaseline && (!hasPulse || Math.abs(mood.valence) < 0.3)) {
    if (baseline < 0) parts.push(pick(['心里有种淡淡的闷，说不上具体原因，不用主动解释它', '莫名有点闷，说不上具体原因，让它待着就好', '有种说不出来源的平静的低气压，带着就好', '心情像蒙了层薄云，不重，但在那儿'], mood.at));
    else parts.push(pick(['莫名有点好心情，像是想起了什么开心的事', '说不清为什么，心里有点亮堂', '有种轻飘飘的愉快，来路不明但挺好', '心里像有风穿过，通透明快'], mood.at));
  }
  return parts.length ? `你当前的状态：${parts.join('；')}。这影响语气，但不要主动报数值。` : '';
}

/** 她最近的心情轨迹：reason 是她自己写的原话，带陈旧度浮回。 */
export function renderMoodTrail(trail: Feeling[], now: number, current?: Feeling): string {
  const parts: string[] = [];
  for (const entry of [...trail].reverse()) {
    if (!entry.reason?.trim()) continue;
    if (current && entry.at === current.at && current.valence <= -0.3) continue;
    const hours = (now - entry.at) / 3600000;
    if (hours >= 18 || hours < 0) continue;
    const age = hours < 1 ? '刚才' : hours < 3 ? '个把小时前' : `${Math.floor(hours)} 小时前`;
    parts.push(`${age}你${entry.reason.trim()}`);
    if (parts.length >= 2) break;
  }
  return parts.length ? `你最近的心情轨迹（这是资料：感觉还在就自然带着，不必解释它从哪来）：${parts.join('；')}。` : '';
}

/** 她此刻的身体状态：深夜与清晨本来就困；今晚熬夜则给"还醒着"的合法通道。 */
export function renderSelfHour(hour: number, bedtimeDelayMinutes = 0): string {
  if (hour >= 1 && hour < 7) {
    if (bedtimeDelayMinutes > 0 && hour < 2 + bedtimeDelayMinutes / 60)
      return '今晚你的身体把入睡往后推了（兴奋的夜）：这个点还醒着是正常的，按此刻真实的困意说话，困了就自然收尾。';
    return '现在是你的深夜，人很困：回复可以短、可以糊、可以只打几个字，也允许明早再回的语气。不必完整接住对方每个话题。';
  }
  if (hour >= 23)
    return bedtimeDelayMinutes > 0
      ? '已经很晚了；今晚你多半会晚点睡（身体还兴奋着）：话可以少一点，收尾自然一点（"我先睡了"是合法回复）。'
      : '已经很晚了，你有点困了：话可以少一点，收尾自然一点（"我先睡了"是合法回复）。';
  if (hour >= 12 && hour < 14) return '是中午，你可能正吃饭或想歇一会儿：忙的话回短一点没关系。';
  return '';
}

export function renderMotives(state: Self, now: number): string {
  const needs = motives(state, now);
  const level = (v: number, low: number, high: number): number => (v < low ? 0 : v < high ? 1 : 2);
  const parts: string[] = [];
  const bored = level(needs.boredom, 0.35, 0.7);
  if (bored === 1) parts.push('有点闲，做事提不起劲');
  if (bored === 2) parts.push('闲得发慌，手机拿起来又放下');
  const miss = level(needs.longing, 0.3, 0.65);
  if (miss === 1) parts.push('有点想念和你说话的时候');
  if (miss === 2) parts.push('很想找你说说话');
  if (state.social <= 0.25) parts.push('社交电量见底，此刻不太想应付任何人——但真正重要的关心仍然要说');
  else if (state.social >= 0.85) parts.push('社交电量满，挺想找人说话');
  if (state.expression >= 0.6) parts.push('心里有话憋着，不吐不快');
  return parts.join('；');
}

export function body(at: number, timezone: string, sleepStart: number, sleepEnd: number): Record<string, unknown> {
  const p = localTime(at, timezone);
  const minute = p.hour * 60 + p.minute;
  const { startMin, endMin } = jitteredSleepWindow(dayKey(at, timezone), sleepStart, sleepEnd);
  const sleepy = inSleepMinutes(minute, startMin, endMin);
  return { local: new Intl.DateTimeFormat('zh-CN', { timeZone: timezone, dateStyle: 'full', timeStyle: 'short' }).format(at), timezone, sleepy, note: sleepy ? '惯常休息时段，是否醒来、何时表达由你决定' : '此刻不在惯常休息时段' };
}

// ---------- 文本工具 ----------

export function grams(text: string): string[] {
  const terms = new Set<string>();
  for (const word of text.toLowerCase().match(/[a-z0-9]+|[\p{Script=Han}]+/gu) ?? []) {
    if (/^[a-z0-9]+$/.test(word) || word.length === 1) terms.add(word);
    else for (let i = 0; i < word.length - 1; i++) terms.add(word.slice(i, i + 2));
  }
  return [...terms];
}

/** 粗略 token 估算：ASCII 约 3 字符/ token，CJK 约 0.74 字/ token。 */
export function estimate(text: string): number {
  let ascii = 0, other = 0;
  for (const char of text) { if (char.codePointAt(0)! < 128) ascii++; else other++; }
  return Math.ceil(ascii / 3 + other * 1.35);
}
