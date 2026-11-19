import { mkdirSync, writeFileSync, statSync, readdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type { Sandbox } from './sandbox.js';

/** 留言墙：她 publish、他直接写，免登录公开页。图片从沙箱快照进
 *  wall 目录（沙箱文件删了墙上的不丢）；总量限容防灌水。 */
export interface WallNote {
  id: string;
  from: 'her' | 'him';
  text: string;
  image?: string;
  at: number;
}

export class Wall {
  private readonly imageDir: string;
  private readonly insert: StatementSync;
  private readonly recent: StatementSync;
  private readonly query: StatementSync;
  private readonly unseen: StatementSync;
  private readonly latestHim: StatementSync;
  private readonly byId: StatementSync;
  private readonly getSeen: StatementSync;
  private readonly setSeen: StatementSync;
  private static readonly IMAGE_QUOTA = 20 * 1024 * 1024;
  private static readonly SEEN_KEY = 'wall:seen';

  constructor(
    sql: DatabaseSync,
    dataDir: string,
    private readonly now: () => number = Date.now,
  ) {
    this.imageDir = join(dataDir, 'wall');
    mkdirSync(this.imageDir, { recursive: true });
    this.insert = sql.prepare(
      'INSERT INTO kernel_wall(id,author,text,image,created_at) VALUES(?,?,?,?,?)',
    );
    this.recent = sql.prepare(
      'SELECT id,author AS "from",text,image AS image,created_at AS at FROM kernel_wall ORDER BY created_at DESC, rowid DESC LIMIT 200',
    );
    // 便签的按需翻阅：过滤与限量下推到 SQL——read_wall 每次调用只付
    // 它翻的那几条，墙再热也不拖累别处的查询。from 不带 = 双方都要。
    this.query = sql.prepare(
      `SELECT id,author AS "from",text,image AS image,created_at AS at
       FROM kernel_wall
       WHERE created_at >= ? AND (? IS NULL OR author = ?)
       ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    );
    this.unseen = sql.prepare(
      "SELECT COUNT(*) AS n FROM kernel_wall WHERE author = 'him' AND created_at > ?",
    );
    this.latestHim = sql.prepare(
      "SELECT created_at AS at, text FROM kernel_wall WHERE author = 'him' ORDER BY created_at DESC LIMIT 1",
    );
    this.byId = sql.prepare(
      'SELECT id,author AS "from",text,image AS image,created_at AS at FROM kernel_wall WHERE id = ?',
    );
    // 她上次"凑近看墙"的时刻（kernel_settings）：提示牌与 read_wall 共用。
    this.getSeen = sql.prepare('SELECT value FROM kernel_settings WHERE key = ?');
    this.setSeen = sql.prepare(
      'INSERT INTO kernel_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    );
  }

  /** 墙图库的当前字节数：直接量目录（配额是磁盘事实，不是行元数据）。 */
  private imageDirBytes(): number {
    let total = 0;
    for (const name of readdirSync(this.imageDir)) {
      try {
        total += statSync(join(this.imageDir, name)).size;
      } catch {
        /* 竞态删除跳过 */
      }
    }
    return total;
  }

  list(): WallNote[] {
    return (this.recent.all() as unknown as WallNote[]).map((note) => ({
      ...note,
      image: note.image || undefined,
      text: note.text || '',
    }));
  }

  /** 按需翻阅（read_wall 的数据面）：作者过滤 + 时间下界 + 限量全在 SQL 里。 */
  notes(options: { from?: 'him' | 'her'; since?: number; limit?: number }): WallNote[] {
    const from = options.from === 'her' || options.from === 'him' ? options.from : null;
    const since = typeof options.since === 'number' && options.since >= 0 ? options.since : 0;
    const limit =
      typeof options.limit === 'number' && Number.isInteger(options.limit)
        ? Math.min(Math.max(options.limit, 1), 20)
        : 10;
    return (this.query.all(since, from, from, limit) as unknown as WallNote[]).map((note) => ({
      ...note,
      image: note.image || undefined,
      text: note.text || '',
    }));
  }

  /** 单张便签全量（read_wall {id}）：不存在返回 undefined。 */
  note(id: string): WallNote | undefined {
    if (typeof id !== 'string' || !id) return undefined;
    const row = this.byId.get(id) as unknown as WallNote | undefined;
    return row ? { ...row, image: row.image || undefined, text: row.text || '' } : undefined;
  }

  /** 他贴的、她还没"凑近看过"的数量与最近一条预览（材料提示牌的数据面）。 */
  unseenByHim(): { count: number; latest?: { text: string; at: number } } {
    const n = (this.unseen.get(this.seenAt()) as { n: number }).n;
    const latest = this.latestHim.get() as { at: number; text: string } | undefined;
    return {
      count: n,
      latest:
        latest && latest.at > this.seenAt() ? { text: latest.text, at: latest.at } : undefined,
    };
  }

  /** 墙图快照进沙箱（read_wall {id} 看图用）：图在 wall 目录，读字节即可。 */
  imageBytes(name: string): Uint8Array | undefined {
    const file = this.imageFile(name);
    return file ? readFileSync(file) : undefined;
  }

  /** 她上次凑近看墙的时刻：read_wall 每次调用后推进——提示牌据此清零。 */
  markSeen(): void {
    this.setSeen.run(Wall.SEEN_KEY, JSON.stringify(this.now()));
  }

  private seenAt(): number {
    const row = this.getSeen.get(Wall.SEEN_KEY) as { value: string } | undefined;
    const at = row ? JSON.parse(row.value) : 0;
    return typeof at === 'number' && at >= 0 ? at : 0;
  }

  /** 发一条：图片必须是沙箱里的真实文件，快照进 wall 目录（随机名防碰撞）。
   *  墙总图片量超配额时拒新图（文字永远可写）。 */
  async post(
    from: 'her' | 'him',
    text: string,
    sandboxPath?: string,
    sandbox?: Sandbox,
  ): Promise<WallNote> {
    const trimmed = text.trim().slice(0, 500);
    if (!trimmed && !sandboxPath) throw new TypeError('留言不能全空');
    let image: string | undefined;
    if (sandboxPath) {
      if (!sandbox) throw new TypeError('没有沙箱文件可发布');
      const file = await sandbox.readFile(sandboxPath, 5 * 1024 * 1024);
      if (!file.bytes.subarray(0, 8).toString('hex').startsWith('89504e470d0a1a0a'))
        throw new TypeError('只能发布 PNG 图片');
      const used = this.imageDirBytes();
      if (used + file.bytes.length > Wall.IMAGE_QUOTA)
        throw new Error('墙的图库满了，先清理旧画再发新的');
      image = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}.png`;
      writeFileSync(join(this.imageDir, image), file.bytes);
    }
    const note: WallNote = {
      id: randomUUID(),
      from,
      text: trimmed,
      ...(image ? { image } : {}),
      at: this.now(),
    };
    this.insert.run(note.id, note.from, note.text, note.image ?? null, note.at);
    return note;
  }

  imageFile(name: string): string | undefined {
    // 白名单字符 + 必须真实存在：防路径穿越与任意文件读。
    if (!/^[\w-]+\.png$/.test(name)) return undefined;
    const target = join(this.imageDir, name);
    try {
      return statSync(target).isFile() ? target : undefined;
    } catch {
      return undefined;
    }
  }

  totalImages(): number {
    return readdirSync(this.imageDir).length;
  }
}
