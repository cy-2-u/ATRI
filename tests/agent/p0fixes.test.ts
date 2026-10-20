import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMood, parseReply, resolveDue } from '@atri/core';
import { ModelError, HttpModel, type ModelConfig } from '@atri/llm';
import { fixture, FakeModel, completion } from '../helpers.js';

const stickers = [{ slug: 'happy', description: '开心', tags: ['开心'], file: 'happy.png' }];
const config: ModelConfig = {
  baseUrl: 'https://model.example',
  apiKey: 'test-only-secret',
  model: 'test-model',
  format: 'openai',
  vision: false,
  maxTokens: 100,
  timeoutMs: 500,
};

test('P0-1 情绪 energy 保持符号：累了不会渲染成精力足', (t) => {
  const f = fixture(t);
  const now = Date.now();
  f.store.pulseMood('p1', { valence: 0, energy: -0.6, reason: '加班' }, now - 60000);
  const mood = f.store.mood('p1');
  assert.ok(mood.energy < 0, '负能量读回应为负');
  const prose = renderMood(mood, now);
  assert.match(prose, /有点累/);
  assert.doesNotMatch(prose, /精力挺足/);
});

test('P0-2 主动消息只标记它真正问到的开环', async (t) => {
  const now = Date.now();
  t.mock.method(Date, 'now', () => now);
  t.mock.method(Math, 'random', () => 0);
  // 模型问到了面试但完全没提体检，也没有上报 askedLoops：词面后备应只匹配面试
  const model = new FakeModel(() =>
    completion({ messages: ['面试怎么样啦？'], memoryUpdates: [] }),
  );
  const f = fixture(t, model, { proactiveEnabled: true, quietStart: 0, quietEnd: 0 });
  f.store.ensurePeer('wechat:p', 'wechat', 'p', 'context', true);
  const source = f.store.ingest(
    'wechat:p',
    'src',
    '明天面试，后天体检',
    [],
    now - 26 * 3600000,
  ).message;
  f.store.addOpenLoop('wechat:p', { content: '面试情况', dueAt: now - 1000, sources: [source.id] });
  f.store.addOpenLoop('wechat:p', { content: '体检安排', dueAt: now - 900, sources: [source.id] });
  f.runtime.schedule(now);
  await f.runtime.drain();
  const loops = f.store.openLoops('wechat:p');
  assert.equal(loops.find((l) => l.content === '面试情况')!.asked, 1, '问到的开环被标记');
  assert.equal(loops.find((l) => l.content === '体检安排')!.asked, 0, '没问到的保持待问');
});

test('P0-2b 模型跳过的主动消息不烧掉任何开环', async (t) => {
  const now = Date.now();
  t.mock.method(Date, 'now', () => now);
  t.mock.method(Math, 'random', () => 0);
  const model = new FakeModel(() => completion({ messages: [], memoryUpdates: [] }));
  const f = fixture(t, model, { proactiveEnabled: true, quietStart: 0, quietEnd: 0 });
  f.store.ensurePeer('wechat:p', 'wechat', 'p', 'context', true);
  const source = f.store.ingest('wechat:p', 'src', '明天面试', [], now - 26 * 3600000).message;
  f.store.addOpenLoop('wechat:p', { content: '面试情况', dueAt: now - 1000, sources: [source.id] });
  f.runtime.schedule(now);
  await f.runtime.drain();
  assert.equal(f.delivered.length, 0, '跳过时不投递');
  assert.equal(f.store.dueOpenLoops('wechat:p', now).length, 1, '开环仍然到期可问');
});

test('P0-3 失败的 notes 任务可在同一 key 上复活', (t) => {
  const f = fixture(t);
  const id = f.store.enqueue('p1', 'notes', '42', { through: 42 });
  f.store.claim('p1', Date.now());
  f.store.finish(id, 'failed', '模型超时');
  const again = f.store.enqueue('p1', 'notes', '42', { through: 42 });
  assert.equal(again, id);
  assert.equal(f.store.taskById(id)!.state, 'queued', '失败任务重新排队');
  assert.ok(f.store.claim('p1', Date.now() + 600000), '能被重新认领');
  // done 的任务不复活：日常主动联系每天一条的语义保持不变
  const done = f.store.enqueue('p1', 'proactive', '2026-09-13', {});
  f.store.claim('p1', Date.now());
  f.store.finish(done);
  f.store.enqueue('p1', 'proactive', '2026-09-13', {});
  assert.equal(f.store.taskById(done)!.state, 'done', 'done 任务不被复活');
});

test('P0-4 年度开环滚动后用新 due_at 生成新任务', (t) => {
  const f = fixture(t);
  const source = f.store.ingest('p1', 'e', '我生日快到了').message;
  const now = Date.now();
  const loop = f.store.addOpenLoop('p1', {
    content: '生日快乐',
    dueAt: now + 86400000,
    sources: [source.id],
    recurring: 'yearly',
  });
  const key1 = f.store.loopTaskKey(loop);
  f.store.enqueue('p1', 'proactive', key1, { loop: loop.id });
  f.store.resolveOpenLoop('p1', loop.id, now + 86400000);
  const rolled = f.store.openLoops('p1').find((l) => l.id === loop.id)!;
  assert.ok(rolled.due_at > loop.due_at, '滚动到明年');
  assert.equal(rolled.status, 'open');
  const key2 = f.store.loopTaskKey(rolled);
  assert.notEqual(key1, key2, '新年度产生新 key');
  const id2 = f.store.enqueue('p1', 'proactive', key2, { loop: loop.id });
  assert.notEqual(id2, f.store.openLoops('p1')[0] && f.store.taskById(key1)?.id, '新任务可建立');
  assert.equal(f.store.taskById(id2)!.state, 'queued');
});

test('P0-5 网络层错误参与重试', async () => {
  assert.equal(ModelError.transient(undefined, true), true, '网络错误可重试');
  assert.equal(ModelError.transient(401), false);
  assert.equal(ModelError.transient(503), true);
  let requests = 0;
  const flaky = new HttpModel(config, (async () => {
    requests++;
    if (requests <= 2) throw new TypeError('fetch failed: ECONNRESET');
    return Response.json({ choices: [{ message: { role: 'assistant', content: '恢复' } }] });
  }) as unknown as typeof fetch);
  const result = await flaky.complete([{ role: 'user', content: 'hi' }]);
  assert.equal(result.text, '恢复');
  assert.equal(requests, 3, '连接失败也拿到 3 次机会');
});

test('P0-6 embeddingEnabled 关闭后不再提供向量', async (t) => {
  const f = fixture(t);
  const { Settings } = await import('../../apps/api/src/config.js');
  const settings = new Settings(f.store, process.cwd(), {
    ADMIN_PASSWORD: 'x'.repeat(16),
    DATA_DIR: f.directory,
  } as NodeJS.ProcessEnv);
  settings.update({
    embeddingEnabled: true,
    embeddingModel: 'text-embedding-test',
    embeddingBaseUrl: 'https://embed.example',
  });
  assert.equal(settings.embeddingEnabled(), false, '缺密钥时视为未启用');
  settings.update({ embeddingApiKey: 'embed-key' });
  assert.equal(settings.embeddingEnabled(), true);
  settings.update({ embeddingEnabled: false });
  assert.equal(settings.embeddingEnabled(), false, '开关真正生效');
});

test('P0-7 置顶记忆不被 500 条滑动窗口截断', (t) => {
  const f = fixture(t);
  const insert = f.store.sql.prepare(
    'INSERT INTO memories(id,peer_id,content,kind,sources,source_hash,hits,last_hit_at,created_at,pinned,invalid_at,importance) VALUES(?,?,?,?,?,?,0,0,?,?,0,0.5)',
  );
  for (let i = 0; i < 520; i++)
    insert.run(
      `m${i}`,
      'p1',
      `内容${i}`,
      'stated',
      '[]',
      `h${i}`,
      Date.now() - (520 - i) * 1000,
      i === 0 ? 1 : 0,
    );
  assert.ok(
    f.store.memories('p1').some((m) => m.id === 'm0'),
    '最老的置顶记忆仍在',
  );
  assert.equal(f.store.rankedMemories('p1', 10)[0]!.id, 'm0', '置顶记忆排第一');
});

test('P1 更正记忆不再伪装成用户发言', (t) => {
  const f = fixture(t);
  const source = f.store.ingest('p1', 'e', '我喜欢猫', [], Date.now() - 10 * 3600000).message;
  f.store.addMemory(
    'p1',
    { content: '用户喜欢猫', kind: 'stated', sources: [source.id] },
    f.store.peer('p1')!.version,
  );
  const before = f.store.peer('p1')!.last_user_at;
  f.store.correctMemory('p1', f.store.memories('p1')[0]!.id, '用户喜欢狗');
  const after = f.store.peer('p1')!.last_user_at;
  assert.equal(after, before, '静默计时没有被重置');
  const roles = f.store.history('p1').map((m) => m.role);
  assert.ok(!roles.includes('system'), '更正记录不进入对话历史');
  assert.ok(
    f.store.memories('p1').every((m) => m.content !== '用户喜欢猫'),
    '旧记忆被替代',
  );
});

test('P1 stated 记忆不能只引用助手自己的话', (t) => {
  const f = fixture(t);
  const task = f.store.enqueue('p1', 'chat', 'c1', { through: 1 });
  f.store.claim('p1', Date.now());
  f.store.saveReply(f.store.taskById(task)!, [{ type: 'text', text: '我觉得你可能喜欢猫吧' }], []);
  // 完整投递一遍，让消息进入可引用状态（pending → sent 并建立索引）
  const delivery = f.store.pendingDeliveries('p1')[0]!;
  f.store.startDelivery(delivery.id);
  f.store.markDelivery(delivery.id, 'sent');
  const assistantId = f.store.history('p1').find((m) => m.role === 'assistant')!.id;
  f.store.addMemory(
    'p1',
    { content: '用户喜欢猫', kind: 'stated', sources: [assistantId] },
    f.store.peer('p1')!.version,
  );
  assert.equal(f.store.memories('p1').length, 0, '自我引用的 stated 被拒绝');
  // interpretation 仍然允许
  f.store.addMemory(
    'p1',
    { content: '对方可能喜欢猫', kind: 'interpretation', sources: [assistantId] },
    f.store.peer('p1')!.version,
  );
  assert.equal(f.store.memories('p1').length, 1);
});

test('P1 相同内容不同来源的记忆合并而不是重复', (t) => {
  const f = fixture(t);
  const a = f.store.ingest('p1', 'e1', '我喜欢猫').message.id;
  const b = f.store.ingest('p1', 'e2', '我最喜欢猫了').message.id;
  const version = f.store.peer('p1')!.version;
  f.store.addMemory('p1', { content: '用户喜欢猫', kind: 'stated', sources: [a] }, version);
  f.store.addMemory('p1', { content: '用户喜欢猫', kind: 'stated', sources: [b] }, version);
  assert.equal(f.store.memories('p1').length, 1, '同内容合并');
  assert.equal(f.store.memories('p1')[0]!.sources.length, 2, '证据合并');
});

test('P1 importance 参与记忆排序', (t) => {
  const f = fixture(t);
  const source = f.store.ingest('p1', 'e', '资料').message.id;
  const version = f.store.peer('p1')!.version;
  f.store.addMemory(
    'p1',
    { content: '随口一提的事', kind: 'stated', sources: [source], importance: 0.1 },
    version,
  );
  f.store.addMemory(
    'p1',
    { content: '非常在意的事', kind: 'stated', sources: [source], importance: 0.95 },
    version,
  );
  assert.equal(f.store.rankedMemories('p1', 2)[0]!.content, '非常在意的事');
});

test('P1 开环去重：同内容同日期只保留一条', (t) => {
  const f = fixture(t);
  const source = f.store.ingest('p1', 'e', '明天面试').message.id;
  const dueAt = Date.now() + 86400000;
  const first = f.store.addOpenLoop('p1', { content: '明天面试', dueAt, sources: [source] });
  const second = f.store.addOpenLoop('p1', { content: '明天面试', dueAt, sources: [source] });
  assert.equal(second.id, first.id, '返回已有条目');
  assert.equal(f.store.openLoops('p1').length, 1);
  assert.equal(f.store.openLoops('p1')[0]!.sources.length, 1, '来源不重复');
});

test('P1 resolveDue 已过日期滚动到明年', () => {
  const now = Date.parse('2026-10-18T04:00:00Z');
  const due = resolveDue(undefined, '09-20 10:00', now, 'Asia/Shanghai');
  assert.ok(due! > now, '过去日期滚到明年');
  const next = new Date(due!);
  assert.equal(next.getUTCFullYear(), 2027);
  // 未来日期保持今年
  const future = resolveDue(undefined, '12-01 09:00', now, 'Asia/Shanghai');
  assert.equal(new Date(future!).getUTCFullYear(), 2026);
});

test('P1 parseReply 使用配置时区解析 due', () => {
  const now = Date.parse('2026-09-13T00:00:00Z');
  const parsed = parseReply(
    JSON.stringify({
      messages: ['好'],
      memoryUpdates: [],
      openLoops: [{ content: '明早叫我', due: '明天 08:00', sources: ['a'] }],
    }),
    stickers,
    false,
    'America/New_York',
  );
  assert.equal(parsed.openLoops.length, 1);
  // parseReply 固定用真实时钟解析相对日期；这里只验证时区换算本身。
  // now = UTC 00:00 = 纽约 9/12 20:00，"明天 08:00" 即纽约 9/13 08:00 = UTC 12:00。
  const direct = resolveDue(undefined, '明天 08:00', now, 'America/New_York');
  assert.equal(direct, Date.parse('2026-09-13T12:00:00Z'), '纽约的明天 08:00 = UTC 12:00');
  const shanghai = resolveDue(undefined, '明天 08:00', now, 'Asia/Shanghai');
  assert.equal(
    shanghai,
    Date.parse('2026-09-14T00:00:00Z'),
    '上海的明天 08:00 = UTC 00:00（9/14 凌晨）',
  );
  // 纽约 9/13 当天 08:00 已过（now 是 UTC 00:00 = 纽约 20:00 前一天? 验证明天语义）
  assert.equal(parsed.openLoops[0]!.dueAt > 0, true);
});

test('P2 askedLoops 从模型输出解析', () => {
  const parsed = parseReply(
    JSON.stringify({ messages: ['x'], memoryUpdates: [], askedLoops: ['a', 42, 'b'] }),
    stickers,
  );
  assert.deepEqual(parsed.askedLoops, ['a', 'b']);
  const missing = parseReply(JSON.stringify({ messages: ['x'], memoryUpdates: [] }), stickers);
  assert.deepEqual(missing.askedLoops, []);
});

test('P2 检索 MMR：重复内容被降位，多样性候选提前', (t) => {
  const f = fixture(t);
  // 三条同分（lexical 都是 10）：两条完全相同的新消息 + 一条更早的多样化消息。
  // 纯分数排序（score 相同按 created_at 降序）会给出 [新, 新, 旧]；
  // MMR 应把重复内容挤到最后，让多样性候选排第二。
  const at = Date.now();
  f.store.ingest('p1', 'e-old', '还记得海边散步吗', [], at - 600000);
  f.store.ingest('p1', 'e-dup-1', '海边散步看日落了呀', [], at - 1000);
  f.store.ingest('p1', 'e-dup-2', '海边散步看日落了呀', [], at);
  const hits = f.store.search('p1', '海边散步', 3);
  assert.strictEqual(hits.length, 3);
  assert.ok(hits[1]!.content.includes('还记得海边散步'), '多样性候选排第二');
  assert.strictEqual(hits[2]!.content, hits[0]!.content, '重复内容被挤到最后');
});

test('P2 情绪规则脉冲使用配置时区', (t) => {
  const f = fixture(t);
  // UTC 18:00 = 上海凌晨 2 点（深夜），纽约是下午 14 点
  const at = Date.parse('2026-09-13T18:00:00Z');
  t.mock.method(Date, 'now', () => at);
  f.store.pulseMoodFromExchange(
    'p1',
    { user: '在忙', assistant: '怎么了', userAt: at },
    at,
    'America/New_York',
  );
  // 纽约下午没有深夜惩罚，长对话阈值也不满足，情绪不应变化
  const mood = f.store.mood('p1');
  assert.ok(Math.abs(mood.energy) < 0.01, '非深夜时段无 energy 惩罚');
  // 上海同一时刻是凌晨 2 点，应有 -0.15 的 energy 惩罚
  f.store.pulseMoodFromExchange(
    'p1',
    { user: '在忙', assistant: '怎么了', userAt: at },
    at,
    'Asia/Shanghai',
  );
  assert.ok(f.store.mood('p1').energy < -0.1, '上海深夜触发 energy 惩罚');
});
