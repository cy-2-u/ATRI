import test from 'node:test';
import assert from 'node:assert/strict';
import { Journal } from '../src/storage/journal.js';
import { nextOccurrence, nextYearAfter } from '../src/domain/commitment.js';

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

test('到期约定重排进冷却，未来约定不受牵连——模型没处理就不许十几秒一拍地烧', () => {
  const journal = new Journal(':memory:', () => 1000);
  try {
    journal.receive('peer', 'one', '别忘了');
    const source = journal.events('peer')[0]!.id;
    const overdue = {
      content: '过期的提醒',
      kind: 'reminder' as const,
      sources: [source],
      dueAt: 500,
      recurring: 'none' as const,
    };
    journal.keepCommitment('peer', overdue);
    // 已到期的约定不再排 0 间隔（dueAt 写错到过去的风暴回归钉）
    assert.equal(journal.jobs().find((job) => job.kind === 'reminder')!.due_at, 1000 + 600_000);
    // 拍后重算带睡眠窗下限：floor 更晚则取 floor
    journal.rearmReminders('peer', 700_000);
    assert.equal(journal.jobs().find((job) => job.kind === 'reminder')!.due_at, 700_000);
    // 未来约定不受冷却拖累，也不被 floor 推迟
    journal.keepCommitment('peer', { ...overdue, content: '未来的提醒', dueAt: 2000 });
    journal.rearmReminders('peer', 700_000);
    assert.equal(journal.jobs().find((job) => job.kind === 'reminder')!.due_at, 2000);
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
      recurring: 'year' as const,
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

test('nextOccurrence：day/week 加法递进，month/year 月份算术 + 月末 clamp', () => {
  const anchor = Date.UTC(2026, 0, 31, 9, 30); // 1月31日 09:30
  // day/week 保持时分秒；了结发生在发生时刻，下一次严格更晚。
  assert.equal(nextOccurrence(anchor, 'day', anchor), Date.UTC(2026, 1, 1, 9, 30));
  assert.equal(
    nextOccurrence(anchor, 'day', Date.UTC(2026, 1, 1, 9, 30)),
    Date.UTC(2026, 1, 2, 9, 30),
  );
  assert.equal(
    nextOccurrence(anchor, 'week', Date.UTC(2026, 1, 1, 9, 30)),
    Date.UTC(2026, 1, 7, 9, 30),
  );
  // 1/31 + 1 月 → 2/28（clamp），+ 2 月 → 3/31（恢复）。
  assert.equal(nextOccurrence(anchor, 'month', anchor), Date.UTC(2026, 1, 28, 9, 30));
  assert.equal(
    nextOccurrence(anchor, 'month', Date.UTC(2026, 1, 28, 9, 30)),
    Date.UTC(2026, 2, 31, 9, 30),
  );
  // 闰日年：2/29 → 平年 2/28，闰年 2/29。
  const leap = Date.UTC(2024, 1, 29, 12);
  assert.equal(nextOccurrence(leap, 'year', leap), Date.UTC(2025, 1, 28, 12));
  assert.equal(nextOccurrence(leap, 'year', Date.UTC(2025, 1, 28, 12)), Date.UTC(2026, 1, 28, 12));
  // 落后多年的锚点直接跳到未来。
  assert.equal(nextOccurrence(leap, 'year', Date.UTC(2026, 5, 1)), Date.UTC(2027, 1, 28, 12));
});

test('周期约定 day/week/month：了结自动续期，askedAt 清零', () => {
  const now = Date.UTC(2026, 10, 13);
  const journal = new Journal(':memory:', () => now);
  try {
    journal.receive('peer', 'one', '建个习惯');
    const source = journal.events('peer')[0]!.id;
    const base = {
      content: '浇水',
      kind: 'reminder' as const,
      sources: [source],
      dueAt: now,
      recurring: 'none' as const,
    };
    for (const [unit, next] of [
      ['day', now + 86_400_000],
      ['week', now + 7 * 86_400_000],
      ['month', Date.UTC(2026, 11, 13)],
    ] as const) {
      const item = journal.keepCommitment('peer', {
        ...base,
        content: `浇水${unit}`,
        recurring: unit,
      });
      assert.equal(journal.resolveCommitment('peer', item.id), true);
      const stored = journal.commitments('peer').find((c) => c.id === item.id)!;
      assert.equal(stored.dueAt, next, unit);
      assert.equal(stored.state, 'open', unit);
      assert.equal(stored.askedAt, 0, unit);
    }
    // 无效周期拒绝。
    assert.throws(() =>
      journal.keepCommitment('peer', {
        ...base,
        content: '坏周期',
        recurring: ' fortnightly' as never,
      }),
    );
  } finally {
    journal.close();
  }
});
