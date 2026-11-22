import http from 'node:http';
import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export class HttpError extends Error {
  status: number;
  retryAfter: number;
  data?: Record<string, unknown>;
  constructor(status: number, message: string, retryAfter = 0, data?: Record<string, unknown>) { super(message); this.status = status; this.retryAfter = retryAfter; this.data = data; }
}

export async function readBounded(response: Response, max = 8 * 1024 * 1024): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      bytes += part.value.length;
      if (bytes > max) { await reader.cancel(); throw new Error('响应超过读取上限'); }
      chunks.push(part.value);
    }
    return Buffer.concat(chunks, bytes);
  } finally { reader.releaseLock(); }
}

export async function jsonRequest(url: string, init: RequestInit, max = 8 * 1024 * 1024): Promise<{ data: Record<string, unknown>; headers: Headers; status: number }> {
  const response = await fetch(url, { ...init, redirect: 'error' });
  const bytes = await readBounded(response, max);
  let data: Record<string, unknown>;
  try { const value: unknown = JSON.parse(Buffer.from(bytes).toString('utf8')); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); data = value as Record<string, unknown>; }
  catch { throw new HttpError(response.status, `服务返回非 JSON（HTTP ${response.status}）`); }
  if (!response.ok) {
    const retry = response.headers.get('retry-after');
    const retryAfter = retry ? /^\d+(?:\.\d+)?$/.test(retry) ? Number(retry) * 1000 : Math.max(0, Date.parse(retry) - Date.now()) : 0;
    throw new HttpError(response.status, `HTTP ${response.status}`, Number.isFinite(retryAfter) ? retryAfter : 0, data);
  }
  return { data, headers: response.headers, status: response.status };
}

export function publicAddress(ip: string): boolean {
  const address = ip.toLowerCase();
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number) as [number, number];
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && (b === 168 || b === 0 || b === 2) || a === 100 && b >= 64 && b <= 127 || a === 198 && [18, 19, 51].includes(b) || a === 203 && b === 0);
  }
  if (isIP(address) === 6) {
    // 全球单播 2000::/3，排除文档地址、映射地址与常见隧道。
    const normalized = new URL(`http://[${address}]/`).hostname.slice(1, -1);
    const first = Number.parseInt(normalized.split(':')[0]!, 16);
    const second = Number.parseInt(normalized.split(':')[1] || '0', 16);
    return first >= 0x2000 && first <= 0x3fff && !normalized.startsWith('2001:db8:') && !(first === 0x2001 && second < 0x200) && first !== 0x2002 && first !== 0x3fff;
  }
  return false;
}

async function publicHost(url: URL, signal: AbortSignal): Promise<{ address: string; family: number }> {
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port && !['80', '443'].includes(url.port)) throw new Error('只允许公开 HTTP(S) 资源');
  signal.throwIfAborted();
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const resolution = isIP(hostname) ? Promise.resolve([{ address: hostname, family: isIP(hostname) }]) : lookup(hostname, { all: true });
  const addresses = await new Promise<{ address: string; family: number }[]>((resolve, reject) => {
    const abort = (): void => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    void resolution.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
  if (!addresses.length || addresses.some(a => !publicAddress(a.address))) throw new Error('拒绝访问内网或保留地址');
  signal.throwIfAborted();
  return addresses[0]!;
}

// DNS 结果绑定到本次连接，避免只预检域名却仍由 fetch 二次解析。
export async function publicDownload(raw: string, signal?: AbortSignal, max = 20 * 1024 * 1024, redirects = 3): Promise<{ bytes: Buffer; mime: string; url: string }> {
  const url = new URL(raw);
  const timeout = AbortSignal.timeout(45000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const address = await publicHost(url, combined);
  const response = await new Promise<{ bytes: Buffer; mime: string; location?: string; status: number }>((resolve, reject) => {
    const client = url.protocol === 'https:' ? https : http;
    const req = client.request(url, { method: 'GET', family: address.family, signal: combined, headers: { 'user-agent': 'ATRI/1.0', accept: '*/*' }, lookup: (_host, _options, callback) => callback(null, address.address, address.family) }, res => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && res.headers.location) { res.resume(); resolve({ bytes: Buffer.alloc(0), mime: '', location: res.headers.location, status }); return; }
      if (status < 200 || status >= 300) { res.resume(); reject(new HttpError(status, `下载 HTTP ${status}`)); return; }
      const chunks: Buffer[] = []; let length = 0;
      res.on('data', (chunk: Buffer) => { length += chunk.length; if (length > max) { res.destroy(new Error('资源超过读取上限')); return; } chunks.push(chunk); });
      res.on('end', () => resolve({ bytes: Buffer.concat(chunks, length), mime: String(res.headers['content-type'] ?? 'application/octet-stream').split(';')[0]!, status }));
      res.on('error', reject);
    });
    req.on('error', reject); req.end();
  });
  if (response.location) {
    if (redirects <= 0) throw new Error('重定向过多');
    const next = new URL(response.location, url);
    if (url.protocol === 'https:' && next.protocol !== 'https:') throw new Error('拒绝 HTTPS 降级');
    return publicDownload(next.href, signal, max, redirects - 1);
  }
  return { bytes: response.bytes, mime: response.mime, url: url.href };
}

export async function publicUpload(raw: string, bytes: Buffer, signal: AbortSignal): Promise<void> {
  const url = new URL(raw);
  if (url.protocol !== 'https:') throw new Error('上传只允许 HTTPS');
  const combined = AbortSignal.any([signal, AbortSignal.timeout(60000)]);
  const address = await publicHost(url, combined);
  await new Promise<void>((resolve, reject) => {
    const req = https.request(url, { method: 'PUT', family: address.family, signal: combined, headers: { 'content-length': bytes.length }, lookup: (_host, _options, callback) => callback(null, address.address, address.family) }, res => {
      const status = res.statusCode ?? 0;
      res.resume();
      if (status >= 200 && status < 300) res.on('end', resolve);
      else reject(new HttpError(status, `上传 HTTP ${status}`));
      res.on('error', reject);
    });
    req.on('error', reject); req.end(bytes);
  });
}

export const sleep = (ms: number, signal?: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
  if (signal?.aborted) { reject(signal.reason); return; }
  const abort = (): void => { clearTimeout(timer); reject(signal?.reason); };
  const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
  signal?.addEventListener('abort', abort, { once: true });
});
