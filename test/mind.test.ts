import test from 'node:test';
import assert from 'node:assert/strict';
import { Mind, parseThought } from '../src/domain/mind.js';
import { Journal } from '../src/storage/journal.js';
import type { Completion, Message, Model } from '../src/model/types.js';

const output = (content: string): Completion => ({
  message: { role: 'assistant', content },
  usage: { input: 1, output: 1, cached: 0 },
});
const silent = '{"action":"nothing","parts":[],"effects":{}}';

test('聊天与心跳使用同一稳定前缀，当前自身状态放在动态材料中', async () => {
  const journal = new Journal(':memory:');
  const prompts: Message[][] = [];
  const model: Model = {
    async complete(messages) {
      prompts.push(structuredClone(messages));
      return output(silent);
    },
  };
  try {
    const mind = new Mind(model, journal);
    const chat = journal.begin('peer', 'chat');
    const thought = await mind.think(
      chat,
      'person',
      [],
      { activity: 'reading', now: 1 },
      { deadlineAt: Date.now() + 1000 },
    );
    journal.draft(chat, thought.parts);
    const beat = journal.begin('peer', 'beat');
    await mind.think(
      beat,
      'person',
      [],
      { activity: 'writing', now: 2 },
      { deadlineAt: Date.now() + 1000 },
    );
    assert.equal(prompts[0]![0]!.content, prompts[1]![0]!.content);
    assert.ok(prompts[0]!.at(-1)!.content.includes('reading'));
    assert.ok(prompts[1]!.at(-1)!.content.includes('writing'));
    assert.ok(!prompts[0]![0]!.content.includes('reading'));
  } finally {
    journal.close();
  }
});

test('工具完成后遇到取消仍留真实回执，不生成表达记录', async () => {
  const journal = new Journal(':memory:');
  const controller = new AbortController();
  const model: Model = {
    async complete() {
      return {
        ...output(''),
        message: {
          role: 'assistant',
          content: '',
          calls: [{ id: 'one', name: 'write', arguments: {} }],
        },
      };
    },
  };
  try {
    const mind = new Mind(model, journal, [
      {
        definition: { name: 'write', description: 'write', parameters: { type: 'object' } },
        async execute() {
          controller.abort();
          return { path: 'note.txt' };
        },
      },
    ]);
    const turn = journal.begin('peer', 'beat');
    await assert.rejects(
      mind.think(
        turn,
        'person',
        [],
        {},
        { signal: controller.signal, deadlineAt: Date.now() + 1000 },
      ),
      { name: 'AbortError' },
    );
    assert.deepEqual(
      journal.events('peer').map((event) => event.kind),
      ['experienced'],
    );
  } finally {
    journal.close();
  }
});

test('结构错误仅修复一次，不能无限请求', async () => {
  const journal = new Journal(':memory:');
  let calls = 0;
  const model: Model = {
    async complete() {
      calls++;
      return output('bad json');
    },
  };
  try {
    const mind = new Mind(model, journal);
    await assert.rejects(
      mind.think(
        journal.begin('peer', 'chat'),
        'person',
        [],
        {},
        { deadlineAt: Date.now() + 1000 },
      ),
    );
    assert.equal(calls, 2);
  } finally {
    journal.close();
  }
});

test('禁止空发言、静默携带气泡和越界图片路径', () => {
  for (const value of [
    { action: 'speak', parts: [] },
    { action: 'nothing', parts: [{ type: 'text', text: 'oops' }] },
    { action: 'speak', parts: [{ type: 'image', path: '../secret.png' }] },
    { action: 'speak', parts: [{ type: 'image', path: 'C:\\secret.png' }] },
    { action: 'muse', parts: [] },
  ])
    assert.throws(() => parseThought(JSON.stringify(value)));
});
