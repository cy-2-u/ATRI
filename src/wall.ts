import { mkdirSync, writeFileSync, statSync, readdirSync } from 'node:fs';
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
  private static readonly IMAGE_QUOTA = 20 * 1024 * 1024;

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
  }

  /** 墙图库的当前字节数：直接量目录（配额是磁盘事实，不是行元数据）。 */
  private imageBytes(): number {
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
      const used = this.imageBytes();
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
