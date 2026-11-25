import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jitteredSleepWindow, inSleepMinutes, nextWakeAfter, eveningArousalMinutes, sleepDayKeyOf, beatDelay, evolveCloseness, projectMemory, rehearseMemory, renderMood, renderMoodTrail, renderSelfHour, renderMotives, initialSelf, grams, estimate, instant, nextOccurrence, fromLocal, dayKey, localTime } from '../src/state.ts';
import { defaults, mergeConfig, validateConfig, publicConfig } from '../src/config.ts';
import { parseThought } from '../src/mind.ts';

const tz = 'Asia/Shanghai';

test('睡眠窗：抖动稳定且不越界', () => {
  const a = jitteredSleepWindow('2026-01-01', 60, 480);
  const b = jitteredSleepWindow('2026-01-01', 60, 480);
  assert.deepEqual(a, b);
  assert.ok(a.startMin >= 0 && a.startMin < 1440 && a.endMin >= 0 && a.endMin < 1440);
  // 同配置跨天抖动不同
  const c = jitteredSleepWindow('2026-01-02', 60, 480);
  assert.notDeepEqual(a, c);
  // 整日不眠不被抖动造出睡眠窗
  assert.deepEqual(jitteredSleepWindow('2026-01-01', 60, 60), { startMin: 60, endMin: 60 });
  // 窗口长度守恒：短窗（<90 分钟）抖动不得翻成跨午夜反转
  for (const day of ['2026-03-01', '2026-03-02', '2026-03-03', '2026-03-04']) {
    const short = jitteredSleepWindow(day, 450, 510);
    const length = (short.endMin - short.startMin + 1440) % 1440;
    assert.equal(length, 60, `${day} 窗口长度变了`);
  }
});

test('睡眠判定与醒来时刻', () => {
  assert.equal(inSleepMinutes(120, 60, 480), true);
  assert.equal(inSleepMinutes(600, 60, 480), false);
  // 跨午夜窗口
  assert.equal(inSleepMinutes(30, 1380, 420), true);
  assert.equal(inSleepMinutes(720, 1380, 420), false);
  // 落在窗内的 due 推到窗结束（抖动后的真实终点）
  const at = Date.parse('2026-03-05T01:30:00+08:00');
  const due = nextWakeAfter(at, tz, 60, 480);
  const p = localTime(due, tz);
  const window = jitteredSleepWindow(dayKey(at, tz), 60, 480);
  assert.equal(p.hour * 60 + p.minute, window.endMin);
  // 窗外原样返回
  const noon = Date.parse('2026-03-05T12:00:00+08:00');
  assert.equal(nextWakeAfter(noon, tz, 60, 480), noon);
});

test('熬夜推迟入睡：18 点后经历让入睡更晚', () => {
  const day = '2026-03-05';
  const base = Date.parse(`${day}T12:00:00+08:00`);
  const events = Array.from({ length: 12 }, (_, i) => ({ at: base + 6 * 3600000 + i * 300000 })); // 18:00–23:55，同一天 12 段
  const minutes = eveningArousalMinutes(events, day, tz);
  assert.equal(minutes, 60); // 封顶一小时
  assert.equal(eveningArousalMinutes([{ at: base }], day, tz), 0);
  // 唤醒度归属：凌晨 2 点的热闹属于前一晚
  const night = Date.parse(`${day}T02:00:00+08:00`);
  assert.equal(sleepDayKeyOf(night, tz, 60, 480), '2026-03-04');
});

test('心跳节拍：黏人度越高拍越短，防骚扰收敛生效', () => {
  const now = Date.now();
  const close = initialSelf(now); close.closeness = 1;
  const far = initialSelf(now); far.closeness = 0;
  const closeBeat = beatDelay(close, now, 90, 0.5) / 60000;
  const farBeat = beatDelay(far, now, 90, 0.5) / 60000;
  assert.ok(closeBeat < 40 && farBeat > 60, `close=${closeBeat} far=${farBeat}`);
  // 刚收到消息未接住：短拍警觉
  const alert = initialSelf(now);
  alert.lastReceivedAt = now - 60000;
  assert.ok(beatDelay(alert, now, 90, 0.5) / 60000 <= 5.1);
  // 刚主动开口：收敛
  const justTalked = initialSelf(now);
  justTalked.lastDeliveredAt = now - 60000;
  assert.ok(beatDelay(justTalked, now, 90, 0.5) > beatDelay(initialSelf(now), now, 90, 0.5));
  // 全域 clamp
  assert.ok(beatDelay(initialSelf(now), now, 720, 0) / 60000 <= 240);
});

test('黏人度每日演化：密度回应推近、落空推远、幂等', () => {
  const now = Date.now();
  const day = dayKey(now, tz);
  const empty = evolveCloseness({ ...initialSelf(now), closeness: 0.5, closenessDay: '' }, [], day);
  assert.ok(empty.closeness < 0.5); // 无相处：目标 0.25
  assert.equal(empty.closenessDay, day);
  const again = evolveCloseness(empty, [], day);
  assert.equal(again.closeness, empty.closeness); // 同日幂等
  const lively = Array.from({ length: 20 }, (_, i) => ({ kind: i % 2 ? 'accepted' : 'received', at: now - 3600000 + i * 120000 }));
  const grown = evolveCloseness({ ...initialSelf(now), closeness: 0.3, closenessDay: '' }, lively, day);
  assert.ok(grown.closeness > 0.3);
  // 底色永不为零
  const cold = evolveCloseness({ ...initialSelf(now), closeness: 0.2, closenessDay: '' }, [], day);
  assert.ok(cold.closeness >= 0.15);
});

test('记忆六变量：情绪浓淡得慢、演练巩固、identity 不衰减由调用方保证', () => {
  const now = Date.now();
  const calm = { importance: 0.5, emotion: 0, detail: 1, consolidation: 0, interference: 0, createdAt: now, evaluatedAt: now - 30 * 86400000, lastRehearsedAt: 0 };
  const sad = { ...calm, emotion: -0.9 };
  assert.ok(projectMemory(sad, now).detail > projectMemory(calm, now).detail);
  const rehearsed = rehearseMemory({ ...calm, lastRehearsedAt: now - 400 * 60000 }, now);
  assert.ok(rehearsed.consolidation > 0);
  // 短时间内重复演练不叠加
  assert.equal(rehearseMemory(rehearsed, now).consolidation, rehearsed.consolidation);
});

test('情绪呈现：中文短句、轨迹、深夜文案（脉冲不衰减，陈旧度靠标注）', () => {
  const now = Date.now();
  const line = renderMood({ label: '低落', valence: -0.5, arousal: 0, patience: 0, reason: '被放鸽子', sources: [], at: now }, now, -0.4);
  assert.match(line, /低落|状态/);
  assert.ok(line.includes('被放鸽子'));
  // 六小时前的情绪不数值衰减，但材料必须标注陈旧度
  const stale = renderMood({ label: '低落', valence: -0.5, arousal: 0, patience: 0, reason: '被放鸽子', sources: [], at: now - 6 * 3600000 }, now, 0);
  assert.match(stale, /6 小时前的状态/);
  const trail = renderMoodTrail([{ label: 'x', valence: -0.5, arousal: 0, patience: 0, reason: '有点委屈', sources: [], at: now - 3600000 }], now);
  assert.match(trail, /你有点委屈/);
  assert.match(renderSelfHour(3), /深夜/);
  assert.match(renderSelfHour(3, 90), /入睡往后推/);
  assert.match(renderMotives({ ...initialSelf(now), stimulatedAt: now - 5 * 3600000 }, now), /闲/);
});

test('时间数学：instant 校验、周期约定的下次发生、DST 本地时间', () => {
  assert.throws(() => instant('2026-01-01T00:00:00'));
  assert.equal(instant('2026-01-01T00:00:00Z'), Date.parse('2026-01-01T00:00:00Z'));
  assert.equal(instant(123456789), 123456789);
  assert.throws(() => instant('2026-02-30T00:00:00Z'));
  // 裸本地时间 + 时区：模型说墙钟时刻，代码负责时区换算（她的时区是配置项）
  const naive = instant('2026-01-01T08:00:00', 'Asia/Shanghai');
  assert.equal(new Date(naive).toISOString(), '2026-01-01T00:00:00.000Z'); // 上海 8 点 = UTC 0 点
  assert.ok(Number.isFinite(instant('2026-01-01T08:00:00.500', 'Asia/Shanghai'))); // 带秒/毫秒的裸时间
  assert.throws(() => instant('2026-02-30T08:00:00', 'Asia/Shanghai')); // 不存在的日期照样打回
  assert.throws(() => instant('明天下午', 'Asia/Shanghai')); // 乱文本照样打回
  assert.throws(() => instant('2026-01-01T08:00:00')); // 无 tz 裸时间维持严格拒绝（治理锚点在调用方）
  const anchor = Date.parse('2026-01-31T09:00:00+08:00');
  const next = nextOccurrence(anchor, { unit: 'month', interval: 1, timezone: tz }, Date.parse('2026-02-25T00:00:00+08:00'));
  assert.equal(dayKey(next, tz), '2026-02-28'); // 短月收尾
  const weekly = nextOccurrence(anchor, { unit: 'week', interval: 2, timezone: tz }, anchor);
  assert.equal((weekly - anchor) / 86400000, 14);
  // DST 无歧义：上海无 DST，洛杉矶夏季边界
  const la = fromLocal({ year: 2026, month: 3, day: 8, hour: 2, minute: 30, second: 0 }, 'America/Los_Angeles');
  assert.ok(Number.isFinite(la));
});

test('grams 与 token 估算', () => {
  assert.deepEqual(grams('AB cd'), ['ab', 'cd']);
  assert.ok(grams('今天天气不错').includes('今天'));
  assert.ok(estimate('hello') < estimate('你好世界'));
});

test('配置：合并保留密钥、校验拒绝非法值、公开脱敏', () => {
  const base = validateConfig(defaults('人格'));
  const merged = mergeConfig(base, { primary: { url: 'https://api.example.com', key: 'sk-test', model: 'gpt' }, qq: { appId: '1' } });
  assert.equal(merged.primary.model, 'gpt');
  assert.equal(merged.qq.appId, '1');
  assert.equal(merged.life.beatMinutes, 90);
  // 空密钥保留旧值
  const kept = mergeConfig(merged, { primary: { key: '' } });
  assert.equal(kept.primary.key, 'sk-test');
  assert.throws(() => mergeConfig(base, { nope: 1 }));
  assert.throws(() => mergeConfig(base, { life: { beatMinutes: 5 } }));
  const published = publicConfig(merged) as { primary: { key: string; keyConfigured: boolean } };
  assert.equal(published.primary.key, '');
  assert.equal(published.primary.keyConfigured, true);
});

test('思考协议解析：thoughts/diary/impressions 全链路', () => {
  const thought = parseThought(JSON.stringify({
    parts: [{ type: 'text', text: '好' }, { type: 'sticker', slug: 'happy' }],
    feeling: { label: '开心', valence: 0.6, arousal: 0.3, patience: 0.2, reason: '他夸我了', sources: ['e1'] },
    memories: [{ kind: 'fact', content: '他喜欢猫', gist: '喜欢猫', sources: ['e1'], importance: 0.7, emotion: 0.4 }],
    commitments: [{ op: 'keep', kind: 'reminder', content: '提醒喝水', due: '2026-05-01T10:00:00+08:00', sources: ['e1'] }],
    thoughts: [{ op: 'keep', topic: '学做蛋糕', meaning: '想做给他吃', sources: ['e1'] }],
    diary: { content: '今天很开心', emotion: 0.7, sources: ['e1'] },
    impressions: { beliefs: [{ text: '他最近在加班', basis: ['e1'] }] },
    intents: [{ reason: '问他项目怎样了', at: '2026-05-02T09:00:00+08:00' }],
  }));
  assert.equal(thought.parts.length, 2);
  assert.equal(thought.thoughts!.length, 1);
  assert.equal(thought.diary!.content, '今天很开心');
  assert.equal(thought.impressions!.beliefs.length, 1);
  // 非法值拒绝
  assert.throws(() => parseThought('{"parts":[{"type":"text"}]}'));
  assert.throws(() => parseThought('{"parts":[],"feeling":{"label":"x","valence":5}}'));
  assert.throws(() => parseThought('{"parts":[],"thoughts":[{"op":"keep","topic":"x","meaning":"y"}]}')); // 缺来源字段
  assert.throws(() => parseThought('{"parts":[],"intents":[{"reason":"x","at":"2026-01-01T00:00:00"}]}')); // 无时区
});
