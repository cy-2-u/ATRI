import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createSchema } from '../src/storage/journal.js';

/** 旧版（v5.x atri.db，schema v14）→ 新内核（kernel_* 表）的一次性迁移。
 *
 *  保真映射：消息 ID、记忆 ID 与六变量、约定、念头、心情、微信会话凭据
 *  全部原样迁移；旧向量直接复制（记忆 ID 对齐，事件向量由滴灌重建）。
 *  老库原文件不动——迁移写进新的库文件，验收后再切换。 */

export interface MigrationSummary {
  peers: number;
  events: number;
  memories: number;
  commitments: number;
  thoughts: number;
  vectors: number;
}

const parse = <T>(value: unknown, fallback: T): T => {
  try {
    return JSON.parse(String(value)) as T;
  } catch {
    return fallback;
  }
};

export function migrate(oldPath: string, newPath: string): MigrationSummary {
  const old = new DatabaseSync(oldPath);
  const fresh = new DatabaseSync(newPath);
  createSchema(fresh);
  fresh.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  const summary: MigrationSummary = {
    peers: 0,
    events: 0,
    memories: 0,
    commitments: 0,
    thoughts: 0,
    vectors: 0,
  };
  fresh.exec('BEGIN IMMEDIATE');
  try {
    const peers = old
      .prepare(`SELECT id, address, context_token, approved FROM peers WHERE channel='wechat'`)
      .all() as unknown as {
      id: string;
      address: string;
      context_token: string;
      approved: number;
    }[];
    for (const peer of peers) {
      fresh.prepare('INSERT OR IGNORE INTO kernel_peers(id,version) VALUES(?,?)').run(peer.id, 0);
      fresh
        .prepare('INSERT OR REPLACE INTO kernel_settings(key,value) VALUES(?,?)')
        .run(`wechat:context:${peer.id}`, JSON.stringify(peer.context_token));
    }
    summary.peers = peers.length;
    const peerIds = peers.map((p) => p.id);
    if (!peerIds.length) {
      fresh.exec('COMMIT');
      return summary;
    }

    // --- 事件：消息 → received/said；日记段 → diary；流水 → experienced ---
    for (const peer of peerIds) {
      const messages = old
        .prepare(
          `SELECT id, role, content, media, event_key, created_at FROM messages WHERE peer_id=? ORDER BY seq`,
        )
        .all(peer) as unknown as {
        id: string;
        role: string;
        content: string;
        media: string;
        event_key: string | null;
        created_at: number;
      }[];
      for (const m of messages) {
        if (m.role === 'system') continue;
        const kind = m.role === 'user' ? 'received' : 'said';
        let content = m.content;
        if (kind === 'received') {
          const media = parse<{ path?: string; mime?: string }[]>(m.media, []).filter(
            (item) => item.path && item.mime?.startsWith('image/'),
          );
          if (media.length) content = JSON.stringify({ text: m.content, media });
        }
        fresh
          .prepare(
            `INSERT OR IGNORE INTO kernel_events(id,peer,turn_id,kind,content,event_key,created_at) VALUES(?,?,NULL,?,?,?,?)`,
          )
          .run(
            m.id,
            peer,
            kind,
            content,
            kind === 'received' ? (m.event_key ?? `migrated:${m.id}`) : null,
            m.created_at,
          );
        summary.events++;
      }
      const diary = old
        .prepare(
          `SELECT id, content, emotion, created_at FROM diary_sections WHERE peer_id=? AND status='active' ORDER BY created_at`,
        )
        .all(peer) as unknown as {
        id: string;
        content: string;
        emotion: number;
        created_at: number;
      }[];
      for (const d of diary) {
        fresh
          .prepare(
            `INSERT OR IGNORE INTO kernel_events(id,peer,turn_id,kind,content,event_key,created_at) VALUES(?,?,NULL,'diary',?,NULL,?)`,
          )
          .run(
            d.id,
            peer,
            JSON.stringify({ content: d.content, emotion: d.emotion }),
            d.created_at,
          );
        summary.events++;
      }
      const life = old
        .prepare(`SELECT at, kind, text FROM life_log ORDER BY at`)
        .all() as unknown as { at: number; kind: string; text: string }[];
      for (const entry of life) {
        fresh
          .prepare(
            `INSERT OR IGNORE INTO kernel_events(id,peer,turn_id,kind,content,event_key,created_at) VALUES(?,?,NULL,'experienced',?,'life:'||?,?)`,
          )
          .run(
            `life-${entry.at}-${createHash('sha1').update(entry.text).digest('hex').slice(0, 8)}`,
            peer,
            JSON.stringify({ tool: 'life', result: { summary: `[${entry.kind}] ${entry.text}` } }),
            entry.at,
            entry.at,
          );
        summary.events++;
      }
    }

    // --- 记忆：六变量按老数学投影到当前强度 ---
    const now = Date.now();
    for (const peer of peerIds) {
      const rows = old
        .prepare(
          `SELECT id, content, kind, sources, status, pinned, invalid_at, importance, emotion, consolidation, interference, created_at, last_hit_at FROM memories WHERE peer_id=?`,
        )
        .all(peer) as unknown as {
        id: string;
        content: string;
        kind: string;
        sources: string;
        status: string;
        pinned: number;
        invalid_at: number;
        importance: number;
        emotion: number;
        consolidation: number;
        interference: number;
        created_at: number;
        last_hit_at: number;
      }[];
      for (const r of rows) {
        // λ = 0.12·(1−0.55|E|)(1−0.65C)(1+0.9I)，自 last_hit 衰减（老记忆模型）。
        const days =
          Math.max(0, now - (r.last_hit_at > 0 ? r.last_hit_at : r.created_at)) / 86400000;
        const rate =
          0.12 *
          (1 - 0.55 * Math.abs(r.emotion)) *
          (1 - 0.65 * Math.max(0, r.consolidation)) *
          (1 + 0.9 * Math.max(0, r.interference));
        const detail = Math.exp(-Math.max(0.005, rate) * days);
        const status =
          r.invalid_at > 0 ? 'forgotten' : r.status === 'active' ? 'active' : 'superseded';
        const value = {
          id: r.id,
          content: r.content,
          gist: r.content.slice(0, 80),
          kind: r.kind === 'interpretation' ? 'interpretation' : 'stated',
          sources: parse<string[]>(r.sources, []),
          status,
          pinned: r.pinned === 1,
          detail,
          importance: r.importance,
          emotion: r.emotion,
          consolidation: r.consolidation,
          interference: r.interference,
          createdAt: r.created_at,
          evaluatedAt: now,
          lastRehearsedAt: r.last_hit_at,
        };
        fresh
          .prepare('INSERT OR IGNORE INTO kernel_memories(id,peer,status,value) VALUES(?,?,?,?)')
          .run(r.id, peer, status, JSON.stringify(value));
        summary.memories++;
      }
    }

    // --- 约定：开环（reminder）+ 挂念（concern/promise）---
    for (const peer of peerIds) {
      const loops = old
        .prepare(
          `SELECT id, content, due_at, sources, recurring, asked, status, created_at FROM open_loops WHERE peer_id=?`,
        )
        .all(peer) as unknown as {
        id: string;
        content: string;
        due_at: number;
        sources: string;
        recurring: string;
        asked: number;
        status: string;
        created_at: number;
      }[];
      for (const l of loops) {
        if (l.status !== 'open') continue;
        const value = {
          id: l.id,
          content: l.content,
          kind: 'reminder' as const,
          sources: parse<string[]>(l.sources, []),
          dueAt: l.due_at,
          recurring: l.recurring === 'yearly' ? ('yearly' as const) : ('none' as const),
          state: 'open' as const,
          askedAt: l.asked === 1 ? l.created_at : 0,
          createdAt: l.created_at,
        };
        fresh
          .prepare('INSERT OR IGNORE INTO kernel_commitments(id,peer,value) VALUES(?,?,?)')
          .run(l.id, peer, JSON.stringify(value));
        summary.commitments++;
      }
      const threads = old
        .prepare(
          `SELECT id, content, kind, sources, status, created_at FROM soft_threads WHERE peer_id=?`,
        )
        .all(peer) as unknown as {
        id: string;
        content: string;
        kind: string;
        sources: string;
        status: string;
        created_at: number;
      }[];
      for (const t of threads) {
        if (t.status !== 'open') continue;
        const value = {
          id: t.id,
          content: t.content,
          kind: t.kind === 'promise' ? ('promise' as const) : ('concern' as const),
          sources: parse<string[]>(t.sources, []),
          dueAt: 0,
          recurring: 'none' as const,
          state: 'open' as const,
          askedAt: 0,
          createdAt: t.created_at,
        };
        fresh
          .prepare('INSERT OR IGNORE INTO kernel_commitments(id,peer,value) VALUES(?,?,?)')
          .run(t.id, peer, JSON.stringify(value));
        summary.commitments++;
      }
    }

    // --- 念头：想法池仍在场的（idle/waiting）→ idle ---
    for (const peer of peerIds) {
      const rows = old
        .prepare(
          `SELECT id, topic_key, meaning, sources, state, created_at, updated_at FROM initiatives WHERE peer_id=?`,
        )
        .all(peer) as unknown as {
        id: string;
        topic_key: string;
        meaning: string;
        sources: string;
        state: string;
        created_at: number;
        updated_at: number;
      }[];
      for (const r of rows) {
        if (r.state === 'expressed' || r.state === 'dropped') continue;
        const sources = [...new Set(parse<string[]>(r.sources, []))].sort();
        const value = {
          id: r.id,
          topic: r.topic_key,
          meaning: r.meaning,
          sources,
          evidence: createHash('sha256').update(JSON.stringify(sources)).digest('hex'),
          state: 'idle' as const,
          createdAt: r.created_at,
          updatedAt: r.updated_at,
        };
        fresh
          .prepare('INSERT OR IGNORE INTO kernel_thoughts(id,peer,topic,value) VALUES(?,?,?,?)')
          .run(r.id, peer, r.topic_key, JSON.stringify(value));
        summary.thoughts++;
      }
    }

    // --- 她的当下与心情 ---
    const self = old
      .prepare(
        `SELECT activity, activity_since, pursuit, pursuit_since, social, express, last_stimulus_at FROM self WHERE id=1`,
      )
      .get() as unknown as
      | {
          activity: string;
          activity_since: number;
          pursuit: string;
          pursuit_since: number;
          social: number;
          express: number;
          last_stimulus_at: number;
        }
      | undefined;
    if (self) {
      const peer = peerIds[0]!;
      const lastReceived = Number(
        fresh
          .prepare(
            `SELECT max(created_at) AS at FROM kernel_events WHERE peer=? AND kind='received'`,
          )
          .get(peer)?.at ?? 0,
      );
      const lastDelivered = Number(
        fresh
          .prepare(`SELECT max(created_at) AS at FROM kernel_events WHERE peer=? AND kind='said'`)
          .get(peer)?.at ?? 0,
      );
      const value = {
        social: Math.max(0, Math.min(1, self.social)),
        expression: Math.max(0, Math.min(1, self.express)),
        integratedAt: now,
        stimulatedAt: self.last_stimulus_at || now,
        lastReceivedAt: lastReceived,
        lastDeliveredAt: lastDelivered,
        activity: self.activity,
        activitySince: self.activity_since || now,
        pursuit: self.pursuit,
        pursuitSince: self.pursuit_since || now,
      };
      fresh
        .prepare('INSERT OR REPLACE INTO kernel_settings(key,value) VALUES(?,?)')
        .run('self', JSON.stringify(value));
      const mood = old.prepare(`SELECT value FROM settings WHERE key='mood'`).get();
      if (mood)
        fresh
          .prepare('INSERT OR REPLACE INTO kernel_settings(key,value) VALUES(?,?)')
          .run(`mood:${peer}`, String(mood.value));
    }

    // --- 微信会话与表情设置（免重新扫码）---
    for (const key of [
      'wechat:session',
      'wechat:account',
      'stickers:custom',
      'stickers:disabled',
    ]) {
      const row = old.prepare(`SELECT value FROM settings WHERE key=?`).get(key);
      if (row)
        fresh
          .prepare('INSERT OR REPLACE INTO kernel_settings(key,value) VALUES(?,?)')
          .run(key, String((row as { value: unknown }).value));
    }
    const contactsRow = old
      .prepare(`SELECT key, value FROM settings WHERE key LIKE 'wechat:contacts%'`)
      .all() as unknown as { key: string; value: string }[];
    for (const row of contactsRow)
      fresh
        .prepare('INSERT OR REPLACE INTO kernel_settings(key,value) VALUES(?,?)')
        .run(row.key, row.value);

    // --- 旧向量：记忆向量 ID 对齐直接复制；事件向量交给滴灌重建 ---
    const knownIds = new Set(
      (
        fresh
          .prepare(`SELECT id FROM kernel_memories UNION SELECT id FROM kernel_events`)
          .all() as unknown as { id: string }[]
      ).map((row) => row.id),
    );
    const embeddings = old
      .prepare(`SELECT id, model, vector FROM memory_embeddings`)
      .all() as unknown as { id: string; model: string; vector: Buffer }[];
    for (const e of embeddings) {
      if (!knownIds.has(e.id)) continue;
      fresh
        .prepare('INSERT OR REPLACE INTO kernel_embeddings(id,model,vector,at) VALUES(?,?,?,?)')
        .run(e.id, e.model, e.vector, now);
      summary.vectors++;
    }

    fresh.exec('COMMIT');
    return summary;
  } catch (error) {
    fresh.exec('ROLLBACK');
    throw error;
  } finally {
    old.close();
    fresh.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [oldPath, newPath] = process.argv.slice(2);
  if (!oldPath || !newPath) {
    console.error('用法：node migrate.mjs <旧 atri.db> <新内核.db>');
    process.exit(1);
  }
  console.log(`迁移完成：`, migrate(oldPath, newPath));
}
