import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as yieldTurn, setTimeout as delay } from 'node:timers/promises';
import { Mind } from '../src/domain/mind.js';
import type { Model } from '../src/model/types.js';
import { Journal } from '../src/storage/journal.js';
import { Runtime, type RuntimeOptions } from '../src/runtime/runtime.js';
import type { Message } from '../src/model/types.js';

async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (condition()) return;
    await delay(2);
  }
  assert.fail('运行时未在预期内推进');
}

function setup(
  model: Model,
  send: (text: string) => Promise<'sent' | 'unknown' | 'failed'>,
  extra?: Partial<RuntimeOptions>,
) {
  const journal = new Journal(':memory:');
  const errors: unknown[] = [];
  const runtime = new Runtime(journal, new Mind(model, journal), {
    persona: () => 'person',
    material: () => ({ activity: 'reading' }),
    send: (_peer, part) => send(part.text ?? ''),
    nextBeat: () => undefined,
    onError: (error) => errors.push(error),
    timeoutMs: 1000,
    debounceMs: 0,
    concurrency: 2,
    pacing: false,
    stickerSlugs: () => new Set(),
    vision: () => false,
    readFile: () => Promise.resolve(undefined),
    ...extra,
  });
  return {
    journal,
    runtime,
    errors,
    async close() {
      await runtime.stop();
      journal.close();
    },
  };
}

const reply: Model = {
  async complete() {
    return {
      message: {
        role: 'assistant',
        content: '{"action":"speak","parts":[{"type":"text","text":"hello"}],"effects":{}}',
      },
      usage: { input: 1, output: 1, cached: 0 },
    };
  },
};

test('入站持久化任务经统一思考到确认送达，无需轮询', async () => {
  const sent: string[] = [];
  const env = setup(reply, async (text) => {
    sent.push(text);
    return 'sent';
  });
  try {
    env.runtime.start();
    env.runtime.receive('peer', 'one', 'hi');
    await until(() => env.journal.events('peer').some((event) => event.kind === 'said'));
    assert.deepEqual(sent, ['hello']);
    assert.equal(env.errors.length, 0);
  } finally {
    await env.close();
  }
});

test('送达未知阻塞后续，确认后唤醒，不重复发送原气泡', async () => {
  let calls = 0;
  const env = setup(reply, async () => {
    calls++;
    return calls === 1 ? 'unknown' : 'sent';
  });
  try {
    env.runtime.start();
    env.runtime.receive('peer', 'one', 'hi');
    await until(() => env.journal.blocked('peer'));
    const unknown = env.journal.unresolved('peer')[0]!;
    assert.equal(calls, 1);
    assert.equal(env.journal.events('peer').filter((event) => event.kind === 'said').length, 0);
    env.runtime.receive('peer', 'two', 'new');
    for (let i = 0; i < 10; i++) await yieldTurn();
    assert.equal(calls, 1);
    assert.equal(env.runtime.resolveDelivery(unknown.id, 'sent'), true);
    await until(() => calls === 2);
    await until(
      () => env.journal.events('peer').filter((event) => event.kind === 'said').length === 2,
    );
    assert.equal(env.journal.unresolved('peer').length, 0);
  } finally {
    await env.close();
  }
});

test('送达未知只暂停外发，不暂停心跳思考', async () => {
  let calls = 0;
  const modes: string[] = [];
  const model: Model = {
    async complete(messages, tools, options) {
      modes.push(JSON.parse(messages.at(-1)!.content).mode);
      return reply.complete(messages, tools, options);
    },
  };
  const env = setup(model, async () => {
    calls++;
    return 'unknown';
  });
  try {
    env.runtime.start();
    env.runtime.receive('peer', 'one', 'hello');
    await until(() => env.journal.blocked('peer'));
    env.runtime.schedule('peer', Date.now());
    await until(() => modes.includes('beat'));
    assert.equal(calls, 1);
    assert.equal(env.journal.unresolved('peer').length, 1);
    assert.equal(env.errors.length, 0);
  } finally {
    await env.close();
  }
});

test('新消息取消旧思考，仅发送新版本回复', async () => {
  let calls = 0;
  const sent: string[] = [];
  const model: Model = {
    async complete(_messages, _tools, options) {
      calls++;
      if (calls === 1)
        await new Promise<void>((_resolve, reject) => {
          options.signal!.addEventListener('abort', () => reject(options.signal!.reason), {
            once: true,
          });
        });
      return reply.complete([], [], options);
    },
  };
  const env = setup(model, async (text) => {
    sent.push(text);
    return 'sent';
  });
  try {
    env.runtime.start();
    env.runtime.receive('peer', 'one', 'first');
    await until(() => calls === 1);
    env.runtime.receive('peer', 'two', 'second');
    await until(() => sent.length === 1);
    assert.equal(calls, 2);
    assert.deepEqual(sent, ['hello']);
    assert.equal(env.errors.length, 0);
  } finally {
    await env.close();
  }
});

test('注入入站可用时刻：到期前不思考，到期后照常回复', async () => {
  let calls = 0;
  const model: Model = {
    async complete(_m, _t, options) {
      calls++;
      return reply.complete([], [], options);
    },
  };
  const sent: string[] = [];
  const env = setup(
    model,
    async (text) => {
      sent.push(text);
      return 'sent';
    },
    { incomingDue: () => Date.now() + 250 },
  );
  try {
    env.runtime.start();
    env.runtime.receive('peer', 'one', 'hi');
    await delay(100);
    assert.equal(calls, 0);
    await until(() => sent.length === 1);
    assert.deepEqual(sent, ['hello']);
    assert.equal(env.errors.length, 0);
  } finally {
    await env.close();
  }
});

test('视觉注入只给最近两条含图消息，更早的图留文字', async () => {
  // 直接落三条带 media 的 received 事件，readFile 恒返回最小 PNG。每条
  // 消息各触发一轮思考——断言只看最后一轮（此时三条都已在历史里）。
  let lastMessages: Message[] = [];
  const model: Model = {
    async complete(messages, _t, options) {
      lastMessages = messages;
      return reply.complete([], [], options);
    },
  };
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  const env = setup(model, async () => 'sent', {
    vision: () => true,
    readFile: () => Promise.resolve(png),
  });
  try {
    env.runtime.start();
    for (const [i, label] of ['一', '二', '三'].entries()) {
      env.runtime.receive(
        'peer',
        `k${i}`,
        JSON.stringify({
          text: `图${label}`,
          media: [{ path: `media/${i}.png`, mime: 'image/png' }],
        }),
      );
      await delay(80);
    }
    await until(() => env.journal.events('peer').some((event) => event.kind === 'said'));
    const withImages = lastMessages.filter(
      (message) => message.role === 'user' && message.images?.length,
    );
    assert.equal(withImages.length, 2, '只有最近两条含图消息注入图片');
    assert.deepEqual(
      withImages.map((message) => message.content),
      ['图二', '图三'],
    );
  } finally {
    await env.close();
  }
});
