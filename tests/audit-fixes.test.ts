import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createBackup } from '@atri/db';
import { dayAt, dropNewestToolRound, rotateStickers } from '@atri/core';
import { ILinkClient, ILinkError } from '@atri/ilink';
import { fixture, FakeModel, completion, promptText } from './helpers.js';

async function waitFor(predicate: () => boolean, timeoutMs = 2000) {
  const until = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > until) throw new Error('等待条件超时');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('多气泡回复仍会更新心情', async (t) => {
  const f = fixture(
    t,
    new FakeModel(() => completion({ messages: ['不客气', '早点休息'], memoryUpdates: [] })),
  );
  f.runtime.accept('p1', 'mood', '谢谢你');
  await f.runtime.drain();
  assert.equal(f.delivered.length, 2, '回复拆成两条气泡');
  const mood = f.store.mood('p1');
  assert.ok(mood.at > 0, '两条气泡之后仍应产生情绪脉冲');
  assert.ok(mood.valence > 0, '感谢应带来正向情绪');
});

test('主动消息不能新增或了结开环', async (t) => {
  const now = Date.now();
  t.mock.method(Date, 'now', () => now);
  t.mock.method(Math, 'random', () => 0);
  const model = new FakeModel();
  const f = fixture(t, model, { proactiveEnabled: true, quietStart: 0, quietEnd: 0 });
  f.store.ensurePeer('wechat:p', 'wechat', 'p', 'ctx', true);
  const source = f.store.ingest('wechat:p', 'src', '我明天面试', [], now - 26 * 3600000).message;
  model.handle = () =>
    completion({
      messages: ['最近还好吗'],
      memoryUpdates: [],
      openLoops: [
        {
          content: '对方明天面试',
          dueAt: now + 86400000,
          dueText: '明天',
          sources: [source.id],
        },
      ],
    });
  f.store.enqueue('wechat:p', 'proactive', 'manual', {}, now);
  await f.runtime.drain();
  assert.equal(f.delivered.length, 1);
  assert.equal(f.store.openLoops('wechat:p').length, 0, '主动消息不应凭空建立开环');
});

test('打断重试不会让旧消息和新消息各回一次', async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const model = new FakeModel(async () => {
    calls++;
    if (calls === 1) {
      await gate;
      return completion({ messages: ['reply-1'], memoryUpdates: [] });
    }
    return completion({ messages: [`reply-${calls}`], memoryUpdates: [] });
  });
  const f = fixture(t, model);
  f.runtime.accept('p1', 'first', '第一条');
  await waitFor(() => calls === 1);
  f.runtime.accept('p1', 'second', '第二条');
  release();
  await f.runtime.drain();
  assert.equal(f.delivered.length, 1, '只应回复最新一条');
  assert.equal(f.delivered[0]!.part.text, 'reply-2');
});

test('失败任务重排时保留退避时间', (t) => {
  const f = fixture(t);
  const now = Date.now();
  const id = f.store.enqueue('p1', 'diary', 'backoff', { through: 1 }, now);
  f.store.claim('p1', now);
  f.store.finish(id, 'failed', '模型超时');
  f.store.deferFailed(id, 10 * 60000);
  const again = f.store.enqueue('p1', 'diary', 'backoff', { through: 1 }, now);
  assert.equal(again, id);
  const task = f.store.taskById(id)!;
  assert.equal(task.state, 'queued');
  assert.ok(task.run_at >= now + 9 * 60000, `退避时间被覆盖为 ${task.run_at}`);
  assert.equal(f.store.claim('p1', now + 1000), undefined, '退避未到不应被认领');
});

test('BudgetError 回退会连同工具结果一起删除', () => {
  const messages = [
    { role: 'system' as const, content: 'system' },
    { role: 'user' as const, content: 'question' },
    {
      role: 'assistant' as const,
      content: '',
      calls: [{ id: 'c1', name: 'search_memory', arguments: {} }],
    },
    { role: 'tool' as const, callId: 'c1', name: 'search_memory', content: '{}' },
    {
      role: 'assistant' as const,
      content: '',
      calls: [{ id: 'c2', name: 'search_memory', arguments: {} }],
    },
    { role: 'tool' as const, callId: 'c2', name: 'search_memory', content: '{}' },
    { role: 'user' as const, content: 'final instruction' },
  ];
  assert.equal(dropNewestToolRound(messages), true);
  assert.deepEqual(
    messages.map((m) => m.role),
    ['system', 'user', 'assistant', 'tool', 'user'],
    '删除最新的 assistant 时必须同时删除它对应的 tool 结果',
  );
});

test('替代记忆时旧向量一并清理', (t) => {
  const f = fixture(t);
  const source = f.store.ingest('p1', 'src', '我周五面试').message;
  const version = f.store.peer('p1')!.version;
  f.store.addMemory('p1', { content: '周五面试', kind: 'stated', sources: [source.id] }, version);
  const old = f.store.memories('p1')[0]!;
  f.store.setEmbedding(old.id, 'p1', 'memory', new Float32Array([1, 0]), 'test-model');
  f.store.addMemory(
    'p1',
    { content: '周六面试', kind: 'stated', sources: [source.id], supersedes: [old.id] },
    f.store.peer('p1')!.version,
  );
  assert.equal(
    f.store.embeddings('p1', 'memory').some((vector) => vector.id === old.id),
    false,
    '被替代的记忆向量不能继续参与语义去重',
  );
});

test('年度循环过了问询窗口会滚到下一年而不是过期', (t) => {
  const now = Date.now();
  const f = fixture(t);
  const source = f.store.ingest('p1', 'src', '我生日快到了').message;
  const loop = f.store.addOpenLoop(
    'p1',
    {
      content: '生日快乐',
      dueAt: now - 10 * 86400000,
      sources: [source.id],
      recurring: 'yearly',
    },
    now - 20 * 86400000,
  );
  f.store.expireOpenLoops('p1', now, 'Asia/Shanghai');
  const after = f.store.openLoops('p1').find((l) => l.id === loop.id)!;
  assert.equal(after.status, 'open');
  assert.ok(after.due_at > now, '年度循环应滚到下一次');
  assert.equal(after.asked, 0);
});

test('新备份不再包含管理密码文件', async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.directory, 'admin-secret.txt'), 'management-password');
  const backup = await createBackup(f.store, f.directory);
  assert.equal(
    backup.manifest.files.some((file) => file.path === 'admin-secret.txt'),
    false,
  );
});

test('未到期开环可见，并能在到期前被了结', async (t) => {
  const now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const f = fixture(t);
  const source = f.store.ingest('p1', 'src', '我下周面试').message;
  const loop = f.store.addOpenLoop('p1', {
    content: '面试结果',
    dueAt: now + 3 * 86400000,
    dueText: '下周三',
    sources: [source.id],
  });
  let seen = '';
  (f.model as FakeModel).handle = (messages) => {
    seen = promptText(messages);
    return completion({
      messages: ['记着呢'],
      memoryUpdates: [],
      resolveLoops: [loop.id],
    });
  };
  f.runtime.accept('p1', 'changed', '面试改到下周三了');
  await f.runtime.drain();
  assert.match(seen, new RegExp(`id:${loop.id}`), '提示词必须包含未到期开环的 id');
  assert.match(seen, /未到期/);
  assert.equal(f.store.openLoops('p1', true).length, 0, '模型可以提前了结');
});

test('分开期间的日记 id 可以被引用为记忆来源', async (t) => {
  const now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const f = fixture(t);
  const old = f.store.ingest('p1', 'old', '最近项目压力很大', [], now - 4 * 86400000).message;
  const day = dayAt(old.created_at, 'Asia/Shanghai');
  f.store.enqueue('p1', 'diary', 'gap-diary', { through: old.seq });
  const task = f.store.claim('p1')!;
  f.store.saveDiary(task, day, [{ content: '他项目压力很大', sources: [old.id] }], []);
  const diary = f.store.diaries('p1')[0]!;
  let seen = '';
  (f.model as FakeModel).handle = (messages) => {
    seen = promptText(messages);
    return completion({
      messages: ['辛苦啦'],
      memoryUpdates: [{ content: '他最近项目压力大', kind: 'interpretation', sources: [diary.id] }],
    });
  };
  f.runtime.accept('p1', 'back', '在吗', [], now);
  await f.runtime.drain();
  assert.match(seen, new RegExp(`id:${diary.id}`), 'gap diary 必须带 id 出现在提示里');
  assert.ok(
    f.store.memories('p1').some((memory) => memory.content.includes('项目压力')),
    '引用 gap diary 的记忆不应被来源过滤掉',
  );
});

test('发过表情后 system 前缀保持稳定', async (t) => {
  const stickers = Array.from({ length: 40 }, (_, i) => ({
    slug: `s${String(i).padStart(2, '0')}`,
    description: `表情${i}`,
    tags: [],
    file: 'f.png',
  }));
  const model = new FakeModel();
  const f = fixture(t, model);
  (f.runtime.agent as any).o.stickers = () => stickers;
  const window = rotateStickers(stickers, [], Date.now());
  const target = window[0]!;
  let turn = 0;
  model.handle = () => {
    turn++;
    return completion({
      messages: turn === 1 ? ['好', { type: 'sticker', slug: target.slug }] : ['嗯'],
      memoryUpdates: [],
    });
  };
  f.runtime.accept('p1', 'one', '在吗');
  await f.runtime.drain();
  const firstSystem = String(model.calls[0]!.messages[0]!.content);
  f.runtime.accept('p1', 'two', '再在吗');
  await f.runtime.drain();
  const secondSystem = String(model.calls[1]!.messages[0]!.content);
  assert.equal(secondSystem, firstSystem, '最近使用表情不应改变 system 前缀');
});

test('空日记是显式契约：不写日记并推进游标', async (t) => {
  const f = fixture(t, new FakeModel(() => completion({ sections: [], memoryUpdates: [] })));
  const message = f.store.ingest('p1', 'empty-day', '今天没什么特别').message;
  f.runtime.queueDiary('p1', true);
  await f.runtime.drain();
  assert.equal(f.store.diaries('p1').length, 0);
  assert.equal(f.store.getSetting('diary_cursor:p1', 0), message.seq);
  assert.equal(f.runtime.queueDiary('p1', true), undefined, '同一批记录不会被反复重跑');
});

test('主动消息的冷落计数按任务算，不把多气泡当成多次已读不回', (t) => {
  const f = fixture(t);
  const now = Date.now();
  for (let i = 0; i < 2; i++) {
    f.store.enqueue('p1', 'proactive', `ping-${i}`, {}, now + i * 1000);
    const task = f.store.claim('p1', now + i * 1000)!;
    assert.equal(
      f.store.saveReply(
        task,
        [
          { type: 'text', text: '在吗' },
          { type: 'text', text: '今天怎么样' },
        ],
        [],
        now + i * 1000,
      ),
      true,
    );
    for (const delivery of f.store.pendingDeliveries('p1')) {
      f.store.startDelivery(delivery.id);
      f.store.markDelivery(delivery.id, 'sent');
    }
  }
  assert.equal(f.store.unansweredProactiveStreak('p1'), 2, '两条主动消息各算一次');
});

test('日记游标只前进不后退，旧任务晚完成不会重做已覆盖的记录', (t) => {
  const f = fixture(t);
  const first = f.store.enqueue('p1', 'diary', 'diary-new', { through: 100 });
  f.store.enqueue('p1', 'diary', 'diary-old', { through: 50 });
  const newer = f.store.claim('p1')!;
  assert.equal(newer.id, first);
  f.store.saveDiary(newer, '2026-10-20', [], []);
  const older = f.store.claim('p1')!;
  f.store.saveDiary(older, '2026-10-19', [], []);
  assert.equal(f.store.getSetting('diary_cursor:p1', 0), 100, '游标不能被旧任务改回 50');
});

test('过期的 notes 快照不能覆盖更新的笔记', (t) => {
  const f = fixture(t);
  const newer = f.store.enqueue('p1', 'notes', 'notes-new', { through: 100 });
  f.store.enqueue('p1', 'notes', 'notes-old', { through: 50 });
  const first = f.store.claim('p1')!;
  assert.equal(first.id, newer);
  f.store.setNotes(first, '新笔记', 100);
  const stale = f.store.claim('p1')!;
  f.store.setNotes(stale, '旧笔记', 50);
  const peer = f.store.peer('p1')!;
  assert.equal(peer.notes, '新笔记');
  assert.equal(peer.notes_until, 100);
});

test('pruneTasks 会顺带清理已删任务的 pending_effects 残留', (t) => {
  const f = fixture(t);
  const old = Date.now() - 40 * 86400000;
  const id = f.store.enqueue('p1', 'chat', 'effects', { text: '早' });
  f.store.setSetting(`pending_effects:${id}`, { loops: ['l1'], threads: ['t1'] });
  f.store.sql.prepare('UPDATE tasks SET state=?, created_at=? WHERE id=?').run('done', old, id);
  f.store.pruneTasks(Date.now());
  assert.equal(f.store.getSetting(`pending_effects:${id}`, null), null);
});

test('getuploadurl 返回的外部主机不会让上传请求变成 SSRF', async () => {
  const original = globalThis.fetch;
  let requests = 0;
  try {
    globalThis.fetch = (async () => {
      requests++;
      return Response.json({ ok: true });
    }) as typeof fetch;
    const client = new ILinkClient({
      botToken: 'token',
      baseUrl: 'https://ilink.test',
      cdnBaseUrl: 'https://cdn.test/c2c',
    });
    await assert.rejects(
      client.uploadEncryptedToCdn({
        plaintext: Buffer.from('image'),
        aesKey: Buffer.alloc(16, 1),
        filekey: 'file-key',
        uploadFullUrl: 'https://evil.example/upload',
      }),
      /host not allowed/,
    );
    assert.equal(requests, 0, '被拒绝的地址不应发出任何请求');
  } finally {
    globalThis.fetch = original;
  }
});

test('CDN 5xx 带 httpStatus 而不是 errcode，便于按暂时失败处理', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = (async (input: unknown) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith('/getuploadurl'))
        return Response.json({ ret: 0, upload_full_url: 'https://cdn.test/upload' });
      // The upload URL is only fetchable when its host is the configured CDN;
      // this test is about HTTP status propagation, not the host gate.

      return new Response('bad gateway', {
        status: 502,
        headers: { 'x-error-message': 'bad gateway' },
      });
    }) as typeof fetch;
    const client = new ILinkClient({
      botToken: 'token',
      baseUrl: 'https://ilink.test',
      cdnBaseUrl: 'https://cdn.test',
    });
    await assert.rejects(
      client.sendImage({
        toUserId: 'peer',
        contextToken: 'ctx',
        image: Buffer.from('image'),
      }),
      (error: unknown) => {
        assert.ok(error instanceof ILinkError);
        assert.equal(error.errcode, undefined);
        assert.equal(error.httpStatus, 502);
        return true;
      },
    );
  } finally {
    globalThis.fetch = original;
  }
});
