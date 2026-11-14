import type { Journal, Turn } from '../storage/journal.js';
import { Recollection, grams } from './memory.js';
import { motives, type SelfState } from './state.js';
import { renderMood, renderSelfHour, type MoodPulse } from './mood.js';
import type { EmbeddingClient } from './embeddings.js';
import type { Stickers } from '../stickers.js';

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
  return '快一个月';
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

/** 本轮打断的静默真正开始的时刻：回溯过整段连发与未获回应的主动消息，
 *  锚点挂在对方最后说话的时刻。 */
export function silenceBasis(events: { kind: string; created_at: number }[]): number | undefined {
  let i = events.length - 1;
  while (i > 0 && events[i]!.kind === 'said') i--;
  while (i > 0 && events[i]!.created_at - events[i - 1]!.created_at < BURST_WINDOW_MS) i--;
  let j = i;
  while (j > 0 && events[j - 1]!.kind === 'said') j--;
  if (j > 0 && events[j - 1]!.kind === 'received') return events[j - 1]!.created_at;
  return i > 0 ? events[i - 1]!.created_at : undefined;
}

function renderTimeGap(now: number, lastAt: number | undefined, timeZone: string): string {
  const moment = `现在是${fullMoment(now, timeZone)}`;
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
  webConfigured(): boolean;
  vision(): boolean;
  embeddings?: EmbeddingClient;
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

  private body(peer: string, now: number): string {
    const self = this.deps.journal.self();
    const mood = this.deps.journal.mood(peer);
    const parts: string[] = [];
    const motivesLine = renderMotives(self, now);
    if (motivesLine) parts.push(motivesLine);
    const hourLine = renderSelfHour(hourOf(now, this.deps.timeZone()));
    if (hourLine) parts.push(hourLine);
    const moodLine = renderMood(
      (mood ?? { valence: 0, energy: 0, patience: 0, at: 0 }) as MoodPulse,
      now,
      emotionalBaseline(this.deps.journal, peer, now),
    );
    if (moodLine) parts.push(moodLine);
    return parts.join('\n');
  }

  private selfNow(self: SelfState, timeZone: string): string {
    const parts: string[] = [];
    if (self.activity) {
      const since = self.activitySince ? `，从 ${clock(self.activitySince, timeZone)} 开始` : '';
      parts.push(`此刻在做：${self.activity}${since}`);
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
    return lines.join('\n');
  }

  /** 白日梦：安静一拍用她自己的心事当召回查询，而不是过时的旧消息。 */
  private recallQuery(peer: string, turn: Turn): string {
    if (turn.kind !== 'chat') {
      const thoughts = this.deps.journal.thoughts(peer).filter((t) => t.state === 'idle');
      const self = this.deps.journal.self();
      return [self.activity, self.pursuit, ...thoughts.slice(-3).map((t) => t.meaning)]
        .filter(Boolean)
        .join('\n');
    }
    const recent = this.deps.journal
      .conversation(peer, 12)
      .filter((e) => e.kind === 'received')
      .slice(-3);
    return recent.map((e) => e.content).join('\n');
  }

  private async recall(
    peer: string,
    turn: Turn,
  ): Promise<{
    list: { id: string; text: string; certainty: string; kind: string; sources: string[] }[];
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
      list: hits.map((hit) => ({
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
      })),
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
    const conversation = journal.conversation(peer, 160);
    const basis = silenceBasis(
      conversation.map((e) => ({ kind: e.kind, created_at: e.created_at })),
    );
    const lastReceived = [...conversation].reverse().find((e) => e.kind === 'received')?.created_at;
    const recall = await this.recall(peer, turn);
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
    const material = {
      mode: turn.kind,
      time: renderTimeGap(now, turn.kind === 'chat' ? basis : lastReceived, timeZone),
      body: this.body(peer, now),
      selfNow: this.selfNow(self, timeZone),
      abilities: this.abilities(),
      lifeLog: journal.experiences(peer, 10).map((e) => renderExperience(e, timeZone)),
      thoughts: journal
        .thoughts(peer)
        .filter((t) => t.state === 'idle')
        .map((t) => ({
          id: t.id,
          topic: t.topic,
          meaning: t.meaning,
          since: clock(t.updatedAt, timeZone),
        })),
      commitments,
      memories: recall.list,
      sources: conversation
        .slice(-12)
        .map((e) => ({ id: e.id, kind: e.kind, content: e.content, at: e.created_at })),
      stickers: this.deps.stickers
        .list()
        .map((s) => ({ slug: s.slug, meaning: s.description, tags: s.tags })),
      uncertain: journal.unresolved(peer),
      waitingDrafts: journal.pending(peer),
    };
    return { material };
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
      day: day.map((e) => ({ id: e.id, kind: e.kind, content: e.content, at: e.created_at })),
      lastDiary: lastDiary.map((e) => e.content),
      recentMemories: recentMemories.map((m) => ({ id: m.id, content: m.content, kind: m.kind })),
      instructions:
        '以第一人称回看上面的真实对话，为这一天写日记。用 write_journal 工具提交：{"sections":[{"content":"一段日记正文","sources":["实际支持这一段的消息或事件 ID"],"emotion":-1到1}]}，sections 最多六段，每段必须带真实来源 ID；没有值得写的就一段都不写。主观感受属于"我当时的理解"，不把对方没说过的事写成事实；只记录给出的消息，不为离线时间虚构。也可以用 remember 工具把"后来形成的认识"（kind 用 interpretation，至少两处真实来源支撑）存进记忆；没有依据就不要硬凑。夜里只整理已发生的事，不发明新计划。写完用 action=nothing、parts 空数组收尾。',
    };
  }

  /** 整理材料：相近的记忆对交给模型归拢（夜里只理旧事，不写新事）。 */
  private tidyMaterial(peer: string): unknown {
    const journal = this.deps.journal;
    const now = this.deps.now();
    const actives = journal.memories(peer).filter((m) => m.status === 'active');
    const pairs: { a: { id: string; content: string }; b: { id: string; content: string } }[] = [];
    for (let i = 0; i < actives.length && pairs.length < 60; i++)
      for (let j = i + 1; j < actives.length && pairs.length < 60; j++) {
        const a = grams(actives[i]!.content),
          b = grams(actives[j]!.content);
        let overlap = 0;
        for (const g of a) if (b.has(g)) overlap++;
        const union = a.size + b.size - overlap;
        if (union && overlap / union >= 0.3)
          pairs.push({
            a: { id: actives[i]!.id, content: actives[i]!.content },
            b: { id: actives[j]!.id, content: actives[j]!.content },
          });
      }
    return {
      mode: 'tidy',
      time: `夜深了（${fullMoment(now, this.deps.timeZone())}），你在整理自己的记忆。下面这些是你自己的记忆条目，两两相近：可能说的是同一件事，也可能互相矛盾。`,
      pairs,
      sources: actives.map((m) => ({
        id: m.id,
        content: m.content,
        kind: m.kind,
        sources: m.sources,
      })),
      instructions:
        '用 remember 工具整理：同一件事记了两遍就合并成一条更完整的（supersedes 写被合并的旧条 id，可以写两条）；互相矛盾时以有真实来源、较新的那条为准，supersedes 掉被推翻的旧条；情况真的变了就 supersede 旧条，"他变了"的感想不属于整理拍；只是措辞相近其实是两件事就跳过；拿不准就跳过。每条 update 的 supersedes 必须写上面出现过的记忆 id——不替代任何旧条目的更新是凭空新增，会被整体丢弃：夜里只理旧事，不写新事。整理是核对与归拢，不是重新评价对方。没有需要整理的就什么都不调用，action 用 nothing、parts 空数组。',
    };
  }
}
