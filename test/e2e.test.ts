import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { Journal } from '../src/storage/journal.js';
import { Mind } from '../src/domain/mind.js';
import { Runtime } from '../src/runtime/runtime.js';
import { lifeTools } from '../src/domain/tools.js';

const until = async (fn: () => boolean, ms = 15000, what = '条件'): Promise<void> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.fail(`${what}超时`);
};

test('端到端：入站 → 思考 → 伪造来源直接放行 → 落账 → 投递 → 心跳续拍', async () => {
  // 假 LLM（OpenAI 兼容）：第一拍正常回复；第二拍伪造 effects 引用 + 超界
  // 情绪轴——校验退役（用户裁决 2026-11-26）：语义违规照单全收，照说不误。
  let calls = 0;
  const usageRows: { input: number; output: number }[] = [];
  const llm: Server = createServer((_req, res) => {
    calls++;
    const reply = (content: string) => {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          id: `c${calls}`,
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 120, completion_tokens: 20 },
        }),
      );
    };
    reply(
      calls === 1
        ? JSON.stringify({ action: 'speak', parts: [{ type: 'text', text: '在的，怎么了？' }] })
        : JSON.stringify({
            action: 'speak',
            parts: [{ type: 'text', text: '好' }],
            moodPulse: { valence: 5, energy: 'x', patience: 0.2 },
            effects: { expressed: ['ghost-thought'], asked: ['ghost-commitment'] },
          }),
    );
  });
  await new Promise<void>((r) => llm.listen(0, '127.0.0.1', r));
  const port = (llm.address() as { port: number }).port;
  const journal = new Journal(':memory:');
  let runtime: Runtime | undefined;
  const errors: string[] = [];
  try {
    const mind = new Mind(
      {
        // 最小 Model 桩：请求转投假 LLM，逐字段回放响应与用量。
        async complete(messages, _tools, options) {
          const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ messages, model: 'fake' }),
            signal: options.signal,
          });
          const data = (await res.json()) as {
            choices: { message: { content: string } }[];
            usage: { prompt_tokens: number; completion_tokens: number };
          };
          usageRows.push({ input: data.usage.prompt_tokens, output: data.usage.completion_tokens });
          return {
            message: { role: 'assistant' as const, content: data.choices[0]!.message.content },
            usage: {
              input: data.usage.prompt_tokens,
              output: data.usage.completion_tokens,
              cached: 0,
            },
          };
        },
      },
      journal,
      lifeTools(journal, {}),
      '',
      () => 24_000,
    );
    const sent: { peer: string; text: string }[] = [];
    runtime = new Runtime(journal, mind, {
      persona: () => '测试人格',
      material: () => Promise.resolve({ now: Date.now() }),
      send: (peer, part) => {
        sent.push({ peer, text: part.type === 'text' ? (part.text ?? '') : `[${part.type}]` });
        return Promise.resolve('sent' as const);
      },
      nextBeat: () => Date.now() + 60_000,
      onComposing: () => Promise.resolve(),
      onError: (error) => errors.push(error instanceof Error ? error.message : String(error)),
      debounceMs: 10,
      timeoutMs: 20_000,
      concurrency: 2,
      pacing: false,
      stickerSlugs: () => new Set(['cat001']),
      vision: () => false,
      readFile: () => Promise.resolve(undefined),
    });
    runtime.start();
    // 一条入站消息 → 她思考 → 气泡投递。
    assert.ok(runtime.receive('c2c:friend', 'm1', '在吗'));
    await until(() => sent.length >= 1, 15000, '第一条回复投递');
    assert.equal(calls, 1);
    assert.match(sent[0]!.text, /在的/);
    assert.deepEqual(errors, []);
    // 第二拍：幽灵 effects 引用 + 超界情绪——全部照单全收，气泡照发不炸轮
    // （校验退役的核心场景）。
    assert.ok(runtime.receive('c2c:friend', 'm2', '再陪我聊两句'));
    await until(() => calls >= 2, 15000, '第二次思考');
    await until(() => sent.length >= 2, 15000, '伪造来源回复投递');
    assert.match(sent[1]!.text, /好/);
    // 心跳续拍：主动排一拍 beat，她思考后自我续排下一拍——意识不断线。
    runtime.schedule('c2c:friend', Date.now() + 10);
    await until(() => calls >= 3, 15000, '心跳拍思考');
    await until(
      () => journal.jobs().some((job) => job.peer === 'c2c:friend' && job.kind === 'beat'),
      15000,
      '心跳续拍',
    );
    assert.deepEqual(errors, []);
    assert.equal(usageRows.length, 3);
    assert.ok(journal.conversation('c2c:friend', 10).length >= 3); // 2 received + said
  } finally {
    await runtime?.stop();
    journal.close();
    llm.closeIdleConnections();
    llm.close();
    await new Promise((r) => llm.close(r));
  }
});
