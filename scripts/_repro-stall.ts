import { Journal } from '../src/storage/journal.js';
import { Runtime } from '../src/runtime/runtime.js';
import { Mind } from '../src/domain/mind.js';
import { ModelRouter } from '../src/model/router.js';
import { httpTransport } from '../src/model/http.js';

/** 生产同款最小装配：真实 schema + 过期 beat job → runtime.start() →
 *  看 scan 是否 claim。复现"重启后她不认领排期"的哑死。 */

const journal = new Journal(':memory:');
journal.receive('peer-a', 'k1', '你好');
journal.schedule('peer-a', 'beat', Date.now() - 60_000); // 过期 beat job
journal.schedule('peer-a', 'diary', Date.now() - 30_000);

const settingsRoutes = () => ({
  primary: {
    format: 'openai' as const,
    baseUrl: 'http://127.0.0.1:9', // 立即连接失败（无关紧要：claim 在 think 前）
    apiKey: 'x',
    model: 'm',
    vision: false,
    timeoutMs: 5000,
    maxTokens: 100,
    inputTokens: 24000,
    retries: 0,
  },
});
const router = new ModelRouter(settingsRoutes, httpTransport);

const runtime = new Runtime(journal, new Mind(router, journal), {
  persona: () => 'test',
  material: () => ({}),
  send: async () => 'sent',
  nextBeat: () => Date.now() + 60_000,
  onError: (e) => console.log('[onError]', e instanceof Error ? e.message : e),
  timeoutMs: 5000,
  debounceMs: 0,
  concurrency: 3,
  pacing: false,
  stickerSlugs: () => new Set(),
  vision: () => false,
  readFile: async () => undefined,
});

console.log(
  'before start: jobs =',
  journal
    .jobs()
    .map((j) => `${j.kind}@${j.due_at}`)
    .join(','),
);
runtime.start();
console.log('started.');

setTimeout(() => {
  const db = journal.db;
  const turns = db
    .prepare('SELECT kind,state,created_at FROM kernel_turns ORDER BY created_at')
    .all();
  console.log('turns after 2s:', turns.map((t) => `${t.kind}/${t.state}`).join(', ') || '(none)');
  console.log(
    'jobs left:',
    journal
      .jobs()
      .map((j) => j.kind)
      .join(',') || '(none)',
  );
  journal.close();
  process.exit(0);
}, 2000);
