import { isIP } from 'node:net';

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
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 198 && (b === 18 || b === 19))
  );
}

/** ::ffff:XXXX:XXXX — the hex spelling of an IPv4-mapped address. */
const HEX_MAPPED = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/;
/** ::ffff:1.2.3.4 — the dotted spelling of the same address. */
const DOTTED_MAPPED = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/;

function isPrivateV6(host: string): boolean {
  const h = host.toLowerCase();
  if (
    h === '::1' ||
    h === '::' ||
    h.startsWith('fe80:') ||
    h.startsWith('fc') ||
    h.startsWith('fd')
  )
    return true;
  // IPv4-mapped addresses must not slip through, in BOTH spellings. Only the
  // dotted form was handled, so the same address written in hex fell through to
  // `false`: `http://[::ffff:7f00:1]/` reached loopback and
  // `http://[::ffff:a9fe:a9fe]/` reached cloud metadata, both classified as
  // public. Accepting one spelling made the whole private-address gate opt-out
  // by rewording the URL.
  const dotted = DOTTED_MAPPED.exec(h);
  if (dotted) return isPrivateV4(dotted[1]!);
  const hex = HEX_MAPPED.exec(h);
  if (hex) {
    const value = ((parseInt(hex[1]!, 16) << 16) | parseInt(hex[2]!, 16)) >>> 0;
    return isPrivateV4(
      `${value >>> 24}.${(value >>> 16) & 255}.${(value >>> 8) & 255}.${value & 255}`,
    );
  }
  // A bare "::ffff:<one group>" cannot express an IPv4 address; no decision.
  return false;
}

/** True when the address is loopback, private, link-local or otherwise not public. */
export function isPrivateAddress(address: string): boolean {
  const host = address.replace(/^\[|\]$/g, '');
  const family = isIP(host);
  if (family === 4) return isPrivateV4(host);
  if (family === 6) return isPrivateV6(host);
  return false;
}

/** Host-literal check before DNS: blocks localhost, *.local and private literals. */
export function isPrivateHostLiteral(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (BLOCKED_HOSTS.has(h) || h.endsWith('.local')) return true;
  return isPrivateAddress(h);
}
