/** 心搏探针：用真实模型直接走 agent.impulse 的完整提示词组装与 JSON 解析，
 *  验证探询在真渠道上的响应格式与判断质量。密钥与端点只从环境变量读
 *  （ATRI_LIVE_URL / ATRI_LIVE_KEY / ATRI_LIVE_MODEL），不进仓库。
 *  运行：npx tsx scripts/_live-impulse.ts */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, type Task } from '../src/db/index.js';
import { HttpModel, type Completion } from '../src/llm.js';
import { Agent, type Sticker } from '../src/core/index.js';

const url = process.env.ATRI_LIVE_URL ?? '';
const key = process.env.ATRI_LIVE_KEY ?? '';
const modelName = process.env.ATRI_LIVE_MODEL ?? '';
if (!url || !key || !modelName)
  throw new Error('需要环境变量 ATRI_LIVE_URL / ATRI_LIVE_KEY / ATRI_LIVE_MODEL');

const stickers: Sticker[] = JSON.parse(
  readFileSync(join(process.cwd(), 'assets', 'stickers', 'catalog.json'), 'utf8'),
);

let rawDump = '';
class LoggingModel extends HttpModel {
  async complete(...args: Parameters<typeof HttpModel.prototype.complete>): Promise<Completion> {
    const result = await super.complete(...args);
    rawDump = result.text;
    return result;
  }
}

const model = new LoggingModel({
  baseUrl: url,
  apiKey: key,
  model: modelName,
  format: 'openai',
  vision: false,
  maxTokens: 120, // 与生产探询一致：maxTokens 120、无工具
  timeoutMs: 90000,
  contextWindowTokens: 65536,
  inputBudgetTokens: 24000,
});

const store = new Store(join(mkdtempSync(join(tmpdir(), 'atri-impulse-')), 'atri.db'));
const agent = new Agent({
  store,
  model: () => model,
  prompt: (name) => readFileSync(join(process.cwd(), 'shared', 'prompts', `${name}.md`), 'utf8'),
  stickers: () => stickers,
  web: {
    search: async () => {
      throw new Error('探针不联网');
    },
    open: async (u) => ({ url: u, content: '', fetchedAt: '' }),
  },
  timeZone: () => 'Asia/Shanghai',
  contextTokens: () => 24000,
  turnTimeoutMs: () => 120000,
});
const PEER = 'preview:impulse-probe';
store.ensurePeer(PEER, 'preview', '探针', '', true);

const now = Date.now();

async function probe(label: string) {
  rawDump = '';
  const result = await agent.impulse(PEER, AbortSignal.timeout(90000));
  console.log(`\n===== ${label} =====`);
  console.log(`模型原始输出：${JSON.stringify(rawDump)}`);
  console.log(`解析结果：${JSON.stringify(result)}`);
}

// 场景一：八小时前聊过、无任何由头 → 期望安静（want=false）
store.ingest(PEER, 'probe-u1', '今天上班累死了，只想躺着', [], now - 8 * 3600000);
store.ingest(PEER, 'probe-a1', '那就早点睡，别硬撑啦', [], now - 8 * 3600000 + 60000, 'system');
await probe('场景一：8 小时前聊过，无由头');

// 场景二：同一语境 + 到期的约定 → 期望想（want=true 且 angle 有由头）
store.addOpenLoop(PEER, {
  content: '说好周末一起看那部新出的电影',
  dueAt: now - 3600000,
  dueText: '上周说过周末',
  sources: ['m:x'],
});
await probe('场景二：到期的约定');

// 场景三：空库新联系人（材料只有时间）→ 期望安静
const FRESH = 'preview:impulse-fresh';
store.ensurePeer(FRESH, 'preview', '新人', '', true);
rawDump = '';
const fresh = await agent.impulse(FRESH, AbortSignal.timeout(90000));
console.log(`\n===== 场景三：空库新联系人 =====`);
console.log(`模型原始输出：${JSON.stringify(rawDump)}`);
console.log(`解析结果：${JSON.stringify(fresh)}`);

console.log('\n===== 用量 =====');
for (const u of store.recentUsage()) console.log(JSON.stringify(u));
store.close();
