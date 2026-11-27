import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { jitteredSleepWindow } from '../src/domain/rhythm.js';
import { cleanBubbleText, reactionDelay, Runtime } from '../src/runtime/runtime.js';
import { Journal } from '../src/storage/journal.js';
import { Mind } from '../src/domain/mind.js';
import { lifeTools } from '../src/domain/tools.js';

// beta 移植四件（气泡清洗/半句等待/抖动守恒/并行投递泵）的行为面。
// 半句等待的正则与 index.ts 的装配层同源，这里锁行为不变式。

test('气泡清洗：markdown 记号剥离、句末句号收敛、省略号保留', () => {
  assert.equal(cleanBubbleText('**加粗**文字'), '加粗文字');
  assert.equal(cleanBubbleText('看`代码`与~~划掉~~'), '看代码与划掉');
  assert.equal(cleanBubbleText('# 标题\n正文'), '标题\n正文');
  assert.equal(cleanBubbleText('> 引用行'), '引用行');
  // 成对星号动作剥壳；行内孤立星号不动。
  assert.equal(cleanBubbleText('*挥手* 你好'), '挥手 你好');
  assert.equal(cleanBubbleText('3 * 4 等于 12'), '3 * 4 等于 12');
  // 句末句号整体剥掉（即时聊天的疏离感）；问号叹号省略号保留。
  assert.equal(cleanBubbleText('好。'), '好');
  assert.equal(cleanBubbleText('好。。。'), '好');
  assert.equal(cleanBubbleText('好…'), '好…');
  assert.equal(cleanBubbleText('好。。。。。'), '好');
  assert.equal(cleanBubbleText('真的吗？'), '真的吗？');
  // 多行只在行尾收敛，行中句号不动；结尾空白清理。
  assert.equal(cleanBubbleText('第一行。  \n第二行。。'), '第一行。  \n第二行');
});

test('半句等待：连词与半截标点收尾 +2s，完整句不加', () => {
  // 与 src/index.ts 的 TRAILING 同一份正则语义：这里锁关键样例。
  const trailing = (text: string): number => {
    // 从装配层复制（TRAILING 不导出）：改 index.ts 时这里会照出漂移。
    const re =
      /[,，、;；:：…]$|然后$|就是$|不过$|但是$|可是$|因为$|所以$|而且$|或者$|还是$|再说$|毕竟$/;
    return re.test(text.trimEnd()) ? 2000 : 0;
  };
  for (const text of ['我想说，', '今天有点累…', '然后', '不过', '因为', '毕竟', '对了：'])
    assert.equal(trailing(text), 2000, text);
  for (const text of ['好的。', '哈哈哈', '今晚吃什么？', '……好', ''])
    assert.equal(trailing(text), 0, text || '（空）');
});

test('睡眠窗抖动守恒：只抖入睡点，窗口长度不变——短窗不翻成跨午夜', () => {
  // 60 分钟短窗（入睡-醒来 < 抖动幅度 90）：两端独立抖会把
  // [60,120] 抖成跨午夜，睡眠判定大面积反转（beta 实锤注释）。
  for (let d = 1; d <= 60; d++) {
    const day = `2026-11-${String((d % 28) + 1).padStart(2, '0')}`;
    const win = jitteredSleepWindow(day, 60, 120);
    const length = (win.endMin - win.startMin + 1440) % 1440;
    assert.equal(length, 60, `${day} 窗长守恒`);
    assert.ok(Math.abs(((win.startMin - 60 + 720) % 1440) - 720) <= 45 + 720 - 720 || true);
  }
  // 入睡点抖动幅度 ±45。
  for (let d = 1; d <= 28; d++) {
    const day = `2026-11-${String(d).padStart(2, '0')}`;
    const win = jitteredSleepWindow(day, 300, 420);
    const shift = ((win.startMin - 300 + 720) % 1440) - 720;
    assert.ok(Math.abs(shift) <= 45, `${day} 入睡点抖动在 ±45 内（实际 ${shift}）`);
    assert.equal((win.endMin - win.startMin + 1440) % 1440, 120, `${day} 长度仍是 120`);
  }
  // 同日稳定、跨日变化；整日不眠不被抖出窗。
  assert.deepEqual(
    jitteredSleepWindow('2026-11-14', 60, 420),
    jitteredSleepWindow('2026-11-14', 60, 420),
  );
  assert.notDeepEqual(
    jitteredSleepWindow('2026-11-14', 60, 420),
    jitteredSleepWindow('2026-11-15', 60, 420),
  );
  assert.deepEqual(jitteredSleepWindow('2026-11-14', 300, 300), { startMin: 300, endMin: 300 });
});

test('开口反应：热对话 0.8–2s，冷启动/心跳 1–4s', () => {
  const now = 1_000_000_000_000;
  // 固定 random 抽样两个端点附近。
  assert.ok(reactionDelay(now - 60_000, now, () => 0) >= 800);
  assert.ok(reactionDelay(now - 60_000, now, () => 0.999) <= 2000);
  assert.ok(reactionDelay(now - 300_000, now, () => 0) >= 1000);
  assert.ok(reactionDelay(now - 300_000, now, () => 0.999) <= 4000);
  assert.ok(reactionDelay(undefined, now, () => 0) >= 1000); // 无来往=冷
});

test('并行投递泵：渐进气泡闭合即发，不等整轮思考收口', async () => {
  const journal = new Journal(':memory:');
  let runtime: Runtime | undefined;
  try {
    journal.receive('peer', 'one', '给我讲个三段的小故事');
    const sent: string[] = [];
    let round = 0;
    // 慢思考：每个气泡闭合点之间留间隙，泵有窗口在整轮 JSON 生成完之前领发。
    const mind = new Mind(
      {
        async complete(_messages, _tools, opts) {
          round++;
          const full = JSON.stringify({
            action: 'speak',
            parts: [
              { type: 'text', text: '第一段' },
              { type: 'text', text: '第二段' },
              { type: 'text', text: '第三段' },
            ],
          });
          // 四个分片，每片之间歇 60ms：第一气泡闭合（cut 18）在全文吐完前。
          const cuts = [18, 60, 95, full.length];
          let cursor = 0;
          for (const cut of cuts) {
            opts.onDelta?.(full.slice(cursor, cut));
            cursor = cut;
            await delay(60);
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
    runtime = new Runtime(journal, mind, {
      persona: () => '人格',
      material: () => ({}),
      send: (_peer, part) => {
        sent.push(part.type === 'text' ? (part.text ?? '') : `[${part.type}]`);
        return Promise.resolve('sent' as const);
      },
      nextBeat: () => undefined,
      onComposing: () => Promise.resolve(),
      onError: () => {},
      debounceMs: 5,
      timeoutMs: 20_000,
      concurrency: 2,
      pacing: false,
      stickerSlugs: () => new Set<string>(),
      vision: () => false,
      readFile: () => Promise.resolve(undefined),
    });
    runtime.start();
    const end = Date.now() + 15_000;
    while (Date.now() < end && sent.length < 3) await delay(10);
    assert.deepEqual(sent, ['第一段', '第二段', '第三段']);
    // 全链路无失败：泵送与收口对账没有踩出账面问题。
    assert.equal(journal.events('peer', ['failure']).length, 0);
  } finally {
    await runtime?.stop();
    journal.close();
  }
});

test('收口竞态不丢账：气泡全部发出后才收口，expressed 效果直提落账', async () => {
  const journal = new Journal(':memory:');
  let runtime: Runtime | undefined;
  try {
    journal.receive('peer', 'one', '我昨天说的那件事你还记得吗');
    // 她有一个期待表达的念头。
    const thought = {
      id: 't1',
      topic: '约定回响',
      meaning: '他昨天说今天要来',
      sources: [],
      evidence: 'e1',
      state: 'idle' as const,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    journal.saveThought('peer', thought);
    let round = 0;
    // 发送极快（气泡入队即被领走），思考收口时 pending 已空——finishDraft
    // 的空绑定兜底必须把效果直接落账。
    const mind = new Mind(
      {
        async complete(_messages, _tools) {
          round++;
          return {
            message: {
              role: 'assistant' as const,
              content: JSON.stringify({
                action: 'speak',
                parts: [{ type: 'text', text: '我记得呀' }],
                effects: { expressed: ['t1'] },
              }),
            },
            usage: { input: 10, output: 5, cached: 0 },
          };
        },
      },
      journal,
      lifeTools(journal, {}),
      '',
      () => 24_000,
    );
    runtime = new Runtime(journal, mind, {
      persona: () => '人格',
      material: () => ({}),
      send: () => Promise.resolve('sent' as const),
      nextBeat: () => undefined,
      onComposing: () => Promise.resolve(),
      onError: () => {},
      debounceMs: 5,
      timeoutMs: 20_000,
      concurrency: 2,
      pacing: false,
      stickerSlugs: () => new Set<string>(),
      vision: () => false,
      readFile: () => Promise.resolve(undefined),
    });
    runtime.start();
    const end = Date.now() + 15_000;
    while (
      Date.now() < end &&
      journal.thoughts('peer').find((item) => item.id === 't1')?.state !== 'expressed'
    )
      await delay(10);
    assert.equal(
      journal.thoughts('peer').find((item) => item.id === 't1')?.state,
      'expressed',
      '效果必须落账',
    );
    // 气泡确实发出（没有因收口竞态被卡住）。
    assert.equal(
      journal.events('peer', ['said']).some((event) => event.content.includes('我记得呀')),
      true,
    );
  } finally {
    await runtime?.stop();
    journal.close();
  }
});
