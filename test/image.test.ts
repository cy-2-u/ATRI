import test from 'node:test';
import assert from 'node:assert/strict';
import { ImagePainter } from '../src/image.js';
import { Journal } from '../src/storage/journal.js';
import { Settings } from '../src/settings.js';

/** PNG 头 8 字节：魔数嗅探的最小合法图片。 */
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

const okBody = (payload: unknown) =>
  new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

test('画笔：b64 响应解码出图片，端点与请求体正确', async () => {
  const requests: { url: string; body: any }[] = [];
  const painter = new ImagePainter(
    () => ({ baseUrl: 'https://img.example.com', apiKey: 'secret', model: 'gpt-image' }),
    async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(String(init!.body)) });
      return okBody({ data: [{ b64_json: PNG.toString('base64') }] });
    },
  );
  const painted = await painter.paint('一只很胖的猫');
  assert.equal(painted.ext, 'png');
  assert.equal(painted.mime, 'image/png');
  assert.equal(requests[0]!.url, 'https://img.example.com/v1/images/generations');
  assert.equal(requests[0]!.body.model, 'gpt-image');
  assert.equal(requests[0]!.body.prompt, '一只很胖的猫');
});

test('画笔：url 响应走下载分支，私网地址被拒', async () => {
  const seen: string[] = [];
  const painter = new ImagePainter(
    () => ({ baseUrl: 'https://img.example.com/v1', apiKey: 'secret', model: 'm' }),
    async (url) => {
      seen.push(String(url));
      if (String(url).endsWith('/images/generations'))
        return okBody({ data: [{ url: 'https://cdn.example.com/x.png' }] });
      return new Response(PNG, { status: 200 });
    },
  );
  const painted = await painter.paint('test');
  assert.equal(painted.mime, 'image/png');
  assert.deepEqual(seen, [
    'https://img.example.com/v1/images/generations',
    'https://cdn.example.com/x.png',
  ]);

  const guarded = new ImagePainter(
    () => ({ baseUrl: 'https://img.example.com', apiKey: 'secret', model: 'm' }),
    async () => okBody({ data: [{ url: 'http://127.0.0.1/x.png' }] }),
  );
  await assert.rejects(() => guarded.paint('test'), /不在允许范围/);
});

test('画笔：HTTP 失败、空响应、非图片、超限各自如实报错；未配置直接拒绝', async () => {
  const failing = new ImagePainter(
    () => ({ baseUrl: 'https://img.example.com', apiKey: 'secret', model: 'm' }),
    async () => new Response('boom', { status: 503 }),
  );
  await assert.rejects(() => failing.paint('test'), /画图失败（HTTP 503）/);

  const empty = new ImagePainter(
    () => ({ baseUrl: 'https://img.example.com', apiKey: 'secret', model: 'm' }),
    async () => okBody({ data: [] }),
  );
  await assert.rejects(() => empty.paint('test'), /没有返回图片/);

  const notImage = new ImagePainter(
    () => ({ baseUrl: 'https://img.example.com', apiKey: 'secret', model: 'm' }),
    async () =>
      okBody({ data: [{ b64_json: Buffer.from('hello plain text').toString('base64') }] }),
  );
  await assert.rejects(() => notImage.paint('test'), /不是图片/);

  const huge = Buffer.concat([PNG, Buffer.alloc(6 * 1024 * 1024)]);
  const oversized = new ImagePainter(
    () => ({ baseUrl: 'https://img.example.com', apiKey: 'secret', model: 'm' }),
    async () => okBody({ data: [{ b64_json: huge.toString('base64') }] }),
  );
  await assert.rejects(() => oversized.paint('test'), /超过 5 MB/);

  const unconfigured = new ImagePainter(() => ({}));
  await assert.rejects(() => unconfigured.paint('test'), /画笔尚未配置/);
});

test('画笔 NAI 引擎：parameters 收口 28 步、独立凭据、danbooru 描述随引擎切', async () => {
  const requests: { url: string; body: any }[] = [];
  const painter = new ImagePainter(
    () => ({
      engine: 'nai',
      baseUrl: 'https://gpt.example.com',
      apiKey: 'gpt-key',
      model: 'gpt-image',
      nai: {
        baseUrl: 'https://nai.example.com',
        apiKey: 'nai-key',
        model: 'nai-diffusion-4-5-full',
        steps: 28,
      },
    }),
    async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(String(init!.body)) });
      return okBody({ data: [{ b64_json: PNG.toString('base64') }] });
    },
  );
  // 引擎标识：NAI 引擎、配置齐备。
  assert.equal(painter.engine, 'nai');
  assert.ok(painter.configured);
  const painted = await painter.paint('1girl, white hair, smile');
  assert.equal(painted.mime, 'image/png');
  // NAI 走自己的凭据与地址，不碰 GPT 组。
  assert.equal(requests[0]!.url, 'https://nai.example.com/v1/images/generations');
  assert.equal(requests[0]!.body.model, 'nai-diffusion-4-5-full');
  assert.equal(requests[0]!.body.response_format, 'b64_json');
  assert.equal(requests[0]!.body.n, 1);
  assert.equal(requests[0]!.body.parameters.steps, 28);
  assert.equal(requests[0]!.body.parameters.cfg_scale, 6);
  assert.equal(requests[0]!.body.parameters.sampler, 'k_dpmpp_2m_sde');
  assert.equal(requests[0]!.body.parameters.noise_schedule, 'karras');
  // 配置的步数超出免费档也被硬收口到 28。
  const greedy = new ImagePainter(
    () => ({
      engine: 'nai',
      baseUrl: 'https://gpt.example.com',
      apiKey: 'gpt-key',
      model: 'gpt-image',
      nai: { baseUrl: 'https://nai.example.com', apiKey: 'nai-key', model: 'nai', steps: 50 },
    }),
    async (_url, init) => {
      requests.push({ url: 'greedy', body: JSON.parse(String(init!.body)) });
      return okBody({ data: [{ b64_json: PNG.toString('base64') }] });
    },
  );
  await greedy.paint('test');
  assert.equal(requests[1]!.body.parameters.steps, 28);
  // 未配 NAI 子配置时如实报错（而不是拿 GPT 凭据瞎打）。
  const missing = new ImagePainter(() => ({
    engine: 'nai',
    baseUrl: 'https://gpt.example.com',
    apiKey: 'gpt-key',
    model: 'gpt-image',
  }));
  await assert.rejects(() => missing.paint('test'), /NAI 画图渠道未配置/);
});

test('画图渠道配置：保存往返、密钥脱敏、清除与缺项拒绝', () => {
  const journal = new Journal(':memory:');
  try {
    const settings = new Settings(journal, { LLM_API_KEY: 'primary-secret' });
    settings.update({
      image: { model: 'img-model', apiKey: 'img-secret', baseUrl: 'https://img.example.com' },
    });
    assert.equal(settings.get().image?.model, 'img-model');
    assert.equal(settings.get().image?.engine, 'gpt'); // 旧配置兼容：缺省 gpt 引擎
    const publicConfig = JSON.stringify(settings.public());
    assert.ok(!publicConfig.includes('img-secret'));
    assert.equal((settings.public().image as { hasApiKey?: boolean })?.hasApiKey, true);
    settings.update({ image: null });
    assert.equal(settings.get().image, undefined);
    // 清除后从零配置：缺 apiKey 必须拒绝，不能静默当"没配置"。
    assert.throws(() =>
      settings.update({ image: { model: 'img-model', baseUrl: 'https://img.example.com' } }),
    );
    // NAI 子配置：保存往返、步数校验、脱敏。
    settings.update({
      image: {
        engine: 'nai',
        model: 'img-model',
        apiKey: 'img-secret',
        baseUrl: 'https://img.example.com',
        nai: {
          model: 'nai-diffusion-4-5-full',
          apiKey: 'nai-secret',
          baseUrl: 'https://nai.example.com',
          steps: 20,
        },
      },
    });
    const nai = settings.get().image?.nai;
    assert.equal(nai?.model, 'nai-diffusion-4-5-full');
    assert.equal(nai?.steps, 20);
    assert.equal(nai?.apiKey, 'nai-secret');
    const pub = settings.public().image as { nai?: { hasApiKey?: boolean } };
    assert.equal(pub.nai?.hasApiKey, true);
    assert.ok(!JSON.stringify(settings.public()).includes('nai-secret'));
    // 步数越界拒绝（免费档 28 封顶）。
    assert.throws(() =>
      settings.update({
        image: {
          engine: 'nai',
          model: 'm',
          apiKey: 'k',
          baseUrl: 'https://img.example.com',
          nai: { model: 'nai', apiKey: 'k', baseUrl: 'https://nai.example.com', steps: 29 },
        },
      }),
    );
    // 引擎值非法拒绝。
    assert.throws(() =>
      settings.update({
        image: { engine: 'sd', model: 'm', apiKey: 'k', baseUrl: 'https://img.example.com' },
      }),
    );
  } finally {
    journal.close();
  }
});
