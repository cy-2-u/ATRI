import test from 'node:test';
import assert from 'node:assert/strict';
import { Store, MEMORY_HALFLIFE_DAYS } from '@atri/db';
import { recentStickerUse, renderTimeGap, parseReply } from '@atri/core';
import { cosineSimilarity } from '@atri/llm';
import { fixture, FakeModel, completion, promptText } from '../helpers.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

test('记忆按使用次数、重要性和新近度混合排序，不再单纯截取最新 10 条', (t) => {
  const f = fixture(t);
  const source = f.store.ingest('p1', 'src', '聊过生日和忌口').message;
  const version = f.store.peer('p1')!.version;
  // 老但重要的 stated 记忆
  f.store.addMemory('p1', { content: '生日在三月', kind: 'stated', sources: [source.id] }, version);
  f.store.sql
    .prepare("UPDATE memories SET created_at=? WHERE content='生日在三月'")
    .run(Date.now() - MEMORY_HALFLIFE_DAYS * 86400000 * 6);
  // 新的一次性 interpretation
  f.store.addMemory(
    'p1',
    { content: '临时的心情推断', kind: 'interpretation', sources: [source.id] },
    version,
  );
  // 被反复引用的旧记忆
  f.store.addMemory('p1', { content: '不吃香菜', kind: 'stated', sources: [source.id] }, version);
  f.store.sql
    .prepare("UPDATE memories SET created_at=? WHERE content='不吃香菜'")
    .run(Date.now() - MEMORY_HALFLIFE_DAYS * 86400000 * 10);
  f.store.markMemoriesUsed('p1', [
    f.store.memories('p1').find((m) => m.content === '不吃香菜')!.id,
  ]);
  f.store.markMemoriesUsed('p1', [
    f.store.memories('p1').find((m) => m.content === '不吃香菜')!.id,
  ]);
  // Raw-SQL backdating bypasses the store's cache invalidation; drop it.
  (f.store as unknown as { memoryCache: Map<string, unknown> }).memoryCache.clear();
  const ranked = f.store.rankedMemories('p1', 2);
  assert.equal(ranked.length, 2);
  assert.equal(ranked[0]!.content, '不吃香菜');
  assert.equal(ranked[1]!.content, '生日在三月');
});

test('更正记忆保留使用计数', (t) => {
  const f = fixture(t);
  const source = f.store.ingest('p1', 'src', '我周五面试').message;
  f.store.addMemory(
    'p1',
    { content: '周五面试', kind: 'stated', sources: [source.id] },
    f.store.peer('p1')!.version,
  );
  const memory = f.store.memories('p1')[0]!;
  f.store.markMemoriesUsed('p1', [memory.id]);
  f.store.markMemoriesUsed('p1', [memory.id]);
  const hits = f.store.memories('p1')[0]!.hits;
  f.store.correctMemory('p1', memory.id, '改成周六面试');
  const corrected = f.store.memories('p1').find((m) => m.content === '改成周六面试')!;
  assert.ok(corrected, '更正后的记忆存在');
  assert.ok(corrected.hits >= hits, '更正保留原引用次数');
});

test('余弦相似度区分同向与正交向量', () => {
  const a = new Float32Array([1, 0, 2]);
  const b = new Float32Array([2, 0, 4]);
  const c = new Float32Array([0, 1, 0]);
  assert.ok(Math.abs(cosineSimilarity(a, b) - 1) < 1e-6);
  assert.equal(cosineSimilarity(a, c), 0);
  assert.equal(cosineSimilarity(a, new Float32Array(0)), 0);
});

test('向量精排把无词面重合的旧事带回召回，开启需嵌入且未配置时不影响原结果', (t) => {
  const f = fixture(t);
  const old = f.store.ingest('p1', 'old', '我最怕打针，看到针头就晕').message;
  f.store.setEmbeddings([
    {
      id: old.id,
      peer: 'p1',
      kind: 'message',
      // 与查询“医院体验”无词面重合，但语义接近
      vector: new Float32Array([1, 0.9, 0]),
      model: 'test-embed',
    },
  ]);
  const noise = f.store.ingest('p1', 'noise', '医院附近的桂花开了').message;
  f.store.setEmbeddings([
    {
      id: noise.id,
      peer: 'p1',
      kind: 'message',
      vector: new Float32Array([0, 0, 1]),
      model: 'test-embed',
    },
  ]);
  const queryVector = new Float32Array([0.95, 0.9, 0.1]);
  const hits = f.store.search('p1', '医院体验', 5, undefined, queryVector);
  assert.ok(
    hits.some((h) => h.id === old.id),
    '语义相近的内容被召回',
  );
  // 无查询向量时保持纯词面行为：无重合则无结果
  const lexicalOnly = f.store.search('p1', '完全无关的词', 5);
  assert.equal(lexicalOnly.length, 0);
});

test('内容更新后旧向量失效，待嵌入清单只列缺失项', (t) => {
  const f = fixture(t);
  const m = f.store.ingest('p1', 'a', '最初的描述').message;
  f.store.setEmbeddings([
    {
      id: m.id,
      peer: 'p1',
      kind: 'message',
      vector: new Float32Array([1, 1]),
      model: 'test-embed',
    },
  ]);
  assert.equal(f.store.pendingEmbeddings('p1').length, 0);
  f.store.updateMedia('p1', m.id, [{ kind: 'image', description: '新的观察' }]);
  assert.equal(f.store.pendingEmbeddings('p1').length, 1, '重新索引后需要重建向量');
  f.store.forget('p1', m.id);
  assert.equal(f.store.embeddings('p1').length, 0, '删除来源会清理向量');
});

test('文本里漏出的 [表情：x] 会被转换为目录内表情，匹配不到则删除', () => {
  const stickers = [
    { slug: 'shy', description: '有些害羞，不好意思', tags: ['害羞', '夸奖'], file: 'shy.png' },
    { slug: 'happy', description: '开心地笑，分享好消息', tags: ['开心', '笑'], file: 'happy.png' },
  ];
  const direct = parseReply(
    '{"messages":["你太夸奖啦 [表情：害羞]"],"memoryUpdates":[]}',
    stickers,
  );
  assert.deepEqual(direct.parts, [
    { type: 'text', text: '你太夸奖啦' },
    { type: 'sticker', slug: 'shy', description: '有些害羞，不好意思' },
  ]);
  const slugForm = parseReply(
    '{"messages":["哈哈 [表情：happy] 收到"],"memoryUpdates":[]}',
    stickers,
  );
  assert.deepEqual(slugForm.parts, [
    { type: 'text', text: '哈哈' },
    { type: 'sticker', slug: 'happy', description: '开心地笑，分享好消息' },
    { type: 'text', text: '收到' },
  ]);
  const unmatched = parseReply(
    '{"messages":["随便说说 [表情：不存在的表情]"],"memoryUpdates":[]}',
    stickers,
  );
  assert.deepEqual(unmatched.parts, [{ type: 'text', text: '随便说说' }]);
  const plain = parseReply('没有表情的一段话', stickers, true);
  assert.deepEqual(plain.parts, [{ type: 'text', text: '没有表情的一段话' }]);
});

test('单个字符串里的空行会兜底拆成气泡，单换行仍留在同一气泡', () => {
  const multi = parseReply(
    JSON.stringify({ messages: ['第一段\n\n第二段'], memoryUpdates: [] }),
    [],
  );
  assert.deepEqual(multi.parts, [
    { type: 'text', text: '第一段' },
    { type: 'text', text: '第二段' },
  ]);
  const single = parseReply(
    JSON.stringify({ messages: ['第一行\n第二行'], memoryUpdates: [] }),
    [],
  );
  assert.deepEqual(single.parts, [{ type: 'text', text: '第一行\n第二行' }]);
});
test('空行拆分会保留多段内容，并与数组元素、表情标记和上限协作', () => {
  const stickers = [
    { slug: 'cat081', description: '猫猫挥手', tags: ['猫', '打招呼'], file: 'cat.png' },
  ];
  const mixed = parseReply(
    JSON.stringify({ messages: ['A\n\nB', 'C'], memoryUpdates: [] }),
    stickers,
  );
  assert.deepEqual(mixed.parts, [
    { type: 'text', text: 'A' },
    { type: 'text', text: 'B' },
    { type: 'text', text: 'C' },
  ]);
  const manyBreaks = parseReply(
    JSON.stringify({ messages: ['A\n\n\nB'], memoryUpdates: [] }),
    stickers,
  );
  assert.deepEqual(manyBreaks.parts, [
    { type: 'text', text: 'A' },
    { type: 'text', text: 'B' },
  ]);
  const withSticker = parseReply(
    JSON.stringify({ messages: ['A\n\n[表情：cat081]'], memoryUpdates: [] }),
    stickers,
  );
  assert.deepEqual(withSticker.parts, [
    { type: 'text', text: 'A' },
    { type: 'sticker', slug: 'cat081', description: '猫猫挥手' },
  ]);
  const plain = parseReply('第一段\n\n第二段', stickers);
  assert.deepEqual(plain.parts, [
    { type: 'text', text: '第一段' },
    { type: 'text', text: '第二段' },
  ]);
  const capped = parseReply(
    JSON.stringify({
      messages: ['一\n\n二\n\n三\n\n四\n\n五\n\n六\n\n七'],
      memoryUpdates: [],
    }),
    stickers,
  );
  assert.equal(capped.parts.length, 6);
  assert.equal(capped.parts.at(-1)?.type, 'text');
  assert.equal((capped.parts.at(-1) as { text: string }).text, '六\n\n七');
  const stickerAtCap = parseReply(
    JSON.stringify({
      messages: ['一', '二', '三', '四', '五', { type: 'sticker', slug: 'cat081' }, '六'],
      memoryUpdates: [],
    }),
    stickers,
  );
  assert.equal(stickerAtCap.parts.length, 6);
  assert.deepEqual(stickerAtCap.parts.at(-1), { type: 'text', text: '六' });
});

test('英文伪协议 [sticker:slug] / (sticker:slug) 同样被转换或删除，不再漏进聊天', () => {
  const stickers = [
    { slug: 'cat053', description: '猫猫挥手', tags: ['猫', '打招呼'], file: 'cat.png' },
  ];
  for (const variant of [
    '你好呀[sticker:cat053]',
    '你好呀[sticker: cat053]',
    '你好呀【sticker:cat053】',
    '你好呀(sticker:cat053)',
  ]) {
    const r = parseReply(JSON.stringify({ messages: [variant], memoryUpdates: [] }), stickers);
    assert.deepEqual(
      r.parts,
      [
        { type: 'text', text: '你好呀' },
        { type: 'sticker', slug: 'cat053', description: '猫猫挥手' },
      ],
      variant,
    );
  }
  const unknown = parseReply(
    '{"messages":["你好呀[sticker:no-such]"],"memoryUpdates":[]}',
    stickers,
  );
  assert.deepEqual(unknown.parts, [{ type: 'text', text: '你好呀' }]);
});

test('模型正确走 JSON 协议时行为不变', () => {
  const stickers = [{ slug: 'happy', description: '开心', tags: ['开心'], file: 'happy.png' }];
  const reply = parseReply(
    '{"messages":["好耶",{"type":"sticker","slug":"happy"}],"memoryUpdates":[]}',
    stickers,
  );
  assert.equal(reply.parts.length, 2);
  assert.equal(reply.parts[1]!.type, 'sticker');
});

test('时间感知：连续聊天、小时级空白与隔天分别渲染', () => {
  const now = Date.parse('2026-09-14T10:00:00Z');
  const zone = 'Asia/Shanghai';
  const continuous = renderTimeGap(now, now - 5 * 60000, zone);
  assert.match(continuous, /连续聊天/);
  const hours = renderTimeGap(now, now - 6 * 3600000, zone);
  assert.match(hours, /6 小时/);
  assert.match(hours, /空白/);
  const days = renderTimeGap(now, now - 30 * 86400000, zone);
  assert.match(days, /30 天/);
  const fresh = renderTimeGap(now, now - 60000, zone);
  assert.match(fresh, /现在是/);
});

test('近期表情使用从历史提取，供反重复提示', (t) => {
  const f = fixture(t);
  const source = f.store.ingest('p1', 'a', '你好').message;
  f.store.sql
    .prepare(
      "INSERT INTO messages(id,peer_id,role,content,status,created_at) VALUES(?,?, 'assistant', ?, 'sent', ?)",
    )
    .run('r1', 'p1', '[表情：开心] 你好呀', source.created_at + 1000);
  f.store.sql
    .prepare(
      "INSERT INTO messages(id,peer_id,role,content,status,created_at) VALUES(?,?, 'assistant', ?, 'sent', ?)",
    )
    .run('r2', 'p1', '[表情：加油] 一起努力', source.created_at + 2000);
  const history = f.store.history('p1');
  // 修复前这里返回的是消息里出现的原始文本（描述），与 rotateStickers 比对的
  // slug 永远对不上，防重复等于没做。现在必须给出目录，按描述/标签解析成 slug。
  const uses = recentStickerUse(history, [
    { slug: 'happy', description: '开心', tags: ['开心'], file: 'happy.png' },
    { slug: 'go', description: '加油', tags: ['加油'], file: 'go.png' },
  ]);
  assert.deepEqual(
    uses.map((u) => u.slug),
    ['happy', 'go'],
  );
});

test('高频聊天后，重要旧记忆仍进提示词（最新10条陷阱回归）', async (t) => {
  const model = new FakeModel(() => completion({ messages: ['记得。'], memoryUpdates: [] }));
  const f = fixture(t, model);
  const source = f.store.ingest('p1', 'old', '我生日在三月，别忘记').message;
  f.store.addMemory(
    'p1',
    { content: '生日在三月', kind: 'stated', sources: [source.id] },
    f.store.peer('p1')!.version,
  );
  f.store.sql
    .prepare("UPDATE memories SET created_at=? WHERE content='生日在三月'")
    .run(Date.now() - 20 * 86400000);
  // 制造 12 条更新的记忆，把旧的挤出“最新 10 条”
  for (let i = 0; i < 12; i++) {
    const s = f.store.ingest('p1', 'n' + i, '日常话题' + i).message;
    f.store.addMemory(
      'p1',
      { content: '新记忆' + i, kind: 'interpretation', sources: [s.id] },
      f.store.peer('p1')!.version,
    );
  }
  f.runtime.accept('p1', 'q', '你知道我的生日吗');
  await f.runtime.drain();
  assert.ok(model.calls.length >= 1);
  const system = promptText(model.calls[0]!.messages);
  assert.match(system, /生日在三月/, '重要旧记忆按重要性排序后仍在提示词中');
});

test('临时目录隔离：Memory store 独立实例可用', () => {
  const dir = mkdtempSync(join(tmpdir(), 'atri-mem-'));
  try {
    const store = new Store(join(dir, 'a.db'));
    store.ensurePeer('x', 'preview', 'x', '', true);
    assert.equal(store.rankedMemories('x').length, 0);
    store.close();
  } finally {
    const absolute = resolve(dir);
    if (!absolute.startsWith(resolve(tmpdir()) + sep + 'atri-mem-')) throw new Error('路径无效');
    rmSync(absolute, { recursive: true, force: true });
  }
});

test('删除联系人会清空该联系人的会话、日记、记忆与惦记的事', (t) => {
  // 每张表都有 REFERENCES peers(id)，且 foreign_keys=ON。删除顺序错了会直接
  // 抛外键错误，所以这个测试同时守着"顺序正确"和"全部清空"两件事。
  const f = fixture(t);
  const peer = f.store.ensurePeer('del:1', 'wechat', 'wechat:del@im.wechat', '', true);
  const source = f.store.ingest('del:1', 'evt', '我养了一只猫叫团子').message;
  const version = f.store.peer('del:1')!.version;
  f.store.addMemory(
    'del:1',
    { content: '养了一只猫叫团子', kind: 'stated', sources: [source.id] },
    version,
  );
  f.store.enqueue(
    'del:1',
    'diary',
    'diary:1',
    { after: 0, through: 1, day: '2026-10-20' },
    Date.now(),
  );
  const task = f.store.claim('del:1')!;
  f.store.saveDiary(task, '2026-10-20', [{ content: '今天聊了猫', sources: [source.id] }], []);
  f.store.enqueue('del:1', 'proactive', 'loop:1', { loopId: 'x' }, Date.now());

  assert.ok(f.store.memories('del:1').length > 0, '前置条件：记忆已写入');
  assert.ok(f.store.diaries('del:1').length > 0, '前置条件：日记已写入');
  assert.ok(f.store.history('del:1', 10).length > 0, '前置条件：消息已写入');

  const removed = f.store.deletePeer('del:1');
  assert.ok(removed, '删除应返回被删掉的计数');

  assert.equal(f.store.peer('del:1'), undefined, 'peers 行应消失');
  assert.equal(f.store.memories('del:1').length, 0, '记忆应清空');
  assert.equal(f.store.diaries('del:1').length, 0, '日记应清空');
  assert.equal(f.store.history('del:1', 10).length, 0, '消息应清空');
  assert.equal(f.store.openLoops('del:1', true).length, 0, '惦记的事应清空');

  // 其它联系人不能被牵连。
  const other = f.store.ensurePeer('keep:1', 'wechat', 'wechat:keep@im.wechat', '', true);
  assert.ok(other, '无关联系人应保留');
  assert.equal(f.store.deletePeer('del:1'), undefined, '重复删除返回 undefined 而不是抛错');
  assert.equal(peer.id, 'del:1');
});

test('删除联系人后重新收到消息，是一个全新的联系人', (t) => {
  // 级联删除之后旧记忆不能"复活"：新消息不该召回已删内容。
  const f = fixture(t);
  f.store.ensurePeer('del:2', 'wechat', 'wechat:del2@im.wechat', '', true);
  const source = f.store.ingest('del:2', 'evt2', '我对花生过敏').message;
  const version = f.store.peer('del:2')!.version;
  f.store.addMemory(
    'del:2',
    { content: '对花生过敏', kind: 'stated', sources: [source.id] },
    version,
  );
  assert.equal(f.store.memories('del:2').length, 1);

  f.store.deletePeer('del:2');
  f.store.ensurePeer('del:2', 'wechat', 'wechat:del2@im.wechat', '', true);
  const fresh = f.store.ingest('del:2', 'evt3', '你好').message;

  assert.equal(f.store.memories('del:2').length, 0, '重建的联系人不该继承旧记忆');
  assert.equal(f.store.rankedMemories('del:2').length, 0);
  assert.equal(f.store.history('del:2', 10).length, 1, '只剩重建后的新消息');
  assert.ok(fresh.id, '新消息正常写入');
  // 全文索引同样不能残留旧内容。
  assert.equal(f.store.search('del:2', '花生').length, 0, '旧内容不应还能被检索到');
});
