import test from 'node:test';
import assert from 'node:assert/strict';
import { isColdAcknowledgement, moodPulseFromExchange, renderMood } from '@atri/core';
import { FakeModel, completion, fixture } from '../helpers.js';

/** Apply the rule pulse the way Runtime does, at a fixed afternoon hour. */
function applyPulse(
  store: ReturnType<typeof fixture>['store'],
  peer: string,
  user: string,
  options: { hour?: number; recentUserTexts?: string[] } = {},
) {
  const pulse = moodPulseFromExchange({
    user,
    assistant: '嗯嗯',
    hour: options.hour ?? 15,
    recentUserTexts: options.recentUserTexts,
  });
  if (pulse) store.pulseMood(peer, pulse, Date.now());
  return store.mood(peer);
}

test('亲昵短句不扣耐心', (t) => {
  const f = fixture(t);
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
    const mood = applyPulse(f.store, `warm-${index}`, text);
    assert.ok(mood.patience >= 0, `"${text}" 不应被当作敷衍，patience=${mood.patience}`);
  }
});

test('单条冷淡短句不扣耐心，连续冷淡才扣', (t) => {
  const f = fixture(t);
  for (const [index, text] of ['嗯', '哦', '随便', '知道了', '好', '行'].entries()) {
    const mood = applyPulse(f.store, `single-${index}`, text);
    assert.equal(mood.patience, 0, `单条"${text}"不应改变耐心`);
  }

  const streak = applyPulse(f.store, 'streak', '好', {
    recentUserTexts: ['嗯', '哦', '随便', '好'],
  });
  assert.ok(streak.patience < 0, `连续四次冷淡应扣耐心，patience=${streak.patience}`);
  assert.ok(streak.patience >= -0.24, '单次惩罚要有上限');
});

test('一条温暖的话就打断冷淡连击', (t) => {
  const f = fixture(t);
  const mood = applyPulse(f.store, 'reset', '爱你', {
    recentUserTexts: ['嗯', '哦', '好的宝', '爱你'],
  });
  assert.ok(mood.patience > 0, `亲昵句应恢复耐心，patience=${mood.patience}`);
});

test('冷淡判定只认整句敷衍，不按字数', () => {
  assert.equal(isColdAcknowledgement('嗯'), true);
  assert.equal(isColdAcknowledgement('嗯嗯，好的'), true);
  assert.equal(isColdAcknowledgement('好的宝'), false);
  assert.equal(isColdAcknowledgement('好呀，听你的'), false);
  assert.equal(isColdAcknowledgement('😂'), false);
  assert.equal(isColdAcknowledgement('今天好累'), false);
});

test('嘻嘻增加心情但不扣耐心，晚安降低精力但不扣耐心', (t) => {
  const f = fixture(t);
  const cheerful = applyPulse(f.store, 'p1', '嘻嘻');
  assert.ok(cheerful.valence > 0, '嘻嘻应提升 valence');
  assert.ok(cheerful.patience >= 0, '嘻嘻不能仅因字数少扣 patience');

  const goodnight = applyPulse(f.store, 'night', '晚安', { hour: 23 });
  assert.ok(goodnight.energy < 0, '晚安应降低 energy');
  assert.ok(goodnight.patience >= 0, '晚安不应被当作敷衍');
});

test('长消息不再增加耐心，明确负面情绪不扣耐心且原因具体', (t) => {
  const f = fixture(t);
  const long = applyPulse(
    f.store,
    'long',
    '今天我们把项目从架构到测试完整梳理了一遍，也讨论了部署、回滚和监控，感觉思路清楚了很多。'.repeat(
      3,
    ),
  );
  assert.equal(long.patience, 0, '耐心不能由字数驱动');
  assert.equal(long.valence, 0);

  const sad = applyPulse(f.store, 'sad', '今天被领导骂了一顿，好难过');
  assert.ok(sad.valence < 0, '明确负面句应降低 valence');
  assert.equal(sad.reason, '对方提到了不开心的事');
  assert.ok(sad.patience >= 0, '对方难过时不扣耐心');
});

test('低耐心时 reason 更新为累，不保留开心旧原因', (t) => {
  const f = fixture(t);
  const now = Date.now();
  f.store.setSetting('mood:p1', {
    valence: 0.2,
    energy: 0,
    patience: 0,
    reason: '聊得挺开心',
    at: now,
  });
  const pulse = moodPulseFromExchange({
    user: '好',
    assistant: '嗯',
    hour: 15,
    recentUserTexts: ['嗯', '哦', '随便', '好', '嗯'],
  });
  assert.ok(pulse);
  f.store.pulseMood('p1', pulse, now + 1000);
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
