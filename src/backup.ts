import { statSync, readdirSync, readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { WebDavConfig } from './settings.js';

/** WebDAV 每日备份：数据库快照（gzip）+ 自定义表情 + 她的作品（墙图与
 *  沙箱整棵），PUT 到远端 atri-backup/<日期戳>/，保留最近 KEEP 份。
 *  轮转按本地记录的日期清单做乐观 DELETE（有的网盘 PROPFIND 不可用，
 *  记录法不依赖列目录）。客户端手写（fetch + Basic auth）：WebDAV 只有
 *  五个动词，不为此引依赖。失败不静默：状态与错误存进 state，管理页
 *  可见、可手动重试。 */

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
  /** 作品文件数上限：超过就明确报错中止，绝不静默截断——ok:true 的
   *  时候备份必须是完整的。 */
  static MAX_FILES = 2000;
  #state: BackupState = {};
  #lastDay: string | undefined;
  #lastFailAt = 0;
  #running = false;

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

  /** 立即备份：管理页按钮调用，绕过每日闸门；成功即记当日已备。
   *  重入拒绝：定时 tick 与手动按钮可能撞车，第二个人明确收到
   *  "备份正在进行中"，而不是两路交错上传。 */
  async run(now: number, day = dayKeyOf(now, this.timeZone())): Promise<void> {
    if (this.#running) throw new Error('备份正在进行中，稍等它跑完');
    this.#running = true;
    try {
      await this.runOnce(day);
    } finally {
      this.#running = false;
    }
  }

  private async runOnce(day: string): Promise<void> {
    const cfg = this.config();
    if (!cfg?.url || !cfg.password) throw new Error('WebDAV 未配置');
    const auth = `Basic ${Buffer.from(`${cfg.user}:${cfg.password}`).toString('base64')}`;
    const base = `${cfg.url.replace(/\/+$/, '')}/atri-backup/${day}/`;
    // MKCOL 405 = 目录已存在，幂等不算失败。
    for (const dir of [`${cfg.url.replace(/\/+$/, '')}/atri-backup/`, base])
      await this.mkcol(dir, auth);
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
    // 子目录先 MKCOL（405=已存在，幂等）：网盘对未建目录的 PUT 回 409。
    const custom = join(this.dataDir, 'custom');
    if (statSync(custom, { throwIfNoEntry: false })?.isDirectory()) {
      await this.mkcol(`${base}custom/`, auth);
      for (const name of readdirSync(custom)) {
        const file = join(custom, name);
        if (statSync(file).isFile())
          await this.request('PUT', `${base}custom/${name}`, auth, readFileSync(file));
      }
    }

    // 她的作品：墙图（平铺）与沙箱目录整棵逐文件上传。数据库之外唯一
    // 不可再生的东西——日记和画挂在卷上，卷挂了就永远没了。文件总数
    // 超上限明确报错：ok:true 的备份必须是完整的，绝不静默截断。
    // media/（微信缓存）不算作品不进来。
    const trees: { remote: string; files: { rel: string; full: string }[] }[] = [];
    let total = 0;
    for (const [name, root] of [
      ['wall', join(this.dataDir, 'wall')],
      ['sandbox', this.sandboxDir ?? join(this.dataDir, 'sandbox')],
    ] as const) {
      if (!statSync(root, { throwIfNoEntry: false })?.isDirectory()) continue;
      const files = this.listFiles(root);
      total += files.length;
      trees.push({ remote: `${base}${name}/`, files });
    }
    if (total > WebDavBackup.MAX_FILES)
      throw new Error(
        `作品文件过多（${total} > ${WebDavBackup.MAX_FILES}），备份中止：请清理沙箱或调低作品量`,
      );
    for (const tree of trees) await this.putTree(tree.remote, tree.files, auth);

    // 轮转由网盘服务端做（写入后扫日期目录，保留最近 KEEP 份）：客户端
    // 不再自作轮转——完整信息在存储侧，客户端换机也不丢轮转语义。
    // 服务端能力上线前的过渡期无轮转（每日多 ~4MB，无害）。

    // 清理失败不影响备份成败：内容已经安全上传。
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

  /** 收集一棵目录树的全部普通文件（无限深度，深层嵌套照样备份）。
   *  符号链接一律跳过：沙箱里的链接指向哪不受控，readFileSync 顺着走
   *  会把沙箱外的东西（数据库、密钥）原样传去网盘。 */
  private listFiles(root: string): { rel: string; full: string }[] {
    const out: { rel: string; full: string }[] = [];
    const walk = (dir: string, rel: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        const childRel = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(full, childRel);
        else if (entry.isFile()) out.push({ rel: childRel, full });
      }
    };
    walk(root, '');
    return out;
  }

  /** 镜像一棵文件清单：清单里的相对路径即远端路径。每个子目录先
   *  MKCOL：网盘对"父目录存在但子目录未建"的 PUT 回 409（RFC 4918
   *  标准语义），先建目录是客户端本分。405 = 目录已存在，幂等不算
   *  失败——每天重复建零成本。 */
  private async putTree(
    remote: string,
    files: { rel: string; full: string }[],
    auth: string,
  ): Promise<void> {
    await this.mkcol(remote, auth);
    const made = new Set<string>();
    for (const { rel, full } of files) {
      const cut = rel.lastIndexOf('/');
      if (cut > 0) {
        const parts = rel.slice(0, cut).split('/');
        for (let i = 1; i <= parts.length; i++) {
          const path = parts.slice(0, i).join('/');
          if (made.has(path)) continue;
          await this.mkcol(`${remote}${path}/`, auth);
          made.add(path);
        }
      }
      await this.request('PUT', `${remote}${rel}`, auth, readFileSync(full));
    }
  }

  /** MKCOL 包装：405 = 已存在（幂等），其余错误如实抛。 */
  private async mkcol(url: string, auth: string): Promise<void> {
    await this.request('MKCOL', url, auth).catch((error) => {
      if (!String(error.message).includes('HTTP 405')) throw error;
    });
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

  /** 标准网盘的轮转：PROPFIND 列日期目录，超出 KEEP 的逐个 DELETE。
   *  自家网盘（w.webav）PROPFIND 不可用，轮转由它的服务端在写入后做
   *  （保留最近 KEEP 份，语义与此处一致）——这里列不出来就静默跳过，
   *  备份比清理金贵。服务端轮转覆盖后此方法可整体退役。 */
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
