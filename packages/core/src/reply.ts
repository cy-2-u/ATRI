import type { MemoryUpdate, OpenLoopInput, ReplyPart, SoftThreadInput } from '@atri/db';
import {
  MAX_REPLY_PARTS,
  MAX_MEMORY_UPDATES,
  MAX_IMAGE_DESCRIPTIONS,
  OPEN_LOOP_PROMPT_MAX,
  SOFT_THREAD_PROMPT_MAX,
  SOFT_THREAD_REVISIT_DAYS,
  SOFT_THREAD_REVISIT_MAX_DAYS,
} from './constants.js';
export interface Sticker {
  slug: string;
  description: string;
  tags: string[];
  file: string;
}
export interface ParsedReply {
  parts: ReplyPart[];
  memories: MemoryUpdate[];
  descriptions: { messageId: string; description: string }[];
  /** Arrangements to remember and ask about later ("明天面试"). */
  openLoops: OpenLoopInput[];
  /** Loop IDs the user just answered, closing them. */
  resolveLoops: string[];
  /** Loop IDs this reply actually brought up, so only those are marked asked. */
  askedLoops: string[];
  /** Undated concerns or promises to revisit when the topic naturally allows. */
  threads: SoftThreadInput[];
  /** Thread IDs that are settled, or that the user explicitly dropped. */
  resolveThreads: string[];
  /** Thread IDs this reply actually brought up. */
  askedThreads: string[];
  /** Optional self-assessed mood pulse for this exchange. */
  moodPulse?: { valence: number; energy: number; patience?: number; reason?: string };
  /** Memory IDs included in this turn's prompt; the runtime marks them used. */
  pickedMemoryIds?: string[];
}
export function parseJson(text: string): any {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('{');
    if (start < 0) throw new Error('模型输出不是有效 JSON');
    // Scan for the matching brace instead of taking the last '}' in the string:
    // with trailing prose ("{...} 后面还有 {...}") lastIndexOf spliced both
    // objects together and the parse failed on otherwise valid output.
    let depth = 0,
      inString = false,
      escaped = false;
    for (let i = start; i < cleaned.length; i++) {
      const ch = cleaned[i]!;
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (!depth) return JSON.parse(cleaned.slice(start, i + 1));
      }
    }
    throw new Error('模型输出不是有效 JSON');
  }
}
export function parseMemories(value: unknown): MemoryUpdate[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_MEMORY_UPDATES).flatMap((v) => {
    if (
      !v ||
      typeof v.content !== 'string' ||
      !Array.isArray(v.sources) ||
      !['stated', 'interpretation'].includes(v.kind)
    )
      return [];
    return [
      {
        content: v.content.slice(0, 800),
        kind: v.kind,
        sources: v.sources.filter((s: unknown) => typeof s === 'string').slice(0, 20),
        supersedes: Array.isArray(v.supersedes)
          ? v.supersedes.filter((s: unknown) => typeof s === 'string').slice(0, 12)
          : [],
        ...(typeof v.importance === 'number' && Number.isFinite(v.importance)
          ? { importance: Math.max(0, Math.min(1, v.importance)) }
          : {}),
      },
    ];
  });
}
/**
 * Models sometimes copy the "[来源 id | time]" annotation from rendered history
 * into their output. Strip leading annotation lines, and when one text blob
 * carries several of them, split it back into separate bubbles the way the
 * model was supposed to emit them via the messages array.
 */
export function stripSourceAnnotations(text: string): { parts: ReplyPart[]; text: string } {
  if (!/\[来源[^\]]*\]/.test(text)) return { parts: [], text };
  // Strip annotations wherever they appear, not only at the very start. A
  // mid-sentence "[来源 …]" used to survive into the outgoing WeChat message.
  const withoutInline = (value: string) =>
    value
      .replace(/\s*\[来源[^\]]*\]\s*/g, ' ')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();
  const leading = /^\s*\[来源[^\]]*\]/.test(text);
  if (!leading) return { parts: [], text: withoutInline(text) };
  // Leading annotations usually mark separate recalled blocks; preserve the
  // existing split into bubbles. The old code compared the whole string with
  // its prefix-stripped copy, so an inline annotation later in the same text
  // skipped this path entirely.
  const withoutPrefix = text.replace(/^\s*\[来源[^\]]*\]\s*\n?/g, '');
  const chunks = withoutPrefix
    .split(/\s*\[来源[^\]]*\]\s*/g)
    .map((c) => c.trim())
    .filter(Boolean);
  if (chunks.length <= 1) return { parts: [], text: withoutInline(chunks[0] ?? '') };
  return {
    parts: chunks.slice(0, MAX_REPLY_PARTS).map((c) => ({ type: 'text' as const, text: c })),
    text: '',
  };
}
/**
 * Models copy the "[表情：x]" rendering they see in history instead of emitting
 * the JSON sticker object. Match such text against the catalog by slug first,
 * then by description/tag words, and convert hits into real sticker parts while
 * preserving source order: the old extractor returned all stickers separately,
 * so normalizeTextParts put every sticker before every line of text and
 * "哈哈[表情]收到" arrived backwards.
 */
function splitInlineParts(text: string, stickers: Sticker[]): ReplyPart[] {
  const out: ReplyPart[] = [];
  const pushText = (value: string) => {
    const body = value.trim();
    if (!body) return;
    const last = out.at(-1);
    if (last?.type === 'text') last.text = `${last.text} ${body}`.trim();
    else out.push({ type: 'text', text: body.slice(0, 6000) });
  };
  // The inner character class is bounded: an unbounded lazy quantifier plus the
  // two \s* groups made a run of unclosed "[表情：" backtrack quadratically
  // (19k chars took 619 ms, on the event loop, freezing every peer). A sticker
  // name is never near 40 characters, so the cap costs nothing.
  const re = /(\s*)[(\[{【]\s*(?:表情|sticker)\s*[：:]\s*([^\]】)}]{1,40}?)\s*[\]】)}](\s*)/gi;
  let cursor = 0;
  for (;;) {
    const match = re.exec(text);
    if (!match) break;
    pushText(text.slice(cursor, match.index) + (match[1] ?? ''));
    const query = (match[2] ?? '').trim().toLowerCase();
    const bySlug = query ? stickers.find((s) => s.slug.toLowerCase() === query) : undefined;
    const byDescription = query
      ? stickers.find(
          (s) =>
            s.description.toLowerCase().includes(query) ||
            (s.tags ?? []).some((t) => t.toLowerCase() === query),
        )
      : undefined;
    const byTag = query
      ? stickers.find((s) =>
          (s.tags ?? []).some(
            (t) => query.includes(t.toLowerCase()) || t.toLowerCase().includes(query),
          ),
        )
      : undefined;
    const sticker = bySlug ?? byDescription ?? byTag;
    if (sticker)
      out.push({ type: 'sticker', slug: sticker.slug, description: sticker.description });
    cursor = match.index + match[0].length;
  }
  pushText(text.slice(cursor));
  return out;
}
function normalizeTextParts(raw: unknown[], stickers: Sticker[]): ReplyPart[] {
  // The slice bounds how many input messages are read, but one message can hold
  // many inline stickers and each becomes its own part. Without the final cap a
  // 6-message reply produced 66 bubbles, and the sender paces every bubble
  // 400–2500 ms apart — a minute of spam from one model output.
  return raw
    .slice(0, MAX_REPLY_PARTS)
    .flatMap<ReplyPart>((m: unknown) => {
      if (typeof m === 'string' && m.trim()) {
        const head = stripSourceAnnotations(m);
        const segments = head.parts.length
          ? head.parts.flatMap((p) => (p.type === 'text' && p.text ? [p.text] : []))
          : [head.text];
        return segments.flatMap<ReplyPart>((segment) => splitInlineParts(segment, stickers));
      }
      if (m && typeof m === 'object' && 'type' in m && m.type === 'sticker' && 'slug' in m) {
        const slug = m.slug;
        if (typeof slug !== 'string') return [];
        const sticker = stickers.find((s) => s.slug === slug);
        if (sticker)
          return [
            { type: 'sticker' as const, slug: sticker.slug, description: sticker.description },
          ];
      }
      return [];
    })
    .slice(0, MAX_REPLY_PARTS);
}
/** Open-loop entries from the model: content plus a due time. When `available`
 *  is given, every source ID must be visible this turn; without it (final JSON
 *  parsing inside the tool loop) only the shape is validated. `due` accepts a
 *  millisecond timestamp or a local-time string resolved by `resolveDue`. */
export function parseOpenLoops(
  value: unknown,
  available?: Set<string>,
  now = Date.now(),
  timeZone = 'Asia/Shanghai',
): OpenLoopInput[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, OPEN_LOOP_PROMPT_MAX).flatMap((v) => {
    if (!v || typeof v.content !== 'string' || !v.content.trim()) return [];
    const sources = Array.isArray(v.sources)
      ? v.sources.filter((s: unknown): s is string => typeof s === 'string')
      : [];
    if (!sources.length) return [];
    if (available && !sources.every((id: string) => available.has(id))) return [];
    const dueAt = resolveDue(v.dueAt, v.due, now, timeZone);
    if (dueAt === undefined) return [];
    return [
      {
        content: v.content.slice(0, 300),
        dueAt,
        dueText: typeof v.dueText === 'string' ? v.dueText.slice(0, 60) : '',
        sources: sources.slice(0, 10),
        ...(v.recurring === 'yearly' ? { recurring: 'yearly' as const } : {}),
      },
    ];
  });
}
/** Undated soft threads: things worth keeping in mind without a due date.
 *  Sources are validated the same way as open loops; `revisitAfter` is clamped
 *  so a model cannot schedule "ask in 300 days" or "ask immediately". */
export function parseSoftThreads(value: unknown, available?: Set<string>): SoftThreadInput[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, SOFT_THREAD_PROMPT_MAX).flatMap((v) => {
    if (!v || typeof v.content !== 'string' || !v.content.trim()) return [];
    const sources = Array.isArray(v.sources)
      ? v.sources.filter((s: unknown): s is string => typeof s === 'string')
      : [];
    if (!sources.length) return [];
    if (available && !sources.every((id: string) => available.has(id))) return [];
    const days = Number(v.revisitAfter);
    const revisitAfter = Number.isFinite(days)
      ? Math.min(SOFT_THREAD_REVISIT_MAX_DAYS, Math.max(1, Math.round(days)))
      : SOFT_THREAD_REVISIT_DAYS;
    return [
      {
        content: v.content.slice(0, 300),
        kind: v.kind === 'promise' ? ('promise' as const) : ('concern' as const),
        revisitAfter,
        sources: sources.slice(0, 10),
      },
    ];
  });
}
/** Resolve a loop's due time: numeric timestamps win; "明天 08:00", "MM-DD HH:mm",
 *  "HH:mm" or ISO strings are interpreted in the configured local timezone.
 *  Any resolved time outside [now − 1d, now + 5y] is rejected: schema-valid
 *  timestamps like year-1970 or year-9999 pass JSON checks but are semantic
 *  garbage the model invented. */
export function resolveDue(
  dueAt: unknown,
  due: unknown,
  now: number,
  timeZone: string,
): number | undefined {
  // 366 (not 365) days per year: five calendar years span at least one leap day,
  // so a legitimate date near the end of the window was rejected as insane.
  const sane = (t: number) => t > now - 86400000 && t < now + 5 * 366 * 86400000;
  if (typeof dueAt === 'number' && Number.isFinite(dueAt) && dueAt > 0) {
    return sane(dueAt) ? dueAt : undefined;
  }
  if (typeof due !== 'string' || !due.trim()) return undefined;
  const text = due.trim().replace(/[：]/g, ':');
  // ISO-style absolute dates are parsed in the *configured* zone, not the
  // process zone: Date.parse treats "2027-01-05 08:00" as local and
  // "2027-01-05" as UTC, so a server whose TZ differs from the app timeZone
  // shifted every such plan by the offset.
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2}))?/.exec(text);
  if (iso) {
    const resolved = localWallTimeFromYMD(
      Number(iso[1]),
      Number(iso[2]),
      Number(iso[3]),
      Number(iso[4] ?? 9),
      Number(iso[5] ?? 0),
      timeZone,
    );
    return Number.isNaN(resolved) ? undefined : sane(resolved) ? resolved : undefined;
  }
  // "明天 08:00" / "后天 14:30" / bare "08:00" — optional day word plus
  // local wall time; a bare time that already passed rolls to tomorrow.
  const dayWords: Record<string, number> = { 今天: 0, 明天: 1, 后天: 2, 大后天: 3 };
  // Longest alternative first: with 后天 ahead of 大后天 the alternation matched
  // the optional group to nothing, the trailing digits then failed on "大", and
  // every "大后天" plan was silently dropped.
  const dayMatch = /^(大后天|今天|明天|后天)?\s*(\d{1,2})(?::(\d{2}))?$/.exec(text);
  if (dayMatch) {
    const named = !!dayMatch[1];
    const offset = dayMatch[1] ? dayWords[dayMatch[1]!]! : 0;
    const hour = Number(dayMatch[2]),
      minute = Number(dayMatch[3] ?? 0);
    if (hour > 23 || minute > 59) return undefined;
    const sameDay = localWallTime(now, offset, hour, minute, timeZone);
    if (named || sameDay > now) return sameDay;
    return localWallTime(now, offset + 1, hour, minute, timeZone);
  }
  // "09-20 10:00" this year, roll to next year when already past.
  const md = /^(\d{1,2})-(\d{1,2})(?:\s+(\d{1,2})(?::(\d{2}))?)?$/.exec(text);
  if (md) {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .formatToParts(new Date(now))
      .reduce<Record<string, string>>((acc, p) => ({ ...acc, [p.type]: p.value }), {});
    const year = Number(parts.year);
    const hour = Number(md[3] ?? 9),
      minute = Number(md[4] ?? 0);
    if (hour > 23 || minute > 59) return undefined;
    const thisYear = localWallTimeFromYMD(
      year,
      Number(md[1]),
      Number(md[2]),
      hour,
      minute,
      timeZone,
    );
    // A date already behind us is the next occurrence, not an expired plan.
    if (!Number.isNaN(thisYear) && thisYear > now) return thisYear;
    const nextYear = localWallTimeFromYMD(
      year + 1,
      Number(md[1]),
      Number(md[2]),
      hour,
      minute,
      timeZone,
    );
    return Number.isNaN(nextYear) ? undefined : nextYear;
  }
  return undefined;
}
/** Milliseconds for a local wall-clock time N days from `now` in `timeZone`. */
function localWallTime(
  now: number,
  dayOffset: number,
  hour: number,
  minute: number,
  timeZone: string,
): number {
  // Calendar arithmetic in UTC, not `now + dayOffset * 86400000`: adding a fixed
  // 24 hours per day lands on the wrong local date across a DST transition, so
  // "明天 08:00" resolved to the day after tomorrow in any zone with DST.
  const parts = wallDateFormatter(timeZone)
    .formatToParts(new Date(now))
    .reduce<Record<string, string>>((acc, p) => ({ ...acc, [p.type]: p.value }), {});
  const shifted = new Date(
    Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day) + dayOffset),
  );
  return localWallTimeFromYMD(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth() + 1,
    shifted.getUTCDate(),
    hour,
    minute,
    timeZone,
  );
}
const wallDateFormatters = new Map<string, Intl.DateTimeFormat>();
function wallDateFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = wallDateFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    wallDateFormatters.set(timeZone, formatter);
  }
  return formatter;
}
const offsetFormatters = new Map<string, Intl.DateTimeFormat>();
function offsetFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = offsetFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-GB', { timeZone, timeZoneName: 'longOffset' });
    offsetFormatters.set(timeZone, formatter);
  }
  return formatter;
}
function localWallTimeFromYMD(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): number {
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day) ||
    !Number.isInteger(hour) ||
    !Number.isInteger(minute) ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59
  )
    return NaN;
  // Date.parse normalizes 2026-02-30 into March 2, so round-trip the calendar
  // date and reject any day that does not exist.
  const calendar = new Date(Date.UTC(year, month - 1, day));
  if (
    calendar.getUTCFullYear() !== year ||
    calendar.getUTCMonth() !== month - 1 ||
    calendar.getUTCDate() !== day
  )
    return NaN;
  const utc = Date.parse(
    `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00Z`,
  );
  if (Number.isNaN(utc)) return NaN;
  // The zone offset at that wall time (two probes cover DST boundaries):
  // local = UTC + offset, so the epoch is utc - offset.
  const formatter = offsetFormatter(timeZone);
  let result = utc;
  for (let i = 0; i < 2; i++) {
    const name = formatter
      .formatToParts(new Date(result))
      .find((p) => p.type === 'timeZoneName')!.value;
    const match = /GMT([+-])(\d{2}):?(\d{2})?/.exec(name);
    const sign = match?.[1] === '-' ? -1 : 1;
    const hh = Number(match?.[2] ?? 0),
      mm = Number(match?.[3] ?? 0);
    result = utc - sign * (hh * 3600000 + mm * 60000);
  }
  return result;
}
/** Model self-assessed mood pulse, clamped; undefined when absent or invalid. */
export function parseMoodPulse(
  value: unknown,
): { valence: number; energy: number; patience?: number; reason?: string } | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const v = value as Record<string, unknown>;
  const clamp = (n: unknown) =>
    typeof n === 'number' && Number.isFinite(n) ? Math.max(-1, Math.min(1, n)) : 0;
  const valence = clamp(v.valence);
  const energy = clamp(v.energy);
  const patience = clamp(v.patience);
  if (!valence && !energy && !patience) return undefined;
  return {
    valence,
    energy,
    ...(patience ? { patience } : {}),
    ...(typeof v.reason === 'string' && v.reason.trim() ? { reason: v.reason.slice(0, 60) } : {}),
  };
}
export function parseReply(
  text: string,
  stickers: Sticker[],
  allowSkip = false,
  timeZone = 'Asia/Shanghai',
): ParsedReply {
  let raw: any;
  try {
    raw = parseJson(text);
  } catch {
    // Any blob that does not parse is treated as a plain-text reply as long as
    // it has content — but only when it was not *meant* to be JSON. A blob that
    // opens like an object or a JSON array is a failed JSON attempt: falling
    // back to prose shipped `{"messages":broken}` to the user verbatim, and only
    // the repair round can close a truncated object. The check is deliberately
    // narrow: a "[来源 …]" annotation line also opens with a bracket, and that
    // one must still reach the splitter below. Prose that merely *contains* a
    // brace ("她说 {笑} 了一下") falls through too.
    const blob = text.trim().slice(0, 6000);
    const looksLikeJson = /^(?:\{\s*["}]|\[\s*[\[{"]|```\s*json)/i.test(blob);
    if (blob && !looksLikeJson) {
      // Split first, then clean each chunk. Doing it the other way round threw
      // away the split points: stripSourceAnnotations only splits when the input
      // still starts with an annotation, so after one pass the remaining three
      // source blocks collapsed into a single bubble.
      const annotated = stripSourceAnnotations(blob);
      const blocks = annotated.parts.length
        ? annotated.parts.map((p) => p.text ?? '')
        : annotated.text
          ? [annotated.text]
          : [];
      const all: ReplyPart[] = [];
      for (const block of blocks) all.push(...splitInlineParts(block, stickers));
      if (!all.length) throw new Error('回复没有有效内容');
      return {
        parts: all.slice(0, MAX_REPLY_PARTS),
        memories: [],
        descriptions: [],
        openLoops: [],
        resolveLoops: [],
        askedLoops: [],
        threads: [],
        resolveThreads: [],
        askedThreads: [],
      };
    }
    throw new Error('回复格式无效');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('回复不是 JSON 对象');
  if (!Array.isArray(raw.messages)) throw new Error('回复缺少 messages 数组');
  const parts = normalizeTextParts(raw.messages, stickers);
  if (!parts.length && !(allowSkip && raw.messages.length === 0))
    throw new Error('回复没有有效内容');
  const descriptions = Array.isArray(raw.imageDescriptions)
    ? raw.imageDescriptions
        .filter((d: any) => typeof d?.messageId === 'string' && typeof d?.description === 'string')
        .slice(0, MAX_IMAGE_DESCRIPTIONS)
        .map((d: any) => ({ messageId: d.messageId, description: d.description.slice(0, 800) }))
    : [];
  const resolveLoops = Array.isArray(raw.resolveLoops)
    ? raw.resolveLoops
        .filter((s: unknown): s is string => typeof s === 'string')
        .slice(0, OPEN_LOOP_PROMPT_MAX)
    : [];
  const askedLoops = Array.isArray(raw.askedLoops)
    ? raw.askedLoops
        .filter((s: unknown): s is string => typeof s === 'string')
        .slice(0, OPEN_LOOP_PROMPT_MAX)
    : [];
  const resolveThreads = Array.isArray(raw.resolveThreads)
    ? raw.resolveThreads
        .filter((s: unknown): s is string => typeof s === 'string')
        .slice(0, SOFT_THREAD_PROMPT_MAX)
    : [];
  const askedThreads = Array.isArray(raw.askedThreads)
    ? raw.askedThreads
        .filter((s: unknown): s is string => typeof s === 'string')
        .slice(0, SOFT_THREAD_PROMPT_MAX)
    : [];
  const moodPulse = parseMoodPulse(raw.moodPulse);
  return {
    parts,
    memories: parseMemories(raw.memoryUpdates),
    descriptions,
    openLoops: parseOpenLoops(raw.openLoops, undefined, Date.now(), timeZone),
    resolveLoops,
    askedLoops,
    threads: parseSoftThreads(raw.threads),
    resolveThreads,
    askedThreads,
    ...(moodPulse ? { moodPulse } : {}),
  };
}
