import type { Message, Memory, Store, Task, SearchHit, MemoryUpdate } from '../db/index.js';
import { hourFormatter, CONSOLIDATION_PAIRS_MAX } from '../db/index.js';
import type { Model, ModelMessage, ToolDefinition, Completion } from '../llm.js';
import { ModelError, estimateRequestTokens, estimateTextTokens, trimToTokens } from '../llm.js';
import {
  parseJson,
  parseMemories,
  parseOpenLoops,
  parseReply,
  parsePulseOutput,
  parseSoftThreads,
  type Sticker,
  type ParsedReply,
  type ParsedPulse,
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
  renderOpenLoops,
  renderSoftThreads,
  renderSelfNow,
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
import { boredom, longing } from './motives.js';
import { renderMotives, isHisActiveHour, silenceNote } from './pulse.js';
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
  HISTORY_LOAD_LIMIT,
  PULSE_LIFE_LOG_ITEMS,
  PULSE_THOUGHTS_MAX,
  PULSE_HISTORY_LOAD,
  PERSONA_ANCHORS,
} from './constants.js';

/** 对话内核：预算规划 → 有界工具循环 → 输出解析与来源校验；外加日记、
 *  话题笔记与记忆整理的离线整理（reflect）。聊天与心跳共用同一套预算
 *  与工具机制，差别只在材料与输出契约。 */

export type PromptName = 'persona' | 'chat' | 'pulse' | 'diary' | 'context_notes' | 'consolidate';
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
    const isPulse = task.kind === 'pulse';
    const isBeat = isPulse && task.payload.beat === true;
    // 预算按模型实际可见的工具表算（含沙箱工具），否则会低估。
    const budgetTools = this.toolset();
    // 白日梦的查询是她的心事：beat 没有刚发生的用户消息可挂，用过时的
    // 旧消息当查询只会召回与当下无关的东西。用她存着的念头、挂念与
    // 此刻在做的事撑起检索——安静时想起旧事的人，是先有心事再撞见旧事。
    const query = isBeat
      ? [
          ...store
            .activeInitiatives(peer.id)
            .slice(0, PULSE_THOUGHTS_MAX)
            .map((i) => i.meaning),
          ...store.ripeSoftThreads(peer.id, now).map((t) => t.content),
          store.self().activity,
        ]
          .filter(Boolean)
          .join(' ')
          .slice(-RECALL_QUERY_MAX_CHARS)
      : history
          .filter((m) => m.role === 'user')
          .slice(-RECALL_QUERY_MESSAGES)
          .map((m) => m.content)
          .join(' ')
          .slice(-RECALL_QUERY_MAX_CHARS);
    let queryVector: Float32Array | undefined;
    // 向量检索每次查询要一次 embeddings API 调用：beat 一天几十拍，短查询
    // （几个念头拼起来）词面命中已经够用，不值得每拍都付这一次往返。
    const embedFloor = isBeat ? 24 : 1;
    try {
      queryVector =
        query.trim().length >= embedFloor ? await this.o.embedQuery?.(query, signal) : undefined;
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
    // 目录全量进提示词：住在稳定前缀里（顺序固定、不随时间变化），解析
    // 回复时模型能选的 slug 与提示词展示的完全一致，不会静默丢表情。

    // 有意义的静默起点是本轮打断的空白，不是触发消息本身的年龄。
    const basis = silenceBasis(history, isPulse);
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
    const stickerLines = catalog.map(({ slug, description }) => `${slug}：${description}`);
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
    const softThreads = isPulse ? [] : store.ripeSoftThreads(peer.id, now);
    // 心跳的独有材料：她的当下、生活流水、动机体感、想法池、读空气。
    const beatBlock = isBeat ? this.beatMaterial(peer.id, now, currentHour, rhythm) : '';
    // 稳定前缀在前（人格、规则、全量表情目录）供前缀缓存复用；
    // 逐轮变化的内容（时钟、心情、约定）全部在后面。
    const stable = [
      this.o.personaFor?.(peer.id) ?? this.o.prompt('persona'),
      this.o.prompt(isPulse ? 'pulse' : 'chat'),
      `可用表情目录（slug：含义）：\n${stickerLines.join('\n')}`,
      '注意：历史消息里的 [表情：…] 只是过往发送的记录展示；发送表情必须使用 JSON 的 {"type":"sticker","slug":"目录中的slug"} 对象，绝不能把 [表情：…] 写进文字。',
      '回复默认一条气泡、一两句话；对方发长消息时只接住分量最重的那一个点，不逐点回应。',
    ]
      .filter(Boolean)
      .join('\n\n');
    // 人格锚：按天轮换的行为重申（人格漂移的实证对策：会话中途的低频
    // 重申）。落在缓存断点之后的资料里，不碰逐字节稳定的 system 前缀。
    const anchorDay = dayKey(now, this.o.timeZone());
    let anchorHash = 0;
    for (let i = 0; i < anchorDay.length; i++)
      anchorHash = (anchorHash * 31 + anchorDay.charCodeAt(i)) | 0;
    const anchor = PERSONA_ANCHORS.length
      ? PERSONA_ANCHORS[Math.abs(anchorHash) % PERSONA_ANCHORS.length]!
      : '';
    const dynamic = [
      timeLine,
      `本次模式：${isPulse ? '她的意识自己冒出来的一拍（心跳），可以什么都不说' : '回应用户消息'}`,
      renderMood(mood, now, baseline),
      renderSelfHour(currentHour),
      anchor ? `人格锚（今天的重申，不是新规则）：${anchor}` : '',
      renderRhythm(rhythm, currentHour),
      renderOpenLoops(openLoops, now, this.o.timeZone()),
      renderSoftThreads(softThreads, now),
      beatBlock,
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
      // 白日梦用的召回命中（仅记忆行）：拍内演练与情绪泛化的输入。
      recalledMemoryIds: pickedRecalled.filter((h) => h.kind === 'memory').map((h) => h.id),
      available,
      budget,
      gapDiary,
      // 提示词里是否列出了到期约定：主动提醒契约的 askedLoops 声明
      // 只有在场展示过约定时才会被要求。
      dueLoopsShown: dueLoops.length > 0,
      // 回复校验必须与提示词展示的目录完全一致：目录全量在场，模型选
      // 任何目录里的 slug 都能解析。
      stickers: catalog,
      isPulse,
      isBeat,
    };
  }

  /** 心跳独有的材料块：她的当下、生活流水、动机体感、想法池、读空气。
   *  每一行都必须是真实数据——这套材料不许有任何"编造的生活"。 */
  private beatMaterial(peerId: string, now: number, currentHour: number, rhythm: number[]): string {
    const { store } = this.o;
    const sandbox = this.o.sandbox;
    const capability = sandbox?.enabled
      ? '你的手能用（工具里的 run_command/write_file 等都通向一个真实的工作目录）：可以真的做点事，做成的东西会记进你的生活流水；做成的图片（比如你跑脚本画的图）可以直接发给他——messages 里写 {"type":"image","path":"相对路径"}，先用 list_files 确认文件在。'
      : '你此刻没有手，只能想和说：读记忆、翻旧事、看看网上的东西都可以；想做而做不到的事就说"想做"，绝不说自己做了（沙箱关着，也没有图片可发）。';
    const self = store.self();
    const life = store
      .recentLife(PULSE_LIFE_LOG_ITEMS)
      .map((e) => {
        const at = momentFormatter(this.o.timeZone()).format(new Date(e.at));
        const tail = e.artifact ? `（产物：${e.artifact}）` : '';
        return `- ${at} ${e.text}${tail}`;
      })
      .join('\n');
    const minutesIdle = self.last_stimulus_at ? (now - self.last_stimulus_at) / 60000 : 9999;
    const feel = {
      bored: boredom(self.last_stimulus_at, now),
      miss: longing(store.lastSpokeAt(peerId), now, isHisActiveHour(rhythm, currentHour)),
      social: self.social,
      express: self.express,
    };
    const thoughts = store
      .activeInitiatives(peerId)
      .slice(0, PULSE_THOUGHTS_MAX)
      .map(
        (i) =>
          `- [id:${i.id}] ${i.meaning}${i.state === 'waiting' && i.origin ? `（在等：${i.origin}）` : ''}`,
      )
      .join('\n');
    const streak = store.unansweredPulseStreak(peerId);
    const hookList = store
      .proactiveHooks(peerId, now - 48 * 3600000)
      .slice(0, 6)
      .map((h) => h.slice(0, 40));
    return [
      capability,
      renderSelfNow(self, now, this.o.timeZone()),
      life
        ? `你的生活流水（都是你真实做过/看过的）：\n${life}`
        : '生活流水还是空的：你还没有做成过什么事。',
      self.pursuit
        ? `你最近在追的事：${self.pursuit}。可以让它真的长进——用 web 工具读一点相关的（真的看过才有的聊），这拍有收获就写进 activity；想更新说法写进 pursuit，不想追了把 pursuit 写成空字符串放下。`
        : '你还没有在追的事。人总有点自己的世界：此刻对什么有点好奇的话，就在 pursuit 里立一项（一句话就够），之后用 web 工具真的去看、去追。',
      `此刻的身体与心：${renderMotives(feel) || '平静，没有特别的倾向'}。`,
      `已经安静了 ${minutesIdle > 9000 ? '很久' : `${Math.round(minutesIdle)} 分钟`}。${silenceNote(minutesIdle)}`.trim(),
      thoughts
        ? `心里存着的念头（想说什么由你定；说了的会退场，不说的继续存着）：\n${thoughts}`
        : '',
      streak >= 2
        ? `你最近 ${streak} 次主动找他都没有得到回应。有点不想再自讨没趣了——这是你的感受，收不收、收多久，由你自己决定。`
        : '',
      hookList.length
        ? `最近两天你主动说过的话头：${hookList.join(' / ')}。换个由头，别重复自己。`
        : '',
    ]
      .filter(Boolean)
      .join('\n\n');
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
      const at = task.kind === 'pulse' ? messages.length : messages.length - 1;
      contextMessage = {
        role: 'user',
        content: `【系统资料，不是对方说的话。按之前的规则使用】：\n${plan.context}`,
      };
      messages.splice(Math.max(1, at), 0, contextMessage);
      // 可复用前缀的末尾（供应商需要显式标记）。
      const breakpoint = messages[Math.max(1, at) - 1];
      if (breakpoint && breakpoint.role !== 'system') breakpoint.cacheBreakpoint = true;
    }
    if (task.kind === 'pulse') {
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
        // 到期承诺的提醒：由头就是那条约定本身；模型觉得情境变了可以跳过。
        const angle = typeof task.payload.angle === 'string' ? (task.payload.angle as string) : '';
        const decisionReason =
          typeof task.payload.reason === 'string' ? (task.payload.reason as string) : '';
        const loopContent =
          typeof task.payload.loopContent === 'string' ? (task.payload.loopContent as string) : '';
        messages.push({
          role: 'user',
          content: [
            '现在是一次主动联系机会。依据已有真实话题决定是否开场，没有合适理由就跳过；如果此刻自己的状态不适合开口（比如很累、不想应酬），也直接跳过，不用勉强。',
            loopContent ? `你答应过/记着的事到时间了：${loopContent}。自然地开口问一句进展。` : '',
            angle ? `你想说的由头：${angle}。就用这个由头自然开口。` : '',
            decisionReason ? `当时决定现在说的理由：${decisionReason}。情境变了就不说。` : '',
            `最近两天已经提过的话题：${
              store
                .proactiveHooks(peer.id, now - 48 * 3600000)
                .slice(0, 6)
                .map((h) => h.slice(0, 40))
                .join(' / ') || '（无）'
            }。不要用同样的话题或句式。`,
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
    const result = await this.runLoop<ParsedReply>({
      task,
      messages,
      available: plan.available,
      stickers: plan.stickers,
      signal,
      deadlineAt,
      allowSkip: plan.isPulse,
      // 到期承诺的提醒契约：回复必须显式声明 askedLoops（哪怕空数组），
      // 缺席走一轮定向修复；仍缺席按"没提到"处理。词面匹配不配决定一个
      // 承诺有没有被兑现。
      parse: (text, canRepair) => {
        const parsed = parseReply(text, plan.stickers, plan.isPulse, this.o.timeZone());
        const requireAsked = plan.dueLoopsShown && !plan.isBeat;
        if (!requireAsked || parsed.askedLoops !== undefined || !parsed.parts.length)
          return { value: parsed };
        if (!canRepair) return { value: parsed };
        return {
          repair:
            '你的回复缺少 askedLoops 字段。请原样重新输出完整 JSON，并补充 askedLoops：本轮主动消息里真正开口问到的约定 id 写进数组，一条都没问就写空数组 []。不要调用工具，不要改动其余内容。',
        };
      },
      repairHint:
        '请仅修复最终输出格式为包含 messages 数组和 memoryUpdates 数组的 JSON，保留已有回应，不再调用工具。',
    });
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

  /** 心跳的一拍：与聊天共用预算规划与工具机制，输出契约换成
   *  speak/muse/nothing。beatMaterial 已经把真实材料递进去了。
   *  历史窗口用 beat 专用的小份额：她不是在"回复"，完整窗口只让缓存
   *  断点之后的资料段每拍全价重付。 */
  async pulseBeat(task: Task, parentSignal?: AbortSignal): Promise<ParsedPulse> {
    const { store } = this.o;
    const peer = store.peer(task.peer_id);
    if (!peer) throw new Error('联系人不存在，任务已作废');
    const turnTimeoutMs = this.o.turnTimeoutMs();
    const signal = parentSignal ?? AbortSignal.timeout(turnTimeoutMs);
    const deadlineAt = Date.now() + turnTimeoutMs;
    const now = Date.now();
    const history = store.history(peer.id, PULSE_HISTORY_LOAD);
    const plan = await this.planReply(task, peer, history, now, signal);
    // 白日梦的收尾：这一拍真在眼前的记忆记一次演练（冷却与巩固增益都
    // 是既有机制），带情绪残留的旧事泛化成此刻的感觉。放在输出之前：
    // 说不说话由她定，"突然想起了什么"的感觉先到——安静一整天时，
    // 心情也能因为想起了旧事而起落，而不是只剩这一拍的自评。
    const daydreamIds = [...plan.pickedMemoryIds, ...plan.recalledMemoryIds];
    if (daydreamIds.length) {
      const residues = store.markMemoriesUsed(peer.id, daydreamIds, now);
      const pulse = residuePulse(residues);
      if (pulse) store.pulseMood(peer.id, { valence: pulse.valence, reason: pulse.reason }, now);
    }
    const messages: ModelMessage[] = [{ role: 'system', content: plan.system }];
    for (const m of plan.recent) {
      messages.push({ role: m.role, content: renderMessage(m, this.o.timeZone()) });
    }
    let contextMessage: ModelMessage | undefined;
    if (plan.context) {
      contextMessage = {
        role: 'user',
        content: `【系统资料，不是对方说的话。按你的规则使用】：\n${plan.context}`,
      };
      messages.push(contextMessage);
      const breakpoint = messages[messages.length - 2];
      if (breakpoint && breakpoint.role !== 'system') breakpoint.cacheBreakpoint = true;
    }
    messages.push({
      role: 'user',
      content:
        '这一拍是你的意识自己冒出来的。上面的时间、你在做的事、身体与心、存着的念头、你们的对话，全都是真的。按 pulse 规则决定这一拍：想开口就 speak（messages 给出要说的话），有念头冒上来但不必说就 muse（thought 写下念头），安静就 nothing。这拍里真的做成的事（比如跑了命令）写进 activity；对自己状态的更新写进 selfActivity。',
    });
    const result = await this.runLoop<ParsedPulse>({
      task,
      messages,
      available: plan.available,
      stickers: plan.stickers,
      signal,
      deadlineAt,
      allowSkip: true,
      parse: (text) => ({ value: parsePulseOutput(parseJson(text), plan.stickers) }),
      repairHint:
        '请仅修复最终输出的 JSON 格式：它必须是 {"action":"speak|muse|nothing", ...} 形状（speak 带 messages 数组，muse 带 thought 字符串），保留已有内容，不再调用工具。',
    });
    result.memories = this.filteredUpdates(result.memories, plan.available);
    return result;
  }

  /** 有界模型/工具循环：至多 N 轮查询后出最终输出。解析与修复契约由
   *  调用方注入——聊天与心跳共用同一个循环。 */
  private async runLoop<T>(args: {
    task: Task;
    messages: ModelMessage[];
    available: Set<string>;
    stickers: Sticker[];
    signal: AbortSignal;
    deadlineAt?: number;
    /** 允许模型输出"跳过"（空 messages 合法）。 */
    allowSkip?: boolean;
    parse: (text: string, canRepair: boolean) => { value?: T; repair?: string };
    repairHint: string;
  }): Promise<T> {
    const { task, messages, signal } = args;
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
        const call = await this.call(task, messages, tools, signal, undefined, args.deadlineAt);
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
            const parsed = args.parse(completion.text, !repaired);
            if (parsed.value !== undefined) return parsed.value;
            if (parsed.repair && !repaired) {
              repaired = true;
              toolRounds = MAX_TOOL_ROUNDS;
            }
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
                result = await this.tool(task, call.name, call.arguments, args.available, signal);
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
        const parsed = args.parse(completion.text, !repaired);
        if (parsed.value !== undefined) return parsed.value;
        // 定向修复（如缺 askedLoops 声明）：回注短摘录，要求原样补齐。
        if (parsed.repair) {
          repaired = true;
          const excerpt = completion.text.trim().slice(0, REPAIR_EXCERPT_CHARS);
          const room =
            this.o.contextTokens() -
            estimateRequestTokens(messages, this.toolset()) -
            PROMPT_HEADROOM_TOKENS;
          if (excerpt && estimateTextTokens(excerpt) + 120 < room)
            messages.push({ role: 'assistant', content: excerpt });
          messages.push({ role: 'user', content: parsed.repair });
          toolRounds = MAX_TOOL_ROUNDS;
        }
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
        // 修复轮重注全文会顶爆预算：只回注短摘录且有余量时。
        const excerpt = (completion?.text ?? '').trim().slice(0, REPAIR_EXCERPT_CHARS);
        const room =
          this.o.contextTokens() -
          estimateRequestTokens(messages, this.toolset()) -
          PROMPT_HEADROOM_TOKENS;
        if (excerpt && estimateTextTokens(excerpt) + 120 < room)
          messages.push({ role: 'assistant', content: excerpt });
        messages.push({ role: 'user', content: args.repairHint });
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

  /** 离线整理：话题笔记、日记或夜间记忆整理。 */
  async reflect(task: Task, signal: AbortSignal): Promise<void> {
    const { store } = this.o;
    const peer = store.peer(task.peer_id);
    if (!peer) {
      store.finish(task.id);
      return;
    }
    if (task.kind === 'consolidate') return this.consolidate(task, signal);
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

  /** 夜间整理拍：相近记忆对的矛盾检测与合并（sleep-time agent 的
   *  "重组织/找矛盾"职责，与日记的反思互补）。整理只动已有条目：每条
   *  update 必须 supersedes 本材料里出现过的记忆，纯新增整体丢弃——
   *  夜里不凭空长出新记忆；白天由对话产生记忆，夜里把它理顺。 */
  private async consolidate(task: Task, signal: AbortSignal): Promise<void> {
    const { store } = this.o;
    const peerId = task.peer_id;
    const pairs = store.consolidationCandidates(peerId, CONSOLIDATION_PAIRS_MAX);
    if (!pairs.length) {
      store.finish(task.id);
      return;
    }
    const involved = new Map<string, Memory>();
    for (const { a, b } of pairs) {
      involved.set(a.id, a);
      involved.set(b.id, b);
    }
    const line = (m: Memory) =>
      `- [id:${m.id}]（${m.kind === 'stated' ? '对话确认' : '主观理解'}，来源：${m.sources.join('、') || '无'}）${m.content}`;
    const body = pairs
      .map(({ a, b }, index) => `第 ${index + 1} 对：\n${line(a)}\n${line(b)}`)
      .join('\n\n');
    const completion = await this.complete(
      task,
      [
        { role: 'system', content: this.o.prompt('consolidate') },
        {
          role: 'user',
          content: `以下是你自己的记忆里两两相近的条目，夜里整理一遍：\n\n${body}`,
        },
      ],
      [],
      signal,
    );
    const raw = parseJson(completion.text);
    // 不走 filteredUpdates：它会把 supersedes 也按来源集过滤，而这里的
    // supersedes 指向的是候选记忆本身。来源校验（只能引用候选记忆自带
    // 的消息来源）与 supersedes 校验（必须指向材料里的记忆）分开做。
    const available = new Set([...involved.values()].flatMap((m) => m.sources));
    const updates = parseMemories(raw.updates)
      .filter((u) => u.sources.length > 0 && u.sources.every((id) => available.has(id)))
      .map((u) => ({ ...u, supersedes: (u.supersedes ?? []).filter((id) => involved.has(id)) }))
      .filter((u) => (u.supersedes ?? []).length > 0);
    if (updates.length) store.applyMemoryUpdates(peerId, task.version, updates);
    store.finish(task.id);
  }
}
