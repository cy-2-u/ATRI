import { mkdir, readdir, realpath, lstat, open, rename, unlink } from 'node:fs/promises';
import { resolve, relative, dirname, sep, extname } from 'node:path';
import { constants } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { Config } from './config.ts';
import { errorText } from './types.ts';

export class Files {
  readonly root: string;
  private config: () => Config;
  private launch: typeof spawn;
  constructor(root: string, config: () => Config, launch = spawn) { this.root = resolve(root); this.config = config; this.launch = launch; }

  async init(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    if ((await lstat(this.root)).isSymbolicLink() || await realpath(this.root) !== this.root) throw new Error('作品根目录不能经过符号链接');
  }

  async scope(peer: string): Promise<Files> {
    const scoped = new Files(resolve(this.root, createHash('sha256').update(peer).digest('hex')), this.config, this.launch);
    await scoped.init(); return scoped;
  }

  async path(name: string, writing = false): Promise<string> {
    if (!name || name.includes('\0') || /[:]|^(?:[\\/])|(?:^|[\\/])\.\.(?:[\\/]|$)/i.test(name)) throw new Error('路径必须位于作品目录内');
    if ((await lstat(this.root)).isSymbolicLink()) throw new Error('作品根目录不能是符号链接');
    const target = resolve(this.root, name), rel = relative(this.root, target);
    if (rel.startsWith(`..${sep}`) || rel === '..' || target === this.root && writing) throw new Error('路径越界');
    const pieces = rel.split(sep).filter(Boolean); let current = this.root;
    for (let i = 0; i < pieces.length; i++) {
      current = resolve(current, pieces[i]!);
      try { const stat = await lstat(current); if (stat.isSymbolicLink() || stat.nlink > 1 && stat.isFile()) throw new Error('不允许符号链接或硬链接'); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !writing) throw error;
        if (i < pieces.length - 1) await mkdir(current, { mode: 0o700 });
      }
    }
    const parent = await realpath(target === this.root ? target : dirname(target));
    if (parent !== this.root && !parent.startsWith(`${this.root}${sep}`)) throw new Error('实际路径越界');
    return target;
  }

  async read(name: string, max = 20 * 1024 * 1024): Promise<Buffer> {
    const path = await this.path(name), file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.nlink > 1 || stat.size > max) throw new Error('文件不是独立普通文件或超过读取上限');
      return await file.readFile();
    } finally { await file.close(); }
  }

  async write(name: string, bytes: string | Uint8Array): Promise<{ path: string; bytes: number; hash: string }> {
    const target = await this.path(name, true), temporary = `${target}.tmp-${randomUUID()}`;
    try {
      const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
      await rename(temporary, target);
    } catch (error) { await unlink(temporary).catch(() => undefined); throw error; }
    return { path: name.replace(/\\/g, '/'), bytes: Buffer.byteLength(bytes), hash: createHash('sha256').update(bytes).digest('hex') };
  }

  async list(name = '.'): Promise<{ name: string; directory: boolean }[]> {
    const path = await this.path(name);
    return (await readdir(path, { withFileTypes: true })).filter(e => !e.isSymbolicLink()).slice(0, 200).map(e => ({ name: e.name, directory: e.isDirectory() }));
  }

  async execute(command: string, signal: AbortSignal): Promise<Record<string, unknown>> {
    const c = this.config().execution;
    if (!c.enabled) throw new Error('隔离执行未启用；文件读写仍可用');
    signal.throwIfAborted();
    // 她的窝：固定名常驻容器，真实挂载作品目录——她攒的环境跨轮保留，崩溃自动拉起。
    const name = 'atri-sandbox';
    const works = process.env.ATRI_SANDBOX_WORKS_PATH || this.root;
    const spec = sandboxArgs(c.image, c.network, this.config().life.timezone, works);
    let existing: { running: boolean; image: string; network: string } | undefined;
    try {
      const info = await this.dockerJSON(['inspect', name]);
      const node = info[0] ?? {};
      existing = {
        running: Boolean((node.State as Record<string, unknown> | undefined)?.Running),
        image: String((node.Config as Record<string, unknown> | undefined)?.Image ?? ''),
        network: String((node.HostConfig as Record<string, unknown> | undefined)?.NetworkMode ?? ''),
      };
    } catch { existing = undefined; }
    if (!existing || existing.image !== c.image || existing.network !== (c.network ? 'bridge' : 'none')) {
      if (existing) await this.spawnAwait(['rm', '-f', name]);
      await this.spawnAwait(['run', '-d', ...spec]);
    } else if (!existing.running) await this.spawnAwait(['start', name]);
    // 超时由容器内 timeout 执行权兜底：exec 客户端断开不影响裁决。
    const seconds = Math.max(1, Math.ceil(c.timeoutMs / 1000));
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(c.timeoutMs)]);
    let output = '', errors = '', truncated = false;
    const clip = (chunk: Buffer, old: string): string => { if (old.length + chunk.length > 64000) truncated = true; return (old + chunk.toString('utf8')).slice(0, 64000); };
    return await new Promise<Record<string, unknown>>((resolvePromise, reject) => {
      const child = this.launch('docker', ['exec', name, 'timeout', `${seconds}s`, 'sh', '-c', command], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      deadline.addEventListener('abort', () => child.kill(), { once: true }); if (deadline.aborted) child.kill();
      child.stdout.on('data', chunk => { output = clip(chunk as Buffer, output); }); child.stderr.on('data', chunk => { errors = clip(chunk as Buffer, errors); });
      child.on('error', error => { deadline.removeEventListener('abort', () => child.kill()); reject(new Error(`容器执行不可用：${errorText(error)}`)); });
      child.on('close', code => { deadline.removeEventListener('abort', () => child.kill()); resolvePromise({ ok: code === 0 && !deadline.aborted, code, stdout: output, stderr: errors, truncated, interrupted: deadline.aborted, isolation: 'persistent-workshop' }); });
    });
  }

  private dockerJSON(args: string[]): Promise<Record<string, unknown>[]> {
    return new Promise((resolve, reject) => {
      const child = this.launch('docker', args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      let out = '', err = '';
      child.stdout.on('data', c => { out += c; }); child.stderr.on('data', c => { err += c; });
      child.on('error', error => reject(error));
      child.on('close', code => {
        if (code !== 0) return reject(new Error(err.trim() || `docker ${args[0]} 退出码 ${code}`));
        try { resolve(JSON.parse(out) as Record<string, unknown>[]); } catch { reject(new Error('docker inspect 输出无效')); }
      });
    });
  }

  private spawnAwait(args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = this.launch('docker', args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      let err = '';
      child.stderr.on('data', c => { err += c; });
      child.on('error', error => reject(new Error(`容器执行不可用：${errorText(error)}`)));
      child.on('close', code => code === 0 ? resolve() : reject(new Error(err.trim() || `docker ${args[0]} 退出码 ${code}`)));
    });
  }
}

/** 她的窝的容器规格：常驻自愈、可写层持久、能力全卸、资源三限；作品目录真实挂载，密钥与数据库不可见。 */
export function sandboxArgs(image: string, network: boolean, tz: string, works: string): string[] {
  return [
    '--restart', 'unless-stopped',
    '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=64', '--memory=512m', '--cpus=1',
    '--network', network ? 'bridge' : 'none',
    '--mount', `type=bind,src=${works},dst=/work`,
    '--workdir=/work', '--env', `TZ=${tz}`, '--pull=never',
    image, 'sleep', 'infinity',
  ];
}

export function mimeOf(bytes: Buffer, name = ''): string {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (/^GIF8[79]a/.test(bytes.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  return ({ '.txt': 'text/plain', '.md': 'text/plain', '.json': 'application/json', '.csv': 'text/csv', '.log': 'text/plain', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.silk': 'audio/silk', '.mp4': 'video/mp4' } as Record<string, string>)[extname(name).toLowerCase()] ?? 'application/octet-stream';
}
