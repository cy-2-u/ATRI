import type { Memory, SearchHit } from '../db/index.js';
import {
  detailIntegrity,
  emotionalResidue,
  traceOf,
  DETAIL_LOST_BELOW,
  DETAIL_VAGUE_BELOW,
  SIGNIFICANCE_FLOOR,
} from '../db/index.js';
import { sourceFormatter } from './time.js';

/** 记忆的分层渲染与情绪泛化：细节完整度 D 决定一段记忆此刻被想起的
 *  样子（清晰/大致记得/有印象），情绪残留 E 给被想起的记忆染色，并在
 *  残留足够强时泛化成心情脉冲。 */

/** 可渲染的记忆形状：Store 的行或排序结果都满足；trace 字段允许缺省
 *  （按新鲜、中性处理）。 */
export type Rememberable = Pick<Memory, 'id' | 'content' | 'kind'> & {
  pinned?: number | boolean;
  importance?: number;
  emotion?: number;
  consolidation?: number;
  interference?: number;
  created_at?: number;
  last_hit_at?: number;
};

/** 情绪染色：残留够强才显形，强弱用措辞表达，从不出现数值。 */
export function emotionalTint(residue: number): string {
  if (residue <= -0.55) return '（想起来心里还是很难受）';
  if (residue <= -0.3) return '（想起来还是有点不好受）';
  if (residue >= 0.55) return '（想起来还是会笑）';
  if (residue >= 0.3) return '（想起来会开心）';
  return '';
}

/** 细节丢失时留下的"照片"：取第一句完整的短语，而不是机械截断。 */
export function gistOf(content: string, maxChars = 48): string {
  const body = content.trim().replace(/\s+/g, ' ');
  if (body.length <= maxChars) return body;
  const clipped = body.slice(0, maxChars + 12);
  const sentence = clipped.match(/^[\s\S]*?[。！？…!?]/)?.[0];
  if (sentence && sentence.replace(/\s/g, '').length >= 8)
    return sentence.replace(/[。！？…]$/, '');
  const comma = clipped.match(/^[\s\S]*?[，,、]/)?.[0];
  if (comma && comma.replace(/\s/g, '').length >= 8) return comma.replace(/[，,、]$/, '');
  return body.slice(0, maxChars);
}

function traceOfRememberable(m: Rememberable) {
  return traceOf({
    importance: m.importance ?? 0.5,
    emotion: m.emotion ?? 0,
    consolidation: m.consolidation ?? 0,
    interference: m.interference ?? 0,
    created_at: m.created_at ?? Date.now(),
    last_hit_at: m.last_hit_at ?? 0,
  });
}

/** 一条记忆此刻被想起的样子；置顶是运维的明确意愿，永远清晰。 */
export function renderMemoryLine(m: Rememberable, kindLabel = true): string {
  const D = m.pinned ? 1 : detailIntegrity(traceOfRememberable(m), Date.now());
  const E = emotionalResidue(traceOfRememberable(m), Date.now());
  const tint = emotionalTint(E);
  const tag = kindLabel
    ? `（id:${m.id}，${m.kind === 'stated' ? '对话确认' : '主观理解'}${m.pinned ? '，置顶' : ''}）`
    : '';
  if (D >= DETAIL_VAGUE_BELOW) return `- ${m.content}${tint}${tag}`;
  if (D >= DETAIL_LOST_BELOW) return `- 大致记得：${m.content}${tint}（细节有些模糊，id:${m.id}）`;
  return `- 有印象：${gistOf(m.content)}${tint}（很多细节想不起来了，id:${m.id}）`;
}

export function renderMemories(memories: Rememberable[]): string {
  if (!memories.length) return '暂无';
  return memories.map((m) => renderMemoryLine(m)).join('\n');
}

/** 想不起来的记忆不参与自发召回；search_memory（带线索的提取）不受此限。 */
export function spontaneouslyUnrecallable(hit: SearchHit): boolean {
  if (hit.kind !== 'memory' || hit.detail === undefined) return false;
  return hit.detail < DETAIL_LOST_BELOW && (hit.significance ?? 1) < SIGNIFICANCE_FLOOR;
}

/** 召回命中渲染：记忆与日记同样分层——老日记不再逐字全文地被想起。 */
export function renderHitLine(hit: SearchHit, format: (h: SearchHit) => string): string {
  const base = format(hit);
  if (hit.detail === undefined || hit.detail >= DETAIL_VAGUE_BELOW) return base;
  if (hit.kind === 'diary') {
    const prefix =
      hit.detail < DETAIL_LOST_BELOW ? '那天的日记，只剩印象：' : '那天的日记，大致记得：';
    return `- ${prefix}${base}`;
  }
  if (hit.kind === 'memory') {
    const prefix = hit.detail < DETAIL_LOST_BELOW ? '模糊印象：' : '大致记得：';
    return `- ${prefix}${base}`;
  }
  return base;
}

/** 日记段落的细节完整度：与记忆同一套衰减，只是没有演练跟踪（纯衰减），
 *  情绪底色强的段落淡得慢。 */
function diaryTrace(d: { emotion?: number; created_at: number }) {
  return traceOf({
    importance: 0.5,
    emotion: d.emotion ?? 0,
    consolidation: 0,
    interference: 0,
    created_at: d.created_at,
    last_hit_at: 0,
  });
}
export function diaryDetail(d: { emotion?: number; created_at: number }, now = Date.now()): number {
  return detailIntegrity(diaryTrace(d), now);
}

/** 久别重逢读的那几段日记按当下清晰度渲染。 */
export function renderDiarySection(
  d: { id: string; day: string; content: string; emotion?: number; created_at: number },
  now = Date.now(),
): string {
  const D = diaryDetail(d, now);
  const tint = emotionalTint(emotionalResidue(diaryTrace(d), now));
  if (D >= DETAIL_VAGUE_BELOW) return `${d.day}（id:${d.id}）：${d.content}${tint}`;
  if (D >= DETAIL_LOST_BELOW)
    return `${d.day}（id:${d.id}）：大致记得——${d.content}${tint}（细节有些模糊）`;
  return `${d.day}（id:${d.id}）：只剩印象——${gistOf(d.content)}（那天的细节想不起来了）`;
}

/** 回看旧日记的情绪泛化素材：底色还在的段落折出残留，交给 residuePulse
 *  变成此刻的心情。 */
export function diaryResidues(
  sections: { id: string; day: string; emotion?: number; created_at: number }[],
  now = Date.now(),
): { emotion: number; reason: string }[] {
  const out: { emotion: number; reason: string }[] = [];
  for (const d of sections) {
    const residue = emotionalResidue(diaryTrace(d), now);
    if (Math.abs(residue) >= 0.35) out.push({ emotion: residue, reason: `翻回了${d.day}写的日记` });
  }
  return out;
}

/** 演练回报 → 心情脉冲：把"想起了什么"泛化成此刻的感觉。幅度保守
 *  （单条残留的 1/4），方向跟随残留符号，原因取最强的一条。 */
export function residuePulse(
  residues: { emotion: number; reason: string }[],
): { valence: number; reason?: string } | undefined {
  if (!residues.length) return undefined;
  const sum = residues.reduce((n, r) => n + r.emotion, 0);
  if (Math.abs(sum) < 0.35) return undefined;
  const strongest = [...residues].sort((a, b) => Math.abs(b.emotion) - Math.abs(a.emotion))[0]!;
  return {
    valence: Math.max(-0.6, Math.min(0.6, sum * 0.25)),
    reason: strongest.reason || '想起了以前的事',
  };
}

/** 召回命中渲染为紧凑的资料行。hits 按相关度从优到劣到达，输出反序：
 *  最相关的资料贴近对话末端（注意力的最强处）。 */
export function renderHits(hits: SearchHit[], timeZone: string): string {
  if (!hits.length) return '暂无';
  const formatter = sourceFormatter(timeZone);
  const line = (h: SearchHit): string => {
    // system 行是管理页的更正，渲染成"你说"会替她认下没说过的话。
    const who =
      h.kind === 'message'
        ? h.role === 'user'
          ? '对方说'
          : h.role === 'system'
            ? '设定更正'
            : '你说'
        : h.kind === 'memory'
          ? h.memory_kind === 'stated'
            ? '记忆·对话确认'
            : '记忆·主观理解'
          : '日记';
    return `${h.content}（${who}，${formatter.format(new Date(h.created_at))}，id:${h.id}）`;
  };
  return [...hits]
    .reverse()
    .map((h) => renderHitLine(h, (x) => line(x)))
    .join('\n');
}
