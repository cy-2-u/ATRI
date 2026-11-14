import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomInt,
  randomUUID,
} from 'node:crypto';
import {
  ITEM_TYPE,
  UPLOAD_MEDIA_TYPE,
  isAllowedMediaUrl,
  type DownloadedMedia,
  type UploadMediaType,
  sniffMediaMime,
  type InboundMediaRef,
  type WeixinMessage,
} from './media.js';

export interface WechatSession {
  token: string;
  baseUrl: string;
  account: string;
}

const DEFAULT_CDN = 'https://novac2c.cdn.weixin.qq.com/c2c';
/** typing_ticket 约 24 小时有效，取 20 小时留余量。 */
const TYPING_TICKET_TTL_MS = 20 * 60 * 60 * 1000;
const MEDIA_MAX_BYTES = 12 * 1024 * 1024;

interface Reply {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  typing_ticket?: string;
  upload_full_url?: string;
  upload_param?: string;
  [key: string]: unknown;
}

export class WechatError extends Error {
  constructor(
    message: string,
    readonly uncertain: boolean,
    readonly expired = false,
  ) {
    super(message);
    this.name = 'WechatError';
  }
}

export function wechatBase(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
    throw new TypeError('微信服务地址无效');
  if (url.hostname !== 'ilinkai.weixin.qq.com' && !url.hostname.endsWith('.weixin.qq.com'))
    throw new TypeError('微信服务主机无效');
  return url.toString().replace(/\/+$/, '');
}

// ---------- CDN 媒体加密（微信图片通道：AES-128-ECB + c2c CDN） ----------

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
const md5Hex = (buf: Buffer) => createHash('md5').update(buf).digest('hex');
const aesEcbPaddedSize = (size: number) => Math.ceil((size + 1) / 16) * 16;
const randomAesKey = () => randomBytes(16);
const randomFileKey = () => randomBytes(16).toString('hex');
/** 出站 image_item 的 aes_key：base64(16 字节密钥的 32 位 hex 文本)。 */
const encodeAesKeyField = (aesKey: Buffer) =>
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
const cdnUploadUrl = (cdn: string, uploadParam: string, filekey: string) =>
  `${cdn.replace(/\/$/, '')}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`;
const cdnDownloadUrl = (cdn: string, encryptedQueryParam: string) =>
  `${cdn.replace(/\/$/, '')}/download?encrypted_query_param=${encodeURIComponent(encryptedQueryParam)}`;

export class WechatClient {
  /** typing_ticket 单缓存：联系人是个位数，无需淘汰（TTL 读时判定）。 */
  private typingTicket?: { ticket: string; expiresAt: number };
  private refreshedTicket = false;

  constructor(
    private readonly session?: WechatSession,
    private readonly fetcher: typeof fetch = fetch,
    private readonly cdnBaseUrl: string = DEFAULT_CDN,
  ) {}

  private async request(
    path: string,
    body: unknown,
    signal?: AbortSignal,
    sending = false,
    timeoutMs = 40_000,
  ): Promise<Reply> {
    signal?.throwIfAborted();
    const base = wechatBase(this.session?.baseUrl ?? 'https://ilinkai.weixin.qq.com');
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const response = await this.fetcher(`${base}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        redirect: 'error',
        signal: combined,
        headers: {
          'content-type': 'application/json',
          AuthorizationType: 'ilink_bot_token',
          // 随机 X-WECHAT-UIN（uint32 十进制文本再 base64，逐请求防重放）。
          'X-WECHAT-UIN': Buffer.from(String(randomInt(0, 0xffffffff)), 'utf8').toString('base64'),
          ...(this.session ? { Authorization: `Bearer ${this.session.token}` } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new WechatError(
          `微信接口 HTTP ${response.status}`,
          sending && response.status >= 500,
          response.status === 401 || response.status === 403,
        );
      }
      const reader = response.body?.getReader();
      if (!reader) throw new WechatError('微信接口响应为空', sending);
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > 4 * 1024 * 1024) {
            await reader.cancel();
            throw new WechatError('微信接口响应过大', sending);
          }
          chunks.push(chunk.value);
        }
      } finally {
        reader.releaseLock();
      }
      const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        throw new WechatError('微信接口响应无效', sending);
      const value = parsed as Reply;
      if (
        (value.ret !== undefined && value.ret !== 0) ||
        (value.errcode !== undefined && value.errcode !== 0)
      )
        throw new WechatError(
          '微信接口拒绝请求',
          false,
          value.ret === -14 || value.errcode === -14,
        );
      return value;
    } catch (error) {
      if (error instanceof WechatError) throw error;
      if (!sending) signal?.throwIfAborted();
      throw new WechatError(timeout.aborted ? '微信接口超时' : '微信接口连接失败', sending);
    }
  }

  qr(signal?: AbortSignal): Promise<Reply> {
    return this.request('/ilink/bot/get_bot_qrcode?bot_type=3', undefined, signal);
  }

  qrStatus(code: string, signal?: AbortSignal): Promise<Reply> {
    return this.request(
      `/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(code)}`,
      undefined,
      signal,
      false,
      90_000,
    );
  }

  updates(
    cursor: string,
    signal?: AbortSignal,
  ): Promise<Reply & { msgs?: WeixinMessage[]; get_updates_buf?: string }> {
    if (!this.session) throw new WechatError('微信尚未登录', false);
    return this.request(
      '/ilink/bot/getupdates',
      { get_updates_buf: cursor, base_info: { channel_version: '1.0.2' } },
      signal,
    );
  }

  async sendText(
    address: string,
    context: string,
    text: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!this.session || !address || !context || !text.trim())
      throw new WechatError('微信发送缺少必要上下文', false);
    await this.request(
      '/ilink/bot/sendmessage',
      {
        msg: {
          from_user_id: '',
          to_user_id: address,
          client_id: `xing-${randomUUID()}`,
          message_type: 2,
          message_state: 2,
          context_token: context,
          item_list: [{ type: ITEM_TYPE.text, text_item: { text } }],
        },
        base_info: { channel_version: '1.0.2' },
      },
      signal,
      true,
      20_000,
    );
  }

  // ---------- typing 指示 ----------

  /** 会话级 typing ticket：缓存 20 小时，过期重取一次；重取仍失败就放弃——
   *  指示是装饰，不能挡住真消息。 */
  private async ticket(signal?: AbortSignal): Promise<string | undefined> {
    const cached = this.typingTicket;
    if (cached && cached.expiresAt > Date.now()) return cached.ticket;
    if (this.refreshedTicket) return undefined;
    this.refreshedTicket = true;
    try {
      const reply = await this.request(
        '/ilink/bot/getconfig',
        { base_info: { channel_version: '1.0.2' } },
        signal,
        false,
        15_000,
      );
      if (typeof reply.typing_ticket === 'string' && reply.typing_ticket) {
        this.typingTicket = {
          ticket: reply.typing_ticket,
          expiresAt: Date.now() + TYPING_TICKET_TTL_MS,
        };
        return this.typingTicket.ticket;
      }
    } catch {
      // 拿不到 ticket 就不显示"输入中"。
    }
    return undefined;
  }

  /** 1 开始"对方正在输入中"，2 清除。 */
  async typing(
    address: string,
    context: string,
    active: boolean,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!this.session || !address || !context) return;
    const ticket = active ? await this.ticket(signal) : undefined;
    try {
      await this.request(
        '/ilink/bot/sendtyping',
        {
          ilink_user_id: address,
          to_user_id: address,
          context_token: context,
          status: active ? 1 : 2,
          ...(ticket ? { typing_ticket: ticket } : {}),
        },
        signal,
        false,
        10_000,
      );
    } catch {
      // 指示失败静默：真消息没有理由因为装饰失败而不发。
    }
  }

  // ---------- 图片通道 ----------

  private requireSession(): WechatSession {
    if (!this.session) throw new WechatError('微信尚未登录', false);
    return this.session;
  }

  /** 加密并 POST 到微信 CDN；响应头 x-encrypted-param 即下载坐标。
   *  上传 URL 来自服务端响应而非自家配置，走与入站媒体同一主机白名单；
   *  重定向可能跳到白名单没查过的主机，CDN 上传合法场景不需要重定向。 */
  private async uploadToCdn(params: {
    plaintext: Buffer;
    aesKey: Buffer;
    filekey: string;
    uploadFullUrl?: string;
    uploadParam?: string;
    signal?: AbortSignal;
  }): Promise<string> {
    const ciphertext = encryptAes128Ecb(params.plaintext, params.aesKey);
    let url: string | undefined;
    if (params.uploadFullUrl?.trim()) {
      const candidate = params.uploadFullUrl.trim();
      if (!isAllowedMediaUrl(candidate, { cdnBaseUrl: this.cdnBaseUrl }))
        throw new WechatError('CDN 上传地址不在白名单内', false);
      url = candidate;
    } else if (params.uploadParam) {
      url = cdnUploadUrl(this.cdnBaseUrl, params.uploadParam, params.filekey);
    }
    if (!url) throw new WechatError('微信未返回上传坐标', false);
    const timeout = AbortSignal.timeout(30_000);
    const combined = params.signal ? AbortSignal.any([params.signal, timeout]) : timeout;
    try {
      const res = await this.fetcher(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: new Uint8Array(ciphertext),
        signal: combined,
        redirect: 'error',
      });
      if (!res.ok) {
        const msg = res.headers.get('x-error-message') || `HTTP ${res.status}`;
        throw new WechatError(`CDN 上传失败：${msg}`, res.status >= 500);
      }
      const dl = res.headers.get('x-encrypted-param');
      if (!dl) throw new WechatError('CDN 上传响应缺少下载坐标', false);
      return dl;
    } catch (error) {
      if (error instanceof WechatError) throw error;
      if (params.signal?.aborted) throw params.signal.reason;
      throw new WechatError(timeout.aborted ? 'CDN 上传超时' : 'CDN 上传连接失败', true);
    }
  }

  private async uploadBytes(
    toUserId: string,
    plaintext: Buffer,
    mediaType: UploadMediaType,
    signal?: AbortSignal,
  ): Promise<{ downloadParam: string; aesKey: Buffer; cipherSize: number }> {
    this.requireSession();
    const aesKey = randomAesKey();
    const filekey = randomFileKey();
    const upload = await this.request(
      '/ilink/bot/getuploadurl',
      {
        filekey,
        media_type: mediaType,
        to_user_id: toUserId,
        rawsize: plaintext.length,
        rawfilemd5: md5Hex(plaintext),
        filesize: aesEcbPaddedSize(plaintext.length),
        aeskey: aesKey.toString('hex'),
        no_need_thumb: true,
        base_info: { channel_version: '1.0.2' },
      },
      signal,
      true,
    );
    const downloadParam = await this.uploadToCdn({
      plaintext,
      aesKey,
      filekey,
      uploadFullUrl:
        typeof upload.upload_full_url === 'string' ? upload.upload_full_url : undefined,
      uploadParam: typeof upload.upload_param === 'string' ? upload.upload_param : undefined,
      signal,
    });
    return { downloadParam, aesKey, cipherSize: aesEcbPaddedSize(plaintext.length) };
  }

  /** 发一张图片（表情与沙箱产物共用）：5MB 是微信图片通道的实践上限。 */
  async sendImage(
    address: string,
    context: string,
    image: Buffer,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!this.session || !address || !context)
      throw new WechatError('微信发送缺少必要上下文', false);
    if (!image?.length) throw new WechatError('图片内容为空', false);
    if (image.length > 5 * 1024 * 1024)
      throw new WechatError(
        `图片超过 5 MB 上限（${Math.round(image.length / 1024 / 1024)} MB）`,
        false,
      );
    const uploaded = await this.uploadBytes(address, image, UPLOAD_MEDIA_TYPE.image, signal);
    await this.request(
      '/ilink/bot/sendmessage',
      {
        msg: {
          from_user_id: '',
          to_user_id: address,
          client_id: `xing-${randomUUID()}`,
          message_type: 2,
          message_state: 2,
          context_token: context,
          item_list: [
            {
              type: ITEM_TYPE.image,
              image_item: {
                media: {
                  encrypt_query_param: uploaded.downloadParam,
                  aes_key: encodeAesKeyField(uploaded.aesKey),
                  encrypt_type: 1,
                },
                mid_size: uploaded.cipherSize,
              },
            },
          ],
        },
        base_info: { channel_version: '1.0.2' },
      },
      signal,
      true,
      20_000,
    );
  }

  /** 下载并解密一条入站附件。流式限量读取，不跟随重定向（只有第一个主机过了白名单）。 */
  async downloadMedia(
    ref: InboundMediaRef,
    opts: { maxBytes?: number; signal?: AbortSignal } = {},
  ): Promise<DownloadedMedia> {
    const maxBytes = Math.max(1024, opts.maxBytes ?? MEDIA_MAX_BYTES);
    if (ref.cipherSize && ref.cipherSize > maxBytes) throw new WechatError('附件过大', false);
    const fullUrlOk =
      Boolean(ref.fullUrl) && isAllowedMediaUrl(ref.fullUrl!, { cdnBaseUrl: this.cdnBaseUrl });
    if (ref.fullUrl && !fullUrlOk && !ref.encryptQueryParam)
      throw new WechatError('附件地址不在白名单内', false);
    const url = fullUrlOk
      ? ref.fullUrl!
      : ref.encryptQueryParam
        ? cdnDownloadUrl(this.cdnBaseUrl, ref.encryptQueryParam)
        : undefined;
    if (!url) throw new WechatError('附件缺少下载坐标', false);
    const timeout = AbortSignal.timeout(30_000);
    const combined = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
    let raw: Buffer;
    try {
      const res = await this.fetcher(url, { method: 'GET', signal: combined, redirect: 'error' });
      if (!res.ok) throw new WechatError(`CDN 下载失败：HTTP ${res.status}`, res.status >= 500);
      const declared = Number(res.headers.get('content-length') ?? '');
      if (Number.isFinite(declared) && declared > maxBytes)
        throw new WechatError('附件过大', false);
      const body = res.body;
      if (!body) {
        raw = Buffer.from(await res.arrayBuffer());
        if (raw.length > maxBytes) throw new WechatError('附件过大', false);
      } else {
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
            throw new WechatError('附件过大', false);
          }
          chunks.push(Buffer.from(value));
        }
        raw = Buffer.concat(chunks);
      }
    } catch (error) {
      if (error instanceof WechatError) throw error;
      if (opts.signal?.aborted) throw opts.signal.reason;
      throw new WechatError('附件下载失败', true);
    }
    let data = raw;
    if (ref.aesKey && ref.encryptType !== 0) {
      try {
        data = decryptAes128Ecb(raw, parseAesKey(ref.aesKey));
      } catch {
        // 个别载荷带着残留 aes_key 却是明文：只有确实嗅探出媒体形态才接受。
        if (!sniffMediaMime(raw)) throw new WechatError('附件解密失败', false);
        data = raw;
      }
    }
    return { kind: ref.kind, data, mime: sniffMediaMime(data), fileName: ref.fileName };
  }
}

export function messageKey(message: WeixinMessage, cursor: string, index: number): string {
  const stable = message.message_id ?? message.msg_id ?? message.id;
  return typeof stable === 'string' || typeof stable === 'number'
    ? `id:${stable}`
    : `h:${createHash('sha256')
        .update(
          JSON.stringify([
            message.from_user_id,
            message.create_time_ms ?? `${cursor}:${index}`,
            message.item_list,
          ]),
        )
        .digest('hex')
        .slice(0, 24)}`;
}
