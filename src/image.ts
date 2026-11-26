import { sniffMediaMime } from './wechat/media.js';
import { isPrivateHostLiteral } from './net.js';

/** OpenAI 兼容 images/generations 客户端：她的画笔。画好的字节由工具
 *  落进沙箱 pictures/，之后的路（image 气泡 → readFile → 微信图片通道）
 *  早已存在。任何失败如实抛错——画不成就说画不成，不编造。 */

/** 微信图片通道的实践上限，与 sendImage 一致。 */
const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
/** 画图比聊天慢得多（10–60s 常见），单独给足两分钟。 */
const PAINT_TIMEOUT_MS = 120_000;

export class ImagePainter {
  constructor(
    private readonly getConfig: () => {
      engine?: 'gpt' | 'nai';
      baseUrl?: string;
      apiKey?: string;
      model?: string;
      nai?: { baseUrl: string; apiKey: string; model: string; steps: number };
    },
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  get configured(): boolean {
    const c = this.getConfig();
    if (c.engine === 'nai') return !!(c.nai?.model && c.nai.apiKey && c.nai.baseUrl);
    return !!(c.model && c.apiKey && c.baseUrl);
  }

  /** 当前引擎：draw_image 的提示词教学随它切换（danbooru tag vs 自然语言）。 */
  get engine(): 'gpt' | 'nai' {
    return this.getConfig().engine === 'nai' ? 'nai' : 'gpt';
  }

  async paint(
    prompt: string,
    signal?: AbortSignal,
  ): Promise<{ bytes: Buffer; ext: string; mime: string }> {
    const c = this.getConfig();
    // NAI 引擎走自己的凭据组；gpt/未指定走主凭据组（旧配置兼容）。
    const nai = c.engine === 'nai';
    const baseUrl = nai ? c.nai?.baseUrl : c.baseUrl;
    const apiKey = nai ? c.nai?.apiKey : c.apiKey;
    const model = nai ? c.nai?.model : c.model;
    if (!model || !apiKey || !baseUrl)
      throw new Error(
        nai
          ? 'NAI 画图渠道未配置，请在管理页填写 NAI 模型与密钥'
          : '画笔尚未配置，请在管理页填写画图模型与密钥',
      );
    const trimmed = prompt.trim();
    if (!trimmed || trimmed.length > 4000)
      throw new TypeError('画图描述必须是一段不超过 4000 字的文本');
    const base = baseUrl.replace(/\/+$/, '').replace(/\/images\/generations$/, '');
    const endpoint = `${/\/v\d+$/.test(base) ? base : `${base}/v1`}/images/generations`;
    const timeout = AbortSignal.timeout(PAINT_TIMEOUT_MS);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    // NAI 免费档硬收口：单张、纯文生图、步数 28 封顶（超出按全价计费），
    // 采样参数钉住 beta 实测稳定组合。GPT 系不带 response_format：
    // gpt-image 只回 b64 且拒绝多余参数；NAI 明确要 b64_json。
    const body: Record<string, unknown> = nai
      ? {
          model,
          prompt: trimmed,
          n: 1,
          response_format: 'b64_json',
          parameters: {
            steps: Math.min(28, Math.max(1, Math.round(c.nai?.steps ?? 28))),
            cfg_scale: 6,
            sampler: 'k_dpmpp_2m_sde',
            noise_schedule: 'karras',
          },
        }
      : { model, prompt: trimmed, n: 1 };
    const response = await this.fetcher(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: combined,
    });
    if (!response.ok) {
      const body = (await response.text().catch(() => '')).slice(0, 200);
      throw new Error(`画图失败（HTTP ${response.status}）：${body}`);
    }
    let data: { data?: { b64_json?: string; url?: string }[] };
    try {
      data = JSON.parse(await response.text()) as typeof data;
    } catch {
      throw new Error('画图服务返回了无效 JSON');
    }
    const item = data.data?.[0];
    if (!item) throw new Error('画图服务没有返回图片');
    let bytes: Buffer | undefined;
    if (item.b64_json) bytes = Buffer.from(item.b64_json, 'base64');
    else if (item.url) bytes = await this.download(item.url, signal);
    if (!bytes?.length) throw new Error('画图返回了空图片');
    const mime = sniffMediaMime(bytes);
    if (!mime?.startsWith('image/')) throw new Error('画图返回的不是图片文件');
    if (bytes.length > IMAGE_MAX_BYTES)
      throw new Error(
        `图片超过 ${Math.round(IMAGE_MAX_BYTES / 1024 / 1024)} MB 上限（实际 ${Math.round(bytes.length / 1024 / 1024)} MB），发不出去`,
      );
    return { bytes, ext: mime.split('/')[1]!, mime };
  }

  /** url 响应分支的下载：只拦私网字面量与奇怪协议——上游是已鉴权的画图
   *  服务，不是任意外部链接（开放网页那条完整防线在 web.ts）。 */
  private async download(url: string, signal?: AbortSignal): Promise<Buffer> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error('画图服务返回了无效图片地址');
    }
    if (
      !['http:', 'https:'].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      isPrivateHostLiteral(parsed.hostname)
    )
      throw new Error('图片地址不在允许范围');
    const timeout = AbortSignal.timeout(PAINT_TIMEOUT_MS);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const response = await this.fetcher(url, { signal: combined, redirect: 'error' });
    if (!response.ok) throw new Error(`图片下载失败（HTTP ${response.status}）`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > 2 * IMAGE_MAX_BYTES) throw new Error('图片下载超过大小上限');
    return bytes;
  }
}
