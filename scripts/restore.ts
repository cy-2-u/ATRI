import { mkdirSync, copyFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 从 backup.ts 产物恢复数据目录：目标必须是空库（避免覆盖更活的现在）。 */

const dataDir = resolve(
  process.env.XING_DATA_DIR || join(resolve(dirname(fileURLToPath(import.meta.url))), '..', 'data'),
);
const fromDir = resolve(process.argv[2] || '');
if (!fromDir || statSync(fromDir, { throwIfNoEntry: false })?.isDirectory() !== true) {
  console.error('用法：node restore.mjs <备份目录>');
  process.exit(1);
}
if (statSync(join(dataDir, 'atri.db'), { throwIfNoEntry: false })) {
  console.error('拒绝恢复：数据目录里已有 atri.db。确认放弃现有数据后先删除它。');
  process.exit(1);
}
mkdirSync(dataDir, { recursive: true });
copyFileSync(join(fromDir, 'atri.db'), join(dataDir, 'atri.db'));
const custom = join(fromDir, 'custom');
if (statSync(custom, { throwIfNoEntry: false })?.isDirectory())
  copyDir(custom, join(dataDir, 'custom'));
console.log(`restore ok: ${fromDir} → ${dataDir}`);

function copyDir(from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    if (entry.isDirectory()) copyDir(join(from, entry.name), join(to, entry.name));
    else copyFileSync(join(from, entry.name), join(to, entry.name));
  }
}
