import { test } from 'node:test';
import { tmpRoot, tmpStore } from './tmp.ts';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { type Turn } from '../src/store.ts';
import { Mind, parseThought } from '../src/mind.ts';
import { validateConfig, defaults } from '../src/config.ts';

const config = validateConfig(defaults('人格'));
const store = tmpStore('atri-mind-');
const mind = new Mind(store, () => config, { complete: async () => { throw new Error('不该调用'); } } as never, { build: async () => { throw new Error('不该调用'); } } as never, []);

const peer = store.ensurePeer({ kind: 'c2c', id: 'u1' }).id;
const received = store.append(peer, 'received', { text: '我下周去北京' })!;
const received2 = store.append(peer, 'received', { text: '记得给我带特产' })!;
const accepted = store.append(peer, 'accepted', { type: 'text', text: '好' })!;
const due = store.append(peer, 'due', { commitment: 'x', content: '提醒', dueAt: store.now() })!;

const makeTurn = (p: string, allowed: string[]): Turn => ({ id: 't', episode: 'e', peer: p, snapshot: store.highwater(p), jobs: [{ id: 'j', peer: p, kind: 'chat', reason: 'r', dueAt: store.now(), data: {}, attempts: 0 }], allowed: new Set(allowed) });
const all = [received.id, received2.id, accepted.id, due.id];

const throws = (fn: () => unknown, why: string) => assert.throws(fn, TypeError, why);

test('校验退役：语义违规全部放行（用户裁决：她乐意说个假的就让她说）', () => {
  // 伪造来源/引用不存在对象/单来源 identity/坏 supersedes/complete 无依据——全部不再打回
  mind.validate({ parts: [], memories: [{ kind: 'fact', content: 'x', gist: 'x', sources: ['bogus'] }], commitments: [], intents: [] }, false);
  mind.validate({ parts: [], memories: [{ kind: 'identity', content: 'x', gist: 'x', sources: [received.id] }], commitments: [], intents: [] }, false);
  mind.validate({ parts: [], memories: [{ kind: 'fact', content: 'x', gist: 'x', sources: [received.id], supersedes: ['不存在'] }], commitments: [], intents: [] }, false);
  mind.validate({ parts: [], memories: [], commitments: [{ op: 'complete', id: '无此约定', sources: [due.id] }], intents: [] }, false);
  mind.validate({ parts: [], memories: [], commitments: [], intents: [], feeling: { label: 'x', valence: 0, arousal: 0, patience: 0, reason: 'x', sources: [accepted.id] } }, false);
  mind.validate({ parts: [{ type: 'text', text: 'x', reply: accepted.id, notified: ['无此约定'] }], memories: [], commitments: [], intents: [] }, false);
  mind.validate({ parts: [], memories: [], commitments: [], intents: [], thoughts: [{ op: 'keep', topic: '带伞', meaning: 'x', sources: [due.id] }] }, false);
  mind.validate({ parts: [], memories: [], commitments: [], intents: [], impressions: { beliefs: [{ text: 'x', basis: ['不存在'] }] } }, true);
});

test('防崩守门保留：夜间不发消息、过期意图仍然打回', () => {
  throws(() => mind.validate({ parts: [{ type: 'text' as const, text: '晚安' }], memories: [], commitments: [], intents: [] }, true), '夜间 parts 非空');
  throws(() => mind.validate({ parts: [], memories: [], commitments: [], intents: [{ reason: 'x', at: store.now() - 1000 }] }, false), '过去时间');
});

test('下游防崩：坏引用落账时静默跳过，不炸整轮', () => {
  // supersedes 指向不存在的记忆：只跳过替代，新记忆照常入库
  const m1 = store.saveMemory(peer, { kind: 'fact', content: '真实记忆', gist: 'x', sources: [received.id], supersedes: ['幽灵-id'] });
  assert.ok(m1);
  assert.equal(store.memories(peer).some(x => x.id === m1.id), true);
  // 残缺念头/约定：静默跳过返回 undefined
  assert.equal(store.changeThought(peer, { op: 'keep', topic: '', meaning: '', sources: [received.id] }), undefined);
  assert.equal(store.changeThought(peer, { op: 'drop', id: '幽灵', sources: [] }), undefined);
  assert.equal(store.changeCommitment(peer, { op: 'keep', kind: 'reminder', content: '', due: store.now(), sources: [] }), undefined);
  assert.equal(store.changeCommitment(peer, { op: 'complete', id: '幽灵约定', sources: [] }), undefined);
  // 正常链路不受影响
  const c = store.changeCommitment(peer, { op: 'keep', kind: 'reminder', content: '正常约定', due: store.now() + 86400000, sources: [received.id] });
  assert.ok(c);
});

test('协议解析：afterPart 越界直接拒绝', () => {
  assert.throws(() => parseThought(JSON.stringify({ parts: [{ type: 'text', text: 'x' }], commitments: [{ op: 'keep', kind: 'promise', content: 'x', due: store.now() + 1000, sources: [received.id], afterPart: 5 }] })), /承诺必须绑定存在的气泡/);
});

test('协议解析：格式层死错误代码修复，语义层照旧严格', () => {
  // 单字符串 sources 自动包数组；数字 id 转字符串——无歧义格式错误不重试
  const fixed = parseThought(JSON.stringify({ parts: [], memories: [{ kind: 'fact', content: 'x', gist: 'x', sources: 'single-id', supersedes: 7 }], intents: [{ reason: 'x', at: 1764000000000 }] }), 'Asia/Shanghai');
  assert.deepEqual(fixed.memories[0]!.sources, ['single-id']);
  assert.deepEqual(fixed.memories[0]!.supersedes, ['7']);
  // 情绪/重要性超界 clamp：主观权重截断比重试便宜
  const clamped = parseThought(JSON.stringify({ parts: [], feeling: { label: 'x', valence: 3, arousal: '0.7', patience: null, reason: 'r', sources: [] }, memories: [{ kind: 'fact', content: 'x', gist: 'x', sources: [], importance: 1.5 }] }), 'Asia/Shanghai');
  assert.equal(clamped.feeling!.valence, 1);
  assert.equal(clamped.feeling!.arousal, 0.7);
  assert.equal(clamped.feeling!.patience, 0); // 垃圾文本回 fallback
  assert.equal(clamped.memories[0]!.importance, 1);
  // 守门点：真垃圾仍然打回（对象混进数组、语义层 evidence 白名单不变）
  assert.throws(() => parseThought(JSON.stringify({ parts: [], memories: [{ kind: 'fact', content: 'x', gist: 'x', sources: [{ deep: 'id' }] }] })), /memories\.sources 需要文本数组/);
  assert.throws(() => parseThought(JSON.stringify({ parts: [], intents: [{ reason: 'x', at: '明天下午' }] }), 'Asia/Shanghai'), /时间需要/);
});

test('协议解析：模型写裸本地时间时按她的时区锚定成毫秒（不再整轮打回）', () => {
  // due 裸时间（今天真实事故：GLM 吐 2026-11-25T20:00:00 被打回三次）
  const withNaive = parseThought(JSON.stringify({ parts: [], commitments: [{ op: 'keep', kind: 'reminder', content: '提醒下课', due: '2026-11-25T20:00:00', sources: [received.id] }] }), 'Asia/Shanghai');
  assert.equal(withNaive.commitments[0]!.due, Date.parse('2026-11-25T20:00:00+08:00'));
  // intents.at 裸时间同样锚定
  const withIntent = parseThought(JSON.stringify({ parts: [], intents: [{ reason: 'x', at: '2026-11-26T09:30:00' }] }), 'Asia/Shanghai');
  assert.equal(withIntent.intents[0]!.at, Date.parse('2026-11-26T09:30:00+08:00'));
  // 带时区 ISO 与毫秒直通不变
  const withIso = parseThought(JSON.stringify({ parts: [], commitments: [{ op: 'keep', kind: 'reminder', content: 'x', due: '2026-11-25T20:00:00Z', sources: [received.id] }] }), 'Asia/Shanghai');
  assert.equal(withIso.commitments[0]!.due, Date.parse('2026-11-25T20:00:00Z'));
  const withMs = parseThought(JSON.stringify({ parts: [], commitments: [{ op: 'keep', kind: 'reminder', content: 'x', due: 1764000000000, sources: [received.id] }] }), 'Asia/Shanghai');
  assert.equal(withMs.commitments[0]!.due, 1764000000000);
  // 不存在的日期/乱文本仍然打回（锚定不是放水）
  assert.throws(() => parseThought(JSON.stringify({ parts: [], commitments: [{ op: 'keep', kind: 'reminder', content: 'x', due: '2026-02-30T08:00:00', sources: [received.id] }] }), 'Asia/Shanghai'), /日期不存在|无法解析/);
  assert.throws(() => parseThought(JSON.stringify({ parts: [], intents: [{ reason: 'x', at: '明天下午' }] }), 'Asia/Shanghai'), /时间需要/);
});

test('工具按配置注入：没配画笔/搜索/沙箱，她收到的工具定义里就没有这些', async () => {
  const { tools } = await import('../src/tools.ts');
  const { Files } = await import('../src/files.ts');
  const { Recall } = await import('../src/memory.ts');
  const files = new Files(join(tmpRoot('atri-mind-'), 'works'), () => config);
  const recall = new Recall(store, () => config);
  const captured: string[][] = [];
  const capture = { complete: async (_m: unknown, defs: { name: string }[]) => { captured.push(defs.map(d => d.name)); throw new Error('到此为止'); } };
  const build = { build: async () => ({ messages: [], cacheKey: 'k' }) };
  const off = validateConfig(defaults('人格'));
  await assert.rejects(new Mind(store, () => off, capture as never, build as never, tools(store, () => off, files, recall)).think(makeTurn(peer, all), new AbortController().signal));
  const bare = captured[0]!;
  assert.ok(!bare.includes('draw'), '未配置画笔却注入了 draw');
  assert.ok(!bare.includes('search'), '未配置搜索却注入了 search');
  assert.ok(!bare.includes('execute'), '未配置沙箱却注入了 execute');
  assert.ok(bare.includes('files'), '作品目录读写是基础能力，始终可用');
  // 三要素齐全但开关关闭：她依然收不到画图工具——可选 = 填了配置也可以不用
  const filled = validateConfig({ ...defaults('人格'), image: { enabled: false, engine: 'gpt', gpt: { url: 'https://api.example.com', key: 'k', model: 'img' }, nai: { url: '', key: '', model: 'nai-diffusion-4-5-full', steps: 28 } } });
  await assert.rejects(new Mind(store, () => filled, capture as never, build as never, tools(store, () => filled, files, recall)).think(makeTurn(peer, all), new AbortController().signal));
  assert.ok(!captured[1]!.includes('draw'), '画笔开关关闭时不应注入 draw');
  // 开关打开 + 配置齐全：画笔出现在她的工具集里
  const full = validateConfig({
    ...defaults('人格'),
    image: { enabled: true, engine: 'gpt', gpt: { url: 'https://api.example.com', key: 'k', model: 'img' }, nai: { url: '', key: '', model: 'nai-diffusion-4-5-full', steps: 28 } },
    web: { key: 'k', enabled: true },
    execution: { ...defaults().execution, enabled: true },
  });
  await assert.rejects(new Mind(store, () => full, capture as never, build as never, tools(store, () => full, files, recall)).think(makeTurn(peer, all), new AbortController().signal));
  const rich = captured[2]!;
  assert.ok(rich.includes('draw') && rich.includes('search') && rich.includes('execute'));
});
