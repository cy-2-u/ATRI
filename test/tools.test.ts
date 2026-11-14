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
