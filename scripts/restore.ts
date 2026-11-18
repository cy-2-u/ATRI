import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  copyFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 从 backup.ts 产物恢复数据目录：目标必须是空库（避免覆盖更活的现在）。
 *  云端备份是 gzip（atri.db.gz）：给 .gz 就地解压，下载下来不必再手动
 *  gunzip；.db-wal.gz 恢复时不需要（checkpoint 后的干净快照即可）。 */

const dataDir = resolve(
  process.env.ATRI_DATA_DIR || join(resolve(dirname(fileURLToPath(import.meta.url))), '..', 'data'),
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
restoreFile('atri.db');
const custom = join(fromDir, 'custom');
if (statSync(custom, { throwIfNoEntry: false })?.isDirectory())
  copyDir(custom, join(dataDir, 'custom'));
console.log(`restore ok: ${fromDir} → ${dataDir}`);

/** 优先 .gz（自动解压，gzip 魔数 1f 8b 防误命名），退回同名裸文件。 */
function restoreFile(name: string): void {
  const gzPath = join(fromDir, `${name}.gz`);
  const gz = statSync(gzPath, { throwIfNoEntry: false });
  if (gz?.isFile()) {
    const raw = readFileSync(gzPath);
    const bytes = raw.subarray(0, 2).equals(Buffer.from([0x1f, 0x8b])) ? gunzipSync(raw) : raw;
    writeFileSync(join(dataDir, name), bytes);
    return;
  }
  const plainPath = join(fromDir, name);
  if (statSync(plainPath, { throwIfNoEntry: false })?.isFile()) {
    copyFileSync(plainPath, join(dataDir, name));
    return;
  }
  console.error(`备份里没有 ${name}（找了 ${name}.gz 和 ${name}）`);
  process.exit(1);
}

function copyDir(from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    if (entry.isDirectory()) copyDir(join(from, entry.name), join(to, entry.name));
    else copyFileSync(join(from, entry.name), join(to, entry.name));
  }
}
