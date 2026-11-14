import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Journal, type Bubble } from '../storage/journal.js';
import { Runtime } from '../runtime/runtime.js';
import { WechatClient, WechatError, wechatBase, messageKey, type WechatSession } from './client.js';
import {
  extractMediaRefs,
  extractText,
  isVisionMime,
  sniffMediaMime,
  type WeixinMessage as WechatMessage,
} from './media.js';
import type { Stickers } from '../stickers.js';
import type { Sandbox } from '../sandbox.js';

interface Contact {
  address: string;
  context: string;
  approved: boolean;
}

export interface BridgeDeps {
  stickers: Stickers;
  sandbox?: Sandbox;
  dataDir: string;
  vision(): boolean;
}

export class WechatBridge {
  private session?: WechatSession;
  private polling?: { controller: AbortController; promise: Promise<void> };
  private loginTask?: { controller: AbortController; promise: Promise<void> };
  private state: { status: string; qr?: string; error?: string; lastPollAt?: number } = {
    status: '未登录',
  };
  private runtime?: Runtime;
  private stopped = true;

  constructor(
    private readonly journal: Journal,
    private readonly onError: (error: unknown) => void,
    private readonly deps: BridgeDeps,
  ) {
    this.session = journal.setting<WechatSession | undefined>('wechat:session', undefined);
    if (this.session) this.state.status = '已连接';
  }

  status() {
    return { ...this.state };
  }
  contacts(): Contact[] {
    const account = this.session?.account ?? this.journal.setting('wechat:account', '');
    return account ? this.journal.setting<Contact[]>(`wechat:contacts:${account}`, []) : [];
  }
  private saveContacts(contacts: Contact[]): void {
    const account = this.session?.account ?? this.journal.setting('wechat:account', '');
    if (!account) throw new Error('微信账号尚未确定');
    this.journal.setSetting(`wechat:contacts:${account}`, contacts);
  }
  peer(address: string): string {
    const account = this.session?.account ?? this.journal.setting('wechat:account', '');
    if (!account) throw new Error('微信账号尚未确定');
    return `wechat:${account}:${address}`;
  }

  approve(address: string): void {
    const contacts = this.contacts();
    const contact = contacts.find((item) => item.address === address);
    if (!contact) throw new TypeError('联系人不存在');
    if (contacts.some((item) => item.approved && item.address !== address))
      throw new TypeError('当前已绑定另一位联系人');
    contact.approved = true;
    this.saveContacts(contacts);
    this.runtime?.schedule(this.peer(address), Date.now() + 10 * 60_000);
  }

  start(runtime: Runtime): void {
    this.runtime = runtime;
    this.stopped = false;
    this.startPoll();
  }

  private startPoll(): void {
    if (this.stopped || !this.session || this.polling) return;
    const controller = new AbortController();
    const session = this.session;
    const promise = Promise.resolve()
      .then(() => this.poll(session, controller.signal))
      .catch((error) => {
        if (!controller.signal.aborted) this.onError(error);
      })
      .finally(() => {
        this.polling = undefined;
        if (this.session && this.session !== session) this.startPoll();
      });
    this.polling = { controller, promise };
  }

  login(): void {
    if (this.loginTask) return;
    const controller = new AbortController();
    const promise = this.scanLogin(controller.signal)
      .catch((error) => {
        if (!controller.signal.aborted) {
          this.state = {
            status: this.session ? '已连接' : '登录失败',
            error: error instanceof Error ? error.message : '登录失败',
          };
        }
      })
      .finally(() => {
        this.loginTask = undefined;
      });
    this.loginTask = { controller, promise };
  }

  private async scanLogin(signal: AbortSignal): Promise<void> {
    const client = new WechatClient();
    this.state = { status: '正在获取二维码' };
    const qr = await client.qr(signal);
    if (typeof qr.qrcode !== 'string' || !qr.qrcode) throw new Error('微信未返回二维码');
    const content = qr.qrcode_url ?? qr.qrcode_img_content ?? qr.qrcode;
    if (typeof content !== 'string') throw new Error('微信二维码内容无效');
    this.state = { status: '等待扫码', qr: content };
    const deadline = Date.now() + 5 * 60_000;
    while (Date.now() < deadline) {
      signal.throwIfAborted();
      let result;
      try {
        result = await client.qrStatus(qr.qrcode, signal);
      } catch (error) {
        signal.throwIfAborted();
        if (!(error instanceof WechatError) || error.expired) throw error;
        await new Promise((resolve) => setTimeout(resolve, 1000));
        continue;
      }
      if (result.status === 'confirmed') {
        if (typeof result.bot_token !== 'string' || !result.bot_token)
          throw new Error('微信登录缺少令牌');
        const account = result.account_id ?? result.ilink_bot_id;
        if (typeof account !== 'string' || !account) throw new Error('微信登录缺少账号标识');
        const session: WechatSession = {
          token: result.bot_token,
          account,
          baseUrl: wechatBase(
            typeof result.baseurl === 'string' ? result.baseurl : 'https://ilinkai.weixin.qq.com',
          ),
        };
        signal.throwIfAborted();
        if (this.session && this.session.account !== account)
          this.journal.setSetting('wechat:contacts', []);
        this.journal.setSetting('wechat:session', session);
        this.journal.setSetting('wechat:account', account);
        this.session = session;
        this.state = { status: '已连接' };
        this.polling?.controller.abort();
        this.startPoll();
        return;
      }
      if (result.status === 'expired') throw new Error('二维码已过期');
      if (result.status === 'scanned') this.state = { ...this.state, status: '请在微信确认登录' };
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error('扫码登录超时');
  }

  async logout(): Promise<void> {
    this.loginTask?.controller.abort();
    this.polling?.controller.abort();
    this.session = undefined;
    this.journal.setSetting('wechat:session', null);
    this.state = { status: '未登录' };
    await Promise.allSettled([this.loginTask?.promise, this.polling?.promise]);
  }

  private async poll(session: WechatSession, signal: AbortSignal): Promise<void> {
    const client = new WechatClient(session);
    const key = `wechat:cursor:${session.account}`;
    while (!signal.aborted && this.session === session) {
      try {
        const cursor = this.journal.setting(key, '');
        const result = await client.updates(cursor, signal);
        signal.throwIfAborted();
        if (this.session !== session) return;
        if (result.msgs !== undefined && !Array.isArray(result.msgs))
          throw new Error('微信消息批次无效');
        for (const [index, message] of (result.msgs ?? []).entries())
          await this.receive(message, cursor, index);
        if (typeof result.get_updates_buf === 'string')
          this.journal.setSetting(key, result.get_updates_buf);
        this.state = {
          ...this.state,
          status: this.loginTask ? this.state.status : '已连接',
          lastPollAt: Date.now(),
        };
        if (!result.msgs?.length) await new Promise((resolve) => setTimeout(resolve, 250));
      } catch (error) {
        if (signal.aborted) return;
        if (error instanceof WechatError && error.expired) {
          this.session = undefined;
          this.journal.setSetting('wechat:session', null);
          this.state = { status: '登录已过期，请重新扫码' };
          return;
        }
        this.state = { ...this.state, status: '连接中断，正在重试' };
        this.onError(error);
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    }
  }

  /** 收到一条消息：文本 + 可下载媒体。图片下载落盘（data/media），供
   *  视觉注入与回看；下载不了的媒体如实标记。 */
  private async receive(message: WechatMessage, cursor: string, index: number): Promise<void> {
    if (
      !message ||
      message.message_type !== 1 ||
      message.group_id ||
      typeof message.from_user_id !== 'string' ||
      !message.from_user_id
    )
      return;
    const contacts = this.contacts();
    // 她只属于一个人：已绑定其他联系人时，后来者的消息直接忽略。
    if (contacts.some((contact) => contact.approved && contact.address !== message.from_user_id))
      return;
    let contact = contacts.find((contact) => contact.address === message.from_user_id);
    if (!contact) {
      contact = { address: message.from_user_id, context: '', approved: false };
      contacts.push(contact);
    }
    if (typeof message.context_token === 'string' && message.context_token)
      contact.context = message.context_token;
    this.saveContacts(contacts);
    if (!contact.approved) return;

    const refs = extractMediaRefs(message);
    const text =
      extractText(message) ||
      refs
        .map((ref) =>
          ref.kind === 'image'
            ? '[图片]'
            : ref.kind === 'voice'
              ? '[语音，微信未提供文字转写]'
              : `[${ref.kind}附件]`,
        )
        .join('\n');
    if (!text.trim()) return;

    const media: { path: string; mime: string }[] = [];
    const client = this.session ? new WechatClient(this.session) : undefined;
    for (const ref of refs.filter((item) => item.kind === 'image').slice(0, 2)) {
      if (!client) break;
      try {
        const downloaded = await client.downloadMedia(ref, { maxBytes: 5 * 1024 * 1024 });
        if (!isVisionMime(downloaded.mime)) continue;
        const dir = join(this.deps.dataDir, 'media');
        mkdirSync(dir, { recursive: true });
        const file = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${downloaded.mime!.split('/')[1]}`;
        writeFileSync(join(dir, file), downloaded.data);
        media.push({ path: `media/${file}`, mime: downloaded.mime! });
      } catch (error) {
        if (error instanceof WechatError && error.uncertain) this.onError(error);
      }
    }
    const content = media.length ? JSON.stringify({ text, media }) : text;
    const key = messageKey(message, cursor, index);
    this.runtime?.receive(this.peer(contact.address), key, content.slice(0, 12000));
  }

  /** 对方的"输入中"指示：气泡间隔期间的打字感。 */
  async composing(peer: string, active: boolean): Promise<void> {
    const contact = this.contacts().find(
      (item) => this.peer(item.address) === peer && item.approved,
    );
    if (!this.session || !contact?.context) return;
    await new WechatClient(this.session).typing(contact.address, contact.context, active);
  }

  async send(peer: string, part: Bubble): Promise<'sent' | 'unknown' | 'failed'> {
    const contact = this.contacts().find(
      (item) => this.peer(item.address) === peer && item.approved,
    );
    if (!this.session || !contact?.context) return 'failed';
    const client = new WechatClient(this.session);
    try {
      if (part.type === 'text')
        await client.sendText(contact.address, contact.context, part.text ?? '');
      else if (part.type === 'sticker')
        await client.sendImage(
          contact.address,
          contact.context,
          this.deps.stickers.bytes(part.slug ?? ''),
        );
      else {
        // 她沙箱里的真实文件：确定性失败（没开沙箱/没有这个文件/不是图片）
        // 重试无意义，判死；只有上传通道自身的错误保持不确定语义。
        if (!this.deps.sandbox?.enabled) throw new WechatError('沙箱未启用，图片发不出去', false);
        const file = await this.deps.sandbox.readFile(part.path ?? '', 5 * 1024 * 1024);
        const mime = sniffMediaMime(file.bytes);
        if (!mime?.startsWith('image/')) throw new WechatError(`不是图片文件：${part.path}`, false);
        await client.sendImage(contact.address, contact.context, file.bytes);
      }
      return 'sent';
    } catch (error) {
      this.onError(error);
      if (error instanceof WechatError) return error.uncertain ? 'unknown' : 'failed';
      return 'unknown';
    }
  }

  /** 读取收到的图片字节（视觉注入用）：路径限定在 data/media 内。 */
  readMedia(path: string, maxBytes: number): Buffer | undefined {
    if (!path.startsWith('media/') || path.includes('..')) return undefined;
    try {
      const bytes = readFileSync(join(this.deps.dataDir, path));
      return bytes.length <= maxBytes ? bytes : undefined;
    } catch {
      return undefined;
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.loginTask?.controller.abort();
    this.polling?.controller.abort();
    await Promise.allSettled([this.loginTask?.promise, this.polling?.promise]);
  }
}
