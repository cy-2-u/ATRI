import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.js';

/** 检索与来源治理：FTS 越窗召回、稀有度、语义去重、删除链、纠正、隔离。 */

test('全文检索：近期窗口之外的旧事仍可召回，保留说话人', (t) => {
  const f = fixture(t);
  for (let i = 0; i < 30; i++)
    f.store.ingest('p1', `m${i}`, `日常流水 ${i}`, [], Date.now() - (40 - i) * 86400000);
  const old = f.store.ingest(
    'p1',
    'old',
    '那年我们在巷口吃过一碗年糕',
    [],
    Date.now() - 300 * 86400000,
  ).message;
  const hits = f.store.search('p1', '年糕 巷口', 5);
  assert.ok(
    hits.some((h) => h.id === old.id),
    '远超近期窗口的旧事可检索',
  );
  assert.equal(hits.find((h) => h.id === old.id)!.role, 'user');
});

test('联系人隔离：检索、来源、记忆互不越界', (t) => {
  const f = fixture(t);
  f.store.ensurePeer('p2', 'preview', '别人', '', true);
  const mine = f.store.ingest('p1', 'a', '我喜欢吃年糕').message;
  f.store.ingest('p2', 'b', '别人也提到年糕但与我无关', [], Date.now() + 1);
  assert.equal(
    f.store.search('p1', '年糕', 5).some((h) => h.content.includes('别人也提到')),
    false,
  );
  assert.equal(f.store.sources('p2', [mine.id]).length, 0, '来源查询按联系人限定');
});

test('稀有度与相关度：常见词命中不占召回的解释力', (t) => {
  const f = fixture(t);
  // “有点”出现在大多数行：只撞它的候选不构成一次有效召回
  for (let i = 0; i < 20; i++)
    f.store.ingest('p1', `c${i}`, `有点普通的第 ${i} 天`, [], Date.now() + i);
  f.store.ingest('p1', 'rare', '唯一的稀有词：青梅酒', [], Date.now() + 100);
  const hits = f.store.search('p1', '青梅酒', 5);
  assert.ok(hits.length >= 1 && /青梅酒/.test(hits[0]!.content));
  const noise = f.store.search('p1', '有点 普通', 5);
  assert.ok(
    noise.every((h) => (h.minDf ?? Infinity) > 5),
    '常见词的 minDf 高，调用方可据此过滤',
  );
});

test('明确纠正替代旧记忆并继承引用计数；superseded 退出默认召回', (t) => {
  const f = fixture(t);
  const source = f.store.ingest('p1', 'a', '不是周五，是周六', [], Date.now()).message;
  f.store.addMemory(
    'p1',
    { content: '约在周五', kind: 'stated', sources: [source.id] },
    f.store.peer('p1')!.version,
  );
  const old = f.store.memories('p1')[0]!;
  f.store.sql.prepare('UPDATE memories SET hits=4 WHERE id=?').run(old.id);
  f.store.sql.prepare('UPDATE peers SET version=version+1 WHERE id=?').run('p1');
  f.store.correctMemory('p1', old.id, '约在周六');
  const memories = f.store.memories('p1');
  assert.equal(memories.length, 1, '更正原子替代旧条');
  assert.match(memories[0]!.content, /周六/);
  assert.equal(memories[0]!.hits, 4, '引用计数被继承');
  assert.equal(f.store.peer('p1')!.notes, '', '更正清空话题笔记迫使重整');
  assert.equal(f.store.search('p1', '周五', 5, 'memory').length, 0, '旧说法退出检索');
});

test('删除原文：依赖链失效到固定点，检索/开环/挂念/向量同步清理', (t) => {
  const f = fixture(t);
  const peer = 'p1';
  const m1 = f.store.ingest(peer, 'm1', '我奶奶生病住院了', [], Date.now()).message;
  const version = () => f.store.peer(peer)!.version;
  f.store.addMemory(
    peer,
    { content: '对方奶奶生病', kind: 'stated', sources: [m1.id], emotion: -0.6 },
    version(),
  );
  const diaryTask = f.store.enqueue(peer, 'diary', 'd:1', {
    day: '2026-10-01',
    through: m1.seq,
    ids: [m1.id],
  });
  const claimed = f.store.claim(peer)!;
  void diaryTask;
  f.store.saveDiary(
    claimed,
    '2026-10-01',
    [{ content: '他说奶奶住院了。', sources: [m1.id], emotion: -0.5 }],
    [{ content: '担心奶奶', kind: 'interpretation', sources: [m1.id] }],
  );
  f.store.addOpenLoop(peer, {
    content: '探望奶奶',
    dueAt: Date.now() + 86400000,
    sources: [m1.id],
  });
  f.store.addSoftThread(peer, { content: '奶奶的病情', kind: 'concern', sources: [m1.id] });
  assert.ok(f.store.search(peer, '奶奶', 5).length >= 2);
  f.store.forget(peer, m1.id);
  assert.equal(f.store.search(peer, '奶奶', 5).length, 0, '检索不再带回已删除来源');
  assert.ok(
    f.store.memories(peer).every((m) => !/奶奶/.test(m.content)),
    '依赖记忆失效（含日记蒸馏出的）',
  );
  assert.equal(f.store.diaries(peer).length, 0, '依赖日记失效');
  assert.equal(f.store.openLoops(peer, true).length, 0, '引用开环过期');
  assert.equal(f.store.softThreads(peer, true).length, 0, '引用挂念过期');
  assert.equal(f.store.getMessage(peer, m1.id)!.content, '', '原文内容清空但行保留审计');
});

test('supersede 链：替代条退出活跃集且退出检索', (t) => {
  const f = fixture(t);
  const s1 = f.store.ingest('p1', 'a', '我最喜欢乌龙茶').message;
  const s2 = f.store.ingest('p1', 'b', '我最近只喝乌龙茶').message;
  const version = () => f.store.peer('p1')!.version;
  f.store.addMemory(
    'p1',
    { content: '对方最喜欢乌龙茶', kind: 'stated', sources: [s1.id] },
    version(),
  );
  f.store.applyMemoryUpdates('p1', version(), [
    {
      content: '对方最近只喝乌龙茶',
      kind: 'stated' as const,
      sources: [s2.id],
      supersedes: [f.store.memories('p1')[0].id],
    },
  ]);
  const memories = f.store.memories('p1');
  assert.equal(memories.length, 1, '被替代的旧条退出活跃集');
  assert.match(memories[0]!.content, /最近只喝/);
  assert.equal(f.store.search('p1', '最喜欢', 5, 'memory').length, 0, '旧条退出检索');
});

test('重述同义事实合并证据并巩固，不产生重复行', (t) => {
  const f = fixture(t);
  const a = f.store.ingest('p1', 'a', '我不吃香菜').message;
  const b = f.store.ingest('p1', 'b', '再说一次，我不吃香菜').message;
  const version = () => f.store.peer('p1')!.version;
  f.store.addMemory('p1', { content: '对方不吃香菜', kind: 'stated', sources: [a.id] }, version());
  const before = f.store.memories('p1')[0];
  f.store.addMemory('p1', { content: '对方不吃香菜', kind: 'stated', sources: [b.id] }, version());
  const after = f.store.memories('p1');
  assert.equal(after.length, 1, '同一事实只有一行');
  assert.equal(after[0]!.id, before.id);
  assert.ok(after[0]!.sources.length >= 2, '证据被合并');
  assert.ok(after[0]!.consolidation > before.consolidation, '重述带来巩固');
});

test('向量回填：缺向量的行按批补齐，换模型清旧向量', (t) => {
  const f = fixture(t);
  const a = f.store.ingest('p1', 'a', '要建索引的内容').message;
  const b = f.store.ingest('p1', 'b', '第二条内容', [], Date.now() + 1).message;
  assert.equal(f.store.pendingEmbeddings('p1', 10).length, 2);
  f.store.setEmbedding(a.id, 'p1', 'message', new Float32Array([1, 0]), 'model-a');
  assert.equal(f.store.pendingEmbeddings('p1', 10).length, 1, '已有向量的行不再等待回填');
  f.store.setEmbedding(b.id, 'p1', 'message', new Float32Array([0, 1]), 'model-b');
  assert.deepEqual(f.store.staleEmbeddingModels('p1', 'model-b'), ['model-a']);
  assert.equal(f.store.dropEmbeddingsOfModel('model-a'), 1);
  assert.equal(f.store.embeddings('p1').length, 1);
});
