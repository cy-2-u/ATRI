import { backup, DatabaseSync } from 'node:sqlite';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { gunzipSync, gzip as gzipCallback } from 'node:zlib';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir, readdir, lstat, rm, mkdtemp } from 'node:fs/promises';
import { join, resolve, relative, sep } from 'node:path';
import { tmpdir } from 'node:os';
import type { Config } from './config.ts';
import type { Store } from './store.ts';
import { object, errorText } from './types.ts';

interface ArchiveFile { name: string; hash: string; bytes: string }
interface Archive { version: 1; at: number; files: ArchiveFile[] }
const signature = Buffer.from('ATRIQQ01');
const limit = 256 * 1024 * 1024;
const digest = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const safeName = (name: string): boolean => !!name && !name.includes('\0') && !name.includes(':') && !/^(?:[a-z]:|[\\/])|(?:^|[\\/])\.\.(?:[\\/]|$)/i.test(name) && (name === 'atri.db' || name.startsWith('works/'));

export class Backups {
  private store: Store;
  private config: () => Config;
  private data: string;
  private key: Buffer;
  private timer?: ReturnType<typeof setTimeout>;
  private running?: Promise<string>;
  private stopped = true;
  private controller?: AbortController;
  constructor(store: Store, config: () => Config, data: string, key: Buffer) { this.store = store; this.config = config; this.data = data; this.key = key; }
  status(): Record<string, unknown> { return { running: !!this.running, ...this.store.get<Record<string, unknown>>('backup-status', {}) }; }
  start(): void { this.stopped = false; this.reconfigure(); }
  reconfigure(): void {
    if (this.timer) clearTimeout(this.timer);
    const c = this.config().backup;
    if (this.stopped || !c.enabled || this.running) return;
    const last = this.store.get<{ at?: number }>('backup-status', {}).at ?? this.store.now();
    const due = Math.max(1000, last + c.intervalHours * 3600000 - this.store.now());
    this.timer = setTimeout(() => { void this.run().catch(() => undefined).finally(() => this.reconfigure()); }, Math.min(due, 2147483647));
    this.timer.unref();
  }
  run(): Promise<string> {
    if (this.running) return this.running;
    this.running = this.perform().finally(() => { this.running = undefined; this.reconfigure(); });
    return this.running;
  }
  private async perform(): Promise<string> {
    const c = this.config().backup;
    if (!c.enabled || !c.url) throw new Error('请明确启用并配置备份目的地');
    const url = new URL(c.url);
    if (url.protocol !== 'https:') throw new Error('WebDAV 备份只允许 HTTPS');
    const temporary = await mkdtemp(join(tmpdir(), 'atri-backup-'));
    this.controller = new AbortController();
    try {
      const snapshot = join(temporary, 'atri.db');
      await backup(this.store.db, snapshot);
      const files: ArchiveFile[] = []; let size = 0;
      const add = async (path: string, name: string): Promise<void> => {
        const stat = await lstat(path);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('备份遇到非普通文件，未跳过');
        size += stat.size;
        if (size > limit) throw new Error('备份原始数据超过256MB安全上限；本次未上传不完整备份');
        const bytes = await readFile(path);
        files.push({ name, hash: digest(bytes), bytes: bytes.toString('base64') });
      };
      await add(snapshot, 'atri.db');
      const works = join(this.data, 'works');
      const walk = async (path: string): Promise<void> => {
        for (const entry of await readdir(path, { withFileTypes: true })) {
          const child = join(path, entry.name);
          if (entry.isSymbolicLink()) throw new Error('备份作品目录包含符号链接，请先处理');
          if (entry.isDirectory()) await walk(child);
          else await add(child, `works/${relative(works, child).split(sep).join('/')}`);
        }
      };
      await walk(works);
      const archive: Archive = { version: 1, at: this.store.now(), files };
      // 异步压缩：256MB 级 gzip 若走同步实现会把事件循环卡住数秒，心跳与投递全部停摆。
      const gzip = promisify(gzipCallback);
      const compressed = await gzip(Buffer.from(JSON.stringify(archive)), { level: 6 });
      const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, nonce);
      cipher.setAAD(signature);
      const encrypted = Buffer.concat([signature, nonce, cipher.update(compressed), cipher.final(), cipher.getAuthTag()]);
      const name = `atri-${new Date(archive.at).toISOString().replace(/[:.]/g, '-')}.atri`;
      url.pathname = `${url.pathname.replace(/\/+$/, '')}/${name}`;
      const response = await fetch(url, { method: 'PUT', headers: { 'content-type': 'application/octet-stream', ...(c.user || c.password ? { authorization: `Basic ${Buffer.from(`${c.user}:${c.password}`).toString('base64')}` } : {}) }, body: encrypted, redirect: 'error', signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(180000)]) });
      await response.body?.cancel();
      if (!response.ok) throw new Error(`WebDAV HTTP ${response.status}`);
      this.store.set('backup-status', { at: archive.at, ok: true, name, bytes: encrypted.length, files: files.length });
      return name;
    } catch (error) { this.store.set('backup-status', { at: this.store.now(), ok: false, error: errorText(error) }); throw error; }
    finally { this.controller = undefined; await rm(temporary, { recursive: true, force: true }); }
  }
  async stop(): Promise<void> { this.stopped = true; if (this.timer) clearTimeout(this.timer); this.controller?.abort(); await this.running?.catch(() => undefined); }
}

export async function restoreArchive(bytes: Buffer, key: Buffer, target: string): Promise<void> {
  if (key.length !== 32 || bytes.length < 37 || bytes.length > limit * 2 || !bytes.subarray(0, 8).equals(signature)) throw new Error('备份文件或密钥无效');
  const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(8, 20));
  decipher.setAAD(signature); decipher.setAuthTag(bytes.subarray(-16));
  const plain = gunzipSync(Buffer.concat([decipher.update(bytes.subarray(20, -16)), decipher.final()]), { maxOutputLength: limit * 2 });
  const value = object(JSON.parse(plain.toString('utf8')));
  if (value.version !== 1 || !Array.isArray(value.files)) throw new Error('不支持此备份版本');
  const files = value.files.map(v => object(v)), names = new Set<string>();
  let total = 0;
  for (const f of files) {
    if (typeof f.name !== 'string' || !safeName(f.name) || names.has(f.name) || typeof f.bytes !== 'string' || typeof f.hash !== 'string') throw new Error('备份文件路径或记录无效');
    names.add(f.name); const content = Buffer.from(f.bytes, 'base64'); total += content.length;
    if (total > limit || digest(content) !== f.hash) throw new Error('备份内容校验失败');
  }
  if (!names.has('atri.db')) throw new Error('备份没有数据库');
  const root = resolve(target);
  await mkdir(root); // 只恢复到不存在的新目录，绝不覆盖运行中数据。
  try {
    for (const f of files) { const path = join(root, String(f.name)); await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, Buffer.from(String(f.bytes), 'base64'), { mode: 0o600 }); }
    const db = new DatabaseSync(join(root, 'atri.db'));
    try { if (db.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok') throw new Error('数据库完整性检查失败'); } finally { db.close(); }
    await writeFile(join(root, 'backup-key.txt'), key.toString('hex'), { encoding: 'utf8', mode: 0o600 });
  } catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
}
