/** 记忆的六个变量 M = {S, D, R, E, C, I}。
 *
 *  记忆不是录像机：每一段记忆随时间各自变化——细节先淡、意义后淡，情绪残留
 *  得更久，被反复想起的记忆会巩固，被相似记忆干扰的记忆会加速模糊。除巩固
 *  C 与干扰 I 存库外，其余量都从写时种子和时间现算，无需后台任务。
 *
 *  遗忘速率 λD = λ0·(1−α|E|)·(1−βC)·(1+γI)：情绪越强忘得越慢，巩固越深忘得
 *  越慢，干扰越大忘得越快。 */

const DAY_MS = 86400000;
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** 细节基础衰减率（/天）：中性、无巩固、无干扰约 6 天半衰。 */
export const DETAIL_DECAY_LAMBDA0 = 0.12;
/** 意义衰减率（/天）：重要的事约一年才淡到一半。 */
export const SIGNIFICANCE_DECAY_LAMBDA = 0.002;
/** 情绪残留半衰期（天）：比心情（小时级）慢一个数量级，比细节快。 */
export const RESIDUE_HALFLIFE_DAYS = 10;

export const EMOTION_GUARD_ALPHA = 0.55;
export const CONSOLIDATION_GUARD_BETA = 0.65;
export const INTERFERENCE_PUSH_GAMMA = 0.9;

/** 渲染分层的两个细节阈值。 */
export const DETAIL_VAGUE_BELOW = 0.65;
export const DETAIL_LOST_BELOW = 0.35;
/** 细节丢失且意义低于此值：这段记忆想不起来了（记录保留，不再自发出现）。 */
export const SIGNIFICANCE_FLOOR = 0.2;

/** 巩固增益：间隔 ≥3 天的回想给足 0.15，刚看过就再看几乎不涨。 */
export const CONSOLIDATION_GAIN_MAX = 0.15;
export const CONSOLIDATION_GAIN_SATURATION_DAYS = 3;
/** 重述已知事实（写路径合并分支）的巩固增量。 */
export const CONSOLIDATION_RESTATE_GAIN = 0.08;
/** 相似新记忆写入时对旧记忆的干扰增量。 */
export const INTERFERENCE_BUMP = 0.1;

/** 心境一致性召回（mood-congruent recall）：当前心情与记忆残留同号时给排序
 *  乘上一个小系数——难过时难过的旧事更容易浮上来。系数刻意很小：
 *  “难过→想起难过→更难过”的自增强回路真实存在，只取真人情绪修复力的下限。 */
export const MOOD_CONGRUENCE_BOOST = 0.15;

export interface MemoryTraceState {
  /** 意义种子（0–1），写入时的 importance。 */
  importance: number;
  /** 写入时的情绪（-1–1）。 */
  emotion: number;
  consolidation: number;
  interference: number;
  createdAt: number;
  /** 上次被想起的时间；0 表示从未（回落到 createdAt）。 */
  rehearseAt: number;
}
export interface MemoryTraceLike {
  importance: number;
  emotion: number;
  consolidation: number;
  interference: number;
  created_at: number;
  last_hit_at: number;
}

/** 从存储行取 trace 状态，缺省值兜底旧数据。 */
export function traceOf(m: MemoryTraceLike): MemoryTraceState {
  return {
    importance: Number.isFinite(m.importance) ? m.importance : 0.5,
    emotion: Number.isFinite(m.emotion) ? m.emotion : 0,
    consolidation: clamp01(Number(m.consolidation) || 0),
    interference: clamp01(Number(m.interference) || 0),
    createdAt: Number(m.created_at) || 0,
    rehearseAt: Number(m.last_hit_at) > 0 ? Number(m.last_hit_at) : Number(m.created_at) || 0,
  };
}

/** λD = λ0·(1−α|E|)·(1−βC)·(1+γI)；情绪与巩固只降速率、不降为 0。 */
export function detailDecayRate(
  emotion: number,
  consolidation: number,
  interference: number,
): number {
  const calm = 1 - EMOTION_GUARD_ALPHA * Math.min(1, Math.abs(emotion));
  const solid = 1 - CONSOLIDATION_GUARD_BETA * clamp01(consolidation);
  const noisy = 1 + INTERFERENCE_PUSH_GAMMA * clamp01(interference);
  return DETAIL_DECAY_LAMBDA0 * Math.max(0.05, calm * solid) * noisy;
}

export const daysSince = (at: number, now: number) => Math.max(0, (now - at) / DAY_MS);

/** D(t) = e^(−λD·Δt)；D0 恒为 1：每次回想重置衰减时钟（再巩固）。 */
export function detailIntegrity(state: MemoryTraceState, now: number): number {
  const lambda = detailDecayRate(state.emotion, state.consolidation, state.interference);
  return Math.exp(-lambda * daysSince(state.rehearseAt || state.createdAt, now));
}

/** S(t) = S0·e^(−λS·age)；按写入起算，回想不重置——意义是事情本身的属性。 */
export function significance(state: MemoryTraceState, now: number): number {
  return (
    clamp01(state.importance) *
    Math.exp(-SIGNIFICANCE_DECAY_LAMBDA * daysSince(state.createdAt, now))
  );
}

/** E(t) = E0·e^(−λE·age)，保留符号；回想让人再次感受到，但不给残留续期。 */
export function emotionalResidue(state: MemoryTraceState, now: number): number {
  const lambda = Math.LN2 / RESIDUE_HALFLIFE_DAYS;
  return Math.max(
    -1,
    Math.min(1, state.emotion * Math.exp(-lambda * daysSince(state.createdAt, now))),
  );
}

/** R = (0.35+0.65·D)·(1+0.5·C)：细节模糊但巩固深的记忆仍然容易被想起。 */
export function accessibility(state: MemoryTraceState, now: number): number {
  return (0.35 + 0.65 * detailIntegrity(state, now)) * (1 + 0.5 * clamp01(state.consolidation));
}

/** 忘记的判定：细节丢了，且连“这件事很重要”都想不起来。非删除。 */
export function isForgotten(state: MemoryTraceState, now: number): boolean {
  return (
    detailIntegrity(state, now) < DETAIL_LOST_BELOW && significance(state, now) < SIGNIFICANCE_FLOOR
  );
}

/** 间隔效应：距上次回想越接近饱和天数，这次回想留下的巩固越多。 */
export function consolidationGain(gapMs: number): number {
  if (!(gapMs > 0)) return CONSOLIDATION_GAIN_MAX * 0.15;
  const days = gapMs / DAY_MS;
  const share = Math.min(1, days / CONSOLIDATION_GAIN_SATURATION_DAYS);
  return CONSOLIDATION_GAIN_MAX * (0.13 + 0.87 * share);
}
