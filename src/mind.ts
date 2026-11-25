import { createHash } from 'node:crypto';
import type { Config } from './config.ts';
import { configured, imageEndpoint } from './config.ts';
import type { Store, Turn } from './store.ts';
import type { Thought, Part, CommitmentInput, MemoryInput, Message, ThoughtOp, DiaryInput } from './types.ts';
import { object, string, strings, axis, errorText } from './types.ts';
import { instant } from './state.ts';
import { Models, requestTokens } from './model.ts';
import { Context } from './context.ts';
import { JsonStreamParser } from './stream.ts';
import type { BubbleSink } from './runtime.ts';
import type { Tool } from './tools.ts';

const array = (value: unknown, name: string): unknown[] => { if (!Array.isArray(value)) throw new TypeError(`${name} 必须是数组`); return value; };
const optional = (value: unknown, name: string, max = 200): string | undefined => value === undefined ? undefined : string(value, name, max);
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(object(value)).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
};

/** 单个气泡元素的解析与结构校验（渐进轻校验与全量 parseThought 共用同一套规则）。 */
function parsePart(value: unknown): Part {
  const part = object(value);
  if (!['text', 'image', 'sticker', 'file', 'voice'].includes(String(part.type))) throw new TypeError('气泡类型无效');
  return { type: part.type as Part['type'], ...(part.type === 'text' ? { text: string(part.text, '气泡文字', 20000) } : part.type === 'sticker' ? { slug: string(part.slug, '表情 slug', 100) } : { path: string(part.path, '文件路径', 1000) }), ...(part.reply === undefined ? {} : { reply: string(part.reply, 'reply', 200) }), ...(part.notified === undefined ? {} : { notified: strings(part.notified) }) };
}

export function parseThought(raw: string): Thought {
  const value = object(JSON.parse(raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')));
  const parts: Part[] = array(value.parts ?? [], 'parts').map(parsePart);
  const memories: MemoryInput[] = array(value.memories ?? [], 'memories').map(v => {
    const m = object(v);
    if (!['fact', 'interpretation', 'identity'].includes(String(m.kind))) throw new TypeError('记忆类型无效');
    const importance = m.importance === undefined ? 0.5 : m.importance;
    if (typeof importance !== 'number' || !Number.isFinite(importance) || importance < 0 || importance > 1) throw new TypeError('记忆重要性无效');
    return { kind: m.kind as MemoryInput['kind'], content: string(m.content, '记忆', 3000), gist: string(m.gist, '记忆要旨', 300), slot: optional(m.slot, '事实槽', 100), sources: strings(m.sources), importance, emotion: axis(m.emotion), supersedes: m.supersedes === undefined ? [] : strings(m.supersedes) };
  });
  const commitments: CommitmentInput[] = array(value.commitments ?? [], 'commitments').map(v => {
    const m = object(v);
    if (!['keep', 'complete', 'cancel'].includes(String(m.op))) throw new TypeError('约定操作无效');
    if (m.kind !== undefined && !['reminder', 'concern', 'promise'].includes(String(m.kind))) throw new TypeError('约定类型无效');
    if (m.due !== undefined) instant(m.due);
    if (m.afterPart !== undefined && (!Number.isInteger(m.afterPart) || Number(m.afterPart) < 0 || Number(m.afterPart) >= parts.length)) throw new TypeError('承诺必须绑定存在的气泡');
    const recurrence = m.recurrence === undefined || m.recurrence === null ? undefined : object(m.recurrence);
    if (recurrence && (!['day', 'week', 'month', 'year'].includes(String(recurrence.unit)) || !Number.isInteger(recurrence.interval) || Number(recurrence.interval) < 1 || Number(recurrence.interval) > 100 || typeof recurrence.timezone !== 'string')) throw new TypeError('重复规则无效');
    if (recurrence) new Intl.DateTimeFormat('en', { timeZone: String(recurrence.timezone) });
    return { op: m.op as CommitmentInput['op'], id: optional(m.id, '约定 ID'), kind: m.kind as CommitmentInput['kind'], content: optional(m.content, '约定', 2000), due: m.due as string | number | undefined, recurrence: m.recurrence === null ? null : recurrence as unknown as CommitmentInput['recurrence'], sources: strings(m.sources), afterPart: m.afterPart as number | undefined };
  });
  const thoughts: ThoughtOp[] = array(value.thoughts ?? [], 'thoughts').map(v => {
    const m = object(v);
    if (!['keep', 'drop'].includes(String(m.op))) throw new TypeError('念头操作无效');
    if (m.due !== undefined) instant(m.due);
    return { op: m.op as ThoughtOp['op'], id: optional(m.id, '念头 ID'), topic: optional(m.topic, '念头主题', 100), meaning: optional(m.meaning, '念头含义', 1000), due: m.due as string | number | undefined, sources: strings(m.sources) };
  });
  let diary: DiaryInput | undefined;
  if (value.diary !== undefined) {
    const d = object(value.diary);
    diary = { content: string(d.content, '日记', 8000), emotion: axis(d.emotion), sources: strings(d.sources) };
  }
  let impressions: Thought['impressions'];
  if (value.impressions !== undefined) {
    const i = object(value.impressions);
    impressions = { beliefs: array(i.beliefs, 'impressions.beliefs').slice(0, 8).map(v => { const b = object(v); return { text: string(b.text, '认识', 300), basis: strings(b.basis, 16) }; }) };
    if (!impressions.beliefs.length) throw new TypeError('impressions.beliefs 不能为空');
  }
  const feeling = value.feeling === undefined ? undefined : object(value.feeling);
  const intents = array(value.intents ?? [], 'intents').map(v => {
    const i = object(v); instant(i.at);
    return { reason: string(i.reason, '未来意图', 1000), at: i.at as string | number, commitment: optional(i.commitment, '关联约定') };
  });
  return { parts, memories, commitments, thoughts, ...(diary ? { diary } : {}), ...(impressions ? { impressions } : {}), intents,
    ...(feeling ? { feeling: { label: string(feeling.label, '情绪词', 100), valence: axis(feeling.valence), arousal: axis(feeling.arousal), patience: axis(feeling.patience), reason: string(feeling.reason, '情绪原因', 1000), sources: strings(feeling.sources) } } : {}),
    ...(value.reflection !== undefined ? { reflection: string(value.reflection, '心事', 3000) } : {}),
    ...(value.activity !== undefined ? { activity: string(value.activity, 'activity', 1000) } : {}),
    ...(value.pursuit !== undefined ? { pursuit: string(value.pursuit, 'pursuit', 1000) } : {}),
    ...(value.interests !== undefined ? { interests: strings(value.interests, 20).map(v => string(v, '兴趣', 200)) } : {}),
  };
}

/** 纯读工具白名单：全部调用都落在这里时才并行执行（recall 带副作用不入列）。 */
const PARALLEL_OK = new Set(['history', 'fetch', 'search', 'files']);

export class Mind {
  private store: Store;
  private config: () => Config;
  private models: Pick<Models, 'complete'>;
  private context: Pick<Context, 'build'>;
  private tools: Map<string, Tool>;
  constructor(store: Store, config: () => Config, models: Pick<Models, 'complete'>, context: Pick<Context, 'build'>, tools: Tool[]) { this.store = store; this.config = config; this.models = models; this.context = context; this.tools = new Map(tools.map(t => [t.definition.name, t])); }

  private available(): Tool[] {
    const c = this.config();
    const img = imageEndpoint(c);
    return [...this.tools.values()]
      .filter(t => t.definition.name !== 'execute' || c.execution.enabled)
      .filter(t => t.definition.name !== 'draw' || c.image.enabled && !!(img.url && img.key && img.model))
      .filter(t => t.definition.name !== 'search' || c.web.enabled && !!c.web.key);
  }

  async think(turn: Turn, signal: AbortSignal, sink?: BubbleSink): Promise<Thought> {
    const available = this.available(), definitions = available.map(t => t.definition), allowedTools = new Set(definitions.map(t => t.name));
    const { messages, cacheKey } = await this.context.build(turn, available, signal);
    const isNight = turn.jobs.some(j => j.kind === 'night') && turn.jobs.every(j => j.kind === 'night');
    let steps = 0, repaired = false, finalize = false;
    // 渐进状态：气泡闭合即校验入队；修复/补账轮不再渐进（已发的气泡不重投）。
    // progressiveCount 是渐进生命周期的闭合总数（通过+丢弃），补账轮据此剪掉新增气泡。
    let progressiveCount = 0;
    let progressive: { parts: (Part | undefined)[]; dropped: Set<number>; droppedCount: number; sealed: boolean } | undefined;
    let dropped: Set<number> | undefined;
    let draftedIds: string[] = [];
    const slugs = new Set(this.store.get<{ slug: string }[]>('stickers', []).map(s => s.slug));
    let index = 0; // 模型 JSON 的 parts 下标计数（闭包共享）
    const captured: Record<number, CommitmentInput[]> = {};
    let parser: JsonStreamParser | undefined;
    // 围栏剥离状态：模型被要求不加代码围栏，但偶尔违规——剥掉再喂解析器，否则渐进全灭。
    let fed = false, prefixBuf = '';
    // 每轮重置：工具轮回滚、修复轮停渐进（repaired=true）
    const resetProgressive = (): void => {
      index = 0;
      for (const key of Object.keys(captured)) delete captured[Number(key)];
      fed = false; prefixBuf = '';
      if (sink && !repaired) progressive = { parts: [], dropped: new Set(), droppedCount: 0, sealed: false };
      else progressive = undefined;
      parser = progressive ? new JsonStreamParser({
        onPart: element => {
          if (!progressive || progressive.sealed) return;
          const i = index++;
          try {
            const part = parsePart(element);
            // 轻校验 = parts 全部终检项前移：reply/notified/sticker/长度。做到 parts 相关
            // 检查全部在此完成，记账期失败只可能来自记账字段——补账模式才逻辑自洽。
            if (part.reply && (!turn.allowed.has(part.reply) || !this.store.evidence(turn.peer, [part.reply]).some(e => e.kind === 'received'))) throw new TypeError('reply 必须引用看见的入站事件');
            if (part.notified?.some(id => !this.store.commitment(turn.peer, id))) throw new TypeError('提醒引用无效约定');
            if (part.type === 'sticker' && !slugs.has(part.slug ?? '')) throw new TypeError('表情不在目录中');
            const effects: Record<string, unknown> = {};
            if (part.notified) effects.notified = part.notified.map(id => { const c = this.store.commitment(turn.peer, id)!; return { id, version: c.version, due: c.dueAt }; });
            if (captured[i]?.length) effects.commitments = captured[i]!.map(e => ({ ...(e as CommitmentInput), pending: true }));
            draftedIds.push(sink!.draft(i, part, effects));
            progressive.parts[i] = part;
            progressiveCount++;
          } catch (error) {
            progressive!.dropped.add(i);
            progressive!.droppedCount++;
            progressiveCount++;
            this.store.append(turn.peer, 'failure', { text: `气泡未通过渐进校验，已丢弃：${errorText(error)}`, raw: JSON.stringify(element).slice(0, 500) }, turn.id);
            if (progressive!.droppedCount >= 2) progressive!.sealed = true; // 连续胡编：停止渐进，等全量修复
          }
        },
        onCommitment: element => {
          if (!progressive || progressive.sealed) return;
          const afterPart = (element as { afterPart?: unknown }).afterPart;
          if (Number.isInteger(afterPart) && Number(afterPart) >= 0) (captured[Number(afterPart)] ??= []).push(element as CommitmentInput);
        },
      }) : undefined;
    };
    const feed = (delta: string): void => {
      if (!parser) return;
      if (fed) { parser.write(delta); return; }
      prefixBuf += delta;
      const stripped = prefixBuf.replace(/^(?:\uFEFF)?\s*```(?:json)?[ \t]*\r?\n?/, '');
      if (stripped !== prefixBuf || (prefixBuf.trimStart() && !prefixBuf.trimStart().startsWith('`'))) {
        fed = true;
        parser.write(stripped);
      }
    };

    for (;;) {
      signal.throwIfAborted();
      resetProgressive();
      const completion = await this.models.complete(messages, definitions, { signal, purpose: turn.jobs.some(j => j.kind === 'chat') ? 'chat' : 'life', cacheKey, final: finalize, onDelta: feed });
      signal.throwIfAborted(); messages.push(completion.message);
      if (completion.message.calls?.length) {
        if (finalize) throw new Error('模型忽略了禁止继续调用工具的收尾要求');
        // 本轮不是最终轮：已渐进 draft 的气泡全部回滚（工具轮回滚成本为零）
        if (draftedIds.length) { this.store.cancelDrafts(draftedIds); draftedIds = []; }
        progressive = undefined; parser = undefined;
        const visuals: Message[] = [];
        // 全部调用都是纯读白名单时才并行（recall 带副作用不入列；混合场景退化为串行）。
        const calls = completion.message.calls;
        const readOnly = calls.every(c => {
          const tool = this.tools.get(c.name);
          const mutates = tool && (typeof tool.mutates === 'function' ? tool.mutates(c.args) : tool.mutates);
          return !!tool && !mutates && PARALLEL_OK.has(c.name);
        });
        const receipts: { call: typeof calls[number]; payload: string; visual?: string }[] = [];
        const executeOne = async (call: typeof calls[number]): Promise<{ payload: string; visual?: string }> => {
          signal.throwIfAborted();
          const tool = this.tools.get(call.name);
          const mutates = tool && (typeof tool.mutates === 'function' ? tool.mutates(call.args) : tool.mutates);
          const signature = createHash('sha256').update(`${call.name}:${canonical(call.args)}`).digest('hex');
          const id = mutates ? `${turn.episode}:${signature}` : `${turn.id}:${call.id}`;
          let result: unknown, succeeded = false, receipt: string | undefined, status = 'failed';
          if (!tool || !allowedTools.has(call.name)) result = { error: '工具不存在或尚未配置' };
          else if (steps >= this.config().life.maxToolSteps) result = { error: '本轮资源上限已到，未执行；需要继续请留下意图' };
          else {
            steps++;
            const previous = this.store.toolStart(id, turn.peer, turn.id, signature);
            if (previous) { result = previous.result ?? { error: '执行结果未知，不能自动重复副作用' }; status = previous.status; succeeded = status === 'ok'; }
            else {
              try { result = await tool.run(call.args, { turn, signal }); succeeded = !(result && typeof result === 'object' && 'ok' in result && (result as { ok: unknown }).ok === false); status = succeeded ? 'ok' : 'failed'; }
              catch (error) { status = mutates && (signal.aborted || call.name === 'draw') ? 'unknown' : 'failed'; result = { error: errorText(error), ...(status === 'unknown' ? { uncertain: true, note: '不能假定未产生副作用，禁止盲目重做' } : {}) }; }
              this.store.toolFinish(id, status, this.receiptResult(result));
            }
            const existing = this.store.eventByDedupe(`tool:${id}`, turn.peer);
            const event = existing ? undefined : this.store.append(turn.peer, 'action', { tool: call.name, args: call.args, mutates: !!mutates, succeeded, status, result: this.receiptResult(result) }, turn.id, `tool:${id}`);
            receipt = event?.id ?? (existing ? String(existing.id) : undefined);
            if (receipt) turn.allowed.add(receipt);
          }
          // 真实结果先落回执，取消不能抹掉已发生的副作用。
          signal.throwIfAborted();
          let visual: string | undefined;
          if (result && typeof result === 'object' && 'visual' in result) { visual = String((result as { visual: unknown }).visual); result = this.receiptResult(result); }
          let payload = JSON.stringify({ receipt, succeeded, status, result });
          if (payload.length > 16000) payload = JSON.stringify({ receipt, succeeded, status, truncated: true, result: payload.slice(0, 14000), note: '完整回执可用 history 核实，文件可分页读取' });
          return { payload, visual };
        };
        if (readOnly && calls.length > 1) {
          const settled = await Promise.allSettled(calls.map(executeOne));
          calls.forEach((call, i) => {
            const outcome = settled[i]!;
            receipts.push(outcome.status === 'fulfilled' ? { call, ...outcome.value } : { call, payload: JSON.stringify({ receipt: undefined, succeeded: false, status: 'failed', result: { error: errorText(outcome.reason) } }) });
          });
        } else {
          for (const call of calls) receipts.push({ call, ...(await executeOne(call)) });
        }
        for (const { call, payload, visual } of receipts) {
          messages.push({ role: 'tool', callId: call.id, content: payload });
          if (visual) visuals.push({ role: 'user', content: `工具打开的实际图片；来源回执 ${(JSON.parse(payload) as { receipt?: string }).receipt}`, images: [visual] });
        }
        messages.push(...visuals);
        const c = this.config(), endpoint = configured(c.primary) ? c.primary : c.fallback;
        if (steps >= c.life.maxToolSteps || requestTokens(messages, definitions) > endpoint.contextTokens - endpoint.outputTokens - 2048) {
          finalize = true;
          messages.push({ role: 'user', content: '本轮资源接近上限。给出完整最终 JSON；未完成任务保留为未完成，需要继续就留下 intents，不编造结果。' });
        }
        continue;
      }
      // 最终轮：渐进气泡已发出的，draftedIds 转正（不再回滚）
      try {
        const thought = parseThought(completion.message.content);
        if (repaired && progressiveCount) {
          // 修复/补账轮：模型改动 parts 数量 = 下标语义全变，回滚全部渐进走纯全量路径；
          // 数量一致则剪掉补账新增的气泡（已发气泡不可增），丢弃下标继续生效。
          if (thought.parts.length !== progressiveCount) {
            if (draftedIds.length) this.store.cancelDrafts(draftedIds);
            draftedIds = []; dropped = undefined;
          } else {
            thought.parts = thought.parts.slice(0, progressiveCount);
            if (dropped?.size) thought.dropped = [...dropped];
          }
        } else if (progressive?.dropped.size) {
          thought.dropped = [...progressive.dropped];
        }
        this.validate(turn, thought, isNight);
        return thought;
      } catch (error) {
        if (repaired) throw error;
        repaired = true; finalize = true;
        dropped = progressive?.dropped;
        messages.push({ role: 'user', content: progressiveCount
          ? `输出校验失败：${errorText(error)}。你的气泡已（部分）发出：parts 原样保留（数量与内容都不变），只修复记账字段的结构或不成立的来源，不新造经历，不调用工具。返回最终 JSON。`
          : `输出校验失败：${errorText(error)}。只修复结构或不成立的来源，不新造经历，不调用工具。返回最终 JSON。` });
      }
    }
  }

  private receiptResult(result: unknown): unknown {
    if (result && typeof result === 'object' && 'visual' in result) { const { visual: _visual, ...rest } = object(result); return rest; }
    return result;
  }

  validate(turn: Turn, thought: Thought, night: boolean): void {
    const evidence = (ids: string[]): ReturnType<Store['evidence']> => {
      if (!ids.length || ids.some(id => !turn.allowed.has(id))) throw new TypeError('来源必须是本轮看见的真实事件 ID');
      const events = this.store.evidence(turn.peer, ids);
      if (events.length !== new Set(ids).size) throw new TypeError('来源不属于当前对话');
      return events;
    };
    if (night && thought.parts.length) throw new TypeError('夜间整理不发消息：parts 必须为空');
    const active = this.store.memories(turn.peer);
    for (const m of thought.memories) {
      const events = evidence(m.sources);
      if (m.kind === 'fact' && !events.some(e => e.kind === 'received')) throw new TypeError('事实记忆需要对方明确输入');
      if (m.kind === 'identity' && new Set(m.sources).size < 2) throw new TypeError('长期自我认识需要两处私聊真实经历');
      if (m.supersedes?.some(id => !active.some(old => old.id === id && old.peer === turn.peer))) throw new TypeError('修订目标不属于当前会话');
    }
    for (const c of thought.commitments) {
      const events = evidence(c.sources), old = c.id ? this.store.commitment(turn.peer, c.id) : undefined;
      if (c.id && !old || c.op !== 'keep' && !old) throw new TypeError('约定不存在');
      if (c.op === 'keep' && !c.id && (!c.content || !c.kind)) throw new TypeError('新约定需要内容和类型');
      if (c.recurrence && !(c.due ?? old?.dueAt)) throw new TypeError('重复约定需要起始时间');
      if (c.op === 'complete' && !events.some(e => e.kind === 'received' || e.kind === 'action' && e.data.succeeded === true && e.data.mutates === true)) throw new TypeError('履约需要对方反馈或成功行动，读记录不等于履约');
      if (c.op === 'keep' && (c.kind ?? old?.kind) === 'promise' && c.afterPart === undefined && !events.some(e => e.kind === 'accepted')) throw new TypeError('新答应的承诺必须绑定承诺气泡');
    }
    for (const t of thought.thoughts ?? []) {
      if (t.op === 'drop') {
        const target = t.id ? this.store.thoughts(turn.peer).find(x => x.id === t.id) : undefined;
        if (t.id && !target) throw new TypeError('要放下的念头不存在');
        continue;
      }
      const events = evidence(t.sources);
      if (!t.topic || !t.meaning) throw new TypeError('新念头需要主题与含义');
      if (!events.some(e => ['received', 'accepted', 'action', 'diary'].includes(e.kind))) throw new TypeError('念头必须来自真实经历');
    }
    if (thought.diary) {
      if (!night) throw new TypeError('日记只在夜间整理拍写');
      evidence(thought.diary.sources);
    }
    if (thought.impressions) {
      if (!night) throw new TypeError('对他人的整批认识只在夜间整理拍修订');
      for (const belief of thought.impressions.beliefs) {
        if (!belief.basis.length) throw new TypeError('每条认识都要有真实依据');
        const memoryIds = new Set(this.store.memories(turn.peer).map(m => m.id));
        for (const id of belief.basis) {
          if (memoryIds.has(id)) continue;
          evidence([id]);
        }
      }
    }
    if (thought.feeling) evidence(thought.feeling.sources);
    for (const part of thought.parts) {
      if (part.reply && (!turn.allowed.has(part.reply) || !this.store.evidence(turn.peer, [part.reply]).some(e => e.kind === 'received'))) throw new TypeError('reply 必须引用看见的入站事件');
      if (part.notified?.some(id => !this.store.commitment(turn.peer, id))) throw new TypeError('提醒引用无效约定');
    }
    for (const intent of thought.intents) {
      if (instant(intent.at) <= this.store.now()) throw new TypeError('未来意图必须在未来，不能制造过去时间循环');
      if (intent.commitment && !this.store.commitment(turn.peer, intent.commitment)) throw new TypeError('未来意图引用无效约定');
    }
  }
}
