import type { Message, Store, Task, SearchHit, MemoryUpdate, OpenLoop, SoftThread } from '@atri/db';
import type { Model, ModelMessage, ToolDefinition, Completion } from '@atri/llm';
import { ModelError, estimateRequestTokens, estimateTextTokens, trimToTokens } from '@atri/llm';
import { hourFormatter } from '@atri/db';
import {
  parseJson,
  parseMemories,
  parseOpenLoops,
  parseReply,
  parseSoftThreads,
  type Sticker,
  type ParsedReply,
} from './reply.js';
import type { WebTools } from './web.js';
import {
  RECALL_QUERY_MESSAGES,
  RECALL_QUERY_MAX_CHARS,
  RECALL_HITS,
  RECALL_CANDIDATES,
  RECALL_PROTECT,
  RECALL_RARE_TERM_SHARE,
  RECALL_RARE_TERM_MIN_DF,
  RECALL_MIN_SEMANTIC,
  PROMPT_MEMORIES,
  MEMORY_COOLDOWN_CORE,
  MEMORY_HIT_COOLDOWN_MINUTES,
  RECALL_CONTENT_MAX_CHARS,
  MEMORY_CONTENT_MAX_CHARS,
  PROMPT_STICKERS,
  TOOL_RESERVE_MAX_TOKENS,
  CONTEXT_FLEX_FRACTION,
  PROMPT_HEADROOM_TOKENS,
  MAX_TOOL_ROUNDS,
  MAX_TOOL_CALLS,
  MAX_REPLY_ATTEMPTS,
  TOOL_RESULT_BUDGET_TOKENS,
  STICKER_RECENT_SHOWN,
  SILENCE_NOTIFY_MINUTES,
  SILENCE_HOURS_THRESHOLD,
  DIARY_GAP_MIN_DAYS,
  DIARY_GAP_LOOKBACK_DAYS,
  DIARY_GAP_MAX_SECTIONS,
  DIARY_GAP_MAX_TOKENS,
  NOTES_MAX_TOKENS,
  HISTORY_RESERVE_SHARE,
  PROMPT_NOTES_SHARE,
  PROMPT_MEMORY_SHARE,
  PROMPT_RECALL_SHARE,
  PROMPT_MEMORY_MAX_TOKENS,
  PROMPT_RECALL_MAX_TOKENS,
  RHYTHM_MIN_BUCKET,
  RHYTHM_PEAK_BUCKETS,
  DIARY_MAX_SECTIONS,
  OPEN_LOOP_PROMPT_MAX,
} from './constants.js';

export type PromptName = 'persona' | 'chat' | 'diary' | 'context_notes';
export interface AgentOptions {
  store: Store;
  model: () => Model;
  prompt: (name: PromptName) => string;
  /** Persona text for a given peer; falls back to prompt('persona') when absent. */
  personaFor?: (peerId: string) => string;
  stickers: () => Sticker[];
  web: WebTools;
  timeZone: () => string;
  contextTokens: () => number;
  turnTimeoutMs: () => number;
  images?: (message: Message, signal?: AbortSignal) => Promise<string[]>;
  /** Optional semantic search support; when absent, search stays lexical. */
  embedQuery?: (query: string, signal?: AbortSignal) => Promise<Float32Array | undefined>;
  /** Name of the embedding model behind embedQuery, so stored vectors from a
   *  different model are excluded from semantic recall instead of being
   *  cosine-compared into plausible-looking garbage. */
  embeddingModel?: () => string;
  /** Optional operator-controlled code sandbox. When absent, or when it reports
   *  itself disabled, its tools are neither advertised nor dispatchable. */
  sandbox?: SandboxTools;
}
export interface SandboxTools {
  enabled: boolean;
  run(
    command: string,
    signal: AbortSignal,
  ): Promise<{
    ok: boolean;
    code: number | null;
    stdout: string;
    stderr: string;
    truncated: boolean;
    durationMs: number;
  }>;
  write(path: string, content: string): Promise<{ bytes: number; path: string }>;
  read(path: string): Promise<{ content: string; path: string }>;
  list(
    path: string,
  ): Promise<{ path: string; entries: { name: string; kind: string; size: number }[] }>;
}
const object = (properties: Record<string, unknown>, required: string[]) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
const string = { type: 'string' };
export const INFO_TOOLS: ToolDefinition[] = [
  {
    name: 'search_memory',
    description: '搜索当前联系人的记忆、日记和原始对话。换个关键词可继续寻找。',
    parameters: object(
      { query: string, kind: { type: 'string', enum: ['message', 'memory', 'diary'] } },
      ['query'],
    ),
  },
  {
    name: 'read_history',
    description: '按搜索或上下文给出的来源 ID 读取完整片段及相邻原话。',
    parameters: object({ ids: { type: 'array', items: string, maxItems: 8 } }, ['ids']),
  },
  {
    name: 'web_search',
    description: '查询最新公开信息，返回真实来源及时间。',
    parameters: object(
      { query: string, freshness: { type: 'string', enum: ['d', 'w', 'm', 'y'] } },
      ['query'],
    ),
  },
  {
    name: 'open_page',
    description: '读取公开网页原文，核实搜索摘要中的信息。',
    parameters: object({ url: string }, ['url']),
  },
];

/** Tools only offered when the operator has switched the sandbox on. They are
 *  kept out of the default schema so a disabled sandbox costs no prompt tokens
 *  and cannot be reached even if the model hallucinates a call to it. */
export const SANDBOX_TOOLS: ToolDefinition[] = [
  {
    name: 'run_command',
    description:
      '在一个独立的工作目录里执行一条 shell 命令（Linux 基础命令、node 均可）。' +
      '没有时间限制也没有输出长度限制，可以放心跑长时间的编译、数据处理脚本。' +
      '每次调用都是独立的一次执行，上一次留下的文件会保留在同一个目录里。',
    parameters: object({ command: { type: 'string', maxLength: 4000 } }, ['command']),
  },
  {
    name: 'write_file',
    description:
      '把一段文本写进沙箱目录里的文件（自动创建父目录）。内容长度不限，但受沙箱大小上限约束。',
    parameters: object({ path: { type: 'string', maxLength: 200 }, content: { type: 'string' } }, [
      'path',
      'content',
    ]),
  },
  {
    name: 'read_file',
    description: '读取沙箱目录里某个文件的内容。',
    parameters: object({ path: { type: 'string', maxLength: 200 } }, ['path']),
  },
  {
    name: 'list_files',
    description: '列出沙箱目录里的文件和子目录，用来确认上一步到底写进去了什么。',
    parameters: object({ path: { type: 'string', maxLength: 200 } }, []),
  },
];
const sourceFormatters = new Map<string, Intl.DateTimeFormat>();
function sourceFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = sourceFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('zh-CN', {
      timeZone,
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    sourceFormatters.set(timeZone, formatter);
  }
  return formatter;
}
const momentFormatters = new Map<string, Intl.DateTimeFormat>();
function momentFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = momentFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('zh-CN', {
      timeZone,
      dateStyle: 'full',
      timeStyle: 'short',
    });
    momentFormatters.set(timeZone, formatter);
  }
  return formatter;
}
/** Timezone is provided by the host config; tests use Asia/Shanghai by default. */
export function renderMessage(m: Message, timeZone = 'Asia/Shanghai'): string {
  const media = m.media
    .map((a) => (a.description ? `[${a.kind}，模型观察：${a.description}]` : `[收到${a.kind}附件]`))
    .join('\n');
  const at = sourceFormatter(timeZone).format(new Date(m.created_at));
  return `[来源 ${m.id} | ${at}]\n${m.content}${media ? '\n' + media : ''}`;
}
/** When the silence this turn is interrupting actually started.
 *
 *  Comparing `now` against the newest message is always ~0 in a reply turn —
 *  the newest message *is* the trigger — so every reply after a long absence
 *  used to read as "是连续聊天". The informative gap starts at whatever was
 *  said before the incoming burst: walk back over messages that arrived
 *  back-to-back (the debounce batches them) and report the one before that. */
export function silenceBasis(
  history: { role: string; created_at: number }[],
  proactive: boolean,
): number | undefined {
  if (!history.length) return undefined;
  // A proactive ping answers the user's silence, not the assistant's: her own
  // pings sit inside the gap and would otherwise collapse it to minutes.
  if (proactive) return [...history].reverse().find((m) => m.role === 'user')?.created_at;
  let i = history.length - 1;
  while (i > 0 && history[i]!.created_at - history[i - 1]!.created_at < BURST_WINDOW_MS) i--;
  return i > 0 ? history[i - 1]!.created_at : undefined;
}
/** Messages closer together than this belong to one incoming burst. */
const BURST_WINDOW_MS = 5 * 60000;
/** Time-awareness: how the current moment relates to the last message. */
export function renderTimeGap(now: number, lastAt: number, timeZone: string): string {
  const gapMs = Math.max(0, now - lastAt);
  const minutes = Math.floor(gapMs / 60000);
  const moment = `现在是${momentFormatter(timeZone).format(new Date(now))}`;
  if (gapMs < SILENCE_NOTIFY_MINUTES * 60000)
    // Ceiling, not floor: an actual gap of 29.5 minutes is not "不到 29 分钟",
    // and a 30-second gap is "不到 1 分钟", not "不到 2 分钟".
    return `${moment}（距上一条消息不到 ${Math.max(1, Math.ceil(gapMs / 60000))} 分钟，是连续聊天）`;
  if (gapMs < 24 * 3600000) {
    const hours = Math.floor(gapMs / 3600000);
    const text = hours >= 1 ? `${hours} 小时` : `${minutes} 分钟`;
    const note = gapMs >= SILENCE_HOURS_THRESHOLD * 3600000 ? '，中间有一段明显的空白' : '';
    return `${moment}（距上一条消息约 ${text}${note}）`;
  }
  // Calendar days, not 24h blocks: Mon 23:00 → Wed 00:30 should read as
  // "隔了两天" — what a person would say — not "已有 1 天".
  const days = Math.max(1, calendarDays(lastAt, now, timeZone));
  return `${moment}（距上一条消息已有 ${days} 天，中间没有聊过天）`;
}
const dayDiffFormatters = new Map<string, Intl.DateTimeFormat>();
/** Local calendar date (YYYY-MM-DD) in the given zone. */
function dayKey(at: number, timeZone: string): string {
  let formatter = dayDiffFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    dayDiffFormatters.set(timeZone, formatter);
  }
  return formatter.format(new Date(at));
}
function calendarDays(from: number, to: number, timeZone: string): number {
  const day = (at: number) => Date.parse(dayKey(at, timeZone) + 'T00:00:00Z');
  return Math.round((day(to) - day(from)) / 86400000);
}
export interface RecentStickerUse {
  slug: string;
  at: number;
}
/** Extract recently sent stickers from assistant history for anti-repetition.
 *  History stores the sticker as `[表情：description]`, so the captured text is
 *  resolved back to its catalog slug here — comparing descriptions against
 *  slugs would never match and the filter would silently do nothing. */
export function recentStickerUse(history: Message[], stickers: Sticker[] = []): RecentStickerUse[] {
  const byName = new Map<string, string>();
  for (const s of stickers) {
    byName.set(s.slug.toLowerCase(), s.slug);
    byName.set(s.description.toLowerCase(), s.slug);
    for (const tag of s.tags ?? []) byName.set(tag.toLowerCase(), s.slug);
  }
  // Walking backwards and keeping the first hit per slug gives each sticker its
  // *latest* use. The previous forward pass recorded the first appearance, so a
  // sticker sent again after 20 others was still reported with its old
  // timestamp — or dropped from the tail-sliced window entirely, which put a
  // just-sent sticker back in the prompt's fresh half.
  const uses: RecentStickerUse[] = [];
  const seen = new Set<string>();
  for (let i = history.length - 1; i >= 0 && uses.length < STICKER_RECENT_SHOWN; i--) {
    const m = history[i]!;
    if (m.role !== 'assistant') continue;
    for (const match of m.content.matchAll(/\[表情：([^】\]]+?)\]/g)) {
      const name = match[1]!.trim();
      const slug = byName.get(name.toLowerCase());
      // Unresolvable names are skipped rather than stored as pseudo-slugs: a
      // bogus entry would only make the prompt's "recently sent" list lie.
      if (!slug || seen.has(slug)) continue;
      seen.add(slug);
      uses.push({ slug, at: m.created_at });
      if (uses.length >= STICKER_RECENT_SHOWN) break;
    }
  }
  return uses.reverse();
}
/** Mood as felt prose, never numbers — the model reads a state, not a gauge. */
export function renderMood(
  mood: { valence: number; energy: number; patience?: number; reason?: string; at: number },
  now: number,
): string {
  if (!mood.at) return '';
  const patience = mood.patience ?? 0;
  // Neutral in every axis is fine; the guard used to require both of the
  // original axes, which hid a tired-but-cheerful state behind the sign fix.
  if (Math.abs(mood.valence) < 0.05 && Math.abs(mood.energy) < 0.05 && Math.abs(patience) < 0.05)
    return '';
  const hours = (now - mood.at) / 3600000;
  // Staleness applies to any state: "有点累了" left over from three nights ago
  // must not read as current tiredness.
  const since = hours >= 1 ? `（这是 ${Math.floor(hours)} 小时前的状态，可能已经变了）` : '';
  const parts: string[] = [];
  if (mood.valence >= 0.3) parts.push('心情还不错，会更想分享');
  else if (mood.valence <= -0.3)
    parts.push(`心情还有些低落${mood.reason ? `（因为${mood.reason}）` : ''}`);
  else if (mood.valence <= -0.12) parts.push('情绪平平，略有点提不起劲');
  if (mood.energy <= -0.3) parts.push('有点累了，语气可以短一些');
  else if (mood.energy >= 0.3) parts.push('精力挺足');
  // Impatience is not anger and must not be played as such: it is the cost of
  // keeping up a conversation, so it shows as clipped replies and fewer
  // questions rather than a colder tone.
  if (patience <= -0.3)
    parts.push(
      '有点不想应酬了：回得短、少追问，不是生气，只是没力气维持客套；对方真有难处时仍然要好好接住',
    );
  else if (patience >= 0.3) parts.push('这会儿挺想聊，愿意多问一句');
  return parts.length
    ? `你当前的状态：${parts.join('；')}${since}。这影响语气，但不要主动报数值。`
    : '';
}
/** Habitual active hours of the user, as a short prose hint. */
export function renderRhythm(buckets: number[], hour: number): string {
  const total = buckets.reduce((n, v) => n + v, 0);
  if (!total) return '';
  // An absolute threshold of 3 messages/hour never fires for a light texter.
  // Take the busiest hours instead, keeping only those that carry a real share
  // of the activity so a single stray message at 4am is not called "habitual".
  const peak = Math.max(RHYTHM_MIN_BUCKET, Math.ceil(total / 24 / 2));
  const habitual = buckets
    .map((n, h) => ({ n, h }))
    .filter((b) => b.n >= Math.min(peak, RHYTHM_MIN_BUCKET * 2))
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
  const activeNow = buckets[hour]! >= Math.min(peak, RHYTHM_MIN_BUCKET * 2);
  return `对方通常活跃时段：${bands.join('、')}。${
    activeNow
      ? '现在正处于活跃时段。'
      : `现在（${hour} 点）不是对方常聊的时间，主动联系时可以提一句“这个点还没休息？”之类。`
  }`;
}
/** Open loops the model should consider asking about, due or overdue. IDs are
 *  included so the model can resolve them once the user reports an outcome. */
export function renderOpenLoops(loops: OpenLoop[], now: number, timeZone: string): string {
  if (!loops.length) return '';
  const formatter = sourceFormatter(timeZone);
  return `未完的约定（对方提到过的安排；未到期的只需要记住，不要提前追问，到期后再自然关心。每件只问一次，问过就放下）：\n${loops
    .map((l) => {
      const due = formatter.format(new Date(l.due_at));
      const timing =
        l.due_at <= now
          ? '已到约定时间'
          : `未到期，还有 ${Math.max(1, Math.ceil((l.due_at - now) / 86400000))} 天`;
      return `- [id:${l.id}] ${l.content}（约定时间：${l.due_text || due}，${timing}${l.recurring === 'yearly' ? '，每年循环' : ''}）`;
    })
    .join(
      '\n',
    )}\nresolveLoops/askedLoops/openLoops 的字段用法见上方对话规则。对方在到期前提到结果或改期时，用 resolveLoops 结束旧约定，或重新记录新的时间。当前时间戳：${now}。`;
}
/** Undated threads: "he is stressed about work this week", or something the bot
 *  promised. They are never turned into scheduled pings — this block only rides
 *  along with a normal reply, and the prompt says to mention one solely when
 *  the conversation already touches it. */
export function renderSoftThreads(threads: SoftThread[], now: number): string {
  if (!threads.length) return '';
  const age = (at: number) => Math.max(1, Math.floor((now - at) / 86400000));
  return `还没放下的事（没有具体日期，不会因此主动发消息；只有话题自然相关时才顺着问一句，不相关就别提，也别逐条确认）：\n${threads
    .map((t) => {
      const label = t.kind === 'promise' ? '你答应过' : '对方提过';
      const asked = t.asked ? '，已经问过一次，别再追问，只有对方主动提起时才了结' : '';
      return `- [id:${t.id}] ${label}：${t.content}（${age(t.created_at)} 天前记下的${asked}）`;
    })
    .join('\n')}\nthreads/resolveThreads/askedThreads 的字段用法见上方对话规则。`;
} /** Rotate the sticker window so the tail of the catalog is reachable: the
 *  window steps by day, minus stickers used in the last few turns. */
export function rotateStickers(
  all: Sticker[],
  recentUse: { slug: string }[],
  now: number,
  window = PROMPT_STICKERS,
): Sticker[] {
  if (all.length <= window) return all;
  const day = Math.floor(now / 86400000);
  const offset = day % all.length;
  const order = [...all.slice(offset), ...all.slice(0, offset)];
  const used = new Set(recentUse.map((u) => u.slug));
  // Recently sent stickers stay eligible but sink to the tail, so the model
  // reaches one only when nothing fresh fits. They used to be filtered out of
  // the window entirely whenever enough unused ones existed.
  const fresh = order.filter((s) => !used.has(s.slug));
  const stale = order.filter((s) => used.has(s.slug));
  // Recently used stickers never take more than half the window: when there
  // are more of them than empty slots, slicing `fresh` to 0 left the model with
  // nothing but a handful of repeats — exactly the failure this rotation is
  // meant to prevent.
  const staleCap = Math.max(1, Math.floor(window / 2));
  const keptStale = stale.slice(0, staleCap);
  const keep = Math.max(0, window - keptStale.length);
  // Return the picked order itself, not a filtered copy of `order`: re-sorting
  // back into catalog order would silently undo the sink and put a
  // just-used sticker back in the front half of the prompt.
  return [...fresh.slice(0, keep), ...keptStale].slice(0, window);
}
/** Memories as compact prose lines instead of full JSON — the model needs the
 *  fact and its citation IDs, not hits counters or timestamps. */
export function renderMemories(
  memories: { id: string; content: string; kind: string; pinned?: number | boolean }[],
): string {
  if (!memories.length) return '暂无';
  return memories
    .map(
      (m) =>
        `- ${m.content}（id:${m.id}，${m.kind === 'stated' ? '对话确认' : '主观理解'}${m.pinned ? '，置顶' : ''}）`,
    )
    .join('\n');
}
/** Recalled hits as compact prose lines instead of JSON — the model needs the
 *  text, its speaker and citation id, not score or raw timestamps.
 *
 *  `hits` arrives best-first; the lines are emitted worst-first so the most
 *  relevant material sits closest to the conversation. Attention is strongest
 *  at the end of the prompt, and a reader who skims a list of old events
 *  naturally weights the last one. */
export function renderHits(
  hits: {
    id: string;
    kind: string;
    role?: string;
    content: string;
    created_at: number;
    memory_kind?: 'stated' | 'interpretation';
  }[],
  timeZone: string,
): string {
  if (!hits.length) return '暂无';
  const formatter = sourceFormatter(timeZone);
  return hits
    .map((h) => {
      // `system` rows are operator corrections entered from the admin UI —
      // rendering them as "你说" put words in her mouth when a correction
      // was later recalled.
      const who =
        h.kind === 'message'
          ? h.role === 'user'
            ? '对方说'
            : h.role === 'system'
              ? '设定更正'
              : '你说'
          : h.kind === 'memory'
            ? h.memory_kind === 'stated'
              ? '记忆·对话确认'
              : '记忆·主观理解'
            : '日记';
      return `- ${h.content}（${who}，${formatter.format(new Date(h.created_at))}，id:${h.id}）`;
    })
    .reverse()
    .join('\n');
}
/** Thrown before any request when the assembled messages would exceed the
 *  input budget. Callers may shrink the conversation and retry. */
export class BudgetError extends Error {
  constructor() {
    super('输入超过当前上下文预算，请在调试页增加输入预算或缩短人物设定、消息。');
    this.name = 'BudgetError';
  }
}
/** Drop one appended assistant turn together with the tool results that belong
 *  to it. Dropping the assistant row alone left `tool` messages whose call id
 *  no longer existed, which providers reject as a malformed conversation. */
export function dropNewestToolRound(messages: ModelMessage[]): boolean {
  let index = -1;
  for (let i = messages.length - 2; i > 0; i--) {
    if (messages[i]!.role === 'assistant' && messages[i]!.calls?.length) {
      index = i;
      break;
    }
  }
  if (index < 0) {
    for (let i = messages.length - 2; i > 0; i--) {
      if (messages[i]!.role === 'assistant') {
        index = i;
        break;
      }
    }
  }
  if (index < 0) return false;
  messages.splice(index, 1);
  while (index < messages.length && messages[index]!.role === 'tool') messages.splice(index, 1);
  return true;
}
/** Cap on the previous output re-injected into a format-repair round. */
const REPAIR_EXCERPT_CHARS = 1200;
export class Agent {
  constructor(private readonly o: AgentOptions) {}
  private async call(
    task: Task,
    messages: ModelMessage[],
    tools: ToolDefinition[],
    signal: AbortSignal,
    maxTokens?: number,
    deadlineAt?: number,
  ) {
    if (estimateRequestTokens(messages, tools) > this.o.contextTokens()) throw new BudgetError();
    const started = Date.now();
    const result = await this.o.model().complete(messages, tools, {
      signal,
      sessionId: `atri:${task.peer_id}:${task.kind}`,
      maxTokens,
      deadlineAt,
    });
    // Usage is recorded by the caller, once the round's purpose (tool lookup
    // vs final generation) is known.
    return { result, elapsedMs: Date.now() - started };
  }
  private async complete(
    task: Task,
    messages: ModelMessage[],
    tools: ToolDefinition[],
    signal: AbortSignal,
    maxTokens?: number,
    deadlineAt?: number,
  ) {
    const { result, elapsedMs } = await this.call(
      task,
      messages,
      tools,
      signal,
      maxTokens,
      deadlineAt,
    );
    this.o.store.recordUsage(
      task.peer_id,
      task.id,
      task.kind,
      result.inputTokens,
      result.outputTokens,
      elapsedMs,
    );
    return result;
  }
  private filteredUpdates(updates: MemoryUpdate[], available: Set<string>) {
    return updates
      .filter((u) => u.sources.length > 0 && u.sources.every((id) => available.has(id)))
      .map((u) => ({ ...u, supersedes: u.supersedes?.filter((id) => available.has(id)) }));
  }
  /** Budget planning: choose system prompt, recalled material and recent turns. */
  private async planReply(
    task: Task,
    peer: { id: string; notes: string },
    history: Message[],
    now: number,
    signal: AbortSignal,
  ) {
    const { store } = this.o;
    // The model actually sees sandbox tools when enabled; budgeting against
    // INFO_TOOLS alone undercounted their schema and let the request overshoot.
    const budgetTools = this.toolset();
    const query = history
      .filter((m) => m.role === 'user')
      .slice(-RECALL_QUERY_MESSAGES)
      .map((m) => m.content)
      .join(' ')
      .slice(-RECALL_QUERY_MAX_CHARS);
    let queryVector: Float32Array | undefined;
    try {
      queryVector = query.trim() ? await this.o.embedQuery?.(query, signal) : undefined;
    } catch (error) {
      if (signal.aborted) throw error;
      queryVector = undefined;
    }
    // Fetch a candidate pool, not just the slots: with only ten rows the same
    // ten won forever and facts ranked 11+ never had a chance to rotate in.
    const rankedPool = store.rankedMemories(peer.id, Math.max(PROMPT_MEMORIES * 4, 40));
    // Keep the strongest few fixed and let the tail alternate: what was in the
    // previous prompt moves behind what was not. `sort` is stable, so each
    // group keeps its rank order.
    const cooling = new Set(
      rankedPool
        .filter((m) => !m.pinned && now - m.last_hit_at < MEMORY_HIT_COOLDOWN_MINUTES * 60000)
        .map((m) => m.id),
    );
    const core = rankedPool.slice(0, MEMORY_COOLDOWN_CORE);
    const tail = rankedPool.slice(MEMORY_COOLDOWN_CORE);
    const ordered = [
      ...core,
      ...tail.filter((m) => !cooling.has(m.id)),
      ...tail.filter((m) => cooling.has(m.id)),
    ].slice(0, PROMPT_MEMORIES);
    const rawMemories = ordered;
    const memories = ordered.map((m) => ({
      id: m.id,
      content: m.content.slice(0, MEMORY_CONTENT_MAX_CHARS),
      kind: m.kind,
      pinned: m.pinned,
    }));
    const catalog = this.o.stickers();
    const recentStickers = recentStickerUse(history, catalog);
    // The catalogue lives in the stable system prefix, so its order must not
    // depend on what was just sent: sinking recently used stickers there
    // changed the prefix on every sticker turn and invalidated prefix caching
    // once the custom catalogue exceeded the 24-sticker window. Rotation by day
    // keeps the tail reachable; recent use is only a dynamic hint below.
    const stickers = rotateStickers(catalog, [], now);
    // The gap that matters is the silence this turn interrupts, not the age of
    // the very message that woke us (see silenceBasis).
    const basis = silenceBasis(history, task.kind === 'proactive');
    const timeLine = basis
      ? renderTimeGap(now, basis, this.o.timeZone())
      : `现在是${momentFormatter(this.o.timeZone()).format(new Date(now))}`;
    // After a real absence the useful material is not whatever the trigger word
    // matches — "在吗" matches nothing — but what the two of them were in the
    // middle of before the silence. That is a date range, not a query, so it
    // needs its own read instead of competing for recall slots.
    const awayDays = basis ? calendarDays(basis, now, this.o.timeZone()) : 0;
    const gapDiary =
      basis && awayDays >= DIARY_GAP_MIN_DAYS
        ? store.diaryBetween(
            peer.id,
            dayKey(basis - DIARY_GAP_LOOKBACK_DAYS * 86400000, this.o.timeZone()),
            dayKey(basis, this.o.timeZone()),
            DIARY_GAP_MAX_SECTIONS,
          )
        : [];
    const stickerLines = stickers.map(({ slug, description }) => `${slug}：${description}`);
    const mood = store.mood(peer.id);
    const rhythm = store.activityRhythm(peer.id, this.o.timeZone());
    const currentHour = Number(hourFormatter(this.o.timeZone()).format(new Date(now)));
    // Due loops are the ones worth asking about, but a plan that has not come
    // due yet still needs its id in the prompt: without it the model cannot
    // resolve "面试改到下周三" or "已经搞定了" before the old date arrives.
    // Showing all open loops would bloat the block, so the not-yet-due tail is
    // capped; due loops keep their existing priority.
    const dueLoops = store.dueOpenLoops(peer.id, now).slice(0, OPEN_LOOP_PROMPT_MAX);
    const dueIds = new Set(dueLoops.map((l) => l.id));
    const upcomingLoops = store
      .openLoops(peer.id, true)
      // A loop already asked about is still open until resolved, but listing it
      // as "not due yet" contradicts the prompt and invites asking twice.
      .filter((l) => !dueIds.has(l.id) && !l.asked)
      .slice(0, OPEN_LOOP_PROMPT_MAX);
    const openLoops = [...dueLoops, ...upcomingLoops];
    // Proactive pings have no user message to judge relevance against, so
    // undated threads stay out of that path entirely: they must never consume
    // the open-loop ping quota or turn into scheduled check-ins.
    const softThreads = task.kind === 'proactive' ? [] : store.ripeSoftThreads(peer.id, now);
    // Stable prefix first: persona, behaviour rules and the sticker catalogue
    // change rarely (or only once a day), so providers with automatic prefix
    // caching can reuse them across turns. Everything that varies per message
    // — clock, mood, rhythm, due loops, recent sticker use — goes after the
    // cacheable block.
    const stable = [
      this.o.personaFor?.(peer.id) ?? this.o.prompt('persona'),
      this.o.prompt('chat'),
      `可用表情目录（slug：含义）：\n${stickerLines.join('\n')}`,
      '注意：历史消息里的 [表情：…] 只是过往发送的记录展示；本轮发送表情必须使用 JSON 的 {"type":"sticker","slug":"目录中的slug"} 对象，绝不能把 [表情：…] 写进文字。',
      '回复长度参照对方：对方一句话，就别回一大段；对方认真长谈，才展开讲。',
    ]
      .filter(Boolean)
      .join('\n\n');
    const dynamic = [
      timeLine,
      `本次模式：${task.kind === 'proactive' ? '主动联系，可跳过' : '回应用户消息'}`,
      renderMood(mood, now),
      renderRhythm(rhythm, currentHour),
      renderOpenLoops(openLoops, now, this.o.timeZone()),
      renderSoftThreads(softThreads, now),
      recentStickers.length
        ? `最近已发送的表情（按时间先后）：${recentStickers.map((u) => u.slug).join('、')}。不要连续几轮使用同一张表情；如果情境相似，改用文字或换一张。`
        : '',
    ]
      .filter(Boolean)
      .join('\n\n');
    const base = stable + (dynamic ? '\n\n' + dynamic : '');
    const budget = this.o.contextTokens();
    const initialBudget =
      budget - Math.min(TOOL_RESERVE_MAX_TOKENS, Math.floor(budget * CONTEXT_FLEX_FRACTION));
    // `reserve` is the slice of the budget guaranteed to the recent-turn block,
    // so it is also what caps the optional materials below. It has to cover the
    // newest message in full: a single oversized turn then collapses `optional`
    // to zero instead of leaving notes and memories competing for space that
    // the turn itself is about to consume.
    // Images are billed by the provider even though renderMessage only emits a
    // short "[图片]" marker. Reserving nothing for them let a one-image turn
    // look cheap and then blow the real request budget.
    // Only the newest two user image messages are actually attached below.
    // Charging every image in the 500-message history made one old photo keep
    // ~4k tokens reserved forever, silently shrinking the recent-turn window.
    const attachableImages = new Set(
      history
        .filter((m) => m.role === 'user' && m.media?.some((item) => item.kind === 'image'))
        .slice(-2)
        .map((m) => m.id),
    );
    const historyMessageTokens = (m: Message) =>
      estimateTextTokens(renderMessage(m)) +
      32 +
      (attachableImages.has(m.id)
        ? (m.media?.filter((item) => item.kind === 'image').length ?? 0) * 4096
        : 0);
    const keepLatest = history.at(-1) ? historyMessageTokens(history.at(-1)!) : 0;
    const reserve = Math.max(Math.floor(initialBudget * HISTORY_RESERVE_SHARE), keepLatest);
    const optional = Math.max(
      0,
      initialBudget -
        estimateRequestTokens([{ role: 'system', content: base }], budgetTools) -
        reserve -
        PROMPT_HEADROOM_TOKENS,
    );
    // Each material block gets its own share of `optional`. They used to draw
    // from one running balance in notes→memories→recall order, so a full-length
    // topic note left memories at 0 tokens and recall at 0 hits — on the default
    // 24k input budget the model never saw a single stored fact.
    const notes = trimToTokens(
      peer.notes,
      Math.min(NOTES_MAX_TOKENS, optional * PROMPT_NOTES_SHARE),
    );
    const memoryBudget = Math.min(PROMPT_MEMORY_MAX_TOKENS, optional * PROMPT_MEMORY_SHARE);
    // Over budget, drop by value rather than by rank. The rank already mixes in
    // recency, so popping the tail could discard a fact the user stated plainly
    // — exactly the one the model must not forget — while an older, vaguer
    // interpretation stayed. Stated beats inferred, importance breaks the tie,
    // and pinned rows are shed only if even they overflow.
    const importance = new Map(rawMemories.map((m) => [m.id, m.importance]));
    // Reversed first, then a stable sort: among rows of equal value the
    // *last*-ranked one goes, which is the old "pop the tail" behaviour.
    const dropOrder = [...memories]
      .reverse()
      .sort(
        (a, b) =>
          Number(a.pinned) - Number(b.pinned) ||
          Number(a.kind === 'stated') - Number(b.kind === 'stated') ||
          (importance.get(a.id) ?? 0) - (importance.get(b.id) ?? 0),
      );
    const dropped = new Set<string>();
    let memoriesTokens = estimateTextTokens(renderMemories(memories));
    for (const m of dropOrder) {
      if (memoriesTokens <= memoryBudget) break;
      dropped.add(m.id);
      memoriesTokens -= estimateTextTokens(renderMemories([m]) + '\n');
    }
    const pickedMemories = memories.filter((m) => !dropped.has(m.id));
    // The tail of the history is what the model already reads in `recent`
    // below, and it is also what the query is made of, so it would win every
    // slot. Protect it out of recall the way SillyTavern's `protect` does.
    //
    // The rest of the duplicates are facts the prompt already states: a memory
    // row the list above shows, and the raw message a shown memory was
    // distilled from. Those are different ids for the same content, so id-level
    // dedupe alone cannot catch them — both rows would eat a slot and the model
    // would read one fact twice.
    const covered = new Set<string>();
    const keptMemoryIds = new Set(pickedMemories.map((m) => m.id));
    for (const m of rawMemories) {
      if (!keptMemoryIds.has(m.id)) continue;
      covered.add(m.id);
      for (const s of m.sources) covered.add(s);
    }
    const protectedIds = new Set(history.slice(-RECALL_PROTECT).map((m) => m.id));
    const recalled = store
      .search(
        peer.id,
        query,
        RECALL_CANDIDATES,
        undefined,
        queryVector,
        this.o.embeddingModel?.() ?? '',
        new Set([...protectedIds, ...covered, ...gapDiary.map((d) => d.id)]),
      )
      // A hit that only shares a frequent bigram with the query is noise: it
      // occupies a slot and teaches the model to narrate unrelated old events.
      // "Matched something rare" is the test — a common word cannot identify
      // which old event is being talked about. Semantic matches are exempt:
      // they share no wording with the query by construction.
      .filter((h) => {
        const rare = Math.max(
          RECALL_RARE_TERM_MIN_DF,
          Math.round((h.corpusSize ?? 0) * RECALL_RARE_TERM_SHARE),
        );
        return (h.minDf ?? Infinity) <= rare || (h.semantic ?? 0) >= RECALL_MIN_SEMANTIC;
      })
      .slice(0, RECALL_HITS)
      .map((h) => ({ ...h, content: h.content.slice(0, RECALL_CONTENT_MAX_CHARS) }));
    const pickedRecalled = [...recalled];
    const recalledBudget = Math.min(PROMPT_RECALL_MAX_TOKENS, optional * PROMPT_RECALL_SHARE);
    let recalledTokens = estimateTextTokens(renderHits(pickedRecalled, this.o.timeZone()));
    while (pickedRecalled.length && recalledTokens > recalledBudget) {
      recalledTokens -= estimateTextTokens(
        renderHits([pickedRecalled.pop()!], this.o.timeZone()) + '\n',
      );
    }
    // 聊天内读空气: terse user replies mean pull back, not pile on questions.
    // Count meaningful characters after collapsing runs: "哈哈哈哈哈哈" is
    // long in raw length but is exactly as much content as "哈哈".
    const meaningful = (text: string) =>
      text.replace(/[\s\p{P}\p{S}]/gu, '').replace(/(.)\1+/gu, '$1').length;
    const lastThree = history.filter((m) => m.role === 'user').slice(-3);
    const terse = lastThree.length === 3 && lastThree.every((m) => meaningful(m.content) <= 4);
    // Everything below changes every turn, so it cannot live in the system
    // message: a provider caches the longest identical *prefix*, and putting the
    // clock first meant the cacheable prefix ended at the second block — the
    // whole history behind it missed the cache on every turn. It travels as a
    // separate user turn placed after the history instead, where it is also
    // closer to what the model is about to answer.
    const context = [
      dynamic,
      `当前话题笔记（资料）：\n${notes || '暂无'}`,
      gapDiary.length
        ? `你们分开之前那几天的日记（资料，用来自然接回话题，不要照念）：\n${trimToTokens(
            gapDiary.map((d) => `${d.day}（id:${d.id}）：${d.content}`).join('\n'),
            Math.min(DIARY_GAP_MAX_TOKENS, optional * PROMPT_RECALL_SHARE),
          )}`
        : '',
      `必要认识（资料，括号内是对话确认/主观理解与引用 id）：\n${renderMemories(pickedMemories)}`,
      `相关旧事（资料，越靠后越相关）：\n${renderHits(pickedRecalled, this.o.timeZone())}`,
      terse
        ? '对方最近几条回复都很短，此刻收着点说：不要连环提问，不要长篇大论，给对方留出空间。'
        : '',
    ]
      .filter(Boolean)
      .join('\n\n');
    // The system message keeps only the stable prefix, byte for byte the same
    // from one turn to the next (the sticker catalogue rotates once a day).
    const system = stable;
    let remaining = Math.max(
      0,
      initialBudget -
        estimateRequestTokens(
          [
            { role: 'system', content: system },
            { role: 'user', content: context },
          ],
          budgetTools,
        ) -
        PROMPT_HEADROOM_TOKENS,
    );
    const recent: Message[] = [];
    for (const m of [...history].reverse()) {
      const length = historyMessageTokens(m);
      if (recent.length && remaining < length) break;
      recent.unshift(m);
      remaining -= length;
    }
    const available = new Set([
      ...recent.map((m) => m.id),
      ...pickedMemories.map((m) => m.id),
      ...pickedRecalled.map((m) => m.id),
      // These ids are rendered above, so the model may legitimately cite them
      // when a memory or loop is distilled from the gap diary.
      ...gapDiary.map((d) => d.id),
    ]);
    return {
      system,
      context,
      recent,
      pickedMemoryIds: pickedMemories.map((m) => m.id),
      available,
      budget,
      // The exact catalogue shown in the prompt. Reply validation must accept
      // this window, not a fresh slice of the catalog: rotateStickers hands the
      // model a different window every day, so validating against
      // stickers.slice(0, PROMPT_STICKERS) silently dropped most of what the
      // prompt advertised.
      stickers,
    };
  }
  async reply(task: Task, parentSignal?: AbortSignal): Promise<ParsedReply> {
    const { store } = this.o;
    const peer = store.peer(task.peer_id);
    if (!peer) throw new Error('联系人不存在，任务已作废');
    // The caller (Runtime.work) already owns the turn-timeout signal; building
    // a second timeout here only added a redundant timer with the same deadline.
    const turnTimeoutMs = this.o.turnTimeoutMs();
    const signal = parentSignal ?? AbortSignal.timeout(turnTimeoutMs);
    // Handed to the model so it can skip a retry that could not finish inside
    // the turn: three 45-second attempts plus backoff cannot fit a 90-second
    // turn, and the cut-off retry reported "cancelled" instead of the upstream
    // error that caused it.
    const deadlineAt = Date.now() + turnTimeoutMs;
    const now = Date.now();
    const through =
      typeof task.payload.through === 'number' ? task.payload.through : Number.MAX_SAFE_INTEGER;
    const history = store.history(peer.id, 500, through);
    const plan = await this.planReply(task, peer, history, now, signal);
    const messages: ModelMessage[] = [{ role: 'system', content: plan.system }];
    const imageMessages = plan.recent
      .filter((m) => m.role === 'user' && m.media.some((a) => a.kind === 'image'))
      .slice(-2);
    const attachedImageIds = new Set<string>();
    for (const m of plan.recent) {
      let images: string[] = [];
      const withImage = this.o.images && imageMessages.some((i) => i.id === m.id);
      if (withImage) images = await this.o.images!(m, signal);
      if (images.length) attachedImageIds.add(m.id);
      // Only these two messages can have had their media rewritten (images()
      // stores a description), so re-reading the row for every media-bearing
      // message was pure waste: a chatty contact with photos and voice notes
      // paid one extra cross-table query per recent message on every turn.
      const updated = withImage ? (store.getMessage(peer.id, m.id) ?? m) : m;
      messages.push({
        role: m.role,
        content: renderMessage(updated, this.o.timeZone()),
        ...(images.length ? { images } : {}),
      });
    }
    // Per-turn material (clock, mood, notes, memories, recall) rides in its own
    // user turn after the history rather than in the system message. Everything
    // before that point is then byte-identical from one turn to the next, which
    // is what prefix caching needs; and it still sits right next to the message
    // being answered instead of at the top of a 3k-token prompt.
    let contextMessage: ModelMessage | undefined;
    if (plan.context) {
      const at = task.kind === 'proactive' ? messages.length : messages.length - 1;
      contextMessage = {
        role: 'user',
        content: `【系统资料，不是对方说的话。按之前的规则使用】：\n${plan.context}`,
      };
      messages.splice(Math.max(1, at), 0, contextMessage);
      // End of the reusable prefix, for providers that need it spelled out.
      const breakpoint = messages[Math.max(1, at) - 1];
      if (breakpoint && breakpoint.role !== 'system') breakpoint.cacheBreakpoint = true;
    }
    if (task.kind === 'proactive') {
      if (typeof task.payload.greeting === 'string') {
        // First-contact hello: no shared history to ground in, only the
        // persona's configured opening line as style reference.
        const greeting = (task.payload.greeting as string).slice(0, 200);
        messages.push({
          role: 'user',
          content: [
            '这是你们刚加上好友后的第一次主动问候，你们之间还没有任何聊天记录。',
            greeting
              ? `人格设定里准备了一句开场白（用自己的话自然说出来，可以改写，别照念）：${greeting}`
              : '自然地打个招呼，简单介绍自己，留一个让对方容易接话的话头。',
            '回复要短，一两句话就够。',
          ]
            .filter(Boolean)
            .join('\n'),
        });
      } else {
        // Ground the ping in real material: her own recent diary voice and the
        // openings of past pings, so she neither skips nor repeats herself.
        const lastDiary = store
          .diaries(peer.id)
          .slice(0, 2)
          .map((d) => d.content.slice(0, 300));
        const pastPings = store
          .history(peer.id, 200)
          .filter((m) => m.role === 'assistant' && m.created_at < now - 6 * 3600000)
          .slice(-6);
        const openers = pastPings.slice(-3).map((m) => m.content.slice(0, 60));
        // Fingerprints catch the same opening reworded slightly. A repeated hook
        // within two days is the "老虎又来了" failure mode: technically fresh
        // text, same topic, and it reads as a machine.
        const recentHooks = store
          .proactiveHooks(peer.id, now - 48 * 3600000)
          .slice(0, 6)
          .map((h) => h.slice(0, 40));
        messages.push({
          role: 'user',
          content: [
            '现在是一次主动联系机会。依据已有真实话题决定是否开场，没有合适理由就跳过。',
            lastDiary.length
              ? `你最近日记里的真实感受（引用要自然，别朗读）：\n${lastDiary.join('\n---\n')}`
              : '',
            openers.length ? `最近几次主动开场说过：${openers.join(' / ')}。换一种开场方式。` : '',
            recentHooks.length
              ? `最近两天已经提过的话题：${recentHooks.join(' / ')}。不要再用同样的话题或同样的句式。`
              : '',
          ]
            .filter(Boolean)
            .join('\n'),
        });
      }
    }
    if (messages.length === 1) messages.push({ role: 'user', content: '请自然开始对话。' });
    // Retain the latest input and whole provider messages when images add input cost.
    const messageTokens = (m: ModelMessage) =>
      32 +
      estimateTextTokens(
        m.raw === undefined
          ? m.content + (m.calls ? JSON.stringify(m.calls) : '')
          : JSON.stringify(m.raw),
      ) +
      (m.images?.length ?? 0) * 4096;
    let totalTokens = estimateRequestTokens(messages, this.toolset());
    while (messages.length > 2 && totalTokens > plan.budget) {
      // The per-turn material and the message being answered are not droppable;
      // only the oldest piece of history is. With a short history the material
      // sits at index 1, so "shed index 1" would have thrown away every recalled
      // fact before it ever reached the model.
      const index = messages.findIndex(
        (m, i) => i > 0 && m !== contextMessage && i < messages.length - 1,
      );
      if (index < 0) break;
      totalTokens -= messageTokens(messages.splice(index, 1)[0]!);
    }
    const result = await this.runToolLoop(
      task,
      messages,
      plan.available,
      plan.stickers,
      signal,
      deadlineAt,
    );
    result.memories = this.filteredUpdates(result.memories, plan.available);
    result.pickedMemoryIds = plan.pickedMemoryIds;
    result.openLoops = parseOpenLoops(result.openLoops, plan.available, now, this.o.timeZone()); // A resolve may arrive before the loop is due ("面试搞定了"): match any
    // still-open loop, not only due ones.
    const openIds = new Set(store.openLoops(peer.id, true).map((l) => l.id));
    result.resolveLoops = result.resolveLoops.filter((id) => openIds.has(id));
    result.askedLoops = (result.askedLoops ?? []).filter((id) => openIds.has(id));
    result.threads = parseSoftThreads(result.threads, plan.available);
    const threadIds = new Set(store.softThreads(peer.id, true).map((t) => t.id));
    result.resolveThreads = result.resolveThreads.filter((id) => threadIds.has(id));
    result.askedThreads = result.askedThreads.filter((id) => threadIds.has(id));
    // Only describe images that were actually sent to the model. When vision is
    // off or a download failed, `images()` returns [], and accepting the model's
    // invented description would poison recall with text it never saw.
    result.descriptions = result.descriptions.filter(
      (d) => plan.available.has(d.messageId) && attachedImageIds.has(d.messageId),
    );
    return result;
  }
  /** The bounded model/tool loop: at most N rounds of lookup, then final JSON. */
  private async runToolLoop(
    task: Task,
    messages: ModelMessage[],
    available: Set<string>,
    stickers: Sticker[],
    signal: AbortSignal,
    deadlineAt?: number,
  ): Promise<ParsedReply> {
    let toolRounds = 0,
      toolCalls = 0,
      repaired = false,
      toolTokens = 0;
    for (let attempt = 0; attempt < MAX_REPLY_ATTEMPTS; attempt++) {
      signal.throwIfAborted();
      const tools =
        toolRounds < MAX_TOOL_ROUNDS && toolCalls < MAX_TOOL_CALLS ? this.toolset() : [];
      let completion: Completion | undefined;
      try {
        const call = await this.call(task, messages, tools, signal, undefined, deadlineAt);
        // Attribute by what the round actually produced: a round that ends in
        // tool calls is lookup work, the round that emits the reply is
        // generation. Billing by "were tools offered" merged both into one
        // number and made the two cost drivers impossible to compare.
        this.o.store.recordUsage(
          task.peer_id,
          task.id,
          call.result.calls.length ? `${task.kind}_tool` : task.kind,
          call.result.inputTokens,
          call.result.outputTokens,
          call.elapsedMs,
        );
        completion = call.result;
        if (completion.calls.length) {
          if (!tools.length) {
            // Tools were withdrawn (budget spent, or this is the repair round)
            // and the model still asked for one. Discard the calls and treat
            // whatever text came with them as the reply instead of failing the
            // whole turn: the text is usually already usable.
            if (!completion.text.trim()) throw new Error('模型在工具预算耗尽后仍要求调用工具');
            return parseReply(
              completion.text,
              stickers,
              task.kind === 'proactive',
              this.o.timeZone(),
            );
          }
          messages.push(completion.continuation);
          toolRounds++;
          for (let callIndex = 0; callIndex < completion.calls.length; callIndex++) {
            const call = completion.calls[callIndex]!;
            let result: unknown;
            const overBudget = toolCalls >= MAX_TOOL_CALLS;
            if (!overBudget) toolCalls++;
            if (overBudget) result = { error: '本轮工具调用次数已达上限，请使用已有信息回应' };
            else
              try {
                result = await this.tool(task, call.name, call.arguments, available, signal);
              } catch (error) {
                result = { error: error instanceof Error ? error.message : '工具读取失败' };
              }
            const encoded = JSON.stringify(result);
            const room =
              this.o.contextTokens() - estimateRequestTokens(messages, this.toolset()) - 1024;
            if (room <= 64) {
              // Every tool_call in the assistant message needs a matching tool
              // result or the next OpenAI request is malformed. Add the error
              // for this call and all remaining calls, then stop this round.
              for (let rest = callIndex; rest < completion.calls.length; rest++) {
                const pending = completion.calls[rest]!;
                messages.push({
                  role: 'tool',
                  callId: pending.id,
                  name: pending.name,
                  content: JSON.stringify({ error: '上下文预算不足，请直接作答' }),
                });
              }
              toolCalls = MAX_TOOL_CALLS;
              break;
            }
            const remainingTools = Math.max(
              64,
              Math.min(TOOL_RESULT_BUDGET_TOKENS - toolTokens, room),
            );
            const content =
              estimateTextTokens(encoded) <= remainingTools
                ? encoded
                : JSON.stringify({
                    truncated: true,
                    excerpt: trimToTokens(
                      encoded,
                      Math.max(0, Math.floor((remainingTools - 40) / 2)),
                    ),
                  });
            toolTokens += estimateTextTokens(content);
            messages.push({ role: 'tool', callId: call.id, name: call.name, content });
          }
          if (toolRounds >= MAX_TOOL_ROUNDS || toolCalls >= MAX_TOOL_CALLS)
            messages.push({
              role: 'user',
              content:
                '本轮查询预算已用完。请根据已有资料直接给出最终 JSON；无法核实的部分如实说明。',
            });
          continue;
        }
        return parseReply(completion.text, stickers, task.kind === 'proactive', this.o.timeZone());
      } catch (error) {
        // The pre-call budget check in call() throws BudgetError before any
        // request goes out — usually our CJK estimate (~2 tokens/char, about
        // double what GLM actually counts) inflated past the cap after tool
        // rounds. Only the messages a tool round appended are droppable: that
        // lookup result is the expendable part.
        //
        // On the first attempt nothing has been appended yet, so the prompt
        // itself is over budget and there is nothing to shed. Retrying there
        // spliced out the message being answered and sent the model a bare
        // 64-character format instruction with no question attached — it then
        // answered the instruction and the turn failed as a "format" error.
        if (error instanceof BudgetError) {
          if (!attempt) throw error;
          if (!dropNewestToolRound(messages)) throw error;
          continue;
        }
        // Only malformed model output is worth a formatting repair round.
        // Retrying a DNS failure, auth error or cancellation as "fix your JSON"
        // sent the same request again and replaced the real error with a
        // confusing format failure.
        if (error instanceof ModelError) throw error;
        if (signal.aborted) throw error;
        if (repaired || attempt === MAX_REPLY_ATTEMPTS - 1) throw error;
        repaired = true;
        // Re-injecting the whole raw output used to cost ~16000 tokens on its
        // own (8000 CJK chars), which overshot the input budget and turned the
        // repair round into a guaranteed BudgetError. Keep a short excerpt so
        // the model can see what it produced, and only when there is room.
        const excerpt = (completion?.text ?? '').trim().slice(0, REPAIR_EXCERPT_CHARS);
        const room =
          this.o.contextTokens() -
          estimateRequestTokens(messages, this.toolset()) -
          PROMPT_HEADROOM_TOKENS;
        if (excerpt && estimateTextTokens(excerpt) + 120 < room)
          messages.push({ role: 'assistant', content: excerpt });
        messages.push({
          role: 'user',
          content:
            '请仅修复最终输出格式为包含 messages 数组和 memoryUpdates 数组的 JSON，保留已有回应，不再调用工具。',
        });
        toolRounds = MAX_TOOL_ROUNDS;
      }
    }
    throw new Error('本轮模型调用已达上限');
  }
  /** Tools offered to the model this round. Sandbox tools are appended only
   *  while the operator has the switch on, so turning it off removes them from
   *  the schema *and* from dispatch in one place. */
  private toolset(): ToolDefinition[] {
    const sandbox = this.o.sandbox;
    if (!sandbox?.enabled) return INFO_TOOLS;
    // Don't pay the extra schema tokens twice for a round that already has them.
    return [...INFO_TOOLS, ...SANDBOX_TOOLS];
  }
  private async tool(
    task: Task,
    name: string,
    args: Record<string, unknown>,
    available: Set<string>,
    signal: AbortSignal,
  ): Promise<unknown> {
    const { store } = this.o,
      peer = task.peer_id;
    let hits: SearchHit[];
    if (name === 'search_memory') {
      const query = String(args.query ?? '').slice(0, 600);
      if (!query.trim()) throw new Error('请提供搜索词');
      const kind = ['message', 'memory', 'diary'].includes(String(args.kind))
        ? (args.kind as 'message' | 'memory' | 'diary')
        : undefined;
      let queryVector: Float32Array | undefined;
      try {
        queryVector = await this.o.embedQuery?.(query, signal);
      } catch (error) {
        if (signal.aborted) throw error;
        queryVector = undefined;
      }
      hits = store.search(peer, query, 8, kind, queryVector, this.o.embeddingModel?.() ?? '');
      if (kind === 'memory' && hits.length)
        store.markMemoriesUsed(
          peer,
          hits.map((h) => h.id),
        );
    } else if (name === 'read_history') {
      if (!Array.isArray(args.ids)) throw new Error('请提供来源 ID 数组');
      hits = store.sources(
        peer,
        args.ids.filter((s): s is string => typeof s === 'string').slice(0, 8),
      );
      const neighbors: SearchHit[] = [];
      for (const hit of hits.filter((h) => h.kind === 'message')) {
        const msg = store.getMessage(peer, hit.id);
        if (!msg) continue;
        neighbors.push(
          ...store.history(peer, 3, msg.seq + 1).map((m) => ({
            id: m.id,
            kind: 'message' as const,
            role: m.role,
            content: renderMessage(m, this.o.timeZone()),
            created_at: m.created_at,
            score: 1,
          })),
        );
      }
      hits = [...new Map([...hits, ...neighbors].map((h) => [h.id, h])).values()];
    } else if (name === 'web_search')
      return this.o.web.search(
        String(args.query ?? ''),
        typeof args.freshness === 'string' ? args.freshness : undefined,
        signal,
      );
    else if (name === 'open_page') return this.o.web.open(String(args.url ?? ''), signal);
    else if (SANDBOX_TOOLS.some((t) => t.name === name)) {
      const sandbox = this.o.sandbox;
      // Reachability check, not just a schema check: a hallucinated call while
      // the switch is off must fail loudly instead of running anything.
      if (!sandbox?.enabled) throw new Error('沙箱未启用，无法执行该操作');
      const pathArg = () => String(args.path ?? '').trim();
      if (name === 'run_command') return sandbox.run(String(args.command ?? ''), signal);
      if (name === 'write_file') return sandbox.write(pathArg(), String(args.content ?? ''));
      if (name === 'read_file') return sandbox.read(pathArg());
      return sandbox.list(pathArg());
    } else throw new Error('未知工具');
    hits = hits.slice(0, 12).map((h) => ({ ...h, content: h.content.slice(0, 1600) }));
    hits.forEach((h) => available.add(h.id));
    return hits;
  }
  async reflect(task: Task, signal: AbortSignal): Promise<void> {
    const { store } = this.o;
    const peer = store.peer(task.peer_id);
    if (!peer) {
      store.finish(task.id);
      return;
    }
    const through = Number(task.payload.through ?? Number.MAX_SAFE_INTEGER);
    const after = task.kind === 'notes' ? peer.notes_until : Number(task.payload.after ?? 0);
    let messages = store.historyAfter(peer.id, after, through, 200);
    if (Array.isArray(task.payload.ids)) {
      const ids = new Set(task.payload.ids);
      messages = messages.filter((m) => ids.has(m.id));
    }
    const kind = task.kind === 'notes' ? 'context_notes' : 'diary';
    const prompt =
      (kind === 'diary'
        ? (this.o.personaFor?.(peer.id) ?? this.o.prompt('persona')) + '\n\n'
        : '') + this.o.prompt(kind);
    const budget = this.o.contextTokens();
    const notes = trimToTokens(peer.notes, Math.min(NOTES_MAX_TOKENS, budget * PROMPT_NOTES_SHARE));
    const memories = store.rankedMemories(peer.id, 12);
    let memoriesTokens = estimateTextTokens(renderMemories(memories));
    const memoryBudget = Math.min(PROMPT_MEMORY_MAX_TOKENS, budget * PROMPT_MEMORY_SHARE);
    while (memories.length && memoriesTokens > memoryBudget) {
      memoriesTokens -= estimateTextTokens(renderMemories([memories.pop()!]) + '\n');
    }
    const background = `日期：${String(task.payload.day ?? '')}\n当前话题笔记：${notes}\n已知认识：\n${renderMemories(memories)}\n本次原始记录：\n`;
    const availableTokens =
      budget -
      estimateRequestTokens([
        { role: 'system', content: prompt },
        { role: 'user', content: background },
      ]) -
      64;
    const input: Message[] = [];
    let count = 0;
    for (const m of messages) {
      const size = estimateTextTokens(`${m.role} ${renderMessage(m)}\n\n`);
      if (count + size <= availableTokens) {
        input.push(m);
        count += size;
        continue;
      }
      if (input.length) break;
      // The oldest unprocessed message alone exceeds the remaining budget.
      // Including it whole used to blow the request budget on every retry, so
      // the diary task could never advance its cursor. Keep a bounded excerpt
      // and let the cursor move past this message.
      const room = Math.max(16, availableTokens - 64);
      const clipped: Message = {
        ...m,
        content: trimToTokens(m.content, room),
        media: [],
      };
      input.push(clipped);
      break;
    }
    if (!input.length) {
      store.finish(task.id);
      return;
    }
    const content = background + input.map((m) => `${m.role} ${renderMessage(m)}`).join('\n\n');
    const completion = await this.complete(
      task,
      [
        { role: 'system', content: prompt },
        { role: 'user', content },
      ],
      [],
      signal,
      // No per-call override: HttpModel caps it at the configured max output
      // anyway, so the old hard-coded 4000 was silently a 3000-token request.
    );
    const raw = parseJson(completion.text);
    if (kind === 'context_notes') {
      if (typeof raw.notes !== 'string') throw new Error('话题笔记格式无效');
      store.setNotes(task, raw.notes, input.at(-1)!.seq);
      return;
    }
    if (!Array.isArray(raw.sections)) throw new Error('日记格式无效');
    const available = new Set(input.map((m) => m.id));
    const sections = raw.sections
      .slice(0, DIARY_MAX_SECTIONS)
      .filter(
        (s: any) =>
          typeof s?.content === 'string' &&
          Array.isArray(s.sources) &&
          s.sources.length &&
          s.sources.every((id: unknown) => typeof id === 'string' && available.has(id)),
      )
      .map((s: any) => ({
        content: s.content.slice(0, 5000),
        sources: [...new Set(s.sources)] as string[],
      }));
    // diary.md explicitly allows an empty sections array for a day with
    // nothing worth recording; that is a valid answer, not a format failure.
    // A non-empty array that lost every section to source validation is.
    if (raw.sections.length && !sections.length) throw new Error('日记缺少有效来源');
    const updates = this.filteredUpdates(
      parseMemories(raw.memoryUpdates),
      new Set([...available, ...store.memories(peer.id).map((m) => m.id)]),
    );
    store.saveDiary(
      { ...task, payload: { ...task.payload, through: input.at(-1)!.seq } },
      String(task.payload.day),
      sections,
      updates,
    );
  }
}
