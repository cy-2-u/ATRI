import { statSync, readdirSync, readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { WebDavConfig } from './settings.js';

/** WebDAV 每日备份：数据库快照（gzip）+ 自定义表情目录，PUT 到远端
 *  atri-backup/<日期戳>/，保留最近 KEEP 份，旧目录自动删除。
 *  客户端手写（fetch + Basic auth）：WebDAV 只有五个动词，不为此引依赖。
 *  失败不静默：状态与错误存进 state，管理页可见、可手动重试。 */

const KEEP = 30;
const RETRIES = 2;
const RETRY_DELAY_MS = 5000;
const TIMEOUT_MS = 60_000;
/** 失败后的重试冷却：地址填错时 10 分钟一查会变成 144 次失败/天。 */
const FAIL_COOLDOWN_MS = 3_600_000;

/** 时区感知的本地日期戳（en-CA = YYYY-MM-DD）：同一份日期只备一次。 */
function dayKeyOf(now: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** 本地时钟的小时数（0–23）：备份定在凌晨 4 点后第一个 tick。 */
function hourOf(now: number, timeZone: string): number {
  return Number(
    new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour: '2-digit',
      hourCycle: 'h23',
    }).format(new Date(now)),
  );
}

export interface BackupState {
  /** 上次成功备份的日期戳；从未成功为 undefined。 */
  at?: string;
  /** 上次失败的原因与日期；成功后清空。 */
  error?: string;
  failedAt?: string;
}

export class WebDavBackup {
  #state: BackupState = {};
  #lastDay: string | undefined;
  #lastFailAt = 0;

  constructor(
    private readonly dataDir: string,
    private readonly config: () => WebDavConfig | undefined,
    private readonly timeZone: () => string,
    private readonly log: (line: string) => void = console.log,
    /** 沙箱根（Docker 里是独立卷 /sandbox，不在 dataDir 下）：作品目录。 */
    private readonly sandboxDir?: string,
  ) {}

  get state(): BackupState {
    return { ...this.#state };
  }

  get configured(): boolean {
    const cfg = this.config();
    return Boolean(cfg?.url && cfg.password);
  }

  /** 每日闸门：凌晨 4 点后、同一本地日期只备一次。进程重启后首拍会补上
   *  当天缺的备份；失败进入冷却（一小时后下一个 tick 再试）。 */
  async tick(now: number): Promise<BackupState> {
    if (!this.configured) return this.#state;
    const day = dayKeyOf(now, this.timeZone());
    if (day === this.#lastDay) return this.#state;
    if (hourOf(now, this.timeZone()) < 4) return this.#state;
    if (now - this.#lastFailAt < FAIL_COOLDOWN_MS) return this.#state;
    try {
      await this.run(now, day);
      this.#lastDay = day;
      this.#state = { at: day };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // 失败保留旧的 at（历史备份还在远端），错误单独记账。
      this.#lastFailAt = now;
      this.#state = { at: this.#state.at, error: message, failedAt: day };
      this.log(`[atri] backup failed: ${message}`);
    }
    return this.#state;
  }

  /** 立即备份：管理页按钮调用，绕过每日闸门；成功即记当日已备。 */
  async run(now: number, day = dayKeyOf(now, this.timeZone())): Promise<void> {
    const cfg = this.config();
    if (!cfg?.url || !cfg.password) throw new Error('WebDAV 未配置');
    const auth = `Basic ${Buffer.from(`${cfg.user}:${cfg.password}`).toString('base64')}`;
    const base = `${cfg.url.replace(/\/+$/, '')}/atri-backup/${day}/`;
    // MKCOL 405 = 目录已存在，幂等不算失败。
    for (const dir of [`${cfg.url.replace(/\/+$/, '')}/atri-backup/`, base])
      await this.request('MKCOL', dir, auth).catch((error) => {
        if (!String(error.message).includes('HTTP 405')) throw error;
      });

    // 数据库：先 checkpoint 把 wal 并回主库，拷贝即完整一致快照；
    // checkpoint 被并发阻塞时照抄主库再补传 wal，副本靠 wal 自恢复。
    // close 放 finally：连接失败也不能把句柄漏在进程里。
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(join(this.dataDir, 'atri.db'));
      db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    } catch {
      /* 繁忙：退回主库 + wal 分别上传 */
    } finally {
      db?.close();
    }
    await this.request(
      'PUT',
      `${base}atri.db.gz`,
      auth,
      gzipSync(readFileSync(join(this.dataDir, 'atri.db'))),
    );
    try {
      await this.request(
        'PUT',
        `${base}atri.db-wal.gz`,
        auth,
        gzipSync(readFileSync(join(this.dataDir, 'atri.db-wal'))),
      );
    } catch {
      /* checkpoint 成功后 wal 常不存在，缺文件不是问题 */
    }

    // 自定义表情：逐文件上传（Node 无内置 zip，不为此引依赖）。
    const custom = join(this.dataDir, 'custom');
    if (statSync(custom, { throwIfNoEntry: false })?.isDirectory())
      for (const name of readdirSync(custom)) {
        const file = join(custom, name);
        if (statSync(file).isFile())
          await this.request('PUT', `${base}custom/${name}`, auth, readFileSync(file));
      }

    // 她的作品：墙图（仅图文件）与沙箱目录整棵逐文件上传。数据库之外
    // 唯一不可再生的东西——日记和画挂在卷上，卷挂了就永远没了。递归
    // 上限两层，media/（微信缓存）不算作品不进来。
    for (const [name, root, depth] of [
      ['wall', join(this.dataDir, 'wall'), 1],
      ['sandbox', this.sandboxDir ?? join(this.dataDir, 'sandbox'), 2],
    ] as const) {
      if (!statSync(root, { throwIfNoEntry: false })?.isDirectory()) continue;
      await this.putTree(`${base}${name}/`, root, auth, depth);
    }

    // 清理失败不影响备份成败：坚果云这类网盘不支持删非空目录，内容
    // 已经安全上传，轮转留到下一天再说。
    try {
      await this.prune(auth);
    } catch (error) {
      this.log(`[atri] backup prune skipped: ${error instanceof Error ? error.message : error}`);
    }
    // 手动备份也算当日已备：状态更新 + 闸门记账（前端"备份完成"直接读它）。
    this.#lastDay = day;
    this.#state = { at: day };
    this.log(`[atri] backup ok: ${day}`);
  }

  /** 递归上传一棵目录树：relative 路径即远端路径，目录原样镜像。
   *  depth 限制递归层数（1 = 只收平铺文件），防止异常嵌套拖爆请求。 */
  private async putTree(remote: string, root: string, auth: string, depth: number): Promise<void> {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      const full = join(root, entry.name);
      if (entry.isDirectory()) {
        if (depth > 1) await this.putTree(`${remote}${entry.name}/`, full, auth, depth - 1);
        continue;
      }
      await this.request('PUT', `${remote}${entry.name}`, auth, readFileSync(full));
    }
  }

  /** WebDAV 只认 2xx：3xx 不能当成功——fetch 对 PUT 的 301/302 会转成
   *  GET 跟随，内容根本没上传却拿到 200；manual 模式把重定向如实交回
   *  来当错误。body 必须消费（cancel 也算），否则连接池被占住。 */
  private async request(method: string, url: string, auth: string, body?: Buffer): Promise<void> {
    let lastError: Error = new Error('未知错误');
    for (let attempt = 0; attempt <= RETRIES; attempt++) {
      try {
        const res = await fetch(url, {
          method,
          headers: { authorization: auth },
          ...(body ? { body: new Uint8Array(body) } : {}),
          redirect: 'manual',
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        await res.body?.cancel().catch(() => undefined);
        if (res.status >= 200 && res.status < 300) return;
        lastError = new Error(`${method} ${new URL(url).pathname} → HTTP ${res.status}`);
        if (res.status < 500) break; // 4xx/3xx 重试无意义
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
      if (attempt < RETRIES) await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    }
    throw lastError;
  }

  /** 保留最近 KEEP 份：PROPFIND 列日期目录，超出的逐个 DELETE。
   *  列不出来就不删——备份比清理金贵。 */
  private async prune(auth: string): Promise<void> {
    const url = this.config()!.url.replace(/\/+$/, '');
    const res = await fetch(`${url}/atri-backup/`, {
      method: 'PROPFIND',
      headers: { authorization: auth, depth: '1' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return;
    const xml = await res.text();
    // 只认响应里的日期戳目录：正则钉死 YYYY-MM-DD，误删面为零。
    const days = [...xml.matchAll(/atri-backup\/(\d{4}-\d{2}-\d{2})/g)]
      .map((m) => m[1]!)
      .filter((day, i, all) => all.indexOf(day) === i)
      .sort();
    for (const old of days.slice(0, Math.max(0, days.length - KEEP)))
      // 单目录删除失败不中断轮转：有些网盘不删非空目录，逐个尽力而为。
      await this.request('DELETE', `${url}/atri-backup/${old}/`, auth).catch(() => undefined);
  }
}
