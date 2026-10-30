/** 数据形状与库结构：类型、调节常量、建表与迁移链。Store 的方法在
 *  store.ts；这里只描述"数据长什么样、库怎么一步步长成现在这样"。 */

export type TaskKind = 'chat' | 'pulse' | 'notes' | 'diary';
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
/** 她的当下与内稳态（全局单行）：此刻在做什么、今天的打算、社交电量与
 *  表达欲（积分状态）、无聊的起算点。想念是按联系人的时间导出量，不入库。 */
export interface SelfState {
  activity: string;
  activity_since: number;
  plan: string;
  plan_day: string;
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
  type: 'text' | 'sticker';
  text?: string;
  slug?: string;
  description?: string;
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

export type Row = Record<string, unknown>;
export const parse = <T>(value: unknown, fallback: T): T => {
  try {
    return JSON.parse(String(value)) as T;
  } catch {
    return fallback;
  }
};

export const SCHEMA_VERSION = 12;

/** 建表 + 迁移链。每个版本一个事务（PRAGMA 会自动提交，分开写会留下
 *  版本与结构不一致的库）。生产库从 v1 一路升上来，新库一次建到最新。 */
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
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, peer_id TEXT NOT NULL REFERENCES peers(id), kind TEXT NOT NULL, dedupe_key TEXT NOT NULL,
        payload TEXT NOT NULL DEFAULT '{}', state TEXT NOT NULL DEFAULT 'queued', version INTEGER NOT NULL DEFAULT 0,
        attempts INTEGER NOT NULL DEFAULT 0, run_at INTEGER NOT NULL, error TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL,
        UNIQUE(peer_id,kind,dedupe_key)
      );
      CREATE INDEX IF NOT EXISTS tasks_ready ON tasks(state,run_at,peer_id);
      CREATE TABLE IF NOT EXISTS outbox (
        id TEXT PRIMARY KEY REFERENCES messages(id), task_id TEXT NOT NULL REFERENCES tasks(id), peer_id TEXT NOT NULL REFERENCES peers(id),
        ordinal INTEGER NOT NULL, part TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
        error TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, UNIQUE(task_id,ordinal)
      );
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY, peer_id TEXT NOT NULL REFERENCES peers(id), content TEXT NOT NULL, kind TEXT NOT NULL,
        sources TEXT NOT NULL, source_hash TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
        hits INTEGER NOT NULL DEFAULT 0, last_hit_at INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
        UNIQUE(peer_id,source_hash)
      );
      CREATE TABLE IF NOT EXISTS memory_embeddings (
        id TEXT PRIMARY KEY, peer_id TEXT NOT NULL REFERENCES peers(id),
        kind TEXT NOT NULL, vector BLOB NOT NULL, dims INTEGER NOT NULL, model TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS memory_embeddings_peer ON memory_embeddings(peer_id);
      CREATE TABLE IF NOT EXISTS diary_sections (
        id TEXT PRIMARY KEY, peer_id TEXT NOT NULL REFERENCES peers(id), task_id TEXT NOT NULL REFERENCES tasks(id),
        ordinal INTEGER NOT NULL, day TEXT NOT NULL, content TEXT NOT NULL, sources TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL, UNIQUE(task_id,ordinal)
      );
      CREATE TABLE IF NOT EXISTS usage (id INTEGER PRIMARY KEY, peer_id TEXT, task_id TEXT, purpose TEXT, input_tokens INTEGER, output_tokens INTEGER, duration_ms INTEGER, created_at INTEGER);
      CREATE TABLE IF NOT EXISTS usage_daily (purpose TEXT NOT NULL, day INTEGER NOT NULL, calls INTEGER NOT NULL, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, average_ms INTEGER NOT NULL, PRIMARY KEY(purpose,day));
      -- FTS 旁的元数据镜像表：元数据列在虚拟表里是 UNINDEXED，过滤/删除
      -- 走真索引，search_index 只答 MATCH，rowid 两边同步。
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
      -- 想法：由真实来源形成、会保留/变化/消退的"还没说出的话"。
      -- topicKey 防同一件事换句话重复立项；sourceHash 幂等同一次判断。
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
    `);
  const hasColumn = (table: string, column: string): boolean =>
    (sql.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[]).some(
      (row) => row.name === column,
    );
  if (openedAt < 2) {
    sql.exec('BEGIN IMMEDIATE');
    if (!hasColumn('memories', 'pinned'))
      sql.exec('ALTER TABLE memories ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;');
    sql.exec('PRAGMA user_version=2;');
    sql.exec('COMMIT');
  }
  if (openedAt < 3) {
    sql.exec('BEGIN IMMEDIATE');
    if (!hasColumn('peers', 'persona_id'))
      sql.exec('ALTER TABLE peers ADD COLUMN persona_id TEXT NOT NULL DEFAULT "";');
    sql.exec('PRAGMA user_version=3;');
    sql.exec('COMMIT');
  }
  if (openedAt < 4) {
    sql.exec('BEGIN IMMEDIATE');
    if (!hasColumn('memories', 'invalid_at'))
      sql.exec('ALTER TABLE memories ADD COLUMN invalid_at INTEGER NOT NULL DEFAULT 0;');
    if (!hasColumn('memories', 'importance'))
      sql.exec('ALTER TABLE memories ADD COLUMN importance REAL NOT NULL DEFAULT 0.5;');
    sql.exec('PRAGMA user_version=4;');
    sql.exec('COMMIT');
  }
  if (openedAt < 5) {
    sql.exec('BEGIN IMMEDIATE');
    sql.exec(
      'CREATE INDEX IF NOT EXISTS outbox_peer_status ON outbox(peer_id,status);\n' +
        'CREATE INDEX IF NOT EXISTS usage_created ON usage(created_at);\n' +
        'CREATE INDEX IF NOT EXISTS memory_embeddings_peer_model ON memory_embeddings(peer_id,model);',
    );
    sql.exec('PRAGMA user_version=5;');
    sql.exec('COMMIT');
  }
  if (openedAt < 6) {
    sql.exec('BEGIN IMMEDIATE');
    sql.exec(
      'CREATE INDEX IF NOT EXISTS memories_peer_status_created ON memories(peer_id,status,created_at DESC);\n' +
        'CREATE INDEX IF NOT EXISTS messages_rhythm ON messages(peer_id,role,status,created_at);\n' +
        'CREATE INDEX IF NOT EXISTS outbox_status_created ON outbox(status,created_at DESC);\n' +
        'CREATE INDEX IF NOT EXISTS tasks_kind ON tasks(kind);\n' +
        'CREATE INDEX IF NOT EXISTS diary_peer_status_day ON diary_sections(peer_id,status,day);',
    );
    sql.exec('PRAGMA user_version=6;');
    sql.exec('COMMIT');
  }
  if (openedAt < 7) {
    sql.exec('BEGIN IMMEDIATE');
    // rowid 保持同步，旧库的删除仍是 O(1) 而不是虚拟表扫描。
    sql.exec(
      `INSERT OR REPLACE INTO search_docs(rowid,id,peer_id,kind,content,created_at)
       SELECT rowid,id,peer_id,kind,content,created_at FROM search_index;`,
    );
    sql.exec('PRAGMA user_version=7;');
    sql.exec('COMMIT');
  }
  if (openedAt < 8) {
    // 六变量列：S/D/R/E 现算不存列，旧行按中性速率从 created_at 开始遗忘。
    sql.exec('BEGIN IMMEDIATE');
    if (!hasColumn('memories', 'emotion'))
      sql.exec('ALTER TABLE memories ADD COLUMN emotion REAL NOT NULL DEFAULT 0;');
    if (!hasColumn('memories', 'emotion_reason'))
      sql.exec("ALTER TABLE memories ADD COLUMN emotion_reason TEXT NOT NULL DEFAULT '';");
    if (!hasColumn('memories', 'consolidation'))
      sql.exec('ALTER TABLE memories ADD COLUMN consolidation REAL NOT NULL DEFAULT 0;');
    if (!hasColumn('memories', 'interference'))
      sql.exec('ALTER TABLE memories ADD COLUMN interference REAL NOT NULL DEFAULT 0;');
    if (!hasColumn('diary_sections', 'emotion'))
      sql.exec('ALTER TABLE diary_sections ADD COLUMN emotion REAL NOT NULL DEFAULT 0;');
    sql.exec('PRAGMA user_version=8;');
    sql.exec('COMMIT');
  }
  if (openedAt < 9) {
    // 用量表补充缓存命中列：供应商的前缀缓存命中 token 单独记录，
    // 调试页据此展示渠道缓存是否实际生效（旧数据按 0 处理）。
    sql.exec('BEGIN IMMEDIATE');
    if (!hasColumn('usage', 'cached_tokens'))
      sql.exec('ALTER TABLE usage ADD COLUMN cached_tokens INTEGER NOT NULL DEFAULT 0;');
    if (!hasColumn('usage_daily', 'cached_tokens'))
      sql.exec('ALTER TABLE usage_daily ADD COLUMN cached_tokens INTEGER NOT NULL DEFAULT 0;');
    sql.exec('PRAGMA user_version=9;');
    sql.exec('COMMIT');
  }
  if (openedAt < 10) {
    // 主动 v2：想法表。旧 impulse 探询的设置键在启动时清掉。
    sql.exec('BEGIN IMMEDIATE');
    sql.exec(
      `CREATE TABLE IF NOT EXISTS initiatives (
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
      DELETE FROM settings WHERE key LIKE 'impulse_at:%';`,
    );
    sql.exec('PRAGMA user_version=10;');
    sql.exec('COMMIT');
  }
  if (openedAt < 11) {
    // 主动 v3：她的当下（全局单行）与生活流水。旧的 proactive 任务类型
    // 更名 pulse，旧键的静默冷却设置不再使用，启动时清掉。
    sql.exec('BEGIN IMMEDIATE');
    sql.exec(
      `CREATE TABLE IF NOT EXISTS self (
        id INTEGER PRIMARY KEY CHECK(id=1),
        activity TEXT NOT NULL DEFAULT '', activity_since INTEGER NOT NULL DEFAULT 0,
        plan TEXT NOT NULL DEFAULT '', plan_day TEXT NOT NULL DEFAULT '',
        social REAL NOT NULL DEFAULT 1, express REAL NOT NULL DEFAULT 0,
        last_stimulus_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0
      );
      INSERT OR IGNORE INTO self(id) VALUES(1);
      CREATE TABLE IF NOT EXISTS life_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, kind TEXT NOT NULL,
        text TEXT NOT NULL, artifact TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS life_log_at ON life_log(at DESC);
      DELETE FROM settings WHERE key LIKE 'silence_cooldown:%' OR key LIKE 'muse_seeded_at:%';`,
    );
    sql.exec('PRAGMA user_version=11;');
    sql.exec('COMMIT');
  }
  if (openedAt < 12) {
    // 她只属于一个人：本地试聊（preview 渠道）整体退场，心跳/日记不再漏进
    // 无人渠道。子表按 deletePeer 的同一依赖序删（outbox 引用 messages 与
    // tasks，必须最先；search_index 按 search_docs 的 rowid 删）。
    sql.exec('BEGIN IMMEDIATE');
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
      DELETE FROM peers WHERE channel='preview';`,
    );
    sql.exec('PRAGMA user_version=12;');
    sql.exec('COMMIT');
  }
}
