import test from 'node:test';
import assert from 'node:assert/strict';
import { Journal } from '../src/storage/journal.js';
import { nextYearAfter } from '../src/domain/commitment.js';

test('多年离线的周年安排直接滚到未来，闰日取平年二月末', () => {
  assert.equal(
    nextYearAfter(Date.UTC(2020, 1, 29, 12), Date.UTC(2026, 10, 13)),
    Date.UTC(2027, 1, 28, 12),
  );
  assert.equal(
    nextYearAfter(Date.UTC(2020, 1, 29, 12), Date.UTC(2027, 11, 1)),
    Date.UTC(2028, 1, 29, 12),
  );
});

test('约定变更后，旧草稿送达不标记新约定已问', () => {
  const journal = new Journal(':memory:', () => 1000);
  try {
    journal.receive('peer', 'one', '提醒取快递');
    const source = journal.events('peer')[0]!.id;
    const input = {
      content: '取快递',
      kind: 'reminder' as const,
      sources: [source],
      dueAt: 2000,
      recurring: 'none' as const,
    };
    const commitment = journal.keepCommitment('peer', input);
    const turn = journal.begin('peer', 'chat');
    journal.draft(turn, [{ type: 'text', text: '该取快递了' }], { asked: [commitment.id] });
    const envelope = journal.pending('peer')[0]!;
    journal.startDelivery(envelope.id);
    journal.keepCommitment('peer', { ...input, dueAt: 3000 });
    journal.delivery(envelope.id, 'sent');
    assert.equal(journal.commitments('peer')[0]!.askedAt, 0);
    assert.equal(journal.commitments('peer')[0]!.dueAt, 3000);
  } finally {
    journal.close();
  }
});

test('提醒独立于心跳，改期和了结后重算最近到期时间', () => {
  const journal = new Journal(':memory:', () => 1000);
  try {
    journal.receive('peer', 'one', '有两件事');
    const source = journal.events('peer')[0]!.id;
    const first = {
      content: '第一件',
      kind: 'reminder' as const,
      sources: [source],
      dueAt: 2000,
      recurring: 'none' as const,
    };
    const second = journal.keepCommitment('peer', { ...first, content: '第二件', dueAt: 3000 });
    journal.keepCommitment('peer', first);
    journal.schedule('peer', 'beat', 9000);
    assert.equal(journal.jobs().find((job) => job.kind === 'reminder')!.due_at, 2000);
    journal.keepCommitment('peer', { ...first, dueAt: 5000 });
    assert.equal(journal.jobs().find((job) => job.kind === 'reminder')!.due_at, 3000);
    journal.resolveCommitment('peer', second.id);
    assert.equal(journal.jobs().find((job) => job.kind === 'reminder')!.due_at, 5000);
    assert.equal(journal.jobs().find((job) => job.kind === 'beat')!.due_at, 9000);
  } finally {
    journal.close();
  }
});

test('约定来源隔离，周年解决后续期，普通挂念解决后退场', () => {
  const now = Date.UTC(2026, 10, 13);
  const journal = new Journal(':memory:', () => now);
  try {
    journal.receive('peer', 'one', '生日');
    const source = journal.events('peer')[0]!.id;
    const input = {
      content: '生日',
      kind: 'reminder' as const,
      sources: [source],
      dueAt: Date.UTC(2020, 1, 29),
      recurring: 'yearly' as const,
    };
    assert.throws(() => journal.keepCommitment('peer', { ...input, sources: ['fake'] }));
    const yearly = journal.keepCommitment('peer', input);
    assert.equal(journal.resolveCommitment('peer', yearly.id), true);
    assert.ok(journal.commitments('peer')[0]!.dueAt > now);
    assert.equal(
      journal.jobs().find((job) => job.kind === 'reminder')!.due_at,
      journal.commitments('peer')[0]!.dueAt,
    );
    const concern = journal.keepCommitment('peer', {
      ...input,
      content: '工作压力',
      kind: 'concern',
      recurring: 'none',
      dueAt: 0,
    });
    journal.resolveCommitment('peer', concern.id);
    assert.equal(
      journal.commitments('peer').find((item) => item.id === concern.id)!.state,
      'resolved',
    );
  } finally {
    journal.close();
  }
});
