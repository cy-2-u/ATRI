import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Journal } from '../src/storage/journal.js';
import { Mind, parseThought } from '../src/domain/mind.js';
import { LifeMaterial } from '../src/domain/material.js';
import {
  inSleepMinutes,
  jitteredSleepWindow,
  minutesOfDay,
  nextWakeAfter,
} from '../src/domain/rhythm.js';
import { Runtime } from '../src/runtime/runtime.js';
import type { Model } from '../src/model/types.js';
import type { Stickers } from '../src/stickers.js';

test('思考输出解析：心情/在做/在追/表情形状与拒绝', () => {
  const thought = parseThought(
    '{"action":"speak","parts":[{"type":"text","text":"hi"},{"type":"sticker","slug":"a_1"},{"type":"image","path":"out/a.png"}],"moodPulse":{"valence":0.5,"energy":-2,"patience":0,"reason":"聊得开心"},"activity":"画画","pursuit":""}',
  );
  assert.equal(thought.parts.length, 3);
  assert.equal(thought.moodPulse?.valence, 0.5);
  assert.equal(thought.moodPulse?.energy, -1);
  assert.equal(thought.activity, '画画');
  assert.equal(thought.pursuit, '');
  assert.throws(() =>
    parseThought('{"action":"speak","parts":[{"type":"sticker","slug":"bad slug!"}]}'),
  );
  assert.throws(() =>
    parseThought('{"action":"speak","parts":[{"type":"image","path":"../escape.png"}]}'),
  );
});

test('心情与在做/在追经 runtime 落库，影响下一拍材料', async () => {
  const journal = new Journal(':memory:');
  const response =
    '{"action":"speak","parts":[{"type":"text","text":"hola"}],"moodPulse":{"valence":0.8,"energy":0.2,"patience":0.1,"reason":"r"},"activity":"reading","pursuit":"jellyfish"}';
  const model: Model = {
    async complete() {
      return {
        message: { role: 'assistant', content: response },
        usage: { input: 1, output: 1, cached: 0 },
      };
    },
  };
  const sent: string[] = [];
  const runtime = new Runtime(journal, new Mind(model, journal), {
    persona: () => 'p',
    material: () => ({}),
    send: (_p, part) => {
      sent.push(part.text ?? '');
      return Promise.resolve('sent');
    },
    nextBeat: () => undefined,
    onError: () => {},
    timeoutMs: 1000,
    debounceMs: 0,
    concurrency: 1,
    pacing: false,
    stickerSlugs: () => new Set(),
    vision: () => false,
    readFile: () => Promise.resolve(undefined),
  });
  try {
    runtime.start();
    runtime.receive('peer', 'one', 'hi');
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && !journal.events('peer').some((e) => e.kind === 'said'))
      await delay(5);
    assert.equal(sent[0], 'hola');
    assert.equal(journal.mood('peer')?.valence, 0.8);
    assert.equal(journal.self().activity, 'reading');
    assert.equal(journal.self().pursuit, 'jellyfish');
  } finally {
    await runtime.stop();
    journal.close();
  }
});

test('目录外的表情整条丢弃，只剩无效表情的 speak 判失败不发送', async () => {
  const journal = new Journal(':memory:');
  let call = 0;
  const responses = [
    '{"action":"speak","parts":[{"type":"text","text":"有字"},{"type":"sticker","slug":"not_in_catalog"}]}',
    '{"action":"speak","parts":[{"type":"sticker","slug":"not_in_catalog"}]}',
  ];
  const model: Model = {
    async complete() {
      return {
        message: { role: 'assistant', content: responses[Math.min(call++, responses.length - 1)]! },
        usage: { input: 1, output: 1, cached: 0 },
      };
    },
  };
  const sent: string[] = [];
  const runtime = new Runtime(journal, new Mind(model, journal), {
    persona: () => 'p',
    material: () => ({}),
    send: (_p, part) => {
      sent.push(part.text ?? '');
      return Promise.resolve('sent');
    },
    nextBeat: () => undefined,
    onError: () => {},
    timeoutMs: 1000,
    debounceMs: 0,
    concurrency: 1,
    pacing: false,
    stickerSlugs: () => new Set(['real_one']),
    vision: () => false,
    readFile: () => Promise.resolve(undefined),
  });
  try {
    runtime.start();
    runtime.receive('peer', 'one', 'a');
    let deadline = Date.now() + 2000;
    while (Date.now() < deadline && !sent.length) await delay(5);
    assert.deepEqual(sent, ['有字']);
    runtime.receive('peer', 'two', 'b');
    deadline = Date.now() + 2000;
    while (
      Date.now() < deadline &&
      !journal.events('peer').some((e) => e.kind === 'failure' && e.content.includes('表情'))
    )
      await delay(5);
    assert.ok(
      journal.events('peer').some((e) => e.kind === 'failure' && e.content.includes('表情')),
    );
    assert.equal(sent.length, 1);
  } finally {
    await runtime.stop();
    journal.close();
  }
});

test('多气泡按长度节奏投递，被打断时保持待发', async () => {
  const journal = new Journal(':memory:');
  const model: Model = {
    async complete() {
      return {
        message: {
          role: 'assistant',
          content:
            '{"action":"speak","parts":[{"type":"text","text":"a"},{"type":"text","text":"b"}]}',
        },
        usage: { input: 1, output: 1, cached: 0 },
      };
    },
  };
  const sent: string[] = [];
  const runtime = new Runtime(journal, new Mind(model, journal), {
    persona: () => 'p',
    material: () => ({}),
    send: (_p, part) => {
      sent.push(part.text ?? '');
      return Promise.resolve('sent');
    },
    nextBeat: () => undefined,
    onError: () => {},
    timeoutMs: 1000,
    debounceMs: 0,
    concurrency: 1,
    pacing: true,
    stickerSlugs: () => new Set(),
    vision: () => false,
    readFile: () => Promise.resolve(undefined),
  });
  try {
    runtime.start();
    runtime.receive('peer', 'one', 'hi');
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && sent.length < 2) await delay(5);
    assert.deepEqual(sent, ['a', 'b']);
    // 第二条有停顿：第一条送达后 effects 已提交，但两气泡同轮。
    assert.equal(journal.unresolved('peer').length, 0);
  } finally {
    await runtime.stop();
    journal.close();
  }
});

test('材料：beat 白日梦查询用她的心事，diary/tidy 各自成形', async () => {
  const journal = new Journal(':memory:');
  const root = mkdtempSync(join(tmpdir(), 'xing-life-'));
  const stickers = {
    list: () => [{ slug: 's1', description: '笑', tags: [], file: 'x', disabled: false }],
  } as unknown as Stickers;
  const life = new LifeMaterial({
    journal,
    stickers,
    timeZone: () => 'Asia/Shanghai',
    sandboxEnabled: () => true,
    webConfigured: () => false,
    vision: () => false,
    now: Date.now,
  });
  try {
    journal.receive('peer', 'one', '在忙什么');
    journal.begin('peer', 'beat');
    journal.saveThought('peer', {
      id: 't1',
      topic: '汇报',
      meaning: '想把进度告诉他',
      sources: [],
      evidence: 'e',
      state: 'idle',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    journal.setSetting('self', {
      social: 0.8,
      expression: 0,
      integratedAt: Date.now(),
      stimulatedAt: Date.now(),
      lastReceivedAt: Date.now(),
      lastDeliveredAt: 0,
      activity: '写代码',
      activitySince: Date.now(),
      pursuit: '',
      pursuitSince: Date.now(),
    });
    const beatTurn = { id: 't', peer: 'peer', version: 0, kind: 'beat' as const };
    const beat = await life.build('peer', beatTurn);
    const material = beat.material as {
      mode: string;
      body: string;
      selfNow: string;
      abilities: string;
    };
    assert.equal(material.mode, 'beat');
    assert.ok(material.selfNow.includes('写代码'));
    assert.ok(material.abilities.includes('你有手'));
    assert.ok(!material.abilities.includes('你有眼：'));

    const diaryTurn = { id: 'd', peer: 'peer', version: 0, kind: 'diary' as const };
    const diary = (await life.build('peer', diaryTurn)).material as {
      mode: string;
      instructions: string;
    };
    assert.equal(diary.mode, 'diary');
    assert.ok(diary.instructions.includes('write_journal'));

    const tidyTurn = { id: 'x', peer: 'peer', version: 0, kind: 'tidy' as const };
    const tidy = (await life.build('peer', tidyTurn)).material as {
      mode: string;
      pairs: unknown[];
    };
    assert.equal(tidy.mode, 'tidy');
    assert.ok(Array.isArray(tidy.pairs));
  } finally {
    journal.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('睡眠窗：按日期抖动稳定、分钟判定与醒来时刻', () => {
  const a = jitteredSleepWindow('2026-11-14', 60, 420);
  const b = jitteredSleepWindow('2026-11-14', 60, 420);
  assert.deepEqual(a, b);
  const c = jitteredSleepWindow('2026-11-15', 60, 420);
  assert.notDeepEqual(a, c);
  assert.ok(Math.abs(a.startMin - 60) <= 45 && Math.abs(a.endMin - 420) <= 45);
  // 跨午夜窗：23 点入睡、6 点醒，凌晨 3 点在睡，8 点不在。
  assert.equal(inSleepMinutes(180, 1380, 360), true);
  assert.equal(inSleepMinutes(480, 1380, 360), false);
  const tz = 'Asia/Shanghai';
  const now = Date.parse('2026-11-14T15:00:00+08:00'); // 当地 15:00，分钟 900
  assert.equal(minutesOfDay(now, tz), 900);
  // 深夜 03:00 必落在抖动窗（最晚 01:45 入睡、最早 06:15 醒）内 → 推到窗结束。
  const night = Date.parse('2026-11-14T03:00:00+08:00');
  const wake = nextWakeAfter(night, tz, 60, 420);
  const window = jitteredSleepWindow('2026-11-14', 60, 420);
  assert.equal(wake > night, true);
  assert.ok(Math.abs(minutesOfDay(wake, tz) - window.endMin) < 2);
});
