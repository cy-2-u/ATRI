import { DatabaseSync, backup } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { cosineSimilarity } from '@atri/llm';
export { createBackup, restoreBackup } from './backup.js';

/** Attempts before a task stops being revived by later enqueues with the same
 *  dedupe key. Without a cap, a permanently failing diary/notes task is
 *  resurrected every scheduler minute and burns an LLM call each time. */
export const MAX_TASK_ATTEMPTS = 5;
/** Terminal task rows older than this are pruned by the scheduler. */
const TASK_RETENTION_DAYS = 7;

const hourFormatters = new Map<string, Intl.DateTimeFormat>();
export function hourFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = hourFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour: '2-digit',
      hourCycle: 'h23',
    });
    hourFormatters.set(timeZone, formatter);
  }
  return formatter;
}

export type TaskKind = 'chat' | 'notes' | 'diary' | 'proactive';
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
  /** When a later fact superseded this one; 0 while still valid. */
  invalid_at: number;
  /** Write-time importance seed (0–1) that scales the ranking score. */
  importance: number;
  created_at: number;
}
/** An unfinished arrangement the user mentioned ("明天面试"): created from a
 *  turn, proactively asked about once due, closed when resolved or expired.
 *  Recurring loops (birthdays, anniversaries) re-open one year later. */
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
/** A dated arrangement is an open loop; a *soft thread* is the undated version:
 *  "he is stressed about the project this week", or a promise the bot made.
 *  It never schedules a ping and never takes the open-loop quota. It only
 *  surfaces after `revisit_after` days, when the conversation happens to touch
 *  it, and expires if nobody ever resolves it. */
export type SoftThreadKind = 'concern' | 'promise';
export interface SoftThread {
  id: string;
  peer_id: string;
  content: string;
  kind: SoftThreadKind;
  sources: string[];
  /** Days to wait before the thread becomes eligible to bring up again. */
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
/** Lightweight cross-conversation mood, injected as prose rather than numbers. */
export interface MoodState {
  valence: number;
  energy: number;
  /** Willingness to socialise. Negative means "不想应酬": not angry, just out
   *  of the energy it takes to keep up the polite back-and-forth. Kept apart
   *  from `energy` because a tired-but-warm evening and a fed-up one read very
   *  differently, and only the second should shorten replies and skip pings. */
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
  created_at: number;
}
export interface MemoryUpdate {
  content: string;
  kind: 'stated' | 'interpretation';
  sources: string[];
  supersedes?: string[];
  /** Model's own 0–1 importance for the fact; absent means neutral 0.5. */
  importance?: number;
}
export interface ReplyPart {
  type: 'text' | 'sticker';
  text?: string;
  slug?: string;
  description?: string;
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
  /** Score before the recency and kind multipliers. `score` rewards freshness
   *  and memories; this is how well the text actually matched, which is what
   *  decides whether a hit is worth a prompt slot at all. */
  relevance?: number;
  /** Smallest document frequency among the terms this hit matched: matching
   *  "有点" (in a third of the chat) says nothing, matching "年糕" (in one line)
   *  identifies a memory. Undefined when nothing matched lexically. */
  minDf?: number;
  /** Number of indexed rows for this peer, so callers can judge `minDf`. */
  corpusSize?: number;
  /** Cosine similarity to the query vector; 0 when embeddings are off. Semantic
   *  recall legitimately matches text with no shared wording, so callers must
   *  let a strong `semantic` through even when nothing rare matched. */
  semantic?: number;
  role?: Message['role'];
  memory_kind?: Memory['kind'];
  sources?: string[];
}
export interface EmbeddingVector {
  id: string;
  peer_id: string;
  kind: SourceKind;
  vector: Float32Array;
  dims: number;
  model: string;
}
type Row = Record<string, unknown>;
const parse = <T>(value: unknown, fallback: T): T => {
  try {
    return JSON.parse(String(value)) as T;
  } catch {
    return fallback;
  }
};
/** A conservative, provider-independent estimate, not a model tokenizer. */
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
/** Selection pressure for memory ranking: recency half-life (days) with a floor
 *  so long-lived facts are never evicted by a flood of fresh interpretations,
 *  and how much user-confirmed facts outrank subjective readings. */
export const MEMORY_HALFLIFE_DAYS = 14;
export const MEMORY_RECENCY_FLOOR = 0.35;
export const MEMORY_STATED_WEIGHT = 2.2;
export const MEMORY_INTERPRETATION_WEIGHT = 0.6;
/** A memory counts as "used" once per window, not once per turn. See
 *  `markMemoriesUsed`. */
export const MEMORY_HIT_COOLDOWN_MINUTES = 180;
/** Open loops: expire silently after this many days past due. */
export const OPEN_LOOP_EXPIRE_DAYS = 7;
/** Undated soft threads: how long they stay worth remembering, how many stay
 *  active at once, and the default wait before one may be brought up. The cap
 *  is deliberately tiny so "挂念" never turns into a backlog of things to
 *  check up on. */
export const SOFT_THREAD_EXPIRE_DAYS = 14;
export const SOFT_THREAD_MAX = 3;
export const SOFT_THREAD_REVISIT_DAYS = 2;
export const SOFT_THREAD_REVISIT_MAX_DAYS = 7;
/** Proactive brake: unanswered pings before the cooldown stretches to days. */
export const PROACTIVE_IGNORE_LIMIT = 2;
export const PROACTIVE_IGNORE_COOLDOWN_DAYS = 3;
/** Mood pulses decay toward neutral with these half-lives (hours). Tuned so
 *  "生气" fades overnight and "累" fades within a nap, not a workday. */
export const MOOD_VALENCE_HALFLIFE_HOURS = 12;
export const MOOD_ENERGY_HALFLIFE_HOURS = 4;
/** Impatience is social, not physical: it should survive a night's sleep but
 *  clear by the next day, otherwise yesterday's clipped replies poison today. */
export const MOOD_PATIENCE_HALFLIFE_HOURS = 10;
/** Share of the remaining distance to ±1 that a repeat same-sign pulse closes.
 *  Kept small enough that an evening of complaints settles well short of the
 *  energy floor which blocks proactive contact entirely. */
export const MOOD_PULSE_SHARE = 0.2;
/** Usage rollup: keep this many days of per-call rows, older ones aggregate. */
export const USAGE_RETENTION_DAYS = 30;
/** How often recordUsage is allowed to scan the table for aged rows. */
const USAGE_ROLLUP_INTERVAL_MS = 60 * 60 * 1000;
/** The status panel polls every 2.5 s; a short cache keeps the full-table
 *  aggregate off that path without showing stale numbers for long. */
const USAGE_CACHE_MS = 5000;
/** Same reasoning for document-frequency counts: a paraphrase of the same
 *  query should not scan every indexed row again. Five minutes is short enough
 *  that new messages are reflected promptly. */
const DF_CACHE_MS = 5 * 60 * 1000;
/** Vector candidates scored per recall. 2000 rows was the largest CPU cost in
 *  a reply; 800 is still far more than the 12 candidates that reach the prompt. */
const SEARCH_VECTOR_CANDIDATES = 800;
/** How long a delivery of unknown outcome keeps its peer's queue paused before
 *  it stops blocking. The row stays in issues() for a manual decision. */
export const UNCERTAIN_HOLD_MS = 10 * 60000;
/** Hard character cap on stored topic notes. */
export const NOTES_MAX_CHARS = 4000;

const dateFormatters = new Map<string, Intl.DateTimeFormat>();
function dateParts(at: number, timeZone: string) {
  let formatter = dateFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    dateFormatters.set(timeZone, formatter);
  }
  return formatter
    .formatToParts(new Date(at))
    .reduce<Record<string, string>>((acc, p) => ({ ...acc, [p.type]: p.value }), {});
}

/** Same wall-clock time one calendar year later, in `timeZone`.
 *
 *  Adding a fixed 365 days drifts: a 2 月 29 日 birthday became 2 月 28 日 and
 *  then oscillated between the two. Feb 29 maps to Feb 28 in common years, and
 *  every other month/day is preserved exactly. */
export function addYear(at: number, timeZone = 'Asia/Shanghai'): number {
  const p = dateParts(at, timeZone);
  const year = Number(p.year);
  const month = Number(p.month);
  const day = Number(p.day);
  const hour = Number(p.hour);
  const minute = Number(p.minute);
  const second = Number(p.second);
  const daysInTargetMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
  const targetDay = Math.min(day, daysInTargetMonth(year + 1, month));
  // Reconstruct through UTC by locating the zone's offset at the candidate time.
  const asUtc = Date.UTC(year + 1, month - 1, targetDay, hour, minute, second);
  let result = asUtc;
  for (let i = 0; i < 2; i++) {
    const offsetName = new Intl.DateTimeFormat('en-GB', { timeZone, timeZoneName: 'longOffset' })
      .formatToParts(new Date(result))
      .find((x) => x.type === 'timeZoneName')!.value;
    const match = /GMT([+-])(\d{2}):?(\d{2})?/.exec(offsetName);
    const sign = match?.[1] === '-' ? -1 : 1;
    const oh = Number(match?.[2] ?? 0),
      om = Number(match?.[3] ?? 0);
    result = asUtc - sign * (oh * 3600000 + om * 60000);
  }
  return result;
}

export class Store {
  readonly sql: DatabaseSync;
  private transactionDepth = 0;
  /** Small per-peer caches keyed by the peers.version change counter. */
  private memoryCache = new Map<string, { version: number; memories: Memory[] }>();
  /** Document frequencies per peer, merged incrementally as new terms appear. */
  private dfCache = new Map<string, { at: number; total: number; counts: Map<string, number> }>();
  private lastUsageRollup = 0;
  private usageCache?: { at: number; rows: Row[] };
  constructor(readonly path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.sql = new DatabaseSync(path);
    const openedAt = Number(this.sql.prepare('PRAGMA user_version').get()?.user_version ?? 0);
    if (openedAt > 6) {
      this.sql.close();
      throw new Error('数据库来自更新版本，不能用当前程序打开');
    }
    this.sql.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
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
    `);
    if (openedAt < 2) {
      // Pinned memories opt out of decay-based ranking. The big DDL block keeps
      // user_version untouched; only the version that needs the column sets it,
      // so reopening a v2 database (e.g. restored backup) never re-runs this.
      this.sql.exec('ALTER TABLE memories ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;');
      this.sql.exec('PRAGMA user_version=2;');
    }
    if (openedAt < 3) {
      // Per-peer persona binding; empty string means "use the default persona".
      this.sql.exec('ALTER TABLE peers ADD COLUMN persona_id TEXT NOT NULL DEFAULT "";');
      this.sql.exec('PRAGMA user_version=3;');
    }
    if (openedAt < 4) {
      // Facts are invalidated, never deleted: invalid_at records when a later
      // statement replaced them, so "she changed her mind" stays traceable.
      // importance is a write-time seed (0–1) that scales ranking; 0.5 is
      // neutral and reproduces the old ordering for existing rows.
      this.sql.exec('ALTER TABLE memories ADD COLUMN invalid_at INTEGER NOT NULL DEFAULT 0;');
      this.sql.exec('ALTER TABLE memories ADD COLUMN importance REAL NOT NULL DEFAULT 0.5;');
      this.sql.exec('PRAGMA user_version=4;');
    }
    if (openedAt < 5) {
      // The delivery pump scans pending outbox rows per peer every 300 ms and
      // usage is aggregated by a 30-day created_at window; both used to be
      // full scans on growing tables.
      this.sql.exec(
        'CREATE INDEX IF NOT EXISTS outbox_peer_status ON outbox(peer_id,status);\n' +
          'CREATE INDEX IF NOT EXISTS usage_created ON usage(created_at);\n' +
          'CREATE INDEX IF NOT EXISTS memory_embeddings_peer_model ON memory_embeddings(peer_id,model);',
      );
      this.sql.exec('PRAGMA user_version=5;');
    }
    if (openedAt < 6) {
      // Every reply reads the active memory set, the trailing-two-week activity
      // histogram, the uncertain-delivery gate and the issue lists. Without
      // these the planner fell back to scanning the whole peer's rows and
      // sorting in a temp B-tree.
      this.sql.exec(
        'CREATE INDEX IF NOT EXISTS memories_peer_status_created ON memories(peer_id,status,created_at DESC);\n' +
          'CREATE INDEX IF NOT EXISTS messages_rhythm ON messages(peer_id,role,status,created_at);\n' +
          'CREATE INDEX IF NOT EXISTS outbox_status_created ON outbox(status,created_at DESC);\n' +
          'CREATE INDEX IF NOT EXISTS tasks_kind ON tasks(kind);\n' +
          'CREATE INDEX IF NOT EXISTS diary_peer_status_day ON diary_sections(peer_id,status,day);',
      );
      this.sql.exec('PRAGMA user_version=6;');
    }
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
  /** Delete a peer and everything recorded for them.
   *
   *  Every table holds `REFERENCES peers(id)` with foreign_keys=ON, so the
   *  children have to go first or the delete throws. The order below is the
   *  dependency order: outbox references both messages and tasks, diary_sections
   *  references tasks, and everything else references peers directly.
   *
   *  This is a hard delete, not the soft "status='deleted'" used by source
   *  removal: that path exists so an invalidated fact keeps its text for audit,
   *  but a removed contact has no audit value and the point is to be gone.
   *  Wrapped in one transaction — a half-deleted peer would leave memories whose
   *  sources point at messages that no longer exist. */
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
    this.sql.exec('BEGIN IMMEDIATE');
    try {
      // outbox → diary_sections → other children → peers.
      this.sql.prepare('DELETE FROM outbox WHERE peer_id=?').run(id);
      this.sql.prepare('DELETE FROM diary_sections WHERE peer_id=?').run(id);
      this.sql.prepare('DELETE FROM tasks WHERE peer_id=?').run(id);
      this.sql.prepare('DELETE FROM memory_embeddings WHERE peer_id=?').run(id);
      this.sql.prepare('DELETE FROM memories WHERE peer_id=?').run(id);
      this.sql.prepare('DELETE FROM open_loops WHERE peer_id=?').run(id);
      this.sql.prepare('DELETE FROM soft_threads WHERE peer_id=?').run(id);
      this.sql.prepare('DELETE FROM messages WHERE peer_id=?').run(id);
      // FTS has no foreign keys; peer_id is UNINDEXED but still queryable.
      this.sql.prepare('DELETE FROM search_index WHERE peer_id=?').run(id);
      // usage keeps its counters: it is billing history, keyed by peer id and
      // not reachable from any peer-scoped page once the peer row is gone.
      this.sql.prepare('DELETE FROM peers WHERE id=?').run(id);
      this.sql.exec('COMMIT');
    } catch (error) {
      this.sql.exec('ROLLBACK');
      throw error;
    }
    // Per-peer transient state lives in settings. Persona bindings are a peer
    // column now, so the old `peer_persona:` key no longer exists.
    this.removeSetting(`diary_cursor:${id}`);
    this.removeSetting(`mood:${id}`);
    this.dfCache.delete(id);
    this.usageCache = undefined;
    // The cache is keyed by peer id and validated against peers.version. A
    // re-created peer restarts that counter at 0, so a stale entry can collide
    // with the new peer's version and hand back memories that were deleted —
    // measured, not theoretical: without this line a removed contact still
    // recalled its old facts after the same id came back.
    this.memoryCache.delete(id);
    return before;
  }
  setPeerPersona(id: string, personaId: string) {
    this.sql.prepare('UPDATE peers SET persona_id=? WHERE id=?').run(personaId, id);
  }
  private message(row: Row): Message {
    return { ...row, media: parse(row.media, []) } as unknown as Message;
  }
  getMessage(peer: string, id: string) {
    const row = this.sql.prepare('SELECT * FROM messages WHERE peer_id=? AND id=?').get(peer, id);
    return row ? this.message(row) : undefined;
  }
  ingest(
    peer: string,
    eventKey: string,
    content: string,
    media: Media[] = [],
    timestamp = Date.now(),
    /** Only the admin correction path writes anything but a user message. */
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
      // A system note is not something the user said: it must not move the
      // silence clock that gates proactive contact.
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
    // A terminal-but-not-done row (failed/superseded/interrupted) used to
    // swallow every future enqueue with the same dedupe key, which permanently
    // froze that key: notes kept reusing the same `through`, diary the same
    // day, a yearly loop the same id. Reviving it keeps dedupe for in-flight
    // work while letting a later attempt actually run. attempts is preserved:
    // a task that keeps failing must hit the retry cap instead of being
    // re-armed every scheduler tick and burning an LLM call each minute.
    this.sql
      .prepare(
        `UPDATE tasks SET state=CASE WHEN attempts>=? THEN state ELSE 'queued' END,
         payload=?,
         -- Preserve a backoff already set by deferFailed. Re-enqueueing a
         -- failed non-chat task used to reset run_at to "now" every scheduler
         -- minute, which burned all five attempts in five minutes and made the
         -- exponential backoff effectively dead. Chat is exempt: a new message
         -- should not wait for the previous turn's backoff.
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
  /** Whether a newer chat turn is already waiting behind an aborted one.
   *  Runtime uses this to supersede instead of retrying, so the user does not
   *  receive an answer to the old message and then a second answer to the new
   *  one. `through < 0` means the interrupted task had no message boundary
   *  (proactive), so any queued chat supersedes it. */
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
  /** Peers that have work and whose queue is safe to advance.
   *
   *  An unconfirmed delivery normally pauses its peer: sending the next bubble
   *  on top of one that may or may not have arrived can invert the
   *  conversation. But that pause used to be permanent — one network blip left
   *  an 'uncertain' row behind, and from then on `readyPeers` never returned
   *  that peer again, so a single hiccup silenced the contact forever with no
   *  warning. The pause now expires: the row stays visible in issues() for the
   *  operator to confirm or resend, but it stops blocking new traffic. */
  readyPeers(now = Date.now()): string[] {
    const holdSince = now - UNCERTAIN_HOLD_MS;
    return this.sql
      .prepare(
        `SELECT DISTINCT p.id FROM peers p WHERE p.approved=1 AND
      NOT EXISTS(SELECT 1 FROM outbox WHERE peer_id=p.id AND (status='failed' OR (status='uncertain' AND created_at>=?))) AND
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
        CASE kind WHEN 'chat' THEN 0 WHEN 'notes' THEN 1 WHEN 'diary' THEN 2 ELSE 3 END,created_at LIMIT 1`,
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
  /** 失败退避：state 仍是 failed（issues() 要能列出、新回复要能 supersede），
   *  只把 run_at 推迟，saveReply 的 revival 只认 queued 以下状态，不会提前跑。 */
  deferFailed(id: string, delay: number) {
    this.sql
      .prepare("UPDATE tasks SET run_at=? WHERE id=? AND state='failed'")
      .run(Date.now() + delay, id);
  }
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
  saveReply(task: Task, parts: ReplyPart[], updates: MemoryUpdate[], now = Date.now()): boolean {
    return this.transaction(() => {
      if (this.taskById(task.id)?.state !== 'running') return false;
      if (this.peer(task.peer_id)?.version !== task.version) {
        this.finish(task.id, 'superseded');
        return false;
      }
      for (const update of updates) this.writeMemory(task.peer_id, update, now);
      parts.forEach((part, ordinal) => {
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
      this.finish(task.id, parts.length ? 'ready' : 'done');
      if (task.kind === 'chat' && typeof task.payload.through === 'number')
        this.sql
          .prepare(
            "UPDATE tasks SET state='superseded' WHERE peer_id=? AND kind='chat' AND id<>? AND state IN ('queued','failed') AND CAST(json_extract(payload,'$.through') AS INTEGER)<=?",
          )
          .run(task.peer_id, task.id, task.payload.through);
      return true;
    });
  }
  /** Direct lookup for the delivery-action endpoint: issues() is a capped
   *  overview, not a registry of every pending row. */
  deliveryById(id: string): { id: string; peer_id: string; status: string } | undefined {
    const row = this.sql.prepare('SELECT id,peer_id,status FROM outbox WHERE id=?').get(id);
    return row
      ? { id: String(row.id), peer_id: String(row.peer_id), status: String(row.status) }
      : undefined;
  }
  startDelivery(id: string) {
    this.sql
      .prepare(
        "UPDATE outbox SET status='sending',attempts=attempts+1 WHERE id=? AND status='pending'",
      )
      .run(id);
  }
  markDelivery(
    id: string,
    status: 'sent' | 'uncertain' | 'failed' | 'pending' | 'cancelled',
    error = '',
    now = Date.now(),
  ) {
    this.transaction(() => {
      const row = this.sql.prepare('SELECT * FROM outbox WHERE id=?').get(id);
      if (!row) throw new Error('发送记录不存在');
      this.sql
        .prepare('UPDATE outbox SET status=?,error=? WHERE id=?')
        .run(status, error.slice(0, 400), id);
      this.sql.prepare('UPDATE messages SET status=? WHERE id=?').run(status, id);
      if (status === 'sent') {
        const msg = this.getMessage(String(row.peer_id), id)!;
        this.index(id, msg.peer_id, 'message', msg.content, msg.created_at);
        if (this.taskById(String(row.task_id))?.kind === 'proactive')
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
    });
  }
  /** Terminal tasks are pure operations debris — chat rows are created per
   *  user message, and done/failed/superseded rows are only ever re-read by
   *  the scheduler scans. Prune ones old enough that no delivery issue or
   *  dedupe key can still reference them. Called from the scheduler tick. */
  pruneTasks(now = Date.now()): number {
    const cutoff = now - TASK_RETENTION_DAYS * 86400000;
    return this.transaction(() => {
      // Every table with a foreign key into tasks must be excluded here, or the
      // DELETE throws and the whole sweep rolls back. outbox and diary_sections
      // are the two: outbox because delivered rows are audit history, and
      // diary_sections because a diary's prose is permanent content that
      // outlives the task that generated it. Missing the second one kept every
      // install that had ever run a diary throwing "FOREIGN KEY constraint
      // failed" every 60 seconds — the scheduler logged it and moved on, so
      // neither tasks nor outbox was ever pruned again.
      // Outbox rows are audit history, not operations state: drop settled rows
      // past retention so the table stops growing without bound. This has to
      // run before the task sweep: a cancelled delivery still points at its
      // task, and leaving it behind made NOT EXISTS block that task forever.
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
      return Number(gone.changes);
    });
  }
  cancelUnsent(task: Task): boolean {
    return this.transaction(() => {
      if (
        this.sql
          .prepare(
            "SELECT 1 FROM outbox WHERE task_id=? AND status IN ('sent','sending','uncertain')",
          )
          .get(task.id)
      )
        return false;
      this.sql
        .prepare("UPDATE outbox SET status='cancelled' WHERE task_id=? AND status='pending'")
        .run(task.id);
      this.sql
        .prepare(
          "UPDATE messages SET status='cancelled' WHERE id IN (SELECT id FROM outbox WHERE task_id=?)",
        )
        .run(task.id);
      this.finish(task.id, 'superseded');
      return true;
    });
  }
  private index(id: string, peer: string, kind: SourceKind, content: string, at: number) {
    this.sql.prepare('DELETE FROM search_index WHERE id=?').run(id);
    // Content changed: the stale vector must not survive the refresh.
    this.sql.prepare('DELETE FROM memory_embeddings WHERE id=?').run(id);
    this.sql
      .prepare('INSERT INTO search_index(id,peer_id,kind,content,created_at) VALUES(?,?,?,?,?)')
      .run(id, peer, kind, content, at);
  }
  private unindex(id: string) {
    this.sql.prepare('DELETE FROM search_index WHERE id=?').run(id);
  }
  private describeHit(hit: SearchHit): SearchHit {
    if (hit.kind === 'message') {
      // Index IDs are globally unique; access scope was checked before this lookup.
      const role = this.sql.prepare('SELECT role FROM messages WHERE id=?').get(hit.id)?.role;
      return { ...hit, role: role as Message['role'] };
    }
    const row =
      hit.kind === 'memory'
        ? this.sql.prepare('SELECT kind,sources FROM memories WHERE id=?').get(hit.id)
        : this.sql.prepare('SELECT sources FROM diary_sections WHERE id=?').get(hit.id);
    return {
      ...hit,
      sources: parse<string[]>(row?.sources, []),
      ...(hit.kind === 'memory' ? { memory_kind: row?.kind as Memory['kind'] } : {}),
    };
  }
  sources(peer: string, ids: string[]): SearchHit[] {
    const wanted = [...new Set(ids)].slice(0, 40);
    if (!wanted.length) return [];
    // One statement for the whole set. This used to run the index lookup and
    // then call describeHit per row, which issued another prepare+get for each
    // of up to 40 ids — so the "one round trip instead of 40 statements"
    // comment below was true only for the first of the two queries. writeMemory
    // runs this on every memory update and search() runs it per hit.
    const marks = wanted.map(() => '?').join(',');
    const rows = this.sql
      .prepare(
        `SELECT s.id AS id, s.kind AS kind, s.content AS content, s.created_at AS created_at,
                m.role AS role,
                mem.kind AS memory_kind, mem.sources AS memory_sources,
                d.sources AS diary_sources
         FROM search_index s
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
  memories(peer: string): Memory[] {
    const version = Number(
      this.sql.prepare('SELECT version FROM peers WHERE id=?').get(peer)?.version ?? -1,
    );
    const cached = this.memoryCache.get(peer);
    // Copy on the way out: callers sort and splice what they get back, and
    // handing them the cached array itself let one caller's in-place sort
    // permanently corrupt every later read for this peer.
    if (cached && cached.version === version) return cached.memories.slice();
    // Pinned rows are fetched separately: a lifetime of chat makes the newest
    // 500 a sliding window that would silently drop a pinned memory created
    // long ago, defeating "置顶的记忆永远会带在身边".
    const rows = this.sql
      .prepare(
        `SELECT * FROM memories WHERE peer_id=? AND status='active'
         AND (pinned=1 OR id IN (SELECT id FROM memories WHERE peer_id=? AND status='active' ORDER BY created_at DESC LIMIT 500))
         ORDER BY pinned DESC, created_at DESC`,
      )
      .all(peer, peer)
      .map((r) => ({ ...r, sources: parse(r.sources, []) }) as unknown as Memory);
    // Bounded cache; setMemoryPinned/correctMemory invalidate explicitly and a
    // version bump covers every write path, so staleness is impossible.
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
  /** Memories ranked by usage, importance and recency for prompt inclusion.
   *  Pinned memories always come first and never participate in the budget
   *  trim that pops from the tail. */
  rankedMemories(peer: string, limit = 10): Memory[] {
    return this.rankedMemoriesScored(peer, limit).map((s) => s.memory);
  }
  /** Same ranking, exposing scores/ages so callers can apply semantic boost. */
  rankedMemoriesScored(
    peer: string,
    limit = 10,
  ): { memory: Memory; score: number; pinned: boolean }[] {
    const now = Date.now(),
      halflifeMs = MEMORY_HALFLIFE_DAYS * 86400000;
    const scored = this.memories(peer).map((m) => {
      if (m.pinned) return { memory: m, score: Number.MAX_SAFE_INTEGER, pinned: true };
      const age = Math.max(0, now - m.created_at);
      const recency = Math.max(MEMORY_RECENCY_FLOOR, Math.pow(0.5, age / halflifeMs));
      const kindWeight = m.kind === 'stated' ? MEMORY_STATED_WEIGHT : MEMORY_INTERPRETATION_WEIGHT;
      const hits = m.hits ?? 0;
      // Importance is a mild multiplier (0.6–1.4 around the neutral 0.5): it
      // nudges the order without letting a single "important" tag bury every
      // recent fact.
      const importance = 0.6 + (Number.isFinite(m.importance) ? m.importance : 0.5) * 0.8;
      return {
        memory: m,
        score: (1 + Math.sqrt(hits)) * recency * kindWeight * importance,
        pinned: false,
      };
    });
    return scored
      .sort((a, b) => b.score - a.score || b.memory.created_at - a.memory.created_at)
      .slice(0, limit);
  }
  /** Count prompt inclusions per memory so reused memories outrank one-offs.
   *
   *  One increment per cooldown window rather than per turn: the prompt is
   *  rebuilt every turn, so a memory that stayed in the top ten gained a hit
   *  each time and after a long evening its score was an order of magnitude
   *  above a fact learned yesterday. The ranking then froze around whichever
   *  rows happened to win early. `last_hit_at` is deliberately *not* refreshed
   *  on a suppressed hit — otherwise continuous display would push the window
   *  forward forever and the counter would never move again. */
  markMemoriesUsed(peer: string, ids: string[], now = Date.now()) {
    const unique = [...new Set(ids)];
    if (!unique.length) return;
    const placeholders = unique.map(() => '?').join(',');
    this.sql
      .prepare(
        `UPDATE memories SET hits=hits+1, last_hit_at=?
         WHERE peer_id=? AND id IN (${placeholders}) AND status=?
           AND last_hit_at<=?`,
      )
      .run(now, peer, ...unique, 'active', now - MEMORY_HIT_COOLDOWN_MINUTES * 60000);
    this.memoryCache.delete(peer);
  }
  /** Apply `supersedes` for every write path. Split out because it used to live
   *  only on the "new row inserted" branch: a restatement of known wording (the
   *  duplicate branch) or a repeated (content, sources) pair (the UNIQUE hit)
   *  returned early and silently dropped the supersedes list, leaving the
   *  corrected fact and its replacement both active in the prompt. */
  private supersede(peer: string, ids: string[], now: number) {
    for (const previous of ids) {
      // Invalidate rather than delete: the old row leaves default recall but
      // keeps its text and the moment it stopped being true.
      if (
        this.sql
          .prepare(
            "UPDATE memories SET status='superseded',invalid_at=? WHERE peer_id=? AND id=? AND status='active'",
          )
          .run(now, peer, previous).changes
      ) {
        this.unindex(previous);
        // The vector is still compared by Runtime.dedupeMemories; leaving it
        // behind let a replaced fact keep deciding which new fact supersedes
        // which, and polluted semantic recall with a row that is no longer active.
        this.sql
          .prepare('DELETE FROM memory_embeddings WHERE peer_id=? AND id=?')
          .run(peer, previous);
      }
    }
  }
  /** Persist one memory update; returns the surviving row id, or undefined when
   *  the update was rejected (no valid sources, unsupported "stated"). */
  private writeMemory(peer: string, update: MemoryUpdate, now: number): string | undefined {
    // Every write path bumps peers.version, but the bump lands before or after
    // this within the same transaction; drop the cache defensively per write.
    this.memoryCache.delete(peer);
    const rawIds = [...new Set(update.sources)];
    const found = this.sources(peer, rawIds);
    const byId = new Map(found.map((s) => [s.id, s]));
    // Keep the legal subset instead of dropping the whole update. The prompt
    // tells the model to cite what it saw this turn, which includes memory
    // ids — discarding everything because one citation was a memory (or was
    // already forgotten, or a stale id) silently lost real facts while the
    // model believed they were stored.
    const keptIds = rawIds.filter((id) => {
      const s = byId.get(id);
      return s && s.kind !== 'memory';
    });
    // "Stated" additionally needs user-side evidence in what remains; diary
    // citations don't count, an assistant-only observation is a guess.
    const statedOk =
      update.kind !== 'stated' ||
      keptIds.some((id) => {
        const s = byId.get(id);
        return s && s.kind === 'message' && (s.role === 'user' || s.role === 'system');
      });
    if (!update.content.trim() || !keptIds.length || !statedOk) return undefined;
    const ids = keptIds;
    const content = update.content.trim();
    const sourceHash = hash(content + '\n' + [...ids].sort().join(','));
    // Identical wording from a different turn is the same fact; only extend
    // its evidence instead of storing a duplicate row.
    const duplicate = this.sql
      .prepare(
        "SELECT id,sources FROM memories WHERE peer_id=? AND content=? AND status='active' LIMIT 1",
      )
      .get(peer, content.slice(0, 800)) as Row | undefined;
    if (duplicate) {
      const merged = [...new Set([...parse<string[]>(duplicate.sources, []), ...ids])].slice(0, 20);
      this.sql
        .prepare('UPDATE memories SET sources=?,importance=MAX(importance,?) WHERE id=?')
        .run(JSON.stringify(merged), update.importance ?? 0.5, String(duplicate.id));
      this.supersede(peer, update.supersedes ?? [], now);
      this.memoryCache.delete(peer);
      return String(duplicate.id);
    }
    const id = randomUUID();
    const inserted = this.sql
      .prepare(
        'INSERT OR IGNORE INTO memories(id,peer_id,content,kind,sources,source_hash,importance,created_at) VALUES(?,?,?,?,?,?,?,?)',
      )
      .run(
        id,
        peer,
        content.slice(0, 800),
        update.kind,
        JSON.stringify(ids),
        sourceHash,
        Math.max(0, Math.min(1, update.importance ?? 0.5)),
        now,
      );
    if (!inserted.changes) {
      // (content, sources) already exists — possibly a superseded row being
      // restated. Revive it rather than dropping the write on the floor.
      const existing = this.sql
        .prepare('SELECT id FROM memories WHERE peer_id=? AND source_hash=?')
        .get(peer, sourceHash) as Row | undefined;
      if (existing) {
        this.sql
          .prepare(
            "UPDATE memories SET status='active',invalid_at=0,sources=?,importance=MAX(importance,?) WHERE id=?",
          )
          .run(
            JSON.stringify(ids),
            Math.max(0, Math.min(1, update.importance ?? 0.5)),
            String(existing.id),
          );
        this.index(String(existing.id), peer, 'memory', content.slice(0, 800), now);
        this.supersede(peer, update.supersedes ?? [], now);
        this.memoryCache.delete(peer);
        return String(existing.id);
      }
      return undefined;
    }
    this.supersede(peer, update.supersedes ?? [], now);
    this.index(id, peer, 'memory', content.slice(0, 800), now);
    return id;
  }
  addMemory(peer: string, update: MemoryUpdate, expectedVersion: number) {
    return this.transaction(() => {
      if (this.peer(peer)?.version !== expectedVersion) return false;
      this.writeMemory(peer, update, Date.now());
      return true;
    });
  }
  correctMemory(peer: string, id: string, content: string) {
    this.transaction(() => {
      const original = this.sql
        .prepare(
          "SELECT id,hits,last_hit_at,pinned FROM memories WHERE peer_id=? AND id=? AND status='active'",
        )
        .get(peer, id) as Row | undefined;
      if (!original) throw new Error('记忆不存在');
      // The correction is evidence in its own right, but it must not masquerade
      // as a user message: `ingest` writes role='user' and refreshes
      // last_user_at, which would reset the proactive silence clock and show
      // up in history as if the user had said it.
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
      // Use the id writeMemory actually produced. Looking the row up again by
      // content matched an older, unrelated memory whenever the corrected text
      // already existed, which copied this row's hits/pinned onto it (zeroing
      // its real stats) while the wrong fact stayed active.
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
  diaries(peer: string): DiarySection[] {
    return this.sql
      .prepare(
        "SELECT * FROM diary_sections WHERE peer_id=? AND status='active' ORDER BY day DESC,created_at,ordinal LIMIT 500",
      )
      .all(peer)
      .map((r) => ({ ...r, sources: parse(r.sources, []) }) as unknown as DiarySection);
  }
  /** Diary sections covering a wall-clock window, oldest first.
   *
   *  Query-driven recall is the wrong tool at the one moment it matters most:
   *  the user comes back after days away and says "在吗", which matches nothing,
   *  while what would let her pick the thread back up is the time range itself.
   *  `day` is a local calendar date (YYYY-MM-DD), so it compares as a string. */
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
    sections: { content: string; sources: string[] }[],
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
            'INSERT OR IGNORE INTO diary_sections(id,peer_id,task_id,ordinal,day,content,sources,created_at) VALUES(?,?,?,?,?,?,?,?)',
          )
          .run(
            id,
            task.peer_id,
            task.id,
            ordinal,
            day,
            section.content,
            JSON.stringify(section.sources),
            now,
          );
        this.index(id, task.peer_id, 'diary', section.content, now);
      });
      if (this.peer(task.peer_id)?.version === task.version)
        for (const update of updates) this.writeMemory(task.peer_id, update, now);
      if (typeof task.payload.through === 'number')
        this.setSetting(`diary_cursor:${task.peer_id}`, task.payload.through);
      this.finish(task.id);
    });
  }
  setNotes(task: Task, notes: string, through: number) {
    this.transaction(() => {
      if (this.peer(task.peer_id)?.version === task.version)
        this.sql
          .prepare('UPDATE peers SET notes=?,notes_until=? WHERE id=?')
          .run(notes.slice(0, NOTES_MAX_CHARS), through, task.peer_id);
      this.finish(task.id);
    });
  }
  forget(peer: string, id: string) {
    this.transaction(() => {
      this.memoryCache.delete(peer);
      // Resolve the target from the tables themselves, not from search_index:
      // superseding a memory removes it from the index while keeping the row, so
      // the old lookup threw "记录不存在" and a superseded fact with sensitive
      // content could never be deleted.
      const kind =
        (this.sql.prepare('SELECT kind FROM search_index WHERE peer_id=? AND id=?').get(peer, id)
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
      // The outbox keeps a full JSON copy of the bubble that was sent; clearing
      // only messages.content left the original plaintext readable there.
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
      // Invalidation must cover the entire history, independent of UI list
      // limits — and it has to run to a fixed point: a dependency chain
      // (memory → diary → memory) only propagates if the sweep repeats until
      // nothing new is invalidated. A single pass missed every link whose row
      // happened to be scanned before the row it depended on.
      // Superseded and deleted rows participate too; otherwise a fact that was
      // replaced earlier silently outlives its own source.
      const load = (sql: string) =>
        this.sql
          .prepare(sql)
          .all(peer)
          .map((r) => ({ id: String(r.id), sources: parse<string[]>(r.sources, []) }));
      // Read each table once. `load` used to sit inside the loop, so a chain of
      // depth k re-selected and re-parsed every memory and diary row k times —
      // thousands of rows JSON-parsed on the request thread, visible as the
      // admin page freezing right after "delete". The fixed point itself only
      // grows a set in memory, so the data never has to be re-read.
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
      // Open loops carry the plan in their own content column and would keep
      // quoting a message that was just forgotten.
      for (const loop of this.sql
        .prepare('SELECT id,sources FROM open_loops WHERE peer_id=?')
        .all(peer) as Row[]) {
        const sources = parse<string[]>(loop.sources, []);
        if (sources.some((s) => invalid.has(s)))
          this.sql
            .prepare("UPDATE open_loops SET content='',sources='[]',status='expired' WHERE id=?")
            .run(String(loop.id));
      }
      // Soft threads quote a message just as directly as open loops do.
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
  }
  /** Rows needing embedding: indexed, not yet vectorized, newest first. */
  pendingEmbeddings(
    peer: string,
    limit = 64,
  ): { id: string; kind: SourceKind; content: string; created_at: number }[] {
    return this.sql
      .prepare(
        `SELECT s.id,s.kind,s.content,s.created_at FROM search_index s
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
  search(
    peer: string,
    query: string,
    limit = 6,
    kind?: SourceKind,
    queryVector?: Float32Array,
    // Vectors from a different embedding model (or dimensionality) must not be
    // cosine-compared with the query: the numbers look plausible and are garbage.
    queryVectorModel = '',
    /** Source ids this turn must not surface. The reply path passes the turns
     *  already present in the prompt: a query built from the newest messages
     *  matches those messages best, so without this the recall slots fill up
     *  with text the model is already reading. */
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
    const kindClause = kind ? ' AND kind=?' : '',
      kindParameters = kind ? [kind] : [];
    const longTerms = terms.filter((t) => [...t].length >= 3).slice(0, 20);
    if (longTerms.length) {
      const match = longTerms.map((t) => '"' + t.replaceAll('"', '""') + '"').join(' OR ');
      rows.push(
        ...this.sql
          .prepare(
            'SELECT id,kind,content,created_at FROM search_index WHERE peer_id=? AND search_index MATCH ?' +
              kindClause +
              ' ORDER BY rank LIMIT 150',
          )
          .all(peer, match, ...kindParameters),
      );
    }
    // LIKE scan only when FTS came up short — it is the fallback for short
    // Chinese bigrams, not a duplicate pass over the same hits.
    if (rows.length < 20) {
      const likeTerms = terms.slice(0, 32).map((t) => '%' + t.replace(/[\\%_]/g, '\\$&') + '%');
      rows.push(
        ...this.sql
          .prepare(
            `SELECT id,kind,content,created_at FROM search_index WHERE peer_id=? AND (${likeTerms.map(() => "content LIKE ? ESCAPE '\\'").join(' OR ')})${kindClause} ORDER BY CAST(created_at AS INTEGER) DESC LIMIT 300`,
          )
          .all(peer, ...likeTerms, ...kindParameters),
      );
    }
    // Semantic candidates: rows that share no surface form with the query but
    // are stored vectors — the whole point of hybrid retrieval. Vector scan is
    // capped: recency-weighted slice keeps the cost bounded on long histories.
    if (queryVector) {
      // model/dims 过滤只在查询侧声明了向量模型时生效：调用方没接 embedder 时
      // （测试夹具、降级部署）不该因为空串匹配不到任何行而失去向量召回。
      const modelFilter = queryVectorModel ? 'AND e.model=? AND e.dims=?' : '';
      rows.push(
        ...this.sql
          .prepare(
            `SELECT s.id,s.kind,s.content,s.created_at FROM memory_embeddings e JOIN search_index s ON s.id=e.id
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
    // One query for every vector instead of a prepare+get per row: the result
    // set reaches 2000 rows when vectors are on, and that used to be 2000
    // round trips inside a reply.
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
    // Term specificity. Chinese queries are cut into bigrams, so every slice
    // used to weigh the same as every other: "有点" (present in half the chat)
    // scored exactly like "年糕" (present in one line). It is the rare term that
    // identifies a memory, so each term's contribution is divided by how common
    // it is in this peer's indexed text — the classic idf, bounded so a term
    // appearing everywhere still counts a little (it is not *wrong*, only
    // uninformative).
    const df = this.termFrequencies(peer, terms);
    const total = df.total;
    const weight = new Map<string, number>();
    for (const t of terms) {
      const seen = df.counts.get(t) ?? 0;
      // +1 smoothing keeps an unseen term (at most one query) from dividing by
      // zero. Unseen terms also carry no usable signal: no row can match them,
      // so they must not set the bar a hit has to clear.
      weight.set(t, Math.log(1 + total / (1 + seen)));
    }
    const idfSum = [...weight.values()].reduce((a, b) => a + b, 0) || 1;
    const scored = [...new Map(rows.map((r) => [r.id, r])).values()]
      .filter((r) => !kind || r.kind === kind)
      .filter((r) => !exclude?.has(String(r.id)))
      .map((r) => {
        const body = String(r.content).normalize('NFKC').toLowerCase();
        // Length still matters (a 6-char match beats a 2-char one) but is now
        // scaled by specificity and normalised against the query's own idf sum,
        // so `lexical` means "how much of the query's *informative* content is
        // here" in a 0–1-ish range instead of an unbounded count.
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
        // Recency boost applies only to genuine matches: without the similarity
        // floor a fresh-but-irrelevant row would outrank an old exact hit.
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
          // Relevance before the recency/kind multipliers, so callers can drop
          // weak hits without the boost hiding how weak they were.
          relevance: base,
          minDf,
          corpusSize: total,
          semantic,
          vector,
          // Cached once per candidate: MMR compares each candidate against every
          // already-picked hit, and recomputing both norms inside that loop made
          // a 20-hit MMR over 2000 x 1024-dim vectors take ~2.4 s per reply.
          norm: vector ? norm(vector) : 0,
        };
      })
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score || b.created_at - a.created_at);
    // MMR keeps the top-k from being one topic repeated: pick the best hit,
    // then penalise candidates too similar to what is already chosen.
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
        // λ=0.7: relevance still leads, redundancy only breaks near-ties.
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
  /** Document frequency of each query term inside one peer's indexed text.
   *  One grouped query over search_index; `total` is the number of indexed rows
   *  for the peer and is used as the corpus size for idf. */
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
        (
          this.sql
            .prepare('SELECT COUNT(*) AS n FROM search_index WHERE peer_id=?')
            .get(peer) as Row
        )?.n ?? 0,
      );
      cached = { at: now, total, counts: new Map() };
      this.dfCache.set(peer, cached);
    }
    if (!cached.total) return { counts: new Map(), total: 0 };
    const missing = terms.filter((t) => !cached!.counts.has(t));
    if (missing.length) {
      // A single LIKE pass with one CASE arm per missing term: 48 separate
      // COUNT queries per recall was 48 table scans, and this runs on every
      // reply. Terms already seen are served from the per-peer cache.
      const arms = missing.map(
        (_, i) => `SUM(CASE WHEN content LIKE ? ESCAPE '\\' THEN 1 ELSE 0 END) AS t${i}`,
      );
      const patterns = missing.map((t) => '%' + t.replace(/[\\%_]/g, '\\$&') + '%');
      const row = this.sql
        .prepare(`SELECT ${arms.join(',')} FROM search_index WHERE peer_id=?`)
        .get(...patterns, peer) as Row | undefined;
      missing.forEach((t, i) => cached!.counts.set(t, Number(row?.[`t${i}`] ?? 0)));
    }
    return {
      counts: new Map(terms.map((t) => [t, cached!.counts.get(t) ?? 0])),
      total: cached.total,
    };
  }
  openLoops(peer: string, onlyOpen = false): OpenLoop[] {
    return this.sql
      .prepare(
        `SELECT * FROM open_loops WHERE peer_id=? ${onlyOpen ? "AND status='open'" : ''} ORDER BY due_at LIMIT 100`,
      )
      .all(peer)
      .map((r) => ({ ...r, sources: parse(r.sources, []) }) as unknown as OpenLoop);
  }
  /** Due loops: fallen due, not yet asked about, still inside the ask window. */
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
    // The same plan is often re-extracted on the next turn ("我明天面试" comes
    // up twice); storing it again would create duplicate reminders.
    const existing = this.sql
      .prepare(
        "SELECT * FROM open_loops WHERE peer_id=? AND status='open' AND content=? AND ABS(due_at-?)<3600000 ORDER BY created_at LIMIT 1",
      )
      .get(peer, content, input.dueAt) as Row | undefined;
    if (existing) {
      // Same plan, maybe with a better due time or one more source: merge.
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
    // Straight lookup, not openLoops(peer).find(...): that list is capped at
    // LIMIT 100, so on a peer with more open loops than that the freshly
    // inserted row was never in it and the non-null assertion threw.
    return this.openLoopById(peer, id);
  }
  openLoopById(peer: string, id: string): OpenLoop {
    const row = this.sql.prepare('SELECT * FROM open_loops WHERE peer_id=? AND id=?').get(peer, id);
    if (!row) throw new Error('开环记录不存在');
    return { ...row, sources: parse(row.sources, []) } as unknown as OpenLoop;
  }
  /** The user answered about this arrangement: close it quietly. Recurring
   *  loops instead move to next year — a birthday never "resolves". Because a
   *  yearly loop rolls in place, `loopTaskKey` includes the new due date so a
   *  fresh ping is not swallowed by the previous year's finished task. */
  resolveOpenLoop(peer: string, id: string, now = Date.now(), timeZone = 'Asia/Shanghai') {
    const loop = this.sql
      .prepare("SELECT recurring,due_at FROM open_loops WHERE peer_id=? AND id=? AND status='open'")
      .get(peer, id) as Row | undefined;
    if (!loop) return;
    if (String(loop.recurring) === 'yearly') {
      const next = addYear(Number(loop.due_at), timeZone);
      this.sql
        .prepare('UPDATE open_loops SET due_at=?,asked=0 WHERE peer_id=? AND id=?')
        .run(next, peer, id);
      return;
    }
    this.sql
      .prepare(
        "UPDATE open_loops SET status='resolved',resolved_at=? WHERE peer_id=? AND id=? AND status='open'",
      )
      .run(now, peer, id);
  }
  /** Dedupe key for a loop ping; the due date makes each yearly roll distinct. */
  loopTaskKey(loop: { id: string; due_at: number }): string {
    return `loop:${loop.id}:${loop.due_at}`;
  }
  markLoopAsked(peer: string, id: string) {
    this.sql
      .prepare("UPDATE open_loops SET asked=1 WHERE peer_id=? AND id=? AND status='open'")
      .run(peer, id);
  }
  /** Old loops nobody resolved: drop silently rather than nag about them.
   *  Yearly loops are not dropped — a birthday missed while the bot was offline
   *  is still next year's birthday — so they roll to the next calendar year. */
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
  /** Threads old enough to mention, still open, inside their lifetime. Rows the
   *  model already asked about stay in the list: it may need the id to resolve
   *  them when the user brings the topic back, and the prompt tells it not to
   *  ask twice. */
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
    // Re-extracting the same concern on the next turn merges sources instead of
    // creating a second row; created_at stays put so re-mentioning does not keep
    // pushing the "ask after N days" window forward forever.
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
    // Keep the newest concerns: drop the oldest open thread rather than refusing
    // the fresh one. The cap is small on purpose, so this is rare.
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
  /** Undated concerns fade on their own; nobody wants last month's worry
   *  resurfacing as if it were current. */
  expireSoftThreads(peer: string, now = Date.now()) {
    this.sql
      .prepare(
        "UPDATE soft_threads SET status='expired' WHERE peer_id=? AND status='open' AND created_at<=?",
      )
      .run(peer, now - SOFT_THREAD_EXPIRE_DAYS * 86400000);
  }
  mood(peer: string): MoodState {
    const raw = this.getSetting<Partial<MoodState> | undefined>(`mood:${peer}`, undefined);
    if (!raw || typeof raw.valence !== 'number' || typeof raw.energy !== 'number') {
      return { valence: 0, energy: 0, patience: 0, at: 0 };
    }
    const at = Number(raw.at ?? 0);
    // Decay toward neutral while offline; both axes never cross zero.
    const decay = (v: number, halflifeHours: number) =>
      Math.abs(v) * Math.pow(0.5, Math.max(0, Date.now() - at) / (halflifeHours * 3600000));
    return {
      valence: decay(raw.valence, MOOD_VALENCE_HALFLIFE_HOURS) * Math.sign(raw.valence),
      // Energy is bipolar too: a tired pulse must stay negative, otherwise the
      // prose hint flips "有点累了" into "精力挺足".
      energy: decay(raw.energy, MOOD_ENERGY_HALFLIFE_HOURS) * Math.sign(raw.energy),
      // Rows written before this axis existed simply have no `patience`.
      patience:
        decay(Number(raw.patience ?? 0), MOOD_PATIENCE_HALFLIFE_HOURS) *
        Math.sign(Number(raw.patience ?? 0)),
      reason: typeof raw.reason === 'string' ? raw.reason : undefined,
      at,
    };
  }
  /** Fold a pulse into the current state.
   *
   *  Two behaviours are needed at once. A single explicit pulse must land close
   *  to the value it carries ("energy: -0.6" has to read back as clearly
   *  tired), but repeated same-sign exchanges must not accumulate without
   *  limit: plain addition pinned the state at ±1 and, since every pulse reset
   *  `at`, the decay clock kept restarting, so one bad evening left `energy`
   *  under the proactive-contact floor for days. So the first pulse moves
   *  directly to its magnitude, and each later same-sign pulse only closes a
   *  fraction of the remaining distance to the extreme.
   */
  pulseMood(peer: string, delta: Partial<Omit<MoodState, 'at'>>, now = Date.now()) {
    const current = this.mood(peer);
    const clamp = (v: number) => Math.max(-1, Math.min(1, v));
    const fold = (from: number, magnitude: number) => {
      const value = clamp(magnitude);
      if (!value) return from;
      const target = Math.sign(value);
      // Opposite sign, or a neutral start: the pulse states the new level.
      if (Math.sign(from) !== target || from === 0) return value;
      // Same sign: creep toward the extreme, never reaching it.
      const room = 1 - Math.abs(from);
      if (room <= 0) return from;
      return Math.sign(from) * Math.min(1, Math.abs(from) + room * MOOD_PULSE_SHARE);
    };
    const valence = delta.valence ?? 0;
    const energy = delta.energy ?? 0;
    const nextValence = fold(current.valence, valence);
    this.setSetting(`mood:${peer}`, {
      valence: nextValence,
      energy: fold(current.energy, energy),
      patience: fold(current.patience, delta.patience ?? 0),
      // A reason describes the pulse that just landed, so a pulse that brings
      // one always replaces the text, and a valence flip drops the old text
      // (otherwise "心情不错 · 对方提到了不开心的事" appears). A pulse that only
      // nudges energy keeps it: the night rule fires on every late exchange
      // with no reason of its own, and it used to erase whatever the model had
      // just reported about the same conversation.
      reason:
        delta.reason ||
        (Math.sign(nextValence) !== Math.sign(current.valence) ? '' : current.reason),
      at: now,
    });
  }
  /** Rule-based mood pulse from one exchange. Deliberately coarse: this feeds
   *  prose tone hints, not a numeric persona. Night and long silences lower
   *  energy; gratitude, laughter and long engaged talks lift valence. */
  pulseMoodFromExchange(
    peer: string,
    exchange: { user: string; assistant: string; userAt: number },
    now = Date.now(),
    timeZone = 'Asia/Shanghai',
  ) {
    const hour = Number(hourFormatter(timeZone).format(new Date(exchange.userAt)));
    // Order matters and used to be inverted: "不开心" contains "开心", so a
    // positive-first cascade scored the most common negative phrase as a
    // happy exchange. Distress is detected first, and a negated positive
    // ("不开心" / "没意思") never counts as cheer.
    // Negation stripping: "今天不累了" / "没什么压力" must not score as
    // distress, so negated forms are removed before the coarse word lists run.
    // Only negative words may be stripped: "不开心" IS the distress token
    // itself, so stripping it would erase the very signal we look for.
    const text = exchange.user.replace(
      /(不|没|没有|不太|不怎么)(太|什么)?(累|疲|烦|难过|生气|委屈|难受|压力大?|崩溃)/g,
      '',
    );
    const distressed =
      /(烦|难过|累|好累|疲|生气|委屈|难受|不开心|不高兴|没意思|压力|崩溃|emo)/i.test(text);
    const grateful = /(谢谢|感谢|辛苦|有你真好)/.test(text);
    const cheerful =
      !/(不开心|不高兴|没意思)/.test(text) && /(开心|哈哈哈|笑死|哈哈|嘻嘻|好耶)/.test(text);
    let valence = 0,
      energy = 0,
      reason: string | undefined;
    if (distressed) {
      valence = -0.3;
      reason = '对方提到了不开心的事';
      energy = -0.2;
    } else if (grateful) {
      valence = 0.2;
      reason = '对方表达了感谢';
    } else if (cheerful) {
      valence = 0.2;
      reason = '聊得挺开心';
    } else if (/(晚安|睡了|好困)/.test(text) || (hour >= 1 && hour < 7)) {
      energy = -0.15;
    } else if (text.length > 80 && exchange.assistant.length > 80) {
      energy = 0.1;
    }
    // 不想应酬 is its own axis. A one-word reply is not an insult, but keeping
    // the exchange pleasant takes something out of her; a real conversation
    // gives it back. Distress is exempt — that is exactly when she should stay
    // patient — which is why this runs outside the cascade above.
    const substance = text.replace(/[\s\p{P}\p{S}]/gu, '').length;
    let patience = 0;
    if (/(晚安|睡了|好困)/.test(text) || (hour >= 1 && hour < 7)) patience -= 0.15;
    if (!distressed && substance > 0 && substance <= 3) patience -= 0.25;
    else if (substance > 80) patience += 0.2;
    if (valence === 0 && energy === 0 && patience === 0) return;
    this.pulseMood(peer, { valence, energy, patience, reason }, now);
  }
  /** Per-hour message frequency over the trailing two weeks, for rhythm hints. */
  activityRhythm(peer: string, timeZone: string): number[] {
    const buckets = new Array(24).fill(0) as number[];
    const since = Date.now() - 14 * 86400000;
    const rows = this.sql
      .prepare(
        "SELECT created_at FROM messages WHERE peer_id=? AND role='user' AND status='received' AND created_at>=?",
      )
      .all(peer, since);
    const formatter = hourFormatter(timeZone);
    for (const row of rows) buckets[Number(formatter.format(new Date(Number(row.created_at))))]++;
    return buckets;
  }
  /** Opening lines of proactive messages since `since`, newest first. Used to
   *  keep the same hook from resurfacing two days in a row. */
  proactiveHooks(peer: string, since: number): string[] {
    return (
      this.sql
        .prepare(
          `SELECT m.content FROM outbox o JOIN messages m ON m.id=o.id
           WHERE o.peer_id=? AND o.status='sent' AND m.created_at>=?
             AND o.task_id IN (SELECT id FROM tasks WHERE kind='proactive')
           ORDER BY m.created_at DESC LIMIT 12`,
        )
        .all(peer, since) as Row[]
    )
      .map((r) => String(r.content).replace(/\s+/g, ' ').trim())
      .filter(Boolean);
  }
  /** Proactive brake: pings sent after the last user message got no reply. */
  unansweredProactiveStreak(peer: string): number {
    const lastUser = this.sql
      .prepare(
        "SELECT created_at FROM messages WHERE peer_id=? AND role='user' AND status='received' ORDER BY seq DESC LIMIT 1",
      )
      .get(peer) as Row | undefined;
    const lastUserAt = lastUser ? Number(lastUser.created_at) : 0;
    const rows = this.sql
      .prepare(
        `SELECT m.created_at FROM outbox o JOIN messages m ON m.id=o.id
         WHERE o.peer_id=? AND o.status='sent' AND o.task_id IN (SELECT id FROM tasks WHERE kind='proactive')
         ORDER BY m.created_at DESC LIMIT ?`,
      )
      .all(peer, PROACTIVE_IGNORE_LIMIT) as Row[];
    let streak = 0;
    for (const row of rows) {
      if (Number(row.created_at) < lastUserAt) break;
      streak++;
    }
    return streak;
  }
  recordUsage(
    peer: string,
    task: string,
    purpose: string,
    input: number,
    output: number,
    duration: number,
  ) {
    this.usageCache = undefined;
    this.transaction(() => {
      this.sql
        .prepare(
          'INSERT INTO usage(peer_id,task_id,purpose,input_tokens,output_tokens,duration_ms,created_at) VALUES(?,?,?,?,?,?,?)',
        )
        .run(peer, task, purpose, input, output, duration, Date.now());
      // Roll up rows older than the retention window into per-day summaries so
      // the status endpoint never aggregates an ever-growing table. This scan
      // ran on every model call; an hourly cadence keeps the table bounded
      // without putting a GROUP BY on the reply path.
      const rolledAt = Date.now();
      if (rolledAt - this.lastUsageRollup < USAGE_ROLLUP_INTERVAL_MS) return;
      this.lastUsageRollup = rolledAt;
      const cutoff = rolledAt - USAGE_RETENTION_DAYS * 86400000;
      const stale = this.sql
        .prepare(
          'SELECT purpose,created_at,count(*) AS n,sum(input_tokens) AS input_tokens,sum(output_tokens) AS output_tokens,round(avg(duration_ms)) AS average_ms FROM usage WHERE created_at<? GROUP BY purpose,created_at/86400000',
        )
        .all(cutoff) as Row[];
      if (stale.length) {
        const upsert = this.sql.prepare(
          // average_ms must merge weighted by call count. Assigning
          // excluded.average_ms made the archived mean the mean of the *last*
          // rollup batch while calls/input/output kept accumulating, so the
          // panel showed an average that contradicted its own call count.
          'INSERT INTO usage_daily(purpose,day,calls,input_tokens,output_tokens,average_ms) VALUES(?,?,?,?,?,?) ' +
            'ON CONFLICT(purpose,day) DO UPDATE SET ' +
            'average_ms=ROUND((average_ms*calls + excluded.average_ms*excluded.calls)*1.0/(calls+excluded.calls)),' +
            'calls=calls+excluded.calls,' +
            'input_tokens=input_tokens+excluded.input_tokens,' +
            'output_tokens=output_tokens+excluded.output_tokens',
        );
        for (const row of stale) {
          upsert.run(
            String(row.purpose),
            Math.floor(Number(row.created_at) / 86400000),
            Number(row.n),
            Number(row.input_tokens),
            Number(row.output_tokens),
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
        'SELECT purpose,count(*) AS calls,sum(input_tokens) AS input_tokens,sum(output_tokens) AS output_tokens,round(avg(duration_ms)) AS average_ms FROM usage GROUP BY purpose',
      )
      .all() as Row[];
    const archived = this.sql
      .prepare(
        'SELECT purpose,sum(calls) AS calls,sum(input_tokens) AS input_tokens,sum(output_tokens) AS output_tokens,round(sum(average_ms*calls)*1.0/sum(calls)) AS average_ms FROM usage_daily GROUP BY purpose',
      )
      .all() as Row[];
    const merged = new Map<string, Row>();
    for (const row of [...recent, ...archived]) {
      const prior = merged.get(String(row.purpose));
      if (!prior) {
        merged.set(String(row.purpose), row);
        continue;
      }
      // Weighted by call count: the archive previously reported average_ms=0
      // and the `|| prior` fallback then let a handful of recent calls overwrite
      // the real average for everything older than the retention window.
      const priorCalls = Number(prior.calls),
        rowCalls = Number(row.calls),
        total = priorCalls + rowCalls;
      merged.set(String(row.purpose), {
        purpose: row.purpose,
        calls: total,
        input_tokens: Number(prior.input_tokens) + Number(row.input_tokens),
        output_tokens: Number(prior.output_tokens) + Number(row.output_tokens),
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
        'SELECT u.purpose,u.input_tokens,u.output_tokens,u.duration_ms,u.created_at,p.address FROM usage u LEFT JOIN peers p ON p.id=u.peer_id ORDER BY u.id DESC LIMIT 12',
      )
      .all();
  }
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
  /** Remove vectors from a retired embedding model so they neither bloat the
   *  database nor (before the model filter existed) pollute cosine recall.
   *  Affected rows are re-embedded by the normal backfill. Returns the count. */
  dropEmbeddingsOfModel(model: string): number {
    const gone = this.sql.prepare('DELETE FROM memory_embeddings WHERE model=?').run(model);
    return Number(gone.changes);
  }
  /** One model per peer is the norm, but old rows can linger; report any model
   *  other than `current` that still has vectors for this peer. */
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
