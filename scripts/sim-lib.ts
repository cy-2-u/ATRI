/** 模拟器公共骨架：模拟时钟 + 真实 Runtime/Store 装配 + 转写与检查工具。
 *
 *  对话内容由剧本（同时扮演 ATRI 与用户）决定，但心情、记忆六变量、
 *  巩固、日记、主动联系调度全部由生产代码计算——模拟验证的是机制随
 *  时间的涌现行为。独立进程运行：npx tsx scripts/simulate-month.ts */

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Store,
  hourFormatter,
  detailIntegrity,
  emotionalResidue,
  significance,
  traceOf,
  type Message,
} from '../src/db/index.js';
import { Runtime, type RuntimeConfig, type WebTools } from '../src/core/index.js';
import type { Completion, Model, ModelMessage } from '../src/llm.js';

export interface SimReplyContext {
  messages: ModelMessage[];
  system: string;
  /** 全部消息内容拼接（含提示词资料块）。 */
  all: string;
  /** 最后一条消息原文（带 [来源 …] 标注）。 */
  raw: string;
  /** 最后一条消息去掉来源标注。 */
  body: string;
  /** 最后一条消息的来源 id（无可解析时为空串）。 */
  lastId: string;
}
export interface SimSticker {
  slug: string;
  description: string;
  tags: string[];
  file: string;
}
export interface SimOptions {
  reply: (ctx: SimReplyContext) => unknown;
  start: string;
  onUserTurn?: () => void;
  stickers?: SimSticker[];
  images?: (message: Message, signal?: AbortSignal) => Promise<string[]>;
  web?: WebTools;
  config?: Partial<RuntimeConfig>;
  transcript?: string;
}

export function sourceIds(text: string): string[] {
  return [...text.matchAll(/\[来源 ([^\s|]+) \|/g)].map((m) => m[1]!);
}

export function startSim(opts: SimOptions) {
  const realNow = Date.now.bind(Date);
  const startTime = realNow();
  let simNow = Date.parse(opts.start);
  Date.now = () => simNow;

  const PEER = 'wechat:sim:user';
  const calls: { messages: ModelMessage[] }[] = [];
  const model: Model = {
    async complete(messages) {
      calls.push({ messages: structuredClone(messages) });
      const raw = messages.at(-1)?.content ?? '';
      const value = opts.reply({
        messages,
        system: messages[0]?.content ?? '',
        all: messages.map((m) => m.content).join('\n\n'),
        raw,
        body: raw.replace(/\[来源[^\]]*\]\s*/g, '').trim(),
        lastId: sourceIds(raw).at(-1) ?? '',
      }) as Record<string, unknown>;
      // 剧本可用 { simToolCalls: [...] } 发起一轮工具调用，走真实工具循环。
      const toolCalls = value.simToolCalls as
        { id: string; name: string; arguments: Record<string, unknown> }[] | undefined;
      if (toolCalls?.length) {
        const text = typeof value.text === 'string' ? value.text : '';
        const callsOut = toolCalls.map((c) => ({ id: c.id, name: c.name, arguments: c.arguments }));
        return {
          text,
          calls: callsOut,
          continuation: { role: 'assistant' as const, content: text, calls: callsOut },
          inputTokens: 20,
          outputTokens: 10,
          cachedTokens: 0,
        };
      }
      const text = JSON.stringify(value);
      const completion: Completion = {
        text,
        calls: [],
        continuation: { role: 'assistant' as const, content: text, calls: [] },
        inputTokens: 20,
        outputTokens: 10,
        cachedTokens: 0,
      };
      return completion;
    },
  };

  const store = new Store(join(mkdtempSync(join(tmpdir(), 'atri-sim-')), 'sim.db'));
  const delivered: { at: number; text: string; kind: string; slug?: string }[] = [];
  const web: WebTools =
    opts.web ??
    ({
      search: async () => {
        throw new Error('模拟不联网');
      },
      open: async () => {
        throw new Error('模拟不联网');
      },
    } as WebTools);
  const config: RuntimeConfig = {
    timeZone: 'Asia/Shanghai',
    diaryHour: 3,
    proactiveEnabled: true,
    quietStart: 0,
    quietEnd: 0,
    proactiveAfterHours: 6,
    debounceMs: 0,
    maxConcurrentPeers: 2,
    turnTimeoutMs: 5000,
    contextTokens: 24000,
    ...opts.config,
  };
  const runtime = new Runtime({
    store,
    model: () => model,
    prompt: (name) => readFileSync(join(process.cwd(), 'shared', 'prompts', `${name}.md`), 'utf8'),
    stickers: () => opts.stickers ?? [],
    web,
    ...(opts.images ? { images: opts.images } : {}),
    config: () => config,
    timeZone: () => config.timeZone,
    contextTokens: () => config.contextTokens,
    turnTimeoutMs: () => config.turnTimeoutMs,
    transport: {
      send: async (peer, part) => {
        if (part.type === 'text') {
          delivered.push({ at: simNow, text: part.text ?? '', kind: 'text' });
          say(`         ATRI（${stamp(simNow)}）：${(part.text ?? '').replace(/\n/g, ' / ')}`);
        } else {
          delivered.push({
            at: simNow,
            text: `[表情:${part.slug}]`,
            kind: 'sticker',
            slug: part.slug,
          });
          say(`         ATRI（${stamp(simNow)}）：[表情图片 ${part.slug}]`);
        }
        void peer;
      },
    },
    log: (message, details) => console.warn('  [runtime]', message, details ?? ''),
  });

  // ---------- 转写与检查 ----------

  const lines: string[] = [];
  const problems: string[] = [];
  const say = (line = '') => {
    lines.push(line);
    console.log(line);
  };
  const check = (ok: boolean, label: string) => {
    say(`    ${ok ? '✓' : '✗'} ${label}`);
    if (!ok) problems.push(label);
  };
  const stamp = (at: number) =>
    new Intl.DateTimeFormat('zh-CN', {
      timeZone: config.timeZone,
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      weekday: 'short',
    }).format(new Date(at));
  const moodLine = (): string => {
    const m = store.mood(PEER);
    const f = (v: number) => (v >= 0 ? `+${v.toFixed(2)}` : v.toFixed(2));
    const parts = [`愉悦${f(m.valence)}`, `精力${f(m.energy)}`, `耐心${f(m.patience ?? 0)}`];
    if (m.reason) parts.push(`（${m.reason}）`);
    return parts.join(' ');
  };
  const memoryTable = (): string[] =>
    store.memories(PEER).map((m) => {
      const state = traceOf(m);
      return `    [记忆] ${m.content.slice(0, 26)}  D=${detailIntegrity(state, simNow).toFixed(2)} S=${significance(state, simNow).toFixed(2)} E=${emotionalResidue(state, simNow).toFixed(2)} C=${state.consolidation.toFixed(2)} I=${state.interference.toFixed(2)}${m.pinned ? ' 置顶' : ''}`;
    });
  const snapshot = (title: string) => {
    say(`    ── ${title} ──`);
    say(`    [心情] ${moodLine()}`);
    for (const line of memoryTable()) say(line);
  };

  // ---------- 推进 ----------

  async function advanceTo(ts: number) {
    while (simNow < ts) {
      simNow = Math.min(simNow + 3600000, ts);
      runtime.schedule(simNow);
      await runtime.drain();
    }
  }
  /** 微推时间越过防抖窗口，回复才会真正产生。 */
  async function tick(ms = 1100) {
    simNow += ms;
    await runtime.drain();
  }
  /** 剧本时间：起始日第 N 天的 hh:mm。 */
  function T(days: number, hm: string): number {
    const datePart = opts.start.slice(0, 10);
    return (
      Date.parse(`${datePart}T00:00:00+08:00`) +
      days * 86400000 +
      (Date.parse(`2026-01-01T${hm}:00+08:00`) - Date.parse('2026-01-01T00:00:00+08:00'))
    );
  }
  function accept(key: string, text: string, media: { kind: string }[] = []) {
    store.ensurePeer(PEER, 'wechat', '同学', 'ctx', true, simNow);
    return runtime.accept(PEER, key, text, media as never, simNow);
  }
  async function userSay(
    days: number,
    hm: string,
    key: string,
    text: string,
    media: { kind: string }[] = [],
  ) {
    const at = T(days, hm);
    await advanceTo(at);
    say();
    say(`「${stamp(at)}」我：${text}`);
    opts.onUserTurn?.();
    accept(key, text, media);
    await tick(1100);
  }
  async function quietDays(label: string, days: number, hm: string) {
    await advanceTo(T(days, hm));
    // 越过主动消息的随机延迟窗口（0–20 分钟），让排定的问候真正发出来。
    await tick(21 * 60000);
    say();
    say(`「……${label}（至 ${stamp(simNow)}）」`);
  }
  function flushDelivered() {
    const items = [...delivered];
    delivered.length = 0;
    return { count: items.length, items };
  }
  function finish() {
    say();
    say(problems.length ? `✗ 未通过的检查：${problems.join('；')}` : '✓ 全部检查通过');
    const file = opts.transcript ?? 'simulation-month-transcript.md';
    writeFileSync(join(process.cwd(), file), lines.join('\n') + '\n', 'utf8');
    console.log(
      `\n完整记录已写入 ${file}（模拟结束于 ${stamp(simNow)}，墙钟耗时 ${((realNow() - startTime) / 1000).toFixed(1)}s）`,
    );
    if (problems.length) process.exitCode = 1;
  }

  return {
    store,
    runtime,
    calls,
    delivered,
    config,
    PEER,
    say,
    check,
    problems,
    stamp,
    moodLine,
    memoryTable,
    snapshot,
    advanceTo,
    T,
    accept,
    tick,
    userSay,
    quietDays,
    flushDelivered,
    finish,
    now: () => simNow,
    hour: () => Number(hourFormatter(config.timeZone).format(new Date(simNow))),
  };
}
