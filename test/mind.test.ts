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
const gpeer = store.ensurePeer({ kind: 'group', id: 'g1' }).id;
const received = store.append(peer, 'received', { text: '我下周去北京' })!;
const received2 = store.append(peer, 'received', { text: '记得给我带特产' })!;
const accepted = store.append(peer, 'accepted', { type: 'text', text: '好' })!;
const due = store.append(peer, 'due', { commitment: 'x', content: '提醒', dueAt: store.now() })!;
const greceived = store.append(gpeer, 'received', { text: '大家好' })!;
const greceived2 = store.append(gpeer, 'received', { text: '我是新来的' })!;

const makeTurn = (p: string, allowed: string[]): Turn => ({ id: 't', episode: 'e', peer: p, snapshot: store.highwater(p), jobs: [{ id: 'j', peer: p, kind: 'chat', reason: 'r', dueAt: store.now(), data: {}, attempts: 0 }], allowed: new Set(allowed) });
const all = [received.id, received2.id, accepted.id, due.id];
const gall = [greceived.id, greceived2.id];

const throws = (fn: () => unknown, why: string) => assert.throws(fn, TypeError, why);

test('诚实红线：fact 记忆必须有对方明确输入', () => {
  throws(() => mind.validate(makeTurn(peer, all), { parts: [], memories: [{ kind: 'fact', content: '他下周去北京', gist: 'x', sources: [accepted.id] }], commitments: [], intents: [] }, false), 'accepted 不是对方输入');
  mind.validate(makeTurn(peer, all), { parts: [], memories: [{ kind: 'fact', content: '他下周去北京', gist: 'x', sources: [received.id] }], commitments: [], intents: [] }, false);
});

test('诚实红线：identity 需要两处真实经历且群聊禁写', () => {
  throws(() => mind.validate(makeTurn(peer, all), { parts: [], memories: [{ kind: 'identity', content: '我是陪伴者', gist: 'x', sources: [received.id] }], commitments: [], intents: [] }, false), '单来源');
  mind.validate(makeTurn(peer, all), { parts: [], memories: [{ kind: 'identity', content: '我是陪伴者', gist: 'x', sources: [received.id, received2.id] }], commitments: [], intents: [] }, false);
  throws(() => mind.validate(makeTurn(gpeer, gall), { parts: [], memories: [{ kind: 'identity', content: '群里的我是活跃的', gist: 'x', sources: [greceived.id, greceived2.id] }], commitments: [], intents: [] }, false), '群聊');
});

test('诚实红线：supersedes 必须指向本会话活跃记忆', () => {
  throws(() => mind.validate(makeTurn(peer, all), { parts: [], memories: [{ kind: 'fact', content: 'x', gist: 'x', sources: [received.id], supersedes: ['不存在'] }], commitments: [], intents: [] }, false), '外来 id');
  const m = store.saveMemory(peer, { kind: 'fact', content: '他下周去北京', gist: 'x', sources: [received.id] });
  mind.validate(makeTurn(peer, all), { parts: [], memories: [{ kind: 'fact', content: '他下周去上海', gist: 'x', sources: [received.id], supersedes: [m.id] }], commitments: [], intents: [] }, false);
});

test('诚实红线：履约必须有对方反馈或成功行动，提醒到期不算', () => {
  const c = store.changeCommitment(peer, { op: 'keep', kind: 'reminder', content: '提醒带伞', due: store.now() + 86400000, sources: [received.id] });
  throws(() => mind.validate(makeTurn(peer, all), { parts: [], memories: [], commitments: [{ op: 'complete', id: c.id, sources: [due.id] }], intents: [] }, false), 'due 事件不算履约');
  mind.validate(makeTurn(peer, all), { parts: [], memories: [], commitments: [{ op: 'complete', id: c.id, sources: [received2.id] }], intents: [] }, false);
});

test('诚实红线：新承诺必须绑定承诺气泡（或引用已见 accepted）', () => {
  throws(() => mind.validate(makeTurn(peer, all), { parts: [{ type: 'text', text: '好' }], memories: [], commitments: [{ op: 'keep', kind: 'promise', content: '带特产', due: store.now() + 86400000, sources: [received.id] }], intents: [] }, false), '无 afterPart 且无 accepted');
  mind.validate(makeTurn(peer, all), { parts: [{ type: 'text', text: '好' }], memories: [], commitments: [{ op: 'keep', kind: 'promise', content: '带特产', due: store.now() + 86400000, sources: [received.id], afterPart: 0 }], intents: [] }, false);
  mind.validate(makeTurn(peer, all), { parts: [{ type: 'text', text: '好' }], memories: [], commitments: [{ op: 'keep', kind: 'promise', content: '带特产', due: store.now() + 86400000, sources: [received.id, accepted.id] }], intents: [] }, false);
});

test('诚实红线：来源/reply/notified 必须是本轮看见的真实对象', () => {
  throws(() => mind.validate(makeTurn(peer, [received.id]), { parts: [], memories: [], commitments: [], intents: [], feeling: { label: 'x', valence: 0, arousal: 0, patience: 0, reason: 'x', sources: [accepted.id] } }, false), 'feeling 来源不在本轮');
  throws(() => mind.validate(makeTurn(peer, all), { parts: [{ type: 'text', text: 'x', reply: accepted.id }], memories: [], commitments: [], intents: [] }, false), 'reply 必须指向 received');
  throws(() => mind.validate(makeTurn(peer, all), { parts: [{ type: 'text', text: 'x', notified: ['无此约定'] }], memories: [], commitments: [], intents: [] }, false), 'notified');
});

test('诚实红线：未来意图不能制造过去时间循环', () => {
  throws(() => mind.validate(makeTurn(peer, all), { parts: [], memories: [], commitments: [], intents: [{ reason: 'x', at: store.now() - 1000 }] }, false), '过去时间');
  throws(() => mind.validate(makeTurn(peer, all), { parts: [], memories: [], commitments: [], intents: [{ reason: 'x', at: store.now() + 86400000, commitment: '无此约定' }] }, false), '坏引用');
});

test('诚实红线：夜间拍不发消息；日记/印象只属于夜间拍', () => {
  const nightThought = { parts: [{ type: 'text' as const, text: '晚安' }], memories: [], commitments: [], intents: [] };
  throws(() => mind.validate(makeTurn(peer, all), nightThought, true), '夜间 parts 非空');
  throws(() => mind.validate(makeTurn(peer, all), { parts: [], memories: [], commitments: [], intents: [], diary: { content: 'x', emotion: 0, sources: [received.id] } }, false), '非夜间写日记');
  throws(() => mind.validate(makeTurn(peer, all), { parts: [], memories: [], commitments: [], intents: [], impressions: { beliefs: [{ text: 'x', basis: [received.id] }] } }, false), '非夜间改印象');
  throws(() => mind.validate(makeTurn(peer, all), { parts: [], memories: [], commitments: [], intents: [], impressions: { beliefs: [{ text: 'x', basis: [] }] } }, true), '印象无依据');
  const m = store.saveMemory(peer, { kind: 'fact', content: '他下周去北京', gist: 'x', sources: [received.id] });
  mind.validate(makeTurn(peer, all), { parts: [], memories: [], commitments: [], intents: [], impressions: { beliefs: [{ text: '他是要出远门的人', basis: [m.id, received.id] }] } }, true), '记忆 id 可作依据';
});

test('诚实红线：念头必须来自真实经历，到期提醒不算', () => {
  throws(() => mind.validate(makeTurn(peer, all), { parts: [], memories: [], commitments: [], intents: [], thoughts: [{ op: 'keep', topic: '带伞', meaning: 'x', sources: [due.id] }] }, false), 'due 不算经历');
  mind.validate(makeTurn(peer, all), { parts: [], memories: [], commitments: [], intents: [], thoughts: [{ op: 'keep', topic: '带伞', meaning: 'x', sources: [received.id] }] }, false);
});

test('协议解析：afterPart 越界直接拒绝', () => {
  assert.throws(() => parseThought(JSON.stringify({ parts: [{ type: 'text', text: 'x' }], commitments: [{ op: 'keep', kind: 'promise', content: 'x', due: store.now() + 1000, sources: [received.id], afterPart: 5 }] })), /承诺必须绑定存在的气泡/);
});

test('诚实红线：来源不存在于库中（伪造 id）一律拒绝', () => {
  throws(() => mind.validate(makeTurn(peer, ['fabricated-id']), { parts: [], memories: [{ kind: 'fact', content: 'x', gist: 'x', sources: ['fabricated-id'] }], commitments: [], intents: [] }, false), '库中无此事件');
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
  const filled = validateConfig({ ...defaults('人格'), image: { url: 'https://api.example.com', key: 'k', model: 'img', enabled: false } });
  await assert.rejects(new Mind(store, () => filled, capture as never, build as never, tools(store, () => filled, files, recall)).think(makeTurn(peer, all), new AbortController().signal));
  assert.ok(!captured[1]!.includes('draw'), '画笔开关关闭时不应注入 draw');
  // 开关打开 + 配置齐全：画笔出现在她的工具集里
  const full = validateConfig({
    ...defaults('人格'),
    image: { url: 'https://api.example.com', key: 'k', model: 'img', enabled: true },
    web: { key: 'k', enabled: true },
    execution: { ...defaults().execution, enabled: true },
  });
  await assert.rejects(new Mind(store, () => full, capture as never, build as never, tools(store, () => full, files, recall)).think(makeTurn(peer, all), new AbortController().signal));
  const rich = captured[2]!;
  assert.ok(rich.includes('draw') && rich.includes('search') && rich.includes('execute'));
});
