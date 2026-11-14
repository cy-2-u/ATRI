import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../scripts/migrate.js';
import { Journal } from '../src/storage/journal.js';

/** 迁移保真：老 schema v14 的最小真实样本 → 新内核，全部 ID 对齐。 */

export function buildOldDb(path: string): void {
  const sql = new DatabaseSync(path);
  sql.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE peers (id TEXT PRIMARY KEY, channel TEXT, address TEXT, context_token TEXT, approved INTEGER, created_at INTEGER);
    CREATE TABLE messages (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE, peer_id TEXT, event_key TEXT, role TEXT, content TEXT, media TEXT DEFAULT '[]', status TEXT, created_at INTEGER);
    CREATE TABLE memories (id TEXT PRIMARY KEY, peer_id TEXT, content TEXT, kind TEXT, sources TEXT, status TEXT, hits INTEGER, last_hit_at INTEGER, pinned INTEGER, invalid_at INTEGER, importance REAL, emotion REAL, emotion_reason TEXT, consolidation REAL, interference REAL, created_at INTEGER);
    CREATE TABLE open_loops (id TEXT PRIMARY KEY, peer_id TEXT, content TEXT, due_at INTEGER, due_text TEXT, sources TEXT, recurring TEXT, asked INTEGER, status TEXT, created_at INTEGER, resolved_at INTEGER);
    CREATE TABLE soft_threads (id TEXT PRIMARY KEY, peer_id TEXT, content TEXT, kind TEXT, sources TEXT, revisit_after INTEGER, asked INTEGER, status TEXT, created_at INTEGER, resolved_at INTEGER);
    CREATE TABLE initiatives (id TEXT PRIMARY KEY, peer_id TEXT, topic_key TEXT, kind TEXT, meaning TEXT, sources TEXT, state TEXT, created_at INTEGER, updated_at INTEGER);
    CREATE TABLE self (id INTEGER PRIMARY KEY CHECK(id=1), activity TEXT, activity_since INTEGER, pursuit TEXT, pursuit_since INTEGER, social REAL, express REAL, last_stimulus_at INTEGER, updated_at INTEGER);
    CREATE TABLE diary_sections (id TEXT PRIMARY KEY, peer_id TEXT, task_id TEXT, ordinal INTEGER, day TEXT, content TEXT, sources TEXT, status TEXT, emotion REAL, created_at INTEGER);
    CREATE TABLE life_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER, kind TEXT, text TEXT, artifact TEXT);
    CREATE TABLE memory_embeddings (id TEXT PRIMARY KEY, peer_id TEXT, kind TEXT, vector BLOB, dims INTEGER, model TEXT, created_at INTEGER);
  `);
  const peer = 'wechat:acc:alice';
  sql
    .prepare(`INSERT INTO peers VALUES(?,?,?,?,?,?)`)
    .run(peer, 'wechat', 'alice', 'ctx-token', 1, Date.now() - 90 * 86400000);
  const insertMessage = sql.prepare(
    `INSERT INTO messages (id, peer_id, event_key, role, content, media, status, created_at) VALUES(?,?,?,?,?,?,?,?)`,
  );
  insertMessage.run(
    'msg-1',
    peer,
    'k1',
    'user',
    '我不吃香菜',
    '[]',
    'received',
    Date.now() - 80 * 86400000,
  );
  insertMessage.run(
    'msg-2',
    peer,
    null,
    'assistant',
    '记住啦',
    '[]',
    'sent',
    Date.now() - 80 * 86400000 + 5000,
  );
  sql
    .prepare(
      `INSERT INTO memories (id, peer_id, content, kind, sources, status, hits, last_hit_at, pinned, invalid_at, importance, emotion, emotion_reason, consolidation, interference, created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      'mem-1',
      peer,
      '他不吃香菜',
      'stated',
      JSON.stringify(['msg-1']),
      'active',
      2,
      Date.now() - 10 * 86400000,
      0,
      0,
      0.8,
      -0.2,
      '在意的细节',
      0.3,
      0,
      Date.now() - 80 * 86400000,
    );
  sql
    .prepare(
      `INSERT INTO open_loops (id, peer_id, content, due_at, due_text, sources, recurring, asked, status, created_at, resolved_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      'loop-1',
      peer,
      '明天 08:00 叫他',
      Date.now() + 3600_000,
      '明天 08:00',
      JSON.stringify(['msg-1']),
      '',
      0,
      'open',
      Date.now() - 86400000,
      0,
    );
  sql
    .prepare(
      `INSERT INTO soft_threads (id, peer_id, content, kind, sources, revisit_after, asked, status, created_at, resolved_at) VALUES(?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      'thread-1',
      peer,
      '答应讲那个故事',
      'promise',
      JSON.stringify(['msg-1']),
      2,
      0,
      'open',
      Date.now() - 2 * 86400000,
      0,
    );
  sql
    .prepare(
      `INSERT INTO initiatives (id, peer_id, topic_key, kind, meaning, sources, state, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      'init-1',
      peer,
      '赶版本',
      'care',
      '问赶版本顺不顺利',
      JSON.stringify(['msg-1']),
      'idle',
      Date.now() - 86400000,
      Date.now() - 86400000,
    );
  sql
    .prepare(
      `INSERT INTO self (id, activity, activity_since, pursuit, pursuit_since, social, express, last_stimulus_at, updated_at) VALUES(1,'复读水母',?, '深海发光生物',?, 0.9, 0.2, ?, ?)`,
    )
    .run(Date.now() - 3600_000, Date.now() - 7200_000, Date.now() - 1800_000, Date.now() - 60000);
  sql
    .prepare(
      `INSERT INTO diary_sections (id, peer_id, task_id, ordinal, day, content, sources, status, emotion, created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      'd-1',
      peer,
      'task-1',
      0,
      '2026-11-01',
      '今天他夸了我的图。',
      JSON.stringify(['msg-2']),
      'active',
      0.7,
      Date.now() - 3 * 86400000,
    );
  sql
    .prepare(`INSERT INTO life_log (at, kind, text, artifact) VALUES(?,?,?,?)`)
    .run(Date.now() - 5 * 3600_000, 'did', '画了一张水母图', '');
  const vector = new Float32Array([1, 2, 3]);
  sql
    .prepare(
      `INSERT INTO memory_embeddings (id, peer_id, kind, vector, dims, model, created_at) VALUES(?,?,?,?,?,?,?)`,
    )
    .run(
      'mem-1',
      peer,
      'memory',
      Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength),
      3,
      'test-model',
      Date.now(),
    );
  sql.prepare(`INSERT INTO settings (key, value) VALUES('mood', ?)`).run(
    JSON.stringify({
      valence: 0.4,
      energy: 0,
      patience: 0,
      reason: '夸夸',
      at: Date.now() - 60000,
    }),
  );
  sql
    .prepare(`INSERT INTO settings (key, value) VALUES('wechat:session', ?)`)
    .run(
      JSON.stringify({ token: 'tok', baseUrl: 'https://ilinkai.weixin.qq.com', account: 'acc' }),
    );
  sql.close();
}

test('老库 → 新内核：ID 对齐、六变量投影、会话凭据保留', () => {
  const dir = mkdtempSync(join(tmpdir(), 'xing-mig-'));
  const oldPath = join(dir, 'old.db');
  const newPath = join(dir, 'new.db');
  try {
    buildOldDb(oldPath);
    const summary = migrate(oldPath, newPath);
    assert.deepEqual(summary, {
      peers: 1,
      events: 4,
      memories: 1,
      commitments: 2,
      thoughts: 1,
      vectors: 1,
    });

    const journal = new Journal(newPath);
    const peer = 'wechat:acc:alice';
    const events = journal.events(peer);
    assert.equal(events.filter((e) => e.kind === 'received').length, 1);
    assert.equal(events.filter((e) => e.kind === 'said').length, 1);
    assert.equal(events.filter((e) => e.kind === 'diary').length, 1);
    assert.ok(events.some((e) => e.kind === 'experienced' && e.content.includes('水母')));
    // 记忆 ID 与向量对齐，detail 按老数学投影后仍在合理区间。
    const memory = journal.memories(peer)[0]!;
    assert.equal(memory.id, 'mem-1');
    assert.ok(memory.detail > 0.3 && memory.detail <= 1);
    assert.equal(memory.sources[0], 'msg-1');
    const embeddings = journal.embeddingsOf(['mem-1'], 'test-model');
    assert.ok(embeddings.has('mem-1'));
    // 约定与念头原样在场，素材来源可验证。
    assert.equal(journal.commitments(peer).length, 2);
    assert.equal(journal.thoughts(peer)[0]!.topic, '赶版本');
    // 她的当下与心情迁入。
    assert.equal(journal.self().activity, '复读水母');
    assert.equal(journal.mood(peer)?.valence, 0.4);
    // 微信会话保留（免重新扫码）。
    const session = journal.setting<{ token: string } | undefined>('wechat:session', undefined);
    assert.equal(session?.token, 'tok');
    journal.close();
  } catch (error) {
    assert.fail(error instanceof Error ? error.message : String(error));
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
      /* Windows 句柄释放滞后：临时目录留给系统清理 */
    }
  }
});
