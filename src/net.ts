import { isIP } from 'node:net';

/** 私网/回环/特殊地址判定：网页读取与微信媒体下载共用的 SSRF 防线。
 *  解析不了的输入一律按私网处理（fail closed）。 */

const BLOCKED_HOSTS = new Set([
  'localhost',
  'localhost.localdomain',
  'metadata',
  'metadata.google.internal',
]);

function isPrivateV4(address: string): boolean {
  const [a, b] = address.split('.').map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || b === 0 || b === 88)) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 198 && (b === 18 || b === 19 || b === 51)) ||
    (a === 203 && b === 0)
  );
}

/** 展开 IPv6 字面量为 8 组 16 位（含 :: 压缩与内嵌 IPv4 尾缀）；非法返回 null。 */
function parseIPv6(host: string): number[] | null {
  let h = host.toLowerCase();
  const zone = h.indexOf('%');
  if (zone >= 0) h = h.slice(0, zone);
  if (h.includes('.')) {
    const colon = h.lastIndexOf(':');
    if (colon < 0) return null;
    const octets = h
      .slice(colon + 1)
      .split('.')
      .map(Number);
    if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255))
      return null;
    h =
      h.slice(0, colon + 1) +
      (((octets[0]! << 8) | octets[1]!).toString(16) +
        ':' +
        ((octets[2]! << 8) | octets[3]!).toString(16));
  }
  const halves = h.split('::');
  if (halves.length > 2) return null;
  const parse = (part: string): number[] | null => {
    if (!part) return [];
    const out: number[] = [];
    for (const group of part.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
      out.push(parseInt(group, 16));
    }
    return out;
  };
  const left = parse(halves[0] ?? '');
  const right = parse(halves[1] ?? '');
  if (!left || !right) return null;
  if (halves.length === 1) return left.length === 8 ? left : null;
  const missing = 8 - left.length - right.length;
  if (missing < 1) return null;
  return [...left, ...Array<number>(missing).fill(0), ...right];
}

function isPrivateV6(host: string): boolean {
  const groups = parseIPv6(host);
  if (!groups) return true;
  // IPv4 映射地址（::ffff:0:0/96）按内嵌的 IPv4 判定。
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    const v4 = `${groups[6]! >> 8}.${groups[6]! & 0xff}.${groups[7]! >> 8}.${groups[7]! & 0xff}`;
    return isPrivateV4(v4);
  }
  // 只放行全局单播 2000::/3；单条规则同时拒绝回环/链路本地/ULA/NAT64 等。
  if ((groups[0]! & 0xe000) !== 0x2000) return true;
  if (groups[0] === 0x2002) return true; // 6to4 隧道可封装任意 IPv4
  if (groups[0] === 0x2001 && [0, 0xdb8, 0x10].includes(groups[1]!)) return true;
  if (groups[0] === 0x3ffe) return true;
  return false;
}

export function isPrivateAddress(address: string): boolean {
  const host = address.replace(/^\[|\]$/g, '');
  const family = isIP(host);
  if (family === 4) return isPrivateV4(host);
  if (family === 6) return isPrivateV6(host);
  return false;
}

/** DNS 之前的主机名字面量检查。 */
export function isPrivateHostLiteral(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (BLOCKED_HOSTS.has(h) || h.endsWith('.local')) return true;
  return isPrivateAddress(h);
}
