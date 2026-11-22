import { test } from 'node:test';
import { tmpStore } from './tmp.ts';
import assert from 'node:assert/strict';
import { Recall } from '../src/memory.ts';
import { validateConfig, defaults, type Config } from '../src/config.ts';

// 语义召回的决定性断言：查询与记忆词面零重叠，仅靠向量命中。
// 词面命中通道永远免费；语义通道必须能把"换了说法的同一件事"捞回来。
const config: Config = validateConfig({ ...defaults('x'), embedding: { url: 'http://127.0.0.1:9', key: 'k', model: 'fake-embed' } });
const store = tmpStore('atri-mem-');
const recall = new Recall(store, () => config);
const peer = store.ensurePeer({ kind: 'c2c', id: 'u1' }).id;
const e1 = store.append(peer, 'received', { text: '我喜欢吃苹果' })!;
const e2 = store.append(peer, 'received', { text: '我在做深度学习研究' })!;
store.saveMemory(peer, { kind: 'fact', content: '他喜欢吃苹果', gist: '水果偏好', sources: [e1.id] });
store.saveMemory(peer, { kind: 'fact', content: '他在研究神经网络', gist: '研究方向', sources: [e2.id] });

// 打桩 embed：查询向量与"神经网络"记忆同向，与"苹果"正交。
recall.embed = async (texts: string[]) => texts.map(t => (t.includes('神经网络') || t.includes('transformer')) ? Float32Array.from([1, 0]) : Float32Array.from([0, 1]));

test('盲区钉死：纯语义命中（零词面重叠）必须能召回', async () => {
  const hits = await recall.search(peer, 'transformer 模型训练', AbortSignal.timeout(5000), true);
  assert.ok(hits.some(h => h.memory.content.includes('神经网络')), `语义通道失效，只回了:[${hits.map(h => h.memory.content).join(' | ')}]`);
  assert.ok(!hits.some(h => h.memory.content.includes('苹果')), '正交向量不应召回');
});

test('词面通道：命中即回，免费', async () => {
  const hits = await recall.search(peer, '苹果', AbortSignal.timeout(5000), false);
  assert.ok(hits.some(h => h.memory.content.includes('苹果')));
  assert.ok(!hits.some(h => h.memory.content.includes('神经网络')));
});

test('六变量呈现：细节低于阈值只给要旨，绝不补原话', () => {
  const e3 = store.append(peer, 'received', { text: '琐碎小事' })!;
  const m = store.saveMemory(peer, { kind: 'interpretation', content: '一条很长的细节描述'.repeat(10), gist: '只剩要旨的旧事', sources: [e3.id], importance: 0.5, emotion: 0 });
  // 人为把 detail 压进"大致记得"区间（0.4–0.65）：未淡忘，但只剩要旨
  const decayed = { ...m, detail: 0.5 };
  store.sql('UPDATE memories SET value=? WHERE id=?').run(JSON.stringify(decayed), m.id);
  const scored = recall.score('细节描述', [decayed]);
  assert.ok(scored.length === 1);
  assert.equal(scored[0]!.text, '只剩要旨的旧事');
  assert.equal(scored[0]!.certainty, '大致记得');
});

test('淡忘：细节与意义双低的记忆不出场', () => {
  const e4 = store.append(peer, 'received', { text: '边缘琐事' })!;
  const m = store.saveMemory(peer, { kind: 'fact', content: '边缘琐事记录', gist: '琐', sources: [e4.id], importance: 0.05 });
  const decayed = { ...m, detail: 0.2 };
  store.sql('UPDATE memories SET value=? WHERE id=?').run(JSON.stringify(decayed), m.id);
  assert.equal(recall.score('边缘琐事', [decayed]).length, 0);
});
