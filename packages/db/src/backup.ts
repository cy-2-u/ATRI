import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from './index.js';

interface Manifest {
  format: 1;
  version: string;
  createdAt: string;
  files: { path: string; sha256: string; size: number }[];
  messages: number;
  diaries: number;
}
function hash(path: string) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}
function safePath(root: string, path: string) {
  const full = resolve(root, path);
  if (
    !full.startsWith(resolve(root) + sep) ||
    !/^atri\.db$|^admin-secret\.txt$|^(media|custom)\/[a-zA-Z0-9_.-]+$/.test(path)
  )
    throw new Error('备份包含无效文件路径');
  return full;
}
export async function createBackup(
  store: Store,
  dataDir: string,
): Promise<{ directory: string; manifest: Manifest }> {
  const directory = join(
    dataDir,
    'backups',
    `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`,
  );
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    chmodSync(directory, 0o700);
  } catch {
    // chmod is advisory on Windows; the directory ACL already applies.
  }
  const destination = join(directory, 'atri.db');
  await store.backup(destination);
  const snapshot = new DatabaseSync(destination, { readOnly: true });
  const files = new Set<string>(['atri.db']);
  try {
    for (const row of snapshot.prepare("SELECT media FROM messages WHERE status<>'deleted'").all())
      for (const item of JSON.parse(String(row.media)))
        if (typeof item.path === 'string') files.add(item.path);
    const custom = snapshot.prepare("SELECT value FROM settings WHERE key='stickers:custom'").get();
    if (custom) for (const item of JSON.parse(String(custom.value))) files.add(item.file);
    // admin-secret.txt is deliberately not included: a backup is the file most
    // likely to be copied to a NAS or shared for support, and shipping the
    // management password inside it turns a data leak into an account takeover.
    // Restore keeps accepting old manifests that contain it (safePath allows
    // the name) but new backups never create one.
    for (const file of files) {
      if (file === 'atri.db') continue;
      const source = safePath(dataDir, file),
        target = safePath(directory, file);
      if (!lstatSync(source).isFile() || lstatSync(source).isSymbolicLink())
        throw new Error('备份源不是普通文件');
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      copyFileSync(source, target);
      try {
        chmodSync(target, 0o600);
      } catch {
        /* Windows */
      }
    }
    try {
      chmodSync(destination, 0o600);
    } catch {
      /* Windows */
    }
    const manifest: Manifest = {
      format: 1,
      version: '2.0.0',
      createdAt: new Date().toISOString(),
      files: [...files].map((path) => ({
        path,
        sha256: hash(safePath(directory, path)),
        size: lstatSync(safePath(directory, path)).size,
      })),
      messages: Number(
        snapshot.prepare("SELECT count(*) AS n FROM messages WHERE status<>'deleted'").get()!.n,
      ),
      diaries: Number(
        snapshot.prepare("SELECT count(*) AS n FROM diary_sections WHERE status='active'").get()!.n,
      ),
    };
    writeFileSync(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', {
      mode: 0o600,
    });
    return { directory, manifest };
  } finally {
    snapshot.close();
  }
}
export function restoreBackup(backupDir: string, dataDir: string) {
  const manifest = JSON.parse(readFileSync(join(backupDir, 'manifest.json'), 'utf8')) as Manifest;
  if (
    manifest.format !== 1 ||
    !Array.isArray(manifest.files) ||
    !manifest.files.some((f) => f.path === 'atri.db')
  )
    throw new Error('备份格式无效');
  const targetDir = resolve(dataDir);
  if (existsSync(targetDir) && readdirSync(targetDir).length)
    throw new Error('请停止服务，并恢复到一个空的数据目录');
  const seen = new Set<string>();
  for (const file of manifest.files) {
    if (seen.has(file.path)) throw new Error('备份含重复文件');
    seen.add(file.path);
    const source = safePath(backupDir, file.path);
    if (
      !lstatSync(source).isFile() ||
      lstatSync(source).isSymbolicLink() ||
      hash(source) !== file.sha256
    )
      throw new Error('备份文件校验失败');
    safePath(targetDir, file.path);
  }
  // Build and validate in a staging directory INSIDE the target. A sibling
  // directory is impossible when the target is a Docker mount point and / is
  // read-only, and the old final `rmdirSync(targetDir)` failed with EBUSY on
  // every mounted /data. Staging inside also guarantees the final moves stay
  // on the same filesystem (rename is atomic per entry).
  if (existsSync(targetDir) && !lstatSync(targetDir).isDirectory())
    throw new Error('数据目录不是目录');
  mkdirSync(targetDir, { recursive: true, mode: 0o700 });
  const tempDir = join(targetDir, `.atri-restore-${randomUUID().slice(0, 8)}`);
  mkdirSync(tempDir, { recursive: true, mode: 0o700 });
  const moved: string[] = [];
  try {
    for (const file of manifest.files) {
      const target = safePath(tempDir, file.path);
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      copyFileSync(safePath(backupDir, file.path), target);
      try {
        chmodSync(target, 0o600);
      } catch {
        /* Windows */
      }
    }
    const store = new Store(join(tempDir, 'atri.db'));
    try {
      const integrity = String(
        store.sql.prepare('PRAGMA integrity_check').get()?.integrity_check ?? '',
      );
      if (integrity !== 'ok') throw new Error('备份数据库完整性校验失败');
      if (store.sql.prepare('PRAGMA foreign_key_check').all().length)
        throw new Error('备份数据库外键校验失败');
      // Every attachment referenced by a message must be present in the
      // manifest; otherwise restore succeeds and the first image read silently
      // fails months later.
      const referenced = new Set<string>();
      for (const row of store.sql
        .prepare("SELECT media FROM messages WHERE status<>'deleted'")
        .all())
        for (const item of JSON.parse(String(row.media)) as { path?: string }[])
          if (typeof item.path === 'string') referenced.add(item.path);
      for (const path of referenced) if (!seen.has(path)) throw new Error(`备份缺少附件：${path}`);
      store.transaction(() => {
        store.sql.exec(
          "UPDATE tasks SET state='failed',error='从备份恢复，请确认是否重试此历史任务' WHERE state IN ('queued','running'); UPDATE outbox SET status='uncertain',error='从备份恢复，请先确认微信是否收到' WHERE status IN ('pending','sending'); UPDATE messages SET status='uncertain' WHERE id IN (SELECT id FROM outbox WHERE status='uncertain');",
        );
        const config = store.getSetting<Record<string, unknown>>('config', {});
        store.setSetting('config', { ...config, proactiveEnabled: false });
      });
    } finally {
      store.close();
    }
    // The target was verified empty above, so every top-level entry can be
    // renamed in. If one move fails, move the already-installed entries back
    // into staging and leave the target as empty as we found it.
    try {
      for (const entry of readdirSync(tempDir)) {
        const destination = join(targetDir, entry);
        if (existsSync(destination)) throw new Error('目标数据目录不为空');
        renameSync(join(tempDir, entry), destination);
        moved.push(entry);
      }
    } catch (error) {
      for (const entry of moved.reverse()) {
        try {
          renameSync(join(targetDir, entry), join(tempDir, entry));
        } catch {
          // Best effort: the original error already tells the operator to
          // inspect the data directory.
        }
      }
      throw error;
    }
    rmdirSync(tempDir);
    try {
      chmodSync(targetDir, 0o700);
    } catch {
      /* Windows */
    }
    return manifest;
  } catch (error) {
    rmSync(tempDir, { recursive: true, force: true });
    throw error;
  }
}
