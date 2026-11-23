import { test } from 'node:test';
import { tmpOpen, tmpRoot, tmpStore } from './tmp.ts';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { sandboxArgs } from '../src/files.ts';

const newStore = (now = Date.now) => tmpStore('atri-test-', now);

test('沙箱规格：她的窝常驻自愈、能力全卸、只挂作品目录（无密钥无 sock）', () => {
  const args = sandboxArgs('python:3.13-alpine', false, 'Asia/Shanghai', '/srv/atri/data/works');
  const text = args.join(' ');
  // 常驻：无 --rm 无 --read-only（可写层持久），崩溃由 unless-stopped 自愈
  assert.ok(!text.includes('--rm') && !text.includes('--read-only'));
  assert.deepEqual([...args].splice(args.indexOf('--restart'), 2), ['--restart', 'unless-stopped']);
  // 能力全卸 + 无新特权 + 资源三限
  for (const flag of ['--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=64', '--memory=512m', '--cpus=1'])
    assert.ok(args.includes(flag), flag);
  // 挂载：只挂 works 到 /work；网络默认 none，开联网为 bridge
  assert.ok(args.includes('type=bind,src=/srv/atri/data/works,dst=/work'));
  assert.deepEqual([...args].splice(args.indexOf('--network'), 2), ['--network', 'none']);
  const withNet = sandboxArgs('img', true, 'tz', 'w');
  assert.deepEqual([...withNet].splice(withNet.indexOf('--network'), 2), ['--network', 'bridge']);
  // 入口是常驻哨兵进程（sleep infinity），不是一次性 sh
  assert.deepEqual(args.slice(-2), ['sleep', 'infinity']);
});

test('入站去重与轮次认领：连发合并、过期任务取消', () => {
  const store = newStore();
  const target = { kind: 'c2c' as const, id: 'user1' };
  const peer0 = store.ensurePeer(target);
  peer0.enabled = true;
  store.savePeer(peer0);
  const incoming = { key: 'm1', target, messageId: 'm1', author: 'user1', text: '在吗', at: store.now(), attachments: [] };
  const first = store.receive(incoming, 0);
  assert.ok(first);
  assert.equal(store.receive(incoming, 0), undefined); // 同 key 去重
  const peer = store.peer('c2c:user1')!;
  store.schedule('beat:c2c:user1', peer.id, 'beat', '拍', store.now() - 1);
  const turn = store.claim(peer.id)!;
  assert.ok(turn);
  assert.equal(turn.jobs.length, 2); // chat + beat 合并成一轮
  assert.equal(store.claim(peer.id), undefined); // 单飞行轮
  store.finish(turn, 'done');
  assert.equal(store.get(`seen:${peer.id}`, 0), turn.snapshot);
  // 过期的 commitment job 在认领时被取消
  store.schedule('commitment:x:1', peer.id, 'commitment', '过期', store.now() - 5, { id: 'x', version: 1, due: 1 });
  const turn2 = store.claim(peer.id);
  assert.equal(turn2, undefined);
  store.close();
});

test('记忆：同内容合并、slot 竞争与 supersedes', () => {
  const store = newStore();
  const peer = 'c2c:user1';
  const event = store.append(peer, 'received', { text: '我只喝美式' })!;
  const event2 = store.append(peer, 'received', { text: '其实最近改喝拿铁了' })!;
  const m1 = store.saveMemory(peer, { kind: 'fact', content: '只喝美式', gist: '咖啡偏好', slot: '咖啡', sources: [event.id], importance: 0.8, emotion: 0 });
  assert.equal(store.memories(peer).length, 1);
  // 同内容保存 → 合并来源，不新增
  const same = store.saveMemory(peer, { kind: 'fact', content: '只喝美式', gist: '咖啡偏好', sources: [event.id] });
  assert.equal(same.id, m1.id);
  assert.equal(store.memories(peer).length, 1);
  // 同槽新记忆 → 旧记忆被替代且带干扰
  const m2 = store.saveMemory(peer, { kind: 'fact', content: '改喝拿铁', gist: '咖啡偏好', slot: '咖啡', sources: [event2.id] });
  const all = store.memories(peer);
  assert.equal(all.length, 1);
  assert.equal(all[0]!.id, m2.id);
  assert.ok(m2.interference > 0 || m2.detail === 1);
  // 词面召回
  const hits = store.searchMemories(peer, '拿铁');
  assert.equal(hits.length, 1);
  // 演练提升巩固
  store.rehearsed([m2.id]);
  assert.ok(store.memories(peer)[0]!.consolidation > 0);
  store.close();
});

test('念头：同证据去重、drop 退场', () => {
  const store = newStore();
  const peer = 'c2c:user1';
  const event = store.append(peer, 'received', { text: '下周要去爬山' })!;
  const t1 = store.changeThought(peer, { op: 'keep', topic: '爬山', meaning: '想提醒他带水', sources: [event.id] })!;
  const t2 = store.changeThought(peer, { op: 'keep', topic: '爬山', meaning: '想提醒他带水', sources: [event.id] })!;
  assert.equal(t1.id, t2.id); // 同证据去重
  const dropped = store.changeThought(peer, { op: 'drop', id: t1.id, sources: [] })!;
  assert.equal(dropped.state, 'dropped');
  assert.equal(store.thoughts(peer).find(t => t.id === t1.id)!.state, 'dropped');
  assert.throws(() => store.changeThought(peer, { op: 'keep', topic: '空 sources', meaning: 'x', sources: [] }));
  store.close();
});

test('约定：版本化、afterPart 效果在平台接收后立约、履约校验在 mind 层', () => {
  const store = newStore();
  const peer = 'c2c:user1';
  const event = store.append(peer, 'received', { text: '明天提醒我开会' })!;
  const c = store.changeCommitment(peer, { op: 'keep', kind: 'reminder', content: '提醒开会', due: store.now() + 86400000, sources: [event.id] });
  assert.equal(c.version, 1);
  assert.ok(store.jobs(peer).some(j => j.kind === 'commitment' && j.data.id === c.id));
  // 修改内容 → 版本 +1，旧 job 取消
  const c2 = store.changeCommitment(peer, { op: 'keep', id: c.id, content: '提醒开产品会', sources: [event.id] });
  assert.equal(c2.version, 2);
  assert.equal(c2.content, '提醒开产品会');
  // 周期约定 complete 后续期
  const daily = store.changeCommitment(peer, { op: 'keep', kind: 'concern', content: '问早安', due: store.now() + 86400000, recurrence: { unit: 'day', interval: 1, timezone: 'Asia/Shanghai' }, sources: [event.id] });
  const done = store.changeCommitment(peer, { op: 'complete', id: daily.id, sources: [event.id] });
  assert.equal(done.status, 'open');
  assert.ok(done.dueAt > store.now());
  store.close();
});

test('outbox 生命周期：draft → 发送 → unknown 可人工裁决；新消息取消待发草稿', () => {
  const store = newStore();
  const peer = 'c2c:user1';
  store.ensurePeer({ kind: 'c2c', id: 'user1' });
  const event = store.append(peer, 'received', { text: '嗨' })!;
  const turn = { id: 't1', episode: 'ep', peer, snapshot: event.seq, jobs: [], allowed: new Set([event.id]) };
  store.draft(turn, [{ type: 'text', text: '在的' }, { type: 'text', text: '怎么啦' }], [{}, {}], [store.now(), store.now() + 2400]);
  const all = store.deliveries(peer);
  assert.equal(all.length, 2);
  const byOrdinal = [...all].sort((a, b) => a.ordinal - b.ordinal);
  assert.ok(byOrdinal[1]!.dueAt > byOrdinal[0]!.dueAt); // 气泡节奏
  assert.equal(store.nextEnvelope(peer)!.id, byOrdinal[0]!.id);
  assert.ok(store.startSend(byOrdinal[0]!.id, { msg_type: 0 }));
  assert.equal(store.nextEnvelope(peer), undefined); // sending 中不取下一条
  store.settleSend(byOrdinal[0]!.id, 'unknown', undefined, '超时');
  assert.ok(store.resolveSend(byOrdinal[0]!.id, true));
  assert.equal(store.deliveries(peer).find(d => d.id === byOrdinal[0]!.id)!.status, 'accepted');
  assert.ok(store.recent(peer).some(e => e.kind === 'accepted'));
  // 第二条：新消息到达取消 pending 草稿
  const event2 = store.receive({ key: 'm2', target: { kind: 'c2c', id: 'user1' }, messageId: 'm2', author: 'user1', text: '喂？', at: store.now(), attachments: [] }, 0);
  assert.ok(event2);
  assert.equal(store.deliveries(peer).find(d => d.id === byOrdinal[1]!.id)!.status, 'cancelled');
  store.close();
});

test('摘要段：保存与合并', () => {
  const store = newStore();
  const peer = 'c2c:user1';
  store.ensurePeer({ kind: 'c2c', id: 'user1' });
  const s1 = store.saveSegment(peer, 1, 10, '早期摘要');
  const s2 = store.saveSegment(peer, 11, 20, '中期摘要');
  assert.equal(store.segments(peer).length, 2);
  const merged = store.mergeSegments(peer, [s1.id, s2.id], '合并摘要');
  assert.equal(store.segments(peer).length, 1);
  assert.equal(store.segments(peer)[0]!.text, '合并摘要');
  assert.equal(merged.from, 1);
  store.close();
});

test('recover：中断状态全部回到可恢复语义', () => {
  const dir = tmpRoot('atri-test-');
  const store = tmpOpen(join(dir, 'atri.db'));
  const peer = 'c2c:user1';
  store.ensurePeer({ kind: 'c2c', id: 'user1' });
  const event = store.append(peer, 'received', { text: '嗨' })!;
  const turn = { id: 't1', episode: 'ep', peer, snapshot: event.seq, jobs: [], allowed: new Set<string>() };
  store.draft(turn, [{ type: 'text', text: 'x' }], [{}], [store.now()]);
  const envelope = store.deliveries(peer)[0]!;
  store.startSend(envelope.id, {});
  // 模拟进程中断后的 recover（新实例，同一库）
  const store2 = tmpOpen(join(dir, 'atri.db'));
  assert.equal(store.deliveries(peer)[0]!.status, 'unknown');
  store2.close();
  store.close();
});

test('心情轨迹与她的状态：feeling 设置、每日黏人度、印象', () => {
  const store = newStore();
  const peer = 'c2c:user1';
  store.ensurePeer({ kind: 'c2c', id: 'user1' });
  store.setFeeling(peer, { label: '开心', valence: 0.5, arousal: 0.2, patience: 0.1, reason: '聊得来', sources: [], at: store.now() });
  assert.equal(store.feeling(peer)!.label, '开心');
  assert.equal(store.get('moodlog:' + peer, []).length, 1);
  const self1 = store.self(peer);
  assert.ok(self1.closeness > 0);
  store.saveSelfPatch(peer, { activity: '画画', interests: ['水彩'] });
  assert.equal(store.self(peer).activity, '画画');
  assert.deepEqual(store.self(peer).interests, ['水彩']);
  store.saveImpressions(peer, { beliefs: [{ text: '他夜猫子', basis: [] }], updatedAt: store.now() });
  assert.equal(store.impressions(peer)!.beliefs.length, 1);
  store.close();
});
