import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';
import { isPrivateAddress } from '../net.js';

/** 联网资料工具：Tavily 搜索与公开网页读取。地址私网拦截、大小与时长
 *  全部有界，动态页面可能读不到——失败时如实报错，不编造结果。 */

const WEB_TIMEOUT_MS = 10_000;
const PAGE_MAX_BYTES = 1024 * 1024;
const SEARCH_MAX_BYTES = 2 * 1024 * 1024;

function abortRejection(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const fail = () =>
      reject(signal.reason instanceof Error ? signal.reason : new Error('请求已取消'));
    if (signal.aborted) fail();
    else signal.addEventListener('abort', fail, { once: true });
  });
}

/** 流式限量读取，不让坏上游把内存吃穿。 */
async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    const text = await response.text();
    if (Buffer.byteLength(text) > maxBytes) throw new Error('上游响应超过读取上限');
    return text;
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error('上游响应超过读取上限');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function decodePage(body: Buffer, encoding: string, contentType: string): string {
  const normalized = encoding.trim().toLowerCase();
  let decoded = body;
  if (normalized && normalized !== 'identity') {
    const options = { maxOutputLength: PAGE_MAX_BYTES };
    try {
      if (normalized === 'gzip' || normalized === 'x-gzip') decoded = gunzipSync(body, options);
      else if (normalized === 'deflate') decoded = inflateSync(body, options);
      else if (normalized === 'br') decoded = brotliDecompressSync(body, options);
      else throw new Error(`不支持的内容编码：${normalized}`);
    } catch (error) {
      if (error instanceof Error && /maxOutputLength|buffer/i.test(error.message))
        throw new Error('网页解压后超过读取上限');
      throw error;
    }
  }
  const charset = /charset\s*=\s*"?([^";\s]+)/i.exec(contentType)?.[1];
  try {
    return new TextDecoder(charset || 'utf-8').decode(decoded);
  } catch {
    return new TextDecoder('utf-8').decode(decoded);
  }
}

export interface WebResult {
  title: string;
  snippet: string;
  url: string;
  fetchedAt: string;
  publishedAt: string | null;
}
export interface WebTools {
  search(query: string, freshness?: string, signal?: AbortSignal): Promise<WebResult[]>;
  open(
    url: string,
    signal?: AbortSignal,
  ): Promise<{ url: string; content: string; fetchedAt: string }>;
}
export const isPublicAddress = (address: string) => !isPrivateAddress(address);

/** 读取公开网页：协议/端口/私网校验（DNS 逐地址），跟随至多 3 次重定向，
 *  共享整轮截止时间，正文抽成纯文本并限量。 */
export async function fetchPublicPage(
  rawUrl: string,
  signal?: AbortSignal,
  redirects = 0,
  deadlineAt = Date.now() + WEB_TIMEOUT_MS,
): Promise<{ url: string; content: string; fetchedAt: string }> {
  const url = new URL(rawUrl);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    !['', '80', '443'].includes(url.port)
  )
    throw new Error('只可读取公开 HTTP/HTTPS 网页');
  const remaining = Math.max(1, deadlineAt - Date.now());
  const combined = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(remaining)])
    : AbortSignal.timeout(remaining);
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  let addresses: { address: string; family: number }[];
  try {
    addresses = isIP(hostname)
      ? [{ address: hostname, family: isIP(hostname) }]
      : await Promise.race([lookup(hostname, { all: true }), abortRejection(combined)]);
  } catch (error) {
    if (combined.aborted) throw new Error('网页读取超时');
    throw error;
  }
  if (!addresses.length || addresses.some((a) => !isPublicAddress(a.address)))
    throw new Error('该地址不是允许读取的公开网页');
  const address = addresses[0];
  const result = await new Promise<{ body: string; location?: string; status: number }>(
    (resolve, reject) => {
      const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
        url,
        {
          signal: combined,
          headers: {
            'user-agent': 'ATRI/4.0 (web reader)',
            accept: 'text/html,text/plain,application/json',
            'accept-encoding': 'identity',
          },
          // DNS 解析钉死到已校验的地址，防解析结果在校验后变化。
          lookup: ((_host: unknown, options: any, callback: any) =>
            options?.all
              ? callback(null, [address])
              : callback(null, address.address, address.family)) as any,
        },
        (response) => {
          if (
            response.statusCode &&
            response.statusCode >= 300 &&
            response.statusCode < 400 &&
            response.headers.location
          ) {
            response.resume();
            resolve({ body: '', location: response.headers.location, status: response.statusCode });
            return;
          }
          const mime = String(response.headers['content-type'] ?? '');
          if (!/text\/|application\/(json|xhtml)/i.test(mime)) {
            response.resume();
            reject(new Error('该地址没有返回可读取的文本'));
            return;
          }
          let length = 0;
          const chunks: Buffer[] = [];
          const encoding = String(response.headers['content-encoding'] ?? '');
          response.on('data', (chunk: Buffer) => {
            length += chunk.length;
            if (length > PAGE_MAX_BYTES) {
              request.destroy(new Error('网页超过读取上限'));
              return;
            }
            chunks.push(chunk);
          });
          response.on('end', () => {
            try {
              resolve({
                body: decodePage(Buffer.concat(chunks), encoding, mime),
                status: response.statusCode ?? 0,
              });
            } catch (error) {
              reject(error);
            }
          });
          response.on('error', reject);
        },
      );
      request.on('error', reject);
      request.end();
    },
  );
  if (result.location) {
    if (redirects >= 3) throw new Error('网页重定向次数过多');
    return fetchPublicPage(new URL(result.location, url).href, signal, redirects + 1, deadlineAt);
  }
  if (result.status < 200 || result.status >= 300)
    throw new Error(`网页读取失败（HTTP ${result.status}）`);
  const content = result.body
    .replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 12000);
  return { url: url.href, content, fetchedAt: new Date().toISOString() };
}

export class TavilyWeb implements WebTools {
  constructor(
    private readonly getKey: () => string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}
  async search(query: string, freshness?: string, signal?: AbortSignal): Promise<WebResult[]> {
    const apiKey = this.getKey();
    if (!apiKey) throw new Error('联网搜索尚未配置，请在管理页填写搜索密钥');
    if (!query.trim() || query.length > 600) throw new Error('查询文本长度无效');
    const response = await this.fetcher('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        search_depth: 'basic',
        max_results: 5,
        include_answer: false,
        ...(['d', 'w', 'm', 'y'].includes(freshness ?? '') ? { time_range: freshness } : {}),
      }),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(10000)])
        : AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error(`联网搜索失败（HTTP ${response.status}）`);
    let json: unknown;
    try {
      json = JSON.parse(await readBoundedText(response, SEARCH_MAX_BYTES));
    } catch (error) {
      if (error instanceof Error && error.message.includes('读取上限')) throw error;
      throw new Error('联网搜索返回了无效 JSON');
    }
    const record =
      json && typeof json === 'object' && !Array.isArray(json)
        ? (json as Record<string, unknown>)
        : undefined;
    const results = Array.isArray(record?.results)
      ? record.results.filter(
          (r): r is { title?: string; content?: string; url?: string; published_date?: string } =>
            Boolean(r && typeof r === 'object' && !Array.isArray(r)),
        )
      : [];
    const fetchedAt = new Date().toISOString();
    return results
      .filter((r) => /^https?:\/\//.test(r.url ?? ''))
      .slice(0, 5)
      .map((r) => ({
        title: typeof r.title === 'string' ? r.title : '',
        snippet: typeof r.content === 'string' ? r.content.slice(0, 1500) : '',
        url: r.url!,
        fetchedAt,
        publishedAt: typeof r.published_date === 'string' ? r.published_date : null,
      }));
  }
  open(url: string, signal?: AbortSignal) {
    return fetchPublicPage(url, signal);
  }
}
