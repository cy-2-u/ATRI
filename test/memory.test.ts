import test from 'node:test';
import assert from 'node:assert/strict';
import { Recollection } from '../src/domain/memory.js';
import { Journal } from '../src/storage/journal.js';

function fixture() {
  let now = 1000;
  const journal = new Journal(':memory:', () => now);
  const memory = new Recollection(journal, () => now);
  journal.receive('peer', 'one', '我喜欢喝茶，通常是周六下午三点');
  const source = journal.events('peer')[0]!.id;
  return {
    journal,
    memory,
    source,
    advance(days: number) {
      now += days * 86_400_000;
    },
  };
}

test('记忆拒绝伪造来源、其他联系人的来源及把自己的话当对方陈述', () => {
  const { journal, memory, source } = fixture();
  try {
    const input = {
      content: '喜欢喝茶',
      gist: '喜欢茶',
      kind: 'stated' as const,
      sources: [source],
      importance: 0.6,
      emotion: 0.2,
    };
    assert.throws(() => memory.remember('peer', { ...input, sources: ['missing'] }));
    assert.throws(() => memory.remember('other', input));
    const turn = journal.begin('peer', 'beat');
    const receipt = journal.receipt(turn, 'read', { text: 'tea' }, true);
    assert.throws(() => memory.remember('peer', { ...input, sources: [receipt] }));
    assert.equal(memory.remember('peer', input).kind, 'stated');
  } finally {
    journal.close();
  }
});

test('模糊记忆只呈现要旨，回想不会恢复原文细节', () => {
  const env = fixture();
  try {
    const created = env.memory.remember('peer', {
      content: '对方通常周六下午三点喝茶',
      gist: '对方有喝茶的习惯',
      kind: 'stated',
      sources: [env.source],
      importance: 0.6,
      emotion: 0,
    });
    env.advance(20);
    const hit = env.memory.recall('peer', '喝茶')[0]!;
    assert.equal(hit.text, '对方有喝茶的习惯');
    const detail = hit.memory.detail;
    env.memory.rehearse('peer', [created.id]);
    assert.equal(env.memory.recall('peer', '喝茶')[0]!.memory.detail, detail);
  } finally {
    env.journal.close();
  }
});

test('内容相近但相反的记忆不会自动替代，显式更正才替代', () => {
  const { journal, memory, source } = fixture();
  try {
    const first = memory.remember('peer', {
      content: '喜欢茶',
      gist: '喜欢茶',
      kind: 'stated',
      sources: [source],
      importance: 0.6,
      emotion: 0,
    });
    journal.receive('peer', 'two', '现在不喜欢茶了');
    const newer = journal.events('peer').at(-1)!.id;
    memory.remember('peer', {
      content: '不喜欢茶',
      gist: '不喜欢茶',
      kind: 'stated',
      sources: [newer],
      importance: 0.6,
      emotion: 0,
    });
    assert.equal(journal.memories('peer').filter((item) => item.status === 'active').length, 2);
    memory.remember('peer', {
      content: '不喜欢茶',
      gist: '不喜欢茶',
      kind: 'stated',
      sources: [newer],
      importance: 0.6,
      emotion: 0,
      supersedes: [first.id],
    });
    assert.equal(
      journal.memories('peer').find((item) => item.id === first.id)!.status,
      'superseded',
    );
  } finally {
    journal.close();
  }
});

test('旧草稿送达不会清掉新证据形成的同主题念头', () => {
  const { journal, memory, source } = fixture();
  try {
    const thought = memory.consider('peer', 'tea', '想聊茶', [source]);
    const turn = journal.begin('peer', 'chat');
    journal.draft(turn, [{ type: 'text', text: '茶怎么样' }], { expressed: [thought.id] });
    const envelope = journal.pending('peer')[0]!;
    journal.startDelivery(envelope.id);
    journal.receive('peer', 'new', '茶喝完了');
    const fresh = journal.events('peer').at(-1)!.id;
    memory.consider('peer', 'tea', '想聊新变化', [fresh]);
    journal.delivery(envelope.id, 'sent');
    assert.equal(journal.thoughts('peer')[0]!.state, 'idle');
    assert.equal(journal.thoughts('peer')[0]!.meaning, '想聊新变化');
  } finally {
    journal.close();
  }
});

test('已表达话题保持退场，新证据可以重新立项且不触发唯一约束错误', () => {
  const { journal, memory, source } = fixture();
  try {
    const thought = memory.consider('peer', 'tea', '想问喜欢哪种茶', [source]);
    journal.saveThought('peer', { ...thought, state: 'expressed' });
    assert.equal(memory.consider('peer', 'tea', '又想问一次', [source]).state, 'expressed');
    journal.receive('peer', 'two', '刚买了新茶叶');
    const next = memory.consider('peer', 'tea', '想了解新茶叶', [
      journal.events('peer').at(-1)!.id,
    ]);
    assert.equal(next.state, 'idle');
    assert.equal(next.id, thought.id);
    assert.equal(journal.thoughts('peer').length, 1);
  } finally {
    journal.close();
  }
});
