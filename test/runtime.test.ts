import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpRoot, tmpStore } from './tmp.ts';
import { join } from 'node:path';
import { Runtime } from '../src/runtime.ts';
import { Files } from '../src/files.ts';
import { validateConfig, defaults, type Config } from '../src/config.ts';

const config: Config = validateConfig({ ...defaults('人格'), life: { ...defaults().life, timezone: 'Asia/Shanghai', enabled: true, beatMinutes: 90, diaryHour: 23 } });
const getConfig = (): Config => config;

test('绑定：她只属于一个人（第一个私聊即绑定，陌生私聊不进她的世界）', () => {
  const store = tmpStore('atri-test-');
  const runtime = new Runtime(store, getConfig, { think: async () => { throw new Error('不该被调用'); } } as never, {} as never, {} as never, () => undefined);
  const at = store.now();
  // 第一条私聊即绑定
  assert.equal(runtime.receive({ key: 'k1', target: { kind: 'c2c', id: 'userA' }, messageId: 'm1', author: 'a', text: '在吗', at, attachments: [] }), true);
  const bound = store.peers().find(p => p.id !== 'c2c:preview');
  assert.equal(bound?.id, 'c2c:userA');
  // 陌生私聊不再接收
  assert.equal(runtime.receive({ key: 'k3', target: { kind: 'c2c', id: 'userB' }, messageId: 'm3', author: 'c', text: '你好', at, attachments: [] }), false);
  assert.equal(store.peer('c2c:userB'), undefined);
  // 绑定会话照常
  assert.equal(runtime.receive({ key: 'k4', target: { kind: 'c2c', id: 'userA' }, messageId: 'm4', author: 'a', text: '又来了', at, attachments: [] }), true);
  // 预演不受绑定限制（管理员功能）
  assert.equal(runtime.receive({ key: 'k5', target: { kind: 'c2c', id: 'preview' }, messageId: 'm5', author: '本地管理员', text: '预演', at, attachments: [] }), true);
});

test('apply：情绪/记忆/念头/日记/印象落账，气泡节奏与表情剔除，intents 排程', () => {
  const store = tmpStore('atri-test-');
  const runtime = new Runtime(store, getConfig, { think: async () => { throw new Error('不该被调用'); } } as never, {} as never, {} as never, () => undefined);
  const peer = store.ensurePeer({ kind: 'c2c', id: 'user1' }).id;
  const r1 = store.append(peer, 'received', { text: '我下周生日' })!;
  const r2 = store.append(peer, 'received', { text: '会给我买蛋糕吗' })!;
  store.set('stickers', [{ slug: 'happy', path: 'x', description: '开心' }]);
  const turn = { id: 't1', episode: 'ep1', peer, snapshot: r2.seq, jobs: [{ id: 'j1', peer, kind: 'chat' as const, reason: 'r', dueAt: store.now(), data: {}, attempts: 0 }], allowed: new Set([r1.id, r2.id]) };
  const at = store.now() + 86400000;
  runtime.apply(turn, {
    parts: [
      { type: 'text', text: '生日我记得的', reply: r1.id },
      { type: 'sticker', slug: 'happy' },
      { type: 'sticker', slug: '不存在' }, // 目录外 → 剔除
      { type: 'text', text: '到时候陪你过', notified: [] },
    ],
    feeling: { label: '期待', valence: 0.5, arousal: 0.4, patience: 0.3, reason: '他提到生日', sources: [r1.id] },
    reflection: '想亲手做个蛋糕，虽然大概率会翻车',
    activity: '翻蛋糕教程',
    memories: [{ kind: 'fact', content: '生日在下周', gist: '生日时间', sources: [r1.id], importance: 0.9, emotion: 0.3 }],
    commitments: [{ op: 'keep', kind: 'promise', content: '生日陪他过', due: at, sources: [r1.id], afterPart: 3 }],
    thoughts: [{ op: 'keep', topic: '学做蛋糕', meaning: '想亲手做一个', sources: [r2.id] }],
    diary: undefined,
    intents: [{ reason: '当天确认他的安排', at: at }],
  });
  // 气泡：目录外表情被剔除，剩 3 条；承诺绑定最后一条
  const outbox = store.deliveries(peer);
  assert.equal(outbox.length, 3);
  const seq = [...outbox].sort((a, b) => a.ordinal - b.ordinal);
  assert.ok(seq[1]!.dueAt > seq[0]!.dueAt && seq[2]!.dueAt > seq[1]!.dueAt); // 打字节奏
  assert.equal((seq[2]!.effects.commitments as unknown[]).length, 1);
  // 情绪与心事
  assert.equal(store.feeling(peer)!.label, '期待');
  assert.ok(store.recent(peer).some(e => e.kind === 'reflection' && String(e.data.text).includes('蛋糕')));
  // 记忆与念头
  assert.equal(store.memories(peer).length, 1);
  const thoughts = store.thoughts(peer);
  assert.equal(thoughts.length, 1);
  assert.equal(thoughts[0]!.state, 'idle');
  // 承诺未立（绑定气泡，平台接收后才立）
  assert.equal(store.commitments(peer).length, 0);
  // 模拟平台接收最后一条 → 立约
  const last = seq[2]!;
  assert.ok(store.startSend(last.id, { msg_type: 0, msg_id: 'm1', msg_seq: 1 }));
  store.settleSend(last.id, 'accepted', 'p1');
  const promises = store.commitments(peer);
  assert.equal(promises.length, 1);
  assert.equal(promises[0]!.status, 'open');
  // intents 已排程
  assert.ok(store.jobs(peer).some(j => j.kind === 'reflection'));
  assert.equal(store.get(`seen:${peer}`, 0), turn.snapshot);
  store.close();
});

test('夜间拍：日记与印象落账、parts 空校验在 mind 层', () => {
  const store = tmpStore('atri-test-');
  const runtime = new Runtime(store, getConfig, { think: async () => { throw new Error('x'); } } as never, {} as never, {} as never, () => undefined);
  const peer = store.ensurePeer({ kind: 'c2c', id: 'user2' }).id;
  const r1 = store.append(peer, 'received', { text: '晚安' })!;
  const turn = { id: 't2', episode: 'ep2', peer, snapshot: r1.seq, jobs: [{ id: 'j2', peer, kind: 'night' as const, reason: '夜', dueAt: store.now(), data: {}, attempts: 0 }], allowed: new Set([r1.id]) };
  runtime.apply(turn, {
    parts: [],
    feeling: undefined,
    memories: [],
    commitments: [],
    diary: { content: '今天他说了晚安', emotion: 0.4, sources: [r1.id] },
    impressions: { beliefs: [{ text: '他习惯晚睡', basis: [r1.id] }] },
    intents: [],
  });
  const diary = store.eventsKind(peer, ['diary'], 0, Number.MAX_SAFE_INTEGER, 10);
  assert.equal(diary.length, 1);
  assert.equal(diary[0]!.data.content, '今天他说了晚安');
  assert.equal(store.impressions(peer)!.beliefs.length, 1);
  assert.equal(store.deliveries(peer).length, 0); // 夜间不发消息
  store.close();
});

test('ensureLife：自主会话有心跳与夜间拍，非自主无夜间', () => {
  const store = tmpStore('atri-test-');
  const runtime = new Runtime(store, getConfig, { think: async () => { throw new Error('x'); } } as never, {} as never, {} as never, () => undefined);
  const c2c = store.ensurePeer({ kind: 'c2c', id: 'user3' });
  c2c.enabled = true; c2c.autonomous = true;
  store.savePeer(c2c);
  runtime.reconfigure();
  const c2cJobs = store.jobs(c2c.id);
  assert.ok(c2cJobs.some(j => j.kind === 'beat'));
  assert.ok(c2cJobs.some(j => j.kind === 'night'));
  // 拍都在未来且不早于现在
  for (const job of c2cJobs) assert.ok(job.dueAt >= store.now() - 1000, `job ${job.kind} 应在未来`);
  // 关闭自主 → 拍被清空
  c2c.autonomous = false;
  store.savePeer(c2c);
  runtime.reconfigure();
  assert.ok(!store.jobs(c2c.id).some(j => j.kind === 'beat'));
  store.close();
});

const until = async (fn: () => boolean, ms = 3000, what = '条件'): Promise<void> => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return; await new Promise(r => setTimeout(r, 40)); }
  assert.fail(`${what} 超时`);
};

test('盲区钉死：心跳任务终态失败后必须自愈（不能静默停跳）', () => {
  const store = tmpStore('atri-test-');
  const runtime = new Runtime(store, getConfig, { think: async () => { throw new Error('x'); } } as never, {} as never, {} as never, () => undefined);
  const peer = store.ensurePeer({ kind: 'c2c', id: 'user7' }).id;
  const p = store.peer(peer)!; p.enabled = true; p.autonomous = true; store.savePeer(p);
  store.schedule(`beat:${peer}`, peer, 'beat', '拍', store.now() - 1);
  const turn = store.claim(peer)!;
  store.finish(turn, 'failed', '渠道拒绝生成', false); // retry=false → beat 终态失败
  runtime.reconfigure(); // ensureLife 必须把死掉的心跳重新排上
  assert.ok(store.jobs(peer).some(j => j.kind === 'beat'), '心跳终态失败后没有被重新排上——她会永久失联');
  assert.ok(store.jobs(peer).some(j => j.kind === 'night'), '夜间拍同理');
  store.close();
});

test('投递管道：主动发送 → accepted 事件 + 身体记账 + 额度记账', async () => {
  const store = tmpStore('atri-test-');
  let activeCount = 0;
  const transport = {
    passiveRequest: () => ({}),
    allowedAt: () => store.now(),
    recordActive: () => { activeCount++; },
    send: async () => 'pid-1',
    upload: async () => 'file-info',
  };
  const runtime = new Runtime(store, getConfig, { think: async () => { throw new Error('x'); } } as never, transport as never, {} as never, () => undefined);
  const peer = store.ensurePeer({ kind: 'c2c', id: 'user8' }).id;
  const p = store.peer(peer)!; p.enabled = true; store.savePeer(p);
  const ev = store.append(peer, 'received', { text: 'hi' })!;
  const turn = { id: 't', episode: 'e', peer, snapshot: ev.seq, jobs: [] as never[], allowed: new Set<string>() };
  store.draft(turn, [{ type: 'text', text: '在的' }], [{}], [store.now()]);
  const beforeQQ = config.qq.enabled;
  config.qq.enabled = true;
  try {
    runtime.start();
    await until(() => store.deliveries(peer)[0]?.status === 'accepted', 3000, '投递');
    const d = store.deliveries(peer)[0]!;
    assert.equal(d.platformId, 'pid-1');
    assert.ok(store.recent(peer).some(e => e.kind === 'accepted' && e.data.text === '在的'));
    assert.ok(activeCount === 1, '主动消息必须记账');
    assert.ok((store.peer(peer)!.lastAccepted ?? 0) > 0);
    assert.ok(store.self(peer).lastDeliveredAt > 0, '送达必须推进她的身体状态');
  } finally {
    config.qq.enabled = beforeQQ;
    await runtime.stop();
    store.close();
  }
});

test('投递管道：额度未到 → defer 等待，不重新思考', async () => {
  const store = tmpStore('atri-test-');
  const transport = {
    passiveRequest: () => ({}),
    allowedAt: () => store.now() + 60000,
    recordActive: () => undefined,
    send: async () => { throw new Error('不该发送'); },
    upload: async () => 'x',
  };
  const runtime = new Runtime(store, getConfig, { think: async () => { throw new Error('x'); } } as never, transport as never, {} as never, () => undefined);
  const peer = store.ensurePeer({ kind: 'c2c', id: 'user9' }).id;
  const p = store.peer(peer)!; p.enabled = true; store.savePeer(p);
  const ev = store.append(peer, 'received', { text: 'hi' })!;
  const turn = { id: 't', episode: 'e', peer, snapshot: ev.seq, jobs: [] as never[], allowed: new Set<string>() };
  store.draft(turn, [{ type: 'text', text: '在的' }], [{}], [store.now()]);
  const beforeQQ = config.qq.enabled;
  config.qq.enabled = true;
  try {
    runtime.start();
    await until(() => (store.deliveries(peer)[0]?.error ?? '').includes('额度等待'), 3000, 'defer');
    assert.equal(store.deliveries(peer)[0]!.status, 'pending');
    assert.ok(store.deliveries(peer)[0]!.dueAt > store.now());
  } finally {
    config.qq.enabled = beforeQQ;
    await runtime.stop();
    store.close();
  }
});

test('投递管道：主动权限关闭 → 确定性失败（不是未知）', async () => {
  const store = tmpStore('atri-test-');
  const transport = {
    passiveRequest: () => ({}),
    allowedAt: () => store.now(),
    recordActive: () => undefined,
    send: async () => { throw new Error('不该发送'); },
    upload: async () => 'x',
  };
  const runtime = new Runtime(store, getConfig, { think: async () => { throw new Error('x'); } } as never, transport as never, {} as never, () => undefined);
  const peer = store.ensurePeer({ kind: 'c2c', id: 'user10' }).id;
  const p = store.peer(peer)!; p.enabled = true; p.activeAllowed = false; store.savePeer(p);
  const ev = store.append(peer, 'received', { text: 'hi' })!;
  const turn = { id: 't', episode: 'e', peer, snapshot: ev.seq, jobs: [] as never[], allowed: new Set<string>() };
  store.draft(turn, [{ type: 'text', text: '在的' }], [{}], [store.now()]);
  const beforeQQ = config.qq.enabled;
  config.qq.enabled = true;
  try {
    runtime.start();
    await until(() => store.deliveries(peer)[0]?.status === 'failed', 3000, 'failed');
    assert.ok((store.deliveries(peer)[0]!.error ?? '').includes('主动接收'));
  } finally {
    config.qq.enabled = beforeQQ;
    await runtime.stop();
    store.close();
  }
});

test('并发交错：思考中到达新消息 → 当前轮作废并合并续答', async () => {
  const store = tmpStore('atri-test-');
  const files = new Files(join(tmpRoot('atri-test-'), 'works'), getConfig); await files.init();
  const before = JSON.stringify({ url: config.primary.url, key: config.primary.key, model: config.primary.model });
  config.primary.url = 'http://127.0.0.1:9'; config.primary.key = 'k'; config.primary.model = 'm'; // ready() 为真才进思考
  const mind = { think: async (_turn: unknown, signal: AbortSignal) => { await new Promise((_r, rej) => signal.addEventListener('abort', () => rej(new Error('中止')))); throw new Error('不该走到这'); } };
  const runtime = new Runtime(store, getConfig, mind as never, {} as never, files, () => undefined);
  const target = { kind: 'c2c' as const, id: 'user11' };
  const p = store.ensurePeer(target); p.enabled = true; store.savePeer(p);
  try {
    runtime.start();
    runtime.receive({ key: 'm1', target, messageId: 'm1', author: 'u', text: '第一句', at: store.now(), attachments: [] });
    await until(() => runtime.status().thinking === 'c2c:user11', 3000, '思考开始');
    runtime.receive({ key: 'm2', target, messageId: 'm2', author: 'u', text: '第二句', at: store.now(), attachments: [] });
    // 被打断的轮必须作废；续答轮会立即被重新认领，所以不断言"无运行中轮次"
    await until(() => store.sql("SELECT state FROM turns WHERE state='superseded'").all().length >= 1, 3000, '轮次作废');
    const states = store.sql('SELECT state FROM turns').all().map(r => String(r.state));
    assert.ok(states.includes('superseded'), `被新消息打断的轮应作废，实际: ${states.join(',')}`);
    // 被打断后必须存在"合并续答"的 chat 任务（pending 或已被重新认领为 running）
    await until(() => Number(store.sql("SELECT COUNT(*) c FROM jobs WHERE peer='c2c:user11' AND kind='chat' AND state IN ('pending','running')").get()!.c) >= 1, 3000, '续答任务');
  } finally {
    const saved = JSON.parse(before) as { url: string; key: string; model: string };
    config.primary.url = saved.url; config.primary.key = saved.key; config.primary.model = saved.model;
    await runtime.stop();
    store.close();
  }
});
