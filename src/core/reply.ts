import type { MemoryUpdate, OpenLoopInput, ReplyPart, SoftThreadInput } from '../db/index.js';
import { epochOfWallTime } from '../db/index.js';
import {
  MAX_REPLY_PARTS,
  MAX_MEMORY_UPDATES,
  MAX_IMAGE_DESCRIPTIONS,
  OPEN_LOOP_PROMPT_MAX,
  SOFT_THREAD_PROMPT_MAX,
  SOFT_THREAD_REVISIT_DAYS,
  SOFT_THREAD_REVISIT_MAX_DAYS,
} from './constants.js';

/** 回复 JSON 的解析与清洗：气泡（含 beat 停顿与内联表情纠错）、记忆更新、
 *  开环与挂念、心情脉冲。代码做形状校验与来源过滤，语义留给模型。 */

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
  openLoops: OpenLoopInput[];
  resolveLoops: string[];
  /** 缺席（模型没表态）与显式空数组（看过、没问）含义不同：主动提醒的
   *  契约靠这个区分，缺席会被修复轮要求补上。 */
  askedLoops?: string[];
  threads: SoftThreadInput[];
  resolveThreads: string[];
  askedThreads: string[];
  moodPulse?: { valence: number; energy: number; patience?: number; reason?: string };
  /** 本轮进入提示词的记忆 id，运行时据此记演练。 */
  pickedMemoryIds?: string[];
}

/** 容错 JSON 解析：剥代码围栏；带尾随散文时按括号配平截取第一个对象。 */
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
        ...(typeof v.emotion === 'number' &&
        Number.isFinite(v.emotion) &&
        Math.abs(v.emotion) >= 0.05
          ? {
              emotion: Math.max(-1, Math.min(1, v.emotion)),
              ...(typeof v.emotionReason === 'string' && v.emotionReason.trim()
                ? { emotionReason: v.emotionReason.trim().slice(0, 80) }
                : {}),
            }
          : {}),
      },
    ];
  });
}

/** 模型偶尔把历史里的 [来源 id | 时间] 标注抄进输出：行首标注剥除并按
 *  标注切回多个气泡；句中的内联标注就地清除。 */
export function stripSourceAnnotations(text: string): { parts: ReplyPart[]; text: string } {
  if (!/\[来源[^\]]*\]/.test(text)) return { parts: [], text };
  const withoutInline = (value: string) =>
    value
      .replace(/\s*\[来源[^\]]*\]\s*/g, ' ')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();
  const leading = /^\s*\[来源[^\]]*\]/.test(text);
  if (!leading) return { parts: [], text: withoutInline(text) };
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

/** 模型把历史展示格式 [表情：x] 写进文字时：按 slug→含义→标签匹配回目录
 *  真实表情并保持顺序（先文字后表情会颠倒发送顺序）。字符类有界：无界
 *  懒惰量组会让一串未闭合的 [表情： 产生二次方回溯。 */
function splitInlineParts(text: string, stickers: Sticker[]): ReplyPart[] {
  const out: ReplyPart[] = [];
  const pushText = (value: string) => {
    const body = value.trim();
    if (!body) return;
    const last = out.at(-1);
    if (last?.type === 'text') last.text = `${last.text} ${body}`.trim();
    else out.push({ type: 'text', text: body.slice(0, 6000) });
  };
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
  // 输入条数有上限，但一条里的内联表情会各自成段：总帽防止一次输出
  // 变成几十个间隔发送的气泡。
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
      // {"type":"text","text":"…","beat":"short|medium|long"}：模型对节奏的
      // 语义表达，beat 挂到该条拆出的第一个气泡上。
      if (m && typeof m === 'object' && 'type' in m && m.type === 'text' && 'text' in m) {
        const item = m as { text?: unknown; beat?: unknown };
        if (typeof item.text !== 'string' || !item.text.trim()) return [];
        const beat =
          item.beat === 'short' || item.beat === 'medium' || item.beat === 'long'
            ? item.beat
            : undefined;
        const parts = splitInlineParts(item.text, stickers);
        if (beat && parts.length) parts[0] = { ...parts[0]!, beat };
        return parts;
      }
      return [];
    })
    .slice(0, MAX_REPLY_PARTS);
}

/** 模型输出的开环：content+到期时间，来源必须本轮可见（available 缺省时
 *  只做形状校验）。due 接受毫秒时间戳或本地时间字符串。 */
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

/** 无日期挂念：来源校验同开环；revisitAfter 夹紧，模型不能排"300 天后
 *  再问"或"立刻问"。 */
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

/** 解析约定的到期时间：数字时间戳优先；"明天 08:00"/"MM-DD HH:mm"/"HH:mm"
 *  与 ISO 日期按配置时区解析。落在 [now−1d, now+5y] 之外的时间戳是模型
 *  臆造（1970 年或 9999 年），直接拒收。 */
export function resolveDue(
  dueAt: unknown,
  due: unknown,
  now: number,
  timeZone: string,
): number | undefined {
  // 366 天/年：五个日历年至少含一个闰日。
  const sane = (t: number) => t > now - 86400000 && t < now + 5 * 366 * 86400000;
  if (typeof dueAt === 'number' && Number.isFinite(dueAt) && dueAt > 0) {
    return sane(dueAt) ? dueAt : undefined;
  }
  if (typeof due !== 'string' || !due.trim()) return undefined;
  const text = due.trim().replace(/[：]/g, ':');
  // ISO 式绝对日期按配置时区解析，不按进程时区。
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2}))?/.exec(text);
  if (iso) {
    const resolved = epochOfWallTime(
      Number(iso[1]),
      Number(iso[2]),
      Number(iso[3]),
      Number(iso[4] ?? 9),
      Number(iso[5] ?? 0),
      timeZone,
    );
    return Number.isNaN(resolved) ? undefined : sane(resolved) ? resolved : undefined;
  }
  // "明天 08:00" / "大后天 14:30" / 裸 "08:00"（已过则滚到明天）。
  const dayWords: Record<string, number> = { 今天: 0, 明天: 1, 后天: 2, 大后天: 3 };
  // 最长备选在前：否则 "大后天" 的可选组匹配空、尾数字撞上"大"直接失配。
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
  // "09-20 10:00"：今年已过则排到明年。
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
    const thisYear = epochOfWallTime(year, Number(md[1]), Number(md[2]), hour, minute, timeZone);
    if (!Number.isNaN(thisYear) && thisYear > now) return thisYear;
    const nextYear = epochOfWallTime(
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

/** now 起 N 天后的本地墙钟时间（日历运算，跨 DST 不漂一天）。 */
function localWallTime(
  now: number,
  dayOffset: number,
  hour: number,
  minute: number,
  timeZone: string,
): number {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
    .formatToParts(new Date(now))
    .reduce<Record<string, string>>((acc, p) => ({ ...acc, [p.type]: p.value }), {});
  const shifted = new Date(
    Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day) + dayOffset),
  );
  return epochOfWallTime(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth() + 1,
    shifted.getUTCDate(),
    hour,
    minute,
    timeZone,
  );
}

/** 模型自评的心情脉冲：限幅，全零或缺席为 undefined。 */
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
    // 解析不了但有内容的，当纯文本回复——除非它本来就想输出 JSON：
    // "{messages:broken" 这种失败尝试走修复轮才有机会被闭合。判定刻意
    // 收窄：[来源 …] 行也以括号开头但必须走切分，含单个花括号的普通
    // 文本（"她说 {笑} 了一下"）也要放行。
    const blob = text.trim().slice(0, 6000);
    const looksLikeJson = /^(?:\{\s*["}]|\[\s*[\[{"]|```\s*json)/i.test(blob);
    if (blob && !looksLikeJson) {
      // 先切分再清洗：反过来会把切分点洗掉，几段来源块塌成一个气泡。
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
    : undefined;
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
    threads: parseSoftThreads(raw.threads),
    resolveThreads,
    askedThreads,
    ...(askedLoops ? { askedLoops } : {}),
    ...(moodPulse ? { moodPulse } : {}),
  };
}
