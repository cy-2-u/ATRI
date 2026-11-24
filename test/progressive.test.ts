import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpRoot, tmpOpen, tmpStore } from './tmp.ts';
import { join } from 'node:path';
import { Runtime, cleanBubbleText } from '../src/runtime.ts';
import { validateConfig, defaults, type Config } from '../src/config.ts';
import { Store, type Turn } from '../src/store.ts';
import type { Thought } from '../src/types.ts';

const config: Config = validateConfig({ ...defaults('人格'), life: { ...defaults().life, timezone: 'Asia/Shanghai', enabled: true } });
const getConfig = (): Config => config;

const makeTurn = (store: Store, peer: string): Turn => ({ id: 't-prog', episode: 'ep-prog', peer, snapshot: store.highwater(peer), jobs: [{ id: 'j-prog', peer, kind: 'chat' as const, reason: 'r', dueAt: store.now(), data: {}, attempts: 0 }], allowed: new Set<string>() });

/** 场景 1：渐进正常落账——sink.draft 入队 → settle accepted（pending 承诺只记事件不立约）
 *  → apply 回填（以接收事件为来源走 changeCommitment）→ 账本闭环、failure 零落账。 */
test('渐进闭环：sink 捕获 → 平台接收 → apply 回填立约', () => {
  const store = tmpStore('atri-prog-');
  const runtime = new Runtime(store, getConfig, { think: async () => { throw new Error('x'); } } as never, {} as never, {} as never, () => undefined);
  const peer = store.ensurePeer({ kind: 'c2c', id: 'p1' }).id;
  const r1 = store.append(peer, 'received', { text: '下周记得叫我' })!;
  const turn = makeTurn(store, peer);
  turn.allowed.add(r1.id);
  // 渐进捕获：sink.draft 带 pending 承诺（对齐 mind.ts onPart 的真实调用形态）
  const captured = [{ op: 'keep' as const, kind: 'reminder' as const, content: '下周叫他', due: store.now() + 86400000, sources: [r1.id], afterPart: 0 }];
  const effects: Record<string, unknown> = { commitments: captured };
  const id = store.draftOne(turn, 0, { type: 'text', text: '好，我记着' }, effects, store.now(), true);
  // 平台接收：pending 承诺只标记 acceptedEvent，不立即立约
  assert.ok(store.startSend(id, { msg_type: 0, msg_id: 'm', msg_seq: 1 }));
  assert.ok(store.settleSend(id, 'accepted', 'pid'));
  assert.equal(store.commitments(peer).length, 0, 'pending 承诺在 settle 时不立约');
  const acceptedEvent = store.eventByDedupe(`accepted:${id}`);
  assert.ok(acceptedEvent, '接收事件必须存在');
  // 思考落账：apply 全量校验通过，回填立约
  const thought: Thought = { parts: [{ type: 'text', text: '好，我记着' }], memories: [], commitments: captured, intents: [] };
  runtime.apply(turn, thought);
  const commitments = store.commitments(peer);
  assert.equal(commitments.length, 1, 'apply 必须回填立约');
  assert.ok(commitments[0]!.sources.includes(acceptedEvent!.id), `立约来源必须含平台接收事件（sources=${JSON.stringify(commitments[0]!.sources)} accepted=${acceptedEvent!.id}）`);
  assert.ok(!store.recent(peer).some(e => e.kind === 'failure'), '闭环内不得落 failure');
  store.close();
});

/** 场景 2：渐进气泡 accepted 早于 apply（settle 先到）——apply 走 backfillAccepted 分支。 */
test('渐进闭环：气泡已被接收时 apply 以接收事件补立约（backfill 分支）', () => {
  const store = tmpStore('atri-prog-');
  const runtime = new Runtime(store, getConfig, { think: async () => { throw new Error('x'); } } as never, {} as never, {} as never, () => undefined);
  const peer = store.ensurePeer({ kind: 'c2c', id: 'p2' }).id;
  const r1 = store.append(peer, 'received', { text: '答应我别熬夜' })!;
  const turn = makeTurn(store, peer);
  turn.allowed.add(r1.id);
  const captured = [{ op: 'keep' as const, kind: 'promise' as const, content: '不熬夜', due: 0, sources: [r1.id], afterPart: 0 }];
  const id = store.draftOne(turn, 0, { type: 'text', text: '嗯，不熬了' }, { commitments: captured }, store.now(), true);
  assert.ok(store.startSend(id, {}));
  assert.ok(store.settleSend(id, 'accepted', 'pid'));
  const acceptedEvent = store.eventByDedupe(`accepted:${id}`)!;
  // apply：envelopeAt 查到 accepted 行 → backfillAccepted 分支（不依赖 effects 里的 pending 标记）
  const thought: Thought = { parts: [{ type: 'text', text: '嗯，不熬了' }], memories: [], commitments: captured, intents: [] };
  runtime.apply(turn, thought);
  const commitments = store.commitments(peer);
  assert.equal(commitments.length, 1);
  assert.ok(commitments[0]!.sources.includes(acceptedEvent.id), 'backfill 必须以接收事件为来源');
  store.close();
});

/** 场景 3：工具轮回滚——渐进气泡全部 cancelled，不投递不立约。 */
test('渐进回滚：工具轮 cancelDrafts 整批取消，承诺随之作废', () => {
  const store = tmpStore('atri-prog-');
  const runtime = new Runtime(store, getConfig, { think: async () => { throw new Error('x'); } } as never, {} as never, {} as never, () => undefined);
  const peer = store.ensurePeer({ kind: 'c2c', id: 'p3' }).id;
  const r1 = store.append(peer, 'received', { text: '帮我查天气' })!;
  const turn = makeTurn(store, peer);
  turn.allowed.add(r1.id);
  const captured = [{ op: 'keep' as const, kind: 'concern' as const, content: '查完天气告诉他', due: 0, sources: [r1.id] }];
  const a = store.draftOne(turn, 0, { type: 'text', text: '我看看' }, { commitments: captured }, store.now(), true);
  const b = store.draftOne(turn, 1, { type: 'text', text: '稍等' }, {}, store.now() + 1000, true);
  store.cancelDrafts([a, b]);
  assert.equal(store.deliveries(peer).every(d => d.status === 'cancelled'), true, '工具轮回滚后不得有任何可投递气泡');
  // apply（最终决定换了内容）：cancelled 行不算数，重新 draftOne 正式路径
  const thought: Thought = { parts: [{ type: 'text', text: '今天晴，26 度' }], memories: [], commitments: [], intents: [] };
  runtime.apply(turn, thought);
  const live = store.deliveries(peer).filter(d => d.status === 'pending' || d.status === 'accepted');
  assert.equal(live.length, 1);
  assert.equal(live[0]!.part.type === 'text' && live[0]!.part.text, '今天晴，26 度');
  assert.equal(store.commitments(peer).length, 0, '回滚的承诺不应立约');
  store.close();
});

/** 场景 4：修复轮 parts 数量不符——渐进全部回滚走纯全量。 */
test('补账模式：修复轮气泡数不符时全部回滚', () => {
  const store = tmpStore('atri-prog-');
  const runtime = new Runtime(store, getConfig, { think: async () => { throw new Error('x'); } } as never, {} as never, {} as never, () => undefined);
  const peer = store.ensurePeer({ kind: 'c2c', id: 'p4' }).id;
  store.append(peer, 'received', { text: 'hi' });
  const turn = makeTurn(store, peer);
  store.draftOne(turn, 0, { type: 'text', text: '草稿甲' }, {}, store.now(), true);
  store.draftOne(turn, 1, { type: 'text', text: '草稿乙' }, {}, store.now() + 1000, true);
  // 修复轮产出数量不符（1 条）：apply 会把 envelopeAt(1) 落空，但第 0 条复用渐进行。
  // 真实 mind 在数量不符时整批 cancel——这里直接模拟 cancel 后 apply 的终态。
  store.cancelDrafts(store.deliveries(peer).map(d => d.id));
  const thought: Thought = { parts: [{ type: 'text', text: '最终一条' }], memories: [], commitments: [], intents: [] };
  runtime.apply(turn, thought);
  const pending = store.deliveries(peer).filter(d => d.status === 'pending');
  assert.equal(pending.length, 1);
  assert.notEqual(pending[0]!.part.type === 'text' && pending[0]!.part.text, '草稿甲', '回滚的草稿不能出门');
  store.close();
});

/** 场景 5：recover 第五类——思考中断后，accepted+pending 承诺必须落 failure 报警，不静默。 */
test('recover 第五类：接收已发生而账本零记录时必须报警', () => {
  const dir = tmpRoot('atri-prog5-');
  const path = join(dir, 'atri.db');
  // 第一阶段：渐进捕获 → 接收 → 模拟进程带着未回填的账崩溃（turn 还在 running——崩溃前提）
  {
    const store = tmpOpen(path);
    const peer = store.ensurePeer({ kind: 'c2c', id: 'p5' }).id;
    const r1 = store.append(peer, 'received', { text: '生日记得陪我过' })!;
    const turn = makeTurn(store, peer);
    turn.allowed.add(r1.id);
    store.sql("INSERT INTO turns(id,peer,snapshot,state,at) VALUES(?,?,?,'running',?)").run(turn.id, peer, turn.snapshot, store.now());
    const captured = [{ op: 'keep' as const, kind: 'promise' as const, content: '生日陪他过', due: 0, sources: [r1.id], afterPart: 0 }];
    const id = store.draftOne(turn, 0, { type: 'text', text: '一定到' }, { commitments: captured }, store.now(), true);
    assert.ok(store.startSend(id, {}));
    assert.ok(store.settleSend(id, 'accepted', 'pid'));
    store.close(); // 此时承诺仍 pending 未回填——崩溃点
  }
  // 第二阶段：新进程 recover 扫描（turn 被标 interrupted，outbox 行 accepted + pending 承诺）
  const reopened = new Store(path);
  const failures = reopened.recent('c2c:p5').filter(e => e.kind === 'failure');
  assert.equal(failures.length, 1, 'recover 必须为「用户看到承诺、账本零记录」落 failure');
  assert.ok(String(failures[0]!.data.text).includes('约定效果未落账'));
  reopened.close();
});

test('渐进清洗幂等：清洗两次与一次结果一致（双路径不双洗）', () => {
  const once = cleanBubbleText('**重复**清洗。');
  const twice = cleanBubbleText(cleanBubbleText('**重复**清洗。'));
  assert.equal(twice, once);
});
