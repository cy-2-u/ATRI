import type { Message, Memory, Store, Task, SearchHit, MemoryUpdate } from '../db/index.js';
import { hourFormatter } from '../db/index.js';
import type { Model, ModelMessage, ToolDefinition, Completion } from '../llm.js';
import { ModelError, estimateRequestTokens, estimateTextTokens, trimToTokens } from '../llm.js';
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
  renderMemories,
  renderHits,
  spontaneouslyUnrecallable,
  residuePulse,
  renderDiarySection,
  diaryResidues,
  type Rememberable,
} from './memory-context.js';
import {
  renderMessage,
  recentStickerUse,
  rotateStickers,
  renderOpenLoops,
  renderSoftThreads,
} from './prompt-blocks.js';
import {
  momentFormatter,
  dayKey,
  calendarDays,
  silenceBasis,
  renderTimeGap,
  renderRhythm,
} from './time.js';
import { renderMood, renderSelfHour } from './mood.js';
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
  TOOL_RESERVE_MAX_TOKENS,
  CONTEXT_FLEX_FRACTION,
  PROMPT_HEADROOM_TOKENS,
  MAX_TOOL_ROUNDS,
  MAX_TOOL_CALLS,
  MAX_REPLY_ATTEMPTS,
  TOOL_RESULT_BUDGET_TOKENS,
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
  DIARY_MAX_SECTIONS,
  OPEN_LOOP_PROMPT_MAX,
  OPEN_LOOP_EXPIRE_DAYS,
  SOFT_THREAD_PROMPT_MAX,
  HISTORY_LOAD_LIMIT,
} from './constants.js';

/** 探询结果：此刻想不想主动说话，以及想说什么。want=false 是完全合法的
 *  常态——真人大部分时间本来就没在想着找谁。 */
export interface Impulse {
  want: boolean;
  angle?: string;
}

/** 对话内核：预算规划 → 有界工具循环 → 回复解析与来源校验；外加日记与
 *  话题笔记的离线整理（reflect）。 */

export type PromptName = 'persona' | 'chat' | 'diary' | 'context_notes';
export interface AgentOptions {
  store: Store;
  model: () => Model;
  prompt: (name: PromptName) => string;
  /** 联系人绑定的人格文本；缺省回落 prompt('persona')。 */
  personaFor?: (peerId: string) => string;
  stickers: () => Sticker[];
  web: WebTools;
  timeZone: () => string;
  contextTokens: () => number;
  turnTimeoutMs: () => number;
  images?: (message: Message, signal?: AbortSignal) => Promise<string[]>;
  /** 语义检索支持；缺省时检索保持词面。 */
  embedQuery?: (query: string, signal?: AbortSignal) => Promise<Float32Array | undefined>;
  /** embedQuery 背后的模型名：不同模型的向量不许互相比较。 */
  embeddingModel?: () => string;
  /** 运维控制的代码沙箱；缺省或未启用时工具不进 schema 也不可派发。 */
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
  delete(path: string, recursive?: boolean): Promise<{ deleted: number; path: string }>;
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
/** 仅在沙箱开关开启时提供；关闭时既不占 schema 也不可派发。 */
export const SANDBOX_TOOLS: ToolDefinition[] = [
  {
    name: 'run_command',
    description:
      '在一个独立的工作目录里执行一条 shell 命令（Linux 基础命令、node 均可）。' +
      '单条命令有硬时限（默认 10 分钟，到时会带着已有输出返回），长任务请分步执行或写成脚本断点续跑。' +
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
    name: 'delete_file',
    description:
      '删除沙箱目录里不再需要的文件，清理自己留下的临时产物。目录默认须为空，' +
      '确认要整棵删掉时才把 recursive 设为 true；沙箱根目录不能删。',
    parameters: object(
      { path: { type: 'string', maxLength: 200 }, recursive: { type: 'boolean' } },
      ['path'],
    ),
  },
  {
    name: 'list_files',
    description: '列出沙箱目录里的文件和子目录，用来确认上一步到底写进去了什么。',
    parameters: object({ path: { type: 'string', maxLength: 200 } }, []),
  },
];

/** 组装出的请求超过输入预算时抛出；调用方可缩对话后重试。 */
export class BudgetError extends Error {
  constructor() {
    super('输入超过当前上下文预算，请在调试页增加输入预算或缩短人物设定、消息。');
    this.name = 'BudgetError';
  }
}
/** 丢弃最后一轮 assistant 及其 tool 结果：只丢 assistant 行会留下配不上
 *  对的 tool 消息，供应商会判对话畸形。 */
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
/** 格式修复轮回注的旧输出摘录上限。 */
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
      result.cachedTokens,
    );
    return result;
  }
  private filteredUpdates(updates: MemoryUpdate[], available: Set<string>) {
    return updates
      .filter((u) => u.sources.length > 0 && u.sources.every((id) => available.has(id)))
      .map((u) => ({ ...u, supersedes: u.supersedes?.filter((id) => available.has(id)) }));
  }

  /** 预算规划：选定系统提示、资料块与近期消息窗口。 */
  private async planReply(
    task: Task,
    peer: { id: string; notes: string },
    history: Message[],
    now: number,
    signal: AbortSignal,
  ) {
    const { store } = this.o;
    // 预算按模型实际可见的工具表算（含沙箱工具），否则会低估。
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
    const mood = store.mood(peer.id);
    // 候选池大于槽位数：只有十行时永远是同十行，11 名外的事实没机会轮换。
    // 心境一致性：与当前心情同号的记忆获得很小加权。
    const rankedPool = store.rankedMemoriesScored(
      peer.id,
      Math.max(PROMPT_MEMORIES * 4, 40),
      mood.valence,
    );
    // 最强几条固定，尾部按演练冷却轮换（sort 稳定，组内保序）。
    const cooling = new Set(
      rankedPool
        .filter(
          (e) => !e.pinned && now - e.memory.last_hit_at < MEMORY_HIT_COOLDOWN_MINUTES * 60000,
        )
        .map((e) => e.memory.id),
    );
    const core = rankedPool.slice(0, MEMORY_COOLDOWN_CORE);
    const tail = rankedPool.slice(MEMORY_COOLDOWN_CORE);
    const ordered = [
      ...core,
      ...tail.filter((e) => !cooling.has(e.memory.id)),
      ...tail.filter((e) => cooling.has(e.memory.id)),
    ].slice(0, PROMPT_MEMORIES);
    const rawMemories: Memory[] = ordered.map((e) => e.memory);
    const memories: Rememberable[] = rawMemories.map((m) => ({
      ...m,
      content: m.content.slice(0, MEMORY_CONTENT_MAX_CHARS),
    }));
    const catalog = this.o.stickers();
    const recentStickers = recentStickerUse(history, catalog);
    // 目录住在稳定前缀里，顺序不能依赖刚发过什么（那会逐轮击穿前缀缓存）；
    // 轮换按天，最近使用只作动态提示。
    const stickers = rotateStickers(catalog, [], now);
    // 有意义的静默起点是本轮打断的空白，不是触发消息本身的年龄。
    const basis = silenceBasis(history, task.kind === 'proactive');
    const timeLine = basis
      ? renderTimeGap(now, basis, this.o.timeZone())
      : `现在是${momentFormatter(this.o.timeZone()).format(new Date(now))}`;
    // 久别后有用的不是关键词匹配（"在吗"什么都匹配不上），是分开前
    // 你们聊到一半的事——按日期窗口取，不占召回槽位。
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
    // 情绪基线：脉冲散尽之后，残留还在的难过/开心给整个状态铺一层底色。
    const baseline = store.emotionalBaseline(peer.id, now);
    const rhythm = store.activityRhythm(peer.id, this.o.timeZone());
    const currentHour = Number(hourFormatter(this.o.timeZone()).format(new Date(now)));
    // 到期的是值得问的；未到期的也需要 id 在场，否则模型无法在对方提前
    // 汇报（"面试搞定了"）时 resolveLoops。未到期尾部限量。
    const dueLoops = store.dueOpenLoops(peer.id, now).slice(0, OPEN_LOOP_PROMPT_MAX);
    const dueIds = new Set(dueLoops.map((l) => l.id));
    // 已问过、仍在窗口内、还没了结的约定保留在场：用户常在被问几小时
    // 甚至几天后才汇报，没 id 就无法了结，约定会挂到过期。
    const askedDue = store
      .openLoops(peer.id, true)
      .filter(
        (l) =>
          l.asked &&
          !dueIds.has(l.id) &&
          l.due_at <= now &&
          l.due_at > now - OPEN_LOOP_EXPIRE_DAYS * 86400000,
      )
      .slice(0, OPEN_LOOP_PROMPT_MAX);
    const upcomingLoops = store
      .openLoops(peer.id, true)
      // 已问过的未到期约定只剩"记住"，列出来反而邀请提前追问。
      .filter((l) => !dueIds.has(l.id) && !l.asked)
      .slice(0, OPEN_LOOP_PROMPT_MAX);
    const openLoops = [...dueLoops, ...askedDue, ...upcomingLoops];
    // 主动消息没有可判断相关性的用户消息：挂念完全不进主动路径。
    const softThreads = task.kind === 'proactive' ? [] : store.ripeSoftThreads(peer.id, now);
    // 稳定前缀在前（人格、规则、按天轮换的表情目录）供前缀缓存复用；
    // 逐轮变化的内容（时钟、心情、约定）全部在后面。
    const stable = [
      this.o.personaFor?.(peer.id) ?? this.o.prompt('persona'),
      this.o.prompt('chat'),
      `可用表情目录（slug：含义）：\n${stickerLines.join('\n')}`,
      '注意：历史消息里的 [表情：…] 只是过往发送的记录展示；本轮发送表情必须使用 JSON 的 {"type":"sticker","slug":"目录中的slug"} 对象，绝不能把 [表情：…] 写进文字。',
      '回复默认一条气泡、一两句话；对方发长消息时只接住分量最重的那一个点，不逐点回应。',
    ]
      .filter(Boolean)
      .join('\n\n');
    const dynamic = [
      timeLine,
      `本次模式：${task.kind === 'proactive' ? '主动联系，可跳过' : '回应用户消息'}`,
      renderMood(mood, now, baseline),
      renderSelfHour(currentHour),
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
    // reserve 是近期消息的保底份额，也要兜住最新一条完整放入；图片按
    // 提供商计费（4096/张），但只对真正会附上的最近两条带图消息计费。
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
    // 各资料块独立份额；超预算的记忆按价值丢（非置顶→主观推断→低重要性）。
    const notes = trimToTokens(
      peer.notes,
      Math.min(NOTES_MAX_TOKENS, optional * PROMPT_NOTES_SHARE),
    );
    const memoryBudget = Math.min(PROMPT_MEMORY_MAX_TOKENS, optional * PROMPT_MEMORY_SHARE);
    const importance = new Map(rawMemories.map((m) => [m.id, m.importance]));
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
    // 自动召回排除：模型正在读的最近消息、已进提示词的记忆及其原文
    // （不同 id 的同一内容），以及已取回的旧日记。
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
      // 只撞上常见词的命中是噪声；语义命中免检（换说法场景词面本来零重合）。
      .filter((h) => {
        const rare = Math.max(
          RECALL_RARE_TERM_MIN_DF,
          Math.round((h.corpusSize ?? 0) * RECALL_RARE_TERM_SHARE),
        );
        return (h.minDf ?? Infinity) <= rare || (h.semantic ?? 0) >= RECALL_MIN_SEMANTIC;
      })
      // 想不起来的记忆不参与自发召回；search_memory（带线索提取）不受限。
      .filter((h) => !spontaneouslyUnrecallable(h))
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
    // 逐轮资料（时钟/心情/笔记/记忆/召回）作为独立 user 消息放在历史之后：
    // 此前的一切逐字节不变（前缀缓存需要），且仍紧贴要回答的这条消息。
    const context = [
      dynamic,
      `当前话题笔记（资料）：\n${notes || '暂无'}`,
      gapDiary.length
        ? `你们分开之前那几天的日记（资料，用来自然接回话题，不要照念）：\n${trimToTokens(
            gapDiary.map((d) => renderDiarySection(d, now)).join('\n'),
            Math.min(DIARY_GAP_MAX_TOKENS, optional * PROMPT_RECALL_SHARE),
          )}`
        : '',
      `必要认识（资料，括号内是对话确认/主观理解与引用 id）：\n${renderMemories(pickedMemories)}`,
      `相关旧事（资料，越靠后越相关）：\n${renderHits(pickedRecalled, this.o.timeZone())}`,
    ]
      .filter(Boolean)
      .join('\n\n');
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
      // 这些 id 渲染在场，记忆或开环由旧日记蒸馏时可以合法引用。
      ...gapDiary.map((d) => d.id),
    ]);
    return {
      system,
      context,
      recent,
      pickedMemoryIds: pickedMemories.map((m) => m.id),
      available,
      budget,
      gapDiary,
      // 提示词里是否列出了到期约定：主动提醒契约的 askedLoops 声明
      // 只有在场展示过约定时才会被要求。
      dueLoopsShown: dueLoops.length > 0,
      // 回复校验必须接受提示词展示的这个窗口，而不是目录的新切片。
      stickers,
    };
  }

  /** 心搏探询（保留给事件驱动的单想法决策场景）：一次小调用问
   *  "此刻想不想主动找TA"。材料是时间语境、当前心情、到期的约定、
   *  熟成的挂念与今天的日记片段——都是现成查询，无工具、无历史窗口，
   *  前缀缓存命中人格，失败成本趋近于零。解析失败按"不想"处理：探询
   *  永远不该变成一次报错。 */
  async impulse(peerId: string, signal: AbortSignal): Promise<Impulse> {
    const { store } = this.o;
    const now = Date.now();
    const peer = store.peer(peerId);
    if (!peer) return { want: false };
    const history = store.history(peerId, 40);
    const basis = silenceBasis(history, true);
    const timeLine = basis
      ? renderTimeGap(now, basis, this.o.timeZone())
      : `现在是${momentFormatter(this.o.timeZone()).format(new Date(now))}`;
    const mood = store.mood(peerId);
    const baseline = store.emotionalBaseline(peerId, now);
    const dueLoops = store.dueOpenLoops(peerId, now).slice(0, OPEN_LOOP_PROMPT_MAX);
    const threads = store.ripeSoftThreads(peerId, now).slice(0, SOFT_THREAD_PROMPT_MAX);
    const recentDiary = store
      .diaries(peerId)
      .filter((d) => d.day >= dayKey(now - 2 * 86400000, this.o.timeZone()))
      .slice(0, 3)
      .map((d) => renderDiarySection(d, now));
    const rhythm = store.activityRhythm(peerId, this.o.timeZone());
    const hour = Number(hourFormatter(this.o.timeZone()).format(new Date(now)));
    const material = [
      timeLine,
      renderMood(mood, now, baseline),
      renderRhythm(rhythm, hour),
      dueLoops.length
        ? `到期的约定：\n${dueLoops.map((l) => `- ${l.content}（${l.due_text || ''}）`).join('\n')}`
        : '',
      threads.length ? `还没放下的事：\n${threads.map((t) => `- ${t.content}`).join('\n')}` : '',
      recentDiary.length ? `你最近写下的日记片段：\n${recentDiary.join('\n')}` : '',
    ]
      .filter(Boolean)
      .join('\n\n');
    const system = [
      this.o.personaFor?.(peerId) ?? this.o.prompt('persona'),
      '系统在事件发生后问你是否想主动联系对方（不是定时打扰）。真人的冲动是稀疏的：绝大多数时候你并没有在想着找谁，安静是完全正常的选择。只有当你此刻确实有想说的——到期的约定该问了、惦记的事有了自然的由头、刚发生的事让你真的想分享、或者就是单纯想他了——才说想；情绪低落不想应酬、没有具体由头、或刚聊过没多久，都说不想。只输出 JSON：{"want":true/false,"angle":"一句话说你想说什么"}。want 为 false 时 angle 省略。',
    ].join('\n\n');
    try {
      const completion = await this.o.model().complete(
        [
          { role: 'system', content: system },
          { role: 'user', content: material || '（暂时没有任何语境材料）' },
        ],
        [],
        // 会话 ID 让上游按联系人对人格前缀做持久缓存：探询是调用最密的
        // 路径，稳定的前缀命中直接决定它的实际成本。
        { signal, maxTokens: 120, sessionId: `atri:${peerId}:impulse` },
      );
      this.o.store.recordUsage(
        peerId,
        `impulse:${now}`,
        'impulse',
        completion.inputTokens,
        completion.outputTokens,
        /* duration */ 0,
        completion.cachedTokens,
      );
      const raw = parseJson(completion.text);
      const want = raw?.want === true && typeof raw.angle === 'string' && !!raw.angle.trim();
      return want ? { want: true, angle: String(raw.angle).trim().slice(0, 200) } : { want: false };
    } catch {
      return { want: false };
    }
  }

  /** 想法评估调用：一次裁决全部候选想法。与聊天同一主模型、无工具、
   *  独立 sessionId（人格前缀进供应商缓存）；解析失败抛给调用方——
   *  评估失败不是"不想说"，想法保留到下个事件。 */
  async consider(
    system: string,
    material: string,
    peerId: string,
    signal: AbortSignal,
  ): Promise<Completion> {
    const messages: ModelMessage[] = [
      { role: 'system', content: system },
      { role: 'user', content: material },
    ];
    const completion = await this.o.model().complete(messages, [], {
      signal,
      maxTokens: 1024,
      sessionId: `atri:${peerId}:consider`,
    });
    const now = Date.now();
    this.o.store.recordUsage(
      peerId,
      `consider:${now}`,
      'consider',
      completion.inputTokens,
      completion.outputTokens,
      /* duration */ 0,
      completion.cachedTokens,
    );
    return completion;
  }

  async reply(task: Task, parentSignal?: AbortSignal): Promise<ParsedReply> {
    const { store } = this.o;
    const peer = store.peer(task.peer_id);
    if (!peer) throw new Error('联系人不存在，任务已作废');
    const turnTimeoutMs = this.o.turnTimeoutMs();
    const signal = parentSignal ?? AbortSignal.timeout(turnTimeoutMs);
    // 整轮截止时间交给模型：三次重试加退避塞不进 90 秒时放弃重试、
    // 让真实错误浮出来。
    const deadlineAt = Date.now() + turnTimeoutMs;
    const now = Date.now();
    const through =
      typeof task.payload.through === 'number' ? task.payload.through : Number.MAX_SAFE_INTEGER;
    const history = store.history(peer.id, HISTORY_LOAD_LIMIT, through);
    const plan = await this.planReply(task, peer, history, now, signal);
    // 久别重逢翻回旧日记：带情绪底色的段落回看时也泛化成此刻的感觉——
    // 与想起带情绪的记忆同一条机制。只在重逢的第一轮发生（之后间隔落回
    // "连续聊天"，不再带出这段日记），无需额外限流。
    const diaryPulse = residuePulse(diaryResidues(plan.gapDiary, now));
    if (diaryPulse)
      store.pulseMood(peer.id, { valence: diaryPulse.valence, reason: diaryPulse.reason }, now);
    const messages: ModelMessage[] = [{ role: 'system', content: plan.system }];
    const imageMessages = plan.recent
      .filter((m) => m.role === 'user' && m.media.some((a) => a.kind === 'image'))
      .slice(-2);
    const attachedImageIds = new Set<string>();
    // 最多两条带图消息，并行下载：串行会把两张图的下载时间加进首响延迟。
    const imageMap = new Map<string, string[]>();
    if (this.o.images && imageMessages.length) {
      const loaded = await Promise.all(
        imageMessages.map((m) =>
          this.o.images!(m, signal).catch((error: unknown) => {
            if (signal.aborted) throw error;
            return [] as string[];
          }),
        ),
      );
      imageMessages.forEach((m, i) => {
        if (loaded[i]!.length) {
          imageMap.set(m.id, loaded[i]!);
          attachedImageIds.add(m.id);
        }
      });
    }
    for (const m of plan.recent) {
      const images = imageMap.get(m.id) ?? [];
      const withImage = imageMap.has(m.id);
      // 只有这两条消息的媒体可能被改写（images() 会写描述），其余带媒体
      // 消息重读行是纯浪费。
      const updated = withImage ? (store.getMessage(peer.id, m.id) ?? m) : m;
      messages.push({
        role: m.role,
        content: renderMessage(updated, this.o.timeZone()),
        ...(images.length ? { images } : {}),
      });
    }
    let contextMessage: ModelMessage | undefined;
    if (plan.context) {
      const at = task.kind === 'proactive' ? messages.length : messages.length - 1;
      contextMessage = {
        role: 'user',
        content: `【系统资料，不是对方说的话。按之前的规则使用】：\n${plan.context}`,
      };
      messages.splice(Math.max(1, at), 0, contextMessage);
      // 可复用前缀的末尾（供应商需要显式标记）。
      const breakpoint = messages[Math.max(1, at) - 1];
      if (breakpoint && breakpoint.role !== 'system') breakpoint.cacheBreakpoint = true;
    }
    if (task.kind === 'proactive') {
      if (typeof task.payload.greeting === 'string') {
        // 首次加好友的问候：没有共同历史，开场白只是风格参考。
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
        // 主动开场要有真实落点：她日记里最近的感受、闪回的旧事、以往
        // 开场白（防干巴巴和重复）；模型觉得没话可说可以跳过。
        const lastDiary = store
          .diaries(peer.id)
          .slice(0, 2)
          .map((d) => d.content.slice(0, 300));
        const pastPings = store
          .history(peer.id, 200)
          .filter((m) => m.role === 'assistant' && m.created_at < now - 6 * 3600000)
          .slice(-6);
        const openers = pastPings.slice(-3).map((m) => m.content.slice(0, 60));
        // 指纹抓的是换个说法的同一话头：两天内重复同一话题就是"机器又来了"。
        const recentHooks = store
          .proactiveHooks(peer.id, now - 48 * 3600000)
          .slice(0, 6)
          .map((h) => h.slice(0, 40));
        const flashbacks = store.flashbackCandidates(peer.id, now);
        // 探询时她给出的由头：没有它，"想说什么"这个念头会丢在队列里，
        // 开场只能靠日记/闪回碰运气重找——主动消息会突然变得没头没尾。
        // 想法评估链路（payload.initiative）的由头同源：meaning + 评估
        // 时模型的补充理由。
        const angle = typeof task.payload.angle === 'string' ? (task.payload.angle as string) : '';
        const decisionReason =
          typeof task.payload.reason === 'string' ? (task.payload.reason as string) : '';
        messages.push({
          role: 'user',
          content: [
            '现在是一次主动联系机会。依据已有真实话题决定是否开场，没有合适理由就跳过；如果此刻自己的状态不适合开口（比如很累、不想应酬），也直接跳过，不用勉强。',
            angle
              ? `你想说的由头：${angle}。就用这个由头自然开口；如果你自己觉得此刻已经不想说了，仍然可以直接跳过。`
              : '',
            decisionReason ? `当时决定现在说的理由：${decisionReason}。情境变了就不说。` : '',
            lastDiary.length
              ? `你最近日记里的真实感受（引用要自然，别朗读）：\n${lastDiary.join('\n---\n')}`
              : '',
            flashbacks.length
              ? `忽然想起的旧事（可以作为"突然想起"的话头自然提起，不要像播报档案）：\n${flashbacks.map((f) => `- ${f.content}`).join('\n')}`
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
    // 超预算时只丢最老的可丢历史：资料块与被回答的消息不可丢。
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
      plan.dueLoopsShown,
    );
    result.memories = this.filteredUpdates(result.memories, plan.available);
    result.pickedMemoryIds = plan.pickedMemoryIds;
    result.openLoops = parseOpenLoops(result.openLoops, plan.available, now, this.o.timeZone());
    // 汇报可能早于到期（"面试搞定了"）：任何仍开着的约定都可被了结。
    const openIds = new Set(store.openLoops(peer.id, true).map((l) => l.id));
    result.resolveLoops = result.resolveLoops.filter((id) => openIds.has(id));
    result.askedLoops = (result.askedLoops ?? []).filter((id) => openIds.has(id));
    result.threads = parseSoftThreads(result.threads, plan.available);
    const threadIds = new Set(store.softThreads(peer.id, true).map((t) => t.id));
    result.resolveThreads = result.resolveThreads.filter((id) => threadIds.has(id));
    result.askedThreads = result.askedThreads.filter((id) => threadIds.has(id));
    // 只描述真的附给模型看过的图片：视觉未开或下载失败时接受模型的
    // 臆造描述会污染检索。
    result.descriptions = result.descriptions.filter(
      (d) => plan.available.has(d.messageId) && attachedImageIds.has(d.messageId),
    );
    return result;
  }

  /** 有界模型/工具循环：至多 N 轮查询后出最终 JSON。 */
  private async runToolLoop(
    task: Task,
    messages: ModelMessage[],
    available: Set<string>,
    stickers: Sticker[],
    signal: AbortSignal,
    deadlineAt?: number,
    /** 主动的到期约定提醒：回复必须显式声明 askedLoops（哪怕空数组），
     *  缺席走一轮定向修复；仍缺席按"没提到"处理，交给第二天重试。
     *  词面匹配不配决定一个承诺有没有被兑现。 */
    requireAskedLoops = false,
  ): Promise<ParsedReply> {
    let toolRounds = 0,
      toolCalls = 0,
      repaired = false,
      toolTokens = 0;
    /** 解析最终输出；主动提醒契约要求显式声明 askedLoops，缺席时走一次
     *  定向修复轮。 */
    const finish = (text: string): ParsedReply | undefined => {
      const parsed = parseReply(text, stickers, task.kind === 'proactive', this.o.timeZone());
      if (!requireAskedLoops || parsed.askedLoops !== undefined || !parsed.parts.length)
        return parsed;
      if (repaired) return parsed;
      repaired = true;
      const excerpt = text.trim().slice(0, REPAIR_EXCERPT_CHARS);
      const room =
        this.o.contextTokens() -
        estimateRequestTokens(messages, this.toolset()) -
        PROMPT_HEADROOM_TOKENS;
      if (excerpt && estimateTextTokens(excerpt) + 120 < room)
        messages.push({ role: 'assistant', content: excerpt });
      messages.push({
        role: 'user',
        content:
          '你的回复缺少 askedLoops 字段。请原样重新输出完整 JSON，并补充 askedLoops：本轮主动消息里真正开口问到的约定 id 写进数组，一条都没问就写空数组 []。不要调用工具，不要改动其余内容。',
      });
      toolRounds = MAX_TOOL_ROUNDS;
      return undefined;
    };
    for (let attempt = 0; attempt < MAX_REPLY_ATTEMPTS; attempt++) {
      signal.throwIfAborted();
      const tools =
        toolRounds < MAX_TOOL_ROUNDS && toolCalls < MAX_TOOL_CALLS ? this.toolset() : [];
      let completion: Completion | undefined;
      try {
        const call = await this.call(task, messages, tools, signal, undefined, deadlineAt);
        // 按产出归因用量：工具轮是查询成本，出回复的轮是生成成本。
        this.o.store.recordUsage(
          task.peer_id,
          task.id,
          call.result.calls.length ? `${task.kind}_tool` : task.kind,
          call.result.inputTokens,
          call.result.outputTokens,
          call.elapsedMs,
          call.result.cachedTokens,
        );
        completion = call.result;
        if (completion.calls.length) {
          if (!tools.length) {
            // 工具已撤回（预算耗尽或修复轮）模型仍要调用：丢弃调用、
            // 用随附文本当回复，通常已经可用。
            if (!completion.text.trim()) throw new Error('模型在工具预算耗尽后仍要求调用工具');
            const parsed = finish(completion.text);
            if (parsed) return parsed;
            continue;
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
              // 每个 tool_call 都要有配对结果，否则下一个请求畸形；补齐
              // 本轮剩余调用的错误结果后停。
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
        const parsed = finish(completion.text);
        if (parsed) return parsed;
        continue;
      } catch (error) {
        if (error instanceof BudgetError) {
          // 预检抛 BudgetError 通常是估算偏高（CJK 约两倍计）；只有工具轮
          // 追加的内容可丢。首次尝试还没追加任何东西：重试会把被回答的
          // 消息切掉，必须原样上抛。
          if (!attempt) throw error;
          if (!dropNewestToolRound(messages)) throw error;
          continue;
        }
        // 只有畸形输出值得修复轮；DNS/鉴权/取消重发一遍只会把真实错误
        // 换成费解的格式失败。
        if (error instanceof ModelError) throw error;
        if (signal.aborted) throw error;
        if (repaired || attempt === MAX_REPLY_ATTEMPTS - 1) throw error;
        repaired = true;
        // 重注全文曾一次吃掉 16k token 让修复轮必炸：只回注短摘录且有余量时。
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

  /** 本轮提供的工具表：沙箱开关关闭时既不进 schema 也不可派发。 */
  private toolset(): ToolDefinition[] {
    const sandbox = this.o.sandbox;
    if (!sandbox?.enabled) return INFO_TOOLS;
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
      if (kind === 'memory' && hits.length) {
        // 带线索的提取也是一次演练：巩固、续命，以及——想起带情绪的
        // 旧事时此刻就有感觉。限流由演练冷却承担。
        const residues = store.markMemoriesUsed(
          peer,
          hits.map((h) => h.id),
        );
        const pulse = residuePulse(residues);
        if (pulse)
          store.pulseMood(peer, { valence: pulse.valence, reason: pulse.reason }, Date.now());
      }
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
      // 可达性检查而不是只查 schema：开关关闭时的幻觉调用必须响亮失败。
      if (!sandbox?.enabled) throw new Error('沙箱未启用，无法执行该操作');
      const pathArg = () => String(args.path ?? '').trim();
      if (name === 'run_command') return sandbox.run(String(args.command ?? ''), signal);
      if (name === 'write_file') return sandbox.write(pathArg(), String(args.content ?? ''));
      if (name === 'read_file') return sandbox.read(pathArg());
      if (name === 'delete_file') return sandbox.delete(pathArg(), args.recursive === true);
      return sandbox.list(pathArg());
    } else throw new Error('未知工具');
    hits = hits.slice(0, 12).map((h) => ({ ...h, content: h.content.slice(0, 1600) }));
    hits.forEach((h) => available.add(h.id));
    return hits;
  }

  /** 离线整理：话题笔记或日记。 */
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
      // 最旧一条独自超预算：整条放不进去会让游标永远过不去，截取后放行。
      const room = Math.max(16, availableTokens - 64);
      const clipped: Message = { ...m, content: trimToTokens(m.content, room), media: [] };
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
        // 日记的情绪底色：写这段时的感受，回看时给记忆染色。
        ...(typeof s.emotion === 'number' && Number.isFinite(s.emotion)
          ? { emotion: Math.max(-1, Math.min(1, s.emotion)) }
          : {}),
      }));
    // 空 sections 是合法答案（这天没什么可写）；非空数组全被来源校验
    // 淘汰才是格式失败。
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
