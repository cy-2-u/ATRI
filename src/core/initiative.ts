import type { Initiative, Store } from '../db/store.js';
import type { Agent } from './agent.js';
import { parseJson } from './reply.js';

/** 想法评估：把"还没说出口的话"交给模型做一次决定——现在说、等条件、
 *  并入下次聊天、放下，还是安静。评估由想法事件驱动（新想法、新进展），
 *  每个想法版本只评一次；代码不按节拍反复掷币。

决策契约（模型只输出 JSON）：
- speak：此刻值得单独说 → 入队主动消息，meaning 作为由头带进生成。
- hold：确实想说，但要等具体条件（对方在忙、自己先做完某事）→ 想法
  转 waiting，不重复轮询；条件说明写进 origin，供下次评估参考。
- fold：不值得单独打扰，用户来聊时自然会带上 → 想法退场（并入回复
  由 chat 提示词的"必要认识"自然覆盖）。
- drop：重复、过时、没意思了 → 退场。
安静（rest）由模型不列出的想法隐式表达：没有决策的想法原样保留，
  等下一次真实事件再评，而不是立刻重问。 */

export interface ConsiderResult {
  enqueued: boolean;
}

export interface ConsiderOptions {
  store: Store;
  agent: Agent;
  peerId: string;
  initiatives: Initiative[];
  log?: (message: string, details?: unknown) => void;
}

const KIND_LABEL: Record<Initiative['kind'], string> = {
  share: '想分享',
  care: '想关心',
  ask: '想问起',
  muse: '想说一句',
};

/** 评估一批想法：一次模型调用裁决全部候选（省 token 也省延迟），
 *  speak 的想法逐条入队。返回是否入队了主动消息。 */
export async function considerInitiatives(options: ConsiderOptions): Promise<ConsiderResult> {
  const { store, agent, peerId, initiatives, log } = options;
  if (!initiatives.length) return { enqueued: false };
  const peer = store.peer(peerId);
  if (!peer) return { enqueued: false };
  const now = Date.now();
  const lines = initiatives.map(
    (idea, index) =>
      `${index + 1}. [${idea.id}] ${KIND_LABEL[idea.kind]}：${idea.meaning}` +
      (idea.state === 'waiting' && idea.origin ? `（上次在等：${idea.origin}）` : ''),
  );
  const system = [
    '你在决定要不要主动联系一个人。下面是你此刻还没说出口的想法，逐条决定怎么处理。' +
      '真人的冲动是稀疏的：大多数想法不需要单独发消息——有的会并进下次聊天，' +
      '有的放一放就淡了，安静是完全正常的结果。只有此刻确实值得单独开口的才说。',
    '逐条输出 JSON（不要代码围栏），decisions 数组与输入一一对应：',
    '{"decisions":[{"id":"想法id","action":"speak|hold|fold|drop","reason":"一句话"}]}',
    'action 含义：speak=现在单独说（消息生成时会拿到这条想法做由头）；' +
      'hold=想等一个具体条件（写清在等什么）；fold=不值得单独打扰，对方来聊时自然带出；' +
      'drop=已经过时/重复/没意思了。没有出现的想法视为"再放放"，保持原状。',
  ].join('\n');
  const material = `距对方上次说话已经有一段时间语境由系统另行提供；当前共有 ${initiatives.length} 条想法：\n${lines.join('\n')}`;
  let decisions: { id?: unknown; action?: unknown; reason?: unknown }[] = [];
  try {
    const signal = AbortSignal.timeout(600000);
    const completion = await agent.consider(system, material, peerId, signal);
    const raw = parseJson(completion.text);
    if (Array.isArray(raw?.decisions)) decisions = raw.decisions;
  } catch (error) {
    // 评估失败不是"她不想说"：想法原样保留，下个事件再评。
    log?.('想法评估失败，本轮跳过', {
      peer: peerId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { enqueued: false };
  }
  let enqueued = false;
  const byId = new Map(initiatives.map((i) => [i.id, i]));
  for (const decision of decisions) {
    if (!decision || typeof decision !== 'object') continue;
    const id = typeof decision.id === 'string' ? decision.id : '';
    const action = typeof decision.action === 'string' ? decision.action : '';
    const reason = typeof decision.reason === 'string' ? decision.reason.trim().slice(0, 120) : '';
    const idea = byId.get(id);
    if (!idea) continue;
    // 评估期间想法已被并发处理过（版本变了）就不再动它。
    const current = store.initiativeById(peerId, id);
    if (!current || current.version !== idea.version || current.state !== idea.state) continue;
    if (action === 'speak') {
      store.enqueue(
        peerId,
        'proactive',
        `idea:${idea.id}:${idea.version}`,
        {
          initiative: idea.id,
          angle: idea.meaning,
          reason,
        },
        now,
      );
      enqueued = true;
    } else if (action === 'hold') {
      store.holdInitiative(peerId, id, now);
      // 等待条件写进 origin：同一行更新，不新建想法。无理由也要留痕，
      // 否则 origin 为空会被调度器当作"从没评过"而反复重问。
      store.sql
        .prepare('UPDATE initiatives SET origin=? WHERE id=?')
        .run(reason || '在等一个时机', id);
    } else if (action === 'fold') {
      // fold 的想法保留在 idle：用户来聊时 chat 提示词仍能看到它，
      // 由模型自然带出；本轮不给它单独的机会。标记 origin 供调试。
      store.sql
        .prepare("UPDATE initiatives SET origin=? WHERE id=? AND state='idle'")
        .run(reason || '并入聊天', id);
    } else if (action === 'drop') {
      store.dropInitiative(peerId, id, now);
    }
  }
  // 没被点名的想法是"这轮先放放"：留下已评估的痕迹，调度器不再把
  // origin 为空的它们当作"从没评过"而反复重问；下一个真实事件
  // （新消息、新进展抬版本）仍会带来新一轮评估。
  const decidedIds = new Set(
    decisions.flatMap((d) =>
      d && typeof d === 'object' && typeof d.id === 'string' ? [d.id] : [],
    ),
  );
  for (const idea of initiatives) {
    if (decidedIds.has(idea.id)) continue;
    const current = store.initiativeById(peerId, idea.id);
    if (!current || current.version !== idea.version || current.state !== idea.state) continue;
    if (current.origin === '')
      store.sql.prepare("UPDATE initiatives SET origin='本轮评估：暂缓' WHERE id=?").run(idea.id);
  }
  return { enqueued };
}
