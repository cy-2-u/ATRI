import { createHash, randomUUID } from 'node:crypto';
import { Journal } from '../storage/journal.js';
import { projectMemory, rehearseMemory, type MemoryStrength } from './state.js';
import { cosine } from './embeddings.js';

export interface Memory extends MemoryStrength {
  id: string;
  content: string;
  gist: string;
  kind: 'stated' | 'interpretation';
  sources: string[];
  status: 'active' | 'superseded' | 'forgotten';
  pinned: boolean;
}

export interface MemoryInput {
  content: string;
  gist: string;
  kind: Memory['kind'];
  sources: string[];
  importance: number;
  emotion: number;
  supersedes?: string[];
}

export interface ThoughtEntry {
  id: string;
  topic: string;
  meaning: string;
  sources: string[];
  evidence: string;
  state: 'idle' | 'expressed' | 'dropped';
  createdAt: number;
  updatedAt: number;
}

const finite = (value: number, min: number, max: number): boolean =>
  Number.isFinite(value) && value >= min && value <= max;

// 存储接口与 SQL 布局分离；来源约束由数据库一次性校验。
export class Recollection {
  constructor(
    private readonly journal: Journal,
    private readonly now: () => number = Date.now,
  ) {}

  remember(peer: string, input: MemoryInput): Memory {
    if (
      !input.content.trim() ||
      input.content.length > 2000 ||
      !input.gist.trim() ||
      input.gist.length > 120
    )
      throw new TypeError('记忆必须有内容和简短要旨');
    if (
      !['stated', 'interpretation'].includes(input.kind) ||
      !finite(input.importance, 0, 1) ||
      !finite(input.emotion, -1, 1)
    )
      throw new TypeError('记忆属性无效');
    const sources = [...new Set(input.sources)];
    const evidence = this.journal.evidence(peer, sources);
    if (!sources.length || evidence.length !== sources.length)
      throw new TypeError('记忆来源不存在或不属于当前联系人');
    if (evidence.some((event) => !['received', 'said', 'experienced'].includes(event.kind)))
      throw new TypeError('记忆只能来自确实发生的经历');
    if (input.kind === 'stated' && !evidence.some((event) => event.kind === 'received'))
      throw new TypeError('对方陈述必须有对方消息作为来源');
    const existing = this.journal
      .memories(peer)
      .find(
        (memory) =>
          memory.status === 'active' &&
          memory.content === input.content.trim() &&
          memory.kind === input.kind,
      );
    const supersedes = [...new Set(input.supersedes ?? [])];
    const all = this.journal.memories(peer);
    if (
      supersedes.some(
        (id) =>
          !all.some(
            (memory) =>
              memory.id === id && memory.status === 'active' && memory.id !== existing?.id,
          ),
      )
    )
      throw new TypeError('替代目标不是有效旧记忆');
    const now = this.now();
    const memory: Memory = existing
      ? {
          ...existing,
          ...projectMemory(existing, now),
          sources: [...new Set([...existing.sources, ...sources])],
        }
      : {
          id: randomUUID(),
          content: input.content.trim(),
          gist: input.gist.trim(),
          kind: input.kind,
          sources,
          status: 'active',
          pinned: false,
          detail: 1,
          importance: input.importance,
          emotion: input.emotion,
          consolidation: 0,
          interference: 0,
          createdAt: now,
          evaluatedAt: now,
          lastRehearsedAt: 0,
        };
    this.journal.saveMemory(peer, memory, supersedes);
    return memory;
  }

  recall(
    peer: string,
    query: string,
    limit = 8,
    semantic?: { model: string; vector: Float32Array },
  ): { memory: Memory; text: string; score: number }[] {
    const terms = grams(query);
    const now = this.now();
    const vectors = semantic
      ? this.journal.embeddingsOf(
          this.journal.memories(peer).map((m) => m.id),
          semantic.model,
        )
      : undefined;
    return this.journal
      .memories(peer)
      .filter((memory) => memory.status === 'active')
      .map((memory) => {
        const projected = { ...memory, ...projectMemory(memory, now) };
        const forgotten = projected.detail < 0.35 && projected.importance < 0.2 && !memory.pinned;
        const words = grams(memory.content);
        let overlap = 0;
        for (const word of terms) if (words.has(word)) overlap++;
        const relevance = terms.size
          ? overlap / Math.sqrt(terms.size * Math.max(1, words.size))
          : 0;
        const embedding = vectors?.get(memory.id);
        const semanticScore = semantic && embedding ? cosine(semantic.vector, embedding) : 0;
        const score =
          relevance * 4 +
          semanticScore * 4 +
          projected.importance * (0.35 + 0.65 * projected.detail) +
          (memory.pinned ? 0.5 : 0);
        const text = projected.detail >= 0.75 ? memory.content : memory.gist;
        return { memory: projected, text, score, forgotten, relevance, semanticScore };
      })
      .filter(
        (hit) =>
          !hit.forgotten &&
          (!terms.size || hit.relevance > 0 || hit.semanticScore >= 0.35 || hit.memory.pinned),
      )
      .sort((a, b) => b.score - a.score || b.memory.createdAt - a.memory.createdAt)
      .slice(0, Math.max(0, Math.min(30, Math.floor(limit))))
      .map(({ memory, text, score }) => ({ memory, text, score }));
  }

  rehearse(peer: string, ids: string[]): void {
    const allowed = new Set(ids);
    for (const memory of this.journal.memories(peer))
      if (allowed.has(memory.id) && memory.status === 'active')
        this.journal.saveMemory(peer, { ...memory, ...rehearseMemory(memory, this.now()) });
  }

  consider(peer: string, topic: string, meaning: string, sourceIds: string[]): ThoughtEntry {
    if (!topic.trim() || topic.length > 100 || !meaning.trim() || meaning.length > 1000)
      throw new TypeError('念头主题和含义无效');
    const sources = [...new Set(sourceIds)].sort();
    const events = this.journal.evidence(peer, sources);
    if (
      !sources.length ||
      events.length !== sources.length ||
      events.some((event) => !['received', 'said', 'experienced'].includes(event.kind))
    )
      throw new TypeError('念头缺少真实依据');
    const evidence = createHash('sha256').update(JSON.stringify(sources)).digest('hex');
    const previous = this.journal.thoughts(peer).find((thought) => thought.topic === topic.trim());
    if (previous?.evidence === evidence) return previous;
    const now = this.now();
    const thought: ThoughtEntry = {
      id: previous?.id ?? randomUUID(),
      topic: topic.trim(),
      meaning: meaning.trim(),
      sources,
      evidence,
      state: 'idle',
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    };
    this.journal.saveThought(peer, thought);
    return thought;
  }
}

/** 字符二元组集合：词面召回与夜间整理配对共用。 */
export function grams(text: string): Set<string> {
  const words = text.toLowerCase().match(/[a-z0-9]+|[\p{Script=Han}]+/gu) ?? [];
  const output = new Set<string>();
  for (const word of words) {
    if (/^[a-z0-9]+$/.test(word) || word.length < 2) output.add(word);
    else for (let i = 0; i + 1 < word.length; i++) output.add(word.slice(i, i + 2));
  }
  return output;
}
