import type { Journal } from '../storage/journal.js';

/** OpenAI 兼容 /embeddings 客户端 + 语义索引的滴灌维护。
 *  向量只影响召回排序：任何失败都降级为纯词面（bigram），聊天主链路
 *  不因此中断；待补语料从数据本身派生（缺嵌入行的语料永远是待补）。 */

export function decodeEmbedding(value: unknown): Float32Array {
  if (Array.isArray(value)) {
    if (!value.length || value.some((n) => typeof n !== 'number' || !Number.isFinite(n)))
      throw new Error('向量服务返回了无效向量');
    return Float32Array.from(value as number[]);
  }
  if (typeof value === 'string' && value.length) {
    const buf = Buffer.from(value, 'base64');
    if (!buf.length || buf.length % 4) throw new Error('向量服务返回了无效的 base64 向量');
    const out = new Float32Array(buf.length / 4);
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    for (let i = 0; i < out.length; i++) out[i] = view.getFloat32(i * 4, true);
    if (out.some((n) => !Number.isFinite(n))) throw new Error('向量服务返回了无效向量');
    return out;
  }
  throw new Error('向量服务返回了无效向量');
}

export class EmbeddingClient {
  constructor(
    private readonly getConfig: () => {
      baseUrl?: string;
      apiKey?: string;
      model?: string;
      timeoutMs?: number;
    },
    private readonly fetcher: typeof fetch = fetch,
  ) {}
  get configured(): boolean {
    const c = this.getConfig();
    return !!(c.model && c.apiKey && c.baseUrl);
  }
  get model(): string {
    return this.getConfig().model ?? '';
  }
  async embed(texts: string[], signal?: AbortSignal): Promise<Float32Array[]> {
    const c = this.getConfig();
    if (!c.model || !c.apiKey || !c.baseUrl) throw new Error('向量模型尚未配置');
    if (!texts.length) return [];
    const usable = texts.map((t) => t.slice(0, 6000)).map((t) => (t.trim() ? t : '(空)'));
    const base = c.baseUrl.replace(/\/+$/, '').replace(/\/embeddings$/, '');
    const endpoint = `${/\/v\d+$/.test(base) ? base : `${base}/v1`}/embeddings`;
    const timeoutMs = c.timeoutMs ?? 30_000;
    let response: Response | undefined;
    let lastError: Error | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        response = await this.fetcher(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${c.apiKey}` },
          body: JSON.stringify({ model: c.model, input: usable, encoding_format: 'float' }),
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
            : AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        if (signal?.aborted) throw new Error('向量请求已取消');
        lastError = new Error(
          `向量服务连接失败：${error instanceof Error ? error.message : '未知错误'}`,
        );
      }
      if (response) {
        if (response.ok) break;
        const body = (await response.text().catch(() => '')).slice(0, 200);
        lastError = new Error(`向量服务请求失败（HTTP ${response.status}）：${body}`);
        // 4xx（除 408/429）是确定性错误：重试不会变好，直接失败。
        if (![408, 429].includes(response.status) && response.status < 500) throw lastError;
      }
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
      response = undefined;
    }
    if (!response?.ok) throw lastError ?? new Error('向量服务请求失败');
    let data: { data?: { index?: number; embedding?: unknown }[] };
    try {
      data = JSON.parse(await response.text()) as typeof data;
    } catch {
      throw new Error('向量服务返回了无效 JSON');
    }
    if (!Array.isArray(data.data) || data.data.length !== usable.length)
      throw new Error('向量服务返回条数不符');
    const out = new Array<Float32Array>(usable.length);
    for (const item of data.data) {
      if (!item || typeof item !== 'object') throw new Error('向量服务返回了无效条目');
      const index = typeof item.index === 'number' ? item.index : out.findIndex((v) => !v);
      if (index < 0 || index >= out.length || out[index]) throw new Error('向量服务返回索引无效');
      out[index] = decodeEmbedding(item.embedding);
    }
    if (out.some((v) => !v)) throw new Error('向量服务返回不完整');
    return out;
  }
}

export function cosine(a: Float32Array, b: Float32Array): number {
  if (!a.length || a.length !== b.length) return 0;
  let dot = 0,
    na = 0,
    nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** 滴灌一轮：把缺嵌入的语料补上（≤64 条/轮）。返回本轮是否还有积压。 */
export async function dripBackfill(
  journal: Journal,
  client: EmbeddingClient,
  peer: string,
  signal?: AbortSignal,
  limit = 64,
): Promise<boolean> {
  const model = client.model;
  if (!client.configured || !model) return false;
  const pending = journal.searchable(peer, model, limit);
  if (!pending.length) return false;
  const vectors = await client.embed(
    pending.map((item) => item.text),
    signal,
  );
  pending.forEach((item, index) => journal.setEmbedding(item.id, model, vectors[index]!));
  return pending.length >= limit;
}
