import type { Message, OpenLoop, SoftThread } from '../db/index.js';
import { sourceFormatter, vagueDays } from './time.js';
import { STICKER_RECENT_SHOWN, PROMPT_STICKERS } from './constants.js';
import type { Sticker } from './reply.js';

/** 提示词资料块的渲染：历史消息、表情目录与使用反馈、未完的约定与挂念、
 *  她自己的当下。这些块是"资料"而非编排逻辑——agent 只负责把它们按预算
 *  拼进请求。 */

export function renderMessage(m: Message, timeZone = 'Asia/Shanghai'): string {
  const media = m.media
    .map((a) => (a.description ? `[${a.kind}，模型观察：${a.description}]` : `[收到${a.kind}附件]`))
    .join('\n');
  const at = sourceFormatter(timeZone).format(new Date(m.created_at));
  return `[来源 ${m.id} | ${at}]\n${m.content}${media ? '\n' + media : ''}`;
}

export interface RecentStickerUse {
  slug: string;
  at: number;
}
/** 从 assistant 历史里取最近发送的表情（历史存的是 [表情：description]，
 *  要解析回目录 slug 才能比对）。倒序扫描取每个 slug 的最近一次使用。 */
export function recentStickerUse(history: Message[], stickers: Sticker[] = []): RecentStickerUse[] {
  const byName = new Map<string, string>();
  for (const s of stickers) {
    byName.set(s.slug.toLowerCase(), s.slug);
    byName.set(s.description.toLowerCase(), s.slug);
    for (const tag of s.tags ?? []) byName.set(tag.toLowerCase(), s.slug);
  }
  const uses: RecentStickerUse[] = [];
  const seen = new Set<string>();
  for (let i = history.length - 1; i >= 0 && uses.length < STICKER_RECENT_SHOWN; i--) {
    const m = history[i]!;
    if (m.role !== 'assistant') continue;
    for (const match of m.content.matchAll(/\[表情：([^】\]]+?)\]/g)) {
      const name = match[1]!.trim();
      const slug = byName.get(name.toLowerCase());
      // 解析不出的名字跳过：存成假 slug 只会让"最近发送"列表撒谎。
      if (!slug || seen.has(slug)) continue;
      seen.add(slug);
      uses.push({ slug, at: m.created_at });
      if (uses.length >= STICKER_RECENT_SHOWN) break;
    }
  }
  return uses.reverse();
}

/** 到期与未到期的约定。已问过的保留 id 让模型能在对方汇报时了结，
 *  渲染层标注不要再追问。 */
export function renderOpenLoops(loops: OpenLoop[], now: number, timeZone: string): string {
  if (!loops.length) return '';
  const formatter = sourceFormatter(timeZone);
  return `未完的约定（对方提到过的安排；未到期的只需要记住，不要提前追问，到期后再自然关心。每件只问一次，问过就放下）：\n${loops
    .map((l) => {
      const due = formatter.format(new Date(l.due_at));
      const timing =
        l.due_at <= now
          ? '已到约定时间'
          : `未到期，还有 ${Math.max(1, Math.ceil((l.due_at - now) / 86400000))} 天`;
      const askedNote = l.asked
        ? '，已问过一次；对方汇报结果时用 resolveLoops 了结，不要再次追问'
        : '';
      return `- [id:${l.id}] ${l.content}（约定时间：${l.due_text || due}，${timing}${askedNote}${l.recurring === 'yearly' ? '，每年循环' : ''}）`;
    })
    .join(
      '\n',
    )}\nresolveLoops/askedLoops/openLoops 的字段用法见上方对话规则。对方在到期前提到结果或改期时，用 resolveLoops 结束旧约定，或重新记录新的时间。当前时间戳：${now}。`;
}

/** 挂念从不变成定时消息：这块只在普通回复时随行，提示词要求仅在话题
 *  自然相关时顺口一问。 */
export function renderSoftThreads(threads: SoftThread[], now: number): string {
  if (!threads.length) return '';
  const age = (at: number) => Math.max(1, Math.floor((now - at) / 86400000));
  return `还没放下的事（没有具体日期，不会因此主动发消息；只有话题自然相关时才顺着问一句，不相关就别提，也别逐条确认）：\n${threads
    .map((t) => {
      const label = t.kind === 'promise' ? '你答应过' : '对方提过';
      const asked = t.asked ? '，已经问过一次，别再追问，只有对方主动提起时才了结' : '';
      return `- [id:${t.id}] ${label}：${t.content}（${vagueDays(age(t.created_at))}前记下的${asked}）`;
    })
    .join('\n')}\nthreads/resolveThreads/askedThreads 的字段用法见上方对话规则。`;
}

/** 表情窗口按天轮转（尾部可达），最近用过的下沉但不占半窗。 */
export function rotateStickers(
  all: Sticker[],
  recentUse: { slug: string }[],
  now: number,
  window = PROMPT_STICKERS,
): Sticker[] {
  if (all.length <= window) return all;
  const day = Math.floor(now / 86400000);
  const offset = day % all.length;
  const order = [...all.slice(offset), ...all.slice(0, offset)];
  const used = new Set(recentUse.map((u) => u.slug));
  const fresh = order.filter((s) => !used.has(s.slug));
  const stale = order.filter((s) => used.has(s.slug));
  const staleCap = Math.max(1, Math.floor(window / 2));
  const keptStale = stale.slice(0, staleCap);
  const keep = Math.max(0, window - keptStale.length);
  // 返回挑选出的顺序本身：按目录序重排会悄悄撤销下沉。
  return [...fresh.slice(0, keep), ...keptStale].slice(0, window);
}

/** 她的当下（聊天与心跳共用）：此刻在做什么、今天打算做什么。聊天时
 *  对方问"在干嘛"她答得上来，是因为这块资料真的递进去了。 */
export function renderSelfNow(
  self: { activity: string; activity_since: number; plan: string; plan_day: string },
  now: number,
  timeZone: string,
): string {
  const parts: string[] = [];
  if (self.activity) {
    const since = self.activity_since
      ? `，从 ${sourceFormatter(timeZone).format(new Date(self.activity_since))} 开始`
      : '';
    parts.push(`此刻在做：${self.activity}${since}`);
  }
  if (self.plan && self.plan_day === sourceFormatter(timeZone).format(new Date(now)).slice(0, 5))
    parts.push(`今天的打算：${self.plan}`);
  if (!parts.length) return '此刻没有在做特定的事。';
  return parts.join('；') + '。这些是资料，不是台词：聊天被问到就如实说，没被问就不必提。';
}
