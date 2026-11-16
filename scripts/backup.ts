import { mkdirSync, copyFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

/** 冷备份数据目录：数据库快照 + 自定义表情。用途：换机、升级前留后路、
 *  每日例行。恢复见 restore.ts。
 *
 *  WAL 模式下直接 copyFileSync 主文件，可能拿到与 wal 对不上的不一致
 *  快照。先在独立连接上做 checkpoint(TRUNCATE)：把 wal 全部并回主库并
 *  截断 wal 文件，随后的主库拷贝自然是某一时刻的完整状态；checkpoint
 *  被并发读阻塞失败时仍照抄 wal/shm，副本靠 wal 恢复，两头都不吃亏。 */

const dataDir = resolve(
  process.env.ATRI_DATA_DIR || join(resolve(dirname(fileURLToPath(import.meta.url))), '..', 'data'),
);
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = resolve(process.argv[2] || join(dataDir, 'backups', stamp));

mkdirSync(outDir, { recursive: true });
const source = join(dataDir, 'atri.db');
if (!statSync(source, { throwIfNoEntry: false })) {
  console.error(`未找到数据库：${source}`);
  process.exit(1);
}
try {
  const db = new DatabaseSync(source);
  db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
  db.close();
  copyFileSync(source, join(outDir, 'atri.db'));
} catch {
  // checkpoint 失败（并发繁忙等）：退回整套文件拷贝，副本带 wal 自恢复。
  copyFileSync(source, join(outDir, 'atri.db'));
  for (const extra of ['atri.db-wal', 'atri.db-shm'] as const) {
    try {
      copyFileSync(join(dataDir, extra), join(outDir, extra));
    } catch {
      /* 检查点后可能不存在 */
    }
  }
}
const custom = join(dataDir, 'custom');
if (statSync(custom, { throwIfNoEntry: false })?.isDirectory())
  copyDir(custom, join(outDir, 'custom'));
console.log(`backup ok: ${outDir}`);

function copyDir(from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    if (entry.isDirectory()) copyDir(join(from, entry.name), join(to, entry.name));
    else copyFileSync(join(from, entry.name), join(to, entry.name));
  }
}
