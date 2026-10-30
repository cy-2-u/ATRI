/** 模型管线探针：用真实模型走完整对话管线（提示词组装→解析→投递），
 *  打印模型原始输出与实际投递的差异，用于更换渠道/模型后的实测。
 *  密钥与端点只从环境变量读（ATRI_LIVE_URL / ATRI_LIVE_KEY / ATRI_LIVE_MODEL），
 *  不进仓库。运行：npx tsx scripts/_live-probe.ts <要说的第几句>...（默认三句固定台词） */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/db/index.js';
import { HttpModel, type Completion } from '../src/llm.js';
import { Runtime, type Sticker } from '../src/core/index.js';

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
    sleepStart: 1,
    sleepEnd: 7,
    clinginess: 50,
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
const PEER = 'wechat:probe:user';
store.ensurePeer(PEER, 'wechat', '探针', '', true);

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
console.log('\n===== 落库状态 =====');
console.log(`心情：${JSON.stringify(store.mood(PEER))}`);
for (const m of store.memories(PEER))
  console.log(
    `记忆[${m.kind}]：${m.content.slice(0, 40)}（importance=${m.importance}${m.emotion ? ` emotion=${m.emotion}` : ''}）`,
  );
for (const l of store.openLoops(PEER, true))
  console.log(`开环：${l.content}（due=${new Date(l.due_at).toLocaleString('zh-CN')}）`);
await runtime.stop();
store.close();
