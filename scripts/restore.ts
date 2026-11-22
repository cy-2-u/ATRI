// 从加密备份恢复：node scripts/restore.ts <备份.atri> <目标新目录> [backup-key.txt]
// 只恢复到不存在的新目录，绝不覆盖运行中的数据；确认后用 ATRI_DATA_DIR 指向新目录。
import { readFile } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { restoreArchive } from '../src/backup.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const archive = process.argv[2], target = process.argv[3];
const keyPath = process.argv[4] ?? join(root, 'data', 'backup-key.txt');
if (!archive || !target) {
  console.error('用法：node scripts/restore.ts <备份.atri> <目标新目录> [backup-key.txt 路径]');
  process.exit(2);
}
const bytes = await readFile(resolve(archive));
const key = Buffer.from((await readFile(resolve(keyPath), 'utf8')).trim(), 'hex');
await restoreArchive(bytes, key, resolve(target));
console.log(`已恢复到 ${resolve(target)}：数据库完整性已校验，backup-key.txt 一并写入新目录。`);
console.log('切换数据目录：ATRI_DATA_DIR=<新目录> 后重启。');
