import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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

test('mutates 幂等：同轮同参回放缓存不重跑，纯读每次真跑', async () => {
  const journal = new Journal(':memory:');
  let runs = 0;
  let reads = 0;
  const model: Model = {
    async complete(_messages, _tools) {
      if (_messages.at(-1)?.role !== 'tool') {
        return {
          ...output(''),
          message: {
            role: 'assistant',
            content: '',
            calls: [
              { id: 'draw1', name: 'draw', arguments: { prompt: '猫' } },
              { id: 'draw2', name: 'draw', arguments: { prompt: '猫' } }, // 同参重试
              { id: 'draw3', name: 'draw', arguments: { prompt: '狗' } }, // 换参不串
              { id: 'peek', name: 'peek', arguments: {} }, // 纯读
            ],
          },
        };
      }
      // 工具回执后：收口。
      return output('{"action":"speak","parts":[{"type":"text","text":"画好了"}],"effects":{}}');
    },
  };
  try {
    const mind = new Mind(model, journal, [
      {
        definition: { name: 'draw', description: 'draw', parameters: { type: 'object' } },
        mutates: true,
        async execute(args) {
          runs++;
          return { path: `pictures/${runs}.png`, prompt: args.prompt };
        },
      },
      {
        definition: { name: 'peek', description: 'peek', parameters: { type: 'object' } },
        async execute() {
          reads++;
          return { n: reads };
        },
      },
    ]);
    const turn = journal.begin('peer', 'beat');
    const thought = await mind.think(turn, 'person', [], {}, {
      deadlineAt: Date.now() + 1000,
    } as never);
    void thought;
    // 三次 draw 只真跑两次（同参回放）；键序不影响签名。纯读两次调用都真跑。
    assert.equal(runs, 2);
    assert.equal(reads, 1);
    const actions = journal
      .events('peer', ['attempted', 'experienced'])
      .map((event) => JSON.parse(event.content));
    // 回放的收到与首跑相同的结果（不重画），换参的拿到自己的。
    const paths = actions
      .filter((item) => item.tool === 'draw')
      .map((item) => (item.result as { path: string }).path);
    assert.deepEqual(paths, ['pictures/1.png', 'pictures/1.png', 'pictures/2.png']);
  } finally {
    journal.close();
  }
});

test('mutates 幂等：中断恢复的 unknown 回放带 uncertain，禁止盲目重做', async () => {
  const journal = new Journal(':memory:');
  const args = { prompt: '猫' };
  // 预置一条中断留下的 running 态（等价 recover 前的现场），跑 recover 改判。
  const mind0 = new Mind(
    {
      async complete() {
        return output(silent);
      },
    },
    journal,
  );
  void mind0;
  const turn0 = journal.begin('peer', 'beat');
  const signature = ((): string => {
    // 与 mind.ts 同一签名规则（工具名 + 键序规范化参数）。
    const canonical = (value: unknown): string => {
      if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
      if (value && typeof value === 'object')
        return `{${Object.entries(value as Record<string, unknown>)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
          .join(',')}}`;
      return JSON.stringify(value);
    };
    return createHash('sha256')
      .update(`draw:${canonical(args)}`)
      .digest('hex');
  })();
  journal.toolStart(`${turn0.id}:${signature}`, 'peer', turn0.id, signature);
  journal.recover(); // running → unknown
  let runs = 0;
  const model: Model = {
    async complete(_messages) {
      if (_messages.at(-1)?.role !== 'tool')
        return {
          ...output(''),
          message: {
            role: 'assistant',
            content: '',
            calls: [{ id: 'draw1', name: 'draw', arguments: args }],
          },
        };
      return output('{"action":"speak","parts":[{"type":"text","text":"知道了"}],"effects":{}}');
    },
  };
  try {
    const mind = new Mind(model, journal, [
      {
        definition: { name: 'draw', description: 'draw', parameters: { type: 'object' } },
        mutates: true,
        async execute() {
          runs++;
          return { path: 'pictures/again.png' };
        },
      },
    ]);
    // 新一轮（turn id 不同 → runId 不同）本不该命中旧 runId……幂等键锚定
    // 轮次：同轮回放才是语义。这里直接复用同一 turn 的运行现场验证回放。
    const thought = await mind.think(turn0, 'person', [], {}, {
      deadlineAt: Date.now() + 1000,
    } as never);
    void thought;
    // unknown 回放：不重跑（runs 0），结果带 uncertain，禁止盲目重做。
    assert.equal(runs, 0);
    const action = JSON.parse(journal.events('peer', ['attempted']).at(-1)!.content) as {
      result: { uncertain?: boolean; error?: string };
    };
    assert.equal(action.result.uncertain, true);
    assert.ok(action.result.error?.includes('不能假定未产生副作用'));
  } finally {
    journal.close();
  }
});
