/** 全部行为调节旋钮集中在这里。 */

// ---------- 自动召回 ----------

/** 参与自动召回查询的近期用户消息条数与总字数。 */
export const RECALL_QUERY_MESSAGES = 3;
export const RECALL_QUERY_MAX_CHARS = 1000;
/** 自动召回放进提示词的命中数。 */
export const RECALL_HITS = 3;
/** 稀有度闸门前多打分的候选数：被拒的命中不占 RECALL_HITS 的坑。 */
export const RECALL_CANDIDATES = 12;
/** 自动召回永不返回的最新消息条数：查询就是用它们拼的，不排除会全部
 *  命中"模型正在读的原文"，旧事永远浮不上来。 */
export const RECALL_PROTECT = 10;
/** 命中至少要撞上一个多稀有的词（占该联系人索引行的比例），下限保护
 *  语料还很少的新联系人。 */
export const RECALL_RARE_TERM_SHARE = 0.02;
export const RECALL_RARE_TERM_MIN_DF = 5;
/** 语义相似度足够高时免词面稀有度：这是词面检索永远服务不了的换说法场景。 */
export const RECALL_MIN_SEMANTIC = 0.45;

// ---------- 提示词中的记忆 ----------

export const PROMPT_MEMORIES = 10;
/** 最强的几条每轮必在（定义关系的事实不许闪烁），其余按冷却轮换。 */
export const MEMORY_COOLDOWN_CORE = 3;
export const RECALL_CONTENT_MAX_CHARS = 600;
export const MEMORY_CONTENT_MAX_CHARS = 500;
/** 提示词里的表情窗口。刻意低于 32 上限：窗口等于上限时轮换与下沉
 *  永远不触发，长目录的尾部永远不可见。 */
export const PROMPT_STICKERS = 24;

// ---------- 预算分配 ----------

/** HISTORY_RESERVE 是近期消息的保底份额；三个资料份额各自独立应用于
 *  固定系统提示之外的余量（独立份额防一条长笔记饿死全部记忆）。 */
export const HISTORY_RESERVE_SHARE = 0.4;
export const PROMPT_NOTES_SHARE = 0.4;
export const PROMPT_MEMORY_SHARE = 0.35;
export const PROMPT_RECALL_SHARE = 0.25;
export const PROMPT_MEMORY_MAX_TOKENS = 3000;
export const PROMPT_RECALL_MAX_TOKENS = 3000;
/** 为工具与续传预留的输入预算份额。 */
export const TOOL_RESERVE_MAX_TOKENS = 6000;
export const CONTEXT_FLEX_FRACTION = 0.25;
/** 系统提示组装保留的最低余量。 */
export const PROMPT_HEADROOM_TOKENS = 256;

// ---------- 工具循环 ----------

export const MAX_TOOL_ROUNDS = 2;
export const MAX_TOOL_CALLS = 4;
export const MAX_REPLY_ATTEMPTS = 4;
export const TOOL_RESULT_BUDGET_TOKENS = 6000;

// ---------- 回复形状 ----------

export const MAX_REPLY_PARTS = 6;
export const MAX_MEMORY_UPDATES = 3;
export const MAX_IMAGE_DESCRIPTIONS = 4;
/** beat 档位映射的毫秒区间：停不停由语义决定，代码只画边界。 */
export const BEAT_RANGES_MS: Record<'short' | 'medium' | 'long', [number, number]> = {
  short: [400, 900],
  medium: [1500, 3000],
  long: [4000, 8000],
};

// ---------- 话题笔记 ----------

/** 笔记内文 token 上限（提示词要求 ≤1000 字，1500 token 会截掉合规输出）。 */
export const NOTES_MAX_TOKENS = 3000;
export const NOTES_MIN_MESSAGES = 20;
export const NOTES_WINDOW = 200;
export const NOTES_BUDGET_SHARE = 0.65;
/** 最新多少条不进笔记（正在进行的轮次不该被总结进去）。 */
export const NOTES_TAIL_EXEMPT = 13;

// ---------- 日记 ----------

export const DIARY_MAX_CHARS = 22000;
export const DIARY_MAX_SECTIONS = 6;

// ---------- 表情反馈 ----------

export const STICKER_RECENT_SHOWN = 8;

// ---------- 时间感知 ----------

export const SILENCE_NOTIFY_MINUTES = 30;
export const SILENCE_HOURS_THRESHOLD = 4;
/** 静默超过该天数时，分别前的日记作为重逢语境取回。 */
export const DIARY_GAP_MIN_DAYS = 2;
export const DIARY_GAP_LOOKBACK_DAYS = 2;
export const DIARY_GAP_MAX_SECTIONS = 4;
export const DIARY_GAP_MAX_TOKENS = 700;

// ---------- 主动联系 ----------

export const PROACTIVE_JITTER_MINUTES = 20;
/** 心搏探询的默认间隔（分钟）：调度器每隔这么久问她一次"此刻想说话吗"。
 *  想不想由她定，代码只管节拍与预算。 */
export const IMPULSE_INTERVAL_MINUTES = 30;
/** 每日真发的主动消息上限：护栏不是目标，多数日子自然落在 0–2。 */
export const PROACTIVE_DAILY_LIMIT = 3;
/** 探询结果的有效期（毫秒）：她说"想"但队列被抖动/打断弄丢后，
 *  过了这个窗口就不再补发，下一拍重新探。 */
export const IMPULSE_WINDOW_MS = 10 * 60000;
export const OPEN_LOOP_PROMPT_MAX = 5;
export const SOFT_THREAD_PROMPT_MAX = 3;
/** 新记忆与既有记忆余弦超过该值时自动替代旧行。 */
export const SIMILARITY_SUPERSEDE = 0.9;
/** 作息桶的最低消息数阈值。 */
export const RHYTHM_MIN_BUCKET = 3;
export const RHYTHM_PEAK_BUCKETS = 6;
/** 向量回填每批条数。 */
export const EMBED_BACKFILL_BATCH = 64;
/** 每轮加载的历史条数上限：静默基准、表情去重、心情回看都只在最近
 *  几十条里活动，500 条全量加载只是白费延迟。 */
export const HISTORY_LOAD_LIMIT = 160;

// db 侧共享的旋钮从这里统一再导出。
export {
  MEMORY_HIT_COOLDOWN_MINUTES,
  OPEN_LOOP_EXPIRE_DAYS,
  PROACTIVE_IGNORE_LIMIT,
  PROACTIVE_IGNORE_COOLDOWN_DAYS,
  SOFT_THREAD_EXPIRE_DAYS,
  SOFT_THREAD_MAX,
  SOFT_THREAD_REVISIT_DAYS,
  SOFT_THREAD_REVISIT_MAX_DAYS,
} from '../db/index.js';
