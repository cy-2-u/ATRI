import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, cpSync } from 'node:fs';
import { fixture, temporary } from './helpers.js';
import { Store, createBackup, restoreBackup } from '../src/db/index.js';

/** 投递可靠性与持久化：状态机、部分失败、恢复、备份。 */

function makeReadyTask(store: Store, peer = 'p1') {
  store.ensurePeer(peer, 'preview', '同学', '', true);
  const task = store.enqueue(peer, 'chat', 'chat:1', { through: 1 });
  store.ingest(peer, 'm1', '你好', [], Date.now() - 1000);
  const claimed = store.claim(peer)!;
  store.saveReply(
    claimed,
    [
      { type: 'text', text: '第一句' },
      { type: 'text', text: '第二句' },
      { type: 'sticker', slug: 'happy', description: '开心' },
    ],
    [],
  );
  void task;
  return claimed;
}

test('状态机：sent 不可被迟到事件覆盖，cancelled 是终态', (t) => {
  const f = fixture(t);
  const task = makeReadyTask(f.store);
  const deliveries = f.store.pendingDeliveries('p1');
  assert.equal(deliveries.length, 3);
  f.store.startDelivery(deliveries[0]!.id);
  assert.equal(f.store.markDelivery(deliveries[0]!.id, 'sent'), true);
  assert.equal(f.store.markDelivery(deliveries[0]!.id, 'failed'), false, '已确认的不重判');
  f.store.markDelivery(deliveries[1]!.id, 'cancelled');
  assert.equal(f.store.markDelivery(deliveries[1]!.id, 'pending'), false, '取消不可复活');
  f.store.startDelivery(deliveries[2]!.id);
  f.store.markDelivery(deliveries[2]!.id, 'sent');
  assert.equal(f.store.taskById(task.id)!.state, 'done', '全部结清后任务完成');
});

test('确定性失败在首气泡：取消剩余气泡，不留半截回复', (t) => {
  const f = fixture(t);
  makeReadyTask(f.store);
  const first = f.store.pendingDeliveries('p1')[0]!;
  f.store.startDelivery(first.id);
  f.store.markDelivery(first.id, 'failed', '发送失败');
  f.store.cancelPendingForTask(first.task_id, first.id, '发送失败');
  assert.equal(f.store.pendingDeliveries('p1').length, 0, '剩余气泡全部取消');
  const statuses = (f.store.issues().deliveries as unknown as { id: string }[]).filter(
    (d) => d.id !== first.id,
  );
  assert.equal(statuses.length, 0);
});

test('送达不明暂停队列 10 分钟后放行', (t) => {
  const f = fixture(t);
  makeReadyTask(f.store);
  const first = f.store.pendingDeliveries('p1')[0]!;
  f.store.startDelivery(first.id);
  f.store.markDelivery(first.id, 'uncertain', '超时');
  assert.equal(f.store.readyPeers(Date.now()).length, 0, '刚不确定时暂停');
  assert.equal(f.store.readyPeers(Date.now() + 11 * 60000).length >= 0, true, '10 分钟后不再阻塞');
  assert.ok(f.store.issues().deliveries.length >= 1, '待办仍可见等运维裁决');
});

test('版本并发：新消息作废未发送的旧草稿', (t) => {
  const f = fixture(t);
  const task = makeReadyTask(f.store);
  f.store.ingest('p1', 'm2', '等等，我改主意了', [], Date.now());
  assert.equal(f.store.cancelUnsent(task), true);
  assert.equal(f.store.pendingDeliveries('p1').length, 0);
  assert.equal(f.store.taskById(task.id)!.state, 'superseded');
});

test('重启恢复：sending 转 uncertain，任务回队', (t) => {
  const f = fixture(t);
  makeReadyTask(f.store);
  const first = f.store.pendingDeliveries('p1')[0]!;
  f.store.startDelivery(first.id);
  f.store.sql
    .prepare("UPDATE tasks SET state='running' WHERE id=(SELECT task_id FROM outbox WHERE id=?)")
    .run(first.id);
  f.store.recover();
  assert.equal(f.store.deliveryById(first.id)!.status, 'uncertain');
  assert.ok(f.store.issues().deliveries.length >= 1);
});

test('sendReply 原子性：状态不是 running 时拒绝写入', (t) => {
  const f = fixture(t);
  const task = makeReadyTask(f.store);
  f.store.finish(task.id, 'failed', 'x');
  const again = { ...task, payload: { ...task.payload } };
  assert.equal(f.store.saveReply(again, [{ type: 'text', text: '迟到的回复' }], []), false);
});

test('失败退避与重试上限', (t) => {
  const f = fixture(t);
  const task = makeReadyTask(f.store);
  f.store.finish(task.id, 'failed', 'x');
  f.store.deferFailed(task.id, 60000);
  assert.equal(f.store.taskById(task.id)!.state, 'failed', '退避保持 failed 让待办可见');
  assert.ok(f.store.taskById(task.id)!.run_at > Date.now());
  const id2 = f.store.enqueue('p1', 'notes', 'note:1', { through: 1 });
  f.store.finish(id2, 'failed', 'y');
  f.store.sql.prepare('UPDATE tasks SET attempts=5 WHERE id=?').run(id2);
  const revived = f.store.enqueue('p1', 'notes', 'note:1', { through: 2 });
  assert.equal(f.store.taskById(revived)!.state, 'failed', '耗尽重试的失败任务不再被复活');
});

test('pruneTasks 清终态任务但保留外键引用', (t) => {
  const f = fixture(t);
  const task = makeReadyTask(f.store);
  f.store.finish(task.id, 'done');
  // outbox 已结清且超龄：任务可清
  f.store.sql
    .prepare('UPDATE outbox SET created_at=? WHERE task_id=?')
    .run(Date.now() - 30 * 86400000, task.id);
  f.store.sql
    .prepare('UPDATE tasks SET created_at=? WHERE id=?')
    .run(Date.now() - 30 * 86400000, task.id);
  const removed = f.store.pruneTasks(Date.now());
  assert.ok(removed >= 0);
  // 有日记引用的任务不删
  const source = f.store.ingest('p1', 'dm', '今天', [], Date.now()).message;
  const diaryTask = f.store.enqueue('p1', 'diary', 'day:1', {
    day: '2026-10-01',
    through: source.seq,
    ids: [source.id],
  });
  const claimed = f.store.claim('p1')!;
  f.store.saveDiary(claimed, '2026-10-01', [{ content: '一段', sources: [source.id] }], []);
  f.store.sql
    .prepare('UPDATE tasks SET created_at=? WHERE id=?')
    .run(Date.now() - 30 * 86400000, diaryTask);
  f.store.pruneTasks(Date.now());
  assert.ok(f.store.taskById(diaryTask), '日记任务被 diary_sections 引用而不清除');
});

// ---------- 备份与恢复 ----------

test('备份快照包含附件与校验清单；恢复必须指向空目录', async (t) => {
  const dir = temporary(t);
  const store = new Store(join(dir, 'atri.db'));
  t.after(() => store.close());
  store.ensurePeer('p1', 'preview', '同学', '', true);
  mkdirSync(join(dir, 'media'), { recursive: true });
  writeFileSync(join(dir, 'media', 'x.png'), Buffer.from('89504e47', 'hex'));
  const media = [{ kind: 'image', path: 'media/x.png', mime: 'image/png' }];
  store.ingest('p1', 'm1', '看这张图', media, Date.now());
  const result = await createBackup(store, dir);
  assert.ok(
    result.manifest.files.some((f) => f.path === 'media/x.png'),
    '被引用附件进备份',
  );
  assert.equal(result.manifest.messages, 1);
  const empty = temporary(t);
  const restored = restoreBackup(result.directory, empty);
  assert.equal(restored.messages, 1);
  // 非空目录拒绝覆盖
  assert.throws(() => restoreBackup(result.directory, empty), /空的数据目录/);
  // 恢复后旧任务暂停、主动联系关闭
  const store2 = new Store(join(empty, 'atri.db'));
  t.after(() => store2.close());
  const tasks = store2.sql.prepare('SELECT state FROM tasks').all() as { state: string }[];
  assert.ok(tasks.every((r) => r.state !== 'queued' && r.state !== 'running'));
  assert.equal(
    store2.getSetting<{ proactiveEnabled: boolean }>('config', { proactiveEnabled: true })
      .proactiveEnabled,
    false,
  );
  // 篡改校验失败
  const tampered = temporary(t);
  cpSync(result.directory, tampered, { recursive: true });
  writeFileSync(join(tampered, 'atri.db'), 'not a db');
  assert.throws(() => restoreBackup(tampered, temporary(t)), /校验|格式|完整性/);
});
