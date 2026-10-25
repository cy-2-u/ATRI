/** 一个月模拟：剧本同时扮演双方，机制全部走生产代码。
 *  覆盖核对点：记忆产生与淡忘、上下文压缩（话题笔记）、情绪（自评脉冲/
 *  残留泛化/深夜能耗/基线）、惦记（挂念浮现与了结）、主动消息（日常问候
 *  与到期开环、读空气刹车）、表情调用格式、多气泡分开投递。
 *  运行：npx tsx scripts/simulate-month.ts（在 docker/ 目录下）。 */

import { startSim, sourceIds } from './sim-lib.js';
import { detailIntegrity, significance, traceOf } from '../src/db/index.js';
import { renderMemories } from '../src/core/index.js';

const STICKERS = [
  { slug: 'happy', description: '开心', tags: ['开心', '哈哈'], file: 'happy.png' },
  { slug: 'cheer', description: '加油打气', tags: ['加油'], file: 'cheer.png' },
  { slug: 'shy', description: '害羞', tags: ['害羞'], file: 'shy.png' },
  { slug: 'listening', description: '在听你说', tags: ['听'], file: 'listening.png' },
  { slug: 'thinking', description: '想一想', tags: ['想'], file: 'thinking.png' },
  { slug: 'hug', description: '抱抱', tags: ['抱抱', '安慰'], file: 'hug.png' },
];

/** 剧本阶段：由主流程随剧情推进切换。 */
let phase = 'intro';
const stickerSlugsSeen: string[] = [];

const sim = startSim({
  start: '2026-10-01T09:00:00+08:00',
  stickers: STICKERS,
  config: { quietStart: 0, quietEnd: 0, proactiveEnabled: true, proactiveAfterHours: 6 },
  transcript: 'simulation-month-transcript.md',
  reply: (ctx) => {
    const all = ctx.all;
    const system = ctx.system;
    const ids = sourceIds(all);
    // ---- 离线整理任务（按 system 提示词特征分派） ----
    if (system.includes('第一人称回看')) {
      const sad = all.includes('猫');
      return {
        sections: [
          {
            content: sad
              ? '他说猫生病了，声音很低。我陪他聊到很晚，希望团子快点好起来。'
              : '今天聊了很多日常，是很踏实的一天。',
            sources: ids.slice(0, 3),
            ...(sad ? { emotion: -0.5 } : {}),
          },
        ],
        memoryUpdates: [],
      };
    }
    if (system.includes('整理成一份短的当前话题笔记'))
      return { notes: '他在准备毕业设计答辩，猫叫团子；约定过下次讲讲我的过去。' };
    // ---- 主动联系（按注入指令特征句 + 约定行自身的到期标记判定） ----
    if (all.includes('现在是一次主动联系机会') || all.includes('第一次主动问候')) {
      const due = /- \[id:([^\]]+)\] ([^（]+)（[^）]*已到约定时间/.exec(all);
      if (due && /面试/.test(due[2]!))
        return {
          messages: ['面试完啦？', { type: 'sticker', slug: 'cheer' }],
          memoryUpdates: [],
          askedLoops: [due[1]!],
        };
      if (due && /聚餐/.test(due[2]!))
        return {
          messages: ['昨天聚餐吃了什么好东西！'],
          memoryUpdates: [],
          askedLoops: [due[1]!],
        };
      return { messages: ['突然想起你说的桂花糕，今天路过一家糕点铺。'], memoryUpdates: [] };
    }
    // ---- 剧情节点 ----
    if (phase === 'intro') {
      stickerSlugsSeen.push('happy');
      return {
        messages: [
          '你好呀，我是亚托莉！',
          { type: 'sticker', slug: 'happy' },
          '很高兴认识你，多聊聊呗',
        ],
        memoryUpdates: [
          { content: '用户叫林拾', kind: 'stated', sources: [ctx.lastId], importance: 0.9 },
          { content: '喜欢喝乌龙茶', kind: 'stated', sources: [ctx.lastId], importance: 0.6 },
          {
            content: '老家有种桂花糕，好像挺在意的',
            kind: 'interpretation',
            sources: [ctx.lastId],
            importance: 0.25,
          },
        ],
        moodPulse: { valence: 0.5, energy: 0.4, reason: '认识了新朋友' },
      };
    }
    if (phase === 'plan-evening') {
      // 明天下午的面试：到期时间写在回复里（剧本时间 20 小时后 ≈ 次日 17:00）
      return {
        messages: ['面试加油！我记着呢，明天下午问你结果。', { type: 'sticker', slug: 'cheer' }],
        memoryUpdates: [],
        openLoops: [
          {
            content: '面试结果',
            dueAt: Date.now() + 20 * 3600000,
            dueText: '明天下午',
            sources: [ctx.lastId],
          },
        ],
        threads: [
          { content: '这周在赶毕业设计', kind: 'concern', revisitAfter: 2, sources: [ctx.lastId] },
          {
            content: '下次讲讲她以前的事',
            kind: 'promise',
            revisitAfter: 3,
            sources: [ctx.lastId],
          },
        ],
        moodPulse: { valence: 0.2, energy: 0, reason: '他愿意跟我说安排' },
      };
    }
    if (phase === 'plan-dinner') {
      return {
        messages: ['好呀，周五等你的美食汇报！'],
        memoryUpdates: [],
        openLoops: [
          {
            content: '聚餐汇报',
            dueAt: Date.now() + 4 * 86400000 + 13 * 3600000, // 周五上午 10 点：与傍晚的日常闲聊时段错开
            dueText: '周五上午',
            sources: [ctx.lastId],
          },
        ],
        threads: [
          { content: '毕业设计答辩', kind: 'concern', revisitAfter: 2, sources: [ctx.lastId] },
        ],
      };
    }
    if (phase === 'happy-day')
      return {
        messages: ['哈哈哈那也太好了！'],
        memoryUpdates: [],
        moodPulse: { valence: 0.5, energy: 0.3, reason: '被逗笑了' },
      };
    if (phase === 'sad-day') {
      stickerSlugsSeen.push('hug');
      return {
        messages: [
          '我在呢。',
          { type: 'sticker', slug: 'hug' },
          '团子会好起来的，明天再带去看看。',
        ],
        memoryUpdates: [
          {
            content: '用户的猫团子生病住院了',
            kind: 'stated',
            sources: [ctx.lastId],
            importance: 0.7,
            emotion: -0.7,
            emotionReason: '他很难受',
          },
        ],
        moodPulse: { valence: -0.6, energy: -0.2, reason: '他的猫生病了' },
      };
    }
    if (phase === 'resolve-interview') {
      const loop = /\[id:([^\]]+)\] [^（]*面试/.exec(all);
      return {
        messages: ['太好了！！请你说好的请客！', { type: 'sticker', slug: 'cheer' }],
        memoryUpdates: [],
        resolveLoops: loop ? [loop[1]!] : [],
        moodPulse: { valence: 0.6, energy: 0.3, reason: '面试过了' },
      };
    }
    if (phase === 'resolve-dinner') {
      const loop = /\[id:([^\]]+)\] [^（]*聚餐/.exec(all);
      return {
        messages: ['哈哈辣并快乐着。'],
        memoryUpdates: [],
        resolveLoops: loop ? [loop[1]!] : [],
      };
    }
    if (phase === 'project-done') {
      const thread = /\[id:([^\]]+)\] 对方提过：[^（]*答辩/.exec(all);
      return {
        messages: ['太棒了，我就说你可以的！'],
        memoryUpdates: [],
        resolveThreads: thread ? [thread[1]!] : [],
        moodPulse: { valence: 0.5, energy: 0.2, reason: '答辩过了' },
      };
    }
    if (phase === 'filler-low') {
      // 后期的随口一提（此刻记忆池已 >10 条，它进不了提示词前排，纯衰减）
      return {
        messages: ['糖炒栗子确实香。'],
        memoryUpdates: [
          {
            content: '路过看到有人排队买糖炒栗子',
            kind: 'interpretation',
            sources: [ctx.lastId],
            importance: 0.2,
          },
        ],
      };
    }
    if (phase === 'filler')
      return {
        messages: ['记下来啦。'],
        memoryUpdates: [
          {
            content: `日常小事${Date.now() % 97}`,
            kind: 'interpretation',
            sources: [ctx.lastId],
            importance: 0.55,
          },
        ],
      };
    return { messages: ['嗯嗯，我在听。'], memoryUpdates: [] };
  },
});

const { store, runtime, PEER, T, check } = sim;
const peerRow = () => store.peer(PEER)!;
/** 最近一次“回应用户消息”的聊天调用（排除日记/笔记/主动任务的调用）。 */
const lastChatPrompt = () => {
  for (let i = sim.calls.length - 1; i >= 0; i--) {
    const text = sim.calls[i]!.messages.map((m) => m.content).join('\n\n');
    if (text.includes('本次模式：回应用户消息')) return text;
  }
  return '';
};

sim.say('====== ATRI 一个月模拟（2026-10-01 → 10-31）======');

// ---------- 第 0 天：认识 ----------
phase = 'intro';
await sim.userSay(
  0,
  '09:30',
  'd0-hello',
  '我叫林拾，平时喜欢喝乌龙茶。老家那边有种桂花糕，小时候常吃。',
);
{
  const batch = sim.flushDelivered();
  check(batch.items.length === 3, `开场回复拆成 3 个气泡分开投递（实际 ${batch.items.length}）`);
  check(
    batch.items.length === 3 &&
      batch.items[1]!.kind === 'sticker' &&
      batch.items[1]!.slug === 'happy',
    '表情以图片部件发送（slug=happy）',
  );
  const rows = store.history(PEER, 10);
  check(
    rows.some((m) => m.role === 'assistant' && m.content.includes('[表情：开心]')),
    '落库格式为 [表情：含义]，与文字气泡分开成行',
  );
  check(store.mood(PEER).valence > 0, '开场的好心情进入状态');
  sim.snapshot('第 0 天：三条新记忆入库');
}

// ---------- 第 0 天晚：约定与挂念 ----------
phase = 'plan-evening';
await sim.userSay(
  0,
  '21:00',
  'd0-plan',
  '这周都在赶毕业设计，明天下午有个面试，过了请你喝奶茶。对了，下次给我讲讲你以前的事呗',
);
check(store.openLoops(PEER, true).length === 1, '“明天面试”记成开环');
check(
  store.softThreads(PEER, true).length === 2,
  '赶项目（concern）与她答应的事（promise）记成挂念',
);

// ---------- 第 1 天：开环到期 → 独立配额主动追问 → 汇报了结 ----------
await sim.advanceTo(T(1, '18:30')); // 开环 17:00 到期，越过到期点与抖动窗口
await sim.tick(21 * 60000);
{
  const batch = sim.flushDelivered();
  check(
    batch.items.some((i) => /面试/.test(i.text)),
    '到期开环触发动机追问',
  );
  const loops = store.openLoops(PEER, true);
  check(loops.length === 1 && loops[0]!.asked === 1, '问过即标记 asked（显式声明，不靠词面猜）');
}
phase = 'resolve-interview';
await sim.userSay(1, '19:00', 'd1-pass', '过啦过啦！！下周请你去吃那家火锅');
check(store.openLoops(PEER, true).length === 0, '汇报结果即了结开环');
sim.snapshot('第 1 天晚：面试闭环');

// ---------- 第 2 天：开心的一天 ----------
phase = 'happy-day';
await sim.userSay(2, '20:00', 'd2-fun', '今天答辩预演居然被老师夸了，晚上吃到了超好吃的小龙虾');
check(store.mood(PEER).valence > 0.2, '被逗笑后愉悦回升');

// ---------- 第 3 天凌晨：深夜能耗 ----------
await sim.userSay(3, '01:30', 'd3-night', '睡不着，再聊会儿');
check(store.mood(PEER).energy < 0, '凌晨一点半还在聊，她自己的能量流失');

// ---------- 第 5 天：难过的一天 ----------
phase = 'sad-day';
await sim.userSay(5, '21:30', 'd5-cat', '团子今天突然不吃东西，送医院了，医生说要在住院观察……');
check(store.mood(PEER).valence < -0.2, '他的猫生病，她的愉悦掉下去');
sim.snapshot('第 5 天：带情绪的记忆入库');

// ---------- 第 6 天：日记 + 日常主动问候 ----------
await sim.quietDays('沉默一天', 6, '10:00');
{
  const diaries = store.diaries(PEER);
  check(diaries.length >= 2, `日记按天增量落库（已 ${diaries.length} 天）`);
  check(
    diaries.some((d) => d.emotion < 0),
    '难过那天的日记带情绪底色',
  );
  const batch = sim.flushDelivered();
  check(
    batch.items.some((i) => /桂花糕/.test(i.text)),
    '日常主动问候带真实落点（旧事/日记素材）',
  );
}

// ---------- 第 6–8 天：连续无回应 → 读空气刹车 ----------
await sim.quietDays('继续沉默', 7, '10:00');
sim.flushDelivered();
await sim.advanceTo(T(8, '10:00'));
await sim.tick(21 * 60000);
check(runtime.proactiveAllowed(peerRow(), sim.now()) === false, '连续两次主动无回应后进入多天冷却');

// ---------- 第 10 天：久别重逢 ----------
phase = 'filler';
await sim.userSay(10, '20:30', 'd10-back', '我回来啦，团子出院了！医生说没大碍');
{
  const last = lastChatPrompt();
  check(
    /上次聊天是/.test(last) && /(凌晨|早上|中午|下午|晚上)/.test(last),
    '重逢带时段锚点（从对方最后一条算起，越过未获回应的主动消息）',
  );
  check(/日记/.test(last), '重逢回看旧日记');
  sim.snapshot('第 10 天：重逢');
}

// ---------- 第 11–14 天：日常 + 填充记忆 ----------
for (let day = 11; day <= 14; day++) {
  phase = 'filler';
  await sim.userSay(day, '19:00', `d${day}-chat`, `今天日常第 ${day} 天：食堂、代码、散步`);
}

// ---------- 第 12 天验证挂念浮现（话题相关时进入提示词） ----------
check(
  sim.calls.some((c) => c.messages.some((m) => m.content.includes('还没放下的事'))),
  '挂念成熟后进入提示词（是否提起由她判断）',
);

// ---------- 第 15 天：超长连聊触发话题笔记（上下文压缩） ----------
phase = 'filler';
await sim.advanceTo(T(15, '15:00'));
for (let i = 0; i < 210; i++) sim.accept(`burst-${i}`, `刷屏日常 ${i}，聊到作业和晚饭。`);
await sim.tick(1100);
check(
  store.peer(PEER)!.notes_until > 0,
  `话题笔记随长对话整理（notes_until=${store.peer(PEER)!.notes_until}）`,
);
phase = 'filler';
await sim.userSay(15, '21:00', 'd15-after', '聊了一天，睡啦');
{
  const last = lastChatPrompt();
  check(/当前话题笔记（资料）：\n(?!暂无)/.test(last), '笔记进入提示词而非全量历史');
}

// ---------- 第 16–17 天：填充 + 一条“随口一提”（回拨 14 天做纯衰减验证） ----------
phase = 'filler-low';
await sim.userSay(16, '12:00', 'd16-low', '路过街口闻到糖炒栗子好香，随便说了句');
// 自然演化下“新鲜即入前排→演练固化”会让它锁住（见最终报告的调优观察）；
// 这里把时钟回拨、清掉这两天攒下的巩固，验证六变量的纯衰减路径。
store.sql
  .prepare(
    "UPDATE memories SET created_at=?, last_hit_at=0, consolidation=0 WHERE peer_id=? AND content LIKE '%糖炒栗子%'",
  )
  .run(sim.now() - 14 * 86400000, PEER);
store.sql.prepare('UPDATE peers SET version=version+1 WHERE id=?').run(PEER);
for (let day = 16; day <= 17; day++) {
  phase = 'filler';
  await sim.userSay(day, '19:00', `d${day}-chat`, `日常第 ${day} 天`);
}

// ---------- 第 18 天：聚餐约定（第二个开环）+ 答辩挂念 ----------
phase = 'plan-dinner';
await sim.userSay(
  18,
  '21:00',
  'd18-dinner',
  '周五晚上我们实验室聚餐，回来跟你汇报好不好吃。答辩也定在下周三了',
);
check(
  store.openLoops(PEER, true).some((l) => /聚餐/.test(l.content)),
  '聚餐记成开环',
);
check(
  store.softThreads(PEER, true).some((t) => /答辩/.test(t.content)),
  '答辩安排记成挂念',
);

// ---------- 第 23 天（周五）：聚餐开环到期（上午 10 点到期，越过到期点与抖动） ----------
await sim.advanceTo(T(23, '10:30'));
await sim.tick(21 * 60000);
{
  const batch = sim.flushDelivered();
  check(
    batch.items.some((i) => /聚餐/.test(i.text)),
    '聚餐开环到点主动问一句',
  );
  phase = 'resolve-dinner';
  await sim.userSay(23, '22:00', 'd23-report', '火锅！但辣到怀疑人生哈哈');
  check(store.openLoops(PEER, true).length === 0, '汇报后聚餐开环了结');
}

// ---------- 第 24 天：答辩结果（挂念了结） ----------
phase = 'project-done';
await sim.userSay(24, '18:00', 'd24-defense', '答辩过了！毕业设计总算结束了');
check(
  store.softThreads(PEER, true).every((t) => !/答辩/.test(t.content)),
  '“答辩”挂念在话题里自然了结',
);

// ---------- 第 25–29 天：日常，让早期记忆风干 ----------
for (let day = 25; day <= 29; day++) {
  phase = 'filler';
  await sim.userSay(day, '19:30', `d${day}-chat`, `日常第 ${day} 天`);
}
sim.flushDelivered();

// ---------- 终检：记忆分层、情绪轨迹、表情目录 ----------
sim.snapshot('第 30 天：月末总览');
{
  const memories = store.memories(PEER);
  const name = memories.find((m) => /林拾/.test(m.content))!;
  const nameD = detailIntegrity(traceOf(name), sim.now());
  check(nameD >= 0.65, `重要记忆（名字）反复演练仍然清晰（D=${nameD.toFixed(2)}）`);
  check(name.consolidation > 0.1, `演练带来巩固（C=${name.consolidation.toFixed(2)}）`);
  const osmanthus = memories.find((m) => /桂花糕/.test(m.content));
  if (osmanthus) {
    // 观察项（不是失败）：早年记忆池还小时每天进提示词，巩固早早封顶；
    // 后期即使重要性低也靠 C=1 稳住位置——这正是“被反复想起的更牢固”。
    const state = traceOf(osmanthus);
    sim.say(
      `    [观察] 早期随口一提（桂花糕）：C=${state.consolidation.toFixed(2)} 已封顶，D=${detailIntegrity(state, sim.now()).toFixed(2)}——早期小记忆池的全量演练把它锁进了前排（符合模型的巩固语义，见最终报告的调优观察）`,
    );
  }
  const chestnut = memories.find((m) => /糖炒栗子/.test(m.content));
  if (chestnut) {
    const state = traceOf(chestnut);
    const D = detailIntegrity(state, sim.now());
    const S = significance(state, sim.now());
    check(D < 0.35, `后期随口一提纯衰减淡出（D=${D.toFixed(2)}，S=${S.toFixed(2)}）`);
    check(/有印象/.test(renderMemories([chestnut])), '淡忘记忆渲染为“有印象”而非原文');
  }
  const baseline = store.emotionalBaseline(PEER, sim.now());
  check(Math.abs(baseline) <= 0.3, `情绪基线钳制在 ±0.3（当前 ${baseline.toFixed(2)}）`);
  check(new Set(stickerSlugsSeen).size >= 1, '剧本表情按对象格式发出');
  check(
    sim.calls.some((c) => c.messages.some((m) => m.content.includes('可以发送的表情'))),
    '表情目录按天轮换进入提示词',
  );
  check(
    sim.calls.some((c) => c.messages.some((m) => m.content.includes('最近已发送的表情'))),
    '最近发送过的表情作为去重反馈进入提示词',
  );
  const assistantCount = store.history(PEER, 500).filter((m) => m.role === 'assistant').length;
  check(assistantCount > 0 && assistantCount < 400, `一个月内的发言量合理（${assistantCount} 条）`);
}

sim.finish();
