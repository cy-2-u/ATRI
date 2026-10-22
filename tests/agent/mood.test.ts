import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMood } from '@atri/core';
import { FakeModel, completion, fixture } from '../helpers.js';

test('亲昵短句不扣耐心，冷淡短句仍然扣耐心', (t) => {
  const f = fixture(t);
  const now = Date.now();
  // 下午三点，避免深夜规则干扰耐心判断。
  const userAt = Date.parse('2026-10-22T15:00:00+08:00');
  const pulse = (peer: string, user: string) => {
    f.store.pulseMoodFromExchange(peer, { user, assistant: '嗯嗯', userAt }, now, 'Asia/Shanghai');
    return f.store.mood(peer);
  };
  for (const [index, text] of [
    '好的宝',
    '爱你',
    '抱抱',
    '亲亲',
    '么么',
    '晚安',
    '好梦',
    '辛苦了',
    '谢谢',
  ].entries()) {
    const mood = pulse(`warm-${index}`, text);
    assert.ok(mood.patience >= 0, `"${text}" 不应被当作敷衍，patience=${mood.patience}`);
  }
  for (const [index, text] of ['嗯', '哦', '随便', '知道了', '好', '行'].entries()) {
    const mood = pulse(`cold-${index}`, text);
    assert.ok(mood.patience < 0, `"${text}" 应被视为冷淡短句，patience=${mood.patience}`);
  }
});

test('嘻嘻增加心情但不扣耐心，晚安降低精力但不扣耐心', (t) => {
  const f = fixture(t);
  const now = Date.now();
  const afternoon = Date.parse('2026-10-22T15:00:00+08:00');
  f.store.pulseMoodFromExchange(
    'p1',
    { user: '嘻嘻', assistant: '怎么啦', userAt: afternoon },
    now,
    'Asia/Shanghai',
  );
  const cheerful = f.store.mood('p1');
  assert.ok(cheerful.valence > 0, '嘻嘻应提升 valence');
  assert.ok(cheerful.patience >= 0, '嘻嘻不能仅因字数少扣 patience');

  f.store.pulseMoodFromExchange(
    'night',
    { user: '晚安', assistant: '晚安宝', userAt: Date.parse('2026-10-22T23:30:00+08:00') },
    now,
    'Asia/Shanghai',
  );
  const goodnight = f.store.mood('night');
  assert.ok(goodnight.energy < 0, '晚安应降低 energy');
  assert.ok(goodnight.patience >= 0, '晚安不应被当作敷衍');
});

test('正常长句增加耐心，明确负面情绪句不扣耐心且原因具体', (t) => {
  const f = fixture(t);
  const now = Date.now();
  const userAt = Date.parse('2026-10-22T15:00:00+08:00');
  f.store.pulseMoodFromExchange(
    'long',
    {
      user: '今天我们把项目从架构到测试完整梳理了一遍，也讨论了部署、回滚和监控，感觉思路清楚了很多。'.repeat(
        3,
      ),
      assistant: '那就好，慢慢来。',
      userAt,
    },
    now,
    'Asia/Shanghai',
  );
  assert.ok(f.store.mood('long').patience > 0, '认真长谈应补充耐心');

  f.store.pulseMoodFromExchange(
    'sad',
    { user: '今天被领导骂了一顿，好难过', assistant: '抱抱，怎么了', userAt },
    now,
    'Asia/Shanghai',
  );
  const sad = f.store.mood('sad');
  assert.ok(sad.valence < 0, '明确负面句应降低 valence');
  assert.equal(sad.reason, '对方提到了不开心的事');
  assert.ok(sad.patience >= 0, '对方难过时不扣耐心');
});

test('低耐心时 reason 更新为累，不保留开心旧原因', (t) => {
  const f = fixture(t);
  const now = Date.now();
  const userAt = Date.parse('2026-10-22T15:00:00+08:00');
  f.store.pulseMoodFromExchange(
    'p1',
    { user: '哈哈哈好开心', assistant: '太好了', userAt },
    now,
    'Asia/Shanghai',
  );
  assert.equal(f.store.mood('p1').reason, '聊得挺开心');
  f.store.pulseMoodFromExchange(
    'p1',
    { user: '哦', assistant: '嗯', userAt: userAt + 60000 },
    now + 60000,
    'Asia/Shanghai',
  );
  const mood = f.store.mood('p1');
  assert.ok(mood.patience <= -0.2);
  assert.equal(mood.reason, '有点累，想安静');
  assert.ok(mood.valence > 0, '心情本身仍偏正，只是耐心低');
});

test('低耐心提示词按 valence 区分累和低落', () => {
  const now = Date.now();
  const warm = renderMood(
    { valence: 0.22, energy: 0, patience: -0.4, reason: '有点累，想安静', at: now },
    now,
  );
  assert.match(warm, /不是不开心/);
  assert.match(warm, /不要冷淡/);
  assert.match(warm, /不要说自己没电了/);

  const low = renderMood(
    { valence: -0.35, energy: 0, patience: -0.4, reason: '对方提到了不开心的事', at: now },
    now,
  );
  assert.match(low, /不想应酬/);
  assert.match(low, /不是生气/);
});

test('旧情绪记录没有 patience 时按 0 处理', (t) => {
  const f = fixture(t);
  const now = Date.now();
  f.store.setSetting('mood:legacy', { valence: 0.2, energy: 0.1, at: now });
  assert.equal(f.store.mood('legacy').patience, 0);
});

test('模型 moodPulse 存在时跳过同轮规则 pulse，避免双倍扣耐心', async (t) => {
  const model = new FakeModel(() =>
    completion({
      messages: ['抱抱。'],
      memoryUpdates: [],
      moodPulse: {
        valence: -0.4,
        energy: -0.2,
        patience: -0.2,
        reason: '工作不顺',
      },
    }),
  );
  const f = fixture(t, model);
  f.runtime.accept('p1', 'q', '今天被领导骂了，好难过');
  await f.runtime.drain();
  const mood = f.store.mood('p1');
  assert.ok(Math.abs(mood.valence + 0.4) < 0.02, `valence=${mood.valence}`);
  assert.ok(Math.abs(mood.energy + 0.2) < 0.02, `energy=${mood.energy}`);
  assert.ok(Math.abs(mood.patience + 0.2) < 0.02, `patience=${mood.patience}`);
  assert.equal(mood.reason, '工作不顺');
});
