import { mkdirSync, copyFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 冷备份数据目录：数据库文件与自定义表情。用途：换机、升级前留后路。
 *  恢复见 restore.ts。 */

const dataDir = resolve(
  process.env.XING_DATA_DIR || join(resolve(dirname(fileURLToPath(import.meta.url))), '..', 'data'),
);
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = resolve(process.argv[2] || join(dataDir, 'backups', stamp));

mkdirSync(outDir, { recursive: true });
copyFileSync(join(dataDir, 'atri.db'), join(outDir, 'atri.db'));
for (const extra of ['atri.db-wal', 'atri.db-shm'] as const) {
  try {
    copyFileSync(join(dataDir, extra), join(outDir, extra));
  } catch {
    /* 检查点后可能不存在 */
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
