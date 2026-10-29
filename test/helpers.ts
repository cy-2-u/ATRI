import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, sep } from 'node:path';
import type { TestContext } from 'node:test';
import { Store, type Peer, type ReplyPart } from '../src/db/index.js';
import { Runtime, type RuntimeConfig, type Sticker } from '../src/core/index.js';
import type { Model, Completion, ModelMessage, ToolDefinition, ToolCall } from '../src/llm.js';

/** 共享夹具：临时目录、FakeModel、Runtime 装配、提示词全文断言工具。
 *  用 fixture(t) 建 Runtime/Store 测试；涉及时间显式传 timeZone。
 *  运行目录约定为仓库根（test/run.mjs 以其为 cwd 启动测试）。 */

export const projectRoot = process.cwd();

const cleanups = new WeakMap<TestContext, (() => void | Promise<void>)[]>();
export function cleanup(t: TestContext, fn: () => void | Promise<void>) {
  let list = cleanups.get(t);
  if (!list) {
    list = [];
    cleanups.set(t, list);
    t.after(async () => {
      for (const close of [...list!].reverse()) await close();
    });
  }
  list.push(fn);
}
export function temporary(t: TestContext) {
  const path = mkdtempSync(join(tmpdir(), 'atri-test-'));
  cleanup(t, () => {
    const absolute = resolve(path),
      root = resolve(tmpdir());
    if (!absolute.startsWith(root + sep + 'atri-test-')) throw new Error('测试清理路径无效');
    // Windows 上句柄刚关的一瞬间 rm 可能 EPERM（杀软扫描），重试后仍失败
    // 就留给系统临时目录清理——测试目录的垃圾无伤大雅。
    try {
      rmSync(absolute, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    } catch {
      /* 尽力而为 */
    }
  });
  return path;
}
export function completion(body: unknown, calls: ToolCall[] = []): Completion {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    text,
    calls,
    continuation: { role: 'assistant', content: text, calls },
    inputTokens: 20,
    outputTokens: 10,
    cachedTokens: 0,
  };
}
export class FakeModel implements Model {
  calls: { messages: ModelMessage[]; tools: ToolDefinition[] }[] = [];
  constructor(
    public handle: (
      messages: ModelMessage[],
      tools: ToolDefinition[],
      signal?: AbortSignal,
    ) => Promise<Completion> | Completion = () =>
      completion({ messages: ['听见啦。'], memoryUpdates: [] }),
  ) {}
  async complete(
    messages: ModelMessage[],
    tools: ToolDefinition[] = [],
    options: { signal?: AbortSignal } = {},
  ) {
    this.calls.push({ messages: structuredClone(messages), tools: structuredClone(tools) });
    return this.handle(messages, tools, options.signal);
  }
}

const fixtureStickers: Sticker[] = [
  { slug: 'happy', description: '开心', tags: ['开心'], file: 'happy.png' },
  { slug: 'cheer', description: '加油', tags: ['加油'], file: 'cheer.png' },
  { slug: 'hug', description: '抱抱', tags: ['抱抱'], file: 'hug.png' },
];

export function fixture(
  t: TestContext,
  model = new FakeModel(),
  patch: Partial<RuntimeConfig> = {},
) {
  const directory = temporary(t),
    store = new Store(join(directory, 'atri.db'));
  const root = projectRoot;
  const delivered: { peer: Peer; part: ReplyPart; id: string }[] = [];
  const config: RuntimeConfig = {
    timeZone: 'Asia/Shanghai',
    diaryHour: 3,
    proactiveEnabled: false,
    quietStart: 23,
    quietEnd: 8,
    debounceMs: 0,
    maxConcurrentPeers: 2,
    turnTimeoutMs: 5000,
    contextTokens: 24000,
    ...patch,
  };
  const runtime = new Runtime({
    store,
    model: () => model,
    prompt: (name) => readFileSync(join(root, 'shared', 'prompts', `${name}.md`), 'utf8'),
    stickers: () => fixtureStickers,
    web: {
      search: async () => [
        {
          title: '天气',
          snippet: '今天晴天',
          url: 'https://example.com/weather',
          fetchedAt: '2026-09-13T00:00:00Z',
          publishedAt: null,
        },
      ],
      open: async (url) => ({ url, content: '原文', fetchedAt: new Date().toISOString() }),
    },
    config: () => config,
    timeZone: () => config.timeZone,
    contextTokens: () => config.contextTokens,
    turnTimeoutMs: () => config.turnTimeoutMs,
    transport: {
      send: async (peer, part, id) => {
        delivered.push({ peer, part, id });
      },
    },
  });
  cleanup(t, async () => {
    await runtime.stop();
    store.close();
  });
  store.ensurePeer('p1', 'preview', '同学', '', true);
  return { directory, store, model, runtime, delivered, config };
}

/** 模型看到的全部文本（系统提示 + 资料 + 历史）：资料块搬到历史后的
 *  独立 user 消息里，断言事实到达模型要看全量而不是 messages[0]。 */
export function promptText(messages: ModelMessage[]): string {
  return messages.map((m) => m.content).join('\n\n');
}
