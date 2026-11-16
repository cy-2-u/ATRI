import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { Memory, PeerModel, ThoughtEntry } from '../domain/memory.js';
import { evolveSelf, initialSelf, projectSelf, type SelfState } from '../domain/state.js';
import { nextYearAfter, type Commitment } from '../domain/commitment.js';
import type { MoodPulse } from '../domain/mood.js';

export interface Bubble {
  type: 'text' | 'sticker' | 'image';
  text?: string;
  slug?: string;
  path?: string;
}

/** 某时刻在某时区的 UTC 偏移（分钟，东正西负）：用量按天分组用。 */
function zoneOffsetMinutes(at: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(at));
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value);
  const asUTC = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return Math.round((asUTC - at) / 60000);
}

export interface Turn {
  id: string;
  peer: string;
  version: number;
  kind: 'chat' | 'beat' | 'reminder' | 'diary' | 'tidy';
}

export interface Envelope {
  id: string;
  turn: string;
  peer: string;
  ordinal: number;
  part: Bubble;
  status: string;
}

interface EnvelopeRow extends Omit<Envelope, 'part'> {
  part: string;
}

/** 内核库的全部 DDL：Journal 与迁移脚本共用同一份真理。 */
export function createSchema(sql: DatabaseSync): void {
  sql.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA foreign_keys=ON;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS kernel_peers (
        id TEXT PRIMARY KEY, version INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS kernel_turns (
        id TEXT PRIMARY KEY, peer TEXT NOT NULL REFERENCES kernel_peers(id),
        version INTEGER NOT NULL, kind TEXT NOT NULL, state TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS kernel_events (
        seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE,
        peer TEXT NOT NULL REFERENCES kernel_peers(id), turn_id TEXT,
        kind TEXT NOT NULL, content TEXT NOT NULL, event_key TEXT,
        created_at INTEGER NOT NULL, UNIQUE(peer,event_key)
      );
      CREATE INDEX IF NOT EXISTS kernel_events_peer ON kernel_events(peer,seq);
      CREATE TABLE IF NOT EXISTS kernel_outbox (
        id TEXT PRIMARY KEY, turn_id TEXT NOT NULL REFERENCES kernel_turns(id),
        peer TEXT NOT NULL REFERENCES kernel_peers(id), ordinal INTEGER NOT NULL,
        part TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL,
        delivered_at INTEGER, UNIQUE(turn_id,ordinal)
      );
      CREATE INDEX IF NOT EXISTS kernel_outbox_ready ON kernel_outbox(peer,status,created_at);
      CREATE TABLE IF NOT EXISTS kernel_effects (
        turn_id TEXT PRIMARY KEY REFERENCES kernel_turns(id), value TEXT NOT NULL,
        ordinal INTEGER NOT NULL, committed_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS kernel_memories (
        id TEXT PRIMARY KEY, peer TEXT NOT NULL REFERENCES kernel_peers(id),
        status TEXT NOT NULL, value TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS kernel_memories_peer ON kernel_memories(peer,status);
      CREATE TABLE IF NOT EXISTS kernel_thoughts (
        id TEXT PRIMARY KEY, peer TEXT NOT NULL REFERENCES kernel_peers(id),
        topic TEXT NOT NULL, value TEXT NOT NULL, UNIQUE(peer,topic)
      );
      CREATE TABLE IF NOT EXISTS kernel_commitments (
        id TEXT PRIMARY KEY, peer TEXT NOT NULL REFERENCES kernel_peers(id), value TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS kernel_commitments_peer ON kernel_commitments(peer);
      CREATE TABLE IF NOT EXISTS kernel_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS kernel_jobs (
        peer TEXT NOT NULL REFERENCES kernel_peers(id), kind TEXT NOT NULL,
        due_at INTEGER NOT NULL, PRIMARY KEY(peer,kind)
      );
      CREATE TABLE IF NOT EXISTS kernel_embeddings (
        id TEXT PRIMARY KEY, model TEXT NOT NULL, vector BLOB NOT NULL, at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS kernel_usage (
        seq INTEGER PRIMARY KEY, purpose TEXT NOT NULL, model TEXT NOT NULL,
        input INTEGER NOT NULL, output INTEGER NOT NULL, cached INTEGER NOT NULL, at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS kernel_usage_at ON kernel_usage(at);
    `);
}

// 新内核使用独立表名，旧数据在迁移验收前保持原样。
export class Journal {
  private readonly sql: DatabaseSync;
  private readonly statements = new Map<string, StatementSync>();

  constructor(
    path: string,
    private readonly now: () => number = Date.now,
  ) {
    this.sql = new DatabaseSync(path);
    createSchema(this.sql);
  }

  private statement(sql: string): StatementSync {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.sql.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  private transaction<T>(work: () => T): T {
    this.sql.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.sql.exec('COMMIT');
      return result;
    } catch (error) {
      this.sql.exec('ROLLBACK');
      throw error;
    }
  }

  setting<T>(key: string, fallback: T): T {
    const row = this.statement('SELECT value FROM kernel_settings WHERE key=?').get(key);
    return row ? (JSON.parse(String(row.value)) as T) : fallback;
  }

  setSetting(key: string, value: unknown): void {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new TypeError('设置值必须可序列化');
    this.statement(
      'INSERT INTO kernel_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    ).run(key, encoded);
  }

  receive(peer: string, eventKey: string, content: string, dueAt = this.now()): boolean {
    if (!eventKey) throw new TypeError('入站消息必须有去重标识');
    return this.transaction(() => {
      this.statement('INSERT OR IGNORE INTO kernel_peers(id) VALUES(?)').run(peer);
      const inserted = this.statement(
        "INSERT OR IGNORE INTO kernel_events(id,peer,kind,content,event_key,created_at) VALUES(?,?,'received',?,?,?)",
      ).run(randomUUID(), peer, content, eventKey, this.now());
      if (!inserted.changes) return false;
      this.statement('UPDATE kernel_peers SET version=version+1 WHERE id=?').run(peer);
      this.statement(
        "UPDATE kernel_turns SET state='superseded' WHERE peer=? AND state='running'",
      ).run(peer);
      this.statement(
        "UPDATE kernel_outbox SET status='cancelled' WHERE peer=? AND status='pending'",
      ).run(peer);
      this.statement(
        "INSERT INTO kernel_jobs(peer,kind,due_at) VALUES(?,'chat',?) ON CONFLICT(peer,kind) DO UPDATE SET due_at=excluded.due_at",
      ).run(peer, dueAt);
      this.setSetting('self', evolveSelf(this.self(), this.now(), { kind: 'received' }));
      return true;
    });
  }

  begin(peer: string, kind: Turn['kind']): Turn {
    return this.transaction(() => {
      this.statement('INSERT OR IGNORE INTO kernel_peers(id) VALUES(?)').run(peer);
      const running = this.statement(
        "SELECT id FROM kernel_turns WHERE peer=? AND state='running'",
      ).get(peer);
      if (running) throw new Error('同一联系人已有思考中的任务');
      const version = Number(
        this.statement('SELECT version FROM kernel_peers WHERE id=?').get(peer)!.version,
      );
      const turn = { id: randomUUID(), peer, version, kind };
      this.statement(
        "INSERT INTO kernel_turns(id,peer,version,kind,state,created_at) VALUES(?,?,?,?,'running',?)",
      ).run(turn.id, peer, version, kind, this.now());
      return turn;
    });
  }

  draft(
    turn: Turn,
    parts: Bubble[],
    effects: Record<string, unknown> = {},
    effectOrdinal = parts.length - 1,
  ): boolean {
    if (parts.length > 6) throw new TypeError('单轮气泡超过上限');
    if (
      parts.length &&
      (!Number.isInteger(effectOrdinal) || effectOrdinal < 0 || effectOrdinal >= parts.length)
    )
      throw new TypeError('表达效果必须绑定本轮气泡');
    for (const part of parts) {
      if (
        part.type === 'text'
          ? !part.text?.trim()
          : part.type === 'sticker'
            ? !part.slug
            : part.type === 'image'
              ? !part.path
              : true
      )
        throw new TypeError('气泡内容不完整');
    }
    return this.transaction(() => {
      const row = this.statement(
        'SELECT t.state,t.version,p.version AS current FROM kernel_turns t JOIN kernel_peers p ON p.id=t.peer WHERE t.id=? AND t.peer=?',
      ).get(turn.id, turn.peer);
      if (
        !row ||
        row.state !== 'running' ||
        row.version !== row.current ||
        Number(row.version) !== turn.version
      )
        return false;
      const thoughts = this.thoughts(turn.peer);
      if (effects.expressed !== undefined && !Array.isArray(effects.expressed))
        throw new TypeError('表达念头必须是数组');
      const expressed = Array.isArray(effects.expressed) ? effects.expressed : [];
      if (
        expressed.some(
          (id) =>
            typeof id !== 'string' ||
            !thoughts.some((thought) => thought.id === id && thought.state === 'idle'),
        )
      )
        throw new TypeError('表达效果引用了无效念头');
      const snapshots = thoughts
        .filter((thought) => expressed.includes(thought.id))
        .map((thought) => ({ id: thought.id, evidence: thought.evidence }));
      if (effects.asked !== undefined && !Array.isArray(effects.asked))
        throw new TypeError('问过的约定必须是数组');
      const asked = Array.isArray(effects.asked) ? effects.asked : [];
      const commitments = this.commitments(turn.peer);
      if (
        asked.some(
          (id) =>
            typeof id !== 'string' ||
            !commitments.some((item) => item.id === id && item.state === 'open' && !item.askedAt),
        )
      )
        throw new TypeError('表达效果引用了无效约定');
      const askedSnapshots = commitments
        .filter((item) => asked.includes(item.id))
        .map((item) => ({ id: item.id, dueAt: item.dueAt }));
      parts.forEach((part, ordinal) => {
        this.statement(
          "INSERT INTO kernel_outbox(id,turn_id,peer,ordinal,part,status,created_at) VALUES(?,?,?,?,?,'pending',?)",
        ).run(randomUUID(), turn.id, turn.peer, ordinal, JSON.stringify(part), this.now());
      });
      if (parts.length)
        this.statement('INSERT INTO kernel_effects(turn_id,value,ordinal) VALUES(?,?,?)').run(
          turn.id,
          JSON.stringify({ effects, snapshots, askedSnapshots }),
          effectOrdinal,
        );
      this.statement('UPDATE kernel_turns SET state=? WHERE id=?').run(
        parts.length ? 'ready' : 'done',
        turn.id,
      );
      return true;
    });
  }

  pending(peer: string): Envelope[] {
    return (
      this.statement(
        "SELECT id,turn_id AS turn,peer,ordinal,part,status FROM kernel_outbox WHERE peer=? AND status='pending' ORDER BY created_at,turn_id,ordinal",
      ).all(peer) as unknown as EnvelopeRow[]
    ).map((row) => ({ ...row, part: JSON.parse(row.part) as Bubble }));
  }

  unresolved(peer: string): Envelope[] {
    return (
      this.statement(
        "SELECT id,turn_id AS turn,peer,ordinal,part,status FROM kernel_outbox WHERE peer=? AND status IN ('sending','unknown') ORDER BY created_at,ordinal",
      ).all(peer) as unknown as EnvelopeRow[]
    ).map((row) => ({ ...row, part: JSON.parse(row.part) as Bubble }));
  }

  startDelivery(id: string): boolean {
    return this.transaction(() => {
      const row = this.statement('SELECT peer FROM kernel_outbox WHERE id=?').get(id);
      if (!row) return false;
      const blocked = this.statement(
        "SELECT id FROM kernel_outbox WHERE peer=? AND status IN ('sending','unknown')",
      ).get(String(row.peer));
      if (blocked) return false;
      return Boolean(
        this.statement(
          "UPDATE kernel_outbox SET status='sending' WHERE id=? AND status='pending'",
        ).run(id).changes,
      );
    });
  }

  delivery(id: string, status: 'sent' | 'unknown' | 'failed'): boolean {
    return this.transaction(() => {
      const row = this.statement('SELECT * FROM kernel_outbox WHERE id=?').get(id);
      if (!row || (row.status !== 'sending' && !(row.status === 'unknown' && status !== 'unknown')))
        return false;
      this.statement('UPDATE kernel_outbox SET status=?,delivered_at=? WHERE id=?').run(
        status,
        status === 'sent' ? this.now() : null,
        id,
      );
      if (status === 'sent') {
        this.statement(
          "INSERT INTO kernel_events(id,peer,turn_id,kind,content,created_at) VALUES(?,?,?,'said',?,?)",
        ).run(id, String(row.peer), String(row.turn_id), String(row.part), this.now());
        this.statement(
          'UPDATE kernel_effects SET committed_at=COALESCE(committed_at,?) WHERE turn_id=? AND ordinal=?',
        ).run(this.now(), String(row.turn_id), Number(row.ordinal));
        this.setSetting('self', evolveSelf(this.self(), this.now(), { kind: 'delivered' }));
        const effect = this.statement(
          'SELECT value FROM kernel_effects WHERE turn_id=? AND ordinal=?',
        ).get(String(row.turn_id), Number(row.ordinal));
        if (effect) {
          const value = JSON.parse(String(effect.value)) as {
            snapshots: { id: string; evidence: string }[];
            askedSnapshots: { id: string; dueAt: number }[];
          };
          for (const thought of this.thoughts(String(row.peer)))
            if (
              thought.state === 'idle' &&
              value.snapshots.some(
                (snapshot) => snapshot.id === thought.id && snapshot.evidence === thought.evidence,
              )
            )
              this.saveThought(String(row.peer), {
                ...thought,
                state: 'expressed',
                updatedAt: this.now(),
              });
          for (const item of this.commitments(String(row.peer)))
            if (
              item.state === 'open' &&
              !item.askedAt &&
              value.askedSnapshots.some(
                (snapshot) => snapshot.id === item.id && snapshot.dueAt === item.dueAt,
              )
            )
              this.statement('UPDATE kernel_commitments SET value=? WHERE id=? AND peer=?').run(
                JSON.stringify({ ...item, askedAt: this.now() }),
                item.id,
                String(row.peer),
              );
          this.refreshReminder(String(row.peer));
        }
      }
      const unresolved = this.statement(
        "SELECT id FROM kernel_outbox WHERE turn_id=? AND status IN ('pending','sending','unknown')",
      ).get(String(row.turn_id));
      if (!unresolved)
        this.statement("UPDATE kernel_turns SET state='done' WHERE id=?").run(String(row.turn_id));
      return true;
    });
  }

  /** 悬置过久的 unknown 发送按失败收场：unknown 封住投递通道（blocked），
   *  管理员不在时她会对着满 pending 的队列一直闭嘴。等确认的语义有时限，
   *  超时后交给"没发出去"的真实——说不成的话下一拍自然会重想。 */
  expireUnknown(timeoutMs: number): number {
    return this.transaction(() => {
      const changed = Number(
        this.statement(
          "UPDATE kernel_outbox SET status='failed' WHERE status='unknown' AND created_at <= ?",
        ).run(this.now() - timeoutMs).changes,
      );
      if (changed)
        this.statement(
          "UPDATE kernel_turns SET state='done' WHERE state='ready' AND id NOT IN (SELECT turn_id FROM kernel_outbox WHERE status IN ('pending','sending','unknown'))",
        ).run();
      return changed;
    });
  }

  receipt(turn: Turn, tool: string, result: unknown, succeeded: boolean): string {
    return this.transaction(() => {
      const id = randomUUID();
      this.statement(
        'INSERT INTO kernel_events(id,peer,turn_id,kind,content,created_at) VALUES(?,?,?,?,?,?)',
      ).run(
        id,
        turn.peer,
        turn.id,
        succeeded ? 'experienced' : 'attempted',
        JSON.stringify({ tool, result }),
        this.now(),
      );
      if (succeeded)
        this.setSetting(
          'self',
          evolveSelf(this.self(), this.now(), { kind: 'experienced', salience: 0.5 }),
        );
      return id;
    });
  }

  /** 通用事件写入（日记段等模型产出的持久记录）。 */
  appendEvent(peer: string, turnId: string, kind: string, content: unknown): string {
    return this.transaction(() => {
      this.statement('INSERT OR IGNORE INTO kernel_peers(id) VALUES(?)').run(peer);
      const id = randomUUID();
      this.statement(
        'INSERT INTO kernel_events(id,peer,turn_id,kind,content,created_at) VALUES(?,?,?,?,?,?)',
      ).run(id, peer, turnId, kind, JSON.stringify(content), this.now());
      return id;
    });
  }

  self(): SelfState {
    return projectSelf(this.setting<SelfState>('self', initialSelf(this.now())), this.now());
  }

  mood(peer: string): MoodPulse | undefined {
    return this.setting<MoodPulse | undefined>(`mood:${peer}`, undefined);
  }

  setMood(peer: string, mood: MoodPulse): void {
    this.setSetting(`mood:${peer}`, mood);
    // 心情轨迹：她自己的 reason 原文是情绪粒度的载体，留着让它浮回材料。
    const history = this.moodHistory(peer);
    const last = history.at(-1);
    const duplicate = last && last.reason === mood.reason && mood.at - last.at < 10 * 60000;
    if (!duplicate) {
      history.push(mood);
      this.setSetting(
        `mood-history:${peer}`,
        history.slice(-24).filter((entry) => mood.at - entry.at < 48 * 3600000),
      );
    }
  }

  moodHistory(peer: string): MoodPulse[] {
    return this.setting<MoodPulse[]>(`mood-history:${peer}`, []);
  }

  /** 她对"他"的心智模型：夜间整理时由她亲手修订的当前信念集，带最后
   *  核实时间——材料里按陈旧度呈现，提醒她这些是会过时的认识。 */
  peerModel(peer: string): PeerModel | undefined {
    return this.setting<PeerModel | undefined>(`peer-model:${peer}`, undefined);
  }

  savePeerModel(peer: string, model: PeerModel): void {
    this.setSetting(`peer-model:${peer}`, model);
  }

  /** 日夜共用的事件读取（日记、整理材料的取材来源）。 */
  recentEvents(
    peer: string,
    kinds: string[],
    limit = 40,
  ): { id: string; kind: string; content: string; created_at: number }[] {
    if (!kinds.length) return [];
    const placeholders = kinds.map(() => '?').join(',');
    const size = Math.max(1, Math.min(500, Math.floor(limit)));
    return (
      this.statement(
        `SELECT id,kind,content,created_at FROM kernel_events WHERE peer=? AND kind IN (${placeholders}) ORDER BY seq DESC LIMIT ?`,
      ).all(peer, ...kinds, size) as unknown as {
        id: string;
        kind: string;
        content: string;
        created_at: number;
      }[]
    ).reverse();
  }

  setEmbedding(id: string, model: string, vector: Float32Array): void {
    this.statement(
      'INSERT INTO kernel_embeddings(id,model,vector,at) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET model=excluded.model,vector=excluded.vector,at=excluded.at',
    ).run(id, model, Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength), this.now());
  }

  embeddingsOf(ids: string[], model: string): Map<string, Float32Array> {
    const out = new Map<string, Float32Array>();
    for (const id of ids) {
      const row = this.statement('SELECT vector FROM kernel_embeddings WHERE id=? AND model=?').get(
        id,
        model,
      ) as { vector: Buffer } | undefined;
      if (row)
        out.set(
          id,
          new Float32Array(row.vector.buffer, row.vector.byteOffset, row.vector.byteLength / 4),
        );
    }
    return out;
  }

  /** 语义检索的语料：收到的消息、确认送达的话、日记段与活跃记忆。
   *  缺嵌入的判断下沉进 SQL（NOT EXISTS）——不再为"已有哪些"加载全量 id。 */
  searchable(
    peer: string,
    model: string,
    limit = 400,
  ): { id: string; kind: string; text: string }[] {
    const rows = this.statement(
      `SELECT id,kind,content FROM kernel_events
       WHERE peer=? AND kind IN ('received','said','diary')
         AND NOT EXISTS (SELECT 1 FROM kernel_embeddings x WHERE x.id=kernel_events.id AND x.model=?)
       ORDER BY seq DESC LIMIT ?`,
    ).all(peer, model, Math.floor(limit)) as unknown as {
      id: string;
      kind: string;
      content: string;
    }[];
    const memoryRows = this.statement(
      `SELECT value FROM kernel_memories
       WHERE peer=? AND status='active'
         AND NOT EXISTS (SELECT 1 FROM kernel_embeddings x WHERE x.id=kernel_memories.id AND x.model=?)
       ORDER BY rowid DESC LIMIT ?`,
    ).all(peer, model, Math.floor(limit / 2)) as unknown as { value: string }[];
    const out: { id: string; kind: string; text: string }[] = [];
    for (const row of rows) {
      let text = row.content;
      if (row.kind !== 'received') {
        try {
          const parsed = JSON.parse(row.content) as Bubble & { content?: string };
          text = parsed.text ?? parsed.content ?? row.content;
        } catch {
          /* 原样 */
        }
      }
      out.push({ id: row.id, kind: row.kind, text });
    }
    for (const row of memoryRows) {
      const memory = JSON.parse(row.value) as Memory;
      out.push({
        id: memory.id,
        kind: 'memory',
        text: memory.kind === 'stated' ? memory.content : `${memory.content}（${memory.gist}）`,
      });
    }
    return out.slice(0, 128);
  }

  /** 待补嵌入的精确计数（管理页用）：searchable 会把语料截到一批的
   *  上限，拿它的 length 当积压数会在 128 处封顶。 */
  searchablePendingCount(peer: string, model: string): number {
    const events = this.statement(
      `SELECT count(*) AS n FROM kernel_events
       WHERE peer=? AND kind IN ('received','said','diary')
         AND NOT EXISTS (SELECT 1 FROM kernel_embeddings x WHERE x.id=kernel_events.id AND x.model=?)`,
    ).get(peer, model) as { n: number };
    const memories = this.statement(
      `SELECT count(*) AS n FROM kernel_memories
       WHERE peer=? AND status='active'
         AND NOT EXISTS (SELECT 1 FROM kernel_embeddings x WHERE x.id=kernel_memories.id AND x.model=?)`,
    ).get(peer, model) as { n: number };
    return Number(events.n) + Number(memories.n);
  }

  recordUsage(purpose: string, model: string, input: number, output: number, cached: number): void {
    this.statement(
      'INSERT INTO kernel_usage(purpose,model,input,output,cached,at) VALUES(?,?,?,?,?,?)',
    ).run(
      purpose,
      model,
      Math.max(0, Math.floor(input)),
      Math.max(0, Math.floor(output)),
      Math.max(0, Math.floor(cached)),
      this.now(),
    );
  }

  usage(
    days = 7,
    timeZone?: string,
  ): {
    day: string;
    purpose: string;
    calls: number;
    input: number;
    output: number;
    cached: number;
  }[] {
    const since = this.now() - Math.max(1, Math.min(90, days)) * 86400000;
    // 按她的时区切日：'天'是人读的钟点，不是 UTC 的凌晨八点。
    const offsetMs = timeZone ? zoneOffsetMinutes(this.now(), timeZone) * 60000 : 0;
    return this.statement(
      `SELECT date((at + ?)/1000,'unixepoch') AS day, purpose, count(*) AS calls,
              sum(input) AS input, sum(output) AS output, sum(cached) AS cached
       FROM kernel_usage WHERE at>=? GROUP BY day, purpose ORDER BY day DESC, purpose`,
    ).all(offsetMs, since) as unknown as {
      day: string;
      purpose: string;
      calls: number;
      input: number;
      output: number;
      cached: number;
    }[];
  }

  experiences(
    peer: string,
    limit = 20,
  ): { id: string; kind: string; content: string; created_at: number }[] {
    return (
      this.statement(
        "SELECT id,kind,content,created_at FROM kernel_events WHERE peer=? AND kind IN ('experienced','attempted') ORDER BY seq DESC LIMIT ?",
      ).all(peer, Math.max(1, Math.min(100, Math.floor(limit)))) as unknown as {
        id: string;
        kind: string;
        content: string;
        created_at: number;
      }[]
    ).reverse();
  }

  conversation(
    peer: string,
    limit = 160,
  ): { id: string; kind: string; content: string; created_at: number }[] {
    const size = Math.max(1, Math.min(500, Math.floor(limit)));
    return (
      this.statement(
        "SELECT id,kind,content,created_at FROM kernel_events WHERE peer=? AND kind IN ('received','said') ORDER BY seq DESC LIMIT ?",
      ).all(peer, size) as unknown as {
        id: string;
        kind: string;
        content: string;
        created_at: number;
      }[]
    ).reverse();
  }

  /** 管理页事件读取。事件流只增不减（muse 每轮都可能写一条），默认只给
   *  最近 500 条——4 秒轮询不该随相处年限线性变贵。 */
  events(
    peer: string,
    kinds?: string[],
    limit = 500,
  ): { id: string; kind: string; content: string; created_at: number }[] {
    const size = Math.max(1, Math.min(2000, Math.floor(limit)));
    const rows = (kinds?.length
      ? this.statement(
          `SELECT id,kind,content,created_at FROM kernel_events WHERE peer=? AND kind IN (${kinds.map(() => '?').join(',')}) ORDER BY seq DESC LIMIT ?`,
        ).all(peer, ...kinds, size)
      : this.statement(
          'SELECT id,kind,content,created_at FROM kernel_events WHERE peer=? ORDER BY seq DESC LIMIT ?',
        ).all(peer, size)) as unknown as {
      id: string;
      kind: string;
      content: string;
      created_at: number;
    }[];
    return rows.reverse();
  }

  evidence(peer: string, ids: string[]): { id: string; kind: string }[] {
    return [...new Set(ids)].flatMap((id) => {
      const row = this.statement('SELECT id,kind FROM kernel_events WHERE peer=? AND id=?').get(
        peer,
        id,
      );
      return row ? [{ id: String(row.id), kind: String(row.kind) }] : [];
    });
  }

  /** 时间窗内的事件（往年今天、当晚唤醒度统计都用它）。半开区间 [from, to)。 */
  eventsBetween(
    peer: string,
    kinds: string[],
    from: number,
    to: number,
    limit = 100,
  ): { id: string; kind: string; content: string; created_at: number }[] {
    if (!kinds.length || from >= to) return [];
    const placeholders = kinds.map(() => '?').join(',');
    return this.statement(
      `SELECT id,kind,content,created_at FROM kernel_events
       WHERE peer=? AND kind IN (${placeholders}) AND created_at>=? AND created_at<?
       ORDER BY seq LIMIT ?`,
    ).all(peer, ...kinds, from, to, Math.max(1, Math.min(500, Math.floor(limit)))) as unknown as {
      id: string;
      kind: string;
      content: string;
      created_at: number;
    }[];
  }

  /** seq 大于 after 的对话事件（话题笔记的增量查询）。 */
  conversationAfter(
    peer: string,
    after: number,
    limit = 200,
  ): { id: string; seq: number; kind: string; content: string; created_at: number }[] {
    return this.statement(
      `SELECT id,seq,kind,content,created_at FROM kernel_events
       WHERE peer=? AND kind IN ('received','said') AND seq>?
       ORDER BY seq LIMIT ?`,
    ).all(peer, after, Math.max(1, Math.min(500, Math.floor(limit)))) as unknown as {
      id: string;
      seq: number;
      kind: string;
      content: string;
      created_at: number;
    }[];
  }

  /** 第一条收到消息的时刻：你们认识的纪元（里程碑资料用）。 */
  firstReceivedAt(peer: string): number | undefined {
    const row = this.statement(
      "SELECT min(created_at) AS at FROM kernel_events WHERE peer=? AND kind='received'",
    ).get(peer);
    return row?.at === undefined || row.at === null ? undefined : Number(row.at);
  }

  /** 收到事件里引用的媒体路径集（孤儿媒体清扫用）：SQL 先筛出含 media
   *  字段的行，不再为几条图片引用 JSON.parse 整部聊天史。 */
  referencedMedia(peer: string): Set<string> {
    const out = new Set<string>();
    for (const row of this.statement(
      "SELECT content FROM kernel_events WHERE peer=? AND kind='received' AND content LIKE '%\"media\":%'",
    ).all(peer) as unknown as { content: string }[])
      try {
        const media = JSON.parse(row.content)?.media;
        if (Array.isArray(media))
          for (const item of media) if (typeof item?.path === 'string') out.add(item.path);
      } catch {
        /* 文本里恰好包含 "media": 字样，不是 JSON */
      }
    return out;
  }

  /** 终态念头（已表达/已放下）超龄退场：材料与检索不再拖着永远不会
   *  回来的尸体。idle 的一律保留——那是还活着的期待。 */
  pruneThoughts(olderThanMs: number): number {
    const cutoff = this.now() - olderThanMs;
    let removed = 0;
    for (const peer of this.peers())
      for (const thought of this.thoughts(peer))
        if (thought.state !== 'idle' && thought.updatedAt < cutoff) {
          this.statement('DELETE FROM kernel_thoughts WHERE peer=? AND topic=?').run(
            peer,
            thought.topic,
          );
          removed++;
        }
    return removed;
  }

  /** 用量流水超龄退场：查询窗口本来只有 90 天，行没有理由比它活得更久。 */
  pruneUsage(olderThanMs: number): number {
    return Number(
      this.statement('DELETE FROM kernel_usage WHERE at <= ?').run(this.now() - olderThanMs)
        .changes,
    );
  }

  /** 该联系人的对话事件总数（received+said，历史窗口自适应用）。 */
  conversationCount(peer: string): number {
    const row = this.statement(
      "SELECT COUNT(*) AS n FROM kernel_events WHERE peer=? AND kind IN ('received','said')",
    ).get(peer);
    return Number(row?.n ?? 0);
  }

  /** 她近两天主动开过的口（心跳拍产出的气泡）：防同一话头反复出现的
   *  指纹清单。返回按时间先后、每条截短的可读文本。 */
  recentBeatOpeners(peer: string, sinceMs: number): string[] {
    const rows = this.statement(
      `SELECT e.content AS content FROM kernel_events e
       JOIN kernel_turns t ON t.id = e.turn_id
       WHERE e.peer=? AND e.kind='said' AND t.kind='beat' AND e.created_at>=?
       ORDER BY e.seq DESC LIMIT 6`,
    ).all(peer, sinceMs) as unknown as { content: string }[];
    const out: string[] = [];
    for (const row of rows.reverse()) {
      try {
        const part = JSON.parse(row.content) as { type?: string; text?: string };
        if (part?.type === 'text' && part.text?.trim())
          out.push(part.text.trim().replace(/\s+/g, ' ').slice(0, 40));
      } catch {
        /* 非气泡行跳过 */
      }
    }
    return out;
  }

  /** 按 ID 精确取事件（read_history 的原文核对通道），保持传入顺序，
   *  不存在的 ID 静默跳过。 */
  eventsByIds(
    peer: string,
    ids: string[],
  ): { id: string; kind: string; content: string; created_at: number }[] {
    return ids.flatMap((id) => {
      const row = this.statement(
        'SELECT id,kind,content,created_at FROM kernel_events WHERE peer=? AND id=?',
      ).get(peer, id);
      return row
        ? [row as unknown as { id: string; kind: string; content: string; created_at: number }]
        : [];
    });
  }

  /** 信念与认识的依据可以是事件，也可以是已立住的记忆（心智模型的整理
   *  发生在夜里，那时候模型手里是记忆条目而不是原始事件）。 */
  supports(peer: string, ids: string[]): number {
    const wanted = [...new Set(ids)];
    let found = 0;
    for (const id of wanted) {
      if (this.statement('SELECT id FROM kernel_events WHERE peer=? AND id=?').get(peer, id)) {
        found++;
        continue;
      }
      if (
        this.statement(
          "SELECT id FROM kernel_memories WHERE peer=? AND id=? AND status='active'",
        ).get(peer, id)
      )
        found++;
    }
    return found;
  }

  memories(peer: string): Memory[] {
    return this.statement('SELECT value,status FROM kernel_memories WHERE peer=?')
      .all(peer)
      .map((row) => ({ ...JSON.parse(String(row.value)), status: String(row.status) }) as Memory);
  }

  saveMemory(peer: string, memory: Memory, supersedes: string[] = []): void {
    this.transaction(() => {
      const owner = this.statement('SELECT peer FROM kernel_memories WHERE id=?').get(memory.id);
      if (owner && owner.peer !== peer) throw new Error('不能修改其他联系人的记忆');
      this.statement(
        'INSERT INTO kernel_memories(id,peer,status,value) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,value=excluded.value',
      ).run(memory.id, peer, memory.status, JSON.stringify(memory));
      for (const id of supersedes)
        this.statement(
          "UPDATE kernel_memories SET status='superseded' WHERE id=? AND peer=? AND status='active'",
        ).run(id, peer);
    });
  }

  thoughts(peer: string): ThoughtEntry[] {
    return this.statement('SELECT value FROM kernel_thoughts WHERE peer=?')
      .all(peer)
      .map((row) => JSON.parse(String(row.value)) as ThoughtEntry);
  }

  saveThought(peer: string, thought: ThoughtEntry): void {
    const owner = this.statement('SELECT peer FROM kernel_thoughts WHERE id=?').get(thought.id);
    if (owner && owner.peer !== peer) throw new Error('不能修改其他联系人的念头');
    this.statement(
      'INSERT INTO kernel_thoughts(id,peer,topic,value) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value',
    ).run(thought.id, peer, thought.topic, JSON.stringify(thought));
  }

  commitments(peer: string): Commitment[] {
    return this.statement('SELECT value FROM kernel_commitments WHERE peer=?')
      .all(peer)
      .map((row) => JSON.parse(String(row.value)) as Commitment);
  }

  private refreshReminder(peer: string): void {
    const due = this.commitments(peer)
      .filter((item) => item.state === 'open' && item.dueAt > 0 && !item.askedAt)
      .map((item) => item.dueAt);
    if (due.length)
      this.statement(
        "INSERT INTO kernel_jobs(peer,kind,due_at) VALUES(?,'reminder',?) ON CONFLICT(peer,kind) DO UPDATE SET due_at=excluded.due_at",
      ).run(peer, Math.min(...due));
    else this.statement("DELETE FROM kernel_jobs WHERE peer=? AND kind='reminder'").run(peer);
  }

  /** 提醒拍结束后重算：问过的退场，没问到的保持到期状态（不会因为一次
   *  安静的提醒拍就永远失去下一次提醒机会）。 */
  rearmReminders(peer: string): void {
    this.transaction(() => this.refreshReminder(peer));
  }

  keepCommitment(
    peer: string,
    input: Omit<Commitment, 'id' | 'state' | 'askedAt' | 'createdAt'>,
  ): Commitment {
    if (
      !input.content.trim() ||
      input.content.length > 1000 ||
      !Number.isFinite(input.dueAt) ||
      input.dueAt < 0 ||
      !['reminder', 'concern', 'promise'].includes(input.kind) ||
      !['none', 'yearly'].includes(input.recurring)
    )
      throw new TypeError('约定内容或时间无效');
    const evidence = this.evidence(peer, input.sources);
    if (
      !input.sources.length ||
      evidence.length !== new Set(input.sources).size ||
      evidence.some((event) => !['received', 'said', 'experienced'].includes(event.kind))
    )
      throw new TypeError('约定缺少真实来源');
    return this.transaction(() => {
      const existing = this.commitments(peer).find(
        (item) =>
          item.state === 'open' &&
          item.content === input.content.trim() &&
          item.kind === input.kind,
      );
      const value: Commitment = {
        ...input,
        content: input.content.trim(),
        sources: [...new Set([...(existing?.sources ?? []), ...input.sources])],
        id: existing?.id ?? randomUUID(),
        state: 'open',
        askedAt: existing?.dueAt === input.dueAt ? existing.askedAt : 0,
        createdAt: existing?.createdAt ?? this.now(),
      };
      this.statement(
        'INSERT INTO kernel_commitments(id,peer,value) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value',
      ).run(value.id, peer, JSON.stringify(value));
      this.refreshReminder(peer);
      return value;
    });
  }

  resolveCommitment(peer: string, id: string): boolean {
    const value = this.commitments(peer).find((item) => item.id === id && item.state === 'open');
    if (!value) return false;
    return this.transaction(() => {
      if (value.recurring === 'yearly') {
        value.dueAt = nextYearAfter(value.dueAt, this.now());
        value.askedAt = 0;
      } else value.state = 'resolved';
      this.statement('UPDATE kernel_commitments SET value=? WHERE id=? AND peer=?').run(
        JSON.stringify(value),
        id,
        peer,
      );
      this.refreshReminder(peer);
      return true;
    });
  }

  committedEffects(turn: string): Record<string, unknown> | undefined {
    const row = this.statement(
      'SELECT value FROM kernel_effects WHERE turn_id=? AND committed_at IS NOT NULL',
    ).get(turn);
    return row
      ? (JSON.parse(String(row.value)) as { effects: Record<string, unknown> }).effects
      : undefined;
  }

  schedule(peer: string, kind: Turn['kind'], dueAt: number): void {
    if (!Number.isFinite(dueAt)) throw new TypeError('任务时间必须有限');
    const due = Math.round(dueAt);
    this.transaction(() => {
      this.statement('INSERT OR IGNORE INTO kernel_peers(id) VALUES(?)').run(peer);
      this.statement(
        'INSERT INTO kernel_jobs(peer,kind,due_at) VALUES(?,?,?) ON CONFLICT(peer,kind) DO UPDATE SET due_at=excluded.due_at',
      ).run(peer, kind, due);
    });
  }

  jobs(): { peer: string; kind: Turn['kind']; due_at: number }[] {
    return this.statement(
      "SELECT peer,kind,due_at FROM kernel_jobs ORDER BY due_at,CASE kind WHEN 'chat' THEN 0 ELSE 1 END",
    ).all() as unknown as { peer: string; kind: Turn['kind']; due_at: number }[];
  }

  claim(peer: string, kind: Turn['kind']): Turn | undefined {
    return this.transaction(() => {
      const job = this.statement('SELECT due_at FROM kernel_jobs WHERE peer=? AND kind=?').get(
        peer,
        kind,
      );
      if (!job || Number(job.due_at) > this.now()) return undefined;
      if (this.statement("SELECT id FROM kernel_turns WHERE peer=? AND state='running'").get(peer))
        return undefined;
      if (
        !this.blocked(peer) &&
        this.statement("SELECT id FROM kernel_outbox WHERE peer=? AND status='pending'").get(peer)
      )
        return undefined;
      const version = Number(
        this.statement('SELECT version FROM kernel_peers WHERE id=?').get(peer)!.version,
      );
      const turn: Turn = { id: randomUUID(), peer, version, kind };
      this.statement(
        "INSERT INTO kernel_turns(id,peer,version,kind,state,created_at) VALUES(?,?,?,?,'running',?)",
      ).run(turn.id, peer, version, kind, this.now());
      this.statement('DELETE FROM kernel_jobs WHERE peer=? AND kind=?').run(peer, kind);
      return turn;
    });
  }

  fail(turn: Turn, error: string): void {
    this.transaction(() => {
      const changed = this.statement(
        "UPDATE kernel_turns SET state='failed' WHERE id=? AND state='running'",
      ).run(turn.id).changes;
      if (changed)
        this.statement(
          "INSERT INTO kernel_events(id,peer,turn_id,kind,content,created_at) VALUES(?,?,?,'failure',?,?)",
        ).run(randomUUID(), turn.peer, turn.id, error, this.now());
    });
  }

  deliveryPeers(): string[] {
    return this.statement("SELECT DISTINCT peer FROM kernel_outbox WHERE status='pending'")
      .all()
      .map((row) => String(row.peer));
  }

  peers(): string[] {
    return (
      this.statement('SELECT id FROM kernel_peers ORDER BY rowid').all() as unknown as {
        id: string;
      }[]
    ).map((row) => row.id);
  }

  turnRunning(peer: string, kind: Turn['kind']): boolean {
    return Boolean(
      this.statement("SELECT id FROM kernel_turns WHERE peer=? AND kind=? AND state='running'").get(
        peer,
        kind,
      ),
    );
  }

  blocked(peer: string): boolean {
    return Boolean(
      this.statement(
        "SELECT id FROM kernel_outbox WHERE peer=? AND status IN ('sending','unknown') LIMIT 1",
      ).get(peer),
    );
  }

  /** 机器人账号换绑：peer id 形如 wechat:{account}:{address}——账号换了，
   *  人没换，她的记忆、对话、约定、排期整体搬到新账号的 peer 下。
   *  jobs 的 (peer,kind) 冲突时旧数据优先（她的历史不可丢）。 */
  remapPeers(oldAccount: string, newAccount: string): void {
    if (oldAccount === newAccount) return;
    const old = `wechat:${oldAccount}:`;
    const fresh = `wechat:${newAccount}:`;
    this.transaction(() => {
      // 先立新 peer 行：子表的 peer 外键要指到真实存在的行。
      for (const row of this.statement('SELECT id FROM kernel_peers WHERE id LIKE ?').all(
        `${old}%`,
      ) as unknown as {
        id: string;
      }[])
        this.statement('INSERT OR IGNORE INTO kernel_peers(id,version) VALUES(?,?)').run(
          fresh + row.id.slice(old.length),
          0,
        );
      for (const table of [
        'kernel_events',
        'kernel_memories',
        'kernel_thoughts',
        'kernel_commitments',
        'kernel_jobs',
        'kernel_turns',
        'kernel_outbox',
      ]) {
        this.statement(
          `UPDATE OR REPLACE ${table} SET peer = ?1 || substr(peer, ?2) WHERE substr(peer, 1, ?3) = ?4`,
        ).run(fresh, old.length + 1, old.length, old);
      }
      // 以 peer 为键的设置：mood 是瞬态（衰减自愈），旧账号的值直接退场，
      // 新账号已长出的现值保留；其余 per-peer 键（心情轨迹、心智模型、
      // 话题笔记及其游标）整体照搬——它们是她的资产，换绑不能丢。
      // 旧账号的联系人册与同步游标随账号退场——账号换了，它们不再被任何
      // 路径读到。
      this.statement(
        "DELETE FROM kernel_settings WHERE key LIKE 'mood:%' AND instr(key, ?1) > 0",
      ).run(old);
      this.statement('DELETE FROM kernel_settings WHERE key = ?').run(
        `wechat:contacts:${oldAccount}`,
      );
      this.statement('DELETE FROM kernel_settings WHERE key = ?').run(
        `wechat:cursor:${oldAccount}`,
      );
      this.statement(
        "UPDATE kernel_settings SET key = replace(key, ?1, ?2) WHERE instr(key, ?1) > 0 AND (key LIKE 'mood-history:%' OR key LIKE 'peer-model:%' OR key LIKE 'notes:%' OR key LIKE 'wechat:context:%')",
      ).run(old, fresh);
      this.statement('DELETE FROM kernel_peers WHERE id LIKE ?').run(`${old}%`);
    });
  }

  recover(): void {
    this.transaction(() => {
      this.statement("UPDATE kernel_outbox SET status='unknown' WHERE status='sending'").run();
      this.statement(
        "INSERT INTO kernel_jobs(peer,kind,due_at) SELECT peer,kind,? FROM kernel_turns WHERE state='running' ON CONFLICT(peer,kind) DO NOTHING",
      ).run(this.now());
      this.statement("UPDATE kernel_turns SET state='interrupted' WHERE state='running'").run();
    });
  }

  close(): void {
    this.statements.clear();
    this.sql.close();
  }
}
