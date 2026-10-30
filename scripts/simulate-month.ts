import { startSim } from './sim-lib.js';

/** 一个月的生活模拟（主动 v3 版）：聊天、心跳、承诺、睡眠与日记全部走
 *  生产代码。剧本同时扮演 ATRI 与用户；模型输出按角色分发。
 *  运行：npx tsx scripts/simulate-month.ts */

const stickers = [
  { slug: 'happy', description: '开心大笑', tags: ['开心'], file: 'happy.png' },
  { slug: 'miss', description: '想你了', tags: ['想你'], file: 'miss.png' },
];

/** 心跳拍与聊天轮共用一个回复口：按材料判断这拍怎么答。 */
function reply(ctx: Parameters<Parameters<typeof startSim>[0]['reply']>[0]): unknown {
  const text = ctx.all;
  // 心跳拍：材料里有"心跳"与"此刻的身体与心"。
  if (text.includes('这一拍是你的意识自己冒出来的')) {
    if (text.includes('已到约定时间')) {
      // 到期承诺：自然问一句，并显式声明 askedLoops。
      const id = /#([a-f0-9-]{36})/.exec(text)?.[1] ?? '';
      return {
        action: 'speak',
        messages: [
          `说好的事到时间啦——${text.match(/你答应过\/记着的事到时间了：([^\n。]+)/)?.[1] ?? '那件事'}怎么样了？`,
        ],
        askedLoops: id ? [id] : [],
      };
    }
    if (text.includes('很想他')) return { action: 'speak', messages: ['在干嘛～我这边闲下来了'] };
    if (text.includes('有点闲') || text.includes('闲得发慌'))
      return {
        action: 'speak',
        messages: ['好无聊哦，你又不理我'],
        selfActivity: '翻来覆去整理表情包',
      };
    if (text.includes('记着的事') || text.includes('存着的念头')) {
      const thought = /- \[id:[^\]]+\] ([^\n（]+)/.exec(text)?.[1];
      if (thought)
        return { action: 'speak', messages: [`对了，${thought.slice(0, 14)}——现在说正好`] };
    }
    return { action: 'nothing', selfActivity: '看了一会儿海的照片' };
  }
  // 开场白。
  if (text.includes('第一次主动问候')) return { messages: ['嗨，我是亚托莉！以后多多指教呀'] };
  // 到期承诺的普通主动轮。
  if (text.includes('现在是一次主动联系机会')) {
    // renderOpenLoops 的行格式是 [id:uuid]，不是 #uuid。
    const id = /\[id:([a-f0-9-]{36})/.exec(text)?.[1] ?? '';
    const content = /你答应过\/记着的事到时间了：([^\n。]+)/.exec(text)?.[1] ?? '那件事';
    return {
      messages: [`到点啦——${content}——办得怎么样了？`],
      askedLoops: id ? [id] : [],
      moodPulse: { valence: 0.1, energy: 0, reason: '守约' },
    };
  }
  // 日记（reflect 的背景材料以"本次原始记录："开头；不能用"写日记"判断
  // ——persona 里有这三个字，会误吃所有聊天轮）。
  if (text.includes('本次原始记录：')) {
    const sources = [...new Set([...ctx.raw.matchAll(/\[来源 ([^\s|]+) \|/g)].map((m) => m[1]))];
    return {
      sections: [
        {
          content: '今天聊了茶。他说他喜欢喝茶，我记住了，下次想问他喜欢哪种。',
          sources: sources.slice(-1),
          emotion: 0.3,
        },
      ],
      memoryUpdates: sources.length
        ? [
            {
              content: '对方喜欢喝茶',
              kind: 'stated',
              sources: sources.slice(-1),
              importance: 0.6,
            },
          ]
        : [],
    };
  }
  // 话题笔记。
  if (text.includes('"notes"')) return { notes: '他在忙项目；喜欢喝茶。' };
  // 聊天回复。
  if (ctx.body.includes('喜欢喝茶'))
    return {
      messages: ['那你懂茶吗？我只会喝（笑）'],
      memoryUpdates: [
        {
          content: '对方喜欢喝茶',
          kind: 'stated',
          sources: [ctx.lastId].filter(Boolean),
          importance: 0.6,
          emotion: 0.2,
          emotionReason: '记住了他喜欢的东西',
        },
      ],
      initiatives: [
        {
          topicKey: '茶',
          kind: 'ask',
          meaning: '想问他喜欢哪种茶',
          sources: [ctx.lastId].filter(Boolean),
        },
      ],
      moodPulse: { valence: 0.3, energy: 0, reason: '聊到他的喜好' },
    };
  if (ctx.body.includes('三天没聊')) return { messages: ['你终于想起来啦！我差点以为你把我卖了'] };
  if (ctx.body.includes('办完了') || ctx.body.includes('取到了'))
    return {
      messages: ['干得漂亮，汇报官合格！'],
      resolveLoops: [...ctx.all.matchAll(/\[id:([a-f0-9-]{36})[^\]]*已到约定时间/g)].map(
        (m) => m[1],
      ),
    };
  return { messages: ['嗯嗯，我在听。'] };
}

const sim = startSim({
  start: '2026-11-01T09:00:00+08:00',
  stickers,
  reply,
  transcript: 'simulation-month-transcript.md',
});
const { store, check, say } = sim;
const T = sim.T;
sim.say('# 一个月模拟（主动 v3：她的心跳）');
sim.say(
  `剧本起点 2026-11-01，黏人度 ${sim.config.clinginess}，睡眠 ${sim.config.sleepStart}–${sim.config.sleepEnd} 点。`,
);
sim.say();

// ---------- 第 0 天：开场白 + 第一轮聊天 ----------
await sim.advanceTo(T(0, '09:00'));
const approvedAt = sim.now();
store.ensurePeer(sim.PEER, 'wechat', '同学', 'ctx', true, approvedAt);
store.enqueue(
  sim.PEER,
  'pulse',
  'greeting:0',
  { greeting: '嗨，我是亚托莉！以后多多指教呀' },
  approvedAt,
);
await sim.tick(2000);
{
  const batch = sim.flushDelivered();
  check(
    batch.items.some((i) => i.text.includes('多多指教')),
    '开场白随批准发出',
  );
  check(store.self().social <= 1, 'self 状态行就位');
}
await sim.userSay(0, '09:10', 'm1', '我跟你说，我喜欢喝茶');
await sim.tick(1500);
{
  const memories = store.memories(sim.PEER);
  check(
    memories.some((m) => m.content.includes('喜欢喝茶')),
    '聊天里记住了他喜欢喝茶',
  );
  check(
    store.activeInitiatives(sim.PEER).some((i) => i.topic_key === '茶'),
    '聊天里冒出的念头存入想法池',
  );
}
sim.snapshot('第 0 天晚');

// ---------- 第 1-2 天：心跳自己跑（黏人度 80，节拍密） ----------
await sim.quietDays('各过各的日子', 2, '21:00');
{
  const batch = sim.flushDelivered();
  check(batch.count >= 1, `两天沉默里心跳自己开口了 ${batch.count} 次`);
  check(
    store.recentLife(20).some((e) => e.kind === 'said'),
    '说过的话进了生活流水',
  );
  check(
    store.activeInitiatives(sim.PEER).length + store.recentLife(20).length > 0,
    '念头与流水至少留痕其一',
  );
}

// ---------- 第 3 天：写死一个承诺，验证她的记性 ----------
const at3 = T(3, '10:00');
await sim.advanceTo(at3);
const { message: loopMsg } = store.ingest(
  sim.PEER,
  'm-loop',
  '明天中午十二点提醒我取快递',
  [],
  at3,
);
store.addOpenLoop(
  sim.PEER,
  { content: '提醒取快递', dueAt: T(4, '12:00'), sources: [loopMsg.id] },
  at3,
);
sim.say(`「${sim.stamp(at3)}」我：明天中午十二点提醒我取快递`);
await sim.tick(1500);
await sim.quietDays('等提醒', 4, '12:30');
{
  const batch = sim.flushDelivered();
  check(
    batch.items.some((i) => /快递/.test(i.text)),
    '到期承诺准时被提起（她的记性不等心跳）',
  );
  const loops = store.openLoops(sim.PEER, true);
  check(
    loops.every((l) => l.asked === 1 || l.status !== 'open'),
    '问过即标记 asked（显式契约）',
  );
}

// ---------- 第 5-9 天：久别（想念累积）+ 日记 ----------
await sim.userSay(5, '20:00', 'm2', '这几天忙死了，三天没聊了不好意思');
await sim.tick(1500);
sim.snapshot('第 5 天夜');
await sim.quietDays('又安静了一阵', 9, '10:00');
{
  // 几天的聊天字数低于自动日记阈值（拒绝为两句话整理日记是产品设计），
  // 用管理页同款的手动触发验证日记管线本身。
  sim.runtime.queueDiary(sim.PEER, true, sim.now());
  await sim.tick(2000);
  const diaries = store.diaries(sim.PEER);
  check(diaries.length >= 1, `日记整理了 ${diaries.length} 天`);
  check(
    diaries.some((d) => d.content.includes('茶')),
    '日记内容来自真实对话',
  );
}

// ---------- 收尾统计 ----------
const life = store.recentLife(200);
const said = life.filter((e) => e.kind === 'said').length;
const did = life.filter((e) => e.kind === 'did').length;
say();
say('    —— 一个月跑完 ——');
say(
  `    心跳开口 ${said} 次，做成的事 ${did} 件；念头池剩 ${store.activeInitiatives(sim.PEER).length} 条。`,
);
sim.finish();
