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
import { fileURLToPath, pathToFileURL } from 'node:url';

/** 从 backup.ts 产物恢复数据目录：目标必须是空库（避免覆盖更活的现在）。
 *  云端备份是 gzip（atri.db.gz）：给 .gz 就地解压，下载下来不必再手动
 *  gunzip；.db-wal.gz 恢复时不需要（checkpoint 后的干净快照即可）。
 *  她的作品与数据库同权重：墙图与沙箱目录一并恢复（沙箱根优先取
 *  ATRI_SANDBOX_DIR——独立卷与数据卷同构恢复）。 */

export function restore(fromDir: string, dataDir: string, sandboxDir?: string): void {
  // 预检全部目标，通过后才动第一个字节：拒绝发生在任何拷贝之前——
  // 恢复一半再炸，留下的是半新半旧的混合时代。
  if (statSync(join(dataDir, 'atri.db'), { throwIfNoEntry: false }))
    throw new Error('拒绝恢复：数据目录里已有 atri.db。确认放弃现有数据后先删除它。');
  const plan: { from: string; to: string }[] = [];
  for (const [label, from, to] of [
    ['自定义表情', join(fromDir, 'custom'), join(dataDir, 'custom')],
    ['墙图', join(fromDir, 'wall'), join(dataDir, 'wall')],
    ['沙箱作品', join(fromDir, 'sandbox'), sandboxDir || join(dataDir, 'sandbox')],
  ] as const) {
    if (statSync(from, { throwIfNoEntry: false })?.isDirectory() !== true) continue;
    const existing = statSync(to, { throwIfNoEntry: false });
    if (existing?.isDirectory() && readdirSync(to).length)
      throw new Error(`拒绝恢复：${label}目录已有内容（${to}）。先清空它再恢复。`);
    plan.push({ from, to });
  }
  mkdirSync(dataDir, { recursive: true });
  restoreFile(fromDir, dataDir, 'atri.db');
  for (const item of plan) copyDir(item.from, item.to);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const dataDir = resolve(
    process.env.ATRI_DATA_DIR ||
      join(resolve(dirname(fileURLToPath(import.meta.url))), '..', 'data'),
  );
  const sandboxDir = process.env.ATRI_SANDBOX_DIR
    ? resolve(process.env.ATRI_SANDBOX_DIR)
    : undefined;
  const fromDir = resolve(process.argv[2] || '');
  if (!fromDir || statSync(fromDir, { throwIfNoEntry: false })?.isDirectory() !== true) {
    console.error('用法：node restore.mjs <备份目录>');
    process.exit(1);
  }
  try {
    restore(fromDir, dataDir, sandboxDir);
    console.log(`restore ok: ${fromDir} → ${dataDir}${sandboxDir ? ` + ${sandboxDir}` : ''}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

/** 优先 .gz（自动解压，gzip 魔数 1f 8b 防误命名），退回同名裸文件。 */
function restoreFile(fromDir: string, dataDir: string, name: string): void {
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
  throw new Error(`备份里没有 ${name}（找了 ${name}.gz 和 ${name}）`);
}

function copyDir(from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    if (entry.isDirectory()) copyDir(join(from, entry.name), join(to, entry.name));
    else copyFileSync(join(from, entry.name), join(to, entry.name));
  }
}
