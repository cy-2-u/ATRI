import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal } from '../src/storage/journal.js';
import { lifeTools, TOOL_SETS } from '../src/domain/tools.js';
import { Sandbox } from '../src/sandbox.js';
import { Wall } from '../src/wall.js';
import type { WebTools } from '../src/web.js';
import type { ImagePainter } from '../src/image.js';
import type { Stickers } from '../src/stickers.js';

const options = () => ({ deadlineAt: Date.now() + 1000 });

test('read_history：按 ids 精确取原文，气泡渲染成可读文本', async () => {
  const journal = new Journal(':memory:');
  try {
    journal.receive('peer', 'one', '我们养了一只猫叫年糕');
    const source = journal.events('peer')[0]!.id;
    const chat = journal.begin('peer', 'chat');
    await new Map(lifeTools(journal, {}).map((t) => [t.definition.name, t]))
      .get('remember')!
      .execute(
        { content: '养了猫叫年糕', gist: '养猫', kind: 'stated', sources: [source] },
        options(),
        chat,
      );
    journal.fail(chat, '收口');
    const turn = journal.begin('peer', 'chat');
    const tools = new Map(lifeTools(journal, {}).map((tool) => [tool.definition.name, tool]));
    // 通道一：给 ids（记忆 sources 的核对路径）。
    const byIds = (await tools
      .get('read_history')!
      .execute({ ids: [source] }, options(), turn)) as { who: string; text: string }[];
    assert.equal(byIds.length, 1);
    assert.equal(byIds[0]!.who, '他');
    assert.equal(byIds[0]!.text, '我们养了一只猫叫年糕');
    // 通道二：最近 N 条同样渲染（不是裸 JSON）。
    const recent = (await tools.get('read_history')!.execute({ limit: 5 }, options(), turn)) as {
      text: string;
    }[];
    assert.ok(recent.every((row) => !row.text.startsWith('{"')));
  } finally {
    journal.close();
  }
});

test('心跳开场指纹：beat 产出的气泡可查，chat 产出的不混入', () => {
  const journal = new Journal(':memory:');
  try {
    journal.receive('peer', 'one', '早');
    // said 事件在投递成功时落库：模拟完整链路。
    const deliver = (turn: ReturnType<typeof journal.begin>) => {
      journal.draft(turn, [{ type: 'text', text: `开场:${turn.kind}` }], {});
      const envelope = journal.pending('peer')[0]!;
      journal.startDelivery(envelope.id);
      journal.delivery(envelope.id, 'sent');
    };
    deliver(journal.begin('peer', 'beat'));
    deliver(journal.begin('peer', 'chat'));
    const openers = journal.recentBeatOpeners('peer', Date.now() - 48 * 3_600_000);
    assert.deepEqual(openers, ['开场:beat']);
  } finally {
    journal.close();
  }
});

test('记忆工具使用当前联系人来源，检索结果不泄露隐藏原文', async () => {
  const journal = new Journal(':memory:');
  try {
    journal.receive('peer', 'one', '喜欢喝茶');
    const turn = journal.begin('peer', 'chat');
    const source = journal.events('peer')[0]!.id;
    const tools = new Map(lifeTools(journal, {}).map((tool) => [tool.definition.name, tool]));
    await tools.get('remember')!.execute(
      {
        content: '对方喜欢喝茶，暗号为 123456',
        gist: '对方喜欢茶',
        kind: 'stated',
        sources: [source],
      },
      options(),
      turn,
    );
    const memory = journal.memories('peer')[0]!;
    journal.saveMemory('peer', { ...memory, detail: 0.4 });
    const result = await tools.get('search_memory')!.execute({ query: '喝茶' }, options(), turn);
    assert.ok(!JSON.stringify(result).includes('123456'));
    assert.ok(JSON.stringify(result).includes('对方喜欢茶'));
    const history = await tools.get('read_history')!.execute({}, options(), turn);
    assert.ok(JSON.stringify(history).includes(source));
    // 校验退役（用户裁决 2026-11-26）：伪造来源照单全收不拦。
    const bogus = await tools
      .get('remember')!
      .execute({ content: 'x', gist: 'x', kind: 'stated', sources: ['fake'] }, options(), turn);
    assert.ok(bogus);
  } finally {
    journal.close();
  }
});

test('话题笔记只在整理拍写，落地时推进 seq 游标', async () => {
  const journal = new Journal(':memory:');
  try {
    for (let i = 0; i < 8; i++) journal.receive('peer', `m${i}`, `消息${i}`);
    const tools = new Map(lifeTools(journal, {}).map((tool) => [tool.definition.name, tool]));
    const chatTurn = journal.begin('peer', 'chat');
    await assert.rejects(
      tools.get('update_topic_notes')!.execute({ content: '笔记' }, options(), chatTurn),
    );
    journal.fail(chatTurn, '测试收口');
    // 8 条增量 ≥ 6：工具落地时游标推进到末条 seq（全局自增，第 8 条 = 8）。
    const tidyTurn = journal.begin('peer', 'tidy');
    await tools
      .get('update_topic_notes')!
      .execute({ content: '在聊期末和猫' }, options(), tidyTurn);
    assert.equal(journal.setting<string>('notes:peer', ''), '在聊期末和猫');
    assert.equal(journal.setting<number>('notes:seq:peer', 0), 8);
  } finally {
    journal.close();
  }
});

test('日记召回：词面命中、情绪随行、detail 分级渲染', async () => {
  const journal = new Journal(':memory:');
  try {
    const tools = new Map(lifeTools(journal, {}).map((tool) => [tool.definition.name, tool]));
    journal.receive('peer', 'seed', '我们在聊猫');
    const source = journal.events('peer')[0]!.id;
    const turn = journal.begin('peer', 'diary');
    await tools.get('write_journal')!.execute(
      {
        sections: [{ content: '今天聊了猫咪罐头的事，很开心', emotion: 0.6, sources: [source] }],
      },
      options(),
      turn,
    );
    journal.draft(turn, [], {});
    const chatTurn = journal.begin('peer', 'chat');
    const hits = (await tools
      .get('search_memory')!
      .execute({ query: '猫咪罐头', kind: 'diary' }, options(), chatTurn)) as {
      text: string;
      certainty: string;
    }[];
    assert.equal(hits.length, 1);
    assert.ok(hits[0]!.text.includes('罐头'));
    assert.equal(hits[0]!.certainty, 'clear');
    // 词面不相干的查询翻不到。
    const none = (await tools
      .get('search_memory')!
      .execute({ query: '完全无关的词', kind: 'diary' }, options(), chatTurn)) as unknown[];
    assert.equal(none.length, 0);
  } finally {
    journal.close();
  }
});

test('TOOL_SETS 全集不变量：每个注册工具必须至少进一个白名单', () => {
  // 漏配 = 模型永远看不见该工具 = 静默死工具（read_wall 事故，CI 实锤过）。
  // 这个不变量锁住整个族：今后新增工具忘配白名单，测试直接红。
  // deps 必须满配——手眼墙画笔都是条件注册的，空 deps 枚举不全。
  const journal = new Journal(':memory:');
  const root = mkdtempSync(join(tmpdir(), 'atri-tools-'));
  const sandbox = new Sandbox(join(root, 'sandbox'), {
    enabled: () => true,
    network: () => false,
    sizeLimitBytes: () => 32 * 1024 * 1024,
  });
  try {
    const registered = new Set(
      lifeTools(journal, {
        sandbox,
        web: {} as unknown as WebTools,
        image: {} as unknown as ImagePainter,
        wall: new Wall(journal.db, root),
        stickers: { list: () => [] } as unknown as Stickers,
      }).map((t) => t.definition.name),
    );
    const whitelisted = new Set<string>(Object.values(TOOL_SETS).flat());
    const missing = [...registered].filter((name) => !whitelisted.has(name));
    assert.deepEqual(missing, [], `死工具（注册了但没进任何拍的白名单）：${missing.join('、')}`);
    // 反向也有价值：白名单里的名字必须是真工具，拼错等于凭空引用。
    const unknown = [...whitelisted].filter((name) => !registered.has(name));
    assert.deepEqual(unknown, [], `白名单引用了不存在的工具：${unknown.join('、')}`);
  } finally {
    sandbox.dispose();
    journal.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('read_wall 必须在 chat/beat 白名单里：提示牌的引导才不落空', () => {
  for (const kind of ['chat', 'beat'] as const) {
    assert.ok(
      TOOL_SETS[kind].includes('read_wall'),
      `${kind} 拍看不到 read_wall，提示牌的引导就落空`,
    );
  }
});

test('到期时间锚定她的时区：裸本地时间、带偏移 ISO、Unix 毫秒三路全通', async () => {
  const journal = new Journal(':memory:');
  try {
    journal.receive('peer', 'one', '明天提醒我浇水');
    const turn = journal.begin('peer', 'chat');
    const source = journal.events('peer')[0]!.id;
    const tools = new Map(
      lifeTools(journal, { timezone: () => 'Asia/Shanghai' }).map((t) => [t.definition.name, t]),
    );
    // 裸本地时间：GLM 吐无偏移墙钟不再整轮打回——上海 20:00 = UTC 12:00。
    const bare = (await tools
      .get('keep_commitment')!
      .execute(
        { content: '浇水', kind: 'reminder', sources: source, dueAt: '2026-07-01T20:00:00' },
        options(),
        turn,
      )) as { dueAt: number };
    assert.equal(bare.dueAt, Date.parse('2026-07-01T12:00:00Z'));
    // 带偏移 ISO 直通；数字毫秒直通；单字符串 sources 自动包数组。
    const iso = (await tools
      .get('keep_commitment')!
      .execute(
        { content: '开会', kind: 'reminder', sources: source, dueAt: '2026-07-02T09:00:00+08:00' },
        options(),
        turn,
      )) as { dueAt: number };
    assert.equal(iso.dueAt, Date.parse('2026-07-02T01:00:00Z'));
    const ms = (await tools
      .get('keep_commitment')!
      .execute(
        { content: '跑步', kind: 'concern', sources: [source], dueAt: 1751467200000 },
        options(),
        turn,
      )) as { dueAt: number };
    assert.equal(ms.dueAt, 1751467200000);
    // dueAt=0：无日期挂念。
    const none = (await tools
      .get('keep_commitment')!
      .execute(
        { content: '想他', kind: 'concern', sources: source, dueAt: 0 },
        options(),
        turn,
      )) as {
      dueAt: number;
    };
    assert.equal(none.dueAt, 0);
    // consider 的 dueAt 同样吃墙钟 ISO（明天上午八点，未来时刻）。
    const thought = (await tools
      .get('consider')!
      .execute(
        { topic: '爬山', meaning: '提醒带水', sources: source, dueAt: '2030-07-03T08:00:00' },
        options(),
        turn,
      )) as { dueAt: number };
    assert.equal(thought.dueAt, Date.parse('2030-07-03T00:00:00Z'));
  } finally {
    journal.close();
  }
});

test('坏时间与坏来源报错带字段名：修复轮知道改哪', async () => {
  const journal = new Journal(':memory:');
  try {
    journal.receive('peer', 'one', '提醒我买菜');
    const turn = journal.begin('peer', 'chat');
    const source = journal.events('peer')[0]!.id;
    const tools = new Map(
      lifeTools(journal, { timezone: () => 'Asia/Shanghai' }).map((t) => [t.definition.name, t]),
    );
    // 2 月 30 日：日历上不存在的日期明确打回。
    await assert.rejects(
      tools
        .get('keep_commitment')!
        .execute(
          { content: '买菜', kind: 'reminder', sources: source, dueAt: '2026-02-30T10:00:00' },
          options(),
          turn,
        ),
      /日期不存在/,
    );
    // 乱文本带字段定位。
    await assert.rejects(
      tools
        .get('keep_commitment')!
        .execute(
          { content: '买菜', kind: 'reminder', sources: source, dueAt: '下周三' },
          options(),
          turn,
        ),
      /dueAt|时间/,
    );
    // sources 混对象：报错点名 sources 字段。
    await assert.rejects(
      tools
        .get('keep_commitment')!
        .execute(
          { content: '买菜', kind: 'reminder', sources: [{ id: source }], dueAt: 1751467200000 },
          options(),
          turn,
        ),
      /sources/,
    );
  } finally {
    journal.close();
  }
});
