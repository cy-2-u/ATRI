import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { ILinkClient, ILinkError, loginWithQrcode } from '../ilink/client.js';
import { extractText, extractMediaRefs, isUserInbound, isVisionMime } from '../ilink/media.js';
import type { WeixinMessage, InboundMediaRef } from '../ilink/types.js';
import { DeliveryError, type Runtime, type Transport } from '../core/index.js';
import type { Store, Peer, ReplyPart, Message, Media } from '../db/index.js';
import type { Settings } from './config.js';
import type { Stickers } from './stickers.js';

/** 微信桥：ilink 协议事件 ↔ Runtime。扫码登录、长轮询收件、文本/表情
 *  发送、图片下载转 data URI。 */

interface Session {
  botToken: string;
  baseUrl: string;
  accountId: string;
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

/** 入站事件键：稳定 ID 优先；缺失时由发送方/时间/正文/媒体构成指纹，
 *  这种协议输入下无法保证跨批次严格去重。 */
export function inboundKey(message: WeixinMessage, cursor: string, index: number): string {
  const stable = message.message_id ?? message.msg_id ?? message.id;
  if (typeof stable === 'string' || typeof stable === 'number') return `id:${stable}`;
  const refs = extractMediaRefs(message).map((r) => ({
    kind: r.kind,
    index: r.index,
    aesKey: r.aesKey,
    encryptQueryParam: r.encryptQueryParam,
    fileName: r.fileName,
  }));
  return hash(
    JSON.stringify([
      message.from_user_id,
      message.to_user_id,
      message.create_time_ms ?? `batch:${cursor}:${index}`,
      message.message_type,
      extractText(message),
      refs,
    ]),
  );
}

export class WeChatBridge implements Transport {
  private running = false;
  private runtime?: Runtime;
  private client?: ILinkClient;
  private loginController?: AbortController;
  private session?: Session;
  private state: {
    status: string;
    qrContent?: string;
    error?: string;
    lastPollAt?: number;
    accountId?: string;
  } = { status: '未登录' };

  constructor(
    private readonly store: Store,
    private readonly settings: Settings,
    private readonly stickers: Stickers,
    private readonly log: (message: string) => void = () => {},
  ) {
    const session = store.getSetting<Session | null>('wechat:session', null);
    if (session) this.useSession(session);
  }
  private useSession(session: Session) {
    this.session = session;
    this.client = new ILinkClient({
      botToken: session.botToken,
      baseUrl: session.baseUrl,
      timeoutMs: 20000,
      longPollTimeoutMs: 40000,
      mediaMaxBytes: 5 * 1024 * 1024,
    });
    this.state = { status: '已连接', accountId: session.accountId };
  }
  status() {
    return { ...this.state };
  }
  start(runtime: Runtime) {
    if (this.running) return;
    this.runtime = runtime;
    this.running = true;
    void this.poll();
  }
  stop() {
    this.running = false;
    this.loginController?.abort();
  }
  login() {
    if (this.loginController && !this.loginController.signal.aborted) return this.status();
    this.logout();
    const controller = new AbortController();
    this.loginController = controller;
    this.state = { status: '正在获取二维码' };
    void loginWithQrcode({
      client: new ILinkClient({ baseUrl: this.settings.ilinkBase() }),
      signal: controller.signal,
      onQrcode: (qr) => {
        if (!controller.signal.aborted)
          this.state = {
            status: '等待扫码',
            qrContent: qr.qrcodeUrl ?? qr.qrcodeImgContent ?? qr.qrcode,
          };
      },
      onStatus: (status) => {
        if (!controller.signal.aborted && status === 'scanned')
          this.state = { ...this.state, status: '请在微信确认登录' };
      },
    })
      .then((result) => {
        if (controller.signal.aborted) return;
        const accountId = result.accountId || String(result.raw.ilink_bot_id ?? '');
        if (!accountId) throw new Error('微信登录响应缺少账号标识');
        const session = {
          botToken: result.botToken,
          baseUrl: result.baseUrl || this.settings.ilinkBase(),
          accountId,
        };
        this.store.setSetting('wechat:session', session);
        this.useSession(session);
        this.loginController = undefined;
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          this.state = {
            status: '登录失败',
            error: error instanceof Error ? error.message : '登录失败',
          };
          this.loginController = undefined;
        }
      });
    return this.status();
  }
  logout() {
    this.loginController?.abort();
    this.client = undefined;
    this.session = undefined;
    this.store.removeSetting('wechat:session');
    this.state = { status: '未登录' };
  }

  private async poll() {
    while (this.running) {
      const client = this.client,
        session = this.session;
      if (!client || !session) {
        await pause(1000);
        continue;
      }
      const cursorKey = `wechat:cursor:${session.accountId}`;
      const cursor = this.store.getSetting<string>(cursorKey, '');
      try {
        const result = await client.getUpdates(cursor);
        if (!this.running) return;
        if (this.session !== session) continue;
        if (result.errcode && result.errcode !== 0)
          throw new ILinkError(result.errmsg ?? '微信接口返回错误', result.ret, result.errcode);
        for (const [index, message] of (result.msgs ?? []).entries())
          this.receive(session.accountId, message, cursor, index);
        if (typeof result.get_updates_buf === 'string')
          this.store.setSetting(cursorKey, result.get_updates_buf);
        this.state = { status: '已连接', accountId: session.accountId, lastPollAt: Date.now() };
        if (!result.msgs?.length) await pause(250);
      } catch (error) {
        if (!this.running) return;
        if (this.session !== session) continue;
        if (
          error instanceof ILinkError &&
          (error.ret === -14 ||
            error.errcode === -14 ||
            // 过期 token 可能表现为裸 HTTP 鉴权失败：当临时断连重试会让
            // 它永远卡在"正在重试"。
            error.httpStatus === 401 ||
            error.httpStatus === 403)
        ) {
          this.client = undefined;
          this.session = undefined;
          this.store.removeSetting('wechat:session');
          this.state = { status: '登录已过期，请重新扫码' };
        } else {
          this.state = {
            ...this.state,
            status: '连接中断，正在重试',
            error: error instanceof Error ? error.message : '连接失败',
          };
          this.log('微信轮询暂时失败');
          await pause(3000);
        }
      }
    }
  }

  receive(accountId: string, message: WeixinMessage, cursor: string, index: number) {
    if (!isUserInbound(message) || message.group_id || !message.from_user_id) return;
    const address = message.from_user_id,
      peerId = `wechat:${accountId}:${address}`;
    this.store.ensurePeer(
      peerId,
      'wechat',
      address,
      message.context_token ?? '',
      this.settings.allowedPeers().has(address),
    );
    const refs = extractMediaRefs(message);
    const text =
      extractText(message) ||
      refs
        .map((r) =>
          r.kind === 'image'
            ? '[图片]'
            : r.kind === 'voice'
              ? '[语音，微信未提供文字转写]'
              : `[${r.kind}附件]`,
        )
        .join('\n');
    if (!text.trim()) return;
    const media: Media[] = refs.map((ref) => ({
      kind: ref.kind,
      ref,
      ...(ref.transcript ? { description: ref.transcript } : {}),
    }));
    const timestamp =
      typeof message.create_time_ms === 'number' &&
      Number.isFinite(message.create_time_ms) &&
      message.create_time_ms > 0 &&
      message.create_time_ms <= Date.now() + 300000
        ? message.create_time_ms
        : Date.now();
    this.runtime!.accept(
      peerId,
      inboundKey(message, cursor, index),
      text.slice(0, 12000),
      media,
      timestamp,
    );
  }

  async typing(peer: Peer, active: boolean) {
    if (peer.channel !== 'wechat' || !this.client || !peer.context_token) return;
    const params = { toUserId: peer.address, contextToken: peer.context_token };
    if (active) await this.client.startTyping(params);
    else await this.client.stopTyping(params);
  }

  async send(peer: Peer, part: ReplyPart, clientId: string) {
    if (peer.channel === 'preview') return;
    if (!this.client || !this.session || !peer.id.startsWith(`wechat:${this.session.accountId}:`))
      throw new DeliveryError('微信账号未连接或与会话不匹配', true);
    if (!peer.context_token)
      throw new DeliveryError('缺少微信会话凭据，请让联系人先发来消息', true);
    try {
      const params = { toUserId: peer.address, contextToken: peer.context_token, clientId };
      if (part.type === 'sticker')
        await this.client.sendImage({ ...params, image: this.stickers.bytes(part.slug!) });
      else await this.client.sendText({ ...params, text: part.text! });
    } catch (error) {
      if (error instanceof ILinkError) {
        const status = error.httpStatus;
        // 408/429 明确可重试：把一切 4xx 当确定性失败会让被限流的气泡
        // 直接判死并卡住队列。
        const permanentStatus =
          status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 429;
        throw new DeliveryError(
          error.message,
          (error.ret !== undefined && error.ret !== 0) ||
            (error.errcode !== undefined && error.errcode !== 0) ||
            permanentStatus ||
            /^HTTP (?!408|429)4\d\d$/.test(error.message),
        );
      }
      throw error;
    }
  }

  /** 读取消息里的图片为 data URI（最多两张）。视觉未开时如实写"未开启"
   *  而不是返回空列表——提示词要求她对看不到的图坦白，没有信号时臆造
   *  描述会成为最可能的路径，而臆造会被存档、被检索。 */
  async images(message: Message, signal?: AbortSignal): Promise<string[]> {
    signal?.throwIfAborted();
    if (!this.settings.config().vision) {
      const media = message.media.map((item) =>
        item.kind === 'image' && !item.description
          ? { ...item, description: '图片识别未开启，无法看到画面内容' }
          : item,
      );
      if (media.some((m, i) => m.description !== message.media[i]!.description))
        this.store.updateMedia(message.peer_id, message.id, media);
      return [];
    }
    const images: string[] = [],
      media = [...message.media];
    let changed = false;
    for (let i = 0; i < media.length && images.length < 2; i++) {
      signal?.throwIfAborted();
      const item = { ...media[i]! };
      if (item.kind !== 'image') continue;
      try {
        let bytes: Buffer;
        if (item.path) {
          const path = resolve(this.settings.dataDir, item.path);
          if (!path.startsWith(resolve(this.settings.dataDir) + sep))
            throw new Error('附件路径无效');
          const stat = lstatSync(path);
          if (!stat.isFile() || stat.size > 5 * 1024 * 1024)
            throw new Error('附件不是可读取的图片文件');
          bytes = readFileSync(path);
        } else {
          if (!this.client || !item.ref) throw new Error('当前无法读取图片');
          const downloaded = await this.client.downloadMedia(item.ref as InboundMediaRef, {
            maxBytes: 5 * 1024 * 1024,
            signal,
          });
          if (!isVisionMime(downloaded.mime)) throw new Error('不支持的图片格式');
          bytes = downloaded.data;
          item.mime = downloaded.mime!;
          item.path = `media/${message.id}-${i}.${item.mime.split('/')[1]}`;
          mkdirSync(join(this.settings.dataDir, 'media'), { recursive: true });
          writeFileSync(join(this.settings.dataDir, item.path), bytes);
          changed = true;
        }
        if (bytes.length > 5 * 1024 * 1024) throw new Error('图片过大');
        if (item.mime && isVisionMime(item.mime))
          images.push(`data:${item.mime};base64,${bytes.toString('base64')}`);
      } catch (error) {
        if (signal?.aborted) throw error;
        if (!item.description) {
          item.description = '图片目前无法读取，尚未识别画面内容';
          changed = true;
        }
      }
      media[i] = item;
    }
    if (changed) this.store.updateMedia(message.peer_id, message.id, media);
    return images;
  }
}
function pause(ms: number) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}
