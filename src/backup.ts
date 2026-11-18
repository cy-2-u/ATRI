import { statSync, readdirSync, readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { WebDavConfig } from './settings.js';

/** WebDAV 每日备份：数据库快照（gzip）+ 自定义表情目录，PUT 到远端
 *  atri-backup/<日期戳>/，保留最近 KEEP 份，旧目录自动删除。
 *  客户端手写（fetch + Basic auth）：WebDAV 只有五个动词，不为此引依赖。
 *  失败不静默：状态与错误存进 lastBackup，管理页可见、可手动重试。 */

const KEEP = 30;
const RETRIES = 2;
const TIMEOUT_MS = 60_000;

/** 时区感知的本地日期戳（en-CA = YYYY-MM-DD）：同一份日期只备一次。 */
function dayKeyOf(now: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
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

  constructor(
    private readonly dataDir: string,
    private readonly config: () => WebDavConfig | undefined,
    private readonly timeZone: () => string,
    private readonly log: (line: string) => void = console.log,
  ) {}

  get state(): BackupState {
    return { ...this.#state };
  }

  get configured(): boolean {
    const cfg = this.config();
    return Boolean(cfg?.url && cfg.password);
  }

  /** 每日闸门：同一本地日期只备一次。进程重启后首拍会补上当天缺的备份。 */
  async tick(now: number, force = false): Promise<BackupState> {
    if (!this.configured) return this.#state;
    const day = dayKeyOf(now, this.timeZone());
    if (day === this.#lastDay && !force) return this.#state;
    try {
      await this.run(now, day);
      this.#lastDay = day;
      this.#state = { at: day };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // 失败保留旧的 at（历史备份还在远端），错误单独记账。
      this.#state = { at: this.#state.at, error: message, failedAt: day };
      this.log(`[atri] backup failed: ${message}`);
    }
    return this.#state;
  }

  /** 立即备份：管理页按钮调用，绕过每日闸门。 */
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

    await this.prune(auth);
    this.log(`[atri] backup ok: ${day}`);
  }

  private async request(method: string, url: string, auth: string, body?: Buffer): Promise<void> {
    let lastError: Error = new Error('未知错误');
    for (let attempt = 0; attempt <= RETRIES; attempt++) {
      try {
        const res = await fetch(url, {
          method,
          headers: { authorization: auth },
          ...(body ? { body: new Uint8Array(body) } : {}),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (res.status < 400) return;
        lastError = new Error(`${method} ${new URL(url).pathname} → HTTP ${res.status}`);
        if (res.status < 500) break; // 4xx 重试无意义
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
      if (attempt < RETRIES) await new Promise((r) => setTimeout(r, 5000));
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
      await this.request('DELETE', `${url}/atri-backup/${old}/`, auth);
  }
}
