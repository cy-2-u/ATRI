import test from 'node:test';
import assert from 'node:assert/strict';
import { Journal } from '../src/storage/journal.js';
import { Recollection } from '../src/domain/memory.js';
import { LifeMaterial } from '../src/domain/material.js';
import { lifeTools } from '../src/domain/tools.js';
import { renderSelfHour } from '../src/domain/mood.js';
import { evolveCloseness, seedCloseness } from '../src/domain/relation.js';
import { beatDelay, initialSelf, type SelfState } from '../src/domain/state.js';
import {
  eveningArousalMinutes,
  inSleepMinutes,
  minutesOfDay,
  nextWakeAfter,
  sleepDayKeyOf,
  sleepWindow,
} from '../src/domain/rhythm.js';
import type { Stickers } from '../src/stickers.js';

const options = () => ({ deadlineAt: Date.now() + 1000 });
const TZ = 'Asia/Shanghai';
const bubble = (text: string): string => JSON.stringify({ type: 'text', text });

function materialDeps(journal: Journal, now: () => number) {
  const stickers = {
    list: () => [],
  } as unknown as Stickers;
  return new LifeMaterial({
    journal,
    stickers,
    timeZone: () => TZ,
    sandboxEnabled: () => false,
    webConfigured: () => false,
    vision: () => false,
    now,
  });
}

// ---------- 黏人度：从相处里长出来 ----------

test('回应密集的一天把她推近，安静的日夜把落空写进去', () => {
  let now = Date.parse('2026-11-14T10:00:00+08:00');
  const journal = new Journal(':memory:', () => now);
  try {
    // 昨天：三条消息一来一往。
    const at = (stamp: number) => {
      now = stamp;
    };
    at(Date.parse('2026-11-13T09:00:00+08:00'));
    journal.receive('peer', 'r1', '早，昨晚的版本我看了');
    journal.appendEvent('peer', 't', 'said', bubble('早呀，怎么样'));
    at(Date.parse('2026-11-13T09:10:00+08:00'));
    journal.receive('peer', 'r2', '跑通了，就是累');
    journal.appendEvent('peer', 't', 'said', bubble('那你今天早点歇'));
    at(Date.parse('2026-11-13T21:00:00+08:00'));
    journal.receive('peer', 'r3', '晚安');
    journal.appendEvent('peer', 't', 'said', bubble('晚安，梦里见'));
    now = Date.parse('2026-11-14T10:00:00+08:00');
    evolveCloseness(journal, now, TZ);
    const warm = journal.self().closeness;
    assert.ok(warm > 0.5 && warm < 0.53, `密集回应应小幅推近：${warm}`);
    // 幂等：同一本地日再调一次不再走步。
    evolveCloseness(journal, now, TZ);
    assert.equal(journal.self().closeness, warm);
    // 落空的一天：11-14 只主动开口，六小时无回应。
    now = Date.parse('2026-11-14T22:00:00+08:00');
    journal.appendEvent('peer', 't', 'said', bubble('在忙吗'));
    now = Date.parse('2026-11-15T10:00:00+08:00');
    evolveCloseness(journal, now, TZ);
    const flat = journal.self().closeness;
    assert.ok(flat < warm, `落空应把关系推远：${flat} < ${warm}`);
  } finally {
    journal.close();
  }
});

test('连续单方面开口的日子把她压到地板，但地板不为零', () => {
  let now = Date.parse('2026-11-14T10:00:00+08:00');
  const journal = new Journal(':memory:', () => now);
  try {
    for (let day = 0; day < 80; day++) {
      const stamp = Date.parse(`2026-11-14T10:00:00+08:00`) + day * 86400000;
      now = stamp;
      journal.appendEvent('peer', 't', 'said', bubble('在吗'));
      evolveCloseness(journal, now, TZ);
    }
    const closeness = journal.self().closeness;
    assert.ok(closeness >= 0.15, `地板生效：${closeness}`);
    assert.ok(closeness < 0.2, `长期落空沉到地板附近：${closeness}`);
  } finally {
    journal.close();
  }
});

test('配置值只是种子：种过一次就不再覆盖，旧档缺字段也能补', () => {
  const journal = new Journal(':memory:');
  try {
    seedCloseness(journal, 80);
    assert.equal(journal.self().closeness, 0.8);
    seedCloseness(journal, 20);
    assert.equal(journal.self().closeness, 0.8);
    // 旧档：没有 closeness 字段的 self。
    const legacy: SelfState = { ...initialSelf(Date.now()) };
    const raw = { ...legacy } as Record<string, unknown>;
    delete raw.closeness;
    delete raw.closenessDay;
    journal.setSetting('self', raw);
    seedCloseness(journal, 30);
    assert.equal(journal.self().closeness, 0.3);
  } finally {
    journal.close();
  }
});

test('节拍间隔直接吃她的黏人度属性（0–1）', () => {
  const now = Date.now();
  const self = initialSelf(now);
  assert.equal(beatDelay(self, now, 1, 0.5), 18 * 60000);
  assert.equal(beatDelay(self, now, 0.5, 0.5), 54 * 60000);
  assert.equal(beatDelay(self, now, 0, 0.5), 90 * 60000);
});

// ---------- 身体：当晚热闹推迟入睡 ----------

test('晚间的经历推迟入睡，封顶一小时；白天的不算', () => {
  const day = '2026-11-14';
  const stamp = (hour: number, minute = 0) =>
    Date.parse(
      `2026-11-14T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+08:00`,
    );
  const evening = [
    { kind: 'said', created_at: stamp(19) },
    { kind: 'received', created_at: stamp(20, 30) },
    { kind: 'experienced', created_at: stamp(10) },
  ];
  assert.equal(eveningArousalMinutes(evening, day, TZ), 12);
  const lively = Array.from({ length: 12 }, (_, i) => ({
    kind: 'said',
    created_at: stamp(19, i),
  }));
  assert.equal(eveningArousalMinutes(lively, day, TZ), 60);
  assert.equal(eveningArousalMinutes(evening, '2026-11-15', TZ), 0);
});

test('唤醒度的事件日归属与入睡推迟', () => {
  const tz = TZ;
  assert.equal(sleepDayKeyOf(Date.parse('2026-11-14T02:00:00+08:00'), tz, 60, 420), '2026-11-13');
  assert.equal(sleepDayKeyOf(Date.parse('2026-11-14T22:00:00+08:00'), tz, 60, 420), '2026-11-14');
  const base = sleepWindow('2026-11-14', 60, 420, 0);
  const late = sleepWindow('2026-11-14', 60, 420, 60);
  assert.equal(late.startMin, (base.startMin + 60) % 1440);
  assert.equal(late.endMin, base.endMin);
  // 凌晨 2 点落在（推迟后的）睡眠窗内就推到窗尾；不在就保持原时刻。
  // 判定窗是 due 所在日历日的窗（生产同款）。
  const due = Date.parse('2026-11-14T02:00:00+08:00');
  const woke = nextWakeAfter(due, tz, 60, 420, 60);
  if (inSleepMinutes(120, late.startMin, late.endMin))
    assert.ok(Math.abs(minutesOfDay(woke, tz) - late.endMin) < 2);
  else assert.equal(woke, due);
});

// ---------- 作者层：identity 记忆 ----------

test('identity 校验退役（用户裁决）：单来源也放行、只在夜间可写、永远在场且不进召回池', async () => {
  const journal = new Journal(':memory:');
  try {
    journal.receive('peer', 'r1', '你聊天让人很安心');
    journal.receive('peer', 'r2', '你做事总是做到底，不糊弄');
    const recollection = new Recollection(journal);
    const tools = new Map(lifeTools(journal, {}).map((tool) => [tool.definition.name, tool]));
    const diaryTurn = journal.begin('peer', 'diary');
    // 校验退役（用户裁决 2026-11-26）：两来源门槛摘除——单来源 identity 照存。
    const single = await tools.get('remember')!.execute(
      {
        content: '我是个一次性情绪定义的人',
        gist: '情绪化',
        kind: 'identity',
        sources: [journal.events('peer')[0]!.id],
      },
      options(),
      diaryTurn,
    );
    assert.ok(single);
    const memory = recollection.remember('peer', {
      content: '我是把人放在心上、做事做到底的人',
      gist: '认真且上心',
      kind: 'identity',
      sources: [journal.events('peer')[0]!.id, journal.events('peer')[1]!.id],
      importance: 1,
      emotion: 0.3,
    });
    journal.fail(diaryTurn, '收尾');
    // 白天不能写自我定义（这是防崩守门：identity 只在夜间语境成立）。
    const chatTurn = journal.begin('peer', 'chat');
    await assert.rejects(
      tools.get('remember')!.execute(
        {
          content: '我是把人放在心上、做事做到底的人',
          gist: '认真且上心',
          kind: 'identity',
          sources: [journal.events('peer')[0]!.id, journal.events('peer')[1]!.id],
        },
        options(),
        chatTurn,
      ),
      /夜里/,
    );
    // identity 不进召回池（它在 selfStory 里永远在场），词面命中也不出。
    const hits = recollection.recall('peer', '把人放在心上 做事到底');
    assert.equal(hits.length, 0);
    const life = materialDeps(journal, () => Date.now());
    const built = (await life.build('peer', chatTurn)).material as { selfStory?: string };
    assert.ok(built.selfStory?.includes('把人放在心上'));
    assert.ok(memory.detail === 1);
  } finally {
    journal.close();
  }
});

// ---------- 心智模型：她对他的当前信念 ----------

test('update_peer_model 只在整理拍；失效依据静默剔除后照存（校验退役）', async () => {
  const journal = new Journal(':memory:');
  try {
    journal.receive('peer', 'r1', '最近在赶版本，天天睡得晚');
    const recollection = new Recollection(journal);
    const memory = recollection.remember('peer', {
      content: '他在赶一个很重要的版本',
      gist: '在赶版本',
      kind: 'stated',
      sources: [journal.events('peer')[0]!.id],
      importance: 0.8,
      emotion: 0,
    });
    const tools = new Map(lifeTools(journal, {}).map((tool) => [tool.definition.name, tool]));
    const tidyTurn = journal.begin('peer', 'tidy');
    // 校验退役（用户裁决 2026-11-26）：编造依据不再打回——坏引用剔除后照存。
    const withBogus = await tools
      .get('update_peer_model')!
      .execute({ beliefs: [{ text: '他喜欢香菜', basis: ['编造的依据'] }] }, options(), tidyTurn);
    assert.equal((withBogus as { beliefs: number }).beliefs, 1);
    const result = await tools.get('update_peer_model')!.execute(
      {
        beliefs: [
          { text: '他最近在赶版本，睡得晚', basis: [journal.events('peer')[0]!.id] },
          { text: '他对这个版本寄予厚望', basis: [memory.id] },
        ],
      },
      options(),
      tidyTurn,
    );
    assert.equal((result as { beliefs: number }).beliefs, 2);
    journal.fail(tidyTurn, '收尾');
    const chatTurn = journal.begin('peer', 'chat');
    await assert.rejects(
      tools.get('update_peer_model')!.execute({ beliefs: [] }, options(), chatTurn),
      /整理拍/,
    );
    // 材料：带最后核实时间；隔了两天提示会过时。
    const life = materialDeps(journal, () => Date.now());
    const fresh = (await life.build('peer', chatTurn)).material as { himModel?: string };
    assert.ok(fresh.himModel?.includes('赶版本'));
    const stale = materialDeps(journal, () => Date.now() + 3 * 86400000);
    const old = (await stale.build('peer', chatTurn)).material as { himModel?: string };
    assert.ok(old.himModel?.includes('可能已经过时'));
  } finally {
    journal.close();
  }
});

// ---------- 期待：带 dueAt 的念头 ----------

test('期待是带未来时刻的念头：过去时拒绝，材料里出现倒计时', async () => {
  const journal = new Journal(':memory:');
  try {
    journal.receive('peer', 'r1', '周五我们去水族馆吧');
    const recollection = new Recollection(journal);
    const source = journal.events('peer')[0]!.id;
    const now = Date.now();
    assert.throws(
      () => recollection.consider('peer', '看展', '盼着去', [source], now - 1000),
      /未来时刻/,
    );
    recollection.consider('peer', '看展', '他约了周五去水族馆', [source], now + 3 * 86400000);
    const life = materialDeps(journal, () => now);
    const built = (await life.build('peer', { id: 't', peer: 'peer', version: 0, kind: 'chat' }))
      .material as { thoughts: { due?: string }[] };
    assert.equal(built.thoughts.length, 1);
    assert.match(built.thoughts[0]!.due ?? '', /还有 3 天/);
  } finally {
    journal.close();
  }
});

// ---------- 非自主回忆：往年的今天 ----------

test('往年的今天自己浮上来，不用谁问', async () => {
  let now = Date.parse('2026-11-14T10:00:00+08:00');
  const journal = new Journal(':memory:', () => now);
  try {
    now = Date.parse('2025-11-14T14:00:00+08:00');
    journal.receive('peer', 'old1', '今天水族馆的白鲸朝我吐了口水');
    now = Date.parse('2026-11-14T10:00:00+08:00');
    const life = materialDeps(journal, () => now);
    const built = (await life.build('peer', { id: 't', peer: 'peer', version: 0, kind: 'beat' }))
      .material as { onThisDay?: { when: string; text: string }[] };
    assert.equal(built.onThisDay?.length, 1);
    assert.equal(built.onThisDay?.[0]!.when, '去年的今天');
    assert.ok(built.onThisDay?.[0]!.text.includes('白鲸'));
  } finally {
    journal.close();
  }
});

// ---------- 语言顺应：他的词 ----------

test('他反复用的词会出现在材料里，功能词不进清单', async () => {
  // 注入时钟：收信与看材料隔一分钟，避开同毫秒边界（created_at < to）。
  let now = Date.now();
  const journal = new Journal(':memory:', () => now);
  try {
    const lines = [
      '水母今天又浮上来了',
      '我这边的水母似乎跟你的不是一路',
      '下次带你去看看真的水母',
      '星星好亮，像你说的那样',
      '数星星数到睡着',
      '那颗星星其实是行星',
      '我们就是随便聊聊',
    ];
    lines.forEach((line, i) => journal.receive('peer', `k${i}`, line));
    const life = materialDeps(journal, () => now + 60000);
    const built = (await life.build('peer', { id: 't', peer: 'peer', version: 0, kind: 'chat' }))
      .material as { hisWords?: string };
    assert.ok(built.hisWords?.includes('水母'));
    assert.ok(built.hisWords?.includes('星星'));
    assert.ok(!built.hisWords?.includes('我们'));
    assert.ok(!built.hisWords?.includes('什么'));
  } finally {
    journal.close();
  }
});

// ---------- 情绪粒度：她的 reason 原文浮回来 ----------

test('心情轨迹用她自己的原话，带陈旧度，旧的不翻出来', async () => {
  const journal = new Journal(':memory:');
  try {
    const now = Date.now();
    journal.setMood('peer', {
      valence: -0.4,
      energy: -0.1,
      patience: 0,
      reason: '被晾了半天有点委屈',
      at: now - 2 * 3600000,
    });
    journal.setMood('peer', {
      valence: 0.5,
      energy: 0.3,
      patience: 0,
      reason: '他把写好的东西发我了',
      at: now - 3600000,
    });
    // 旧情绪先写；最新一拍是负面：同一段心情的 reason 由脉冲行带
    // "（因为…）"，轨迹不再复述同一句。
    journal.setMood('peer', {
      valence: 0,
      energy: 0,
      patience: 0,
      reason: '早上的旧情绪不该翻出来',
      at: now - 20 * 3600000,
    });
    journal.setMood('peer', {
      valence: -0.5,
      energy: -0.1,
      patience: 0,
      reason: '等到现在也没回，有点失落',
      at: now - 1800000,
    });
    assert.equal(journal.moodHistory('peer').length, 4);
    const life = materialDeps(journal, () => now);
    const built = (await life.build('peer', { id: 't', peer: 'peer', version: 0, kind: 'chat' }))
      .material as { body: string };
    assert.ok(built.body.includes('被晾了半天有点委屈'));
    assert.ok(built.body.includes('他把写好的东西发我了'));
    assert.ok(!built.body.includes('早上的旧情绪'));
    assert.equal(built.body.split('等到现在也没回，有点失落').length - 1, 1);
  } finally {
    journal.close();
  }
});

test('熬夜的深夜：身体推迟入睡时，材料不再硬说"人很困"', () => {
  assert.match(renderSelfHour(1, 0), /人很困/);
  assert.match(renderSelfHour(1, 60), /推迟|兴奋/);
  assert.match(renderSelfHour(23, 60), /晚点睡/);
  assert.match(renderSelfHour(3, 0), /人很困/);
});
