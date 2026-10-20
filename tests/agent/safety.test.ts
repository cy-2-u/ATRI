import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, FakeModel, completion } from '../helpers.js';

// ---------- 清理任务不能因为外键约束把进程带崩 ----------
//
// 这是唯一一个会让 Node 进程直接退出的缺陷：pruneTasks 在 setInterval 回调里
// 运行，DELETE 撞上 outbox.task_id 的外键后抛错，未捕获的异常结束了整个进程，
// 而且只在部署一周后（超过保留期）才会发生。旧实现只把 pending/sending/uncertain
// 排除在外，'sent' 状态的行——也就是每一个真正投递过的任务——都会让 DELETE 失败。

test('pruneTasks 不会删除仍被 outbox 引用的任务（外键不崩）', (t) => {
  const f = fixture(t);
  const old = Date.now() - 40 * 86400000;
  const taskId = f.store.enqueue('p1', 'chat', 'k1', { text: '早' });
  // saveReply 只接受 running 状态的任务，先按真实调度走一遍 claim。
  const task = f.store.claim('p1')!;
  assert.equal(task.id, taskId);
  // 走真实投递路径，让 messages 与 outbox 都留下被引用的行。
  assert.equal(f.store.saveReply(task, [{ type: 'text', text: '早呀' }], []), true);
  // 全部推到保留期之外：任务本身和那条已确认投递的 outbox 记录。
  f.store.sql.prepare('UPDATE tasks SET state=?, created_at=? WHERE id=?').run('done', old, taskId);
  f.store.sql.prepare('UPDATE outbox SET created_at=? WHERE task_id=?').run(old, taskId);

  // 修复前：这里抛 FOREIGN KEY constraint failed，在调度器里就是进程级崩溃。
  assert.doesNotThrow(() => f.store.pruneTasks(Date.now()), '清理不应抛外键错误');
  assert.ok(f.store.taskById(taskId), '仍被引用的任务必须保留');
});

test('pruneTasks 会清理已取消的旧投递，不再永久占住任务', (t) => {
  const f = fixture(t);
  const old = Date.now() - 40 * 86400000;
  const taskId = f.store.enqueue('p1', 'chat', 'k-cancelled', { text: '早' });
  const task = f.store.claim('p1')!;
  assert.equal(f.store.saveReply(task, [{ type: 'text', text: '早呀' }], []), true);
  f.store.markDelivery(taskId + ':0', 'cancelled', '测试取消');
  f.store.sql.prepare('UPDATE tasks SET created_at=? WHERE id=?').run(old, taskId);
  f.store.sql.prepare('UPDATE outbox SET created_at=? WHERE task_id=?').run(old, taskId);
  f.store.pruneTasks(Date.now());
  assert.equal(f.store.taskById(taskId), undefined, '取消记录清理后任务也应回收');
  assert.equal(
    Number(f.store.sql.prepare('SELECT count(*) AS n FROM outbox WHERE task_id=?').get(taskId)!.n),
    0,
  );
});

test('pruneTasks 会删除既过期又无引用的任务', (t) => {
  const f = fixture(t);
  const old = Date.now() - 40 * 86400000;
  const taskId = f.store.enqueue('p1', 'chat', 'k2', { text: '在吗' });
  f.store.sql.prepare('UPDATE tasks SET state=?, created_at=? WHERE id=?').run('done', old, taskId);
  f.store.pruneTasks(Date.now());
  assert.equal(f.store.taskById(taskId), undefined, '无引用的过期任务应当被清掉');
});

// ---------- 预算不足时必须报预算，而不是伪装成格式错误 ----------

test('最新原话超预算时报上下文预算错误，而不是把原话删掉重试', async (t) => {
  const f = fixture(t, new FakeModel(() => completion({ messages: ['不该被调用'] })), {
    contextTokens: 4096,
  });
  const latest = '这一段话远远超出预算。' + '内容'.repeat(2000);
  f.runtime.accept('p1', 'oversized', latest);
  await f.runtime.drain();
  assert.equal(f.model.calls.length, 0, '超预算时不应发出任何模型请求');
  assert.equal(f.delivered.length, 0, '超预算时不应投递任何内容');
  // 原文完整保留：截断用户的话比失败更糟，她看到的应当是原文加上明确的错误。
  assert.equal(f.store.history('p1')[0].content, latest);
  const task = f.store.issues().tasks[0];
  assert.match(String(task?.error), /上下文预算/, '错误信息应指向预算而不是格式');
});

// ---------- 记忆更新必须真正生效 ----------

test('更正记忆后旧条目被取代，列表里只剩新内容', (t) => {
  const f = fixture(t);
  const msg = f.store.ingest('p1', 'src', '我住在北京').message;
  const version = f.store.peer('p1')!.version;
  const written = f.store.addMemory(
    'p1',
    { content: '用户住在北京', kind: 'stated', sources: [msg.id] },
    version,
  );
  assert.equal(written, true, '首条记忆应当写入');
  const id = f.store.memories('p1')[0]!.id;
  f.store.correctMemory('p1', id, '用户搬到了上海');
  const active = f.store.memories('p1').map((m) => m.content);
  assert.deepEqual(active, ['用户搬到了上海'], '旧记忆应被取代，不能两条并存');
});

// ---------- 表情窗口：提示词给出的都必须能被解析接受 ----------

test('轮换出的表情窗口内每一张都能通过解析校验', async () => {
  const { parseReply, rotateStickers } = await import('@atri/core');
  const all = Array.from({ length: 100 }, (_, i) => ({
    slug: 's' + String(i).padStart(3, '0'),
    description: '表情' + i,
    tags: [],
    file: 'f.png',
  }));
  for (let day = 0; day < 60; day++) {
    const window = rotateStickers(all, [], Date.parse('2026-01-01T00:00:00Z') + day * 86400000);
    const probe = window[window.length - 1]!;
    const reply = parseReply(
      JSON.stringify({
        messages: ['早呀', { type: 'sticker', slug: probe.slug }],
        memoryUpdates: [],
      }),
      window,
    );
    assert.ok(
      reply.parts.some((p) => p.type === 'sticker' && p.slug === probe.slug),
      `第 ${day} 天窗口尾部的表情 ${probe.slug} 被丢弃了`,
    );
  }
});

// ---------- 日记外键：第二张引用 tasks 的表 ----------
//
// outbox 修好之后 diary_sections 还在引用 tasks。任何跑过日记的库都会踩到，
// 而且失败的是同一个 setInterval 里的清理：任务表和 outbox 从此永不收缩，
// 调度器每 60 秒往日志里写一条错误。

test('pruneTasks 不会删除仍被 diary_sections 引用的任务', (t) => {
  const f = fixture(t);
  const old = Date.now() - 40 * 86400000;
  const taskId = f.store.enqueue('p1', 'diary', 'day:old', {}, old);
  f.store.sql.prepare('UPDATE tasks SET state=?, created_at=? WHERE id=?').run('done', old, taskId);
  f.store.sql
    .prepare(
      'INSERT INTO diary_sections(id,peer_id,task_id,ordinal,day,content,sources,created_at) VALUES(?,?,?,?,?,?,?,?)',
    )
    .run('d1', 'p1', taskId, 0, '2026-10-01', '今天的日记', '[]', old);

  assert.doesNotThrow(() => f.store.pruneTasks(Date.now()), '清理不应抛外键错误');
  assert.ok(f.store.taskById(taskId), '日记仍在引用它的生成任务，任务必须保留');
});

// ---------- 私网地址闸门必须两种写法都拦 ----------

test('IPv4 映射地址的十六进制写法不能被当作公网', async () => {
  const { isPrivateAddress } = await import('@atri/net');
  // 点分写法一直是拦的。
  assert.equal(isPrivateAddress('::ffff:127.0.0.1'), true);
  // 十六进制写法曾经漏过去：同一个地址换种写法就能读到回环和云元数据。
  assert.equal(isPrivateAddress('::ffff:7f00:1'), true, '回环的十六进制写法');
  assert.equal(isPrivateAddress('::ffff:a9fe:a9fe'), true, '云元数据 169.254.169.254');
  assert.equal(isPrivateAddress('::ffff:a00:1'), true, '10.0.0.1');
  // 公网地址仍然放行，避免把闸门写成一律拒绝。
  assert.equal(isPrivateAddress('::ffff:808:808'), false, '8.8.8.8 应放行');
});
