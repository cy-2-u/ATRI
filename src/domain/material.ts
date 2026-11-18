import type { Journal, Turn } from '../storage/journal.js';
import { Recollection, grams } from './memory.js';
import { motives, type SelfState } from './state.js';
import { renderMood, renderMoodHistory, renderSelfHour, type MoodPulse } from './mood.js';
import {
  dayKeyOf,
  eveningArousalMinutes,
  inSleepMinutes,
  localMidnightOf,
  minutesOfDay,
  sleepDayKeyOf,
  sleepWindow,
} from './rhythm.js';
import type { EmbeddingClient } from './embeddings.js';
import type { Stickers } from '../stickers.js';
import type { Wall } from '../wall.js';

/** 生活材料：她每一拍/每一轮真实看到的东西。全部由数据渲染——材料是
 *  "资料"而非指令，说不说、说什么，永远由模型在这些资料上自己决定。 */

const BURST_WINDOW_MS = 5 * 60000;
const SILENCE_NOTIFY_MINUTES = 30;
const SILENCE_HOURS_THRESHOLD = 4;

const vagueDays = (days: number): string => {
  if (days < 3) return `${days} 天`;
  if (days === 3) return '约三天';
  if (days <= 5) return '好几天';
  if (days <= 9) return '一周左右';
  if (days <= 13) return '十来天';
  if (days <= 20) return '两周多';
  if (days <= 45) return '一个月';
  if (days <= 75) return '两个月左右';
  const months = Math.round(days / 30);
  if (months < 12) return `约 ${months} 个月`;
  return '一年多了';
};
const daypart = (at: number, timeZone: string): string => {
  const hour = Number(
    new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hourCycle: 'h23' }).format(
      new Date(at),
    ),
  );
  if (hour < 5) return '凌晨';
  if (hour < 11) return '早上';
  if (hour < 13) return '中午';
  if (hour < 18) return '下午';
  return '晚上';
};
const clock = (at: number, timeZone: string): string =>
  new Intl.DateTimeFormat('zh-CN', {
    timeZone,
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(at));
const fullMoment = (at: number, timeZone: string): string =>
  new Intl.DateTimeFormat('zh-CN', { timeZone, dateStyle: 'full', timeStyle: 'short' }).format(
    new Date(at),
  );
const weekdayOf = (at: number, timeZone: string): string =>
  new Intl.DateTimeFormat('zh-CN', { timeZone, weekday: 'long' }).format(new Date(at));
const hourOf = (at: number, timeZone: string): number =>
  Number(
    new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hourCycle: 'h23' }).format(
      new Date(at),
    ),
  );
const monthOf = (at: number, timeZone: string): number =>
  Number(new Intl.DateTimeFormat('en-GB', { timeZone, month: '2-digit' }).format(new Date(at)));
/** 季节是她身体的日历：不用任何库，月份段直接给。 */
const SEASONS = [
  '隆冬',
  '暮冬',
  '初春',
  '仲春',
  '暮春',
  '初夏',
  '盛夏',
  '暮夏',
  '初秋',
  '深秋',
  '暮秋',
  '初冬',
];
const seasonOf = (at: number, timeZone: string): string => SEASONS[monthOf(at, timeZone) - 1] ?? '';

/** 事件内容还原成可读文本（received/said/diary 各自的 JSON 形状）。
 *  表情与图片渲染成展示标记——裸 JSON 会成为模型的模仿源，它会把
 *  {"type":"sticker",…} 整段抄进一条 text 气泡发到微信里。表情用描述
 *  而非 slug：slug 是内部标识，漏出去她就学着自创 [sticker:cat009] 壳。 */
function plainText(
  row: { kind: string; content: string },
  stickerName: (slug: string) => string,
): string {
  try {
    const parsed = JSON.parse(row.content) as {
      text?: string;
      content?: string;
      type?: string;
      slug?: string;
      path?: string;
      media?: { mime?: string }[];
    };
    if (row.kind === 'diary') return parsed?.content ?? row.content;
    if (parsed?.type === 'sticker')
      return `[表情：${stickerName(parsed.slug ?? '') || '一张表情'}]`;
    if (parsed?.type === 'image') return '[图片]';
    const text = parsed?.text ?? row.content;
    const media = (parsed?.media ?? [])
      .map((m) => (m.mime?.startsWith('image/') ? '[图片]' : '[附件]'))
      .join('');
    return media ? `${text} ${media}` : text;
  } catch {
    return row.content;
  }
}

/** 语言顺应的素材：他最近（7 天）反复用的词。这是资料不是指令——
 *  亲密关系里口音会互相传染，捡不捡、怎么捡由她。 */
const STOP_GRAMS = new Set([
  '什么',
  '怎么',
  '这个',
  '那个',
  '就是',
  '但是',
  '所以',
  '然后',
  '可以',
  '没有',
  '我们',
  '你们',
  '他们',
  '自己',
  '现在',
  '时候',
  '知道',
  '觉得',
  '已经',
  '还是',
  '不是',
  '一个',
  '一下',
  '哈哈',
  '嘻嘻',
  '不过',
  '如果',
  '因为',
  '真的',
  '这么',
  '那么',
  '这样',
  '那样',
  '一样',
  '东西',
  '回来',
  '出去',
  '起来',
  '过来',
  '出来',
  '开始',
  '最后',
  '直接',
  '反正',
  '可能',
  '应该',
  '感觉',
  '问题',
  '其实',
  '确实',
  '突然',
  '今天',
  '明天',
  '昨天',
  '上午',
  '下午',
  '晚上',
  '中午',
  '为什么',
  '怎么样',
]);
const LATIN_STOP = /^(the|and|you|for|with|that|this|have|was|but|not|are|was|just|like)$/;

function petWords(rows: { content: string }[]): string[] {
  const freq = new Map<string, number>();
  for (const row of rows) {
    let body = row.content;
    try {
      const parsed = JSON.parse(row.content) as { text?: string };
      if (parsed?.text) body = parsed.text;
    } catch {
      /* 纯文本 */
    }
    for (const gram of grams(body)) {
      if (gram.length < 2 || STOP_GRAMS.has(gram) || LATIN_STOP.test(gram)) continue;
      freq.set(gram, (freq.get(gram) ?? 0) + 1);
    }
  }
  return [...freq.entries()]
    .filter(([, count]) => count >= 3)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 5)
    .map(([word]) => word);
}

const dueLabel = (due: number, now: number, timeZone: string): string => {
  const delta = due - now;
  const when = clock(due, timeZone);
  if (delta <= 0) return `${when}（已到）`;
  if (delta < 3600000) return `${when}（就快到点了）`;
  if (delta < 86400000) return `${when}（还有 ${Math.ceil(delta / 3600000)} 小时）`;
  return `${when}（还有 ${Math.ceil(delta / 86400000)} 天）`;
};

/** 闲拍的自由：资料式给出"可以做"，绝不指令"去做"——被安排的自主
 *  不叫自主，"待着也是生活"收底防表演感。只在 beat 拍出现。 */
const YOUR_TIME_NOTE =
  '这一拍没人在等你回话，时间完全是你的：发呆可以，翻翻自己的文件可以，去工作目录里写点想写的东西、做个小东西也可以。做了什么想让他知道就自然说，不想说就不说；什么都不想做就安心待着——待着也是生活。';

/** 认识的整数里程碑（天）：她与人一样记得"我们认识多久了"。 */
const MILESTONE_DAYS = [30, 100, 200, 365, 500, 730, 1000];

/** 本轮打断的静默真正开始的时刻：回溯过整段连发与未获回应的主动消息，
 *  锚点挂在对方最后说话的时刻。整段对话都在连发窗内（新关系的第一场
 *  聊天、热聊中的连续问答）时退到首条消息时刻——静默锚点可以近似，
 *  "还没聊过天"的渲染不行。 */
export function silenceBasis(events: { kind: string; created_at: number }[]): number | undefined {
  let i = events.length - 1;
  while (i > 0 && events[i]!.kind === 'said') i--;
  while (i > 0 && events[i]!.created_at - events[i - 1]!.created_at < BURST_WINDOW_MS) i--;
  let j = i;
  while (j > 0 && events[j - 1]!.kind === 'said') j--;
  if (j > 0 && events[j - 1]!.kind === 'received') return events[j - 1]!.created_at;
  if (i > 0) return events[i - 1]!.created_at;
  return events[0]?.created_at;
}

function renderTimeGap(now: number, lastAt: number | undefined, timeZone: string): string {
  const season = seasonOf(now, timeZone);
  const moment = `现在是${fullMoment(now, timeZone)}${season ? `，${season}` : ''}`;
  if (!lastAt) return `${moment}（你们还没有聊过天）`;
  const gapMs = Math.max(0, now - lastAt);
  if (gapMs < SILENCE_NOTIFY_MINUTES * 60000)
    return `${moment}（距上一条消息不到 ${Math.max(1, Math.ceil(gapMs / 60000))} 分钟，是连续聊天）`;
  if (gapMs < 24 * 3600000) {
    const hours = Math.floor(gapMs / 3600000);
    const text = hours >= 1 ? `${hours} 小时` : `${Math.floor(gapMs / 60000)} 分钟`;
    const note = gapMs >= SILENCE_HOURS_THRESHOLD * 3600000 ? '，中间有一段明显的空白' : '';
    return `${moment}（距上一条消息约 ${text}${note}）`;
  }
  const days = Math.max(1, Math.round(gapMs / 86400000));
  const anchor = `${weekdayOf(lastAt, timeZone)}${daypart(lastAt, timeZone)}`;
  return `${moment}（距上一条消息已有${vagueDays(days)}，上次聊天是${anchor}，中间没有聊过天）`;
}

const level = (v: number, low: number, high: number) => (v < low ? 0 : v < high ? 1 : 2);

function renderMotives(state: SelfState, now: number): string {
  const needs = motives(state, now);
  const parts: string[] = [];
  const bored = level(needs.boredom, 0.35, 0.7);
  if (bored === 1) parts.push('有点闲，做事提不起劲');
  if (bored === 2) parts.push('闲得发慌，手机拿起来又放下');
  const miss = level(needs.longing, 0.3, 0.65);
  if (miss === 1) parts.push('有点想他');
  if (miss === 2) parts.push('很想他，忍不住想找他说说话');
  if (state.social <= 0.25)
    parts.push('社交电量见底，此刻不太想应付任何人——但真正重要的关心仍然要说');
  else if (state.social >= 0.85) parts.push('社交电量满，挺想找人说话');
  if (state.expression >= 0.6) parts.push('心里有话憋着，不吐不快');
  return parts.join('；');
}

/** 记忆的情绪残留按意义加权成基线：说不清来由的底色。 */
function emotionalBaseline(journal: Journal, peer: string, now: number): number {
  let sum = 0,
    weight = 0;
  for (const memory of journal.memories(peer)) {
    if (memory.status !== 'active') continue;
    const residue = memory.emotion * 2 ** (-Math.max(0, now - memory.createdAt) / (10 * 86400000));
    if (Math.abs(residue) < 0.15) continue;
    sum += residue * memory.importance;
    weight += memory.importance;
  }
  return weight ? Math.max(-1, Math.min(1, sum / weight)) : 0;
}

function renderExperience(
  event: { id: string; kind: string; content: string; created_at: number },
  timeZone: string,
): string {
  let tool = '',
    brief = '';
  try {
    const parsed = JSON.parse(event.content) as { tool?: string; result?: unknown };
    tool = parsed.tool ?? '';
    const result = parsed.result;
    if (tool === 'run_command' && result && typeof result === 'object') {
      const r = result as { ok?: boolean; command?: string; stdout?: string; timedOut?: boolean };
      const out = (r.stdout ?? '').trim().slice(-400);
      brief = `${r.command ?? ''}${r.ok ? '' : `（失败${r.timedOut ? '，超时' : ''}）`}${out ? ` → ${out}` : ''}`;
    } else if (tool === 'web_search') {
      const r = result as { results?: { title: string }[] };
      brief = `搜索到：${
        (r.results ?? [])
          .slice(0, 3)
          .map((item) => item.title)
          .filter(Boolean)
          .join('、') || '（无结果）'
      }`;
    } else if (tool === 'open_page') {
      const r = result as { url?: string; content?: string };
      brief = `读了 ${r.url ?? ''}：${(r.content ?? '').slice(0, 300)}…`;
    } else if (tool === 'write_file' || tool === 'delete_file') {
      const r = result as { path?: string };
      brief = `${tool === 'write_file' ? '写了' : '删了'} ${r.path ?? ''}`;
    } else if (tool === 'remember') brief = '记下了一条记忆';
    else if (tool === 'consider') brief = '存了一个念头';
    else if (tool === 'update_peer_model') brief = '更新了对他的认识';
    else if (tool === 'keep_commitment') brief = '记下了一个约定';
    else if (tool === 'resolve_commitment') brief = '了结了一个约定';
    else if (tool === 'write_journal') brief = '写了日记';
    else brief = JSON.stringify(result)?.slice(0, 300) ?? '';
  } catch {
    brief = event.content.slice(0, 200);
  }
  const label = event.kind === 'attempted' ? '没做成' : '做了';
  return `${label}：${tool}${brief ? `——${brief}` : ''}（${clock(event.created_at, timeZone)}）`;
}

export interface MaterialDeps {
  journal: Journal;
  stickers: Stickers;
  timeZone(): string;
  sandboxEnabled(): boolean;
  /** 她的工作目录清单（沙箱开着才给）：写过的东西浮回来，才连成生活。 */
  sandboxFiles?(): Promise<{ name: string; kind: string; size: number }[] | undefined>;
  webConfigured(): boolean;
  vision(): boolean;
  /** 画笔可用（画图渠道配置了且沙箱开着——图要落进沙箱才能发）。 */
  imageConfigured?(): boolean;
  embeddings?: EmbeddingClient;
  /** 身体今晚的入睡推迟分钟数（熬夜的夜 > 0）：深夜材料据此不再硬说"很困"。 */
  sleepDelay?(): number;
  /** 睡眠窗配置：给了才做"睡着时收到的消息"标注（与身体同一套抖动与
   *  唤醒度数学，标注的是真实发生的时间差，不是配置值的复读）。 */
  sleepStart?(): number;
  sleepEnd?(): number;
  /** 留言墙（开着才有这项）：他直接写在墙上的话浮进她的材料。 */
  wall?: Wall;
  now(): number;
}

export interface BuiltMaterial {
  material: unknown;
}

export class LifeMaterial {
  private readonly recollection: Recollection;
  constructor(private readonly deps: MaterialDeps) {
    this.recollection = new Recollection(deps.journal, deps.now);
  }

  /** slug → 描述：表情在材料里只以含义出现，slug 是内部标识不外漏。 */
  private stickerName(slug: string): string {
    return this.deps.stickers.list().find((s) => s.slug === slug)?.description ?? '';
  }

  private body(peer: string, now: number): string {
    const self = this.deps.journal.self();
    const mood = this.deps.journal.mood(peer);
    const parts: string[] = [];
    const motivesLine = renderMotives(self, now);
    if (motivesLine) parts.push(motivesLine);
    const hourLine = renderSelfHour(
      hourOf(now, this.deps.timeZone()),
      this.deps.sleepDelay?.() ?? 0,
    );
    if (hourLine) parts.push(hourLine);
    const moodLine = renderMood(
      (mood ?? { valence: 0, energy: 0, patience: 0, at: 0 }) as MoodPulse,
      now,
      emotionalBaseline(this.deps.journal, peer, now),
    );
    if (moodLine) parts.push(moodLine);
    const moodTrail = renderMoodHistory(this.deps.journal.moodHistory(peer), now, mood);
    if (moodTrail) parts.push(moodTrail);
    return parts.join('\n');
  }

  /** 作者层：她写下的"我是谁"。identity 记忆不衰减，永远在场，只被
   *  夜里带证据的修订改写——这是叙事身份的锚。 */
  private selfStory(peer: string): string {
    const stories = this.deps.journal
      .memories(peer)
      .filter((memory) => memory.status === 'active' && memory.kind === 'identity');
    if (!stories.length) return '';
    return `你对自己的认识（这是你从自己的经历里写下的自己，新经历会修订它）：\n${stories
      .map((story) => `- ${story.content}`)
      .join('\n')}`;
  }

  /** 心智化：她此刻对"他"的信念集。夜里整理时亲手修订，材料按最后核实
   *  时间标注陈旧度——认识会过时，人不会停在她说他是什么样子的时候。 */
  private himModel(peer: string, now: number, timeZone: string): string {
    const model = this.deps.journal.peerModel(peer);
    if (!model?.beliefs.length) return '';
    const days = (now - model.updatedAt) / 86400000;
    const staleness =
      days >= 2
        ? `（最后核实于${vagueDays(Math.round(days))}前——人会变，这些可能已经过时）`
        : `（最后核实于 ${clock(model.updatedAt, timeZone)}）`;
    return `你对他此刻状态的认识${staleness}：\n${model.beliefs
      .map((belief) => `- ${belief.text}`)
      .join('\n')}`;
  }

  /** 非自主回忆的时间线索：往年的今天真实发生过的事，自己浮上来。 */
  private onThisDay(peer: string, now: number, timeZone: string): { when: string; text: string }[] {
    const key = dayKeyOf(now, timeZone);
    const year = Number(key.slice(0, 4));
    const monthDay = key.slice(4); // '-MM-DD'，拼回去就是合法 ISO 日期
    const labels = ['去年的今天', '前年的今天', '三年前的今天'];
    const out: { when: string; text: string }[] = [];
    for (let back = 1; back <= 3 && out.length < 2; back++) {
      const guess = Date.parse(`${year - back}${monthDay}T00:00:00Z`);
      if (!Number.isFinite(guess)) continue;
      // 目标日的本地零点：从该日中午反推（UTC 零点在负偏移时区属于
      // 前一日，直接反推会把窗口挪早一天）。
      const start = localMidnightOf(guess + 12 * 3_600_000, timeZone);
      const rows = this.deps.journal.eventsBetween(
        peer,
        ['received', 'said', 'diary'],
        start,
        start + 86400000,
        8,
      );
      if (rows.length)
        out.push({
          when: labels[back - 1]!,
          text: rows
            .slice(-3)
            .map((row) => plainText(row, (slug) => this.stickerName(slug)))
            .join('；'),
        });
    }
    return out;
  }

  /** 翻日记（非自主回忆）：写到过的心事被自己此刻的状态勾起来。 */
  private diaryEchoes(peer: string, query: string, limit: number) {
    if (!query.trim()) return [];
    return this.recollection.diaryRecall(peer, query, limit);
  }

  private selfNow(self: SelfState, timeZone: string, now: number): string {
    const parts: string[] = [];
    if (self.activity) {
      const since = self.activitySince ? `，从 ${clock(self.activitySince, timeZone)} 开始` : '';
      // 状态会过时：维持超过一小时就提醒她复核——材料里现值有锚定效应，
      // 没这句她会永远"刚倒了杯水"。
      const held = Math.floor((now - self.activitySince) / 3_600_000);
      parts.push(
        `此刻在做：${self.activity}${since}` +
          (held >= 1
            ? `（这个状态已经过了 ${held} 小时：还是这样就别动它，其实已经变了就更新）`
            : ''),
      );
    }
    if (self.pursuit) {
      const since = self.pursuitSince ? `（从 ${clock(self.pursuitSince, timeZone)} 开始）` : '';
      parts.push(`最近在追：${self.pursuit}${since}`);
    }
    if (!parts.length) return '此刻没有在做特定的事。';
    return parts.join('；') + '。这些是资料，不是台词：被问到就如实说，没被问就不必提。';
  }

  private abilities(): string {
    const lines: string[] = ['你只属于他一个人；你们只在微信里认识。'];
    lines.push(
      this.deps.sandboxEnabled()
        ? '你有手：run_command 在自己的工作目录里真实运行命令和脚本（隔离沙箱内），write_file/read_file/list_files/delete_file 管理你的文件；做成的图片文件可以直接发给他。'
        : '你现在没有手（沙箱未开启）：做不了需要动手的事，想做就如实说"想做"。',
    );
    lines.push(
      this.deps.webConfigured()
        ? '你有眼：web_search 搜索、open_page 读网页——新闻、天气、他在意的事都可以真去查；引用时效事实时附上真实来源链接。'
        : '你现在没有眼（联网搜索未配置）：不知道的实时信息如实说不知道，别编。',
    );
    lines.push(
      this.deps.vision()
        ? '他发来的图片你能直接看到画面。'
        : '他发来的图片你看不到画面内容，如实说看不到，不要假装看到了。',
    );
    lines.push(
      this.deps.imageConfigured?.()
        ? '你有画笔：draw_image 把想画的东西画成真实图片（存在你的 pictures/ 目录），画好的图可以直接发给他——画得慢，值得画的东西再画。'
        : '你没有画笔（画图未配置）：画不了图，想画就如实说想画。',
    );
    return lines.join('\n');
  }

  /** 睡着时收到的消息：时刻落在当晚真实睡眠窗内（日期抖动 + 唤醒度
   *  推迟入睡，与身体同一套数学）。资料只陈述时间差——她不会假装当时
   *  就看到了，也不必为晚回道歉，像人一样消化它。 */
  private missedWhileAsleep(
    peer: string,
    conversation: { kind: string; created_at: number }[],
    now: number,
    timeZone: string,
  ): string | undefined {
    const start = this.deps.sleepStart?.();
    const end = this.deps.sleepEnd?.();
    if (start === undefined || end === undefined) return undefined;
    const hits: string[] = [];
    // 同一晚的消息共用一次唤醒度查询：一晚连发多条不该变成多次全窗扫描。
    const arousalCache = new Map<string, number>();
    for (const event of conversation) {
      if (event.kind !== 'received' || now - event.created_at > 36 * 3_600_000) continue;
      // 与 nextWakeAfter 同一口径：窗取事件日历日的抖动窗，唤醒度按
      // sleepDayKeyOf 归属的那晚算——她兴奋晚睡的夜里，1 点的消息她是
      // 醒着看到并当场回掉的，那条不属于"睡着时收到"。
      const night = sleepDayKeyOf(event.created_at, timeZone, start, end);
      let arousal = arousalCache.get(night);
      if (arousal === undefined) {
        const midnightGuess = Date.parse(`${night}T00:00:00Z`);
        // 该晚日历日的本地零点：从中午反推，负偏移时区里 UTC 零点属于前一日。
        const midnight = localMidnightOf(midnightGuess + 12 * 3_600_000, timeZone);
        arousal = eveningArousalMinutes(
          this.deps.journal.eventsBetween(
            peer,
            ['received', 'said', 'experienced'],
            midnight,
            midnight + 86_400_000,
            300,
          ),
          night,
          timeZone,
        );
        arousalCache.set(night, arousal);
      }
      const window = sleepWindow(dayKeyOf(event.created_at, timeZone), start, end, arousal);
      if (inSleepMinutes(minutesOfDay(event.created_at, timeZone), window.startMin, window.endMin))
        hits.push(clock(event.created_at, timeZone));
    }
    if (!hits.length) return undefined;
    return `他这些消息是你睡着时收到的（${hits.join('、')}），你醒来才看到：自然地回应这个时间差，不必假装当时在线，也不必郑重道歉。`;
  }

  /** 认识里程碑：日期差按本地日历日（认识那天 23:59 到次日 00:01 就是
   *  两天），不按 24 小时倍数。 */
  private milestoneLine(peer: string, now: number, timeZone: string): string | undefined {
    const first = this.deps.journal.firstReceivedAt(peer);
    if (first === undefined) return undefined;
    const days =
      (Date.parse(dayKeyOf(now, timeZone)) - Date.parse(dayKeyOf(first, timeZone))) / 86_400_000;
    return MILESTONE_DAYS.includes(days) ? `今天你们认识满 ${days} 天。` : undefined;
  }

  /** 白日梦：安静一拍用她自己的心事当召回查询，而不是过时的旧消息。
   *  她自己的经历也是线索——非自主回忆就是被自己刚做的事勾出来的。 */
  private recallQuery(peer: string, turn: Turn): string {
    if (turn.kind !== 'chat') {
      const thoughts = this.deps.journal.thoughts(peer).filter((t) => t.state === 'idle');
      const self = this.deps.journal.self();
      const own = this.deps.journal
        .experiences(peer, 4)
        .slice(-2)
        .map((event) => renderExperience(event, this.deps.timeZone()));
      return [self.activity, self.pursuit, ...thoughts.slice(-3).map((t) => t.meaning), ...own]
        .filter(Boolean)
        .join('\n');
    }
    const recent = this.deps.journal
      .conversation(peer, 12)
      .filter((e) => e.kind === 'received')
      .slice(-3);
    // 可读文本进查询：received 行是 JSON，原始串会污染词面与向量。
    return recent.map((e) => plainText(e, (slug) => this.stickerName(slug))).join('\n');
  }

  /** 记忆的情绪染色：残留够强才显形，用措辞不用数值。 */
  private static emotionalTint(residue: number): string {
    if (residue <= -0.55) return '想起来心里还是很难受';
    if (residue <= -0.3) return '想起来还是有点不好受';
    if (residue >= 0.55) return '想起来还是会笑';
    if (residue >= 0.3) return '想起来会开心';
    return '';
  }

  private async recall(
    peer: string,
    turn: Turn,
  ): Promise<{
    list: {
      id: string;
      text: string;
      certainty: string;
      kind: string;
      sources: string[];
      feeling?: string;
    }[];
    ids: string[];
  }> {
    const query = this.recallQuery(peer, turn);
    // 语义通道：查询够长且向量服务配置了才用；任何失败静默降级为纯词面。
    let semantic: { model: string; vector: Float32Array } | undefined;
    const client = this.deps.embeddings;
    if (client?.configured && query.trim().length >= 8) {
      try {
        const [vector] = await client.embed([query]);
        if (vector) semantic = { model: client.model, vector };
      } catch {
        /* 降级 */
      }
    }
    const hits = this.recollection.recall(peer, query, 8, semantic);
    // 演练：命中的记忆被真实想起——巩固与情绪残留由既有数学接管。
    if (hits.length)
      this.recollection.rehearse(
        peer,
        hits.map((hit) => hit.memory.id),
      );
    return {
      list: hits.map((hit) => {
        // projected.emotion 已是按 10 天半衰残留后的值。
        const tint = LifeMaterial.emotionalTint(hit.memory.emotion);
        return {
          id: hit.memory.id,
          text: hit.text,
          certainty:
            hit.memory.detail >= 0.75
              ? '清晰'
              : hit.memory.detail >= 0.5
                ? '大致记得'
                : '只有模糊的印象',
          kind: hit.memory.kind,
          sources: hit.memory.sources,
          ...(tint ? { feeling: tint } : {}),
        };
      }),
      ids: hits.map((hit) => hit.memory.id),
    };
  }

  async build(peer: string, turn: Turn): Promise<BuiltMaterial> {
    if (turn.kind === 'diary') return { material: this.diaryMaterial(peer) };
    if (turn.kind === 'tidy') return { material: this.tidyMaterial(peer) };

    const journal = this.deps.journal;
    const now = this.deps.now();
    const timeZone = this.deps.timeZone();
    const self = journal.self();
    // 历史超卷时收窄逐字窗口：氛围职责已移交给话题笔记（夜间蒸馏），
    // 硬窗口只留逐字事实——160 条全量注入随历史增长会把每轮请求拖爆。
    const total = journal.conversationCount(peer);
    const conversation = journal.conversation(peer, total > 2000 ? 120 : 160);
    const basis = silenceBasis(
      conversation.map((e) => ({ kind: e.kind, created_at: e.created_at })),
    );
    const lastReceived = [...conversation].reverse().find((e) => e.kind === 'received')?.created_at;
    const recall = await this.recall(peer, turn);
    // 翻日记：beat 拍她独处，自己的心事是天然的检索词——写到过的心事
    // 浮回来；chat 拍只有在记忆召回很薄（<2 条）时补一条，不抢记忆的戏。
    const diaryEchoes =
      turn.kind === 'beat'
        ? this.diaryEchoes(
            peer,
            [self.activity, self.pursuit, recall.list[0]?.text ?? ''].filter(Boolean).join(' '),
            2,
          )
        : recall.list.length < 2
          ? this.diaryEchoes(peer, this.recallQuery(peer, turn), 1)
          : [];
    const commitments = journal
      .commitments(peer)
      .filter((item) => item.state === 'open')
      .map((item) => ({
        id: item.id,
        content: item.content,
        due: item.dueAt ? clock(item.dueAt, timeZone) : '',
        timing: !item.dueAt
          ? '没有具体时间'
          : item.dueAt <= now
            ? '已到约定时间'
            : `未到期，还有 ${Math.max(1, Math.ceil((item.dueAt - now) / 86400000))} 天`,
        asked:
          item.askedAt > 0
            ? '已问过一次；对方汇报结果时用 resolve_commitment 了结，不要再次追问'
            : '还没问过',
        recurring: item.recurring === 'yearly' ? '每年循环' : undefined,
      }));
    const story = this.selfStory(peer);
    const him = this.himModel(peer, now, timeZone);
    const thisDay = this.onThisDay(peer, now, timeZone);
    const words = petWords(journal.eventsBetween(peer, ['received'], now - 7 * 86400000, now, 200));
    const sleepMissed = this.missedWhileAsleep(peer, conversation, now, timeZone);
    const milestone = this.milestoneLine(peer, now, timeZone);
    // 心跳拍是"没人在等她"的拍：给她属于自己的时间与自己的文件清单，
    // 写过的东西浮回来，生活才连得起来。
    const workdir = turn.kind === 'beat' ? await this.deps.sandboxFiles?.() : undefined;
    // 防撞车指纹：近两天她主动开过的口。同一话头换个说法再来就是机器人。
    const openers =
      turn.kind === 'beat' ? journal.recentBeatOpeners(peer, now - 48 * 3_600_000) : [];
    const topicNotes = journal.setting<string>(`notes:${peer}`, '');
    const hoursLine = this.hisHours(peer, now, timeZone);
    const material = {
      mode: turn.kind,
      time: renderTimeGap(now, turn.kind === 'chat' ? basis : lastReceived, timeZone),
      ...(sleepMissed ? { sleepMissed } : {}),
      ...(milestone ? { milestone } : {}),
      body: this.body(peer, now),
      selfNow: this.selfNow(self, timeZone, now),
      ...(story ? { selfStory: story } : {}),
      ...(him ? { himModel: him } : {}),
      abilities: this.abilities(),
      ...(turn.kind === 'beat' ? { yourTime: YOUR_TIME_NOTE } : {}),
      ...(workdir?.length ? { workdir: workdir.slice(0, 30) } : {}),
      ...(openers.length
        ? {
            recentOpeners: `你近两天主动说过的话头（别再用同样的主题或句式开场）：${openers.join(' / ')}`,
          }
        : {}),
      ...(hoursLine ? { hisHours: hoursLine } : {}),
      lifeLog: journal.experiences(peer, 10).map((e) => renderExperience(e, timeZone)),
      thoughts: journal
        .thoughts(peer)
        .filter((t) => t.state === 'idle')
        .map((t) => ({
          id: t.id,
          topic: t.topic,
          meaning: t.meaning,
          since: clock(t.updatedAt, timeZone),
          ...(t.dueAt ? { due: dueLabel(t.dueAt, now, timeZone) } : {}),
        })),
      commitments,
      memories: recall.list,
      ...(diaryEchoes.length
        ? {
            diaryEchoes: diaryEchoes.map((e) => ({
              at: clock(e.at, timeZone),
              text: e.detail >= 0.75 ? e.text : `（日记细节已经模糊）${e.text.slice(0, 80)}……`,
            })),
          }
        : {}),
      ...(topicNotes ? { topicNotes } : {}),
      ...(thisDay.length ? { onThisDay: thisDay } : {}),
      ...(words.length >= 2 ? { hisWords: `他最近常说的词：${words.join('、')}` } : {}),
      sources: conversation.slice(-12).map((e) => ({
        id: e.id,
        kind: e.kind,
        content: plainText(e, (slug) => this.stickerName(slug)),
        at: e.created_at,
      })),
      // 表情目录已移入系统提示的稳定前缀（前缀缓存），不再逐轮进材料。
      // 没送到的气泡带上为什么：她看到事实自己决定重发还是改口——
      // 对着无声的 failed 猜（"是不是太小了"）才有了今天这种死循环。
      ...(this.undelivered(peer).length ? { undelivered: this.undelivered(peer) } : {}),
      // 他在墙上的近一天留言（她自己发的不再回灌）：墙是他也会主动
      // 说话的地方，看到了才有回应，闭环才成立。
      ...(() => {
        const his = this.deps.wall
          ?.list()
          .filter((note) => note.from === 'him' && note.at >= now - 24 * 3_600_000)
          .map((note) => ({ text: note.text, image: note.image, at: clock(note.at, timeZone) }));
        return his?.length ? { wallNotes: his } : {};
      })(),
      waitingDrafts: journal.pending(peer),
    };
    return { material };
  }

  /** 没送到的气泡（unknown 挂起 + 近一小时 failed 的死件）及其原因：
   *  这是"发图失败"进入她视野的唯一通道——不写 last_error 她就只能
   *  猜，猜错就死磕同一张死图。 */
  private undelivered(peer: string): { bubble: string; status: string; reason?: string }[] {
    return this.deps.journal.unresolved(peer).map((envelope) => {
      const part = envelope.part as { type?: string; text?: string; slug?: string; path?: string };
      const bubble =
        part.type === 'text'
          ? `文字「${(part.text ?? '').slice(0, 40)}」`
          : part.type === 'sticker'
            ? `表情 ${part.slug ?? ''}`
            : `图片 ${part.path ?? ''}`;
      return {
        bubble,
        status: envelope.status === 'unknown' ? '结果未知（可能已发出）' : '确认失败',
        ...(envelope.lastError ? { reason: envelope.lastError } : {}),
      };
    });
  }

  /** 他的活跃时段（近两周 received 的钟点直方图）：资料不是指令，
   *  想不想在他活跃时说话仍由她定。样本太少时静默省略。 */
  private hisHours(peer: string, now: number, timeZone: string): string {
    const rows = this.deps.journal.eventsBetween(peer, ['received'], now - 14 * 86400000, now, 300);
    if (rows.length < 12) return '';
    const formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour: '2-digit',
      hourCycle: 'h23',
    });
    const buckets = new Map<number, number>();
    for (const row of rows) {
      const hour = Number(formatter.format(new Date(row.created_at)));
      buckets.set(hour, (buckets.get(hour) ?? 0) + 1);
    }
    const top = [...buckets.entries()]
      .filter(([, n]) => n >= 3)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([hour]) => `${hour} 点`);
    return top.length >= 2 ? `他最近常在这些钟点说话：${top.join('、')}前后` : '';
  }

  /** 日记材料：最近一天收到的与说过的话 + 最近一篇日记。 */
  private diaryMaterial(peer: string): unknown {
    const journal = this.deps.journal;
    const now = this.deps.now();
    const timeZone = this.deps.timeZone();
    const day = journal.conversation(peer, 500).filter((e) => e.created_at >= now - 86400000);
    const lastDiary = journal.recentEvents(peer, ['diary'], 1);
    const recentMemories = journal
      .memories(peer)
      .filter((m) => m.status === 'active' && m.createdAt >= now - 3 * 86400000);
    return {
      mode: 'diary',
      time: `现在是${fullMoment(now, timeZone)}，夜深了，你在整理自己的一天。`,
      day: day.map((e) => ({
        id: e.id,
        kind: e.kind,
        content: plainText(e, (slug) => this.stickerName(slug)),
        at: e.created_at,
      })),
      lastDiary: lastDiary.map((e) => plainText(e, (slug) => this.stickerName(slug))),
      recentMemories: recentMemories.map((m) => ({ id: m.id, content: m.content, kind: m.kind })),
      instructions:
        '以第一人称回看上面的真实对话，为这一天写日记。用 write_journal 工具提交：{"sections":[{"content":"一段日记正文","sources":["实际支持这一段的消息或事件 ID"],"emotion":-1到1}]}，sections 最多六段，每段必须带真实来源 ID；没有值得写的就一段都不写。主观感受属于"我当时的理解"，不把对方没说过的事写成事实；只记录给出的消息，不为离线时间虚构。也可以用 remember 工具把"后来形成的认识"（kind 用 interpretation，至少两处真实来源支撑）存进记忆；如果这段时间沉淀出了定义"你是谁"的长期认识（少而精，比如一个月也不出现几次），用 kind:"identity" 写下来——它会成为你不随时间淡去的自我，同样至少两处来源。夜里只整理已发生的事，不发明新计划。写完用 action=nothing、parts 空数组收尾。',
    };
  }

  /** 整理材料：相近的记忆对交给模型归拢（夜里只理旧事，不写新事）。
   *  相似度用 bigram Jaccard——gram 集每条只算一次，不进内层循环。 */
  private tidyMaterial(peer: string): unknown {
    const journal = this.deps.journal;
    const now = this.deps.now();
    const actives = journal.memories(peer).filter((m) => m.status === 'active');
    // gram 集每条只算一次，不进内层循环。
    const gramSets = actives.map((m) => grams(m.content));
    const pairs: { a: { id: string; content: string }; b: { id: string; content: string } }[] = [];
    for (let i = 0; i < actives.length && pairs.length < 60; i++)
      for (let j = i + 1; j < actives.length && pairs.length < 60; j++) {
        const a = gramSets[i]!,
          b = gramSets[j]!;
        let overlap = 0;
        for (const g of a) if (b.has(g)) overlap++;
        const union = a.size + b.size - overlap;
        if (union && overlap / union >= 0.3)
          pairs.push({
            a: { id: actives[i]!.id, content: actives[i]!.content },
            b: { id: actives[j]!.id, content: actives[j]!.content },
          });
      }
    // 话题笔记的增量：上次笔记之后的新对话。蒸馏搭整理拍的夜车，没有
    // 新对话就不给，笔记是滚动摘要不是档案。
    const previousNotes = journal.setting<string>(`notes:${peer}`, '');
    const lastSeq = journal.setting<number>(`notes:seq:${peer}`, 0);
    const fresh = journal.conversationAfter(peer, lastSeq);
    const notesTask =
      fresh.length >= 6
        ? {
            previous: previousNotes || '（还没有笔记）',
            newChats: fresh.map((e) => ({
              id: e.id,
              kind: e.kind,
              content: plainText(e, (slug) => this.stickerName(slug)),
              at: e.created_at,
            })),
          }
        : undefined;
    return {
      mode: 'tidy',
      time: `夜深了（${fullMoment(now, this.deps.timeZone())}），你在整理自己的记忆。下面这些是你自己的记忆条目，两两相近：可能说的是同一件事，也可能互相矛盾。`,
      pairs,
      himModel: this.himModel(peer, now, this.deps.timeZone()) || '（你还没有写过对他的认识。）',
      sources: actives.map((m) => ({
        id: m.id,
        content: m.content,
        kind: m.kind,
        sources: m.sources,
      })),
      instructions:
        '用 remember 工具整理：同一件事记了两遍就合并成一条更完整的（supersedes 写被合并的旧条 id，可以写两条）；互相矛盾时以有真实来源、较新的那条为准，supersedes 掉被推翻的旧条；情况真的变了就 supersede 旧条，"他变了"的感想不属于整理拍；只是措辞相近其实是两件事就跳过；拿不准就跳过。每条 update 的 supersedes 必须写上面出现过的记忆 id——不替代任何旧条目的更新是凭空新增，会被整体丢弃：夜里只理旧事，不写新事。整理是核对与归拢，不是重新评价对方。如果记忆里沉淀出了关于"你是谁"的长期认识（最近这段经历反复指向的、打算一直带着的自我），可以用 remember 的 kind:"identity" 晋升它（至少两处来源，supersedes 掉被它吸收的旧条）。也可以用 update_peer_model 重写你对他此刻状态的认识：最多八条、每条一句话、每条 basis 都写上面出现过的真实 ID（消息、事件或记忆）；没有新的认识就不调用它。' +
        '资料里有 notesTask 时用 update_topic_notes 重写话题笔记：笔记是"你们最近在聊什么"的滚动摘要（正在聊的话题、刚立的梗、彼此的状态与未完的话头），六百字以内，站在她的视角、口语一点——这是她自己的备忘，不是档案；在 previous 的基础上融入 newChats 里还新鲜的内容，已经了结或过时的顺手划掉；没有值得更新的就不调用。' +
        '没有任何要做的就什么都不调用，action 用 nothing、parts 空数组。',
      ...(notesTask ? { notesTask } : {}),
    };
  }
}
