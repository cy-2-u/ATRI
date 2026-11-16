import test from 'node:test';
import assert from 'node:assert/strict';
import { Journal } from '../src/storage/journal.js';
import { lifeTools } from '../src/domain/tools.js';

const options = () => ({ deadlineAt: Date.now() + 1000 });

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
    await assert.rejects(
      tools
        .get('remember')!
        .execute({ content: 'x', gist: 'x', kind: 'stated', sources: ['fake'] }, options(), turn),
    );
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
