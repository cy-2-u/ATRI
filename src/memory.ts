import type { Config } from './config.ts';
import { apiBase, configured } from './config.ts';
import type { Memory } from './types.ts';
import type { Store } from './store.ts';
import { jsonRequest } from './net.ts';
import { grams, projectMemory } from './state.ts';
import { createHash } from 'node:crypto';

export const cosine = (a: Float32Array, b: Float32Array): number => {
  if (a.length !== b.length || !a.length) return 0;
  let dot = 0, x = 0, y = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]! * b[i]!; x += a[i]! ** 2; y += b[i]! ** 2; }
  return x && y ? dot / Math.sqrt(x * y) : 0;
};

export interface RecalledMemory {
  memory: Memory;
  /** detail >= 0.65 给原文，否则只给要旨——模糊的记忆不补细节。 */
  text: string;
  certainty: '清晰' | '大致记得' | '只剩模糊的印象';
  feeling: string;
  score: number;
}

/** 记忆情绪残留按意义加权成基线：说不清来由的底色。 */
export function emotionalBaseline(memories: Memory[], now: number): number {
  let sum = 0, weight = 0;
  for (const memory of memories) {
    const residue = memory.emotion * 2 ** (-Math.max(0, now - memory.createdAt) / (10 * 86400000));
    if (Math.abs(residue) < 0.15) continue;
    sum += residue * memory.importance;
    weight += memory.importance;
  }
  return weight ? Math.max(-1, Math.min(1, sum / weight)) : 0;
}

const tint = (residue: number): string => {
  if (residue <= -0.55) return '想起来心里还是很难受';
  if (residue <= -0.3) return '想起来还是有点不好受';
  if (residue >= 0.55) return '想起来还是会笑';
  if (residue >= 0.3) return '想起来会开心';
  return '';
};

export class Recall {
  private store: Store;
  private config: () => Config;
  private queryCache = new Map<string, Float32Array>();
  constructor(store: Store, config: () => Config) { this.store = store; this.config = config; }

  async embed(texts: string[], signal: AbortSignal): Promise<Float32Array[]> {
    const c = this.config().embedding, started = this.store.now();
    let data: Record<string, unknown> | undefined;
    try {
      ({ data } = await jsonRequest(`${apiBase(c.url)}/embeddings`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${c.key}` }, body: JSON.stringify({ model: c.model, input: texts, encoding_format: 'float' }), signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]) }));
      if (!Array.isArray(data.data) || data.data.length !== texts.length) throw new Error('向量条数不符');
      const result = new Array<Float32Array>(texts.length); let dimensions = 0;
      for (const value of data.data as { index?: number; embedding?: unknown }[]) {
        if (!Number.isInteger(value.index) || value.index! < 0 || value.index! >= texts.length || result[value.index!]) throw new Error('向量索引无效');
        if (!Array.isArray(value.embedding) || !value.embedding.length || value.embedding.length > 65536 || value.embedding.some(v => typeof v !== 'number' || !Number.isFinite(v))) throw new Error('无效向量');
        dimensions ||= value.embedding.length;
        if (value.embedding.length !== dimensions) throw new Error('向量维度不一致');
        result[value.index!] = Float32Array.from(value.embedding as number[]);
      }
      this.store.recordUsage({ purpose: 'embedding', model: c.model, endpoint: c.url, status: 'ok', input: typeof (data.usage as { total_tokens?: unknown } | undefined)?.total_tokens === 'number' ? (data.usage as { total_tokens: number }).total_tokens : undefined, latency: this.store.now() - started });
      return result;
    } catch (error) {
      this.store.recordUsage({ purpose: 'embedding', model: c.model, endpoint: c.url, status: signal.aborted ? 'cancelled' : 'failed', input: typeof (data?.usage as { total_tokens?: unknown } | undefined)?.total_tokens === 'number' ? (data!.usage as { total_tokens: number }).total_tokens : undefined, latency: this.store.now() - started, error: error instanceof Error ? error.message : '向量请求失败' });
      throw error;
    }
  }

  /** 词面（FTS5，免费）打底；语义向量只在明确要求且词面很薄时补。 */
  async search(peer: string, query: string, signal: AbortSignal, semantic = false): Promise<RecalledMemory[]> {
    const lexical = this.store.searchMemories(peer, query, 8);
    const scored = this.score(query, lexical);
    if (!semantic || !configured(this.config().embedding) || !query.trim() || scored.length >= 4) return scored;
    const memories = this.store.memories(peer);
    if (!memories.length) return scored;
    const c = this.config().embedding;
    const namespace = `${c.url}:${c.model}`;
    const key = `${namespace}:${createHash('sha256').update(query).digest('hex')}`;
    try {
      let vec = this.queryCache.get(key);
      if (!vec) {
        [vec] = await this.embed([query], signal);
        if (!vec) return scored;
        this.queryCache.set(key, vec);
        if (this.queryCache.size > 256) this.queryCache.delete(this.queryCache.keys().next().value!);
      }
      const missing = memories.filter(m => !this.store.vector(m.id, namespace, m.content)).slice(0, 32);
      if (missing.length) {
        const vectors = await this.embed(missing.map(m => m.content), signal);
        missing.forEach((m, i) => this.store.saveVector(m.id, namespace, m.content, vectors[i]!));
      }
      const hits = memories
        .map(m => ({ id: m.id, score: cosine(vec!, this.store.vector(m.id, namespace, m.content) ?? new Float32Array()) }))
        .filter(m => m.score >= 0.35)
        .sort((a, b) => b.score - a.score)
        .slice(0, 4);
      const merged = [...new Map([...lexical, ...hits.map(h => memories.find(m => m.id === h.id)!)].map(m => [m.id, m])).values()];
      this.store.rehearsed(merged.map(m => m.id));
      return this.score(query, merged, 8, new Map(hits.map(h => [h.id, h.score])));
    } catch { signal.throwIfAborted(); return scored; }
  }

  /** 六变量投影后的统一评分：被淡忘的（细节与意义都低）不出场；
   *  detail 低的只给要旨——模糊记忆不补原话。语义分与词面分同权重。 */
  score(query: string, candidates: Memory[], limit = 8, semanticScores?: Map<string, number>): RecalledMemory[] {
    const terms = new Set(grams(query));
    const now = this.store.now();
    const semanticOf = (id: string): number => semanticScores?.get(id) ?? 0;
    return candidates
      .filter(m => m.kind !== 'identity' || terms.size === 0)
      .map(memory => {
        const projected = { ...memory, ...projectMemory(memory, now) };
        const forgotten = projected.detail < 0.35 && projected.importance < 0.2;
        const words = new Set(grams(memory.content));
        let overlap = 0;
        for (const term of terms) if (words.has(term)) overlap++;
        const relevance = terms.size ? overlap / Math.sqrt(terms.size * Math.max(1, words.size)) : 0;
        const score = relevance * 4 + semanticOf(memory.id) * 4 + projected.importance * (0.35 + 0.65 * projected.detail);
        const text = projected.detail >= 0.65 || memory.kind === 'identity' ? memory.content : memory.gist;
        const certainty: RecalledMemory['certainty'] = projected.detail >= 0.65 || memory.kind === 'identity' ? '清晰' : projected.detail >= 0.4 ? '大致记得' : '只剩模糊的印象';
        return { memory: projected, text, certainty, feeling: tint(memory.emotion * 2 ** (-Math.max(0, now - memory.createdAt) / (10 * 86400000))), score, relevance, forgotten };
      })
      .filter(hit => !hit.forgotten && (terms.size === 0 || hit.relevance > 0 || semanticOf(hit.memory.id) >= 0.35))
      .sort((a, b) => b.score - a.score || b.memory.createdAt - a.memory.createdAt)
      .slice(0, limit)
      .map(({ memory, text, certainty, feeling, score }) => ({ memory, text, certainty, feeling, score }));
  }
}
