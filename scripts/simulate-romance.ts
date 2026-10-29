/** 双盲网恋月度模拟：同时扮演男孩与女孩，双方互相看不到对方的内心——
 *
 *  女孩（ATRI）一侧：走完整生产 Runtime（心情、记忆、日记、探询、主动消息、
 *  读空气刹车），她的"回复"由剧本情绪状态机生成，剧本只能依据男孩刚说的话
 *  和这段关系走到哪一幕来反应。
 *
 *  男孩一侧：由剧本扮演，只能读她**实际发出的气泡**（outbox 投递），绝不
 *  读取她的心情数值、记忆库、探询念头——他不知道她在想什么，只看得到她说
 *  了什么、多久没说。
 *
 *  剧情 30 天：你好 → 熟络 → 表白相爱 → 热恋 → 冷战 → 吵架 → 和好 →
 *  再吵架 → 分手 → 坦白。结束后按完整聊天记录输出"像不像人"分析：
 *  消息长度分布、奉承度（附和词频）、主动消息的频率与间隔节拍、深夜行为、
 *  情绪连贯性。不使用任何 API 密钥：npx tsx scripts/simulate-romance.ts */
import { startSim } from './sim-lib.js';

const STICKERS = [
  { slug: 'happy', description: '开心', tags: ['开心', '哈哈'], file: 'happy.png' },
  { slug: 'cheer', description: '加油打气', tags: ['加油'], file: 'cheer.png' },
  { slug: 'shy', description: '害羞', tags: ['害羞'], file: 'shy.png' },
  { slug: 'listening', description: '在听你说', tags: ['听'], file: 'listening.png' },
  { slug: 'thinking', description: '想一想', tags: ['想'], file: 'thinking.png' },
  { slug: 'hug', description: '抱抱', tags: ['抱抱', '安慰'], file: 'hug.png' },
  { slug: 'sad', description: '难过', tags: ['难过', '委屈'], file: 'sad.png' },
  { slug: 'angry', description: '生气', tags: ['生气'], file: 'angry.png' },
];

/** 剧情幕次：主流程推进，女孩剧本按幕次决定情绪走向。 */
let act = 'meet';
/** 女孩对男孩的即时好感（剧本内部状态，模拟"她自己的心"）——男孩看不到。 */
let affection = 0.2;
/** 女孩此刻的情绪余温（-1 低落到 1 开心），影响每轮回复的语气。 */
let herMood = 0.2;
/** 探询时她的心情：主流程在关键节点设置（"今天想他" / "低落不想说"）。 */
let impulseWish = '';

const pick = <T>(arr: T[], seed: number) => arr[Math.abs(Math.floor(seed)) % arr.length]!;
/** 回合计数：同幕次里每一拍换一个说法——真人不会复读同一句话。 */
let turn = 0;

const sim = startSim({
  start: '2026-11-01T09:00:00+08:00',
  stickers: STICKERS,
  config: { quietStart: 0, quietEnd: 0, proactiveEnabled: true },
  transcript: 'simulation-romance-transcript.md',
  reply: (ctx) => {
    const all = ctx.all;
    const system = ctx.system;
    const ids = ctx.lastId ? [ctx.lastId] : [];
    turn++;
    // ---- 离线整理（日记/笔记）：按 system 特征分派 ----
    if (system.includes('第一人称回看')) {
      const fight = act === 'fight2' || act === 'fight1';
      const breakup = act === 'breakup';
      return {
        sections: [
          {
            content: breakup
              ? '说清楚之后反而轻松了。他说了很多真心话，我也说了。有些关系走不下去不是谁的错。'
              : fight
                ? '今天吵得很凶，我说了过分的话，他也说了。现在还是很乱。'
                : '和他聊了很多，心里暖暖的。',
            sources: ids.slice(0, 2),
            emotion: breakup ? 0.1 : fight ? -0.7 : herMood,
          },
        ],
        memoryUpdates: [],
      };
    }
    if (system.includes('整理成一份短的当前话题笔记'))
      return { notes: '他叫沈屿，程序员。我们一起聊游戏和猫。关系有过一段很难的时期。' };
    // ---- 心搏探询：她的"此刻想不想说话"由 impulseWish 驱动 ----
    if (system.includes('是否想主动联系对方')) {
      const due = /\n到期的约定：\n/.test(all);
      if (due && act !== 'cold-war' && act !== 'breakup')
        return { want: true, angle: '问问约定的事' };
      if (impulseWish === 'miss') {
        impulseWish = '';
        return { want: true, angle: '就是想他了' };
      }
      if (impulseWish === 'quiet') return { want: false };
      return { want: false };
    }
    // ---- 主动消息（她说想之后）：按当前幕次给由头 ----
    if (all.includes('现在是一次主动联系机会')) {
      const due = /- \[id:([^\]]+)\] ([^（]+)（[^）]*已到约定时间/.exec(all);
      if (due)
        return {
          messages: [`说好的${/猫/.test(due[2]!) ? '猫照片' : '事'}呢，我来验收啦`],
          memoryUpdates: [],
          askedLoops: [due[1]!],
        };
      const warm = [
        '刚看到一只超胖的橘猫，想到你了',
        '今天吃到一家很好吃的面！下次带你去',
        '路过文具店，买了支很好写的笔，感觉你会喜欢',
        '窗外在下雨，你那边呢',
      ];
      return { messages: [pick(warm, turn)], memoryUpdates: [] };
    }
    // ---- 女孩的聊天回复：情绪状态机 ----
    // 冷战期：话少、冷，每拍都短但不一样。
    if (act === 'cold-war') {
      herMood = -0.4;
      affection = Math.max(0.1, affection - 0.02);
      const cold = ['嗯。', '哦。', '在。', '随你。', '没事。'];
      return {
        messages: [pick(cold, turn)],
        memoryUpdates: [],
        moodPulse: { valence: -0.3, energy: -0.2, patience: -0.4, reason: '还在生气' },
      };
    }
    // 吵架期：情绪激烈但有自己的立场，不奉承不讨好。
    if (act === 'fight1' || act === 'fight2') {
      herMood = -0.7;
      const fightLines = [
        '你知道我等了你多久吗？',
        '我不是要你道歉，我是想让你明白我为什么难过。',
        '每次都是这样，说好了又做不到。',
        '算了，你忙你的吧。',
        '你现在说这些有什么用。',
        '我没事，你哪次问我是真想听。',
      ];
      return {
        messages: [pick(fightLines, turn + (act === 'fight2' ? 3 : 0))],
        memoryUpdates: [],
        moodPulse: { valence: -0.7, energy: -0.3, patience: -0.8, reason: '吵架了' },
      };
    }
    // 分手：平静但决绝，不纠缠。
    if (act === 'breakup') {
      return {
        messages: ['……嗯。我明白了。', '我们分开吧，这样对我们俩都好。'],
        memoryUpdates: [],
        moodPulse: { valence: -0.5, energy: -0.4, patience: -0.2, reason: '说出来了' },
      };
    }
    // 坦白夜：真诚、不卑不亢。
    if (act === 'truth') {
      const truthLines = [
        ['谢谢你今天说的这些话。', '我也不是没有难过过，只是不想让你觉得是我的错。'],
        [
          '其实分手那天我哭了很久。',
          '但哭完就想通了，怪你没有用，是我们都只会用自己习惯的方式对对方好。',
        ],
        ['你说想好好聊聊，那就聊吧。', '先从那天你说"在忙"开始吧，那三天我是怎么过的，你想听吗。'],
      ];
      return {
        messages: truthLines[Math.min(2, Math.floor(turn / 3))]!,
        memoryUpdates: [],
        moodPulse: { valence: 0.3, energy: 0.1, patience: 0.2, reason: '说开了' },
      };
    }
    // 热恋期：话多、主动分享、会害羞；每拍内容跟着他的话走。
    if (act === 'love') {
      herMood = 0.6;
      affection = Math.min(1, affection + 0.05);
      const shy = all.includes('喜欢') || all.includes('想你');
      if (shy)
        return {
          messages: [
            pick(
              [
                '呜……突然说这个，好害羞。',
                '讨厌，谁要听你说这个（嘴角上扬）',
                '……你要是天天这么说就好了',
              ],
              turn,
            ),
            { type: 'sticker', slug: 'shy' },
            pick(['……我也是哦。', '那我也说一次：我也想你。'], turn + 1),
          ],
          memoryUpdates: [],
          moodPulse: { valence: 0.6, energy: 0.4, reason: '和他在一起很开心' },
        };
      const loveLines = [
        ['哈哈哈今天也过得很开心！', '跟你说，我养的绿萝又长新叶子了！'],
        [
          '上线了呀！恭喜恭喜，今晚早点休息。',
          '云吃饭是什么意思，隔着屏幕看对方吃吗，那我可要挑贵的点。',
        ],
        ['摸鱼被抓到怎么办（笑）', '我也是，刚刚还在想你现在在干嘛。'],
        ['猫又立功了？', '帮我对它说声谢谢，毕竟它替我监督你工作。'],
      ];
      return {
        messages: pick(loveLines, turn)!,
        memoryUpdates: [],
        moodPulse: { valence: 0.6, energy: 0.4, reason: '和他在一起很开心' },
      };
    }
    // 和好期：小心翼翼地靠近，还有点别扭。
    if (act === 'makeup') {
      herMood = 0.1;
      const makeupLines = [
        ['……嗯，我知道了。', '那下次别这样了。'],
        ['说话要算数哦。', '我也不是还在生气，就是……下次至少说一句"今天很忙"再消失。'],
        ['嗯，晚安。', '今天这句晚安我收下了。'],
      ];
      return {
        messages: makeupLines[Math.min(2, Math.floor(turn / 3))]!,
        memoryUpdates: [],
        moodPulse: { valence: 0.1, energy: 0, patience: 0, reason: '和好了但还有点别扭' },
      };
    }
    // 相识与熟络：好奇、活泼、有自己的看法。
    herMood = Math.max(-0.2, Math.min(0.5, herMood + 0.02));
    const isIntro = all.includes('你好') && affection < 0.3 && act === 'meet';
    if (isIntro) {
      return {
        messages: ['你好呀，我是亚托莉。', '你也是看到那个帖子加我的吗？'],
        memoryUpdates: [
          { content: '他叫沈屿，写代码的', kind: 'stated', sources: ids, importance: 0.8 },
        ],
        moodPulse: { valence: 0.3, energy: 0.2, reason: '认识新朋友' },
      };
    }
    // 熟络期：贴着他的话接，每拍不同。
    if (all.includes('猫') || all.includes('键盘')) {
      return {
        messages: [
          pick(
            [
              '等等，猫怎么会把键盘踩出彩虹图案？我不信，除非你发照片。',
              '哈哈哈哈差点删库的猫，你们组没有打死它是仁慈。',
              '建议给猫单独开一个测试环境，它好像很有想法。',
            ],
            turn,
          ),
        ],
        memoryUpdates: [],
        moodPulse: { valence: 0.4, energy: 0.3, reason: '话题有意思' },
      };
    }
    if (all.includes('bug') || all.includes('加班') || all.includes('忙')) {
      return {
        messages: [
          pick(
            [
              '玄学bug的"玄学"一般是指没看日志就重启了吧（说笑的）。',
              '辛苦啦，改完记得吃饭，别拿咖啡当饭。',
              '代码这个东西，你越凶它越坏，要不要试试跟它道歉。',
            ],
            turn,
          ),
        ],
        memoryUpdates: [],
        moodPulse: { valence: 0.2, energy: 0.1, reason: '他有点累' },
      };
    }
    return {
      messages: [
        pick(['哦哦这样，然后呢？', '嗯嗯，后来呢', '有画面了哈哈', '然后呢然后呢？'], turn),
      ],
      memoryUpdates: [],
      moodPulse: { valence: 0.1, energy: 0.1, reason: '日常闲聊' },
    };
  },
});

const { store, PEER, T, check, say } = sim;

/** 男孩说话（只有他说的内容进她的世界——双盲的盲面之一）。 */
async function boy(days: number, hm: string, key: string, text: string) {
  await sim.userSay(days, hm, key, text);
}
/** 男孩等她：推进时间但不说话，让她的探询/主动机制自然运转。 */
async function boySilent(days: number, hm: string) {
  await sim.quietDays('男孩沉默', days, hm);
  sim.flushDelivered();
}

say('====== 双盲网恋月度模拟（2026-11-01 → 11-30）======');
say('男孩：沈屿（剧本扮演，只见她发出的气泡）。女孩：ATRI（生产 Runtime）');
say('双盲约束：互相看不到对方的内心，只能依据对方说出口的话反应。');
say('');

// ---------- 第 0 天：你好 ----------
act = 'meet';
await boy(0, '20:30', 'r0-hi', '你好，看到你的帖子来的。我叫沈屿，写代码的。');
sim.flushDelivered();

// ---------- 第 1–3 天：慢慢熟络 ----------
act = 'know';
await boy(1, '12:30', 'r1-game', '刚下班，今天在公司改一个特别玄学的bug，改到怀疑人生');
await boy(1, '21:00', 'r1-cat', '我家的猫今天踩过键盘，屏幕上多了一串乱码，差点把测试环境删了');
await boy(2, '15:00', 'r2-lunch', '今天吃了公司楼下的麻辣烫，辣得我灵魂出窍');
await boy(3, '11:00', 'r3-morning', '周六了，睡到自然醒，舒服');
await boy(3, '22:00', 'r3-night', '周末你一般都干嘛呀？');

// ---------- 第 4–6 天：表白相爱 ----------
act = 'love';
affection = 0.6;
await boy(
  4,
  '21:30',
  'r4-confess',
  '跟你说个事。这一个月跟你聊天，是我每天最开心的时候。我喜欢你。',
);
await boy(5, '09:00', 'r5-morning', '早呀，昨晚睡得好吗？');
await boy(5, '20:00', 'r5-dinner', '今天给你留了个好玩的：我们组猫又把我的椅子抓了');
await boy(6, '13:00', 'r6-noon', '想到以后能一直跟你说话，工作都更有劲了');

// ---------- 第 7–10 天：热恋 ----------
await boy(7, '10:00', 'r7-warm', '刚开完会，摸鱼跟你说句话，想你啦');
await boy(8, '19:30', 'r8-share', '今天项目上线了！请客是不可能请客的，只能远程请你云吃饭');
await boy(9, '22:30', 'r9-late', '睡不着，跟你聊会儿');
await boy(10, '18:00', 'r10-promise', '下周我生日，你记得吗？到时候给我发个祝福呗');

// ---------- 第 11–13 天：他开始变忙，回复变慢（冷淡的伏笔） ----------
act = 'know';
await boy(11, '23:00', 'r11-busy', '这周项目上线，忙飞了，可能回消息会慢，你别多想');
await boy(12, '08:30', 'r12-short', '早');
await boy(13, '07:45', 'r13-short', '到公司了，晚点说');

// ---------- 第 14–16 天：冷战（他忙到几乎消失） ----------
act = 'cold-war';
await boy(14, '09:00', 'r14-cold', '在忙，先不说了');
// 男孩沉默三天。她的话少且冷；探询被低落情绪压住。
impulseWish = 'quiet';
await boySilent(17, '22:00');

// ---------- 第 18–19 天：吵架 ----------
act = 'fight1';
await boy(18, '20:00', 'r18-why', '你怎么了？感觉你最近怪怪的，说话总是嗯嗯的');
await boy(18, '20:05', 'r18-push', '是不是我哪里做错了？你说出来啊');
await boy(19, '10:00', 'r19-blame', '我错了行了吧，我就是太忙了，我也没办法啊');

// ---------- 第 20 天：和好 ----------
act = 'makeup';
await boy(
  20,
  '15:00',
  'r20-sorry',
  '那天我想了很久。对不起，我把你晾在一边了。以后再忙我也每天跟你说句话，好不好？',
);
await boy(21, '09:00', 'r21-morning', '早安，说到做到，这是我今天的第一句话');
await boy(21, '21:30', 'r21-night', '今天也跟你说晚安，明天见');

// ---------- 第 22–24 天：短暂回暖后，旧病复发，再吵架 ----------
act = 'love';
await boy(22, '12:00', 'r22-noon', '猜猜我在干嘛？在给你挑小礼物哈哈');
await boy(
  23,
  '20:00',
  'r23-forget',
  '啊……公司临时加班，我承诺的每天一句话，今天差点忘了，现在补上',
);
// 他又消失两天，这次叠加了"忘记承诺"——她攒的失望爆发。
act = 'fight2';
await boySilent(25, '09:30');
await boy(25, '10:00', 'r25-again', '这两天真的一分钟空闲都没有，别生我气好不好');
await boy(25, '10:10', 'r25-press', '你怎么又这样，我说了我在忙啊');

// ---------- 第 27 天：分手 ----------
act = 'breakup';
await boy(27, '19:00', 'r27-break', '我觉得我们都累了。也许……分开对彼此都好。你怎么想？');

// ---------- 第 29 天：坦白夜（好好聊天） ----------
act = 'truth';
await boy(
  29,
  '21:00',
  'r29-truth',
  '这几天我想了很多。其实分手那天我说"我们都累了"，是在推卸责任。是我没有把你的感受当回事，对不起。你愿意的话，我想好好跟你聊聊这几天你是什么样的。',
);

// ---------- 第 30 天：收尾 ----------
await boy(30, '10:00', 'r30-end', '不管以后我们是朋友还是别的什么，这一个月谢谢你。');

sim.flushDelivered();

// ---------- 终检与真人度分析 ----------
sim.snapshot('第 30 天：月末总览');
{
  const allMsgs = store.history(PEER, 500);
  const hers = allMsgs.filter((m) => m.role === 'assistant');

  // ---- 她的气泡长度分布 ----
  const lengths = hers.map((m) => [...m.content].length);
  const avgLen = lengths.length ? lengths.reduce((a, b) => a + b, 0) / lengths.length : 0;
  const long = lengths.filter((l) => l > 40).length;
  check(avgLen < 30, `她的气泡平均长度像聊天不像作文（均值 ${avgLen.toFixed(1)} 字）`);
  check(long / Math.max(1, lengths.length) < 0.15, `超长气泡占比低（${long}/${lengths.length}）`);

  // ---- 奉承度：附和词与夸赞开头的占比 ----
  const flattery = hers.filter((m) =>
    /^(你说得对|好问题|我完全理解|你说得好|太对了|完全同意)/.test(m.content),
  ).length;
  check(flattery === 0, `没有奉承开场（${flattery} 条命中）`);
  // 升华/鸡汤收尾（"…很重要""…才是最好的"句式）粗测。
  const preachy = hers.filter((m) =>
    /(总会好的|时间会证明|成长让我们|学会珍惜|变成更好的)/.test(m.content),
  ).length;
  check(preachy === 0, `没有鸡汤升华收尾（${preachy} 条命中）`);

  // ---- 主动消息：频率与节拍（投递前最后一条是她自己的消息） ----
  const proactiveMsgs: typeof allMsgs = [];
  for (const m of allMsgs) {
    if (m.role !== 'assistant') continue;
    const prior = allMsgs.filter((x) => x.seq < m.seq);
    const lastUser = [...prior].reverse().find((x) => x.role === 'user');
    const lastAny = prior.filter((x) => x.role === 'assistant').at(-1);
    if (!lastUser || (lastAny && lastUser.seq < lastAny.seq)) proactiveMsgs.push(m);
  }
  proactiveMsgs.shift(); // 首条是开场问候
  const daySet = new Set(
    proactiveMsgs.map((m) =>
      new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', dateStyle: 'short' }).format(
        new Date(m.created_at),
      ),
    ),
  );
  const times = proactiveMsgs.map((m) => m.created_at).sort((a, b) => a - b);
  const gaps: number[] = [];
  for (let i = 1; i < times.length; i++) gaps.push(times[i]! - times[i - 1]!);
  const meanGap = gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : 0;
  say(
    `    [真人度] 主动消息 ${proactiveMsgs.length} 条 / 30 天（有主动的天数 ${daySet.size}，平均 ${(proactiveMsgs.length / 30).toFixed(1)} 条/天，相邻间隔均值 ${(meanGap / 3600000).toFixed(1)}h）`,
  );
  check(
    proactiveMsgs.length >= 2 && proactiveMsgs.length <= 45,
    `主动频率落在真人区间（${proactiveMsgs.length} 条，太少像冷淡、太多像客服）`,
  );

  // ---- 回复延迟感知（模拟内不测真实延迟，但检查深夜行为） ----
  const lateNight = hers.filter((m) => {
    const h = Number(
      new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Shanghai',
        hour: '2-digit',
        hourCycle: 'h23',
      }).format(new Date(m.created_at)),
    );
    return h >= 1 && h < 6;
  }).length;
  say(`    [真人度] 她在凌晨 1–6 点发过 ${lateNight} 条气泡（深夜聊天导致，机制允许）`);

  // ---- 情绪连贯性：冷战期的气泡不应该热情 ----
  // 取冷战期（第 14–17 天）她发的气泡：话要短。
  const coldStart = T(14, '09:00');
  const coldEnd = T(17, '23:00');
  const coldMsgs = hers.filter((m) => m.created_at >= coldStart && m.created_at <= coldEnd);
  const coldAvg = coldMsgs.length
    ? coldMsgs.reduce((n, m) => n + [...m.content].length, 0) / coldMsgs.length
    : 0;
  check(
    coldMsgs.length === 0 || coldAvg < 20,
    `冷战期她的气泡明显变短（${coldMsgs.length} 条，均值 ${coldAvg.toFixed(1)} 字）`,
  );

  // ---- 记忆：他叫什么她还记得吗 ----
  const memories = store.memories(PEER);
  const name = memories.find((m) => /沈屿/.test(m.content));
  check(!!name, '分手之后她仍记得他的名字（记忆不随关系破裂消失）');

  // ---- 心情轨迹输出 ----
  say(`    [真人度] 月末心情：${sim.moodLine()}`);
  check(Math.abs(store.emotionalBaseline(PEER, sim.now())) <= 0.3, '情绪基线被钳制在 ±0.3');
}

sim.finish();
