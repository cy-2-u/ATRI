import type {
  CDNMedia,
  FileItem,
  ImageItem,
  InboundMediaRef,
  MediaKind,
  MessageItem,
  VideoItem,
  VoiceItem,
  WeixinMessage,
} from './types.js';
import { ITEM_TYPE } from './types.js';
import { isPrivateHostLiteral } from '../net.js';

/** 从魔数识别媒体类型（识别而非校验：上传侧的严格校验在 stickers.ts）。 */
export function sniffMediaMime(buf: Buffer): string | null {
  if (!buf || buf.length < 4) return null;
  const startsWith = (bytes: number[], offset = 0): boolean => {
    if (buf.length < offset + bytes.length) return false;
    for (let i = 0; i < bytes.length; i++) if (buf[offset + i] !== bytes[i]) return false;
    return true;
  };
  const ascii = (offset: number, len: number): string =>
    buf.length >= offset + len ? buf.subarray(offset, offset + len).toString('latin1') : '';
  if (startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith([0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a') return 'image/gif';
  if (ascii(0, 4) === 'RIFF') {
    const form = ascii(8, 4);
    if (form === 'WEBP') return 'image/webp';
    if (form === 'WAVE') return 'audio/wav';
  }
  if (ascii(0, 2) === 'BM') return 'image/bmp';
  // 微信语音是 SILK，偶尔前面多一个引导字节。
  if (ascii(0, 6) === '#!SILK' || ascii(1, 6) === '#!SILK') return 'audio/silk';
  if (ascii(0, 5) === '#!AMR') return 'audio/amr';
  if (ascii(0, 4) === 'OggS') return 'audio/ogg';
  if (ascii(0, 3) === 'ID3') return 'audio/mpeg';
  if (buf.length >= 2 && buf[0] === 0xff && (buf[1]! & 0xe0) === 0xe0) return 'audio/mpeg';
  if (ascii(4, 4) === 'ftyp') {
    const brand = ascii(8, 4);
    if (brand === 'M4A ' || brand === 'M4B ') return 'audio/mp4';
    return 'video/mp4';
  }
  if (startsWith([0x1a, 0x45, 0xdf, 0xa3])) return 'video/webm';
  if (ascii(0, 5) === '%PDF-') return 'application/pdf';
  if (startsWith([0x50, 0x4b, 0x03, 0x04])) return 'application/zip';
  return null;
}

/** 视觉模型可接受的图片 mime（data URI 形式）。 */
const VISION_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
export function isVisionMime(mime: string | null | undefined): boolean {
  return Boolean(mime && VISION_MIMES.has(mime));
}

function readMedia(item: ImageItem | VoiceItem | VideoItem | FileItem | undefined): {
  media?: CDNMedia;
  aesKey?: string;
  fullUrl?: string;
  cipherSize?: number;
} {
  if (!item) return {};
  return {
    media: item.media,
    aesKey: item.media?.aes_key ?? item.aeskey,
    fullUrl: item.media?.full_url ?? item.url,
    cipherSize: item.mid_size,
  };
}

function refFromItem(item: MessageItem, index: number, kind: MediaKind): InboundMediaRef | null {
  const sub =
    kind === 'image'
      ? item.image_item
      : kind === 'voice'
        ? item.voice_item
        : kind === 'video'
          ? item.video_item
          : item.file_item;
  const { media, aesKey, fullUrl, cipherSize } = readMedia(sub);
  const encryptQueryParam = media?.encrypt_query_param;
  if (!encryptQueryParam && !fullUrl) return null;
  const transcript =
    kind === 'voice'
      ? (item.voice_item?.text || item.voice_item?.voice_text || '').trim() || undefined
      : undefined;
  return {
    kind,
    index,
    encryptQueryParam,
    aesKey,
    encryptType: media?.encrypt_type,
    fullUrl,
    cipherSize: typeof cipherSize === 'number' && cipherSize > 0 ? cipherSize : undefined,
    fileName: kind === 'file' ? item.file_item?.file_name?.trim() || undefined : undefined,
    transcript,
  };
}

const ALL_KINDS: readonly MediaKind[] = ['image', 'voice', 'video', 'file'];
const KIND_BY_ITEM_TYPE = new Map<number, MediaKind>([
  [ITEM_TYPE.image, 'image'],
  [ITEM_TYPE.voice, 'voice'],
  [ITEM_TYPE.video, 'video'],
  [ITEM_TYPE.file, 'file'],
]);

/** 取出入站消息的全部可下载附件。类型号不可靠：先试声明的 kind，再试
 *  其余（各 kind 读的是互不相同的子字段，不会误标格式良好的条目）。 */
export function extractMediaRefs(msg: WeixinMessage): InboundMediaRef[] {
  const out: InboundMediaRef[] = [];
  (msg.item_list ?? []).forEach((item, index) => {
    if (!item || item.type === ITEM_TYPE.text) return;
    const claimed = KIND_BY_ITEM_TYPE.get(item.type);
    const order = claimed ? [claimed, ...ALL_KINDS.filter((k) => k !== claimed)] : ALL_KINDS;
    for (const kind of order) {
      const ref = refFromItem(item, index, kind);
      if (ref) {
        out.push(ref);
        return;
      }
    }
  });
  return out;
}

/** 入站 full_url 原则上是攻击者可影响的：只放行配置的 CDN 主机与
 *  微信/QQ CDN 子域，其余一律回退到用自家 CDN 基址重建 URL。 */
const WECHAT_CDN_SUFFIXES = ['.weixin.qq.com', '.qq.com'];
export function isAllowedMediaUrl(
  rawUrl: string,
  opts: { cdnBaseUrl?: string; extraHosts?: readonly string[] } = {},
): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
  if (url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  if (!host || isPrivateHostLiteral(host)) return false;
  let cdnHost = '';
  if (opts.cdnBaseUrl) {
    try {
      cdnHost = new URL(opts.cdnBaseUrl).hostname.toLowerCase();
    } catch {
      /* 配置畸形时忽略 */
    }
  }
  if (cdnHost && host === cdnHost) return true;
  if (WECHAT_CDN_SUFFIXES.some((s) => host.endsWith(s))) return true;
  return (opts.extraHosts ?? []).some((h) => host === h.trim().toLowerCase());
}

export function mediaKindLabel(kind: MediaKind): string {
  switch (kind) {
    case 'image':
      return '图片';
    case 'voice':
      return '语音';
    case 'video':
      return '视频';
    case 'file':
      return '文件';
  }
}

/** 提取纯文本（文字 + 语音转写）。includeVoiceTranscript=false 时语音无转写
 *  就当不可读媒体处理。 */
export function extractText(
  msg: WeixinMessage,
  opts: { includeVoiceTranscript?: boolean } = {},
): string | null {
  const includeVoice = opts.includeVoiceTranscript !== false;
  const parts: string[] = [];
  for (const item of msg.item_list ?? []) {
    if (item.type === 1 && item.text_item?.text) {
      parts.push(item.text_item.text);
      continue;
    }
    if (item.type === 3) {
      if (!includeVoice) continue;
      const voice = item as {
        voice_item?: { text?: string; voice_text?: string };
        text_item?: { text?: string };
      };
      const t = voice.voice_item?.text || voice.voice_item?.voice_text || voice.text_item?.text;
      if (t) parts.push(t);
    }
  }
  return parts.length ? parts.join('\n') : null;
}

export function isMediaOnlyWithoutText(
  msg: WeixinMessage,
  opts: { includeVoiceTranscript?: boolean } = {},
): boolean {
  return !extractText(msg, opts) && (msg.item_list?.length ?? 0) > 0;
}

/** 入站用户消息通常是 message_type === 1。 */
export function isUserInbound(msg: WeixinMessage): boolean {
  return msg.message_type === 1;
}
