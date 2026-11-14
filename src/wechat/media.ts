import { isPrivateHostLiteral } from '../net.js';

/** 微信媒体：魔数识别、CDN 白名单、入站附件提取与纯文本抽取。
 *  1 文本、2 图片、3 语音（入站确认）已实测；4 视频、5 文件为推断值，
 *  仅入站解析使用，出站只发文本与图片。 */

export type WeixinItemType = 1 | 2 | 3 | 4 | 5;

export const ITEM_TYPE = {
  text: 1,
  image: 2,
  voice: 3,
  video: 4,
  file: 5,
} as const satisfies Record<string, WeixinItemType>;

/** getuploadurl 的 media_type：1 图 2 视频 3 文件 4 语音。 */
export type UploadMediaType = 1 | 2 | 3 | 4;
export const UPLOAD_MEDIA_TYPE = {
  image: 1,
  video: 2,
  file: 3,
  voice: 4,
} as const satisfies Record<string, UploadMediaType>;

export interface CDNMedia {
  encrypt_query_param?: string;
  aes_key?: string;
  encrypt_type?: number;
  full_url?: string;
}
export interface ImageItem {
  media?: CDNMedia;
  aeskey?: string;
  url?: string;
  mid_size?: number;
}
export interface VoiceItem {
  media?: CDNMedia;
  text?: string;
  voice_text?: string;
  mid_size?: number;
}
export interface VideoItem {
  media?: CDNMedia;
  url?: string;
  mid_size?: number;
}
export interface FileItem {
  media?: CDNMedia;
  url?: string;
  file_name?: string;
  mid_size?: number;
}
export interface MessageItem {
  type: WeixinItemType;
  text_item?: { text?: string };
  image_item?: ImageItem;
  voice_item?: VoiceItem;
  video_item?: VideoItem;
  file_item?: FileItem;
  [key: string]: unknown;
}

export interface WeixinMessage {
  from_user_id?: string;
  to_user_id?: string;
  message_type?: number;
  message_state?: number;
  context_token?: string;
  item_list?: MessageItem[];
  create_time_ms?: number;
  group_id?: string;
  message_id?: string | number;
  msg_id?: string | number;
  id?: string | number;
  [key: string]: unknown;
}

export type MediaKind = 'image' | 'voice' | 'video' | 'file';

export interface InboundMediaRef {
  kind: MediaKind;
  index: number;
  encryptQueryParam?: string;
  aesKey?: string;
  encryptType?: number;
  fullUrl?: string;
  cipherSize?: number;
  fileName?: string;
  transcript?: string;
}

export interface DownloadedMedia {
  kind: MediaKind;
  data: Buffer;
  /** 从魔数嗅探；识别不了为 null。 */
  mime: string | null;
  fileName?: string;
}

/** 从魔数识别媒体类型（识别而非校验：上传侧的严格校验在 stickers）。 */
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

/** 视觉模型可接受的图片 mime。 */
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
  const sub = item as
    { media?: CDNMedia; aeskey?: string; url?: string; mid_size?: number } | undefined;
  if (!sub) return {};
  return {
    media: sub.media,
    aesKey: sub.media?.aes_key ?? sub.aeskey,
    fullUrl: sub.media?.full_url ?? sub.url,
    cipherSize: sub.mid_size,
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
      const t = item.voice_item?.text || item.voice_item?.voice_text || item.text_item?.text;
      if (t) parts.push(t);
    }
  }
  return parts.length ? parts.join('\n') : null;
}
