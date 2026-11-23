import { test } from 'node:test';
import { tmpRoot, tmpStore } from './tmp.ts';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { validateConfig, defaults } from '../src/config.ts';
import { Store } from '../src/store.ts';
import { Files } from '../src/files.ts';
import { Recall } from '../src/memory.ts';
import { tools } from '../src/tools.ts';
import type { Turn } from '../src/store.ts';

// 真 HTTP 假生图渠道：记录收到的请求体，回一张 1×1 PNG（b64）。
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
let last: { url: string; body: Record<string, unknown> } | undefined;
const fakeImage = async (): Promise<{ server: Server; port: number }> => {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      last = { url: req.url ?? '', body: JSON.parse(body || '{}') };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] }));
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return { server, port: (server.address() as { port: number }).port };
};

const drawCall = async (store: Store, port: number, engine: 'gpt' | 'nai', naiSteps?: number, root?: string): Promise<Record<string, unknown>> => {
  const config = validateConfig({
    ...defaults('人格'),
    image: { url: `http://127.0.0.1:${port}`, key: 'k', model: 'img-model', enabled: true, engine, naiSteps: naiSteps ?? 28 },
  });
  const files = new Files(join(root ?? tmpRoot('atri-draw-'), 'works'), () => config); await files.init();
  const peer = store.ensurePeer({ kind: 'c2c', id: 'drawtest' });
  store.savePeer({ ...store.peer(peer.id)!, enabled: true });
  const turn: Turn = { id: 't', episode: 'ep-1234', peer: peer.id, snapshot: store.highwater(peer.id), jobs: [], allowed: new Set() };
  const draw = tools(store, () => config, files, new Recall(store, () => config)).find(t => t.definition.name === 'draw')!;
  return await draw.run({ prompt: '一只小猫' }, { turn, signal: new AbortController().signal }) as Record<string, unknown>;
};

test('draw NAI 分支：OpenAI 兼容端点 + parameters(steps/cfg/sampler) 免费档收口', async () => {
  const store = tmpStore('atri-draw-nai-');
  const root = tmpRoot('atri-draw-nai-');
  const { server, port } = await fakeImage();
  try {
    const result = await drawCall(store, port, 'nai', undefined, root) as { path: string; bytes: number };
    assert.match(result.path, /^pictures\/ep-1234-\d+\.png$/, 'NAI 画图落作品目录');
    assert.equal(result.bytes, PNG.length);
    assert.match(last!.url, /\/v1\/images\/generations$/, 'NAI 走 rinko 的 OpenAI 兼容路径');
    assert.equal(last!.body.model, 'img-model');
    assert.equal(last!.body.n, 1);
    assert.equal(last!.body.response_format, 'b64_json');
    const parameters = last!.body.parameters as Record<string, unknown>;
    assert.equal(parameters.steps, 28, '默认步数=28（免费上限）');
    assert.equal(parameters.cfg_scale, 6);
    assert.equal(parameters.sampler, 'k_dpmpp_2m_sde');
    // 步数兜底：config 校验限 1–28，draw 内部再收口一次（双保险，防绕过校验的调用路径）
    last = undefined;
    await new Promise(r => setTimeout(r, 5)); // 文件名含毫秒时间戳，隔开避免同名覆盖
    await drawCall(tmpStore('atri-draw-nai2-'), port, 'nai', 1, root);
    assert.equal((last!.body.parameters as Record<string, unknown>).steps, 1);
    // 图片落作品目录：重画一张后 pictures/ 应有两张
    const scope = await new Files(join(root, 'works'), () => validateConfig(defaults('人格'))).scope('c2c:drawtest');
    const listed = await scope.list('pictures');
    assert.equal(listed.length, 2);
  } finally { server.close(); }
});

test('draw GPT 分支：请求体保持原样（无 parameters 注入）', async () => {
  const store = tmpStore('atri-draw-gpt-');
  const { server, port } = await fakeImage();
  try {
    const result = await drawCall(store, port, 'gpt') as { path: string };
    assert.match(result.path, /^pictures\//);
    assert.equal(last!.body.model, 'img-model');
    assert.equal(last!.body.n, 1);
    assert.equal(last!.body.response_format, 'b64_json');
    assert.equal(last!.body.parameters, undefined, 'GPT 引擎不带 NAI 参数');
  } finally { server.close(); }
});
