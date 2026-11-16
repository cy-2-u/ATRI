import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal } from '../src/storage/journal.js';
import { Recollection } from '../src/domain/memory.js';

function fixture() {
  let now = 1000;
  const directory = mkdtempSync(join(tmpdir(), 'atri-journal-'));
  const path = join(directory, 'test.db');
  let journal = new Journal(path, () => now);
  return {
    get journal() {
      return journal;
    },
    advance(step = 1000) {
      now += step;
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

test('账号换绑：记忆与对话整体搬到新账号 peer，旧 peer 退场', () => {
  const env = fixture();
  try {
    const oldPeer = 'wechat:old-bot:alice';
    const newPeer = 'wechat:new-bot:alice';
    env.journal.receive(oldPeer, 'event-1', '我不吃香菜');
    env.journal.saveMemory(oldPeer, {
      id: 'mem-1',
      content: '他不吃香菜',
      kind: 'stated',
      sources: ['event-1'],
      status: 'active',
      detail: 0.9,
      importance: 0.7,
      emotion: 0,
      consolidation: 0,
      interference: 0,
      createdAt: 1000,
      evaluatedAt: 1000,
      lastRehearsedAt: 0,
      pinned: false,
    } as never);
    env.journal.setSetting(`mood:${oldPeer}`, { pleasure: 0.4, energy: 0, patience: 0, at: 1000 });
    env.journal.setSetting(`wechat:context:${oldPeer}`, 'ctx-token');
    env.journal.savePeerModel(oldPeer, {
      beliefs: [{ text: '他在忙项目', basis: ['event-1'] }],
      updatedAt: 1000,
    });
    env.journal.setSetting(`notes:${oldPeer}`, '最近在聊装修');
    env.journal.setSetting(`notes:seq:${oldPeer}`, 42);
    env.journal.schedule(oldPeer, 'beat', 5000);
    // 换绑前新账号已长出自己的心情瞬态：保留现值，不被旧值覆盖。
    env.journal.setSetting(`mood:${newPeer}`, { pleasure: 0.8, energy: 0, patience: 0, at: 2000 });

    env.journal.remapPeers('old-bot', 'new-bot');

    assert.equal(env.journal.events(newPeer).length, 1);
    assert.equal(env.journal.events(oldPeer).length, 0);
    assert.equal(env.journal.memories(newPeer).length, 1);
    // 心智模型与话题笔记是她的资产：换绑账号不能丢（连同笔记游标）。
    assert.equal(env.journal.peerModel(newPeer)?.beliefs[0]?.text, '他在忙项目');
    assert.equal(env.journal.setting(`notes:${newPeer}`, ''), '最近在聊装修');
    assert.equal(env.journal.setting(`notes:seq:${newPeer}`, 0), 42);
    assert.equal(
      (
        env.journal.setting<{ pleasure: number }>(`mood:${newPeer}`, { pleasure: 0 }) as {
          pleasure: number;
        }
      ).pleasure,
      0.8,
    );
    assert.equal(env.journal.setting(`wechat:context:${newPeer}`, ''), 'ctx-token');
    assert.ok(env.journal.jobs().some((job) => job.peer === newPeer && job.kind === 'beat'));
    assert.equal(
      env.journal.peers().some((peer) => peer === oldPeer),
      false,
    );
  } finally {
    env.close();
  }
});

test('终态念头超龄退场，idle 的一律保留', () => {
  const env = fixture();
  try {
    env.journal.receive('peer', '1', 'hello');
    const base = { sources: ['event-1'], evidence: 'e', createdAt: 1000 };
    env.journal.saveThought('peer', {
      ...base,
      id: 't-old',
      topic: '旧的已表达',
      meaning: '说过了',
      state: 'expressed',
      updatedAt: 1000,
    });
    env.journal.saveThought('peer', {
      ...base,
      id: 't-idle',
      topic: '还惦记着',
      meaning: '等一个时机',
      state: 'idle',
      updatedAt: 1000,
    });
    // 推进 31 天（一天 = 86_400_000 ms，别再少写三个零），再存"此刻"的终态。
    for (let i = 0; i < 31; i++) env.advance(86_400_000);
    env.journal.saveThought('peer', {
      ...base,
      id: 't-fresh',
      topic: '刚表达',
      meaning: '刚说完',
      state: 'expressed',
      updatedAt: 2_678_401_000,
    });
    assert.equal(env.journal.pruneThoughts(30 * 86_400_000), 1);
    const left = env.journal.thoughts('peer').map((thought) => thought.id);
    assert.deepEqual([...left].sort(), ['t-fresh', 't-idle']);
  } finally {
    env.close();
  }
});

test('用量流水超龄退场', () => {
  const env = fixture();
  try {
    env.journal.recordUsage('primary', 'm', 10, 5, 0); // at = 1000
    for (let i = 0; i < 91; i++) env.advance(86_400_000); // now = 1000 + 91d
    assert.equal(env.journal.pruneUsage(90 * 86_400_000), 1);
    assert.deepEqual(env.journal.usage(7), []);
  } finally {
    env.close();
  }
});

test('媒体引用集：SQL 侧只筛含 media 的行，误报文本不炸', () => {
  const env = fixture();
  try {
    env.journal.receive(
      'peer',
      'with-media',
      JSON.stringify({ text: '看这张', media: [{ path: 'media/a.jpg', mime: 'image/jpeg' }] }),
    );
    env.journal.receive('peer', 'plain', '他聊到 "media": 这个词，不是附件');
    env.journal.receive('peer', 'text', '普通一句话');
    const referenced = env.journal.referencedMedia('peer');
    assert.equal(referenced.size, 1);
    assert.ok(referenced.has('media/a.jpg'));
  } finally {
    env.close();
  }
});

test('待补嵌入计数不随一批语料的上限截断', () => {
  const env = fixture();
  try {
    for (let i = 0; i < 300; i++) env.journal.receive('peer', `k${i}`, `消息${i}`);
    // searchable 是"一批嵌入语料"（截到 128），计数是真实积压。
    assert.equal(env.journal.searchable('peer', 'embed-model', 4096).length, 128);
    assert.equal(env.journal.searchablePendingCount('peer', 'embed-model'), 300);
    const first = env.journal.searchable('peer', 'embed-model', 1)[0]!;
    env.journal.setEmbedding(first.id, 'embed-model', new Float32Array([1, 0]));
    assert.equal(env.journal.searchablePendingCount('peer', 'embed-model'), 299);
  } finally {
    env.close();
  }
});
