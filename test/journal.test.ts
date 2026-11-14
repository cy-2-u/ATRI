import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal } from '../src/storage/journal.js';
import { Recollection } from '../src/domain/memory.js';

function fixture() {
  let now = 1000;
  const directory = mkdtempSync(join(tmpdir(), 'xing-journal-'));
  const path = join(directory, 'test.db');
  let journal = new Journal(path, () => now);
  return {
    get journal() {
      return journal;
    },
    advance() {
      now += 1000;
    },
    reopen() {
      journal.close();
      journal = new Journal(path, () => now);
      journal.recover();
    },
    close() {
      journal.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test('入站幂等，草稿不冒充说过，确认送达才提交表达效果', () => {
  const env = fixture();
  try {
    assert.equal(env.journal.receive('peer', 'event-1', 'hello'), true);
    assert.equal(env.journal.receive('peer', 'event-1', 'hello'), false);
    const loop = env.journal.keepCommitment('peer', {
      content: '问候',
      kind: 'reminder',
      sources: [env.journal.events('peer')[0]!.id],
      dueAt: 1000,
      recurring: 'none',
    });
    const turn = env.journal.begin('peer', 'chat');
    assert.equal(
      env.journal.draft(turn, [{ type: 'text', text: 'hi' }], { asked: [loop.id] }),
      true,
    );
    assert.deepEqual(
      env.journal.events('peer').map((event) => event.kind),
      ['received'],
    );
    assert.equal(env.journal.committedEffects(turn.id), undefined);
    const envelope = env.journal.pending('peer')[0]!;
    assert.equal(env.journal.startDelivery(envelope.id), true);
    env.advance();
    assert.equal(env.journal.delivery(envelope.id, 'sent'), true);
    assert.equal(env.journal.delivery(envelope.id, 'sent'), false);
    assert.deepEqual(env.journal.committedEffects(turn.id), { asked: [loop.id] });
    assert.equal(env.journal.commitments('peer')[0]!.askedAt, 2000);
    assert.equal(env.journal.events('peer').at(-1)!.created_at, 2000);
  } finally {
    env.close();
  }
});

test('新消息作废旧思考和未发草稿，旧版本不能回写', () => {
  const env = fixture();
  try {
    env.journal.receive('peer', '1', 'one');
    const stale = env.journal.begin('peer', 'chat');
    env.journal.receive('peer', '2', 'two');
    assert.equal(env.journal.draft(stale, [{ type: 'text', text: 'stale' }]), false);
    const next = env.journal.begin('peer', 'chat');
    env.journal.draft(next, [{ type: 'text', text: 'draft' }]);
    env.journal.receive('peer', '3', 'three');
    assert.deepEqual(env.journal.pending('peer'), []);
  } finally {
    env.close();
  }
});

test('发送中崩溃恢复为未知，不重复发送，人工确认后才提交', () => {
  const env = fixture();
  try {
    env.journal.receive('peer', '1', 'one');
    const turn = env.journal.begin('peer', 'chat');
    const thought = new Recollection(env.journal).consider('peer', 'greeting', '想打个招呼', [
      env.journal.events('peer')[0]!.id,
    ]);
    env.journal.draft(
      turn,
      [
        { type: 'text', text: 'first' },
        { type: 'text', text: 'second' },
      ],
      { expressed: [thought.id] },
    );
    const [first, second] = env.journal.pending('peer');
    assert.equal(env.journal.startDelivery(first!.id), true);
    env.reopen();
    assert.equal(env.journal.startDelivery(first!.id), false);
    assert.equal(env.journal.startDelivery(second!.id), false);
    assert.equal(env.journal.committedEffects(turn.id), undefined);
    assert.equal(env.journal.events('peer').filter((event) => event.kind === 'said').length, 0);
    assert.equal(env.journal.thoughts('peer')[0]!.state, 'idle');
    assert.equal(env.journal.self().lastDeliveredAt, 0);
    assert.equal(env.journal.delivery(first!.id, 'sent'), true);
    assert.equal(env.journal.startDelivery(second!.id), true);
    assert.equal(env.journal.committedEffects(turn.id), undefined);
    assert.equal(env.journal.delivery(second!.id, 'sent'), true);
    assert.deepEqual(env.journal.committedEffects(turn.id), { expressed: [thought.id] });
    assert.equal(env.journal.thoughts('peer')[0]!.state, 'expressed');
    assert.equal(env.journal.self().lastDeliveredAt, 1000);
    assert.equal(env.journal.self().lastReceivedAt, 1000);
  } finally {
    env.close();
  }
});

test('工具经历独立于草稿和取消留存，失败尝试不记成做过', () => {
  const env = fixture();
  try {
    env.journal.receive('peer', '1', 'one');
    const turn = env.journal.begin('peer', 'beat');
    env.journal.receipt(turn, 'write_file', { path: 'note.txt' }, true);
    env.journal.receipt(turn, 'run', { error: 'denied' }, false);
    env.journal.receive('peer', '2', 'two');
    assert.equal(env.journal.draft(turn, [{ type: 'text', text: 'stale' }]), false);
    assert.deepEqual(
      env.journal.events('peer').map((event) => event.kind),
      ['received', 'experienced', 'attempted', 'received'],
    );
  } finally {
    env.close();
  }
});

test('设置只编码一次，重启后保持对象类型', () => {
  const env = fixture();
  try {
    env.journal.setSetting('mood:peer', { pleasure: 0.3 });
    env.reopen();
    assert.deepEqual(env.journal.setting('mood:peer', {}), { pleasure: 0.3 });
  } finally {
    env.close();
  }
});
