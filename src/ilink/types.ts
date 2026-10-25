/** iLink Bot 消息条目类型（社区逆向 + 插件行为）。
 *  1 文本、2 图片、3 语音（入站确认）已实测；4 视频、5 文件为推断值，
 *  仅入站解析使用（KIND_BY_ITEM_TYPE），出站只发文本与图片。 */

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

export interface TextItem {
  text?: string;
}
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
  thumb_size?: number;
  thumb_height?: number;
  thumb_width?: number;
  hd_size?: number;
}
/** 语音条目：text/voice_text 是 iLink 侧产出的转写——微信语音是
 *  SILK/AMR，通用 ASR 接口不收，所以只用转写、不碰音频。 */
export interface VoiceItem {
  media?: CDNMedia;
  aeskey?: string;
  url?: string;
  text?: string;
  voice_text?: string;
  mid_size?: number;
  voice_size?: number;
  voice_length?: number;
  duration_ms?: number;
}
export interface VideoItem {
  media?: CDNMedia;
  aeskey?: string;
  url?: string;
  mid_size?: number;
  thumb_size?: number;
  duration_ms?: number;
}
export interface FileItem {
  media?: CDNMedia;
  aeskey?: string;
  url?: string;
  file_name?: string;
  file_size?: number;
  mid_size?: number;
}
export interface MessageItem {
  type: WeixinItemType;
  text_item?: TextItem;
  image_item?: ImageItem;
  voice_item?: VoiceItem;
  video_item?: VideoItem;
  file_item?: FileItem;
  [key: string]: unknown;
}

export type MediaKind = 'image' | 'voice' | 'video' | 'file';

/** 入站消息上一条可下载的附件；encryptQueryParam+aesKey 是微信 CDN
 *  需要的坐标，fullUrl 存在且为绝对地址时优先。 */
export interface InboundMediaRef {
  kind: MediaKind;
  /** 在 item_list 中的序号（单条消息内的稳定 id）。 */
  index: number;
  encryptQueryParam?: string;
  aesKey?: string;
  encryptType?: number;
  fullUrl?: string;
  /** 密文大小提示（mid_size），用于提前拒绝过大附件。 */
  cipherSize?: number;
  fileName?: string;
  /** iLink 侧转写（仅语音）。 */
  transcript?: string;
}
export interface DownloadedMedia {
  kind: MediaKind;
  data: Buffer;
  /** 从魔数嗅探；识别不了为 null。 */
  mime: string | null;
  fileName?: string;
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
  [key: string]: unknown;
}
export interface GetUpdatesResponse {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: WeixinMessage[];
  get_updates_buf?: string;
  longpolling_timeout_ms?: number;
}
export interface SendMessageResponse {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  [key: string]: unknown;
}
export interface GetUploadUrlResponse {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  upload_full_url?: string;
  upload_param?: string;
  [key: string]: unknown;
}
/** 1 开始"对方正在输入中"，2 清除。 */
export type TypingStatus = 1 | 2;
/** /ilink/bot/getconfig 发出的 typing_ticket，按用户生效约 24 小时。 */
export interface GetConfigResponse {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  typing_ticket?: string;
  [key: string]: unknown;
}
export interface QrcodeResponse {
  qrcode?: string;
  qrcode_img_content?: string;
  qrcode_url?: string;
  ret?: number;
  errmsg?: string;
  [key: string]: unknown;
}
export interface QrcodeStatusResponse {
  status?: string;
  bot_token?: string;
  baseurl?: string;
  account_id?: string;
  ilink_bot_id?: string;
  ret?: number;
  errmsg?: string;
  [key: string]: unknown;
}

export interface ILinkClientOptions {
  baseUrl?: string;
  botToken?: string;
  channelVersion?: string;
  timeoutMs?: number;
  longPollTimeoutMs?: number;
  cdnBaseUrl?: string;
  typingTicketTtlMs?: number;
  typingTicketMaxEntries?: number;
  mediaMaxBytes?: number;
  /** 入站 full_url 之外额外放行的主机（默认仅微信/QQ CDN 域）。 */
  mediaHostAllowlist?: string[];
}
export interface UploadedMedia {
  filekey: string;
  downloadEncryptedQueryParam: string;
  aesKey: Buffer;
  rawSize: number;
  cipherSize: number;
}
