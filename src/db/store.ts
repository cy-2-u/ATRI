import { DatabaseSync, backup } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, unlinkSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { cosineSimilarity } from '../llm.js';
import { hourFormatter, addYear, epochOfWallTime } from './format.js';
import {
  accessibility,
  consolidationGain,
  detailIntegrity,
  emotionalResidue,
  isForgotten,
  significance,
  traceOf,
  CONSOLIDATION_RESTATE_GAIN,
  INTERFERENCE_BUMP,
  MOOD_CONGRUENCE_BOOST,
} from './memory-model.js';
import type { MemoryTraceLike } from './memory-model.js';
import {
  SCHEMA_VERSION,
  migrate,
  parse,
  MEMORY_HALFLIFE_DAYS,
  MEMORY_STATED_WEIGHT,
  MEMORY_INTERPRETATION_WEIGHT,
  MEMORY_HIT_COOLDOWN_MINUTES,
  OPEN_LOOP_EXPIRE_DAYS,
  SOFT_THREAD_EXPIRE_DAYS,
  SOFT_THREAD_MAX,
  SOFT_THREAD_REVISIT_DAYS,
  SOFT_THREAD_REVISIT_MAX_DAYS,
  MOOD_VALENCE_HALFLIFE_HOURS,
  MOOD_ENERGY_HALFLIFE_HOURS,
  MOOD_PATIENCE_HALFLIFE_HOURS,
  MOOD_PULSE_SHARE,
  USAGE_RETENTION_DAYS,
  MAX_TASK_ATTEMPTS,
  TASK_RETENTION_DAYS,
  LIFE_LOG_KEEP,
  UNCERTAIN_HOLD_MS,
  NOTES_MAX_CHARS,
  type Row,
  type TaskKind,
  type SourceKind,
  type Peer,
  type Media,
  type Message,
  type Task,
  type Memory,
  type OpenLoop,
  type OpenLoopInput,
  type SoftThreadKind,
  type SoftThread,
  type SoftThreadInput,
  type Initiative,
  type InitiativeInput,
  type InitiativeKind,
  type SelfState,
  type SelfPatch,
  type LifeEntry,
  type MoodState,
  type DiarySection,
  type MemoryUpdate,
  type ReplyPart,
  type Delivery,
  type SearchHit,
  type EmbeddingVector,
} from './schema.js';

/** 数据层：SQLite（WAL）之上的一站式 Store。所有检索、来源与任务都按
 *  联系人隔离；写路径通过 peers.version 做乐观并发。 */

const USAGE_ROLLUP_INTERVAL_MS = 60 * 60 * 1000;
const USAGE_CACHE_MS = 5000;
const DF_CACHE_MS = 5 * 60 * 1000;
const RHYTHM_CACHE_MS = 5 * 60 * 1000;
/** 每次向量召回参与打分的候选上限（远大于最终进入提示词的条数）。 */
const SEARCH_VECTOR_CANDIDATES = 800;

export {
  SCHEMA_VERSION,
  MEMORY_HALFLIFE_DAYS,
  MEMORY_STATED_WEIGHT,
  MEMORY_INTERPRETATION_WEIGHT,
  MEMORY_HIT_COOLDOWN_MINUTES,
  OPEN_LOOP_EXPIRE_DAYS,
  SOFT_THREAD_EXPIRE_DAYS,
  SOFT_THREAD_MAX,
  SOFT_THREAD_REVISIT_DAYS,
  SOFT_THREAD_REVISIT_MAX_DAYS,
  MOOD_VALENCE_HALFLIFE_HOURS,
  MOOD_ENERGY_HALFLIFE_HOURS,
  MOOD_PATIENCE_HALFLIFE_HOURS,
  MOOD_PULSE_SHARE,
  USAGE_RETENTION_DAYS,
  MAX_TASK_ATTEMPTS,
  UNCERTAIN_HOLD_MS,
  NOTES_MAX_CHARS,
  hourFormatter,
  addYear,
  epochOfWallTime,
};
export type {
  TaskKind,
  SourceKind,
  Peer,
  Media,
  Message,
  Task,
  Memory,
  OpenLoop,
  OpenLoopInput,
  SoftThreadKind,
  SoftThread,
  SoftThreadInput,
  InitiativeKind,
  Initiative,
  InitiativeInput,
  SelfState,
  SelfPatch,
  LifeEntry,
  MoodState,
  DiarySection,
  MemoryUpdate,
  ReplyPart,
  Delivery,
  SearchHit,
  EmbeddingVector,
};

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export class Store {
  readonly sql: DatabaseSync;
  private transactionDepth = 0;
  /** 按联系人版本号缓存的小型查询缓存。 */
  private memoryCache = new Map<string, { version: number; memories: Memory[] }>();
  private dfCache = new Map<string, { at: number; total: number; counts: Map<string, number> }>();
  private rhythmCache = new Map<string, { version: number; at: number; buckets: number[] }>();
  private lastUsageRollup = 0;
  private usageCache?: { at: number; rows: Row[] };

  constructor(readonly path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.sql = new DatabaseSync(path);
    migrate(this.sql);
  }
  close() {
    this.sql.close();
  }
  transaction<T>(fn: () => T): T {
    if (this.transactionDepth) return fn();
    this.sql.exec('BEGIN IMMEDIATE');
    this.transactionDepth = 1;
    try {
      const result = fn();
      this.sql.exec('COMMIT');
      return result;
    } catch (error) {
      this.sql.exec('ROLLBACK');
      throw error;
    } finally {
      this.transactionDepth = 0;
    }
  }

  // ---------- 设置 ----------

  getSetting<T>(key: string, fallback: T): T {
    return parse(
      this.sql.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value,
      fallback,
    );
  }
  setSetting(key: string, value: unknown) {
    this.sql
      .prepare(
        'INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      )
      .run(key, JSON.stringify(value));
  }
  removeSetting(key: string) {
    this.sql.prepare('DELETE FROM settings WHERE key=?').run(key);
  }

  // ---------- 联系人 ----------

  ensurePeer(
    id: string,
    channel: string,
    address: string,
    token = '',
    approved = false,
    now = Date.now(),
  ): Peer {
    this.sql
      .prepare(
        `INSERT INTO peers(id,channel,address,context_token,approved,created_at) VALUES(?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET context_token=CASE WHEN excluded.context_token<>'' THEN excluded.context_token ELSE peers.context_token END`,
      )
      .run(id, channel, address, token, approved ? 1 : 0, now);
    return this.peer(id)!;
  }
  peer(id: string) {
    return this.sql.prepare('SELECT * FROM peers WHERE id=?').get(id) as unknown as
      Peer | undefined;
  }
  peers() {
    return this.sql
      .prepare('SELECT * FROM peers ORDER BY last_user_at DESC')
      .all() as unknown as Peer[];
  }
  approve(id: string, approved: boolean) {
    this.sql.prepare('UPDATE peers SET approved=? WHERE id=?').run(approved ? 1 : 0, id);
  }
  setPeerPersona(id: string, personaId: string) {
    this.sql.prepare('UPDATE peers SET persona_id=? WHERE id=?').run(personaId, id);
  }
  /** 硬删除联系人及其全部数据（子表有外键，须按依赖序删）。 */
  deletePeer(id: string): { memories: number; messages: number } | undefined {
    const peer = this.peer(id);
    if (!peer) return undefined;
    const counts = () => ({
      memories: Number(
        (
          this.sql.prepare('SELECT count(*) c FROM memories WHERE peer_id=?').get(id) as
            { c: number } | undefined
        )?.c ?? 0,
      ),
      messages: Number(
        (
          this.sql.prepare('SELECT count(*) c FROM messages WHERE peer_id=?').get(id) as
            { c: number } | undefined
        )?.c ?? 0,
      ),
    });
    const before = counts();
    const mediaFiles = this.mediaPathsFor(id);
    this.sql.exec('BEGIN IMMEDIATE');
    try {
      this.sql.prepare('DELETE FROM outbox WHERE peer_id=?').run(id);
      this.sql.prepare('DELETE FROM diary_sections WHERE peer_id=?').run(id);
      this.sql.prepare('DELETE FROM tasks WHERE peer_id=?').run(id);
      this.sql.prepare('DELETE FROM memory_embeddings WHERE peer_id=?').run(id);
      this.sql.prepare('DELETE FROM memories WHERE peer_id=?').run(id);
      this.sql.prepare('DELETE FROM open_loops WHERE peer_id=?').run(id);
      this.sql.prepare('DELETE FROM soft_threads WHERE peer_id=?').run(id);
      this.sql.prepare('DELETE FROM initiatives WHERE peer_id=?').run(id);
      this.sql.prepare('DELETE FROM messages WHERE peer_id=?').run(id);
      this.sql
        .prepare(
          'DELETE FROM search_index WHERE rowid IN (SELECT rowid FROM search_docs WHERE peer_id=?)',
        )
        .run(id);
      this.sql.prepare('DELETE FROM search_docs WHERE peer_id=?').run(id);
      // usage 是计费历史，联系人删了也保留计数。
      this.sql.prepare('DELETE FROM peers WHERE id=?').run(id);
      this.sql.exec('COMMIT');
    } catch (error) {
      this.sql.exec('ROLLBACK');
      throw error;
    }
    this.removeSetting(`diary_cursor:${id}`);
    this.removeSetting(`mood:${id}`);
    this.dfCache.delete(id);
    this.rhythmCache.delete(id);
    this.usageCache = undefined;
    // 重建的同 id 联系人 version 从 0 重新计：不删缓存会用旧记忆撞新版本号。
    this.memoryCache.delete(id);
    this.removeMediaFiles(mediaFiles);
    return before;
  }
  /** 删除刚被清空的行所引用的媒体文件（隐私与磁盘都要）。 */
  private removeMediaFiles(paths: string[]): void {
    if (this.path === ':memory:') return;
    const root = resolve(dirname(this.path));
    for (const path of new Set(paths)) {
      const full = resolve(root, path);
      if (!full.startsWith(root + sep)) continue;
      try {
        unlinkSync(full);
      } catch {
        /* 已不在或不是普通文件；数据库是权威 */
      }
    }
  }
  private mediaPathsFor(peer: string, id?: string): string[] {
    const rows = id
      ? this.sql.prepare('SELECT media FROM messages WHERE peer_id=? AND id=?').all(peer, id)
      : this.sql.prepare('SELECT media FROM messages WHERE peer_id=?').all(peer);
    const out: string[] = [];
    for (const row of rows)
      for (const item of parse<{ path?: string }[]>(row.media, []))
        if (typeof item.path === 'string') out.push(item.path);
    return out;
  }

  // ---------- 消息 ----------

  private message(row: Row): Message {
    return { ...row, media: parse(row.media, []) } as unknown as Message;
  }
  getMessage(peer: string, id: string) {
    const row = this.sql.prepare('SELECT * FROM messages WHERE peer_id=? AND id=?').get(peer, id);
    return row ? this.message(row) : undefined;
  }
  /** 落库一条入站消息（event_key 去重）；仅管理页更正写 system 角色——
   *  system 不是对方说的话，不能推动主动联系的静默时钟。 */
  ingest(
    peer: string,
    eventKey: string,
    content: string,
    media: Media[] = [],
    timestamp = Date.now(),
    role: 'user' | 'system' = 'user',
  ) {
    return this.transaction(() => {
      const existing = this.sql
        .prepare('SELECT * FROM messages WHERE peer_id=? AND event_key=?')
        .get(peer, eventKey);
      if (existing) return { duplicate: true, message: this.message(existing) };
      const id = randomUUID();
      this.sql
        .prepare(
          'INSERT INTO messages(id,peer_id,event_key,role,content,media,status,created_at) VALUES(?,?,?,?,?,?,?,?)',
        )
        .run(
          id,
          peer,
          eventKey,
          role,
          content,
          JSON.stringify(media),
          role === 'system' ? 'note' : 'received',
          timestamp,
        );
      if (role === 'user')
        this.sql
          .prepare('UPDATE peers SET version=version+1,last_user_at=MAX(last_user_at,?) WHERE id=?')
          .run(timestamp, peer);
      else this.sql.prepare('UPDATE peers SET version=version+1 WHERE id=?').run(peer);
      this.index(id, peer, 'message', content, timestamp);
      return { duplicate: false, message: this.getMessage(peer, id)! };
    });
  }
  updateMedia(peer: string, id: string, media: Media[]) {
    const message = this.getMessage(peer, id);
    if (!message || message.status === 'deleted') return;
    this.sql
      .prepare('UPDATE messages SET media=? WHERE peer_id=? AND id=?')
      .run(JSON.stringify(media), peer, id);
    if (['received', 'sent'].includes(message.status))
      this.index(
        id,
        peer,
        'message',
        message.content +
          media
            .filter((m) => m.description)
            .map((m) => `\n[模型对${m.kind}的观察：${m.description}]`)
            .join(''),
        message.created_at,
      );
  }
  history(peer: string, limit = 40, before = Number.MAX_SAFE_INTEGER): Message[] {
    return this.sql
      .prepare(
        "SELECT * FROM messages WHERE peer_id=? AND seq<=? AND status IN ('received','sent') ORDER BY seq DESC LIMIT ?",
      )
      .all(peer, before, Math.min(500, limit))
      .reverse()
      .map((r) => this.message(r));
  }
  historyAfter(
    peer: string,
    after: number,
    before = Number.MAX_SAFE_INTEGER,
    limit = 200,
  ): Message[] {
    return this.sql
      .prepare(
        "SELECT * FROM messages WHERE peer_id=? AND seq>? AND seq<=? AND status IN ('received','sent') ORDER BY seq LIMIT ?",
      )
      .all(peer, after, before, limit)
      .map((r) => this.message(r));
  }

  // ---------- 任务 ----------

  enqueue(
    peer: string,
    kind: TaskKind,
    key: string,
    payload: Record<string, unknown> = {},
    runAt = Date.now(),
  ): string {
    const id = randomUUID();
    this.sql
      .prepare(
        'INSERT OR IGNORE INTO tasks(id,peer_id,kind,dedupe_key,payload,run_at,created_at) VALUES(?,?,?,?,?,?,?)',
      )
      .run(id, peer, kind, key, JSON.stringify(payload), runAt, Date.now());
    // 复活终态但未完成的行：保持去重的同时允许之后的尝试真正运行；
    // attempts 保留，反复失败的任务要撞到重试上限而不是每分钟复活。
    this.sql
      .prepare(
        `UPDATE tasks SET state=CASE WHEN attempts>=? THEN state ELSE 'queued' END,
         payload=?,
         run_at=CASE WHEN state='failed' AND kind<>'chat' THEN MAX(run_at,?) ELSE ? END,
         error=''
         WHERE peer_id=? AND kind=? AND dedupe_key=? AND state IN ('failed','superseded','interrupted')`,
      )
      .run(MAX_TASK_ATTEMPTS, JSON.stringify(payload), runAt, runAt, peer, kind, key);
    return String(
      this.sql
        .prepare('SELECT id FROM tasks WHERE peer_id=? AND kind=? AND dedupe_key=?')
        .get(peer, kind, key)!.id,
    );
  }
  /** 等价任务是否已排队：调度器用它避免同一拍重复入队。 */
  hasPendingTask(peer: string, kind: TaskKind, key: string): boolean {
    return Boolean(
      this.sql
        .prepare(
          "SELECT 1 FROM tasks WHERE peer_id=? AND kind=? AND dedupe_key=? AND state IN ('queued','running') LIMIT 1",
        )
        .get(peer, kind, key),
    );
  }
  /** 连发合并：同一联系人已有排队中的 chat 就延后其 run_at 并推进 through。 */
  enqueueChat(peer: string, seq: number, debounceMs: number) {
    const existing = this.sql
      .prepare(
        "SELECT id FROM tasks WHERE peer_id=? AND kind='chat' AND state='queued' ORDER BY created_at LIMIT 1",
      )
      .get(peer);
    if (existing) {
      this.sql
        .prepare('UPDATE tasks SET payload=?,run_at=? WHERE id=?')
        .run(JSON.stringify({ through: seq }), Date.now() + debounceMs, String(existing.id));
      return String(existing.id);
    }
    return this.enqueue(peer, 'chat', String(seq), { through: seq }, Date.now() + debounceMs);
  }
  /** 是否已有更新的 chat 轮次在排队：被中断的旧轮次应被取代而不是重试。 */
  newerChatQueued(peer: string, through: number): boolean {
    return Boolean(
      this.sql
        .prepare(
          `SELECT 1 FROM tasks WHERE peer_id=? AND kind='chat' AND state='queued'
           AND CAST(json_extract(payload,'$.through') AS INTEGER)>? LIMIT 1`,
        )
        .get(peer, through),
    );
  }
  private task(row: Row): Task {
    return { ...row, payload: parse(row.payload, {}) } as unknown as Task;
  }
  taskById(id: string) {
    const row = this.sql.prepare('SELECT * FROM tasks WHERE id=?').get(id);
    return row ? this.task(row) : undefined;
  }
  /** 有活干且队列可以推进的联系人：送达不明只暂停 10 分钟，不是永久。 */
  readyPeers(now = Date.now()): string[] {
    const holdSince = now - UNCERTAIN_HOLD_MS;
    return this.sql
      .prepare(
        `SELECT DISTINCT p.id FROM peers p WHERE p.approved=1 AND
      NOT EXISTS(SELECT 1 FROM outbox WHERE peer_id=p.id AND status='uncertain' AND created_at>=?) AND
      (EXISTS(SELECT 1 FROM tasks WHERE peer_id=p.id AND state='queued' AND run_at<=?) OR EXISTS(SELECT 1 FROM outbox WHERE peer_id=p.id AND status='pending'))`,
      )
      .all(holdSince, now)
      .map((r) => String(r.id));
  }
  claim(peer: string, now = Date.now()): Task | undefined {
    return this.transaction(() => {
      const row = this.sql
        .prepare(
          `SELECT * FROM tasks WHERE peer_id=? AND state='queued' AND run_at<=? ORDER BY
        CASE kind WHEN 'chat' THEN 0 WHEN 'pulse' THEN 1 WHEN 'notes' THEN 2 WHEN 'diary' THEN 3 ELSE 4 END,created_at LIMIT 1`,
        )
        .get(peer, now);
      if (!row) return undefined;
      this.sql
        .prepare("UPDATE tasks SET state='running',version=?,attempts=attempts+1 WHERE id=?")
        .run(this.peer(peer)!.version, String(row.id));
      return this.taskById(String(row.id));
    });
  }
  finish(id: string, state = 'done', error = '') {
    this.sql
      .prepare('UPDATE tasks SET state=?,error=? WHERE id=?')
      .run(state, error.slice(0, 400), id);
  }
  retry(id: string, delay = 0) {
    this.sql
      .prepare(
        "UPDATE tasks SET state='queued',run_at=?,error='' WHERE id=? AND state NOT IN ('done','ready')",
      )
      .run(Date.now() + delay, id);
  }
  /** 失败退避：state 仍是 failed（待办可见、可被新回复取代），只推迟 run_at。 */
  deferFailed(id: string, delay: number) {
    this.sql
      .prepare("UPDATE tasks SET run_at=? WHERE id=? AND state='failed'")
      .run(Date.now() + delay, id);
  }
  /** 重启恢复：运行中的任务回队，发送中的投递转"送达不明"。 */
  recover() {
    this.transaction(() => {
      this.sql.exec(
        "UPDATE tasks SET state='queued' WHERE state='running'; UPDATE outbox SET status='uncertain',error='进程在发送确认前退出，请确认是否送达' WHERE status='sending'; UPDATE messages SET status='uncertain' WHERE id IN (SELECT id FROM outbox WHERE status='uncertain');",
      );
    });
  }
  pendingDeliveries(peer: string): Delivery[] {
    return this.sql
      .prepare(
        "SELECT * FROM outbox WHERE peer_id=? AND status='pending' ORDER BY created_at,task_id,ordinal",
      )
      .all(peer)
      .map((r) => ({ ...r, part: parse(r.part, {}) }) as unknown as Delivery);
  }
  issues() {
    return {
      tasks: this.sql
        .prepare(
          "SELECT t.id,t.peer_id,p.address,t.kind,t.state,t.error,t.created_at FROM tasks t JOIN peers p ON p.id=t.peer_id WHERE t.state='failed' ORDER BY t.created_at DESC LIMIT 100",
        )
        .all(),
      deliveries: this.sql
        .prepare(
          "SELECT o.id,o.peer_id,p.address,o.task_id,o.status,o.error,o.created_at,m.content FROM outbox o JOIN peers p ON p.id=o.peer_id JOIN messages m ON m.id=o.id WHERE o.status IN ('uncertain','failed') ORDER BY o.created_at DESC LIMIT 100",
        )
        .all(),
    };
  }
  /** 保存回复气泡（先落库再投递）；版本不匹配时旧草稿整体作废。 */
  saveReply(task: Task, parts: ReplyPart[], updates: MemoryUpdate[], now = Date.now()): boolean {
    return this.transaction(() => {
      if (this.taskById(task.id)?.state !== 'running') return false;
      if (this.peer(task.peer_id)?.version !== task.version) {
        this.finish(task.id, 'superseded');
        return false;
      }
      for (const update of updates) this.writeMemory(task.peer_id, update, now);
      const validParts = parts.filter(
        (part) => part.type !== 'text' || Boolean((part.text ?? '').trim()),
      );
      validParts.forEach((part, ordinal) => {
        const id = `${task.id}:${ordinal}`;
        const content =
          part.type === 'text' ? part.text! : `[表情：${part.description ?? part.slug}]`;
        this.sql
          .prepare(
            "INSERT INTO messages(id,peer_id,role,content,status,created_at) VALUES(?,?,'assistant',?,'pending',?)",
          )
          .run(id, task.peer_id, content, now);
        this.sql
          .prepare(
            'INSERT INTO outbox(id,task_id,peer_id,ordinal,part,created_at) VALUES(?,?,?,?,?,?)',
          )
          .run(id, task.id, task.peer_id, ordinal, JSON.stringify(part), now);
      });
      this.finish(task.id, validParts.length ? 'ready' : 'done');
      if (task.kind === 'chat' && typeof task.payload.through === 'number')
        this.sql
          .prepare(
            "UPDATE tasks SET state='superseded' WHERE peer_id=? AND kind='chat' AND id<>? AND state IN ('queued','failed') AND CAST(json_extract(payload,'$.through') AS INTEGER)<=?",
          )
          .run(task.peer_id, task.id, task.payload.through);
      return true;
    });
  }
  deliveryById(id: string): { id: string; peer_id: string; status: string } | undefined {
    const row = this.sql.prepare('SELECT id,peer_id,status FROM outbox WHERE id=?').get(id);
    return row
      ? { id: String(row.id), peer_id: String(row.peer_id), status: String(row.status) }
      : undefined;
  }
  startDelivery(id: string): boolean {
    return (
      this.sql
        .prepare(
          "UPDATE outbox SET status='sending',attempts=attempts+1 WHERE id=? AND status='pending'",
        )
        .run(id).changes > 0
    );
  }
  /** 某气泡确定性失败后取消同任务其余未发气泡：半截回复不该继续发。 */
  cancelPendingForTask(taskId: string, exceptId: string, error: string): void {
    this.transaction(() => {
      this.sql
        .prepare(
          "UPDATE outbox SET status='cancelled',error=? WHERE task_id=? AND status='pending' AND id<>?",
        )
        .run(error.slice(0, 400), taskId, exceptId);
      this.sql
        .prepare(
          "UPDATE messages SET status='cancelled' WHERE id IN (SELECT id FROM outbox WHERE task_id=? AND status='cancelled')",
        )
        .run(taskId);
    });
  }
  markDelivery(
    id: string,
    status: 'sent' | 'uncertain' | 'failed' | 'pending' | 'cancelled',
    error = '',
    now = Date.now(),
  ): boolean {
    return this.transaction(() => {
      const row = this.sql.prepare('SELECT * FROM outbox WHERE id=?').get(id);
      if (!row) throw new Error('发送记录不存在');
      const current = String(row.status);
      // 显式迁移保护运维操作与发送方竞速：迟到的 sent 盖不掉刻意的取消。
      const allowed: Record<typeof status, readonly string[]> = {
        sent: ['pending', 'sending', 'uncertain'],
        uncertain: ['pending', 'sending'],
        failed: ['pending', 'sending', 'uncertain'],
        pending: ['failed', 'uncertain'],
        cancelled: ['pending', 'sending', 'failed', 'uncertain'],
      };
      if (current === status) return true;
      if (!allowed[status].includes(current)) return false;
      this.sql
        .prepare('UPDATE outbox SET status=?,error=? WHERE id=?')
        .run(status, error.slice(0, 400), id);
      this.sql.prepare('UPDATE messages SET status=? WHERE id=?').run(status, id);
      if (status === 'sent') {
        const msg = this.getMessage(String(row.peer_id), id)!;
        this.index(id, msg.peer_id, 'message', msg.content, msg.created_at);
        if (this.taskById(String(row.task_id))?.kind === 'pulse')
          this.sql.prepare('UPDATE peers SET last_proactive_at=? WHERE id=?').run(now, msg.peer_id);
      }
      const count = Number(
        this.sql
          .prepare(
            "SELECT count(*) AS n FROM outbox WHERE task_id=? AND status NOT IN ('sent','cancelled')",
          )
          .get(String(row.task_id))!.n,
      );
      if (!count) this.finish(String(row.task_id));
      return true;
    });
  }
  /** 清理终态任务与已结清投递；有外键指向 tasks 的表必须排除。 */
  pruneTasks(now = Date.now()): number {
    const cutoff = now - TASK_RETENTION_DAYS * 86400000;
    return this.transaction(() => {
      this.sql
        .prepare("DELETE FROM outbox WHERE status IN ('sent','cancelled') AND created_at < ?")
        .run(cutoff);
      const gone = this.sql
        .prepare(
          `DELETE FROM tasks WHERE state IN ('done','failed','superseded','interrupted')
           AND created_at < ?
           AND NOT EXISTS(SELECT 1 FROM outbox WHERE outbox.task_id=tasks.id)
           AND NOT EXISTS(SELECT 1 FROM diary_sections WHERE diary_sections.task_id=tasks.id)`,
        )
        .run(cutoff);
      // 任务被清掉后，它留下的 pending_effects 快照永远不会再被读取。
      this.sql
        .prepare(
          "DELETE FROM settings WHERE key LIKE 'pending_effects:%' AND substr(key, 17) NOT IN (SELECT id FROM tasks)",
        )
        .run();
      return Number(gone.changes);
    });
  }
  /** 新消息作废一切未发送的旧气泡；已发送的保留真实状态。 */
  cancelUnsent(task: Task): boolean {
    return this.transaction(() => {
      this.sql
        .prepare("UPDATE outbox SET status='cancelled' WHERE task_id=? AND status='pending'")
        .run(task.id);
      this.sql
        .prepare(
          "UPDATE messages SET status='cancelled' WHERE id IN (SELECT id FROM outbox WHERE task_id=? AND status='cancelled')",
        )
        .run(task.id);
      this.finish(task.id, 'superseded');
      return true;
    });
  }

  // ---------- 检索索引 ----------

  private index(id: string, peer: string, kind: SourceKind, content: string, at: number) {
    this.unindex(id);
    // 内容变了，旧向量不能存活。
    this.sql.prepare('DELETE FROM memory_embeddings WHERE id=?').run(id);
    const inserted = this.sql
      .prepare('INSERT INTO search_docs(id,peer_id,kind,content,created_at) VALUES(?,?,?,?,?)')
      .run(id, peer, kind, content, at);
    this.dfCache.delete(peer);
    this.sql
      .prepare(
        'INSERT INTO search_index(rowid,id,peer_id,kind,content,created_at) VALUES(?,?,?,?,?,?)',
      )
      .run(Number(inserted.lastInsertRowid), id, peer, kind, content, at);
  }
  private unindex(id: string) {
    const row = this.sql.prepare('SELECT rowid,peer_id FROM search_docs WHERE id=?').get(id);
    if (row) {
      this.sql.prepare('DELETE FROM search_index WHERE rowid=?').run(Number(row.rowid));
      this.dfCache.delete(String(row.peer_id));
    }
    this.sql.prepare('DELETE FROM search_docs WHERE id=?').run(id);
  }
  private describeHit(hit: SearchHit): SearchHit {
    if (hit.kind === 'message') {
      const role = this.sql.prepare('SELECT role FROM messages WHERE id=?').get(hit.id)?.role;
      return { ...hit, role: role as Message['role'] };
    }
    if (hit.kind === 'memory') {
      const row = this.sql
        .prepare(
          'SELECT kind,sources,importance,emotion,consolidation,interference,created_at,last_hit_at FROM memories WHERE id=?',
        )
        .get(hit.id) as Row | undefined;
      const state = row ? traceOf(row as unknown as MemoryTraceLike) : undefined;
      return {
        ...hit,
        sources: parse<string[]>(row?.sources, []),
        memory_kind: row?.kind as Memory['kind'],
        ...(state
          ? {
              detail: detailIntegrity(state, Date.now()),
              significance: significance(state, Date.now()),
              residue: emotionalResidue(state, Date.now()),
            }
          : {}),
      };
    }
    const row = this.sql
      .prepare('SELECT sources,emotion,created_at FROM diary_sections WHERE id=?')
      .get(hit.id) as Row | undefined;
    const emotion = Math.max(-1, Math.min(1, Number(row?.emotion ?? 0) || 0));
    // 日记没有演练跟踪：细节从写入起纯衰减，渲染层与记忆同一套阈值。
    const state = row
      ? traceOf({
          importance: 0.5,
          emotion,
          consolidation: 0,
          interference: 0,
          created_at: Number(row.created_at) || 0,
          last_hit_at: 0,
        })
      : undefined;
    return {
      ...hit,
      sources: parse<string[]>(row?.sources, []),
      residue: emotion,
      ...(state ? { detail: detailIntegrity(state, Date.now()) } : {}),
    };
  }
  /** 按 id 直取来源（含角色与依赖信息），一次查询取全组。 */
  sources(peer: string, ids: string[]): SearchHit[] {
    const wanted = [...new Set(ids)].slice(0, 40);
    if (!wanted.length) return [];
    const marks = wanted.map(() => '?').join(',');
    const rows = this.sql
      .prepare(
        `SELECT s.id AS id, s.kind AS kind, s.content AS content, s.created_at AS created_at,
                m.role AS role,
                mem.kind AS memory_kind, mem.sources AS memory_sources,
                d.sources AS diary_sources
         FROM search_docs s
         LEFT JOIN messages m ON m.id = s.id
         LEFT JOIN memories mem ON mem.id = s.id
         LEFT JOIN diary_sections d ON d.id = s.id
         WHERE s.peer_id = ? AND s.id IN (${marks})`,
      )
      .all(peer, ...wanted);
    const byId = new Map(rows.map((r) => [String(r.id), r]));
    return wanted.flatMap<SearchHit>((id) => {
      const row = byId.get(id);
      if (!row) return [];
      const base = {
        id: String(row.id),
        kind: String(row.kind) as SourceKind,
        content: String(row.content),
        created_at: Number(row.created_at),
        score: 1,
      };
      if (base.kind === 'message') return [{ ...base, role: row.role as Message['role'] }];
      return [
        {
          ...base,
          sources: parse<string[]>(
            row[base.kind === 'memory' ? 'memory_sources' : 'diary_sources'],
            [],
          ),
          ...(base.kind === 'memory' ? { memory_kind: row.memory_kind as Memory['kind'] } : {}),
        },
      ];
    });
  }

  // ---------- 记忆 ----------

  memories(peer: string): Memory[] {
    const version = Number(
      this.sql.prepare('SELECT version FROM peers WHERE id=?').get(peer)?.version ?? -1,
    );
    const cached = this.memoryCache.get(peer);
    // 出栈拷贝：调用方会就地排序/裁剪，交出缓存本体会让一次排序永久污染后续读取。
    if (cached && cached.version === version) return cached.memories.slice();
    // 置顶单独取：最新 500 条的滑动窗口会漏掉很早以前置顶的记忆。
    const rows = this.sql
      .prepare(
        `SELECT * FROM memories WHERE peer_id=? AND status='active'
         AND (pinned=1 OR id IN (SELECT id FROM memories WHERE peer_id=? AND status='active' ORDER BY created_at DESC LIMIT 500))
         ORDER BY pinned DESC, created_at DESC`,
      )
      .all(peer, peer)
      .map((r) => ({ ...r, sources: parse(r.sources, []) }) as unknown as Memory);
    if (this.memoryCache.size > 64) this.memoryCache.clear();
    this.memoryCache.set(peer, { version, memories: rows });
    return rows.slice();
  }
  setMemoryPinned(peer: string, id: string, pinned: boolean) {
    const result = this.sql
      .prepare("UPDATE memories SET pinned=? WHERE peer_id=? AND id=? AND status='active'")
      .run(pinned ? 1 : 0, peer, id);
    if (!result.changes) throw new Error('记忆不存在');
    this.memoryCache.delete(peer);
  }
  rankedMemories(peer: string, limit = 10): Memory[] {
    return this.rankedMemoriesScored(peer, limit).map((s) => s.memory);
  }
  /** 六变量排序；可选传入当前心情的愉悦度，与残留同号的记忆获得很小的
   *  心境一致性加权。置顶不参与排序与衰减渲染。 */
  rankedMemoriesScored(
    peer: string,
    limit = 10,
    moodValence?: number,
  ): {
    memory: Memory;
    score: number;
    pinned: boolean;
    detail: number;
    significanceScore: number;
    residue: number;
  }[] {
    const now = Date.now();
    const scored: {
      memory: Memory;
      score: number;
      pinned: boolean;
      detail: number;
      significanceScore: number;
      residue: number;
    }[] = [];
    const congruentMood =
      moodValence !== undefined && Math.abs(moodValence) >= 0.12 ? moodValence : undefined;
    for (const m of this.memories(peer)) {
      if (m.pinned) {
        scored.push({
          memory: m,
          score: Number.MAX_SAFE_INTEGER,
          pinned: true,
          detail: 1,
          significanceScore: 1,
          residue: 0,
        });
        continue;
      }
      const state = traceOf(m);
      if (isForgotten(state, now)) continue;
      const D = detailIntegrity(state, now);
      const S = significance(state, now);
      const E = emotionalResidue(state, now);
      const kindWeight = m.kind === 'stated' ? MEMORY_STATED_WEIGHT : MEMORY_INTERPRETATION_WEIGHT;
      const congruent =
        congruentMood !== undefined &&
        Math.abs(E) >= 0.05 &&
        Math.sign(E) === Math.sign(congruentMood)
          ? 1 + MOOD_CONGRUENCE_BOOST
          : 1;
      const score =
        (0.55 + 0.45 * S) *
        accessibility(state, now) *
        (1 + 0.25 * Math.abs(E)) *
        congruent *
        kindWeight;
      scored.push({ memory: m, score, pinned: false, detail: D, significanceScore: S, residue: E });
    }
    return scored
      .sort((a, b) => b.score - a.score || b.memory.created_at - a.memory.created_at)
      .slice(0, limit);
  }
  /** 演练：hits+1、巩固按间隔增长、细节时钟重置。返回仍带强残留的条目，
   *  供运行时把"想起了什么"泛化成此刻的心情。 */
  markMemoriesUsed(
    peer: string,
    ids: string[],
    now = Date.now(),
  ): { id: string; emotion: number; reason: string }[] {
    const unique = [...new Set(ids)];
    if (!unique.length) return [];
    const cooldownBefore = now - MEMORY_HIT_COOLDOWN_MINUTES * 60000;
    const placeholders = unique.map(() => '?').join(',');
    const marks = this.sql
      .prepare(
        `SELECT * FROM memories WHERE peer_id=? AND status='active' AND last_hit_at<=?
         AND id IN (${placeholders})`,
      )
      .all(peer, cooldownBefore, ...unique) as Row[];
    if (marks.length) this.memoryCache.delete(peer);
    const residues: { id: string; emotion: number; reason: string }[] = [];
    for (const row of marks) {
      const state = traceOf(row as unknown as MemoryTraceLike);
      const gap = now - state.rehearseAt;
      this.sql
        .prepare(
          'UPDATE memories SET hits=hits+1, last_hit_at=?, consolidation=MIN(1, consolidation+?) WHERE id=?',
        )
        .run(now, consolidationGain(gap), String(row.id));
      const residue = emotionalResidue(state, now);
      if (Math.abs(residue) >= 0.35)
        residues.push({
          id: String(row.id),
          emotion: residue,
          reason: String((row as Row).emotion_reason ?? ''),
        });
    }
    return residues;
  }
  /** 气泡投递后的记忆落库：版本不匹配（期间来了新消息）时整体放弃。 */
  applyMemoryUpdates(
    peer: string,
    expectedVersion: number,
    updates: MemoryUpdate[],
    now = Date.now(),
  ): number {
    return this.transaction(() => {
      if (this.peer(peer)?.version !== expectedVersion) return 0;
      let written = 0;
      for (const update of updates) if (this.writeMemory(peer, update, now)) written++;
      return written;
    });
  }
  /** 情绪基线：所有还想得起来的残留按意义加权的总和，钳在 ±0.3。 */
  emotionalBaseline(peer: string, now = Date.now()): number {
    let sum = 0;
    for (const m of this.memories(peer)) {
      const state = traceOf(m);
      if (isForgotten(state, now)) continue;
      const residue = emotionalResidue(state, now);
      if (Math.abs(residue) < 0.05) continue;
      sum += residue * significance(state, now);
    }
    return Math.max(-0.3, Math.min(0.3, sum * 0.2));
  }
  /** 闪回候选：意义重、带残留、≥3 天没被想起的旧记忆。 */
  flashbackCandidates(peer: string, now = Date.now(), limit = 2): Memory[] {
    return this.memories(peer)
      .filter((m) => !m.pinned)
      .filter((m) => {
        const state = traceOf(m);
        return (
          now - m.created_at >= 3 * 86400000 &&
          (m.last_hit_at === 0 || now - m.last_hit_at >= 7 * 86400000) &&
          !isForgotten(state, now)
        );
      })
      .map((m) => {
        const state = traceOf(m);
        return {
          m,
          rank: Math.abs(emotionalResidue(state, now)) * 0.6 + significance(state, now) * 0.4,
        };
      })
      .sort((a, b) => b.rank - a.rank)
      .slice(0, limit)
      .map((x) => x.m);
  }
  /** 应用 supersedes：旧条退出默认召回但保留文本与失效时刻。 */
  private supersede(peer: string, ids: string[], now: number) {
    for (const previous of ids) {
      if (
        this.sql
          .prepare(
            "UPDATE memories SET status='superseded',invalid_at=? WHERE peer_id=? AND id=? AND status='active'",
          )
          .run(now, peer, previous).changes
      ) {
        this.unindex(previous);
        // 被替代的向量继续参与语义去重判断会污染召回。
        this.sql
          .prepare('DELETE FROM memory_embeddings WHERE peer_id=? AND id=?')
          .run(peer, previous);
      }
    }
  }
  /** 落库一条记忆更新：来源必须是本轮真实存在的非记忆来源；stated 还需
   *  对方原话（或管理员更正）为证。同文重述合并证据并巩固。 */
  private writeMemory(peer: string, update: MemoryUpdate, now: number): string | undefined {
    this.memoryCache.delete(peer);
    const rawIds = [...new Set(update.sources)];
    const found = this.sources(peer, rawIds);
    const byId = new Map(found.map((s) => [s.id, s]));
    const keptIds = rawIds.filter((id) => {
      const s = byId.get(id);
      return s && s.kind !== 'memory';
    });
    const statedOk =
      update.kind !== 'stated' ||
      keptIds.some((id) => {
        const s = byId.get(id);
        return s && s.kind === 'message' && (s.role === 'user' || s.role === 'system');
      });
    if (!update.content.trim() || !keptIds.length || !statedOk) return undefined;
    const ids = keptIds;
    const content = update.content.trim();
    const emotion = Math.max(-1, Math.min(1, update.emotion ?? 0));
    const sourceHash = sha(content + '\n' + [...ids].sort().join(','));
    const duplicate = this.sql
      .prepare(
        "SELECT id,sources FROM memories WHERE peer_id=? AND content=? AND status='active' LIMIT 1",
      )
      .get(peer, content.slice(0, 800)) as Row | undefined;
    if (duplicate) {
      const merged = [...new Set([...parse<string[]>(duplicate.sources, []), ...ids])].slice(0, 20);
      this.sql
        .prepare(
          `UPDATE memories SET sources=?,kind=?,importance=MAX(importance,?),
             consolidation=MIN(1, consolidation+?),
             emotion=CASE WHEN ?<>0 THEN ? ELSE emotion END,
             emotion_reason=CASE WHEN ?<>0 THEN ? ELSE emotion_reason END
           WHERE id=?`,
        )
        .run(
          JSON.stringify(merged),
          update.kind,
          Math.max(0, Math.min(1, update.importance ?? 0.5)),
          CONSOLIDATION_RESTATE_GAIN,
          emotion,
          emotion,
          emotion,
          update.emotionReason ?? '',
          String(duplicate.id),
        );
      // 更正不许可替代刚合并到的那一行本身。
      this.supersede(
        peer,
        (update.supersedes ?? []).filter((previous) => previous !== String(duplicate.id)),
        now,
      );
      this.memoryCache.delete(peer);
      return String(duplicate.id);
    }
    const id = randomUUID();
    const inserted = this.sql
      .prepare(
        `INSERT OR IGNORE INTO memories(id,peer_id,content,kind,sources,source_hash,importance,emotion,emotion_reason,created_at)
         VALUES(?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        peer,
        content.slice(0, 800),
        update.kind,
        JSON.stringify(ids),
        sourceHash,
        Math.max(0, Math.min(1, update.importance ?? 0.5)),
        emotion,
        (update.emotionReason ?? '').slice(0, 80),
        now,
      );
    if (!inserted.changes) {
      // (content, sources) 已存在——可能是被替代行的重述：复活而不是丢弃。
      const existing = this.sql
        .prepare('SELECT id FROM memories WHERE peer_id=? AND source_hash=?')
        .get(peer, sourceHash) as Row | undefined;
      if (existing) {
        this.sql
          .prepare(
            "UPDATE memories SET content=?,kind=?,status='active',invalid_at=0,sources=?,importance=MAX(importance,?),emotion=?,emotion_reason=? WHERE id=?",
          )
          .run(
            content.slice(0, 800),
            update.kind,
            JSON.stringify(ids),
            Math.max(0, Math.min(1, update.importance ?? 0.5)),
            emotion,
            (update.emotionReason ?? '').slice(0, 80),
            String(existing.id),
          );
        this.index(String(existing.id), peer, 'memory', content.slice(0, 800), now);
        this.supersede(peer, update.supersedes ?? [], now);
        this.memoryCache.delete(peer);
        return String(existing.id);
      }
      return undefined;
    }
    // 干扰在新记忆进索引前算：查询不能看到它自己。
    this.bumpInterference(peer, content, new Set([id, ...(update.supersedes ?? [])]));
    this.supersede(peer, update.supersedes ?? [], now);
    this.index(id, peer, 'memory', content.slice(0, 800), now);
    return id;
  }
  /** 词面最相近的至多 4 条旧记忆干扰 +0.1：同类事实攒得越多旧的越快模糊。 */
  private bumpInterference(peer: string, content: string, exclude: Set<string>): void {
    const hits = this.search(peer, content, 4, 'memory');
    let touched = false;
    for (const hit of hits) {
      if (exclude.has(hit.id)) continue;
      this.sql
        .prepare(
          "UPDATE memories SET interference=MIN(1, interference+?) WHERE peer_id=? AND id=? AND status='active'",
        )
        .run(INTERFERENCE_BUMP, peer, hit.id);
      touched = true;
    }
    if (touched) this.memoryCache.delete(peer);
  }
  addMemory(peer: string, update: MemoryUpdate, expectedVersion: number) {
    return this.transaction(() => {
      if (this.peer(peer)?.version !== expectedVersion) return false;
      return this.writeMemory(peer, update, Date.now()) !== undefined;
    });
  }
  /** 管理页更正：写一条 system 修正消息作为新证据，原子替代旧条并继承
   *  hits/置顶；清空话题笔记迫使按新事实重整。 */
  correctMemory(peer: string, id: string, content: string) {
    this.transaction(() => {
      const original = this.sql
        .prepare(
          "SELECT id,hits,last_hit_at,pinned FROM memories WHERE peer_id=? AND id=? AND status='active'",
        )
        .get(peer, id) as Row | undefined;
      if (!original) throw new Error('记忆不存在');
      const msg = this.ingest(
        peer,
        randomUUID(),
        `[管理页更正] ${content}`,
        [],
        Date.now(),
        'system',
      ).message;
      const carried = {
        hits: Number(original.hits ?? 0),
        at: Number(original.last_hit_at ?? 0),
        pinned: Number(original.pinned ?? 0),
      };
      const written = this.writeMemory(
        peer,
        { content, kind: 'stated', sources: [msg.id], supersedes: [id] },
        Date.now(),
      );
      if (!written) throw new Error('更正内容无法写入');
      this.sql
        .prepare('UPDATE memories SET hits=?,last_hit_at=?,pinned=? WHERE id=?')
        .run(carried.hits, carried.at, carried.pinned, written);
      this.sql.prepare("UPDATE peers SET notes='',notes_until=0 WHERE id=?").run(peer);
    });
  }

  // ---------- 日记 ----------

  diaries(peer: string): DiarySection[] {
    return this.sql
      .prepare(
        "SELECT * FROM diary_sections WHERE peer_id=? AND status='active' ORDER BY day DESC,created_at,ordinal LIMIT 500",
      )
      .all(peer)
      .map((r) => ({ ...r, sources: parse(r.sources, []) }) as unknown as DiarySection);
  }
  /** 覆盖墙钟日期窗口的日记段落。久别重逢时按时间范围取（"在吗"匹配
   *  不了任何词面），day 是本地日期可直接按字符串比较。 */
  diaryBetween(peer: string, fromDay: string, toDay: string, limit = 4): DiarySection[] {
    return this.sql
      .prepare(
        "SELECT * FROM diary_sections WHERE peer_id=? AND status='active' AND day BETWEEN ? AND ? ORDER BY day,ordinal LIMIT ?",
      )
      .all(peer, fromDay, toDay, limit)
      .map((r) => ({ ...r, sources: parse(r.sources, []) }) as unknown as DiarySection);
  }
  saveDiary(
    task: Task,
    day: string,
    sections: { content: string; sources: string[]; emotion?: number }[],
    updates: MemoryUpdate[],
    now = Date.now(),
  ) {
    this.transaction(() => {
      if (this.taskById(task.id)?.state !== 'running') return;
      sections.forEach((section, ordinal) => {
        const sources = this.sources(task.peer_id, section.sources);
        if (
          !section.sources.length ||
          sources.length !== new Set(section.sources).size ||
          sources.some((s) => s.kind !== 'message')
        )
          return;
        const id = `diary:${task.id}:${ordinal}`;
        this.sql
          .prepare(
            'INSERT OR IGNORE INTO diary_sections(id,peer_id,task_id,ordinal,day,content,sources,emotion,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
          )
          .run(
            id,
            task.peer_id,
            task.id,
            ordinal,
            day,
            section.content,
            JSON.stringify(section.sources),
            Math.max(-1, Math.min(1, section.emotion ?? 0)),
            now,
          );
        // 索引库里实际存的文本：重试时 INSERT OR IGNORE 留下的是旧行。
        const saved = this.sql
          .prepare('SELECT content FROM diary_sections WHERE id=? AND peer_id=?')
          .get(id, task.peer_id) as Row | undefined;
        if (saved) this.index(id, task.peer_id, 'diary', String(saved.content), now);
      });
      if (this.peer(task.peer_id)?.version === task.version)
        for (const update of updates) this.writeMemory(task.peer_id, update, now);
      if (typeof task.payload.through === 'number' && Number.isFinite(task.payload.through)) {
        // 游标是高水位：旧任务晚完成不能把游标倒回去重复写日记。
        const cursor = this.getSetting<number>(`diary_cursor:${task.peer_id}`, 0);
        if (task.payload.through > cursor)
          this.setSetting(`diary_cursor:${task.peer_id}`, task.payload.through);
      }
      this.finish(task.id);
    });
  }
  /** 话题笔记是"截至 seq N"的快照：过期任务不能覆盖更新的快照。 */
  setNotes(task: Task, notes: string, through: number) {
    this.transaction(() => {
      const peer = this.peer(task.peer_id);
      if (peer?.version === task.version && through >= peer.notes_until)
        this.sql
          .prepare('UPDATE peers SET notes=?,notes_until=? WHERE id=?')
          .run(notes.slice(0, NOTES_MAX_CHARS), through, task.peer_id);
      this.finish(task.id);
    });
  }
  /** 删除一条来源：连带失效全部依赖链（固定点传播），清理检索、开环、
   *  挂念与向量；outbox 里的明文副本也一并清空。 */
  forget(peer: string, id: string) {
    const mediaFiles = this.mediaPathsFor(peer, id);
    this.transaction(() => {
      this.memoryCache.delete(peer);
      // 从表本身解析类型：被替代的记忆已出索引但行还在。
      const kind =
        (this.sql.prepare('SELECT kind FROM search_docs WHERE peer_id=? AND id=?').get(peer, id)
          ?.kind as SourceKind | undefined) ??
        (this.sql.prepare('SELECT 1 AS hit FROM messages WHERE peer_id=? AND id=?').get(peer, id)
          ? 'message'
          : this.sql.prepare('SELECT 1 AS hit FROM memories WHERE peer_id=? AND id=?').get(peer, id)
            ? 'memory'
            : this.sql
                  .prepare('SELECT 1 AS hit FROM diary_sections WHERE peer_id=? AND id=?')
                  .get(peer, id)
              ? 'diary'
              : undefined);
      if (!kind) throw new Error('记录不存在');
      if (kind === 'message')
        this.sql
          .prepare(
            "UPDATE messages SET content='',media='[]',status='deleted' WHERE peer_id=? AND id=?",
          )
          .run(peer, id);
      this.sql.prepare("UPDATE outbox SET part='{}' WHERE id=? AND peer_id=?").run(id, peer);
      if (kind === 'memory')
        this.sql
          .prepare(
            "UPDATE memories SET content='',sources='[]',status='deleted' WHERE peer_id=? AND id=?",
          )
          .run(peer, id);
      if (kind === 'diary')
        this.sql
          .prepare(
            "UPDATE diary_sections SET content='',sources='[]',status='deleted' WHERE peer_id=? AND id=?",
          )
          .run(peer, id);
      const invalid = new Set([id]);
      // 失效覆盖全部历史并迭代到固定点：依赖链（记忆→日记→记忆）只有
      // 反复扫到不再新增才传播完整；被替代/已删除的行同样参与。
      const load = (sqlText: string) =>
        this.sql
          .prepare(sqlText)
          .all(peer)
          .map((r) => ({ id: String(r.id), sources: parse<string[]>(r.sources, []) }));
      const diaries = load('SELECT id,sources FROM diary_sections WHERE peer_id=?');
      const memories = load('SELECT id,sources FROM memories WHERE peer_id=?');
      for (;;) {
        let changed = false;
        for (const diary of diaries)
          if (
            !invalid.has(diary.id) &&
            (diary.id === id || diary.sources.some((s) => invalid.has(s)))
          ) {
            invalid.add(diary.id);
            changed = true;
          }
        for (const mem of memories)
          if (!invalid.has(mem.id) && mem.sources.some((s) => invalid.has(s))) {
            invalid.add(mem.id);
            changed = true;
          }
        if (!changed) break;
      }
      for (const sourceId of invalid) {
        this.sql
          .prepare(
            "UPDATE diary_sections SET content='',sources='[]',status='deleted' WHERE peer_id=? AND id=? AND status<>'deleted'",
          )
          .run(peer, sourceId);
        this.sql
          .prepare(
            "UPDATE memories SET content='',sources='[]',status='deleted' WHERE peer_id=? AND id=? AND status<>'deleted'",
          )
          .run(peer, sourceId);
        this.unindex(sourceId);
      }
      // 开环与挂念的正文直接引用被删消息的内容。
      for (const loop of this.sql
        .prepare('SELECT id,sources FROM open_loops WHERE peer_id=?')
        .all(peer) as Row[]) {
        const sources = parse<string[]>(loop.sources, []);
        if (sources.some((s) => invalid.has(s)))
          this.sql
            .prepare("UPDATE open_loops SET content='',sources='[]',status='expired' WHERE id=?")
            .run(String(loop.id));
      }
      for (const thread of this.sql
        .prepare('SELECT id,sources FROM soft_threads WHERE peer_id=?')
        .all(peer) as Row[]) {
        const sources = parse<string[]>(thread.sources, []);
        if (sources.some((s) => invalid.has(s)))
          this.sql
            .prepare("UPDATE soft_threads SET content='',sources='[]',status='expired' WHERE id=?")
            .run(String(thread.id));
      }
      this.dropEmbeddings(peer, [...invalid]);
      this.sql
        .prepare("UPDATE peers SET notes='',notes_until=0,version=version+1 WHERE id=?")
        .run(peer);
    });
    this.removeMediaFiles(mediaFiles);
  }

  // ---------- 检索 ----------

  /** 缺向量的行（待嵌入）。 */
  pendingEmbeddings(
    peer: string,
    limit = 64,
  ): { id: string; kind: SourceKind; content: string; created_at: number }[] {
    return this.sql
      .prepare(
        `SELECT s.id,s.kind,s.content,s.created_at FROM search_docs s
       LEFT JOIN memory_embeddings e ON e.id=s.id
       WHERE s.peer_id=? AND e.id IS NULL
       ORDER BY s.created_at DESC LIMIT ?`,
      )
      .all(peer, limit)
      .map((r) => ({
        id: String(r.id),
        kind: String(r.kind) as SourceKind,
        content: String(r.content),
        created_at: Number(r.created_at),
      }));
  }
  /** 混合检索：FTS trigram + LIKE 兜底 + IDF 词面打分 + 可选向量语义召回
   *  + 近度/类型加权 + MMR 去冗余。 */
  search(
    peer: string,
    query: string,
    limit = 6,
    kind?: SourceKind,
    queryVector?: Float32Array,
    // 不同嵌入模型（或维度）的向量与查询向量做余弦是伪相关，必须过滤。
    queryVectorModel = '',
    exclude?: ReadonlySet<string>,
  ): SearchHit[] {
    const normalized = query.normalize('NFKC').toLowerCase();
    const words = normalized.match(/[\p{L}\p{N}]+/gu) ?? [];
    const terms = [
      ...new Set(
        words.flatMap((w) =>
          /\p{Script=Han}/u.test(w)
            ? [w, ...Array.from({ length: Math.max(0, w.length - 1) }, (_, i) => w.slice(i, i + 2))]
            : [w],
        ),
      ),
    ]
      .filter((t) => t.length >= 2)
      .slice(0, 48);
    if (!terms.length && normalized.trim()) terms.push(normalized.trim());
    if (!terms.length) return [];
    const rows: Row[] = [];
    const kindClause = kind ? ' AND d.kind=?' : '',
      kindParameters = kind ? [kind] : [];
    const longTerms = terms.filter((t) => [...t].length >= 3).slice(0, 20);
    if (longTerms.length) {
      const match = longTerms.map((t) => '"' + t.replaceAll('"', '""') + '"').join(' OR ');
      rows.push(
        ...this.sql
          .prepare(
            'SELECT d.id,d.kind,d.content,d.created_at FROM search_docs d JOIN search_index ON search_index.rowid=d.rowid WHERE d.peer_id=? AND search_index MATCH ?' +
              kindClause +
              ' ORDER BY rank LIMIT 150',
          )
          .all(peer, match, ...kindParameters),
      );
    }
    // LIKE 只在 FTS 不够且存在短于 trigram 的词时补扫。
    const hasShortTerm = terms.some((t) => [...t].length < 3);
    if (rows.length < 20 && hasShortTerm) {
      const likeTerms = terms.slice(0, 32).map((t) => '%' + t.replace(/[\\%_]/g, '\\$&') + '%');
      rows.push(
        ...this.sql
          .prepare(
            `SELECT d.id,d.kind,d.content,d.created_at FROM search_docs d WHERE d.peer_id=? AND (${likeTerms.map(() => "d.content LIKE ? ESCAPE '\\'").join(' OR ')})${kindClause} ORDER BY CAST(d.created_at AS INTEGER) DESC LIMIT 300`,
          )
          .all(peer, ...likeTerms, ...kindParameters),
      );
    }
    if (queryVector) {
      const modelFilter = queryVectorModel ? 'AND e.model=? AND e.dims=?' : '';
      rows.push(
        ...this.sql
          .prepare(
            `SELECT s.id,s.kind,s.content,s.created_at FROM memory_embeddings e JOIN search_docs s ON s.id=e.id
           WHERE e.peer_id=? ${kind ? 'AND s.kind=?' : ''} ${modelFilter}
           ORDER BY s.created_at DESC LIMIT ${SEARCH_VECTOR_CANDIDATES}`,
          )
          .all(
            peer,
            ...(kind ? [kind] : []),
            ...(queryVectorModel ? [queryVectorModel, queryVector.length] : []),
          )
          .map((r) => r as Row),
      );
    }
    // 一次查询取全部向量，代替逐行 prepare+get。
    const vectors = new Map<string, Float32Array>();
    if (queryVector) {
      const ids = [...new Set(rows.map((r) => String(r.id)))];
      for (let i = 0; i < ids.length; i += 400) {
        const slice = ids.slice(i, i + 400);
        for (const row of this.sql
          .prepare(
            `SELECT id,vector FROM memory_embeddings WHERE id IN (${slice.map(() => '?').join(',')})`,
          )
          .all(...slice) as Row[]) {
          const buf = row.vector as Buffer;
          vectors.set(
            String(row.id),
            new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)),
          );
        }
      }
    }
    const now = Date.now();
    const norm = (v: Float32Array) => {
      let n = 0;
      for (let i = 0; i < v.length; i++) n += v[i]! * v[i]!;
      return Math.sqrt(n);
    };
    // 词面 IDF：中文全被切成二元组后"有点"与"年糕"同权，除以文档频率后
    // 才是"这个词能定位一件事"；没出现过的词不设门槛（没有行能命中它）。
    const df = this.termFrequencies(peer, terms);
    const total = df.total;
    const weight = new Map<string, number>();
    for (const t of terms) {
      const seen = df.counts.get(t) ?? 0;
      weight.set(t, seen > 0 ? Math.log(1 + total / (1 + seen)) : 0);
    }
    const idfSum = [...weight.values()].reduce((a, b) => a + b, 0) || 1;
    const scored = [...new Map(rows.map((r) => [r.id, r])).values()]
      .filter((r) => !kind || r.kind === kind)
      .filter((r) => !exclude?.has(String(r.id)))
      .map((r) => {
        const body = String(r.content).normalize('NFKC').toLowerCase();
        let raw = 0;
        let minDf: number | undefined;
        for (const t of terms) {
          if (!body.includes(t)) continue;
          raw += Math.min(t.length, 8) * (weight.get(t) ?? 0);
          const seen = df.counts.get(t) ?? 0;
          if (minDf === undefined || seen < minDf) minDf = seen;
        }
        const lexical = (raw / idfSum) * 4;
        const vector = vectors.get(String(r.id));
        const semantic =
          queryVector && vector ? Math.max(0, cosineSimilarity(queryVector, vector)) : 0;
        // 近度加权只给真命中：完全不相干的新行不该排到精确命中的旧行前面。
        const ageDays = Math.max(0, now - Number(r.created_at)) / 86400000;
        const boost =
          semantic >= 0.35 || lexical > 0
            ? 1 + 0.2 * Math.pow(0.5, ageDays / MEMORY_HALFLIFE_DAYS)
            : 1;
        const base = lexical + semantic * 4;
        const kindBonus = lexical ? (r.kind === 'memory' ? 0.5 : r.kind === 'diary' ? 0.25 : 0) : 0;
        return {
          row: r,
          created_at: Number(r.created_at),
          score: (base + kindBonus) * boost,
          relevance: base,
          minDf,
          corpusSize: total,
          semantic,
          vector,
          norm: vector ? norm(vector) : 0,
        };
      })
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score || b.created_at - a.created_at);
    // MMR：top-k 不许是同一话题复读（λ=0.7，冗余只打破近平局）。
    const picked: typeof scored = [];
    const candidates = [...scored];
    const cap = Math.max(1, Math.min(limit, 20));
    const dot = (a: Float32Array, b: Float32Array) => {
      let sum = 0;
      for (let i = 0; i < a.length; i++) sum += a[i]! * b[i]!;
      return sum;
    };
    while (picked.length < cap && candidates.length) {
      let best = 0,
        bestScore = -Infinity;
      for (let i = 0; i < candidates.length; i++) {
        const candidate = candidates[i]!;
        let penalty = 0;
        for (const chosen of picked) {
          if (chosen.vector && candidate.vector && chosen.norm && candidate.norm)
            penalty = Math.max(
              penalty,
              dot(chosen.vector, candidate.vector) / (chosen.norm * candidate.norm),
            );
          else if (chosen.row.content === candidate.row.content) penalty = 1;
        }
        const value = 0.7 * candidate.score - 0.3 * penalty;
        if (value > bestScore) {
          bestScore = value;
          best = i;
        }
      }
      picked.push(candidates.splice(best, 1)[0]!);
    }
    return picked.map((p) =>
      this.describeHit({
        ...p.row,
        score: p.score,
        relevance: p.relevance,
        minDf: p.minDf,
        corpusSize: p.corpusSize,
        semantic: p.semantic,
      } as unknown as SearchHit),
    );
  }
  /** 查询词在该联系人已索引文本中的文档频率（带缓存）。 */
  private termFrequencies(
    peer: string,
    terms: string[],
  ): { counts: Map<string, number>; total: number } {
    if (!terms.length) return { counts: new Map(), total: 0 };
    const now = Date.now();
    let cached = this.dfCache.get(peer);
    if (cached && now - cached.at > DF_CACHE_MS) {
      this.dfCache.delete(peer);
      cached = undefined;
    }
    if (!cached) {
      const total = Number(
        (this.sql.prepare('SELECT COUNT(*) AS n FROM search_docs WHERE peer_id=?').get(peer) as Row)
          ?.n ?? 0,
      );
      cached = { at: now, total, counts: new Map() };
      this.dfCache.set(peer, cached);
    }
    if (!cached.total) return { counts: new Map(), total: 0 };
    const missing = terms.filter((t) => !cached!.counts.has(t));
    if (missing.length) {
      // 一条带 CASE 臂的 LIKE 扫描代替 48 次独立 COUNT。
      const arms = missing.map(
        (_, i) => `SUM(CASE WHEN content LIKE ? ESCAPE '\\' THEN 1 ELSE 0 END) AS t${i}`,
      );
      const patterns = missing.map((t) => '%' + t.replace(/[\\%_]/g, '\\$&') + '%');
      const row = this.sql
        .prepare(`SELECT ${arms.join(',')} FROM search_docs WHERE peer_id=?`)
        .get(...patterns, peer) as Row | undefined;
      missing.forEach((t, i) => cached!.counts.set(t, Number(row?.[`t${i}`] ?? 0)));
    }
    return {
      counts: new Map(terms.map((t) => [t, cached!.counts.get(t) ?? 0])),
      total: cached.total,
    };
  }

  // ---------- 开环与挂念 ----------

  openLoops(peer: string, onlyOpen = false): OpenLoop[] {
    return this.sql
      .prepare(
        `SELECT * FROM open_loops WHERE peer_id=? ${onlyOpen ? "AND status='open'" : ''} ORDER BY due_at LIMIT 100`,
      )
      .all(peer)
      .map((r) => ({ ...r, sources: parse(r.sources, []) }) as unknown as OpenLoop);
  }
  /** 到期待问：已到期、未问过、仍在询问窗口内。 */
  dueOpenLoops(peer: string, now = Date.now()): OpenLoop[] {
    return this.sql
      .prepare(
        `SELECT * FROM open_loops WHERE peer_id=? AND status='open' AND asked=0
         AND due_at<=? AND due_at>? ORDER BY due_at`,
      )
      .all(peer, now, now - OPEN_LOOP_EXPIRE_DAYS * 86400000)
      .map((r) => ({ ...r, sources: parse(r.sources, []) }) as unknown as OpenLoop);
  }
  addOpenLoop(peer: string, input: OpenLoopInput, now = Date.now()): OpenLoop {
    const content = input.content.slice(0, 300);
    // 同一安排常在下一轮被重复抽取：合并而不是再排一次提醒。
    const existing = this.sql
      .prepare(
        "SELECT * FROM open_loops WHERE peer_id=? AND status='open' AND content=? AND ABS(due_at-?)<3600000 ORDER BY created_at LIMIT 1",
      )
      .get(peer, content, input.dueAt) as Row | undefined;
    if (existing) {
      const sources = [
        ...new Set([...parse<string[]>(existing.sources, []), ...input.sources]),
      ].slice(0, 10);
      this.sql
        .prepare('UPDATE open_loops SET due_at=?,due_text=?,sources=? WHERE id=?')
        .run(
          input.dueAt,
          input.dueText ?? String(existing.due_text ?? ''),
          JSON.stringify(sources),
          String(existing.id),
        );
      return this.openLoopById(peer, String(existing.id));
    }
    const id = randomUUID();
    this.sql
      .prepare(
        'INSERT INTO open_loops(id,peer_id,content,due_at,due_text,sources,recurring,created_at) VALUES(?,?,?,?,?,?,?,?)',
      )
      .run(
        id,
        peer,
        content,
        input.dueAt,
        input.dueText ?? '',
        JSON.stringify([...new Set(input.sources)].slice(0, 10)),
        input.recurring === 'yearly' ? 'yearly' : '',
        now,
      );
    return this.openLoopById(peer, id);
  }
  openLoopById(peer: string, id: string): OpenLoop {
    const row = this.sql.prepare('SELECT * FROM open_loops WHERE peer_id=? AND id=?').get(peer, id);
    if (!row) throw new Error('开环记录不存在');
    return { ...row, sources: parse(row.sources, []) } as unknown as OpenLoop;
  }
  /** 了结：每年循环的约定滚到明年而不是关闭；dedupe key 含新到期日。 */
  resolveOpenLoop(peer: string, id: string, now = Date.now(), timeZone = 'Asia/Shanghai') {
    const loop = this.sql
      .prepare("SELECT recurring,due_at FROM open_loops WHERE peer_id=? AND id=? AND status='open'")
      .get(peer, id) as Row | undefined;
    if (!loop) return;
    if (String(loop.recurring) === 'yearly') {
      this.sql
        .prepare('UPDATE open_loops SET due_at=?,asked=0 WHERE peer_id=? AND id=?')
        .run(addYear(Number(loop.due_at), timeZone), peer, id);
      return;
    }
    this.sql
      .prepare(
        "UPDATE open_loops SET status='resolved',resolved_at=? WHERE peer_id=? AND id=? AND status='open'",
      )
      .run(now, peer, id);
  }
  loopTaskKey(loop: { id: string; due_at: number }): string {
    return `loop:${loop.id}:${loop.due_at}`;
  }
  markLoopAsked(peer: string, id: string) {
    this.sql
      .prepare("UPDATE open_loops SET asked=1 WHERE peer_id=? AND id=? AND status='open'")
      .run(peer, id);
  }
  /** 过期退场：yearly 不退（错过的生日还是明年的生日），滚到明年。 */
  expireOpenLoops(peer: string, now = Date.now(), timeZone = 'Asia/Shanghai') {
    const cutoff = now - OPEN_LOOP_EXPIRE_DAYS * 86400000;
    const yearly = this.sql
      .prepare(
        "SELECT id,due_at FROM open_loops WHERE peer_id=? AND status='open' AND recurring='yearly' AND due_at<=?",
      )
      .all(peer, cutoff) as Row[];
    for (const row of yearly)
      this.sql
        .prepare('UPDATE open_loops SET due_at=?,asked=0 WHERE peer_id=? AND id=?')
        .run(addYear(Number(row.due_at), timeZone), peer, String(row.id));
    this.sql
      .prepare(
        "UPDATE open_loops SET status='expired' WHERE peer_id=? AND status='open' AND recurring<>'yearly' AND due_at<=?",
      )
      .run(peer, cutoff);
  }
  softThreads(peer: string, onlyOpen = false): SoftThread[] {
    return this.sql
      .prepare(
        `SELECT * FROM soft_threads WHERE peer_id=? ${onlyOpen ? "AND status='open'" : ''} ORDER BY created_at DESC LIMIT 100`,
      )
      .all(peer)
      .map((r) => ({ ...r, sources: parse(r.sources, []) }) as unknown as SoftThread);
  }
  /** 到了可提起的窗口、仍开着、还在寿命内的挂念；已问过的保留 id 供了结。 */
  ripeSoftThreads(peer: string, now = Date.now()): SoftThread[] {
    return this.sql
      .prepare(
        `SELECT * FROM soft_threads WHERE peer_id=? AND status='open'
         AND created_at + revisit_after * 86400000 <= ? AND created_at > ?
         ORDER BY asked, created_at LIMIT ?`,
      )
      .all(peer, now, now - SOFT_THREAD_EXPIRE_DAYS * 86400000, SOFT_THREAD_MAX)
      .map((r) => ({ ...r, sources: parse(r.sources, []) }) as unknown as SoftThread);
  }
  addSoftThread(peer: string, input: SoftThreadInput, now = Date.now()): SoftThread {
    const content = input.content.slice(0, 300);
    const requested = Number(input.revisitAfter);
    const revisit = Number.isFinite(requested)
      ? Math.min(SOFT_THREAD_REVISIT_MAX_DAYS, Math.max(1, Math.round(requested)))
      : SOFT_THREAD_REVISIT_DAYS;
    // 重提同一挂念合并来源；created_at 不动，重复提起不会把窗口永远推后。
    const existing = this.sql
      .prepare(
        "SELECT * FROM soft_threads WHERE peer_id=? AND status='open' AND content=? ORDER BY created_at DESC LIMIT 1",
      )
      .get(peer, content) as Row | undefined;
    if (existing) {
      const sources = [
        ...new Set([...parse<string[]>(existing.sources, []), ...input.sources]),
      ].slice(0, 10);
      this.sql
        .prepare('UPDATE soft_threads SET kind=?,revisit_after=?,sources=? WHERE id=?')
        .run(input.kind, revisit, JSON.stringify(sources), String(existing.id));
      return this.softThreadById(peer, String(existing.id));
    }
    // 超过上限时淘汰最旧的，而不是拒绝新的。
    const open = this.sql
      .prepare("SELECT id FROM soft_threads WHERE peer_id=? AND status='open' ORDER BY created_at")
      .all(peer) as Row[];
    const excess = open.length - SOFT_THREAD_MAX + 1;
    for (let i = 0; i < excess; i++)
      this.sql
        .prepare("UPDATE soft_threads SET status='expired' WHERE id=?")
        .run(String(open[i]!.id));
    const id = randomUUID();
    this.sql
      .prepare(
        'INSERT INTO soft_threads(id,peer_id,content,kind,sources,revisit_after,created_at) VALUES(?,?,?,?,?,?,?)',
      )
      .run(
        id,
        peer,
        content,
        input.kind,
        JSON.stringify([...new Set(input.sources)].slice(0, 10)),
        revisit,
        now,
      );
    return this.softThreadById(peer, id);
  }
  softThreadById(peer: string, id: string): SoftThread {
    const row = this.sql
      .prepare('SELECT * FROM soft_threads WHERE peer_id=? AND id=?')
      .get(peer, id);
    if (!row) throw new Error('挂念记录不存在');
    return { ...row, sources: parse(row.sources, []) } as unknown as SoftThread;
  }
  resolveSoftThread(peer: string, id: string, now = Date.now()) {
    this.sql
      .prepare(
        "UPDATE soft_threads SET status='resolved',resolved_at=? WHERE peer_id=? AND id=? AND status='open'",
      )
      .run(now, peer, id);
  }
  markSoftThreadAsked(peer: string, id: string) {
    this.sql
      .prepare("UPDATE soft_threads SET asked=1 WHERE peer_id=? AND id=? AND status='open'")
      .run(peer, id);
  }
  expireSoftThreads(peer: string, now = Date.now()) {
    this.sql
      .prepare(
        "UPDATE soft_threads SET status='expired' WHERE peer_id=? AND status='open' AND created_at<=?",
      )
      .run(peer, now - SOFT_THREAD_EXPIRE_DAYS * 86400000);
  }

  // ---------- 想法 ----------

  /** 尚未说出口的想法：持久、有来源、有生命周期。它不是消息草稿——
   *  meaning 是想传达的核心，真正的话在生成时才说。 */
  initiativeById(peer: string, id: string): Initiative | undefined {
    const row = this.sql
      .prepare('SELECT * FROM initiatives WHERE peer_id=? AND id=?')
      .get(peer, id);
    return row ? initiative(row) : undefined;
  }
  /** 当前活跃（idle 或 waiting）的想法；waiting 在前（等条件成熟的更急）。 */
  activeInitiatives(peer: string): Initiative[] {
    return this.sql
      .prepare(
        `SELECT * FROM initiatives WHERE peer_id=? AND state IN ('idle','waiting')
         ORDER BY CASE state WHEN 'waiting' THEN 0 ELSE 1 END, updated_at DESC LIMIT 20`,
      )
      .all(peer)
      .map((r) => initiative(r));
  }
  /** 同主题的活跃想法（去重：换句话重提不重复立项）。 */
  activeInitiativeByTopic(peer: string, topicKey: string): Initiative | undefined {
    const row = this.sql
      .prepare(
        "SELECT * FROM initiatives WHERE peer_id=? AND topic_key=? AND state IN ('idle','waiting') LIMIT 1",
      )
      .get(peer, topicKey);
    return row ? initiative(row) : undefined;
  }
  /** 新想法或合并进旧想法。sourceHash 相同的同主题评估是幂等重放，不动
   *  旧行；相同主题的新进展（hash 变了）更新含义与来源、抬升版本。 */
  upsertInitiative(
    peer: string,
    input: InitiativeInput,
    now = Date.now(),
  ): { initiative: Initiative; created: boolean } {
    const sources = [...new Set(input.sources)].slice(0, 10);
    const sourceHash = createHash('sha256')
      .update(input.sources.join('\u0000'))
      .digest('hex')
      .slice(0, 32);
    return this.transaction(() => {
      const existing = this.activeInitiativeByTopic(peer, input.topicKey);
      if (existing) {
        if (existing.source_hash === sourceHash) return { initiative: existing, created: false };
        this.sql
          .prepare(
            `UPDATE initiatives SET kind=?,meaning=?,sources=?,source_hash=?,expect_reply=?,
             state='idle',origin='',version=version+1,updated_at=?,released_at=0,dropped_at=0
             WHERE id=?`,
          )
          .run(
            input.kind,
            input.meaning.slice(0, 300),
            JSON.stringify(sources),
            sourceHash,
            input.expectReply ? 1 : 0,
            now,
            existing.id,
          );
        return {
          initiative: this.initiativeById(peer, existing.id)!,
          created: false,
        };
      }
      const id = randomUUID();
      this.sql
        .prepare(
          `INSERT INTO initiatives(id,peer_id,topic_key,kind,meaning,sources,source_hash,expect_reply,state,origin,created_at,updated_at)
           VALUES(?,?,?,?,?,?,?,?, 'idle','',?,?)`,
        )
        .run(
          id,
          peer,
          input.topicKey.slice(0, 120),
          input.kind,
          input.meaning.slice(0, 300),
          JSON.stringify(sources),
          sourceHash,
          input.expectReply ? 1 : 0,
          now,
          now,
        );
      return { initiative: this.initiativeById(peer, id)!, created: true };
    });
  }
  /** 想法被这次主动真的说了：表达过即退场（被说的内容已进对话史）。 */
  releaseInitiative(peer: string, id: string, now = Date.now()) {
    this.sql
      .prepare(
        "UPDATE initiatives SET state='expressed',released_at=?,updated_at=? WHERE peer_id=? AND id=?",
      )
      .run(now, now, peer, id);
  }
  dropInitiative(peer: string, id: string, now = Date.now()) {
    this.sql
      .prepare(
        "UPDATE initiatives SET state='dropped',dropped_at=?,updated_at=? WHERE peer_id=? AND id=?",
      )
      .run(now, now, peer, id);
  }
  holdInitiative(peer: string, id: string, now = Date.now()) {
    this.sql
      .prepare("UPDATE initiatives SET state='waiting',updated_at=? WHERE peer_id=? AND id=?")
      .run(now, peer, id);
  }
  /** 来源已不存在（消息被删/记忆被替代）的想法自动退场。无来源的想法
   *  （心跳冒出的碎碎念）没有可失效的锚点，原样保留。 */
  expireInitiatives(peer: string, isValidSource: (id: string) => boolean, now = Date.now()) {
    const rows = this.sql
      .prepare("SELECT id,sources FROM initiatives WHERE peer_id=? AND state IN ('idle','waiting')")
      .all(peer) as Row[];
    for (const row of rows) {
      const sources = parse<string[]>(row.sources, []);
      if (sources.length && sources.every((s) => !isValidSource(s)))
        this.sql
          .prepare("UPDATE initiatives SET state='dropped',dropped_at=?,updated_at=? WHERE id=?")
          .run(now, now, String(row.id));
    }
  }
  /** 已结束的想法保留 7 天供调试回看，之后清掉。 */
  pruneInitiatives(now = Date.now()): number {
    const cutoff = now - 7 * 86400000;
    const gone = this.sql
      .prepare("DELETE FROM initiatives WHERE state IN ('expressed','dropped') AND updated_at < ?")
      .run(cutoff);
    return Number(gone.changes);
  }

  // ---------- 她的当下与生活流水（主动 v3） ----------

  self(): SelfState {
    const row = this.sql.prepare('SELECT * FROM self WHERE id=1').get() as Row | undefined;
    return {
      activity: String(row?.activity ?? ''),
      activity_since: Number(row?.activity_since ?? 0),
      plan: String(row?.plan ?? ''),
      plan_day: String(row?.plan_day ?? ''),
      social: Number(row?.social ?? 1),
      express: Number(row?.express ?? 0),
      last_stimulus_at: Number(row?.last_stimulus_at ?? 0),
      updated_at: Number(row?.updated_at ?? 0),
    };
  }
  updateSelf(patch: SelfPatch, now = Date.now()): SelfState {
    const current = this.self();
    this.sql
      .prepare(
        `UPDATE self SET activity=?,activity_since=?,plan=?,plan_day=?,
         social=?,express=?,last_stimulus_at=?,updated_at=? WHERE id=1`,
      )
      .run(
        patch.activity !== undefined ? patch.activity.slice(0, 120) : current.activity,
        patch.activitySince !== undefined ? patch.activitySince : current.activity_since,
        patch.plan !== undefined ? patch.plan.slice(0, 300) : current.plan,
        patch.planDay !== undefined ? patch.planDay : current.plan_day,
        patch.social !== undefined ? Math.max(0, Math.min(1, patch.social)) : current.social,
        patch.express !== undefined ? Math.max(0, Math.min(1, patch.express)) : current.express,
        patch.lastStimulusAt !== undefined ? patch.lastStimulusAt : current.last_stimulus_at,
        now,
      );
    return this.self();
  }
  /** 生活流水追加一条；超过环形上限时从最旧处裁掉。 */
  logLife(kind: string, text: string, artifact = '', now = Date.now()): LifeEntry {
    const entry = this.sql
      .prepare('INSERT INTO life_log(at,kind,text,artifact) VALUES(?,?,?,?)')
      .run(now, kind.slice(0, 12), text.slice(0, 300), artifact.slice(0, 300));
    this.sql
      .prepare(
        `DELETE FROM life_log WHERE id <= (SELECT id FROM life_log ORDER BY id DESC LIMIT 1 OFFSET ?)`,
      )
      .run(LIFE_LOG_KEEP - 1);
    return {
      id: Number(entry.lastInsertRowid),
      at: now,
      kind: kind.slice(0, 12),
      text: text.slice(0, 300),
      artifact: artifact.slice(0, 300),
    };
  }
  recentLife(limit = 6): LifeEntry[] {
    return (
      this.sql
        .prepare('SELECT id,at,kind,text,artifact FROM life_log ORDER BY id DESC LIMIT ?')
        .all(Math.min(50, limit)) as Row[]
    ).map((r) => ({
      id: Number(r.id),
      at: Number(r.at),
      kind: String(r.kind),
      text: String(r.text),
      artifact: String(r.artifact),
    }));
  }

  // ---------- 心情 ----------

  private moodState(raw: Partial<MoodState> | undefined): MoodState {
    if (!raw || typeof raw.valence !== 'number' || typeof raw.energy !== 'number') {
      return { valence: 0, energy: 0, patience: 0, at: 0 };
    }
    const at = Number(raw.at ?? 0);
    // 离线向中性回落，双极轴不越零：累的脉冲回落时仍是负的。
    const decay = (v: number, halflifeHours: number) =>
      Math.abs(v) * Math.pow(0.5, Math.max(0, Date.now() - at) / (halflifeHours * 3600000));
    return {
      valence: decay(raw.valence, MOOD_VALENCE_HALFLIFE_HOURS) * Math.sign(raw.valence),
      energy: decay(raw.energy, MOOD_ENERGY_HALFLIFE_HOURS) * Math.sign(raw.energy),
      patience:
        decay(Number(raw.patience ?? 0), MOOD_PATIENCE_HALFLIFE_HOURS) *
        Math.sign(Number(raw.patience ?? 0)),
      reason: typeof raw.reason === 'string' ? raw.reason : undefined,
      at,
    };
  }
  mood(peer: string): MoodState {
    return this.moodState(
      this.getSetting<Partial<MoodState> | undefined>(`mood:${peer}`, undefined),
    );
  }
  /** 一次读出全部联系人的心情（状态页轮询用）。 */
  moods(): Map<string, MoodState> {
    const out = new Map<string, MoodState>();
    for (const row of this.sql
      .prepare("SELECT key,value FROM settings WHERE key LIKE 'mood:%'")
      .all() as Row[]) {
      out.set(
        String(row.key).slice(5),
        this.moodState(parse<Partial<MoodState> | undefined>(row.value, undefined)),
      );
    }
    return out;
  }
  dueLoopCounts(now = Date.now()): Map<string, number> {
    const out = new Map<string, number>();
    for (const row of this.sql
      .prepare(
        `SELECT peer_id,COUNT(*) AS n FROM open_loops
         WHERE status='open' AND asked=0 AND due_at<=? AND due_at>?
         GROUP BY peer_id`,
      )
      .all(now, now - OPEN_LOOP_EXPIRE_DAYS * 86400000) as Row[])
      out.set(String(row.peer_id), Number(row.n));
    return out;
  }
  /** 折叠脉冲：反向或从零直达该值；同向只再收剩余距离的一小段——
   *  一次明确的外部脉冲要立刻读得出，但重复同向不会钉死在 ±1。 */
  pulseMood(peer: string, delta: Partial<Omit<MoodState, 'at'>>, now = Date.now()) {
    const current = this.mood(peer);
    const clamp = (v: number) => Math.max(-1, Math.min(1, v));
    const fold = (from: number, magnitude: number) => {
      const value = clamp(magnitude);
      if (!value) return from;
      const target = Math.sign(value);
      if (Math.sign(from) !== target || from === 0) return value;
      const room = 1 - Math.abs(from);
      if (room <= 0) return from;
      return Math.sign(from) * Math.min(1, Math.abs(from) + room * MOOD_PULSE_SHARE);
    };
    const valence = delta.valence ?? 0;
    const nextValence = fold(current.valence, valence);
    this.setSetting(`mood:${peer}`, {
      valence: nextValence,
      energy: fold(current.energy, delta.energy ?? 0),
      patience: fold(current.patience, delta.patience ?? 0),
      // reason 描述刚落地的脉冲：带原因的脉冲替换文本，valence 翻转清空；
      // 只碰能量的深夜规则不带原因，不能抹掉模型刚给出的解释。
      reason:
        delta.reason ||
        (Math.sign(nextValence) !== Math.sign(current.valence) ? '' : current.reason),
      at: now,
    });
  }

  // ---------- 作息与心跳 ----------

  /** 近 14 天对方消息的 24 小时分布（按版本缓存）。 */
  activityRhythm(peer: string, timeZone: string): number[] {
    const version = Number(
      this.sql.prepare('SELECT version FROM peers WHERE id=?').get(peer)?.version ?? -1,
    );
    const cached = this.rhythmCache.get(peer);
    if (cached && cached.version === version && Date.now() - cached.at < RHYTHM_CACHE_MS)
      return cached.buckets.slice();
    const buckets = new Array(24).fill(0) as number[];
    const rows = this.sql
      .prepare(
        "SELECT created_at FROM messages WHERE peer_id=? AND role='user' AND status='received' AND created_at>=?",
      )
      .all(peer, Date.now() - 14 * 86400000);
    const formatter = hourFormatter(timeZone);
    for (const row of rows) buckets[Number(formatter.format(new Date(Number(row.created_at))))]++;
    if (this.rhythmCache.size > 64) this.rhythmCache.clear();
    this.rhythmCache.set(peer, { version, at: Date.now(), buckets });
    return buckets.slice();
  }
  /** 心跳开场行（防两天内重复同一话头）。 */
  proactiveHooks(peer: string, since: number): string[] {
    return (
      this.sql
        .prepare(
          `SELECT m.content FROM outbox o JOIN messages m ON m.id=o.id
           WHERE o.peer_id=? AND o.status='sent' AND m.created_at>=?
             AND o.task_id IN (SELECT id FROM tasks WHERE kind='pulse')
           ORDER BY m.created_at DESC LIMIT 12`,
        )
        .all(peer, since) as Row[]
    )
      .map((r) => String(r.content).replace(/\s+/g, ' ').trim())
      .filter(Boolean);
  }
  /** 读空气素材：最后一条用户消息之后发出的心跳消息（按任务去重）。
   *  v3 里它不再触发代码冷却——次数如实交给模型看，收不收她自己定。 */
  unansweredPulseStreak(peer: string): number {
    const lastUser = this.sql
      .prepare(
        "SELECT created_at FROM messages WHERE peer_id=? AND role='user' AND status='received' ORDER BY seq DESC LIMIT 1",
      )
      .get(peer) as Row | undefined;
    const lastUserAt = lastUser ? Number(lastUser.created_at) : 0;
    // 一次主动算一次无回应，不按气泡数数。
    const rows = this.sql
      .prepare(
        `SELECT MAX(m.created_at) AS created_at FROM outbox o JOIN messages m ON m.id=o.id
         WHERE o.peer_id=? AND o.status='sent' AND o.task_id IN (SELECT id FROM tasks WHERE kind='pulse')
         GROUP BY o.task_id ORDER BY created_at DESC LIMIT 12`,
      )
      .all(peer) as Row[];
    let streak = 0;
    for (const row of rows) {
      if (Number(row.created_at) < lastUserAt) break;
      streak++;
    }
    return streak;
  }
  /** 故障保险丝的输入：最近一段时间内发出过的心跳消息条数。 */
  recentPulseSends(peer: string, sinceMs: number, now = Date.now()): number {
    return Number(
      (
        this.sql
          .prepare(
            `SELECT COUNT(DISTINCT o.task_id) AS n FROM outbox o JOIN tasks t ON t.id=o.task_id
             WHERE o.peer_id=? AND o.status='sent' AND t.kind='pulse' AND o.created_at>=?`,
          )
          .get(peer, now - sinceMs) as Row
      ).n ?? 0,
    );
  }
  /** 她最近一次开口（聊天回复或心跳）的时刻；想念从它起算。 */
  lastSpokeAt(peer: string): number {
    return Number(
      (
        this.sql
          .prepare(
            "SELECT MAX(created_at) AS at FROM messages WHERE peer_id=? AND role='assistant' AND status='sent'",
          )
          .get(peer) as Row
      ).at ?? 0,
    );
  }

  // ---------- 用量 ----------

  recordUsage(
    peer: string,
    task: string,
    purpose: string,
    input: number,
    output: number,
    duration: number,
    cached = 0,
  ) {
    this.usageCache = undefined;
    this.transaction(() => {
      this.sql
        .prepare(
          'INSERT INTO usage(peer_id,task_id,purpose,input_tokens,output_tokens,duration_ms,cached_tokens,created_at) VALUES(?,?,?,?,?,?,?,?)',
        )
        .run(peer, task, purpose, input, output, duration, cached, Date.now());
      // 滚动归档按小时级节流，避免回复路径上的全表 GROUP BY。
      const rolledAt = Date.now();
      if (rolledAt - this.lastUsageRollup < USAGE_ROLLUP_INTERVAL_MS) return;
      this.lastUsageRollup = rolledAt;
      const cutoff = rolledAt - USAGE_RETENTION_DAYS * 86400000;
      const stale = this.sql
        .prepare(
          'SELECT purpose,created_at,count(*) AS n,sum(input_tokens) AS input_tokens,sum(output_tokens) AS output_tokens,sum(cached_tokens) AS cached_tokens,round(avg(duration_ms)) AS average_ms FROM usage WHERE created_at<? GROUP BY purpose,created_at/86400000',
        )
        .all(cutoff) as Row[];
      if (stale.length) {
        const upsert = this.sql.prepare(
          'INSERT INTO usage_daily(purpose,day,calls,input_tokens,output_tokens,cached_tokens,average_ms) VALUES(?,?,?,?,?,?,?) ' +
            'ON CONFLICT(purpose,day) DO UPDATE SET ' +
            'average_ms=ROUND((average_ms*calls + excluded.average_ms*excluded.calls)*1.0/(calls+excluded.calls)),' +
            'calls=calls+excluded.calls,' +
            'input_tokens=input_tokens+excluded.input_tokens,' +
            'output_tokens=output_tokens+excluded.output_tokens,' +
            'cached_tokens=cached_tokens+excluded.cached_tokens',
        );
        for (const row of stale) {
          upsert.run(
            String(row.purpose),
            Math.floor(Number(row.created_at) / 86400000),
            Number(row.n),
            Number(row.input_tokens),
            Number(row.output_tokens),
            Number(row.cached_tokens),
            Number(row.average_ms),
          );
        }
        this.sql.prepare('DELETE FROM usage WHERE created_at<?').run(cutoff);
      }
    });
  }
  usage() {
    const now = Date.now();
    if (this.usageCache && now - this.usageCache.at < USAGE_CACHE_MS) return this.usageCache.rows;
    const recent = this.sql
      .prepare(
        'SELECT purpose,count(*) AS calls,sum(input_tokens) AS input_tokens,sum(output_tokens) AS output_tokens,sum(cached_tokens) AS cached_tokens,round(avg(duration_ms)) AS average_ms FROM usage GROUP BY purpose',
      )
      .all() as Row[];
    const archived = this.sql
      .prepare(
        'SELECT purpose,sum(calls) AS calls,sum(input_tokens) AS input_tokens,sum(output_tokens) AS output_tokens,sum(cached_tokens) AS cached_tokens,round(sum(average_ms*calls)*1.0/sum(calls)) AS average_ms FROM usage_daily GROUP BY purpose',
      )
      .all() as Row[];
    const merged = new Map<string, Row>();
    for (const row of [...recent, ...archived]) {
      const prior = merged.get(String(row.purpose));
      if (!prior) {
        merged.set(String(row.purpose), row);
        continue;
      }
      // 平均耗时按调用数加权合并。
      const priorCalls = Number(prior.calls),
        rowCalls = Number(row.calls),
        total = priorCalls + rowCalls;
      merged.set(String(row.purpose), {
        purpose: row.purpose,
        calls: total,
        input_tokens: Number(prior.input_tokens) + Number(row.input_tokens),
        output_tokens: Number(prior.output_tokens) + Number(row.output_tokens),
        cached_tokens: Number(prior.cached_tokens ?? 0) + Number(row.cached_tokens ?? 0),
        average_ms: total
          ? Math.round(
              (Number(prior.average_ms) * priorCalls + Number(row.average_ms) * rowCalls) / total,
            )
          : 0,
      });
    }
    const rows = [...merged.values()];
    this.usageCache = { at: now, rows };
    return rows;
  }
  recentUsage() {
    return this.sql
      .prepare(
        'SELECT u.purpose,u.input_tokens,u.output_tokens,u.cached_tokens,u.duration_ms,u.created_at,p.address FROM usage u LEFT JOIN peers p ON p.id=u.peer_id ORDER BY u.id DESC LIMIT 12',
      )
      .all();
  }

  // ---------- 向量 ----------

  setEmbedding(
    id: string,
    peer: string,
    kind: SourceKind,
    vector: Float32Array,
    model: string,
    now = Date.now(),
  ) {
    this.sql
      .prepare(
        'INSERT INTO memory_embeddings(id,peer_id,kind,vector,dims,model,created_at) VALUES(?,?,?,?,?,?,?) ' +
          'ON CONFLICT(id) DO UPDATE SET vector=excluded.vector,dims=excluded.dims,model=excluded.model,created_at=excluded.created_at',
      )
      .run(
        id,
        peer,
        kind,
        Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength),
        vector.length,
        model,
        now,
      );
  }
  setEmbeddings(
    items: { id: string; peer: string; kind: SourceKind; vector: Float32Array; model: string }[],
    now = Date.now(),
  ) {
    this.transaction(() => {
      for (const item of items)
        this.setEmbedding(item.id, item.peer, item.kind, item.vector, item.model, now);
    });
  }
  embeddings(peer: string, kind?: SourceKind): EmbeddingVector[] {
    return this.sql
      .prepare(
        `SELECT id,peer_id,kind,vector,dims,model FROM memory_embeddings WHERE peer_id=?${kind ? ' AND kind=?' : ''}`,
      )
      .all(...(kind ? [peer, kind] : [peer]))
      .map((r) => ({
        id: String(r.id),
        peer_id: String(r.peer_id),
        kind: String(r.kind) as SourceKind,
        vector: new Float32Array(
          (r.vector as Buffer).buffer.slice(
            (r.vector as Buffer).byteOffset,
            (r.vector as Buffer).byteOffset + (r.vector as Buffer).byteLength,
          ),
        ),
        dims: Number(r.dims),
        model: String(r.model),
      }));
  }
  dropEmbeddings(peer: string, ids?: string[]) {
    if (ids) {
      const del = this.sql.prepare('DELETE FROM memory_embeddings WHERE peer_id=? AND id=?');
      this.transaction(() => {
        for (const id of [...new Set(ids)]) del.run(peer, id);
      });
    } else this.sql.prepare('DELETE FROM memory_embeddings WHERE peer_id=?').run(peer);
  }
  /** 换模型后清掉旧向量：既省空间也不再污染余弦召回，由正常回填补齐。 */
  dropEmbeddingsOfModel(model: string): number {
    return Number(
      this.sql.prepare('DELETE FROM memory_embeddings WHERE model=?').run(model).changes,
    );
  }
  staleEmbeddingModels(peer: string, current: string): string[] {
    return this.sql
      .prepare('SELECT DISTINCT model FROM memory_embeddings WHERE peer_id=? AND model<>?')
      .all(peer, current)
      .map((r) => String(r.model));
  }

  async backup(destination: string) {
    mkdirSync(dirname(destination), { recursive: true });
    await backup(this.sql, destination);
  }
}

/** 想法行的 JSON 列解析。 */
function initiative(row: Row): Initiative {
  return { ...row, sources: parse(row.sources, []) } as unknown as Initiative;
}
