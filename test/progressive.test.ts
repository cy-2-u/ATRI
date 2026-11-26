import test from 'node:test';
import assert from 'node:assert/strict';
import { Journal } from '../src/storage/journal.js';
import { Mind, type BubbleSink } from '../src/domain/mind.js';
import { JsonStreamParser } from '../src/stream.js';
import { Runtime } from '../src/runtime/runtime.js';
import { lifeTools } from '../src/domain/tools.js';

const options = () => ({ deadlineAt: Date.now() + 1000 });

test('JsonStreamParser：parts 元素闭合即回调、围栏/转义/重复 parts 全防住', () => {
  const seen: unknown[] = [];
  const parser = new JsonStreamParser((element) => seen.push(element));
  // 分片喂：跨 chunk 的字符串转义与中文都不能破坏边界判定。
  for (const chunk of [
    '{"ac',
    'tion":"speak","parts":[{"type":"te',
    'xt","text":"嗨\\"啊"',
    '},{"type":"sticker","slug":"cat0',
    '01"}],"effects":{}}',
  ])
    parser.write(chunk);
  assert.equal(seen.length, 2);
  assert.deepEqual(seen[0], { type: 'text', text: '嗨"啊' });
  assert.deepEqual(seen[1], { type: 'sticker', slug: 'cat001' });
  // 重复 parts：首个合法元素照常回调；重复出现即结构错误，停止后续回调。
  const dupeSeen: unknown[] = [];
  const dupe = new JsonStreamParser((element) => dupeSeen.push(element));
  dupe.write('{"parts":[{"type":"text","text":"a"}]');
  assert.equal(dupeSeen.length, 1); // 重复出现前，首个元素合法闭合
  dupe.write(',"parts":[{"type":"text","text":"b"}]}');
  assert.equal(dupeSeen.length, 1); // 重复 parts：停止回调（等全量修复轮）
  assert.ok(dupe.error);
  // 裸字符串元素（primitive）闭合也回调。
  const strings: unknown[] = [];
  const bare = new JsonStreamParser((e) => strings.push(e));
  bare.write('{"parts":["x", 12, null, {"type":"text","text":"y"}]}');
  assert.equal(strings.length, 4);
});

test('渐进投递：气泡闭合即入队，不等整轮 JSON 生成完', async () => {
  const journal = new Journal(':memory:');
  try {
    journal.receive('peer', 'one', '给我讲个三段的小故事');
    const turn = journal.begin('peer', 'chat');
    const drafts: number[] = [];
    const sink: BubbleSink = {
      draft: (ordinal, part) => {
        drafts.push(ordinal);
        return journal.draftOne(turn, ordinal, part);
      },
    };
    const deltas: string[][] = [];
    let round = 0;
    const mind = new Mind(
      {
        async complete(_messages, _tools, opts) {
          round++;
          // 模拟流式：三个气泡逐段吐出，每个气泡闭合时 outbox 立刻有行。
          const full = JSON.stringify({
            action: 'speak',
            parts: [
              { type: 'text', text: '第一段' },
              { type: 'text', text: '第二段' },
              { type: 'text', text: '第三段' },
            ],
          });
          const log = deltas[round - 1] ?? (deltas[round - 1] = []);
          // 四个分片：前三个分片恰好覆盖前两个气泡的闭合点。
          const cuts = [18, 60, 95, full.length];
          let cursor = 0;
          for (const cut of cuts) {
            const delta = full.slice(cursor, cut);
            cursor = cut;
            opts.onDelta?.(delta);
            log.push(delta);
          }
          return {
            message: { role: 'assistant' as const, content: full },
            usage: { input: 10, output: 5, cached: 0 },
          };
        },
      },
      journal,
      lifeTools(journal, {}),
      '',
      () => 24_000,
    );
    const thought = await mind.think(turn, '人格', [], {}, options(), sink);
    assert.equal(thought.parts.length, 3);
    // 全文吐完之前，闭合的气泡已在 outbox 排队（渐进的核心收益）。
    const outbox = journal.pending('peer').filter((e) => e.turn === turn.id);
    assert.equal(outbox.length, 3);
    assert.deepEqual(drafts, [0, 1, 2]);
    // 收口后 turn 转 ready（待投递）。
    assert.equal(journal.turnState(turn.id), 'ready');
  } finally {
    journal.close();
  }
});

test('渐进投递：目录外表情在轻校验被丢弃，气泡照发不炸轮', async () => {
  const journal = new Journal(':memory:');
  try {
    journal.receive('peer', 'one', '来个表情');
    const turn = journal.begin('peer', 'chat');
    const sink: BubbleSink = {
      draft: (ordinal, part) => journal.draftOne(turn, ordinal, part),
    };
    const mind = new Mind(
      {
        async complete(_messages, _tools, opts) {
          const full = JSON.stringify({
            action: 'speak',
            parts: [
              { type: 'sticker', slug: 'ghost' }, // 不在目录：渐进层丢弃
              { type: 'text', text: '给你文字' },
            ],
          });
          opts.onDelta?.(full);
          return {
            message: { role: 'assistant' as const, content: full },
            usage: { input: 10, output: 5, cached: 0 },
          };
        },
      },
      journal,
      lifeTools(journal, {}),
      '',
      () => 24_000,
      {},
      () => undefined, // stickerQuery 找不到目录外 slug
    );
    const thought = await mind.think(turn, '人格', [], {}, options(), sink);
    assert.equal(thought.parts.length, 2);
    const outbox = journal.pending('peer').filter((e) => e.turn === turn.id);
    // 幽灵表情在渐进轻校验被拒（入队 0 个），文字气泡闭合入队。
    assert.equal(outbox.length, 1);
    assert.equal(journal.turnState(turn.id), 'ready');
  } finally {
    journal.close();
  }
});

test('渐进投递：全量与渐进数量漂移时回滚重投（最终决定是权威）', async () => {
  // 走真 Runtime：回滚后的重新全量入账由 runtime 的全量 draft 路径完成，
  // 直调 mind.think 永远看不到重投结果。
  const journal = new Journal(':memory:');
  let runtime: Runtime | undefined;
  try {
    journal.receive('peer', 'one', '聊聊');
    let round = 0;
    const mind = new Mind(
      {
        async complete(_messages, _tools, opts) {
          round++;
          if (round === 1) {
            // 第一轮：两个气泡渐进入队，但全文 JSON 缺 action——全量解析失败进修复轮。
            const full = '{"parts":[{"type":"text","text":"一"},{"type":"text","text":"二"}]}';
            opts.onDelta?.(full);
            return {
              message: { role: 'assistant' as const, content: full },
              usage: { input: 10, output: 5, cached: 0 },
            };
          }
          // 修复轮：数量漂移（三个气泡）——渐进全部回滚走纯全量。
          const full = JSON.stringify({
            action: 'speak',
            parts: [
              { type: 'text', text: '一改' },
              { type: 'text', text: '二改' },
              { type: 'text', text: '三改' },
            ],
          });
          opts.onDelta?.(full);
          return {
            message: { role: 'assistant' as const, content: full },
            usage: { input: 10, output: 5, cached: 0 },
          };
        },
      },
      journal,
      lifeTools(journal, {}),
      '',
      () => 24_000,
    );
    const sent: string[] = [];
    runtime = new Runtime(journal, mind, {
      persona: () => '人格',
      material: () => ({}),
      send: (_peer, part) => {
        sent.push(part.type === 'text' ? (part.text ?? '') : `[${part.type}]`);
        return Promise.resolve('sent' as const);
      },
      nextBeat: () => Date.now() + 60_000,
      onComposing: () => Promise.resolve(),
      onError: () => {},
      debounceMs: 10,
      timeoutMs: 20_000,
      concurrency: 2,
      pacing: false,
      stickerSlugs: () => new Set<string>(),
      vision: () => false,
      readFile: () => Promise.resolve(undefined),
    });
    runtime.start();
    const end = Date.now() + 15_000;
    while (Date.now() < end && sent.length < 3) await new Promise((r) => setTimeout(r, 50));
    assert.equal(sent.length, 3);
    // 回滚后重新全量入账：三气泡齐全，旧两气泡不留尸体。
    assert.deepEqual(sent, ['一改', '二改', '三改']);
  } finally {
    await runtime?.stop();
    journal.close();
  }
});
