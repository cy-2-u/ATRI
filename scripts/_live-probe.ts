import { ModelRouter } from '../src/model/router.js';
import { httpTransport } from '../src/model/http.js';
import type { Endpoint } from '../src/model/types.js';

/** 真机管线探针：换渠道/模型后手动跑一次，验证主渠道与备用渠道都能
 *  完成“编码→请求→解码→工具契约”的整条链路。密钥只走环境变量。
 *
 *  XING_LIVE_URL / XING_LIVE_KEY / XING_LIVE_MODEL 必填；
 *  XING_LIVE_FORMAT=openai|anthropic|gemini（默认 openai）；
 *  XING_LIVE_FALLBACK_URL/KEY/MODEL 可选，同时验证备用。 */

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) {
    console.error(`缺少环境变量 ${name}`);
    process.exit(1);
  }
  return value;
};

const endpoint = (prefix: string): Endpoint => ({
  format: (process.env[`${prefix}_FORMAT`] || 'openai') as Endpoint['format'],
  baseUrl: required(`${prefix}_URL`),
  apiKey: required(`${prefix}_KEY`),
  model: required(`${prefix}_MODEL`),
  vision: false,
  timeoutMs: 60_000,
  maxTokens: 300,
  inputTokens: 8000,
  retries: 1,
});

const router = new ModelRouter(
  () => ({
    primary: endpoint('XING_LIVE'),
    ...(process.env.XING_LIVE_FALLBACK_MODEL ? { fallback: endpoint('XING_LIVE_FALLBACK') } : {}),
  }),
  httpTransport,
);

const messages = [
  { role: 'system' as const, content: '你是管线探针。收到任何输入都只返回 JSON：{"ok":true}。' },
  { role: 'user' as const, content: '探针测试。' },
];

const started = Date.now();
try {
  const completion = await router.complete(messages, [], { deadlineAt: Date.now() + 120_000 });
  console.log(
    `✅ 完成（${Date.now() - started}ms，渠道=${completion.channel}，模型=${completion.model}）`,
  );
  console.log(
    `   usage: in=${completion.usage.input} out=${completion.usage.output} cached=${completion.usage.cached}`,
  );
  console.log(`   回复：${completion.message.content.slice(0, 120)}`);
} catch (error) {
  console.error(
    `❌ 失败（${Date.now() - started}ms）：`,
    error instanceof AggregateError ? error.errors : error,
  );
  process.exit(1);
}
