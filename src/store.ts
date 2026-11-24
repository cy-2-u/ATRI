import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import type { Attachment, Commitment, CommitmentInput, Envelope, Event, Feeling, Incoming, Impressions, Job, JobKind, Memory, MemoryInput, Part, Peer, Self, Target, ThoughtEntry, ThoughtOp } from './types.ts';
import { peerKey, errorText } from './types.ts';
import { grams, instant, nextOccurrence, initialSelf, projectSelf, evolveSelf, evolveCloseness, dayKey, dayStart, rehearseMemory } from './state.ts';

const parse = <T>(value: unknown): T => JSON.parse(String(value)) as T;
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export interface Turn { id: string; episode: string; peer: string; snapshot: number; jobs: Job[]; allowed: Set<string> }
export interface Segment { id: string; peer: string; from: number; to: number; text: string; at: number }
interface CommitmentEffect extends CommitmentInput { expected: { id: string; version: number; status: Commitment['status'] } | null }

export class Store {
  readonly db: DatabaseSync;
  readonly now: () => number;
  private statements = new Map<string, StatementSync>();
  private depth = 0;

  constructor(path: string, now = Date.now) {
    this.now = now;
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      PRAGMA foreign_keys=ON;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS kv(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS peers(id TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(
        seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,peer TEXT NOT NULL,
        kind TEXT NOT NULL,data TEXT NOT NULL,at INTEGER NOT NULL,turn TEXT,dedupe TEXT UNIQUE
      );
      CREATE INDEX IF NOT EXISTS events_peer_seq ON events(peer,seq);
      CREATE INDEX IF NOT EXISTS events_peer_kind ON events(peer,kind,seq);
      CREATE VIRTUAL TABLE IF NOT EXISTS event_search USING fts5(id UNINDEXED,peer UNINDEXED,terms);
      CREATE TABLE IF NOT EXISTS attachments(id TEXT PRIMARY KEY,peer TEXT NOT NULL,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs(
        id TEXT PRIMARY KEY,peer TEXT NOT NULL,kind TEXT NOT NULL,reason TEXT NOT NULL,
        due INTEGER NOT NULL,data TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,error TEXT
      );
      CREATE INDEX IF NOT EXISTS jobs_due ON jobs(state,due);
      CREATE TABLE IF NOT EXISTS turns(id TEXT PRIMARY KEY,peer TEXT NOT NULL,snapshot INTEGER NOT NULL,state TEXT NOT NULL,at INTEGER NOT NULL,error TEXT);
      CREATE TABLE IF NOT EXISTS outbox(
        id TEXT PRIMARY KEY,peer TEXT NOT NULL,turn TEXT NOT NULL,ordinal INTEGER NOT NULL,
        part TEXT NOT NULL,effects TEXT NOT NULL,status TEXT NOT NULL,request TEXT,
        due INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,error TEXT,platform_id TEXT,created INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS outbox_pending ON outbox(status,due);
      CREATE TABLE IF NOT EXISTS memories(id TEXT PRIMARY KEY,peer TEXT NOT NULL,slot TEXT NOT NULL,status TEXT NOT NULL,value TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS memories_peer ON memories(peer,status);
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_search USING fts5(id UNINDEXED,peer UNINDEXED,terms);
      CREATE TABLE IF NOT EXISTS vectors(id TEXT NOT NULL,model TEXT NOT NULL,hash TEXT NOT NULL,value BLOB NOT NULL,PRIMARY KEY(id,model));
      CREATE TABLE IF NOT EXISTS commitments(id TEXT PRIMARY KEY,peer TEXT NOT NULL,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS thoughts(id TEXT PRIMARY KEY,peer TEXT NOT NULL,topic TEXT NOT NULL,value TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS thoughts_peer ON thoughts(peer);
      CREATE TABLE IF NOT EXISTS segments(id TEXT PRIMARY KEY,peer TEXT NOT NULL,first_seq INTEGER NOT NULL,last_seq INTEGER NOT NULL,text TEXT NOT NULL,at INTEGER NOT NULL,UNIQUE(peer,first_seq,last_seq));
      CREATE TABLE IF NOT EXISTS usage(id INTEGER PRIMARY KEY,at INTEGER NOT NULL,purpose TEXT NOT NULL,model TEXT NOT NULL,endpoint TEXT NOT NULL,status TEXT NOT NULL,input INTEGER,output INTEGER,cached INTEGER,cache_write INTEGER,cost REAL,latency INTEGER NOT NULL,error TEXT);
      CREATE INDEX IF NOT EXISTS usage_at ON usage(at);
      CREATE TABLE IF NOT EXISTS tool_runs(id TEXT PRIMARY KEY,peer TEXT NOT NULL,turn TEXT NOT NULL,signature TEXT NOT NULL,status TEXT NOT NULL,result TEXT,at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS media_cache(key TEXT PRIMARY KEY,info TEXT NOT NULL,expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS wall(id TEXT PRIMARY KEY,peer TEXT NOT NULL,author TEXT NOT NULL,text TEXT NOT NULL,path TEXT,at INTEGER NOT NULL,public INTEGER NOT NULL DEFAULT 0);
    `);
    this.recover();
  }

  sql(query: string): StatementSync {
    let stmt = this.statements.get(query);
    if (!stmt) { stmt = this.db.prepare(query); this.statements.set(query, stmt); }
    return stmt;
  }

  transaction<T>(work: () => T): T {
    const level = this.depth++;
    const savepoint = `tx_${level}`;
    this.db.exec(level ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE');
    try { const value = work(); this.db.exec(level ? `RELEASE ${savepoint}` : 'COMMIT'); return value; }
    catch (error) { this.db.exec(level ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}` : 'ROLLBACK'); throw error; }
    finally { this.depth--; }
  }

  get<T>(key: string, fallback: T): T {
    const row = this.sql('SELECT value FROM kv WHERE key=?').get(key);
    return row ? parse<T>(row.value) : fallback;
  }
  set(key: string, value: unknown): void {
    this.sql('INSERT INTO kv(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value));
  }

  peers(): Peer[] { return this.sql('SELECT value FROM peers ORDER BY id').all().map(r => parse<Peer>(r.value)); }
  peer(id: string): Peer | undefined { const row = this.sql('SELECT value FROM peers WHERE id=?').get(id); return row ? parse<Peer>(row.value) : undefined; }
  ensurePeer(target: Target): Peer {
    const id = peerKey(target);
    const existing = this.peer(id);
    if (existing) return existing;
    // 开箱即活：能收到消息的会话天然就是她在乎的人，默认处理消息+自主心智。
    // 开关降级为「想关时才碰」——部署完不该再有一轮手动点燃仪式。
    const p: Peer = { id, target, name: id, enabled: true, autonomous: true, activeAllowed: null, lastReceived: 0, lastAccepted: 0 };
    this.savePeer(p);
    return p;
  }
  savePeer(peer: Peer): void { this.sql('INSERT INTO peers(id,value) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(peer.id, JSON.stringify(peer)); }

  append(peer: string, kind: Event['kind'], data: Record<string, unknown>, turn?: string, dedupe?: string, at = this.now()): Event | undefined {
    const id = randomUUID();
    const result = this.sql('INSERT OR IGNORE INTO events(id,peer,kind,data,at,turn,dedupe) VALUES(?,?,?,?,?,?,?)').run(id, peer, kind, JSON.stringify(data), at, turn ?? null, dedupe ?? null);
    if (!result.changes) return undefined;
    const seq = Number(result.lastInsertRowid);
    const text = typeof data.text === 'string' ? data.text : typeof data.content === 'string' ? data.content : '';
    if (text) this.sql('INSERT INTO event_search(id,peer,terms) VALUES(?,?,?)').run(id, peer, grams(text).join(' '));
    return { seq, id, peer, kind, data, at, turn };
  }

  receive(input: Incoming, debounce: number): Event | undefined {
    return this.transaction(() => {
      const peer = this.ensurePeer(input.target);
      const event = this.append(peer.id, 'received', { ...input }, undefined, `${peer.id}:${input.key}`, input.at);
      if (!event) return undefined;
      for (const a of input.attachments) this.saveAttachment(peer.id, a);
      this.savePeer({ ...peer, lastReceived: this.now() });
      this.settleSelf(peer.id, 'received');
      this.sql("UPDATE outbox SET status='cancelled',error='新消息到达，旧草稿不再直接发送' WHERE peer=? AND status='pending'").run(peer.id);
      if (peer.enabled) this.schedule(`chat:${peer.id}`, peer.id, 'chat', '收到新消息', this.now() + debounce, { through: event.seq }, true);
      return event;
    });
  }

  private eventRow(row: Record<string, unknown>): Event {
    return { seq: Number(row.seq), id: String(row.id), peer: String(row.peer), kind: row.kind as Event['kind'], data: parse(row.data), at: Number(row.at), ...(row.turn ? { turn: String(row.turn) } : {}) };
  }
  events(peer: string, after = 0, before = Number.MAX_SAFE_INTEGER, limit = 200): Event[] {
    return this.sql('SELECT * FROM events WHERE peer=? AND seq>? AND seq<=? ORDER BY seq LIMIT ?').all(peer, after, before, limit).map(r => this.eventRow(r));
  }
  eventsKind(peer: string, kinds: string[], after: number, before: number, limit: number): Event[] {
    const marks = kinds.map(() => '?').join(',');
    return this.sql(`SELECT * FROM events WHERE peer=? AND kind IN (${marks}) AND seq>? AND seq<=? ORDER BY seq LIMIT ?`).all(peer, ...kinds, after, before, limit).map(r => this.eventRow(r));
  }
  eventsBetween(peer: string, kinds: string[], from: number, to: number, limit: number): Event[] {
    const marks = kinds.map(() => '?').join(',');
    return this.sql(`SELECT * FROM events WHERE peer=? AND kind IN (${marks}) AND at>=? AND at<=? ORDER BY seq LIMIT ?`).all(peer, ...kinds, from, to, limit).map(r => this.eventRow(r));
  }
  recent(peer: string, limit = 50, before = Number.MAX_SAFE_INTEGER): Event[] {
    // failure 在列：她和管理员都看得见自己的失败——诚实材料是公理不是装饰。
    return this.sql("SELECT * FROM events WHERE peer=? AND seq<=? AND kind IN ('received','accepted','action','reflection','due','diary','failure') ORDER BY seq DESC LIMIT ?").all(peer, before, limit).reverse().map(r => this.eventRow(r));
  }
  highwater(peer: string): number { return Number(this.sql('SELECT COALESCE(MAX(seq),0) AS seq FROM events WHERE peer=?').get(peer)!.seq); }
  latestReceived(peer: string): number { return Number(this.sql("SELECT COALESCE(MAX(seq),0) AS seq FROM events WHERE peer=? AND kind='received'").get(peer)!.seq); }
  evidence(peer: string, ids: string[]): Event[] {
    return [...new Set(ids)].flatMap(id => { const row = this.sql('SELECT * FROM events WHERE id=? AND peer=?').get(id, peer); return row ? [this.eventRow(row)] : []; });
  }
  eventByDedupe(dedupe: string): Event | undefined {
    const row = this.sql('SELECT * FROM events WHERE dedupe=?').get(dedupe);
    return row ? this.eventRow(row) : undefined;
  }
  searchHistory(peer: string, query: string, limit = 12): Event[] {
    const terms = grams(query).slice(0, 40);
    if (!terms.length) return [];
    return this.sql('SELECT e.* FROM event_search f JOIN events e ON e.id=f.id WHERE event_search MATCH ? AND f.peer=? ORDER BY rank LIMIT ?').all(terms.map(t => `"${t}"`).join(' OR '), peer, limit).map(r => this.eventRow(r));
  }
  saveAttachment(peer: string, a: Attachment): void { this.sql('INSERT INTO attachments(id,peer,value) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(a.id, peer, JSON.stringify(a)); }
  attachment(peer: string, id: string): Attachment | undefined {
    const row = this.sql('SELECT value FROM attachments WHERE id=? AND peer=?').get(id, peer);
    return row ? parse<Attachment>(row.value) : undefined;
  }

  schedule(id: string, peer: string, kind: JobKind, reason: string, due: number, data: Record<string, unknown> = {}, replace = false): void {
    if (!Number.isSafeInteger(due) || due < 0) throw new TypeError('任务时间无效');
    const existing = this.sql('SELECT state,due FROM jobs WHERE id=?').get(id);
    if (existing && !replace && existing.state !== 'cancelled') return;
    if (existing?.state === 'running') {
      // 入站过程中运行中的 chat 可以有独立的新一轮，不覆盖已认领任务。
      id += `:${this.highwater(peer)}`;
    }
    this.sql("INSERT INTO jobs(id,peer,kind,reason,due,data,state) VALUES(?,?,?,?,?,?,'pending') ON CONFLICT(id) DO UPDATE SET reason=excluded.reason,due=excluded.due,data=excluded.data,state='pending',attempts=0,error=NULL").run(id, peer, kind, reason, due, JSON.stringify(data));
  }
  jobs(peer?: string): Job[] {
    const rows = peer ? this.sql("SELECT * FROM jobs WHERE state='pending' AND peer=? ORDER BY due").all(peer) : this.sql("SELECT * FROM jobs WHERE state='pending' ORDER BY due").all();
    return rows.map(r => ({ id: String(r.id), peer: String(r.peer), kind: r.kind as JobKind, reason: String(r.reason), dueAt: Number(r.due), data: parse(r.data), attempts: Number(r.attempts) }));
  }
  dropJobs(peer: string, kind?: JobKind): void {
    if (kind) this.sql("UPDATE jobs SET state='cancelled' WHERE peer=? AND kind=? AND state='pending'").run(peer, kind);
    else this.sql("UPDATE jobs SET state='cancelled' WHERE peer=? AND state='pending'").run(peer);
  }

  claim(peer: string): Turn | undefined {
    return this.transaction(() => {
      if (this.sql("SELECT id FROM turns WHERE state='running' LIMIT 1").get()) return undefined;
      const jobs = this.jobs(peer).filter(j => j.dueAt <= this.now()).filter(j => {
        if (j.kind !== 'commitment') return true;
        const c = this.commitment(peer, String(j.data.id));
        const valid = c?.status === 'open' && c.version === j.data.version && c.dueAt === j.data.due;
        if (!valid) this.sql("UPDATE jobs SET state='cancelled' WHERE id=?").run(j.id);
        else this.markDue(j);
        return valid;
      });
      if (!jobs.length) return undefined;
      const id = randomUUID(), snapshot = this.highwater(peer);
      const episode = hash({ peer, received: this.latestReceived(peer), jobs: jobs.map(j => j.id).sort() });
      this.sql("INSERT INTO turns(id,peer,snapshot,state,at) VALUES(?,?,?,'running',?)").run(id, peer, snapshot, this.now());
      for (const job of jobs) this.sql("UPDATE jobs SET state='running' WHERE id=? AND state='pending'").run(job.id);
      return { id, episode, peer, snapshot, jobs, allowed: new Set<string>() };
    });
  }

  stale(turn: Turn): boolean { return this.latestReceived(turn.peer) > turn.snapshot; }

  finish(turn: Turn, state: 'done' | 'superseded' | 'failed', error?: string, retry = false): void {
    this.transaction(() => {
      this.sql('UPDATE turns SET state=?,error=? WHERE id=?').run(state, error ?? null, turn.id);
      for (const job of turn.jobs) {
        const superseded = state === 'superseded' && job.kind !== 'chat';
        const again = superseded || retry && job.attempts < 2;
        this.sql('UPDATE jobs SET state=?,attempts=attempts+?,error=?,due=? WHERE id=?').run(again ? 'pending' : state, Number(!superseded), error ?? null, superseded ? this.now() : this.now() + 5000 * 3 ** job.attempts, job.id);
      }
      if (state === 'done') this.set(`seen:${turn.peer}`, turn.snapshot);
      if (state === 'superseded') this.schedule(`chat:${turn.peer}`, turn.peer, 'chat', '新消息合并续答', this.now(), {}, true);
    });
  }

  recover(): void {
    this.transaction(() => {
      this.sql("UPDATE outbox SET status='unknown',error='进程中断，平台是否接收未知' WHERE status='sending'").run();
      this.sql("UPDATE jobs SET state='pending' WHERE state='running'").run();
      this.sql("UPDATE turns SET state='interrupted',error='进程中断' WHERE state='running'").run();
      this.sql("UPDATE tool_runs SET status='unknown',result=? WHERE status='running'").run(JSON.stringify({ error: '执行中断，不能假定未产生副作用' }));
      // 渐进投递的崩溃缺口：气泡已被平台接收、承诺还挂 pending 未回填，而思考已中断——
      // 「用户看到了承诺、账本零记录」。绝不静默：落 failure 让管理员看得见缺口。
      const rows = this.sql("SELECT o.id, o.peer, o.effects FROM outbox o JOIN turns t ON t.id=o.turn WHERE o.status='accepted' AND t.state!='done'").all() as { id: string; peer: string; effects: string }[];
      for (const row of rows) {
        const commitments = (parse<Record<string, unknown>>(row.effects).commitments ?? []) as { pending?: boolean; applied?: boolean; id?: string; content?: string }[];
        if (commitments.some(c => c.pending && !c.applied)) this.append(row.peer, 'failure', { delivery: row.id, text: '气泡已被平台接收，但约定效果未落账（思考中断）；需依据当前约定重新确认' });
      }
    });
  }

  draft(turn: Turn, parts: Part[], effects: Record<string, unknown>[], due: number[]): void {
    for (let i = 0; i < parts.length; i++) this.draftOne(turn, i, parts[i]!, effects[i] ?? {}, due[i] ?? this.now());
  }

  /** 单气泡入账。progressive=true 是流式闭合瞬间的捕获（不等思考结束）：承诺带
   *  pending 标记+捕获时快照——未过全量校验的模型原始材料，平台接收时不立即立约，
   *  由思考落账以接收事件为来源回填。false 是全量校验后的正式落账：只挂 expected
   *  版本快照，平台接收即立约（约定已变化则拒绝并落 failure）。 */
  draftOne(turn: Turn, ordinal: number, part: Part, effects: Record<string, unknown>, due: number, progressive = false): string {
    return this.transaction(() => {
      const effect = { ...effects };
      if (effect.commitments) effect.commitments = (effect.commitments as CommitmentInput[]).map(input => {
        const old = input.id ? this.commitment(turn.peer, input.id) : this.commitments(turn.peer).find(c => c.status === 'open' && c.content === input.content && c.kind === input.kind);
        const expected = old ? { id: old.id, version: old.version, status: old.status } : null;
        return progressive ? { ...input, pending: true, expected } : { ...input, expected };
      });
      const id = randomUUID();
      this.sql("INSERT INTO outbox(id,peer,turn,ordinal,part,effects,status,due,created) VALUES(?,?,?,?,?,?,'pending',?,?)").run(id, turn.peer, turn.id, ordinal, JSON.stringify(part), JSON.stringify(effect), due, this.now());
      return id;
    });
  }

  envelopeAt(turn: string, ordinal: number): Envelope | undefined {
    const row = this.sql('SELECT * FROM outbox WHERE turn=? AND ordinal=?').get(turn, ordinal);
    return row ? this.envelope(row) : undefined;
  }

  /** 工具轮回滚：本轮误入队的渐进气泡整批取消（模型还要继续调工具，最终决定尚未出现）。 */
  cancelDrafts(ids: string[]): void {
    if (!ids.length) return;
    const marks = ids.map(() => '?').join(',');
    this.sql(`UPDATE outbox SET status='cancelled',error='思考转向工具调用，最终决定尚未出现' WHERE id IN (${marks}) AND status='pending'`).run(...ids);
  }

  /** 思考落账时回写渐进气泡的正式 effects（承诺从 pending 转正）。只覆盖未终态的行；
   *  已 accepted 的行保留 acceptedEvent 标记，由 runtime.backfillAccepted 以接收事件为来源补立约。 */
  updateDraftEffects(id: string, effects: Record<string, unknown>): void {
    this.sql("UPDATE outbox SET effects=? WHERE id=? AND status IN ('pending','sending')").run(JSON.stringify(effects), id);
  }

  private envelope(row: Record<string, unknown>): Envelope {
    return { id: String(row.id), peer: String(row.peer), turn: String(row.turn), ordinal: Number(row.ordinal), part: parse(row.part), effects: parse(row.effects), status: row.status as Envelope['status'], request: row.request ? parse(row.request) : undefined, dueAt: Number(row.due), attempts: Number(row.attempts), error: row.error ? String(row.error) : undefined, platformId: row.platform_id ? String(row.platform_id) : undefined, createdAt: Number(row.created) };
  }

  deliveries(peer?: string, limit = 100): Envelope[] {
    const rows = peer ? this.sql('SELECT * FROM outbox WHERE peer=? ORDER BY created DESC,ordinal LIMIT ?').all(peer, limit) : this.sql('SELECT * FROM outbox ORDER BY created DESC,ordinal LIMIT ?').all(limit);
    return rows.map(r => this.envelope(r));
  }

  nextEnvelope(peer: string): Envelope | undefined {
    if (this.sql("SELECT id FROM outbox WHERE peer=? AND (status='sending' OR (status='unknown' AND created>?)) LIMIT 1").get(peer, this.now() - 120000)) return undefined;
    const row = this.sql("SELECT * FROM outbox WHERE peer=? AND status='pending' ORDER BY created,ordinal LIMIT 1").get(peer);
    if (!row || Number(row.due) > this.now()) return undefined;
    return this.envelope(row);
  }

  nextDeliveryAt(peer: string): number | undefined {
    if (this.sql("SELECT id FROM outbox WHERE peer=? AND status='sending' LIMIT 1").get(peer)) return undefined;
    const pending = this.sql("SELECT due FROM outbox WHERE peer=? AND status='pending' ORDER BY created,ordinal LIMIT 1").get(peer);
    if (!pending) return undefined;
    const unknown = this.sql("SELECT MAX(created) at FROM outbox WHERE peer=? AND status='unknown'").get(peer);
    return Math.max(Number(pending.due), unknown?.at ? Number(unknown.at) + 120000 : 0);
  }

  startSend(id: string, request: Record<string, unknown> | (() => Record<string, unknown>)): boolean {
    return this.transaction(() => {
      if (!this.sql("SELECT id FROM outbox WHERE id=? AND status='pending'").get(id)) return false;
      const value = typeof request === 'function' ? request() : request;
      return !!this.sql("UPDATE outbox SET status='sending',request=?,attempts=attempts+1 WHERE id=? AND status='pending'").run(JSON.stringify(value), id).changes;
    });
  }

  deferSend(id: string, due: number, error?: string, request?: Record<string, unknown>): void {
    this.sql("UPDATE outbox SET status='pending',due=?,error=?,request=COALESCE(?,request) WHERE id=? AND status IN ('pending','sending')").run(due, error ?? null, request ? JSON.stringify(request) : null, id);
  }

  settleSend(id: string, status: 'accepted' | 'unknown' | 'failed' | 'cancelled', platformId?: string, error?: string, manual = false): boolean {
    return this.transaction(() => {
      const raw = this.sql('SELECT * FROM outbox WHERE id=?').get(id);
      if (!raw || !['pending', 'sending', ...(manual ? ['unknown', 'failed'] : [])].includes(String(raw.status))) return false;
      const envelope = this.envelope(raw);
      this.sql('UPDATE outbox SET status=?,platform_id=?,error=? WHERE id=?').run(status, platformId ?? null, error ?? null, id);
      if (status === 'accepted') {
        const event = this.append(envelope.peer, 'accepted', { ...envelope.part, platformId, delivery: id, note: '平台确认接收，不代表用户已读' }, envelope.turn, `accepted:${id}`)!;
        const p = this.peer(envelope.peer);
        if (p) this.savePeer({ ...p, lastAccepted: this.now() });
        this.settleSelf(envelope.peer, 'delivered');
        const commitments = (envelope.effects.commitments ?? []) as (CommitmentEffect & { pending?: boolean; acceptedEvent?: string })[];
        const hasPending = commitments.some(c => c.pending);
        if (hasPending) {
          // 渐进捕获的承诺未过全量校验：只记平台接收事件并标记，立约由思考落账回填——
          // 否则崩溃窗口里会出现「用户看到了承诺、账本零记录」的诚实缺口。
          for (const effect of commitments) if (effect.pending && !effect.acceptedEvent) effect.acceptedEvent = event.id;
          this.sql('UPDATE outbox SET effects=? WHERE id=?').run(JSON.stringify({ ...envelope.effects, commitments }), id);
        }
        for (const effect of hasPending ? [] : commitments as CommitmentEffect[]) {
          try {
            const { expected, ...input } = effect;
            const current = expected ? this.commitment(envelope.peer, expected.id) : this.commitments(envelope.peer).find(c => c.content === input.content && c.kind === (input.kind ?? 'concern'));
            if (expected === undefined || (expected ? !current || current.version !== expected.version || current.status !== expected.status : !!current)) throw new Error('约定已变化或缺少草稿版本，旧投递不能覆盖当前约定');
            this.changeCommitment(envelope.peer, { ...input, ...(expected ? { id: expected.id } : {}), sources: [...new Set([...input.sources, event.id])] });
          } catch (error) {
            this.append(envelope.peer, 'failure', { delivery: id, commitment: effect.id ?? effect.content, text: '消息已接收，但约定效果未应用；需依据当前约定重新确认', error: errorText(error) }, envelope.turn);
          }
        }
        const notifications = envelope.effects.notified as { id: string; version: number; due: number }[] | undefined;
        for (const n of notifications ?? []) {
          const c = this.commitment(envelope.peer, n.id);
          if (c?.status === 'open' && c.version === n.version && c.dueAt === n.due) this.writeCommitment({ ...c, notifiedDue: n.due });
        }
      }
      return true;
    });
  }

  resolveSend(id: string, accepted: boolean): boolean {
    const row = this.sql('SELECT status FROM outbox WHERE id=?').get(id);
    if (!row || !['unknown', 'failed'].includes(String(row.status))) return false;
    return this.settleSend(id, accepted ? 'accepted' : 'cancelled', undefined, '管理员确认', true);
  }

  // ---------- 记忆（六变量） ----------

  memories(peer: string): Memory[] {
    return this.sql("SELECT value FROM memories WHERE status='active' AND peer=? ORDER BY id").all(peer).map(r => parse<Memory>(r.value));
  }

  saveMemory(peer: string, input: MemoryInput): Memory {
    const now = this.now();
    const existing = this.memories(peer);
    const same = existing.find(m => m.content === input.content && m.kind === input.kind);
    if (same) {
      const refreshed: Memory = { ...same, ...rehearseMemory(same, now), sources: [...new Set([...same.sources, ...input.sources])] };
      this.writeMemory(refreshed);
      return refreshed;
    }
    const value: Memory = {
      id: randomUUID(), peer, kind: input.kind, content: input.content, gist: input.gist, slot: input.slot ?? '',
      sources: [...new Set(input.sources)], importance: input.importance ?? 0.5, emotion: input.emotion ?? 0,
      detail: 1, consolidation: 0, interference: 0, status: 'active', createdAt: now, evaluatedAt: now, lastRehearsedAt: 0,
    } satisfies Memory;
    const replace = new Set(input.supersedes ?? []);
    if (value.slot) for (const m of existing) if (m.slot === value.slot) replace.add(m.id);
    for (const id of replace) {
      const old = existing.find(m => m.id === id);
      if (!old) throw new TypeError('替代记忆不属于可修改范围');
      this.sql("UPDATE memories SET status='superseded',value=? WHERE id=?").run(JSON.stringify({ ...old, status: 'superseded' }), id);
    }
    this.writeMemory(value);
    return value;
  }

  private writeMemory(m: Memory): void {
    this.sql('INSERT INTO memories(id,peer,slot,status,value) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(m.id, m.peer, m.slot, m.status, JSON.stringify(m));
    this.sql('DELETE FROM memory_search WHERE id=?').run(m.id);
    this.sql('INSERT INTO memory_search(id,peer,terms) VALUES(?,?,?)').run(m.id, m.peer, grams(m.content).join(' '));
  }

  searchMemories(peer: string, query: string, limit = 8): Memory[] {
    const terms = grams(query).slice(0, 40);
    if (!terms.length) return [];
    return this.sql("SELECT m.value FROM memory_search f JOIN memories m ON m.id=f.id WHERE memory_search MATCH ? AND f.peer=? AND m.status='active' ORDER BY rank LIMIT ?").all(terms.map(t => `"${t}"`).join(' OR '), peer, limit).map(r => parse<Memory>(r.value));
  }

  rehearsed(ids: string[]): void {
    const now = this.now();
    for (const id of new Set(ids)) {
      const row = this.sql("SELECT value FROM memories WHERE id=? AND status='active'").get(id);
      if (!row) continue;
      const m = parse<Memory>(row.value);
      if (m.kind === 'identity') continue;
      if (now - m.lastRehearsedAt > 180 * 60000) this.writeMemory({ ...m, ...rehearseMemory(m, now) });
    }
  }

  vector(id: string, model: string, content: string): Float32Array | undefined {
    const row = this.sql('SELECT value FROM vectors WHERE id=? AND model=? AND hash=?').get(id, model, hash(content));
    if (!row) return undefined;
    const bytes = row.value as Uint8Array;
    const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return Float32Array.from({ length: bytes.byteLength / 4 }, (_, i) => data.getFloat32(i * 4, true));
  }
  saveVector(id: string, model: string, content: string, vec: Float32Array): void {
    const bytes = new Uint8Array(vec.length * 4), view = new DataView(bytes.buffer);
    vec.forEach((v, i) => view.setFloat32(i * 4, v, true));
    this.sql('INSERT INTO vectors(id,model,hash,value) VALUES(?,?,?,?) ON CONFLICT(id,model) DO UPDATE SET hash=excluded.hash,value=excluded.value').run(id, model, hash(content), bytes);
  }

  // ---------- 念头 ----------

  thoughts(peer: string): ThoughtEntry[] {
    return this.sql('SELECT value FROM thoughts WHERE peer=?').all(peer).map(r => parse<ThoughtEntry>(r.value)).sort((a, b) => a.updatedAt - b.updatedAt);
  }

  changeThought(peer: string, op: ThoughtOp): ThoughtEntry | undefined {
    return this.transaction(() => {
      const now = this.now();
      if (op.op === 'drop') {
        const target = op.id ? this.thoughts(peer).find(t => t.id === op.id) : this.thoughts(peer).find(t => op.topic !== undefined && t.topic === op.topic);
        if (!target) return undefined;
        const dropped: ThoughtEntry = { ...target, state: 'dropped', updatedAt: now };
        this.writeThought(dropped);
        return dropped;
      }
      const topic = op.topic ?? '', meaning = op.meaning ?? '';
      if (!topic || !meaning) throw new TypeError('念头需要主题与含义');
      const sources = [...new Set(op.sources)].sort();
      if (!sources.length) throw new TypeError('念头缺少真实依据');
      const evidence = hash(sources);
      const due = op.due === undefined ? undefined : instant(op.due);
      const previous = this.thoughts(peer).find(t => t.topic === topic);
      if (previous && previous.evidence === evidence) return previous;
      const entry: ThoughtEntry = {
        id: previous?.id ?? randomUUID(), peer, topic, meaning, sources, evidence,
        ...(due !== undefined ? { dueAt: due } : previous?.dueAt ? { dueAt: previous.dueAt } : {}),
        state: 'idle', createdAt: previous?.createdAt ?? now, updatedAt: now,
      };
      this.writeThought(entry);
      return entry;
    });
  }

  private writeThought(t: ThoughtEntry): void {
    this.sql('INSERT INTO thoughts(id,peer,topic,value) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(t.id, t.peer, t.topic, JSON.stringify(t));
  }

  // ---------- 约定 ----------

  commitments(peer: string): Commitment[] { return this.sql('SELECT value FROM commitments WHERE peer=?').all(peer).map(r => parse<Commitment>(r.value)); }
  commitment(peer: string, id: string): Commitment | undefined { return this.commitments(peer).find(c => c.id === id); }
  private writeCommitment(c: Commitment): void { this.sql('INSERT INTO commitments(id,peer,value) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(c.id, c.peer, JSON.stringify(c)); }

  changeCommitment(peer: string, input: CommitmentInput): Commitment {
    return this.transaction(() => {
      const old = input.id ? this.commitment(peer, input.id) : this.commitments(peer).find(c => c.status === 'open' && c.content === input.content && c.kind === input.kind);
      if (input.id && !old || input.op !== 'keep' && !old) throw new TypeError('约定不存在');
      if (input.op === 'keep') {
        const dueAt = input.due === undefined ? old?.dueAt ?? 0 : instant(input.due);
        const recurrence = input.recurrence === null ? undefined : input.recurrence ?? old?.recurrence;
        if (recurrence && !dueAt) throw new TypeError('周期约定需要起始时间');
        const changed = !!old && (old.status !== 'open' || dueAt !== old.dueAt || input.content !== undefined && input.content !== old.content || input.kind !== undefined && input.kind !== old.kind || JSON.stringify(recurrence) !== JSON.stringify(old.recurrence));
        const c: Commitment = { id: old?.id ?? randomUUID(), peer, kind: input.kind ?? old?.kind ?? 'concern', content: input.content ?? old?.content ?? '', sources: [...new Set([...(old?.sources ?? []), ...input.sources])], dueAt, recurrence, status: 'open', version: old ? old.version + Number(changed) : 1, notifiedDue: changed ? 0 : old?.notifiedDue ?? 0, createdAt: old?.createdAt ?? this.now() };
        if (!c.content) throw new TypeError('约定内容不能为空');
        if (changed) this.sql("UPDATE jobs SET state='cancelled' WHERE id=? AND state='pending'").run(`commitment:${old!.id}:${old!.version}`);
        if (!old || changed) this.set(`anchor:${c.id}`, dueAt);
        this.writeCommitment(c);
        if (dueAt > 0) this.schedule(`commitment:${c.id}:${c.version}`, peer, 'commitment', c.content, dueAt, { id: c.id, version: c.version, due: dueAt });
        return c;
      }
      if (old!.status !== 'open') return old!;
      this.sql("UPDATE jobs SET state='cancelled' WHERE id=? AND state='pending'").run(`commitment:${old!.id}:${old!.version}`);
      let c: Commitment = { ...old!, sources: [...new Set([...old!.sources, ...input.sources])], status: input.op === 'complete' ? 'completed' : 'cancelled' };
      if (input.op === 'complete' && old!.recurrence) {
        const anchor = this.get(`anchor:${old!.id}`, old!.dueAt);
        c = { ...c, status: 'open', dueAt: nextOccurrence(anchor, old!.recurrence, Math.max(this.now(), old!.dueAt)), notifiedDue: 0, version: old!.version + 1 };
        this.schedule(`commitment:${c.id}:${c.version}`, peer, 'commitment', c.content, c.dueAt, { id: c.id, version: c.version, due: c.dueAt });
      }
      this.writeCommitment(c);
      return c;
    });
  }

  markDue(job: Job): Event | undefined {
    const c = this.commitment(job.peer, String(job.data.id));
    if (!c || c.status !== 'open' || c.version !== job.data.version || c.dueAt !== job.data.due) return undefined;
    return this.append(job.peer, 'due', { commitment: c.id, content: c.content, dueAt: c.dueAt }, undefined, `due:${c.id}:${c.version}`);
  }

  // ---------- 她的状态（每会话一份自我、情绪、印象） ----------

  self(peer: string): Self {
    const stored = this.get<Self | undefined>(`self:${peer}`, undefined);
    return stored ? projectSelf(stored, this.now()) : initialSelf(this.now());
  }

  settleSelf(peer: string, event: 'received' | 'delivered'): void {
    const next = evolveSelf(this.self(peer), { kind: event, at: this.now() });
    next.updatedAt = this.now();
    this.set(`self:${peer}`, next);
  }

  /** 黏人度与身体的每日演化：以昨天的相处为材料，同一天幂等。 */
  dailySelf(peer: string, timezone: string): Self {
    return this.transaction(() => {
      const current = this.self(peer);
      const now = this.now();
      const day = dayKey(now - 86400000, timezone);
      if (current.closenessDay === day) return current;
      const from = dayStart(now - 86400000, timezone);
      const events = this.eventsBetween(peer, ['received', 'accepted'], from, from + 86400000, 500);
      const next = evolveCloseness(current, events.map(e => ({ kind: e.kind, at: e.at })), day);
      next.updatedAt = now;
      this.set(`self:${peer}`, next);
      return next;
    });
  }

  saveSelfPatch(peer: string, patch: { activity?: string; pursuit?: string; interests?: string[] }): void {
    const now = this.now();
    let next = this.self(peer);
    if (patch.activity !== undefined) next = evolveSelf(next, { kind: 'activity', value: patch.activity, at: now });
    if (patch.pursuit !== undefined) next = evolveSelf(next, { kind: 'pursuit', value: patch.pursuit, at: now });
    if (patch.interests !== undefined) next = { ...next, interests: patch.interests };
    next.updatedAt = now;
    this.set(`self:${peer}`, next);
  }

  feeling(peer: string): Feeling | undefined { return this.get<Feeling | undefined>(`feeling:${peer}`, undefined); }

  setFeeling(peer: string, feeling: Feeling): void {
    this.set(`feeling:${peer}`, feeling);
    const trail = this.get<Feeling[]>(`moodlog:${peer}`, []);
    trail.push(feeling);
    this.set(`moodlog:${peer}`, trail.slice(-8));
  }

  impressions(peer: string): Impressions | undefined { return this.get<Impressions | undefined>(`impressions:${peer}`, undefined); }
  saveImpressions(peer: string, value: Impressions): void { this.set(`impressions:${peer}`, value); }

  segments(peer: string): Segment[] { return this.sql('SELECT * FROM segments WHERE peer=? ORDER BY last_seq').all(peer).map(r => ({ id: String(r.id), peer, from: Number(r.first_seq), to: Number(r.last_seq), text: String(r.text), at: Number(r.at) })); }
  saveSegment(peer: string, from: number, to: number, text: string): Segment {
    this.sql('INSERT OR IGNORE INTO segments(id,peer,first_seq,last_seq,text,at) VALUES(?,?,?,?,?,?)').run(randomUUID(), peer, from, to, text, this.now());
    return this.segments(peer).find(s => s.from === from && s.to === to)!;
  }
  mergeSegments(peer: string, ids: string[], text: string): Segment {
    return this.transaction(() => {
      const old = this.segments(peer).filter(s => ids.includes(s.id));
      if (old.length !== ids.length || old.length < 2) throw new TypeError('摘要段不存在');
      old.forEach(s => this.sql('DELETE FROM segments WHERE id=?').run(s.id));
      return this.saveSegment(peer, old[0]!.from, old.at(-1)!.to, text);
    });
  }

  recordUsage(data: { purpose: string; model: string; endpoint: string; status: string; input?: number; output?: number; cached?: number; cacheWrite?: number; cost?: number; latency: number; error?: string }): void {
    this.sql('INSERT INTO usage(at,purpose,model,endpoint,status,input,output,cached,cache_write,cost,latency,error) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(this.now(), data.purpose, data.model, data.endpoint, data.status, data.input ?? null, data.output ?? null, data.cached ?? null, data.cacheWrite ?? null, data.cost ?? null, data.latency, data.error ?? null);
  }

  usage(since: number): Record<string, unknown> {
    const totals = this.sql('SELECT COUNT(*) calls,COALESCE(SUM(input),0) input,COALESCE(SUM(output),0) output,COALESCE(SUM(cached),0) cached,COALESCE(SUM(cache_write),0) cacheWrite,SUM(cost) cost,COALESCE(SUM(CASE WHEN input IS NULL THEN 1 ELSE 0 END),0) unknownUsage,COALESCE(SUM(CASE WHEN cost IS NULL THEN 1 ELSE 0 END),0) unknownCost FROM usage WHERE at>=?').get(since)!;
    const rows = this.sql('SELECT * FROM usage WHERE at>=? ORDER BY id DESC LIMIT 100').all(since);
    return { ...totals, rows };
  }

  toolStart(id: string, peer: string, turn: string, signature: string): { status: string; result?: unknown } | undefined {
    const existing = this.sql('SELECT status,result FROM tool_runs WHERE id=?').get(id);
    if (existing) return { status: String(existing.status), result: existing.result ? parse(existing.result) : undefined };
    this.sql("INSERT INTO tool_runs(id,peer,turn,signature,status,at) VALUES(?,?,?,?,'running',?)").run(id, peer, turn, signature, this.now());
    return undefined;
  }
  toolFinish(id: string, status: string, result: unknown): void { this.sql('UPDATE tool_runs SET status=?,result=? WHERE id=?').run(status, JSON.stringify(result), id); }

  cachedMedia(key: string): Record<string, unknown> | undefined {
    const r = this.sql('SELECT info FROM media_cache WHERE key=? AND (expires=0 OR expires>?)').get(key, this.now() + 10000);
    return r ? parse(r.info) : undefined;
  }
  cacheMedia(key: string, info: Record<string, unknown>, ttl: number): void { this.sql('INSERT INTO media_cache(key,info,expires) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET info=excluded.info,expires=excluded.expires').run(key, JSON.stringify(info), ttl === 0 ? 0 : this.now() + ttl * 1000); }
  forgetMedia(key: string): void { this.sql('DELETE FROM media_cache WHERE key=?').run(key); }

  post(peer: string, author: string, text: string, path?: string): string {
    const id = randomUUID();
    this.sql('INSERT INTO wall(id,peer,author,text,path,at) VALUES(?,?,?,?,?,?)').run(id, peer, author, text, path ?? null, this.now());
    return id;
  }
  wall(peer?: string, limit = 50): Record<string, unknown>[] { return peer ? this.sql('SELECT * FROM wall WHERE peer=? ORDER BY at DESC LIMIT ?').all(peer, limit) : this.sql('SELECT * FROM wall ORDER BY at DESC LIMIT ?').all(limit); }

  /** 计量与缓存不是经历：usage/tool_runs/media_cache 到期即清；终态 jobs 与 reply-seq 计数同理；账本本体（events/outbox/memories）永不修剪。 */
  prune(now = this.now()): void {
    this.transaction(() => {
      this.sql('DELETE FROM usage WHERE at<?').run(now - 90 * 86400000);
      this.sql('DELETE FROM tool_runs WHERE at<?').run(now - 7 * 86400000);
      this.sql('DELETE FROM media_cache WHERE expires>0 AND expires<?').run(now);
      // done/cancelled 的任务行没有时间列，靠 id 里的日期（night）或父账本推断太脆：保守只清终态且过期的，pending/running 永不动。
      // jobs 表没有 at 列——用 turns 的完成时间不行（job 可独立失败）；
      // 干脆给终态行按 id 前缀判断：chat/beat/intent 行在重新调度时会被 replace 或自愈，残留的终态行 30 天后已无引用价值。
      // 由于无时间列，改为定期全表收缩：终态行超过 400 条时删最旧的（id 排序 ≈ 时间序，SQLite rowid 递增）。
      const stale = Number(this.sql("SELECT COUNT(*) n FROM jobs WHERE state IN ('done','cancelled')").get()!.n);
      if (stale > 400) this.sql("DELETE FROM jobs WHERE rowid IN (SELECT rowid FROM jobs WHERE state IN ('done','cancelled') ORDER BY rowid LIMIT ?)").run(Math.max(0, stale - 200));
      // kv 里带时间戳的计量键自清（被动回复计数/搜索缓存）；无时间戳的旧数字键保守跳过。
      for (const row of this.sql("SELECT key,value FROM kv WHERE key LIKE 'reply-seq:%' OR key LIKE 'search:%'").all() as { key: string; value: string }[]) {
        const value = parse<{ at?: number } | number>(row.value);
        const at = typeof value === 'object' && value ? Number(value.at ?? 0) : 0;
        if (at > 0 && at < now - 86400000) this.sql('DELETE FROM kv WHERE key=?').run(row.key);
      }
    });
  }

  close(): void { this.statements.clear(); this.db.close(); }
}
