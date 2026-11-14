import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Journal } from '../src/storage/journal.js';
import { Mind } from '../src/domain/mind.js';
import { lifeTools, TOOL_SETS } from '../src/domain/tools.js';
import { LifeMaterial } from '../src/domain/material.js';
import { Runtime } from '../src/runtime/runtime.js';
import type { TimerClock } from '../src/runtime/wakeup.js';
import { Stickers } from '../src/stickers.js';
import { beatDelay } from '../src/domain/state.js';
import {
  dayKeyOf,
  inSleepMinutes,
  jitteredSleepWindow,
  minutesOfDay,
  nextWakeAfter,
} from '../src/domain/rhythm.js';
import type { Model, Message } from '../src/model/types.js';

/** 机制月度模拟：假时钟把 30 天压缩进几秒，验证节律、诚实材料、日记、
 *  念头、失败为零与气泡节奏的机制分布。不接真实模型——台词长短刻意
 *  不均，人味断言只针对机制能保证的部分。 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = mkdtempSync(join(root, 'sim-'));
mkdirSync(join(dataDir, 'sandbox'), { recursive: true });

// ---------- 假时钟：单点推进，定时器登记后手动到期 ----------
let now = Date.parse('2026-11-01T08:00:00+08:00');
const realDateNow = Date.now;
Date.now = () => now;
let timerSeq = 0;
const timers = new Map<number, { at: number; cb: () => void }>();
const clock: TimerClock = {
  now: () => now,
  set: (cb, delay: number) => {
    const id = ++timerSeq;
    timers.set(id, { at: now + Math.max(0, delay), cb });
    return id;
  },
  clear: (id: unknown) => void timers.delete(id as number),
};
const drain = async (): Promise<void> => {
  for (let i = 0; i < 80; i++) await new Promise(setImmediate);
};
async function fireDue(): Promise<void> {
  for (;;) {
    const due = [...timers.entries()]
      .filter(([, t]) => t.at <= now)
      .sort((a, b) => a[1].at - b[1].at);
    if (!due.length) return;
    for (const [id, timer] of due) {
      timers.delete(id);
      timer.cb();
      await drain();
    }
  }
}
async function advanceTo(at: number): Promise<void> {
  for (;;) {
    let next = Infinity;
    for (const timer of timers.values()) if (timer.at < next) next = timer.at;
    if (next === Infinity || next > at) break;
    now = Math.max(now, next);
    await fireDue();
  }
  now = Math.max(now, at);
  await drain();
  await fireDue();
}

// ---------- 世界 ----------
const journal = new Journal(join(dataDir, 'atri.db'), () => now);
const stickers = new Stickers(root, join(dataDir, 'custom'), journal);
const material = new LifeMaterial({
  journal,
  stickers,
  timeZone: () => 'Asia/Shanghai',
  sandboxEnabled: () => false,
  webConfigured: () => false,
  vision: () => false,
  now: () => now,
});
const PEER = 'wechat:sim:him';
journal.receive(PEER, 'seed', '（我们认识第 30 天了）', now - 1);
journal.schedule(PEER, 'beat', now);

const beatLines = [
  '在忙吗',
  '刚刚在想一件事',
  '今天路过看到一只很胖的猫，瞬间想起你瞪人的样子，我认真对比过的，不许反驳，瞪我干嘛，你看你看就是现在这个表情！',
  '嗯…没什么',
];
const chatLines = [
  '哦？',
  '我在哦，怎么了',
  '这个我记下了，下次别忘了我可要记账的',
  '嗯。',
  '那你今天早点休息，我看着钟等你来找我，超时不候。',
  '好',
];
let modelCalls = 0;
const diaryDone = new Set<string>();
let diaryFollowUp = false;
const said: { at: number; text: string }[] = [];
const model: Model = {
  async complete(messages: Message[]) {
    modelCalls++;
    const last = messages.at(-1)?.content ?? '{}';
    const { mode, material: current } = (() => {
      try {
        return JSON.parse(last) as {
          mode?: string;
          material?: { day?: unknown[]; pairs?: unknown[] };
        };
      } catch {
        return {} as { mode?: string; material?: { day?: unknown[]; pairs?: unknown[] } };
      }
    })();
    const text = (raw: string, extra = '') => ({
      message: {
        role: 'assistant' as const,
        content: `{"action":"speak","parts":[{"type":"text","text":"${raw}"}]${extra}` + '}',
      },
      usage: { input: 100, output: 40, cached: 0 },
    });
    // 日记工具的收尾轮：tool 回执之后安静收尾（夜里不说话）。
    if (diaryFollowUp && messages.at(-1)?.role === 'tool') {
      diaryFollowUp = false;
      return {
        message: { role: 'assistant', content: '{"action":"nothing"}' },
        usage: { input: 100, output: 5, cached: 0 },
      };
    }
    if (mode === 'diary') {
      const key = String((current?.day?.[0] as { id?: string } | undefined)?.id ?? 'day');
      if (!diaryDone.has(key)) {
        diaryDone.add(key);
        diaryFollowUp = true;
        return {
          message: {
            role: 'assistant',
            content: '',
            calls: [
              {
                id: 'd1',
                name: 'write_journal',
                arguments: {
                  sections: [
                    {
                      content: '今天也聊了些有的没的，他都快忘了香菜的事了，我还是记得。',
                      sources: [journal.conversation(PEER, 1)[0]?.id ?? 'seed'],
                      emotion: 0.2,
                    },
                  ],
                },
              },
            ],
          },
          usage: { input: 100, output: 60, cached: 0 },
        };
      }
      return {
        message: { role: 'assistant', content: '{"action":"nothing"}' },
        usage: { input: 100, output: 5, cached: 0 },
      };
    }
    if (mode === 'tidy')
      return {
        message: { role: 'assistant', content: '{"action":"nothing"}' },
        usage: { input: 100, output: 5, cached: 0 },
      };
    if (mode === 'chat') return text(chatLines[modelCalls % chatLines.length]);
    // 心跳：四分之一的拍开口，其余安静（读空气的机制留白）。
    if (modelCalls % 7 === 0)
      return {
        message: { role: 'assistant', content: '{"action":"muse","thought":"想提醒他喝水"}' },
        usage: { input: 100, output: 20, cached: 0 },
      };
    if (modelCalls % 11 === 0)
      return {
        message: {
          role: 'assistant',
          content: `{"action":"speak","parts":[{"type":"sticker","slug":"${stickers.list()[0]?.slug ?? 'x'}"}],"moodPulse":{"valence":0.3,"energy":0,"patience":0}}`,
        },
        usage: { input: 100, output: 30, cached: 0 },
      };
    if (modelCalls % 4 === 0)
      return text(
        beatLines[modelCalls % beatLines.length],
        ',"moodPulse":{"valence":0.1,"energy":0,"patience":0}',
      );
    return {
      message: { role: 'assistant', content: '{"action":"nothing"}' },
      usage: { input: 100, output: 5, cached: 0 },
    };
  },
};

const runtime = new Runtime(
  journal,
  new Mind(model, journal, lifeTools(journal, {}), '', () => 24000, TOOL_SETS),
  {
    persona: () => '你是亚托莉。',
    material: (turn) => material.build(turn.peer, turn).then((built) => built.material),
    send: (_peer, part) => {
      if (part.text) said.push({ at: now, text: part.text });
      return Promise.resolve('sent');
    },
    // 与生产完全同源的下一拍数学：人格节拍 + 睡眠窗推送。
    nextBeat: () =>
      nextWakeAfter(now + beatDelay(journal.self(), now, 50), 'Asia/Shanghai', 60, 420),
    onError: (error) =>
      console.error('sim runtime error:', error instanceof Error ? error.message : error),
    timeoutMs: 6 * 3600000,
    debounceMs: 0,
    concurrency: 2,
    pacing: true,
    stickerSlugs: () => new Set(stickers.list().map((item) => item.slug)),
    vision: () => false,
    readFile: () => Promise.resolve(undefined),
    clock,
  },
);

const transcript: string[] = [];
const push = (line: string) =>
  transcript.push(
    `[${new Date(now).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}] ${line}`,
  );

runtime.start();
await drain();
/** 宿主的夜间排期（与 index.ts 同一套幂等逻辑）：日记 3 点、整理 4 点。 */
function ensureNightJobs(): void {
  const localMidnight = (at: number) => {
    const guess = Date.parse(`${dayKeyOf(at, 'Asia/Shanghai')}T00:00:00Z`);
    return guess - minutesOfDay(guess, 'Asia/Shanghai') * 60000;
  };
  const nextHour = (hour: number) => {
    let candidate = localMidnight(now) + hour * 3_600_000;
    if (candidate <= now) candidate += 86_400_000;
    return candidate;
  };
  for (const kind of ['diary', 'tidy'] as const) {
    if (journal.jobs().some((job) => job.peer === PEER && job.kind === kind)) continue;
    if (journal.turnRunning(PEER, kind)) continue;
    journal.schedule(PEER, kind, nextHour(kind === 'diary' ? 3 : 4));
  }
}
let chatCount = 0;
for (let day = 0; day < 30; day++) {
  const dayStart = Date.parse(`2026-11-${String(day + 1).padStart(2, '0')}T08:00:00+08:00`);
  await advanceTo(dayStart);
  ensureNightJobs();
  for (const slot of [0, 4, 10]) {
    await advanceTo(dayStart + slot * 3600000 + 60000);
    const message = chatLines[chatCount % chatLines.length];
    journal.receive(PEER, `day${day}-${slot}`, message, now);
    push(`他：${message}`);
    chatCount++;
    await fireDue();
    await drain();
    ensureNightJobs();
  }
  await advanceTo(dayStart + 14 * 3600000);
  await fireDue();
}
await advanceTo(Date.parse('2026-12-01T08:00:00+08:00'));
await fireDue();

const events = journal.events(PEER);
const received = events.filter((e) => e.kind === 'received');
const diaries = events.filter((e) => e.kind === 'diary');
const muses = events.filter((e) => e.kind === 'muse');
const failures = events.filter((e) => e.kind === 'failure');

const byHour = new Map<number, number>();
const dayOf = (at: number) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date(at));
for (const s of said) {
  const h = Number(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Shanghai',
      hour: '2-digit',
      hourCycle: 'h23',
    }).format(new Date(s.at)),
  );
  byHour.set(h, (byHour.get(h) ?? 0) + 1);
}
// 深夜静：判定用抖动后的真实睡眠窗（1:00±45 入睡），不是死板的钟点。
const inSleepAt = (at: number): boolean => {
  const window = jitteredSleepWindow(dayKeyOf(at, 'Asia/Shanghai'), 60, 420);
  return inSleepMinutes(minutesOfDay(at, 'Asia/Shanghai'), window.startMin, window.endMin);
};
const deepNight = said.filter((s) => inSleepAt(s.at)).length;
for (const s of said.filter((s) => inSleepAt(s.at)))
  console.log(
    `[睡眠窗样本] ${new Date(s.at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })} → ${s.text.slice(0, 30)}`,
  );
const lens = said.map((s) => s.text.length);
const mean = lens.reduce((a, b) => a + b, 0) / Math.max(1, lens.length);
const stdev = Math.sqrt(lens.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, lens.length));
const dayCounts = new Map<string, number>();
for (const s of said) {
  const d = dayOf(s.at);
  dayCounts.set(d, (dayCounts.get(d) ?? 0) + 1);
}
// 最后一天只跑了半天：剔除后统计完整日。
const lastDay = [...dayCounts.keys()].sort().at(-1);
if (lastDay) dayCounts.delete(lastDay);
const perDay = [...dayCounts.values()];

const checks: [string, boolean][] = [
  ['他的消息全部入账', received.length >= 90],
  ['她既有回应也有主动消息', said.length > 30],
  ['深夜静（1–6 点无消息）', deepNight === 0],
  ['气泡长短有方差（σ > 4 字）', stdev > 4],
  [
    '每日条数有起伏（1–12 条）',
    perDay.length > 0 && Math.max(...perDay) <= 12 && Math.min(...perDay) >= 2,
  ],
  ['日记夜夜在写', diaries.length >= 25],
  ['有念头存着', muses.length >= 3],
  ['失败任务为零', failures.length === 0],
];

writeFileSync(
  join(root, 'simulation-month-transcript.md'),
  `# 机制月度模拟转写（new 内核）\n\n${transcript.join('\n')}\n`,
  'utf8',
);
console.log(
  `模拟 30 天完成：他 ${received.length} 条，她 ${said.length} 条，日记 ${diaries.length} 段，念头 ${muses.length}，失败 ${failures.length}，模型调用 ${modelCalls}`,
);
console.log(
  `深夜主动 ${deepNight} 条；气泡长度 σ=${stdev.toFixed(1)} 字；每日 ${Math.min(...perDay)}–${Math.max(...perDay)} 条`,
);
if (failures.length)
  console.log(
    '失败样本：',
    failures.slice(0, 3).map((f) => f.content.slice(0, 120)),
  );
let failed = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? '✔' : '✖'} ${name}`);
  if (!ok) failed++;
}
try {
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
} catch {
  /* 句柄释放滞后 */
}
Date.now = realDateNow;
process.exit(failed ? 1 : 0);
