import { startSim } from './sim-lib.js';
import {
  dayKey,
  jitteredSleepWindow,
  inSleepMinutes,
  minutesOfDay,
  BURST_WINDOW_MS,
} from '../src/core/index.js';

/** 一个月的生活模拟（主动 v3 版）：聊天、心跳、承诺、睡眠与日记全部走
 *  生产代码。剧本同时扮演 ATRI 与用户；模型输出按角色分发。
 *  运行：npx tsx scripts/simulate-month.ts */

const stickers = [
  {
    slug: 'cat028',
    description: '伸爪凑过来讨吃的：吃啥呢给我掰点',
    tags: ['嘴馋', '讨吃'],
    file: 'memes/028.jpg',
  },
  {
    slug: 'cat043',
    description: '张开双臂扑过来：抱抱！',
    tags: ['抱抱', '热情'],
    file: 'memes/043.jpg',
  },
];

/** 心跳开口的人味限流：材料命中就想说的冲动，真人也不会每小时都找他。
 *  到期承诺的追问不受此限——记性是记性，闲聊是闲聊。 */
let lastBeatSpeakAt = 0;
const BEAT_SPEAK_GAP_MS = 4 * 3600000;
/** 台词轮换：同一句台词说一个月不是人，长短错落也让长度方差有量纲。 */
const MISS_LINES = ['在干嘛～我这边闲下来了', '想你了。冒个泡？', '喂——在忙吗，我想找你说会儿话'];
const BORED_LINES = [
  '好无聊哦，你又不理我',
  '闲的。你在干嘛呢',
  '闲得发慌，整理了半天表情包也没人看',
];
let lineIndex = 0;
const pickLine = (lines: string[]) => lines[lineIndex++ % lines.length]!;

/** 心跳拍与聊天轮共用一个回复口：按材料判断这拍怎么答。 */
function reply(ctx: Parameters<Parameters<typeof startSim>[0]['reply']>[0]): unknown {
  const text = ctx.all;
  // 心跳拍：材料里有"心跳"与"此刻的身体与心"。
  if (text.includes('这一拍是你的意识自己冒出来的')) {
    // 到期承诺：只认真实到期行（renderOpenLoops 的 [id:uuid] 行），绝不
    // 认系统提示里的措辞——"已到约定时间"五个字就写在 pulse.md 正文里，
    // 按词匹配会让每一拍都在追问同一件不存在的事。问过一次的行不再问。
    const dueLine = text
      .split('\n')
      .find(
        (l) =>
          /\[id:[0-9a-f-]{36}\]/.test(l) && l.includes('已到约定时间') && !l.includes('已问过一次'),
      );
    const dueRow = dueLine ? /\[id:([0-9a-f-]{36})\] ([^\n（]+)/.exec(dueLine) : undefined;
    if (dueRow) {
      return {
        action: 'speak',
        messages: [`说好的事到时间啦——${dueRow[2]!.trim()}——办得怎么样了？`],
        askedLoops: [dueRow[1]!],
      };
    }
    const maySpeak = sim.now() - lastBeatSpeakAt >= BEAT_SPEAK_GAP_MS;
    if (maySpeak && text.includes('很想他')) {
      lastBeatSpeakAt = sim.now();
      return { action: 'speak', messages: [pickLine(MISS_LINES)] };
    }
    if (maySpeak && (text.includes('有点闲') || text.includes('闲得发慌'))) {
      lastBeatSpeakAt = sim.now();
      return {
        action: 'speak',
        messages: [pickLine(BORED_LINES)],
        selfActivity: '翻来覆去整理表情包',
      };
    }
    if (maySpeak && (text.includes('记着的事') || text.includes('存着的念头'))) {
      const thought = /- \[id:[^\]]+\] ([^\n（]+)/.exec(text)?.[1];
      if (thought) {
        lastBeatSpeakAt = sim.now();
        return { action: 'speak', messages: [`对了，${thought.slice(0, 14)}——现在说正好`] };
      }
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
  // 夜间整理拍：模拟里没有值得合并的重复记忆，直接交空。
  if (text.includes('两两相近的条目，夜里整理一遍')) return { updates: [] };
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

// ---------- 人味统计（设计文档验收：分布像人） ----------
// 机制层面的量化：深夜静、连发上限、长度方差、每日分布、心跳开口占比。
// 剧本扮演双方，所以这些统计验证的是调度与投递机制的人味，不是模型文风。
{
  const tz = sim.config.timeZone;
  const bubbles = sim.bubbles;
  const texts = bubbles.filter((b) => b.kind === 'text').map((b) => b.text.length);
  const mean = texts.length ? texts.reduce((a, b) => a + b, 0) / texts.length : 0;
  const stdev = texts.length
    ? Math.sqrt(texts.reduce((a, b) => a + (b - mean) ** 2, 0) / texts.length)
    : 0;
  // 深夜静：每条气泡都落在当天抖动后的清醒窗内。
  const asleep = bubbles.filter((b) => {
    const w = jitteredSleepWindow(dayKey(b.at, tz), sim.config.sleepStart, sim.config.sleepEnd);
    return inSleepMinutes(minutesOfDay(b.at, tz), w.startMin, w.endMin);
  }).length;
  // 连发：5 分钟窗内的连续气泡。
  let maxBurst = 0,
    run = 0,
    prev = 0;
  for (const b of bubbles) {
    run = b.at - prev < BURST_WINDOW_MS ? run + 1 : 1;
    if (run > maxBurst) maxBurst = run;
    prev = b.at;
  }
  // 每日条数分布。
  const daily = new Map<string, number>();
  for (const b of bubbles) daily.set(dayKey(b.at, tz), (daily.get(dayKey(b.at, tz)) ?? 0) + 1);
  const counts = [...daily.values()];
  const maxDay = counts.length ? Math.max(...counts) : 0;
  const minDay = counts.length ? Math.min(...counts) : 0;
  // 心跳开口占比：beat 任务里真发了气泡的比例（大多数拍应该是安静）。
  const pulseRows = store.sql
    .prepare("SELECT id,payload FROM tasks WHERE peer_id=? AND kind='pulse'")
    .all(sim.PEER) as { id: string; payload: string }[];
  const spoken = new Set(
    (
      store.sql
        .prepare("SELECT DISTINCT task_id AS id FROM outbox WHERE peer_id=? AND status='sent'")
        .all(sim.PEER) as { id: string }[]
    ).map((r) => r.id),
  );
  let beats = 0,
    beatSpeaks = 0;
  for (const row of pulseRows) {
    if (!row.payload.includes('"beat":true')) continue;
    beats++;
    if (spoken.has(row.id)) beatSpeaks++;
  }
  const userMsgs = Number(
    (
      store.sql
        .prepare("SELECT COUNT(*) AS n FROM messages WHERE peer_id=? AND role='user'")
        .get(sim.PEER) as { n: number }
    ).n ?? 0,
  );
  const stickers = bubbles.filter((b) => b.kind === 'sticker').length;
  const spanDays = Math.max(
    1,
    Math.ceil((sim.now() - Date.parse('2026-11-01T09:00:00+08:00')) / 86400000),
  );
  say();
  say('    —— 人味统计 ——');
  say(
    `    气泡 ${bubbles.length} 条（文本均长 ${mean.toFixed(1)}±${stdev.toFixed(1)} 字，表情 ${stickers} 次）；每日 ${minDay}–${maxDay} 条；最大连发 ${maxBurst} 条。`,
  );
  say(`    心跳开口 ${beatSpeaks}/${beats} 拍；主动消息 ${said} 条 / 对方消息 ${userMsgs} 条。`);
  check(asleep === 0, `深夜静：睡眠窗内 ${asleep} 条气泡`);
  check(maxBurst <= 6, `连发不超上限（最多 ${maxBurst} 条）`);
  check(stdev >= 3, `气泡长度有方差（σ=${stdev.toFixed(1)} 字）`);
  check(maxDay - minDay >= 2, `每日密度有起伏（${minDay}–${maxDay} 条/天）`);
  check(
    beats === 0 || beatSpeaks / beats <= 0.6,
    `大多数拍是安静的（开口 ${beats ? ((beatSpeaks / beats) * 100).toFixed(0) : 0}%）`,
  );
  // 主动不淹没对方：机制级看日均主动条数（黏人度 80 也不该刷屏）。
  check(said / spanDays <= 5, `日均主动 ${(said / spanDays).toFixed(1)} 条（≤5）`);
}
sim.finish();
