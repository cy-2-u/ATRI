import { createHash, randomUUID } from 'node:crypto';
import { Journal } from '../storage/journal.js';
import { projectMemory, rehearseMemory, type MemoryStrength } from './state.js';
import { cosine } from './embeddings.js';

export interface Memory extends MemoryStrength {
  id: string;
  content: string;
  gist: string;
  /** identity 是作者层的自我叙事：定义"我是谁"的长期认识。不随时间
   *  衰减，只被新证据修订（supersede）；夜里整理时少而精地写。 */
  kind: 'stated' | 'interpretation' | 'identity';
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
  /** 期待中的事带一个未来时刻：材料里呈现倒计时，靠近时自然想提。 */
  dueAt?: number;
  state: 'idle' | 'expressed' | 'dropped';
  createdAt: number;
  updatedAt: number;
}

/** 她对"他"的心智模型：一小束当前信念，整批修订、整体带最后核实时间。 */
export interface PeerBelief {
  text: string;
  basis: string[];
}
export interface PeerModel {
  beliefs: PeerBelief[];
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
      !['stated', 'interpretation', 'identity'].includes(input.kind) ||
      !finite(input.importance, 0, 1) ||
      !finite(input.emotion, -1, 1)
    )
      throw new TypeError('记忆属性无效');
    // 校验松绑（用户裁决 2026-11-26：她乐意说个假的就让她说，不拦）：来源白名单、
    // 对方陈述门槛、identity 两来源、supersedes 存在性检查全部摘除——语义违规照单
    // 全收，坏引用在下游静默跳过（saveMemory 的 replace 过滤），不炸整轮。
    // 只留格式防崩：内容/要旨非空、枚举与数值域。
    const sources = [...new Set(input.sources)];
    const existing = this.journal
      .memories(peer)
      .find(
        (memory) =>
          memory.status === 'active' &&
          memory.content === input.content.trim() &&
          memory.kind === input.kind,
      );
    const supersedes = [...new Set(input.supersedes ?? [])];
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
      .filter((memory) => memory.status === 'active' && memory.kind !== 'identity')
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
      if (
        allowed.has(memory.id) &&
        memory.status === 'active' &&
        // identity 不衰减也就不巩固：它是被修订的，不是被复述的。
        memory.kind !== 'identity'
      )
        this.journal.saveMemory(peer, { ...memory, ...rehearseMemory(memory, this.now()) });
  }

  /** 翻日记：日记是她写下的情绪档案，理应能被想起。日记没有演练跟踪
   *  （纯衰减），情绪浓的淡得慢；detail 低的只剩一段模糊印象。 */
  diaryRecall(
    peer: string,
    query: string,
    limit = 3,
  ): { id: string; text: string; at: number; emotion: number; detail: number }[] {
    const terms = grams(query);
    if (!terms.size) return [];
    const now = this.now();
    return this.journal
      .recentEvents(peer, ['diary'], 120)
      .map((row) => {
        let content = row.content,
          emotion = 0;
        try {
          const parsed = JSON.parse(row.content) as { content?: string; emotion?: number };
          content = parsed?.content ?? row.content;
          emotion = Number.isFinite(parsed?.emotion) ? Number(parsed.emotion) : 0;
        } catch {
          /* 旧格式纯文本 */
        }
        // 与记忆同一套衰减数学：日记没有演练，consolidation 恒 0。
        const projected = projectMemory(
          {
            detail: 0.9,
            importance: 0.45,
            emotion,
            consolidation: 0,
            interference: 0.1,
            createdAt: row.created_at,
            evaluatedAt: row.created_at,
            lastRehearsedAt: 0,
          },
          now,
        );
        const words = grams(content);
        let overlap = 0;
        for (const word of terms) if (words.has(word)) overlap++;
        const relevance = overlap / Math.sqrt(terms.size * Math.max(1, words.size));
        return {
          id: row.id,
          text: content,
          at: row.created_at,
          emotion,
          detail: projected.detail,
          relevance,
        };
      })
      .filter((hit) => hit.relevance > 0 && hit.detail > 0.35)
      .sort((a, b) => b.relevance - a.relevance || b.at - a.at)
      .slice(0, Math.max(0, Math.min(10, Math.floor(limit))));
  }

  consider(
    peer: string,
    topic: string,
    meaning: string,
    sourceIds: string[],
    dueAt?: number,
  ): ThoughtEntry {
    if (!topic.trim() || topic.length > 100 || !meaning.trim() || meaning.length > 1000)
      throw new TypeError('念头主题和含义无效');
    if (dueAt !== undefined && (!Number.isFinite(dueAt) || dueAt <= this.now()))
      throw new TypeError('期待的时间必须是未来时刻');
    // 校验松绑（用户裁决 2026-11-26）：来源存在性/白名单门槛摘除——
    // 语义违规照单全收，不炸整轮；只留格式防崩与未来时刻约束。
    const sources = [...new Set(sourceIds)].sort();
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
      ...(dueAt !== undefined ? { dueAt } : previous?.dueAt ? { dueAt: previous.dueAt } : {}),
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
