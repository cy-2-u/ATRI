import { test } from 'node:test';
import { tmpRoot, tmpStore } from './tmp.ts';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { type Turn } from '../src/store.ts';
import { Context } from '../src/context.ts';
import { Recall } from '../src/memory.ts';
import { Files } from '../src/files.ts';
import { validateConfig, defaults, type Config } from '../src/config.ts';
import type { Completion } from '../src/types.ts';

const config: Config = validateConfig(defaults('测试人格【用于材料组装】'));
const configGet = (): Config => config;
const stubModels = {
  complete: async (): Promise<Completion> => ({ message: { role: 'assistant', content: '压缩摘要' }, usage: { input: 1, output: 1, cached: 0, cacheWrite: 0 }, finish: 'stop' }),
  cacheKey: (): string => 'k',
};

const store = tmpStore('atri-ctx-');
const files = new Files(join(tmpRoot('atri-ctx-w-'), 'works'), configGet); await files.init();
const context = new Context(store, configGet, stubModels as never, files, new Recall(store, configGet));

const peer = store.ensurePeer({ kind: 'c2c', id: 'u1' }).id;
const r1 = store.append(peer, 'received', { text: '今天好累' })!;
const a1 = store.append(peer, 'accepted', { type: 'text', text: '抱抱' })!;
const f1 = store.append(peer, 'failure', { text: '这次思考未完成', error: 'timeout' })!;
const a2 = store.append(peer, 'accepted', { type: 'text', text: '我去睡了' })!;

const turn = (jobs: ('chat' | 'beat' | 'night')[]): Turn => ({ id: 't1', episode: 'e1', peer, snapshot: store.highwater(peer), jobs: jobs.map(kind => ({ id: `j-${kind}`, peer, kind, reason: 'r', dueAt: store.now(), data: {}, attempts: 0 })), allowed: new Set<string>() });

test('聊天轮：系统前缀 + 事件历史 + 材料尾部，allowed 覆盖全部看见事件', async () => {
  const t = turn(['chat']);
  const { messages, cacheKey } = await context.build(t, [], AbortSignal.timeout(5000));
  assert.equal(messages[0]!.role, 'system');
  assert.ok(messages[0]!.content.includes('测试人格【用于材料组装】'));
  assert.ok(messages[0]!.content.includes('只返回 JSON'), '协议必须在前缀里');
  assert.ok(messages.at(-1)!.role === 'user');
  const material = JSON.parse(messages.at(-1)!.content) as Record<string, unknown>;
  assert.ok(material.scene && material.reasons && material.self && material.capabilities);
  assert.ok(cacheKey.length > 0);
  for (const id of [r1.id, a1.id, a2.id]) assert.ok(t.allowed.has(id), `allowed 缺 ${id}`);
  // 摘要尚未生成
  assert.ok(!messages.some(m => m.role === 'system' && m.content.includes('低频记忆')));
});

test('盲区钉死：聊天轮必须看见自己的失败记录（诚实材料）', async () => {
  const t = turn(['chat']);
  const { messages } = await context.build(t, [], AbortSignal.timeout(5000));
  const hasFailure = messages.some(m => m.content.includes('"failure"') && m.content.includes('这次思考未完成'));
  assert.ok(hasFailure, 'failure 事件被窗口过滤掉了——她看不见自己哪次思考没完成');
  assert.ok(t.allowed.has(f1.id));
});

test('心跳拍：紧凑窗口不带全量历史，材料含身体/动机/黏人度', async () => {
  const t = turn(['beat']);
  const { messages } = await context.build(t, [], AbortSignal.timeout(5000));
  const material = JSON.parse(messages.at(-1)!.content) as Record<string, unknown>;
  assert.equal((material.body as Record<string, unknown>).timezone, 'Asia/Shanghai');
  assert.ok('closeness' in (material.self as Record<string, unknown>));
  const history = messages.filter(m => m.role === 'user' && m.content.startsWith('{"id":'));
  assert.ok(history.length <= 40, '心跳窗上限 40');
});

test('夜间拍：day/pairs/impressions 回显 + 夜规约 + 无消息历史', async () => {
  const m1 = store.saveMemory(peer, { kind: 'fact', content: '他今天说很累，在加班', gist: '加班', sources: [r1.id] });
  store.saveMemory(peer, { kind: 'fact', content: '他今天说很累，在赶项目', gist: '加班', sources: [r1.id] });
  store.saveImpressions(peer, { beliefs: [{ text: '他最近工作压力大', basis: [m1.id] }], updatedAt: store.now() });
  const t = turn(['night']);
  const { messages } = await context.build(t, [], AbortSignal.timeout(5000));
  const material = JSON.parse(messages.at(-1)!.content) as Record<string, unknown>;
  assert.equal(material.mode, 'night');
  const day = material.day as { id: string }[];
  assert.ok(day.some(e => e.id === r1.id) && day.some(e => e.id === a1.id));
  assert.ok(((material.pairs ?? []) as unknown[]).length >= 1, '相近记忆应配对');
  assert.equal(((material.impressions as { beliefs: unknown[] }).beliefs).length, 1);
  assert.ok((material.note as string).includes('夜间整理拍'));
  // 夜拍只有系统前缀 + 材料，没有逐字事件历史
  assert.equal(messages.length, 2);
  for (const id of [r1.id, a1.id, a2.id]) assert.ok(t.allowed.has(id), `夜拍 allowed 缺 ${id}`);
  // 事件来源被放行（依据可核实），记忆 id 本身不进 allowed（validate 里单独放行其作印象依据）
  assert.ok(!t.allowed.has(m1.id));
});

test('夜间拍：impressions 为空时给空集而非缺字段', async () => {
  const p2 = store.ensurePeer({ kind: 'c2c', id: 'u2' }).id;
  const t: Turn = { id: 't2', episode: 'e2', peer: p2, snapshot: 0, jobs: [{ id: 'j-night', peer: p2, kind: 'night', reason: 'r', dueAt: store.now(), data: {}, attempts: 0 }], allowed: new Set<string>() };
  const { messages } = await context.build(t, [], AbortSignal.timeout(5000));
  const material = JSON.parse(messages.at(-1)!.content) as { impressions: { beliefs: unknown[] } };
  assert.deepEqual(material.impressions.beliefs, []);
});
