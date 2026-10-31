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

// ---------- 预算分配 ----------

/** HISTORY_RESERVE 是近期消息的保底份额；资料份额各自独立应用于
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

// ---------- 心跳（主动 v3：她自己的意识流） ----------

/** 开环与挂念在提示词里的条数上限。 */
export const OPEN_LOOP_PROMPT_MAX = 5;
export const SOFT_THREAD_PROMPT_MAX = 3;
/** 作息桶的最低消息数阈值。 */
export const RHYTHM_MIN_BUCKET = 3;
export const RHYTHM_PEAK_BUCKETS = 6;
/** 心跳材料里最近生活流水的条数。 */
export const PULSE_LIFE_LOG_ITEMS = 6;
/** 聊天结束后多少分钟内视为"余韵未散"：节拍自动加密。 */
export const PULSE_AFTER_CHAT_MINUTES = 10;
/** 异常观察线：一小时内无回应的主动消息多过此值时记一条日志给运维，
 *  仅此而已——她的行为不由它改变。这类模式多数时候是对方真的忙，
 *  少数时候是程序故障；判断与处置都交给人，不交给闸门。 */
export const PULSE_ANOMALY_PER_HOUR = 2;
/** 想法池在心跳材料里的条数上限。 */
export const PULSE_THOUGHTS_MAX = 5;
/** beat 拍加载的近期消息条数：她不是在"回复"，完整历史窗口只让缓存
 *  断点之后的资料段每拍全价重付。40 条足够覆盖余韵、静默锚点与连发。 */
export const PULSE_HISTORY_LOAD = 40;
/** 进程启动后首拍的最小延迟：部署重启不该让她"恰好醒来"。 */
export const BOOT_BEAT_GRACE_MS = 10 * 60000;

// ---------- 人格锚 ----------

/** 按天轮换的行为重申。人格漂移的实证对策之一是会话中途的低频重申；
 *  锚放在 dynamic 块（缓存断点之后），不碰逐字节稳定的 system 前缀。
 *  措辞刻意人格无关：联系人可绑自定义人格，锚只重申对所有人格都成立
 *  的底线，不替具体人设代言。 */
export const PERSONA_ANCHORS: string[] = [
  '像微信里熟悉的人那样说话：短句、口语、可以毛糙；上一句说得巧，这一句就随意些。',
  '没有经历过的事不能说经历过；拿不准的就如实说不知道。',
  '不奉承、不每轮提问收尾、不重复同一种口癖；对方敷衍你时你能察觉，也会说出来。',
  '关系从真实相处里来：记得对方说过的事，但别朗读档案，别引用几周前的原话。',
  '约定要算数，哪怕很小的事；被当小孩哄、被替你做决定时，你会说出来。',
];

// ---------- 夜间整理（记忆巩固管线） ----------
// 配对阈值定义在数据层（src/db/schema.ts）：候选对由 store 计算。

// ---------- 数据 ----------

/** 新记忆与既有记忆余弦超过该值时自动替代旧行。 */
export const SIMILARITY_SUPERSEDE = 0.9;
/** 向量回填每批条数。 */
export const EMBED_BACKFILL_BATCH = 64;
/** 每轮加载的历史条数上限：静默基准、表情去重、心情回看都只在最近
 *  几十条里活动，500 条全量加载只是白费延迟。 */
export const HISTORY_LOAD_LIMIT = 160;

// db 侧共享的旋钮从这里统一再导出。
export {
  MEMORY_HIT_COOLDOWN_MINUTES,
  OPEN_LOOP_EXPIRE_DAYS,
  SOFT_THREAD_EXPIRE_DAYS,
  SOFT_THREAD_MAX,
  SOFT_THREAD_REVISIT_DAYS,
  SOFT_THREAD_REVISIT_MAX_DAYS,
} from '../db/index.js';
