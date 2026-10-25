import { createCipheriv, createDecipheriv, createHash, randomBytes, randomInt } from 'node:crypto';
import { isAllowedMediaUrl, sniffMediaMime } from './media.js';
import type {
  DownloadedMedia,
  GetConfigResponse,
  GetUpdatesResponse,
  GetUploadUrlResponse,
  ILinkClientOptions,
  InboundMediaRef,
  QrcodeResponse,
  QrcodeStatusResponse,
  SendMessageResponse,
  TypingStatus,
  UploadMediaType,
  UploadedMedia,
  WeixinItemType,
} from './types.js';
import { ITEM_TYPE, UPLOAD_MEDIA_TYPE } from './types.js';

const DEFAULT_BASE = 'https://ilinkai.weixin.qq.com';
const DEFAULT_CDN = 'https://novac2c.cdn.weixin.qq.com/c2c';
const DEFAULT_TYPING_TICKET_TTL_MS = 20 * 60 * 60 * 1000;
const DEFAULT_TYPING_TICKET_MAX_ENTRIES = 5000;
const DEFAULT_MEDIA_MAX_BYTES = 12 * 1024 * 1024;

// ---------- CDN 媒体加密 ----------

export function aesEcbPaddedSize(plaintextSize: number): number {
  return Math.ceil((plaintextSize + 1) / 16) * 16;
}
export function encryptAes128Ecb(plaintext: Buffer, key: Buffer): Buffer {
  if (key.length !== 16) throw new Error(`AES-128 key must be 16 bytes, got ${key.length}`);
  const cipher = createCipheriv('aes-128-ecb', key, null);
  cipher.setAutoPadding(true);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}
export function decryptAes128Ecb(ciphertext: Buffer, key: Buffer): Buffer {
  if (key.length !== 16) throw new Error(`AES-128 key must be 16 bytes, got ${key.length}`);
  const decipher = createDecipheriv('aes-128-ecb', key, null);
  decipher.setAutoPadding(true);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
export const md5Hex = (buf: Buffer) => createHash('md5').update(buf).digest('hex');
export const randomAesKey = () => randomBytes(16);
export const randomFileKey = () => randomBytes(16).toString('hex');
/** 出站 image_item 的 aes_key：base64(16 字节密钥的 32 位 hex 文本)。 */
export const encodeAesKeyField = (aesKey: Buffer) =>
  Buffer.from(aesKey.toString('hex'), 'utf8').toString('base64');
/** 入站 aes_key 兼容三种形态：base64(裸 16 字节)/base64(hex 文本)/裸 hex。 */
export function parseAesKey(aesKeyField: string): Buffer {
  const raw = aesKeyField.trim();
  if (/^[0-9a-fA-F]{32}$/.test(raw)) return Buffer.from(raw, 'hex');
  const decoded = Buffer.from(raw, 'base64');
  if (decoded.length === 16) return decoded;
  if (decoded.length === 32) {
    const asAscii = decoded.toString('ascii');
    if (/^[0-9a-fA-F]{32}$/.test(asAscii)) return Buffer.from(asAscii, 'hex');
  }
  throw new Error(
    `aes_key must decode to 16 raw bytes or 32-char hex, got ${decoded.length} bytes`,
  );
}
export function buildCdnUploadUrl(cdnBaseUrl: string, uploadParam: string, filekey: string) {
  const base = cdnBaseUrl.replace(/\/$/, '');
  return `${base}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`;
}
export function buildCdnDownloadUrl(cdnBaseUrl: string, encryptedQueryParam: string) {
  const base = cdnBaseUrl.replace(/\/$/, '');
  return `${base}/download?encrypted_query_param=${encodeURIComponent(encryptedQueryParam)}`;
}

// ---------- 请求头 ----------

/** 随机 X-WECHAT-UIN（uint32 十进制文本再 base64，逐请求防重放）。 */
export const randomWechatUinHeader = () =>
  Buffer.from(String(randomInt(0, 0xffffffff)), 'utf8').toString('base64');
export function buildILinkHeaders(botToken?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    'X-WECHAT-UIN': randomWechatUinHeader(),
  };
  if (botToken) headers.Authorization = `Bearer ${botToken}`;
  return headers;
}

// ---------- 客户端 ----------

interface TypingTicketEntry {
  ticket: string;
  expiresAt: number;
}

export class ILinkError extends Error {
  constructor(
    message: string,
    public readonly ret?: number,
    public readonly errcode?: number,
    public readonly body?: unknown,
    /** 传输层失败的 HTTP 状态（CDN 5xx 是临时故障，非零 ret 是协议拒绝）。 */
    public readonly httpStatus?: number,
  ) {
    super(message);
    this.name = 'ILinkError';
  }
}

export class ILinkClient {
  private baseUrl: string;
  private botToken?: string;
  private channelVersion: string;
  private timeoutMs: number;
  private longPollTimeoutMs: number;
  private cdnBaseUrl: string;
  private typingTickets = new Map<string, TypingTicketEntry>();
  private typingTicketInflight = new Map<string, Promise<string | null>>();
  private typingTicketTtlMs: number;
  private typingTicketMaxEntries: number;
  private mediaMaxBytes: number;
  private mediaHostAllowlist: string[];

  constructor(opts: ILinkClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE).replace(/\/$/, '');
    this.botToken = opts.botToken;
    this.channelVersion = opts.channelVersion ?? '1.0.2';
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.longPollTimeoutMs = opts.longPollTimeoutMs ?? 40_000;
    this.cdnBaseUrl = (opts.cdnBaseUrl ?? DEFAULT_CDN).replace(/\/$/, '');
    this.typingTicketTtlMs = Math.max(
      60_000,
      opts.typingTicketTtlMs ?? DEFAULT_TYPING_TICKET_TTL_MS,
    );
    this.typingTicketMaxEntries = Math.max(
      64,
      opts.typingTicketMaxEntries ?? DEFAULT_TYPING_TICKET_MAX_ENTRIES,
    );
    this.mediaMaxBytes = Math.max(1024, opts.mediaMaxBytes ?? DEFAULT_MEDIA_MAX_BYTES);
    this.mediaHostAllowlist = (opts.mediaHostAllowlist ?? []).map((h) => h.trim()).filter(Boolean);
  }

  setBotToken(token: string) {
    this.botToken = token;
  }
  getBotToken() {
    return this.botToken;
  }
  setBaseUrl(url: string) {
    this.baseUrl = url.replace(/\/$/, '');
  }
  setCdnBaseUrl(url: string) {
    this.cdnBaseUrl = url.replace(/\/$/, '');
  }
  getCdnBaseUrl() {
    return this.cdnBaseUrl;
  }

  async getBotQrcode(botType = 3): Promise<QrcodeResponse> {
    const url = `${this.baseUrl}/ilink/bot/get_bot_qrcode?bot_type=${botType}`;
    return this.getJson<QrcodeResponse>(url, false, this.timeoutMs);
  }

  /** 扫码状态长轮询：服务端会挂住 35–60 秒，用长超时，AbortError 由调用方当"继续等"。 */
  async getQrcodeStatus(qrcode: string): Promise<QrcodeStatusResponse> {
    const url = `${this.baseUrl}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
    return this.getJson<QrcodeStatusResponse>(url, false, 90_000);
  }

  /** 入站长轮询；首次 getUpdatesBuf 传空串。 */
  async getUpdates(getUpdatesBuf: string): Promise<GetUpdatesResponse> {
    this.requireToken();
    return this.postJson<GetUpdatesResponse>(
      '/ilink/bot/getupdates',
      { get_updates_buf: getUpdatesBuf, base_info: { channel_version: this.channelVersion } },
      this.longPollTimeoutMs,
    );
  }

  async sendText(params: {
    toUserId: string;
    text: string;
    contextToken: string;
    clientId?: string;
  }): Promise<SendMessageResponse> {
    this.requireToken();
    const clientId =
      params.clientId ?? `wechat-ai-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    return this.postJson<SendMessageResponse>('/ilink/bot/sendmessage', {
      msg: {
        from_user_id: '',
        to_user_id: params.toUserId,
        client_id: clientId,
        message_type: 2,
        message_state: 2,
        context_token: params.contextToken,
        item_list: [{ type: ITEM_TYPE.text, text_item: { text: params.text } }],
      },
      base_info: { channel_version: this.channelVersion },
    });
  }

  /** sendtyping 需要的按用户 typing_ticket（约 24 小时有效）。 */
  async getConfig(params: { toUserId: string; contextToken: string }): Promise<GetConfigResponse> {
    this.requireToken();
    return this.postJson<GetConfigResponse>('/ilink/bot/getconfig', {
      ilink_user_id: params.toUserId,
      to_user_id: params.toUserId,
      context_token: params.contextToken,
      base_info: { channel_version: this.channelVersion },
    });
  }

  getCachedTypingTicket(toUserId: string): string | null {
    const hit = this.typingTickets.get(toUserId);
    if (!hit) return null;
    if (hit.expiresAt <= Date.now()) {
      this.typingTickets.delete(toUserId);
      return null;
    }
    return hit.ticket;
  }
  invalidateTypingTicket(toUserId: string) {
    this.typingTickets.delete(toUserId);
  }

  /** 缓存优先取 ticket；getconfig 失败返回 null——输入指示是装饰，绝不能拖垮回复。 */
  async getTypingTicket(params: {
    toUserId: string;
    contextToken: string;
    force?: boolean;
  }): Promise<string | null> {
    const key = params.toUserId;
    if (!params.force) {
      const cached = this.getCachedTypingTicket(key);
      if (cached) return cached;
      const inflight = this.typingTicketInflight.get(key);
      if (inflight) return inflight;
    }
    const pending = (async (): Promise<string | null> => {
      try {
        const res = await this.getConfig({
          toUserId: params.toUserId,
          contextToken: params.contextToken,
        });
        const ticket = typeof res.typing_ticket === 'string' ? res.typing_ticket.trim() : '';
        if (!ticket) return null;
        this.rememberTypingTicket(key, ticket);
        return ticket;
      } catch {
        return null;
      }
    })();
    this.typingTicketInflight.set(key, pending);
    try {
      return await pending;
    } finally {
      if (this.typingTicketInflight.get(key) === pending) this.typingTicketInflight.delete(key);
    }
  }

  /** 显示（status 1）/清除（status 2）输入指示。停止调用从不取新 ticket——
   *  没缓存说明从未开始过。缓存 ticket 失效时强制刷新重试一次。 */
  async sendTyping(params: {
    toUserId: string;
    contextToken: string;
    status?: TypingStatus;
    typingTicket?: string;
  }): Promise<unknown> {
    this.requireToken();
    const status: TypingStatus = params.status ?? 1;
    const explicit = params.typingTicket?.trim();
    let ticket: string | null = explicit ?? null;
    if (!ticket) {
      ticket =
        status === 2
          ? this.getCachedTypingTicket(params.toUserId)
          : await this.getTypingTicket({
              toUserId: params.toUserId,
              contextToken: params.contextToken,
            });
    }
    const fromCache = !explicit && Boolean(ticket);
    try {
      return await this.postTyping(params.toUserId, params.contextToken, status, ticket);
    } catch (err) {
      if (!fromCache) throw err;
      this.invalidateTypingTicket(params.toUserId);
      const fresh = await this.getTypingTicket({
        toUserId: params.toUserId,
        contextToken: params.contextToken,
        force: true,
      });
      if (!fresh || fresh === ticket) throw err;
      return this.postTyping(params.toUserId, params.contextToken, status, fresh);
    }
  }
  async startTyping(params: { toUserId: string; contextToken: string; typingTicket?: string }) {
    return this.sendTyping({ ...params, status: 1 });
  }
  async stopTyping(params: { toUserId: string; contextToken: string; typingTicket?: string }) {
    return this.sendTyping({ ...params, status: 2 });
  }
  private postTyping(
    toUserId: string,
    contextToken: string,
    status: TypingStatus,
    ticket: string | null,
  ) {
    const body: Record<string, unknown> = {
      ilink_user_id: toUserId,
      to_user_id: toUserId,
      context_token: contextToken,
      status,
    };
    if (ticket) body.typing_ticket = ticket;
    return this.postJson('/ilink/bot/sendtyping', body);
  }
  private rememberTypingTicket(toUserId: string, ticket: string) {
    const now = Date.now();
    if (this.typingTickets.size >= this.typingTicketMaxEntries) {
      for (const [k, v] of this.typingTickets) if (v.expiresAt <= now) this.typingTickets.delete(k);
      let toDrop = this.typingTickets.size - this.typingTicketMaxEntries + 1;
      if (toDrop > 0)
        for (const k of this.typingTickets.keys()) {
          this.typingTickets.delete(k);
          if (--toDrop <= 0) break;
        }
    }
    this.typingTickets.delete(toUserId);
    this.typingTickets.set(toUserId, { ticket, expiresAt: now + this.typingTicketTtlMs });
  }

  async getUploadUrl(params: {
    filekey: string;
    mediaType: UploadMediaType;
    toUserId: string;
    rawSize: number;
    rawFileMd5: string;
    fileSize: number;
    aesKeyHex: string;
    noNeedThumb?: boolean;
  }): Promise<GetUploadUrlResponse> {
    this.requireToken();
    return this.postJson<GetUploadUrlResponse>('/ilink/bot/getuploadurl', {
      filekey: params.filekey,
      media_type: params.mediaType,
      to_user_id: params.toUserId,
      rawsize: params.rawSize,
      rawfilemd5: params.rawFileMd5,
      filesize: params.fileSize,
      aeskey: params.aesKeyHex,
      no_need_thumb: params.noNeedThumb !== false,
      base_info: { channel_version: this.channelVersion },
    });
  }

  /** 加密并 POST 到微信 CDN；响应头 x-encrypted-param 即下载坐标。 */
  async uploadEncryptedToCdn(params: {
    plaintext: Buffer;
    aesKey: Buffer;
    filekey: string;
    uploadFullUrl?: string;
    uploadParam?: string;
  }): Promise<string> {
    const ciphertext = encryptAes128Ecb(params.plaintext, params.aesKey);
    let url: string | undefined;
    if (params.uploadFullUrl?.trim()) {
      const candidate = params.uploadFullUrl.trim();
      // 上传 URL 来自服务端响应而非自家配置，与入站媒体走同一主机白名单。
      if (
        !isAllowedMediaUrl(candidate, {
          cdnBaseUrl: this.cdnBaseUrl,
          extraHosts: this.mediaHostAllowlist,
        })
      )
        throw new ILinkError(`CDN upload URL host not allowed: ${ILinkClient.hostOf(candidate)}`);
      url = candidate;
    } else if (params.uploadParam) {
      url = buildCdnUploadUrl(this.cdnBaseUrl, params.uploadParam, params.filekey);
    }
    if (!url) throw new ILinkError('CDN upload URL missing (need upload_full_url or upload_param)');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      // 重定向可能跳到白名单没查过的主机，CDN 上传合法场景不需要重定向。
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: new Uint8Array(ciphertext),
        signal: ctrl.signal,
        redirect: 'error',
      });
      if (!res.ok) {
        const msg =
          res.headers.get('x-error-message') ||
          (await res.text().catch(() => '')) ||
          `HTTP ${res.status}`;
        throw new ILinkError(
          `CDN upload failed: ${msg}`,
          undefined,
          undefined,
          undefined,
          res.status,
        );
      }
      const dl = res.headers.get('x-encrypted-param');
      if (!dl) throw new ILinkError('CDN upload response missing x-encrypted-param');
      return dl;
    } catch (err) {
      if (err instanceof ILinkError) throw err;
      if (err instanceof Error && err.name === 'AbortError')
        throw new ILinkError(
          `CDN upload timed out after ${this.timeoutMs}ms`,
          undefined,
          undefined,
          {
            aborted: true,
          },
        );
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /** 取上传凭证 → 加密上传 → 下载坐标（供需要裸上传坐标的调用方使用）。 */
  async uploadMedia(params: {
    toUserId: string;
    data: Buffer;
    mediaType?: UploadMediaType;
  }): Promise<UploadedMedia> {
    const mediaType = params.mediaType ?? 1;
    if (!params.data?.length) throw new ILinkError('media buffer is empty');
    if (params.data.length > this.mediaMaxBytes)
      throw new ILinkError(`media too large: ${params.data.length} > ${this.mediaMaxBytes} bytes`);
    return this.uploadBytes(params.toUserId, params.data, mediaType);
  }

  async sendImage(params: {
    toUserId: string;
    contextToken: string;
    image: Buffer;
    clientId?: string;
  }): Promise<SendMessageResponse> {
    this.requireToken();
    if (!params.image?.length) throw new ILinkError('image buffer is empty');
    const uploaded = await this.uploadBytes(params.toUserId, params.image, UPLOAD_MEDIA_TYPE.image);
    const clientId =
      params.clientId ?? `wechat-ai-img-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    return this.postJson<SendMessageResponse>('/ilink/bot/sendmessage', {
      msg: {
        from_user_id: '',
        to_user_id: params.toUserId,
        client_id: clientId,
        message_type: 2,
        message_state: 2,
        context_token: params.contextToken,
        item_list: [
          {
            type: ITEM_TYPE.image,
            image_item: {
              media: {
                encrypt_query_param: uploaded.downloadEncryptedQueryParam,
                aes_key: encodeAesKeyField(uploaded.aesKey),
                encrypt_type: 1,
              },
              mid_size: uploaded.cipherSize,
            },
          },
        ],
      },
      base_info: { channel_version: this.channelVersion },
    });
  }

  /** 非图片媒体发送：itemType/itemField 显式传参，便于按真实抓包纠正
   *  推断的类型号而无需改代码。 */
  async sendMedia(params: {
    toUserId: string;
    contextToken: string;
    data: Buffer;
    mediaType: UploadMediaType;
    itemType: WeixinItemType;
    itemField: string;
    itemExtra?: Record<string, unknown>;
    clientId?: string;
  }): Promise<SendMessageResponse> {
    this.requireToken();
    if (!params.data?.length) throw new ILinkError(`${params.itemField} buffer is empty`);
    if (params.data.length > this.mediaMaxBytes)
      throw new ILinkError(`media too large: ${params.data.length} > ${this.mediaMaxBytes} bytes`);
    const uploaded = await this.uploadBytes(params.toUserId, params.data, params.mediaType);
    const clientId =
      params.clientId ??
      `wechat-ai-${params.itemField}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    return this.postJson<SendMessageResponse>('/ilink/bot/sendmessage', {
      msg: {
        from_user_id: '',
        to_user_id: params.toUserId,
        client_id: clientId,
        message_type: 2,
        message_state: 2,
        context_token: params.contextToken,
        item_list: [
          {
            type: params.itemType,
            [params.itemField]: {
              media: {
                encrypt_query_param: uploaded.downloadEncryptedQueryParam,
                aes_key: encodeAesKeyField(uploaded.aesKey),
                encrypt_type: 1,
              },
              mid_size: uploaded.cipherSize,
              ...(params.itemExtra ?? {}),
            },
          },
        ],
      },
      base_info: { channel_version: this.channelVersion },
    });
  }

  async sendVoice(params: {
    toUserId: string;
    contextToken: string;
    voice: Buffer;
    durationMs?: number;
    itemType?: WeixinItemType;
    clientId?: string;
  }): Promise<SendMessageResponse> {
    const itemExtra: Record<string, unknown> = {};
    if (typeof params.durationMs === 'number' && params.durationMs > 0) {
      const ms = Math.round(params.durationMs);
      itemExtra.duration_ms = ms;
      itemExtra.voice_length = ms;
    }
    return this.sendMedia({
      toUserId: params.toUserId,
      contextToken: params.contextToken,
      data: params.voice,
      mediaType: UPLOAD_MEDIA_TYPE.voice,
      itemType: params.itemType ?? ITEM_TYPE.voice,
      itemField: 'voice_item',
      itemExtra,
      clientId: params.clientId,
    });
  }
  async sendVideo(params: {
    toUserId: string;
    contextToken: string;
    video: Buffer;
    durationMs?: number;
    itemType?: WeixinItemType;
    clientId?: string;
  }) {
    const itemExtra: Record<string, unknown> = {};
    if (typeof params.durationMs === 'number' && params.durationMs > 0)
      itemExtra.duration_ms = Math.round(params.durationMs);
    return this.sendMedia({
      toUserId: params.toUserId,
      contextToken: params.contextToken,
      data: params.video,
      mediaType: UPLOAD_MEDIA_TYPE.video,
      itemType: params.itemType ?? ITEM_TYPE.video,
      itemField: 'video_item',
      itemExtra,
      clientId: params.clientId,
    });
  }
  async sendFile(params: {
    toUserId: string;
    contextToken: string;
    file: Buffer;
    fileName: string;
    itemType?: WeixinItemType;
    clientId?: string;
  }) {
    const name = params.fileName?.trim();
    if (!name) throw new ILinkError('fileName is required for sendFile');
    return this.sendMedia({
      toUserId: params.toUserId,
      contextToken: params.contextToken,
      data: params.file,
      mediaType: UPLOAD_MEDIA_TYPE.file,
      itemType: params.itemType ?? ITEM_TYPE.file,
      itemField: 'file_item',
      itemExtra: { file_name: name, file_size: params.file.length },
      clientId: params.clientId,
    });
  }

  /** 下载并解密一条入站附件。流式限量读取，Content-Length 只作参考。 */
  async downloadMedia(
    ref: InboundMediaRef,
    opts: { maxBytes?: number; signal?: AbortSignal } = {},
  ): Promise<DownloadedMedia> {
    const maxBytes = Math.max(1024, opts.maxBytes ?? this.mediaMaxBytes);
    if (ref.cipherSize && ref.cipherSize > maxBytes)
      throw new ILinkError(`media too large: ${ref.cipherSize} > ${maxBytes} bytes`);
    const fullUrlOk =
      Boolean(ref.fullUrl) &&
      isAllowedMediaUrl(ref.fullUrl!, {
        cdnBaseUrl: this.cdnBaseUrl,
        extraHosts: this.mediaHostAllowlist,
      });
    if (ref.fullUrl && !fullUrlOk && !ref.encryptQueryParam)
      throw new ILinkError(`media full_url host not allowed: ${ILinkClient.hostOf(ref.fullUrl)}`);
    const url = fullUrlOk
      ? ref.fullUrl!
      : ref.encryptQueryParam
        ? buildCdnDownloadUrl(this.cdnBaseUrl, ref.encryptQueryParam)
        : undefined;
    if (!url) throw new ILinkError('media ref has neither full_url nor encrypt_query_param');
    const raw = await this.fetchBounded(url, maxBytes, opts.signal);
    let data = raw;
    if (ref.aesKey && ref.encryptType !== 0) {
      try {
        data = decryptAes128Ecb(raw, parseAesKey(ref.aesKey));
      } catch (err) {
        // 个别载荷带着残留 aes_key 却是明文：只有确实嗅探出媒体形态才接受。
        if (!sniffMediaMime(raw))
          throw new ILinkError(`media decrypt failed: ${(err as Error).message}`);
        data = raw;
      }
    }
    return { kind: ref.kind, data, mime: sniffMediaMime(data), fileName: ref.fileName };
  }

  private async fetchBounded(url: string, maxBytes: number, signal?: AbortSignal): Promise<Buffer> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, ctrl.signal]) : ctrl.signal;
    try {
      // 不跟随重定向：只有第一个主机过了白名单。
      const res = await fetch(url, { method: 'GET', signal: combined, redirect: 'error' });
      if (!res.ok)
        throw new ILinkError(
          `CDN download failed: HTTP ${res.status}`,
          undefined,
          undefined,
          undefined,
          res.status,
        );
      const declared = Number(res.headers.get('content-length') ?? '');
      if (Number.isFinite(declared) && declared > maxBytes)
        throw new ILinkError(`media too large: ${declared} > ${maxBytes} bytes`);
      const body = res.body;
      if (!body) {
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > maxBytes)
          throw new ILinkError(`media too large: ${buf.length} > ${maxBytes} bytes`);
        return buf;
      }
      const reader = body.getReader();
      const chunks: Buffer[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => undefined);
          throw new ILinkError(`media too large: exceeded ${maxBytes} bytes`);
        }
        chunks.push(Buffer.from(value));
      }
      return Buffer.concat(chunks);
    } catch (err) {
      if (err instanceof ILinkError) throw err;
      if (signal?.aborted) throw err;
      if (err instanceof Error && err.name === 'AbortError')
        throw new ILinkError(
          `CDN download timed out after ${this.timeoutMs}ms`,
          undefined,
          undefined,
          {
            aborted: true,
          },
        );
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  private static hostOf(raw: string): string {
    try {
      return new URL(raw).hostname || '(none)';
    } catch {
      return '(unparseable)';
    }
  }
  private requireToken() {
    if (!this.botToken) throw new ILinkError('bot_token is required; complete QR login first');
  }

  /** 统一的上传路径：取凭证 → 加密上传 → 返回下载坐标。 */
  private async uploadBytes(
    toUserId: string,
    plaintext: Buffer,
    mediaType: UploadMediaType,
  ): Promise<UploadedMedia> {
    const aesKey = randomAesKey();
    const filekey = randomFileKey();
    const upload = await this.getUploadUrl({
      filekey,
      mediaType,
      toUserId,
      rawSize: plaintext.length,
      rawFileMd5: md5Hex(plaintext),
      fileSize: aesEcbPaddedSize(plaintext.length),
      aesKeyHex: aesKey.toString('hex'),
    });
    const downloadEncryptedQueryParam = await this.uploadEncryptedToCdn({
      plaintext,
      aesKey,
      filekey,
      uploadFullUrl: upload.upload_full_url,
      uploadParam: upload.upload_param,
    });
    return {
      filekey,
      downloadEncryptedQueryParam,
      aesKey,
      rawSize: plaintext.length,
      cipherSize: aesEcbPaddedSize(plaintext.length),
    };
  }

  /** 读响应不假设一定是 JSON：网关 502 常是 HTML、204 是空体。 */
  private async readJson<T>(res: Response): Promise<T> {
    let text: string;
    try {
      text = await res.text();
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') throw err;
      throw new ILinkError(
        `HTTP ${res.status} 响应读取失败`,
        undefined,
        undefined,
        undefined,
        res.status,
      );
    }
    if (!text.trim())
      throw new ILinkError(
        res.ok ? 'iLink 返回了空响应' : `HTTP ${res.status}`,
        undefined,
        undefined,
        undefined,
        res.status,
      );
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new ILinkError(
        res.ok ? 'iLink 返回了非 JSON 响应' : `HTTP ${res.status}`,
        undefined,
        undefined,
        text.slice(0, 300),
        res.status,
      );
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new ILinkError(
        res.ok ? 'iLink 返回了无效响应' : `HTTP ${res.status}`,
        undefined,
        undefined,
        parsed,
        res.status,
      );
    const data = parsed as T & { ret?: number; errcode?: number; errmsg?: string };
    if (!res.ok)
      throw new ILinkError(
        data.errmsg ?? `HTTP ${res.status}`,
        data.ret,
        data.errcode,
        data,
        res.status,
      );
    const ret = typeof data.ret === 'number' ? data.ret : 0;
    const errcode = typeof data.errcode === 'number' ? data.errcode : 0;
    if (ret !== 0 || errcode !== 0)
      throw new ILinkError(
        data.errmsg ?? `iLink ret=${ret} errcode=${errcode}`,
        data.ret,
        data.errcode,
        data,
        res.status,
      );
    return data;
  }

  private async getJson<T>(url: string, auth: boolean, timeoutMs = this.timeoutMs): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: buildILinkHeaders(auth ? this.botToken : undefined),
        signal: ctrl.signal,
      });
      return await this.readJson<T>(res);
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError')
        throw new ILinkError(`request timed out after ${timeoutMs}ms`, undefined, undefined, {
          aborted: true,
        });
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
  private async postJson<T>(path: string, body: unknown, timeoutMs = this.timeoutMs): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: buildILinkHeaders(this.botToken),
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      return await this.readJson<T>(res);
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError')
        throw new ILinkError(`request timed out after ${timeoutMs}ms`, undefined, undefined, {
          aborted: true,
        });
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}

// ---------- 扫码登录 ----------

export interface LoginResult {
  botToken: string;
  baseUrl?: string;
  accountId?: string;
  raw: QrcodeStatusResponse;
}
export interface LoginOptions {
  client?: ILinkClient;
  botType?: number;
  pollIntervalMs?: number;
  timeoutMs?: number;
  onQrcode?: (info: { qrcode: string; qrcodeImgContent?: string; qrcodeUrl?: string }) => void;
  onStatus?: (status: string, raw: QrcodeStatusResponse) => void;
  signal?: AbortSignal;
}

export function resolveQrOpenUrl(qr: QrcodeResponse): string | undefined {
  if (qr.qrcode_img_content?.startsWith('http')) return qr.qrcode_img_content;
  if (qr.qrcode_url?.startsWith('http')) return qr.qrcode_url;
  if (qr.qrcode)
    return `https://liteapp.weixin.qq.com/q/7GiQu1?qrcode=${encodeURIComponent(qr.qrcode)}&bot_type=3`;
  return undefined;
}

function loginSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new ILinkError('login aborted'));
    const onAbort = () => {
      clearTimeout(t);
      reject(new ILinkError('login aborted'));
    };
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** 交互式扫码登录；确认后返回 bot_token。 */
export async function loginWithQrcode(opts: LoginOptions = {}): Promise<LoginResult> {
  const client = opts.client ?? new ILinkClient();
  const pollIntervalMs = opts.pollIntervalMs ?? 1500;
  const timeoutMs = opts.timeoutMs ?? 5 * 60_000;
  const started = Date.now();
  const qr = await client.getBotQrcode(opts.botType ?? 3);
  if (!qr.qrcode)
    throw new ILinkError(qr.errmsg ?? 'get_bot_qrcode missing qrcode field', qr.ret, undefined, qr);
  opts.onQrcode?.({
    qrcode: qr.qrcode,
    qrcodeImgContent: qr.qrcode_img_content,
    qrcodeUrl: resolveQrOpenUrl(qr) ?? qr.qrcode_url,
  });
  for (;;) {
    if (opts.signal?.aborted) throw new ILinkError('login aborted');
    if (Date.now() - started > timeoutMs)
      throw new ILinkError('login timed out waiting for QR scan');
    let status: QrcodeStatusResponse;
    try {
      status = await client.getQrcodeStatus(qr.qrcode);
    } catch (err) {
      if (err instanceof ILinkError && (err.body as { aborted?: boolean })?.aborted) {
        opts.onStatus?.('waiting', { status: 'waiting' });
        continue;
      }
      if (err instanceof Error && /timed out|aborted|fetch failed|ECONNRESET/i.test(err.message)) {
        opts.onStatus?.('retry', { status: 'retry' });
        await loginSleep(pollIntervalMs, opts.signal);
        continue;
      }
      throw err;
    }
    const st = (status.status ?? '').toLowerCase();
    opts.onStatus?.(st || 'unknown', status);
    if (
      st === 'confirmed' ||
      st === 'confirmed_login' ||
      st === 'success' ||
      Boolean(status.bot_token)
    ) {
      if (!status.bot_token)
        throw new ILinkError('QR confirmed but bot_token missing', status.ret, undefined, status);
      if (status.baseurl) client.setBaseUrl(status.baseurl);
      client.setBotToken(status.bot_token);
      return {
        botToken: status.bot_token,
        baseUrl: status.baseurl,
        accountId: status.account_id ?? status.ilink_bot_id,
        raw: status,
      };
    }
    if (st === 'expired' || st === 'cancel' || st === 'cancelled')
      throw new ILinkError(`QR login ${st}`, status.ret, undefined, status);
    await loginSleep(Math.min(pollIntervalMs, 500), opts.signal);
  }
}
