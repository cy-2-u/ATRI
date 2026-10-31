/** 数据形状与库结构：类型、调节常量、建表与升级。Store 的方法在
 *  store.ts；这里只描述"数据长什么样、库怎么打开"。
 *
 *  升级策略是幂等引导而不是版本链：目标形态全部用 CREATE IF NOT EXISTS
 *  与 hasColumn 守卫的 ALTER 表达，任何旧库（含 4.0 时代的 atri.db）都
 *  能一步到位，新库一次建到最新。 */

export type TaskKind = 'chat' | 'pulse' | 'notes' | 'diary' | 'consolidate';
export type SourceKind = 'message' | 'memory' | 'diary';

export interface Peer {
  id: string;
  channel: string;
  address: string;
  context_token: string;
  approved: number;
  version: number;
  notes: string;
  notes_until: number;
  last_user_at: number;
  last_proactive_at: number;
  created_at: number;
  persona_id: string;
}
export interface Media {
  path?: string;
  mime?: string;
  description?: string;
  kind: string;
  ref?: unknown;
}
export interface Message {
  id: string;
  seq: number;
  peer_id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  media: Media[];
  status: string;
  created_at: number;
}
export interface Task {
  id: string;
  peer_id: string;
  kind: TaskKind;
  state: string;
  payload: Record<string, unknown>;
  version: number;
  attempts: number;
  run_at: number;
  error: string;
  created_at: number;
}
export interface Memory {
  id: string;
  peer_id: string;
  content: string;
  kind: 'stated' | 'interpretation';
  sources: string[];
  status: string;
  hits: number;
  last_hit_at: number;
  pinned: number;
  /** 被后续事实替代的时刻；0 表示仍然有效。 */
  invalid_at: number;
  importance: number;
  emotion: number;
  emotion_reason: string;
  consolidation: number;
  interference: number;
  created_at: number;
}
/** 用户提到的有明确时间的安排（"明天面试"）：到点问一次，汇报即了结，
 *  每年循环的事（生日）自动滚到明年。 */
export interface OpenLoop {
  id: string;
  peer_id: string;
  content: string;
  due_at: number;
  due_text: string;
  sources: string[];
  recurring: string;
  asked: number;
  status: string;
  created_at: number;
  resolved_at: number;
}
export interface OpenLoopInput {
  content: string;
  dueAt: number;
  dueText?: string;
  sources: string[];
  recurring?: string;
}
/** 无日期版的"挂念"：对方的持续事件或她答应过的事。从不主动发消息、
 *  不占开环配额，只在话题自然相关时浮现。 */
export type SoftThreadKind = 'concern' | 'promise';
export interface SoftThread {
  id: string;
  peer_id: string;
  content: string;
  kind: SoftThreadKind;
  sources: string[];
  revisit_after: number;
  asked: number;
  status: string;
  created_at: number;
  resolved_at: number;
}
export interface SoftThreadInput {
  content: string;
  kind: SoftThreadKind;
  revisitAfter?: number;
  sources: string[];
}
/** 一个尚未表达的想法。kind 是动机类别（share 分享、care 关心、
 *  ask 履约追问、muse 单纯想说），meaning 是"想传达什么"，不是消息草稿。
 *  想法由聊天与心跳两条路产生，在心跳时自然浮上来。 */
export type InitiativeKind = 'share' | 'care' | 'ask' | 'muse';
export interface Initiative {
  id: string;
  peer_id: string;
  topic_key: string;
  kind: InitiativeKind;
  meaning: string;
  sources: string[];
  source_hash: string;
  expect_reply: number;
  /** idle 可以表达；waiting 等一个条件；expressed/dropped 已退场。 */
  state: 'idle' | 'waiting' | 'expressed' | 'dropped';
  origin: string;
  version: number;
  created_at: number;
  updated_at: number;
  released_at: number;
  dropped_at: number;
}
export interface InitiativeInput {
  topicKey: string;
  kind: InitiativeKind;
  meaning: string;
  sources: string[];
  expectReply?: boolean;
}
/** 她的当下与内稳态（全局单行）：此刻在做什么、今天的打算、在追什么、
 *  社交电量与表达欲（积分状态）、无聊的起算点。想念是按联系人的时间
 *  导出量，不入库。pursuit 是"在追的事"：她自己的 ongoing 兴趣，互惠
 *  自我披露的材料——她有自己的世界，聊天里才有自己的事可讲。 */
export interface SelfState {
  activity: string;
  activity_since: number;
  plan: string;
  plan_day: string;
  pursuit: string;
  pursuit_since: number;
  social: number;
  express: number;
  last_stimulus_at: number;
  updated_at: number;
}
export interface SelfPatch {
  activity?: string;
  activitySince?: number;
  plan?: string;
  planDay?: string;
  /** 设置/更新在追的事（pursuitSince 随内容变化自动落到 now）。 */
  pursuit?: string;
  /** 放下在追的事（pursuit 清空、pursuit_since 归零）。 */
  pursuitClear?: boolean;
  social?: number;
  express?: number;
  lastStimulusAt?: number;
}
/** 生活流水：她真实做过的事（心跳的工具轮产物）。只增不改，环形保留。 */
export interface LifeEntry {
  id: number;
  at: number;
  /** did=做成了事 saw=看了什么 said=说了什么（主动消息由头） plan=今日打算 */
  kind: string;
  text: string;
  artifact: string;
}
/** 跨对话的轻量心情，以体感文字注入提示词而非数值。patience 单独一轴：
 *  累但温暖与烦透了读起来完全不同，只有后者该少说少问。 */
export interface MoodState {
  valence: number;
  energy: number;
  patience: number;
  reason?: string;
  at: number;
}
export interface DiarySection {
  id: string;
  peer_id: string;
  day: string;
  content: string;
  sources: string[];
  emotion: number;
  created_at: number;
}
export interface MemoryUpdate {
  content: string;
  kind: 'stated' | 'interpretation';
  sources: string[];
  supersedes?: string[];
  importance?: number;
  emotion?: number;
  emotionReason?: string;
}
export interface ReplyPart {
  type: 'text' | 'sticker' | 'image';
  text?: string;
  slug?: string;
  description?: string;
  /** image 专用：她沙箱里的相对路径——只发真实存在的图片文件，
   *  文件是否存在由发送侧响亮校验（诚实红线：没有的图不发）。 */
  path?: string;
  /** 模型请求的语义停顿档位；毫秒区间由发送端界定（BEAT_RANGES_MS）。 */
  beat?: 'short' | 'medium' | 'long';
}
export interface Delivery {
  id: string;
  task_id: string;
  peer_id: string;
  ordinal: number;
  part: ReplyPart;
  status: string;
  attempts: number;
  error: string;
  created_at: number;
}
export interface SearchHit {
  id: string;
  kind: SourceKind;
  content: string;
  created_at: number;
  score: number;
  /** 乘上近度/类型加权前的原始相关度。 */
  relevance?: number;
  /** 本次命中词里最小的文档频率：命中"有点"说明不了什么，命中"年糕"
   *  才能定位一件事。词面没命中时为 undefined。 */
  minDf?: number;
  /** 该联系人已索引的行数，供调用方判断 minDf。 */
  corpusSize?: number;
  /** 与查询向量的余弦相似度；语义召回可能词面零重合，必须放行。 */
  semantic?: number;
  role?: Message['role'];
  memory_kind?: Memory['kind'];
  sources?: string[];
  /** 记忆/日记命中当下的六变量快照，供分层渲染与情绪染色。 */
  detail?: number;
  significance?: number;
  residue?: number;
}
export interface EmbeddingVector {
  id: string;
  peer_id: string;
  kind: SourceKind;
  vector: Float32Array;
  dims: number;
  model: string;
}

// ---------- 调节常量（写在这里供测试引用） ----------

/** 消息命中近度加权的半衰期；记忆排序本身由六变量接管。 */
export const MEMORY_HALFLIFE_DAYS = 14;
export const MEMORY_STATED_WEIGHT = 2.2;
export const MEMORY_INTERPRETATION_WEIGHT = 0.6;
/** 一次演练在一个窗口内只计一次。 */
export const MEMORY_HIT_COOLDOWN_MINUTES = 180;
/** 开环过期：到期 7 天无人理会即静默退场。 */
export const OPEN_LOOP_EXPIRE_DAYS = 7;
export const SOFT_THREAD_EXPIRE_DAYS = 14;
export const SOFT_THREAD_MAX = 3;
export const SOFT_THREAD_REVISIT_DAYS = 2;
export const SOFT_THREAD_REVISIT_MAX_DAYS = 7;
export const MOOD_VALENCE_HALFLIFE_HOURS = 12;
export const MOOD_ENERGY_HALFLIFE_HOURS = 4;
export const MOOD_PATIENCE_HALFLIFE_HOURS = 10;
/** 同号脉冲每次只收剩余距离的这一比例：一晚上的糟心事钉不死状态。 */
export const MOOD_PULSE_SHARE = 0.2;
/** 用量明细保留天数，更早的聚合成按日汇总。 */
export const USAGE_RETENTION_DAYS = 30;
/** 任务失败重试上限：防止永久失败的任务被调度器每分钟复活烧模型调用。 */
export const MAX_TASK_ATTEMPTS = 5;
/** 终态任务行保留天数。 */
export const TASK_RETENTION_DAYS = 7;
/** 生活流水的环形保留条数。 */
export const LIFE_LOG_KEEP = 200;
/** 送达不明的记录暂停该联系人队列的时长；之后放行但保留在待办里。 */
export const UNCERTAIN_HOLD_MS = 10 * 60000;
export const NOTES_MAX_CHARS = 4000;
/** 同一 burst（连发）内的消息间隔上限。数据层的节律统计与 core 的静默
 *  锚点共用同一把尺子。 */
export const BURST_WINDOW_MS = 5 * 60000;

// ---------- 夜间整理（记忆巩固管线） ----------

/** 语义相近记忆进入整理候选的余弦阈值（≥0.9 的纯复述已在写入路径
 *  自动替代，这里抓的是"同一件事的两三个说法"与"互相矛盾的旧新条"。 */
export const CONSOLIDATION_PAIR_SIMILARITY = 0.6;
/** 无向量时的兜底：字符二元组 Jaccard 阈值（CJK 短句上三元组过稀）。 */
export const CONSOLIDATION_PAIR_GRAM_SIMILARITY = 0.3;
/** 每晚交给模型的记忆对上限。 */
export const CONSOLIDATION_PAIRS_MAX = 12;

/** 联系人近 N 天的节律统计（"分布像人"的在线观测）。 */
export interface RhythmStats {
  days: number;
  /** 心跳拍总数与其中真开口的拍数。 */
  beats: number;
  beatSpeaks: number;
  /** 全部主动消息（含心跳、承诺提醒、开场白）与对方消息条数。 */
  proactiveMsgs: number;
  userMsgs: number;
  /** 气泡总量、表情数、文本气泡的平均长度与标准差、最大连发条数。 */
  bubbles: number;
  stickers: number;
  avgLen: number;
  lenStdev: number;
  maxBurst: number;
  /** 按本地日聚合的逐日明细（时间升序）。 */
  perDay: { day: string; beats: number; speaks: number; userMsgs: number; bubbles: number }[];
}

export type Row = Record<string, unknown>;
export const parse = <T>(value: unknown, fallback: T): T => {
  try {
    return JSON.parse(String(value)) as T;
  } catch {
    return fallback;
  }
};

/** 当前数据形态版本。与 4.0 时代的 atri.db 版本号连续，旧库可直接打开。 */
export const SCHEMA_VERSION = 13;

/** 建库 + 旧库升级，幂等：任何版本的库（含 4.0 的 atri.db）都能一步到
 *  最新形态。目标形态全部是 CREATE IF NOT EXISTS 与守卫 ALTER，历史上
 *  每一步迁移的效果都被"最终形态 + 幂等语句"覆盖。 */
export function migrate(sql: import('node:sqlite').DatabaseSync): void {
  const openedAt = Number(sql.prepare('PRAGMA user_version').get()?.user_version ?? 0);
  if (openedAt > SCHEMA_VERSION) throw new Error('数据库来自更新版本，不能用当前程序打开');
  sql.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS peers (
        id TEXT PRIMARY KEY, channel TEXT NOT NULL, address TEXT NOT NULL, context_token TEXT NOT NULL DEFAULT '',
        approved INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 0,
        notes TEXT NOT NULL DEFAULT '', notes_until INTEGER NOT NULL DEFAULT 0,
        last_user_at INTEGER NOT NULL DEFAULT 0, last_proactive_at INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, peer_id TEXT NOT NULL REFERENCES peers(id),
        event_key TEXT, role TEXT NOT NULL, content TEXT NOT NULL, media TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE(peer_id,event_key)
      );
      CREATE INDEX IF NOT EXISTS messages_peer ON messages(peer_id,seq);
      CREATE INDEX IF NOT EXISTS messages_rhythm ON messages(peer_id,role,status,created_at);
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, peer_id TEXT NOT NULL REFERENCES peers(id), kind TEXT NOT NULL, dedupe_key TEXT NOT NULL,
        payload TEXT NOT NULL DEFAULT '{}', state TEXT NOT NULL DEFAULT 'queued', version INTEGER NOT NULL DEFAULT 0,
        attempts INTEGER NOT NULL DEFAULT 0, run_at INTEGER NOT NULL, error TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL,
        UNIQUE(peer_id,kind,dedupe_key)
      );
      CREATE INDEX IF NOT EXISTS tasks_ready ON tasks(state,run_at,peer_id);
      CREATE INDEX IF NOT EXISTS tasks_kind ON tasks(kind);
      CREATE TABLE IF NOT EXISTS outbox (
        id TEXT PRIMARY KEY REFERENCES messages(id), task_id TEXT NOT NULL REFERENCES tasks(id), peer_id TEXT NOT NULL REFERENCES peers(id),
        ordinal INTEGER NOT NULL, part TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
        error TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, UNIQUE(task_id,ordinal)
      );
      CREATE INDEX IF NOT EXISTS outbox_peer_status ON outbox(peer_id,status);
      CREATE INDEX IF NOT EXISTS outbox_status_created ON outbox(status,created_at DESC);
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY, peer_id TEXT NOT NULL REFERENCES peers(id), content TEXT NOT NULL, kind TEXT NOT NULL,
        sources TEXT NOT NULL, source_hash TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
        hits INTEGER NOT NULL DEFAULT 0, last_hit_at INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
        pinned INTEGER NOT NULL DEFAULT 0, invalid_at INTEGER NOT NULL DEFAULT 0,
        importance REAL NOT NULL DEFAULT 0.5, emotion REAL NOT NULL DEFAULT 0,
        emotion_reason TEXT NOT NULL DEFAULT '', consolidation REAL NOT NULL DEFAULT 0,
        interference REAL NOT NULL DEFAULT 0,
        UNIQUE(peer_id,source_hash)
      );
      CREATE INDEX IF NOT EXISTS memories_peer_status_created ON memories(peer_id,status,created_at DESC);
      CREATE TABLE IF NOT EXISTS memory_embeddings (
        id TEXT PRIMARY KEY, peer_id TEXT NOT NULL REFERENCES peers(id),
        kind TEXT NOT NULL, vector BLOB NOT NULL, dims INTEGER NOT NULL, model TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS memory_embeddings_peer ON memory_embeddings(peer_id);
      CREATE INDEX IF NOT EXISTS memory_embeddings_peer_model ON memory_embeddings(peer_id,model);
      CREATE TABLE IF NOT EXISTS diary_sections (
        id TEXT PRIMARY KEY, peer_id TEXT NOT NULL REFERENCES peers(id), task_id TEXT NOT NULL REFERENCES tasks(id),
        ordinal INTEGER NOT NULL, day TEXT NOT NULL, content TEXT NOT NULL, sources TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active', emotion REAL NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
        UNIQUE(task_id,ordinal)
      );
      CREATE INDEX IF NOT EXISTS diary_peer_status_day ON diary_sections(peer_id,status,day);
      CREATE TABLE IF NOT EXISTS usage (id INTEGER PRIMARY KEY, peer_id TEXT, task_id TEXT, purpose TEXT, input_tokens INTEGER, output_tokens INTEGER, duration_ms INTEGER, cached_tokens INTEGER NOT NULL DEFAULT 0, created_at INTEGER);
      CREATE INDEX IF NOT EXISTS usage_created ON usage(created_at);
      CREATE TABLE IF NOT EXISTS usage_daily (purpose TEXT NOT NULL, day INTEGER NOT NULL, calls INTEGER NOT NULL, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, average_ms INTEGER NOT NULL, cached_tokens INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(purpose,day));
      -- FTS 旁的元数据镜像表：元数据列在虚拟表里是 UNINDEXED，过滤/删除
      -- 走真索引，search_index 只答 MATCH，rowid 两边同步（见下方同步语句）。
      CREATE TABLE IF NOT EXISTS search_docs (
        id TEXT PRIMARY KEY, peer_id TEXT NOT NULL, kind TEXT NOT NULL,
        content TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS search_docs_peer_kind ON search_docs(peer_id,kind,created_at DESC);
      CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(id UNINDEXED, peer_id UNINDEXED, kind UNINDEXED, content, created_at UNINDEXED, tokenize='trigram');
      CREATE TABLE IF NOT EXISTS open_loops (
        id TEXT PRIMARY KEY, peer_id TEXT NOT NULL REFERENCES peers(id), content TEXT NOT NULL,
        due_at INTEGER NOT NULL, due_text TEXT NOT NULL DEFAULT '', sources TEXT NOT NULL,
        recurring TEXT NOT NULL DEFAULT '', asked INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'open',
        created_at INTEGER NOT NULL, resolved_at INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS open_loops_peer ON open_loops(peer_id,status);
      CREATE TABLE IF NOT EXISTS soft_threads (
        id TEXT PRIMARY KEY, peer_id TEXT NOT NULL REFERENCES peers(id), content TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'concern', sources TEXT NOT NULL,
        revisit_after INTEGER NOT NULL DEFAULT 2, asked INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'open', created_at INTEGER NOT NULL,
        resolved_at INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS soft_threads_peer ON soft_threads(peer_id,status);
      CREATE TABLE IF NOT EXISTS initiatives (
        id TEXT PRIMARY KEY, peer_id TEXT NOT NULL REFERENCES peers(id),
        topic_key TEXT NOT NULL, kind TEXT NOT NULL, meaning TEXT NOT NULL,
        sources TEXT NOT NULL, source_hash TEXT NOT NULL,
        expect_reply INTEGER NOT NULL DEFAULT 0,
        state TEXT NOT NULL DEFAULT 'idle', origin TEXT NOT NULL DEFAULT '',
        version INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        released_at INTEGER NOT NULL DEFAULT 0, dropped_at INTEGER NOT NULL DEFAULT 0,
        UNIQUE(peer_id, topic_key)
      );
      CREATE INDEX IF NOT EXISTS initiatives_peer_state ON initiatives(peer_id,state,updated_at DESC);
      CREATE TABLE IF NOT EXISTS self (
        id INTEGER PRIMARY KEY CHECK(id=1),
        activity TEXT NOT NULL DEFAULT '', activity_since INTEGER NOT NULL DEFAULT 0,
        plan TEXT NOT NULL DEFAULT '', plan_day TEXT NOT NULL DEFAULT '',
        pursuit TEXT NOT NULL DEFAULT '', pursuit_since INTEGER NOT NULL DEFAULT 0,
        social REAL NOT NULL DEFAULT 1, express REAL NOT NULL DEFAULT 0,
        last_stimulus_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0
      );
      INSERT OR IGNORE INTO self(id) VALUES(1);
      CREATE TABLE IF NOT EXISTS life_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, kind TEXT NOT NULL,
        text TEXT NOT NULL, artifact TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS life_log_at ON life_log(at DESC);
  `);

  // 旧库补列（新库的 DDL 已含全部列，hasColumn 守卫让这些成为空操作）。
  const hasColumn = (table: string, column: string): boolean =>
    (sql.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[]).some(
      (row) => row.name === column,
    );
  const legacyColumns: [string, string, string][] = [
    ['memories', 'pinned', 'INTEGER NOT NULL DEFAULT 0'],
    ['peers', 'persona_id', 'TEXT NOT NULL DEFAULT ""'],
    ['memories', 'invalid_at', 'INTEGER NOT NULL DEFAULT 0'],
    ['memories', 'importance', 'REAL NOT NULL DEFAULT 0.5'],
    ['memories', 'emotion', 'REAL NOT NULL DEFAULT 0'],
    ['memories', 'emotion_reason', "TEXT NOT NULL DEFAULT ''"],
    ['memories', 'consolidation', 'REAL NOT NULL DEFAULT 0'],
    ['memories', 'interference', 'REAL NOT NULL DEFAULT 0'],
    ['diary_sections', 'emotion', 'REAL NOT NULL DEFAULT 0'],
    ['usage', 'cached_tokens', 'INTEGER NOT NULL DEFAULT 0'],
    ['usage_daily', 'cached_tokens', 'INTEGER NOT NULL DEFAULT 0'],
    ['self', 'pursuit', "TEXT NOT NULL DEFAULT ''"],
    ['self', 'pursuit_since', 'INTEGER NOT NULL DEFAULT 0'],
  ];
  for (const [table, column, decl] of legacyColumns)
    if (!hasColumn(table, column)) sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl};`);

  // rowid 保持同步：镜像表与 FTS 表的删除都靠它 O(1)。每次启动重放一次
  // 同步（INSERT OR REPLACE），旧库漏行、历史中断的升级都能自愈。
  sql.exec(
    `INSERT OR REPLACE INTO search_docs(rowid,id,peer_id,kind,content,created_at)
     SELECT rowid,id,peer_id,kind,content,created_at FROM search_index;`,
  );

  // 旧时代的遗留：本地试聊渠道整体退场（她只属于一个人）；早已停用的
  // 设置键清掉。语句对新库是空操作。
  sql.exec(
    `DELETE FROM outbox WHERE peer_id IN (SELECT id FROM peers WHERE channel='preview');
     DELETE FROM diary_sections WHERE peer_id IN (SELECT id FROM peers WHERE channel='preview');
     DELETE FROM tasks WHERE peer_id IN (SELECT id FROM peers WHERE channel='preview');
     DELETE FROM memory_embeddings WHERE peer_id IN (SELECT id FROM peers WHERE channel='preview');
     DELETE FROM memories WHERE peer_id IN (SELECT id FROM peers WHERE channel='preview');
     DELETE FROM open_loops WHERE peer_id IN (SELECT id FROM peers WHERE channel='preview');
     DELETE FROM soft_threads WHERE peer_id IN (SELECT id FROM peers WHERE channel='preview');
     DELETE FROM initiatives WHERE peer_id IN (SELECT id FROM peers WHERE channel='preview');
     DELETE FROM messages WHERE peer_id IN (SELECT id FROM peers WHERE channel='preview');
     DELETE FROM search_index WHERE rowid IN (SELECT rowid FROM search_docs WHERE peer_id IN (SELECT id FROM peers WHERE channel='preview'));
     DELETE FROM search_docs WHERE peer_id IN (SELECT id FROM peers WHERE channel='preview');
     DELETE FROM peers WHERE channel='preview';
     DELETE FROM settings WHERE key LIKE 'impulse_at:%' OR key LIKE 'silence_cooldown:%'
       OR key LIKE 'muse_seeded_at:%';`,
  );

  sql.exec(`PRAGMA user_version=${SCHEMA_VERSION};`);
}
