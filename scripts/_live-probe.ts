/** 临时探针：用真实模型走完整对话管线，诊断表情/格式/解析问题。
 *  密钥只从环境变量读（ATRI_LIVE_KEY / ATRI_LIVE_URL / ATRI_LIVE_MODEL），不进仓库。
 *  运行：npx tsx scripts/_live-probe.ts <要说的第几句>...（默认三句固定台词） */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/db/index.js';
import { HttpModel, type Completion } from '../src/llm.js';
import { Runtime, type Sticker } from '../src/core/index.js';

const url = process.env.ATRI_LIVE_URL ?? 'https://sub.vcnovb.cn/v1';
const key = process.env.ATRI_LIVE_KEY ?? '';
const modelName = process.env.ATRI_LIVE_MODEL ?? 'glm-5.3-flash';
if (!key) throw new Error('缺少 ATRI_LIVE_KEY');

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
  maxTokens: 800, // 省钱：聊天回复用不了多少
  timeoutMs: 90000,
  contextWindowTokens: 65536,
  inputBudgetTokens: 24000,
});

const store = new Store(join(mkdtempSync(join(tmpdir(), 'atri-live-')), 'atri.db'));
const delivered: { kind: string; text: string; slug?: string }[] = [];
const runtime = new Runtime({
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
  config: () => ({
    timeZone: 'Asia/Shanghai',
    diaryHour: 3,
    proactiveEnabled: false,
    quietStart: 23,
    quietEnd: 8,
    proactiveAfterHours: 6,
    debounceMs: 0,
    maxConcurrentPeers: 1,
    turnTimeoutMs: 120000,
    contextTokens: 24000,
  }),
  timeZone: () => 'Asia/Shanghai',
  contextTokens: () => 24000,
  turnTimeoutMs: () => 120000,
  transport: {
    send: async (_peer, part) => {
      delivered.push(
        part.type === 'text'
          ? { kind: 'text', text: part.text ?? '' }
          : { kind: 'sticker', text: '', slug: part.slug },
      );
    },
  },
  log: (m, d) => console.warn('[runtime]', m, d ?? ''),
});
const PEER = 'preview:probe';
store.ensurePeer(PEER, 'preview', '探针', '', true);

const lines = process.argv.slice(2);
const turns = lines.length
  ? lines
  : ['在吗？随便聊聊', '发个表情包看看嘛', '你就当我刚甩过来一个沙雕猫猫头吧'];

for (const [i, text] of turns.entries()) {
  console.log(`\n===== 第 ${i + 1} 轮 =====\n我：${text}`);
  rawDump = '';
  runtime.accept(PEER, `probe-${i}`, text);
  await runtime.drain(120000);
  console.log(`--- 模型原始输出（前 600 字） ---\n${rawDump.slice(0, 600)}`);
  console.log('--- 实际投递 ---');
  if (!delivered.length) console.log('（无——解析失败或被过滤）');
  for (const d of delivered)
    console.log(
      d.kind === 'sticker' ? `  [表情图片] slug=${d.slug}` : `  [文字] ${JSON.stringify(d.text)}`,
    );
  delivered.length = 0;
}
await runtime.stop();
store.close();
