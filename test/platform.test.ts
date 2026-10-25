import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HttpModel,
  ModelError,
  EmbeddingClient,
  estimateTextTokens,
  estimateRequestTokens,
  trimToTokens,
  type ModelConfig,
  type ModelMessage,
  type ToolDefinition,
} from '../src/llm.js';
import { isPrivateAddress, isPrivateHostLiteral } from '../src/net.js';
import {
  encryptAes128Ecb,
  decryptAes128Ecb,
  encodeAesKeyField,
  parseAesKey,
} from '../src/ilink/client.js';
import {
  sniffMediaMime,
  extractText,
  extractMediaRefs,
  isAllowedMediaUrl,
} from '../src/ilink/media.js';
import type { WeixinMessage } from '../src/ilink/types.js';

/** 平台适配层：三种模型接口格式、重试与预算、微信协议工具、私网判定。 */

const base: ModelConfig = {
  baseUrl: 'https://model.example',
  apiKey: 'test-only-secret',
  model: 'test-model',
  format: 'openai',
  vision: false,
  maxTokens: 3000,
  timeoutMs: 500,
};

function okOpenAI(body: Record<string, unknown> = {}) {
  return async (): Promise<Response> =>
    new Response(
      JSON.stringify({
        choices: [{ message: { role: 'assistant', content: '你好' } }],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          prompt_tokens_details: { cached_tokens: 8 },
        },
        ...body,
      }),
      { status: 200 },
    );
}

test('OpenAI 兼容：请求构造、思考剥离、工具调用解析、密钥不外泄', async () => {
  const calls: RequestInit[] = [];
  const urls: string[] = [];
  const model = new HttpModel(base, async (url, init) => {
    urls.push(String(url));
    calls.push(init!);
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              role: 'assistant',
              content: '<think>推理</think>答案',
              reasoning_content: '不进入历史',
              tool_calls: [
                { id: '', function: { name: 'search_memory', arguments: '{"query":"茶"}' } },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
      { status: 200 },
    );
  });
  const completion = await model.complete([{ role: 'user', content: 'hi' }]);
  assert.equal(urls[0], 'https://model.example/v1/chat/completions', '自动补 /v1/chat/completions');
  const sent = JSON.parse(String(calls[0]!.body));
  assert.equal(sent.model, 'test-model');
  assert.equal(sent.max_tokens, 3000);
  assert.equal(completion.text, '答案', '<think> 被剥掉');
  assert.equal(completion.cachedTokens, 0, '该响应未带缓存字段时报 0');
  assert.equal(completion.calls.length, 1);
  assert.notEqual(completion.calls[0].id, 'undefined', '缺失 id 被合成');
  assert.equal(completion.calls[0].arguments.query, '茶');
  assert.ok(
    !JSON.stringify(completion.continuation.raw ?? {}).includes('推理'),
    'reasoning 字段不进入回放',
  );
  const auth = String(new Headers(calls[0]!.headers).get('authorization'));
  assert.ok(auth.includes('test-only-secret'));
});

test('Anthropic：system 块带缓存断点、tool_result 配对、三段用量合计', async () => {
  const bodies: any[] = [];
  const model = new HttpModel({ ...base, format: 'anthropic' }, async (_url, init) => {
    bodies.push(JSON.parse(String(init!.body)));
    return new Response(
      JSON.stringify({
        content: [
          { type: 'text', text: '好' },
          { type: 'tool_use', id: 'tu1', name: 'search_memory', input: { query: '茶' } },
        ],
        usage: {
          input_tokens: 10,
          cache_creation_input_tokens: 100,
          cache_read_input_tokens: 200,
          output_tokens: 5,
        },
      }),
      { status: 200 },
    );
  });
  const messages: ModelMessage[] = [
    { role: 'system', content: '稳定前缀' },
    { role: 'user', content: '问题' },
    {
      role: 'assistant',
      content: '',
      calls: [{ id: 'tu1', name: 'search_memory', arguments: {} }],
      raw: { role: 'assistant', content: [] },
    },
    { role: 'tool', callId: 'tu1', name: 'search_memory', content: '{}' },
    { role: 'user', content: '继续', cacheBreakpoint: true },
  ];
  const completion = await model.complete(messages);
  const body = bodies[0];
  assert.equal(body.system[0].cache_control.type, 'ephemeral', 'system 是最高价值断点');
  assert.ok(body.messages.some((m: any) => JSON.stringify(m.content).includes('tool_result')));
  assert.equal(completion.inputTokens, 310, 'uncached+cache-write+cache-read 合计');
  assert.equal(completion.cachedTokens, 200, 'Anthropic 缓存读取单独上报');
});

test('Gemini：同角色合并、functionResponse 包装、systemInstruction', async () => {
  const bodies: any[] = [];
  const model = new HttpModel({ ...base, format: 'gemini' }, async (_url, init) => {
    bodies.push(JSON.parse(String(init!.body)));
    return new Response(
      JSON.stringify({
        candidates: [
          {
            content: {
              parts: [
                { text: '好' },
                { thought: true, text: '推理不外显' },
                { functionCall: { name: 'search_memory', args: { query: '茶' } } },
              ],
            },
          },
        ],
        usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3 },
      }),
      { status: 200 },
    );
  });
  const tools: ToolDefinition[] = [
    { name: 'search_memory', description: '搜索', parameters: { type: 'object' } },
  ];
  await model.complete(
    [
      { role: 'system', content: '设定' },
      { role: 'user', content: '第一' },
      { role: 'user', content: '第二' },
      { role: 'tool', callId: 't', name: 'search_memory', content: '纯文本结果' },
    ],
    tools,
  );
  const body = bodies[0];
  assert.ok(body.systemInstruction, 'system 进 systemInstruction');
  const userTurns = body.contents.filter((c: any) => c.role === 'user');
  assert.equal(userTurns.length, 1, '连续 user 合并成一个 turn');
  assert.ok(JSON.stringify(userTurns[0]).includes('functionResponse'), '工具结果并入 user turn');
  assert.ok(JSON.stringify(body.contents).includes('"result":"纯文本结果"'), '纯文本包成对象');
  assert.ok(Array.isArray(body.tools[0].functionDeclarations));
});

test('重试策略：临时故障退避重试、永久 4xx 立即失败、放不进截止时间不重试', async () => {
  let n = 0;
  const flaky = new HttpModel(base, async () => {
    n++;
    if (n === 1)
      return new Response('{"error":"busy"}', { status: 429, headers: { 'retry-after': '0' } });
    return okOpenAI()();
  });
  assert.equal((await flaky.complete([{ role: 'user', content: 'x' }])).text, '你好');
  assert.equal(n, 2, '429 重试一次');
  const permanent = new HttpModel(
    base,
    async () => new Response('{"error":"bad key"}', { status: 401 }),
  );
  await assert.rejects(permanent.complete([{ role: 'user', content: 'x' }]), ModelError);
  const slow = new HttpModel(base, async () => {
    n++;
    return new Response('{"error":"boom"}', { status: 500 });
  });
  await assert.rejects(
    slow.complete([{ role: 'user', content: 'x' }], [], { deadlineAt: Date.now() + 100 }),
    /boom/,
    '塞不进截止时间时直接抛原始错误',
  );
  assert.equal(ModelError.transient(429), true);
  assert.equal(ModelError.transient(500), true);
  assert.equal(ModelError.transient(401), false);
  assert.equal(ModelError.transient(undefined, true), true, '网络错误可重试');
});

test('预算估算与截断：CJK 保守、代理对不劈开', () => {
  assert.ok(estimateTextTokens('中文中文') > estimateTextTokens('abcd'));
  assert.ok(
    estimateRequestTokens([{ role: 'user', content: 'x', images: ['data:image/png;base64,xx'] }]) >
      4000,
  );
  const trimmed = trimToTokens('字形'.repeat(5000), 100);
  assert.ok(estimateTextTokens(trimmed) <= 100);
  assert.ok(!/[\uD800-\uDDBFF]$/.test(trimmed), '不在代理对中间截断');
  assert.equal(trimToTokens('短', 100), '短');
  assert.equal(trimToTokens('长'.repeat(100), 0), '');
});

test('嵌入客户端：接受数组与 base64 向量，条数校验', async () => {
  const client = new EmbeddingClient(
    () => ({ baseUrl: 'https://e.example', apiKey: 'k', model: 'm' }),
    async (_url, init) => {
      const body = JSON.parse(String(init!.body));
      assert.equal(body.model, 'm');
      const count = (body.input as string[]).length;
      return new Response(
        JSON.stringify({
          data: Array.from({ length: count }, (_, i) => ({
            index: i,
            embedding:
              i === 0
                ? [0.1, 0.2]
                : Buffer.from(new Float32Array([0.3, 0.4]).buffer).toString('base64'),
          })),
        }),
        { status: 200 },
      );
    },
  );
  const vectors = await client.embed(['第一条', '第二条']);
  assert.equal(vectors.length, 2);
  assert.equal(vectors[0]!.length, 2);
  assert.ok(Math.abs(vectors[1]![0]! - 0.3) < 1e-6, 'base64 float32 解码正确');
  assert.equal(client.configured, true);
});

// ---------- ilink ----------

test('CDN 媒体加密：AES-128-ECB 往返与 aes_key 三种形态', () => {
  const key = Buffer.from('0123456789abcdef');
  const plain = Buffer.from('你好，微信 CDN。');
  const cipher = encryptAes128Ecb(plain, key);
  assert.ok(cipher.length > plain.length, 'PKCS7 填充');
  assert.ok(decryptAes128Ecb(cipher, key).equals(plain));
  assert.equal(parseAesKey(encodeAesKeyField(key)).toString('hex'), key.toString('hex'));
  assert.equal(parseAesKey(key.toString('hex')).toString('hex'), key.toString('hex'));
  assert.throws(() => parseAesKey('zz'), /aes_key/);
});

test('媒体嗅探与入站解析：文字+转写+附件坐标', () => {
  assert.equal(sniffMediaMime(Buffer.from('89504e470d0a1a0a', 'hex')), 'image/png');
  assert.equal(sniffMediaMime(Buffer.from('#!SILK_9')), 'audio/silk');
  assert.equal(sniffMediaMime(Buffer.from('\x00#!SILK')), 'audio/silk');
  const msg: WeixinMessage = {
    message_type: 1,
    from_user_id: 'u1',
    context_token: 'ctx',
    item_list: [
      { type: 1, text_item: { text: '看这张' } },
      {
        type: 3,
        voice_item: {
          text: '语音转写内容',
          media: {
            encrypt_query_param: 'p1',
            aes_key: encodeAesKeyField(Buffer.from('k'.repeat(16))),
          },
        },
      },
      { type: 2, image_item: { media: { encrypt_query_param: 'p2' }, mid_size: 100 } },
    ],
  };
  assert.match(extractText(msg)!, /看这张/);
  assert.match(extractText(msg)!, /语音转写内容/);
  const refs = extractMediaRefs(msg);
  assert.equal(refs.length, 2, '语音与图片各取一个坐标');
  assert.equal(refs[0]!.transcript, '语音转写内容');
  assert.equal(
    extractText({ ...msg, item_list: msg.item_list!.slice(1) }, { includeVoiceTranscript: false }),
    null,
  );
});

test('媒体 URL 白名单：只放行微信/QQ CDN 与配置主机', () => {
  assert.equal(
    isAllowedMediaUrl('https://novac2c.cdn.weixin.qq.com/c2c/download?x=1', {
      cdnBaseUrl: 'https://novac2c.cdn.weixin.qq.com/c2c',
    }),
    true,
  );
  assert.equal(isAllowedMediaUrl('https://evil.example.com/x', {}), false);
  assert.equal(isAllowedMediaUrl('http://127.0.0.1:8080/x', {}), false);
  assert.equal(isAllowedMediaUrl('https://user:pass@novac2c.cdn.weixin.qq.com/x', {}), false);
  assert.equal(
    isAllowedMediaUrl('https://cdn.example.com/x', { extraHosts: ['cdn.example.com'] }),
    true,
  );
});

// ---------- net ----------

test('私网判定：v4 全段、v6 压缩/映射/特殊前缀、主机字面量', () => {
  for (const addr of [
    '127.0.0.1',
    '10.0.0.1',
    '192.168.1.1',
    '172.16.0.1',
    '169.254.1.1',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
  ])
    assert.equal(isPrivateAddress(addr), true, addr);
  assert.equal(isPrivateAddress('8.8.8.8'), false);
  assert.equal(isPrivateAddress('::1'), true);
  assert.equal(isPrivateAddress('fe80::1'), true);
  assert.equal(isPrivateAddress('fd00::1'), true);
  assert.equal(isPrivateAddress('::ffff:127.0.0.1'), true, 'v4 映射的回环');
  assert.equal(isPrivateAddress('::ffff:8.8.8.8'), false, 'v4 映射的公网');
  assert.equal(isPrivateAddress('2001:db8::1'), true, '文档段');
  assert.equal(isPrivateAddress('2600::1'), false, '全局单播放行');
  assert.equal(isPrivateHostLiteral('metadata.google.internal'), true);
  assert.equal(isPrivateHostLiteral('localhost.local'), true);
  assert.equal(isPrivateHostLiteral('example.com'), false);
});
