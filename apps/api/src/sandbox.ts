import { spawn, execFile } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync as mkdirTemp,
  readdirSync,
  rmSync,
  statSync,
  existsSync,
  readFileSync,
  writeFileSync,
  realpathSync,
} from 'node:fs';
import { join, resolve, dirname, isAbsolute, relative, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/** Output ceiling. Unlimited by default because the operator asked for no
 *  length cap; kept as a guard rail so a runaway `yes` cannot exhaust the
 *  server's memory when the operator does set one. */
export const SANDBOX_OUTPUT_LIMIT = 0;

export interface SandboxResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  durationMs: number;
  /** Which isolation path actually ran, so the UI can be honest about it. */
  isolation: 'nsjail' | 'directory';
}

export interface SandboxOptions {
  /** Operator switch, read fresh on every call so flipping it in the UI takes
   *  effect on the very next model turn. */
  enabled: () => boolean;
  /** Hard cap on total bytes stored in the sandbox directory. 0 = unlimited. */
  sizeLimitBytes: () => number;
  /** Output ceiling per stream; 0 means unlimited. */
  outputLimit?: number;
  /** Address space cap in MB; 0 means unlimited. Bounds a runaway allocation
   *  without needing cgroup access, which a plain container cannot provide. */
  memoryLimitMb?: () => number;
  /** Timezone handed to commands so `date` matches the persona's clock. */
  timeZone?: () => string;
  /** Whether sandboxed commands may reach the network. Off by default: the
   *  command gets its own empty net namespace. */
  network: () => boolean;
}

export class SandboxQuotaError extends Error {}

const NSJAIL = '/usr/local/bin/nsjail';

/** PATH every sandboxed command gets, nsjail or fallback alike. */
const SANDBOX_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

/** Locale for sandboxed commands. nsjail replaces the environment wholesale, so
 *  PATH/LANG/TZ all have to be passed as argv rather than inherited. */
const SANDBOX_LANG = process.env.LANG || 'C.UTF-8';

/** Env handed to sandboxed commands. Anything secret (LLM keys, admin password,
 *  the SQLite path) is deliberately absent so a stray `printenv` cannot leak it
 *  into a chat message. HOME points at the scratch dir: npm and git need a
 *  writable cache there, and an empty HOME breaks `#!/usr/bin/env node`
 *  shebangs outright. */
const safeEnv = (tmpDir: string, timeZone: string | undefined): NodeJS.ProcessEnv => ({
  PATH: SANDBOX_PATH,
  HOME: tmpDir,
  LANG: SANDBOX_LANG,
  // Same clock the persona uses; otherwise `date` in the sandbox and "现在是…"
  // in her prompt disagree about what time it is.
  TZ: timeZone || process.env.TZ,
});

export class Sandbox {
  readonly root: string;
  readonly tmpDir: string;
  private readonly outputLimit: number;
  /** Cached probe result. nsjail's availability cannot change at runtime, but the
   *  probe depends on the network flag, so the key covers that too. */
  private nsjailProbe: string | null = null;
  private nsjailUsable = false;

  constructor(
    rootDir: string,
    private readonly options: SandboxOptions,
  ) {
    this.root = resolve(rootDir);
    mkdirSync(this.root, { recursive: true });
    // Only the sandbox root is writable, so give toolchains somewhere to put
    // their scratch files (npm's _cacache, git's objects) instead of failing
    // against a read-only /tmp. Kept outside the sandbox directory so tool
    // caches never eat into the operator's quota or show up in list_files.
    this.tmpDir = mkdirTemp(join(tmpdir(), 'atri-sandbox-'));
    this.outputLimit = options.outputLimit ?? SANDBOX_OUTPUT_LIMIT;
  }

  get enabled(): boolean {
    return this.options.enabled();
  }

  get sizeLimit(): number {
    return Math.max(0, this.options.sizeLimitBytes());
  }

  /** Detect whether nsjail can actually create namespaces here. Probed once
   *  with a real no-op run, because "binary exists" is not the same as
   *  "works": some hosts block user namespaces outright. */
  async nsjailAvailable(): Promise<boolean> {
    const key = String(this.options.network());
    if (this.nsjailProbe === key) return this.nsjailUsable;
    if (process.platform === 'win32' || !existsSync(NSJAIL)) {
      this.nsjailProbe = key;
      this.nsjailUsable = false;
      return false;
    }
    try {
      // Probe with the same flags the real runs use, including the hidden
      // tmpfs mounts: a bare invocation would pass even when the mount tree
      // cannot be built, which is exactly the failure mode to catch. The
      // working directory must exist first or the cwd bind fails.
      mkdirSync(this.root, { recursive: true });
      const { args } = this.nsjailArgs('true');
      await exec(NSJAIL, args, { timeout: 15000 });
      this.nsjailUsable = true;
    } catch {
      this.nsjailUsable = false;
    }
    this.nsjailProbe = key;
    return this.nsjailUsable;
  }

  /** Directory size, skipping node_modules/.git which the operator never
   *  counts against the quota but which would dominate a naive walk. */
  usage(): { files: number; bytes: number } {
    let files = 0,
      bytes = 0;
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else {
          files++;
          try {
            bytes += statSync(full).size;
          } catch {
            // A file removed mid-walk is not worth failing the whole count.
          }
        }
      }
    };
    if (existsSync(this.root)) walk(this.root);
    return { files, bytes };
  }

  clear(): void {
    if (existsSync(this.root)) rmSync(this.root, { recursive: true, force: true });
    mkdirSync(this.root, { recursive: true });
  }

  /** Release the scratch dir. Called on shutdown; without it every restart
   *  left an `atri-sandbox-*` directory in the OS temp folder forever. */
  dispose(): void {
    rmSync(this.tmpDir, { recursive: true, force: true });
  }

  /** Reject before running anything that would obviously blow past the quota,
   *  so the model gets told immediately instead of after a long job. */
  private assertWithinQuota(extraBytes = 0): void {
    const limit = this.sizeLimit;
    if (!limit) return;
    const { bytes } = this.usage();
    if (bytes + extraBytes > limit)
      throw new SandboxQuotaError(
        `沙箱已满（${(bytes / 1024 / 1024).toFixed(1)} MB / ${(limit / 1024 / 1024).toFixed(1)} MB）。` +
          '请先删除文件，或在设置里调大沙箱大小。',
      );
  }

  /** Resolve a model-supplied path inside the sandbox. Absolute paths are
   *  treated as sandbox-relative and `..` cannot escape: the resolved target
   *  must still sit under `root`. `realpathSync` closes the symlink hole that a
   *  plain string check leaves open. */
  private safePath(input: string): string {
    const raw = (input || '.').trim();
    if (raw.length > 200) throw new Error('路径过长');
    const target = resolve(this.root, isAbsolute(raw) ? raw.replace(/^([/\\])+/, '') : raw);
    const rel = relative(this.root, target);
    if (rel.startsWith('..') || isAbsolute(rel) || rel.split(sep).includes('..'))
      throw new Error('路径超出沙箱范围');
    // If the path (or its nearest existing parent) is already a symlink, check
    // where it really points. Missing leaf is fine, the parent is what matters.
    let probe = target;
    while (!existsSync(probe) && probe !== dirname(probe)) probe = dirname(probe);
    if (existsSync(probe)) {
      const real = realpathSync(probe);
      const realRel = relative(realpathSync(this.root), real);
      if (realRel.startsWith('..') || isAbsolute(realRel)) throw new Error('路径超出沙箱范围');
    }
    return target;
  }

  async write(path: string, content: string): Promise<{ bytes: number; path: string }> {
    if (!this.enabled) throw new Error('沙箱未启用');
    // No length cap on content; the size quota is the real bound, and a string
    // beyond V8's max length is impossible to accept anyway.
    this.assertWithinQuota(Buffer.byteLength(content));
    const target = this.safePath(path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, 'utf8');
    return { path: relative(this.root, target) || '.', bytes: Buffer.byteLength(content) };
  }

  async read(path: string): Promise<{ content: string; path: string }> {
    if (!this.enabled) throw new Error('沙箱未启用');
    const target = this.safePath(path);
    if (!existsSync(target)) throw new Error('文件不存在');
    const stat = statSync(target);
    if (stat.isDirectory()) throw new Error('这是一个目录，请改用 list_files');
    return {
      path: relative(this.root, target) || '.',
      content: readFileSync(target, 'utf8'),
    };
  }

  async list(path: string): Promise<{
    path: string;
    entries: { name: string; kind: string; size: number }[];
  }> {
    if (!this.enabled) throw new Error('沙箱未启用');
    const target = this.safePath(path);
    if (!existsSync(target)) throw new Error('目录不存在');
    return {
      path: relative(this.root, target) || '.',
      entries: readdirSync(target, { withFileTypes: true })
        .slice(0, 200)
        .map((entry) => {
          const full = join(target, entry.name);
          let size = 0;
          try {
            size = entry.isFile() ? statSync(full).size : 0;
          } catch {
            // Raced with a concurrent command; reporting 0 beats failing.
          }
          return {
            name: entry.name,
            kind: entry.isDirectory() ? 'dir' : entry.isFile() ? 'file' : 'other',
            size,
          };
        }),
    };
  }

  /** Run one shell command inside the sandbox. Prefers nsjail (namespace
   *  isolation) and falls back to a plain subshell when nsjail is unavailable,
   *  so the feature still works on hosts that block user namespaces. */
  async run(command: string, signal?: AbortSignal): Promise<SandboxResult> {
    const started = Date.now();
    if (!this.enabled) throw new Error('沙箱未启用');
    const trimmed = command.trim();
    if (!trimmed) throw new Error('命令不能为空');
    if (trimmed.length > 4000) throw new Error('命令过长');
    this.assertWithinQuota();

    const useNsjail = await this.nsjailAvailable();
    return this.spawn(
      useNsjail ? this.nsjailArgs(trimmed) : this.fallbackArgs(trimmed),
      useNsjail ? 'nsjail' : 'directory',
      started,
      signal,
    );
  }

  /** nsjail argv. Namespace isolation: mount/pid/ipc/uts/user namespaces, so the
   *  command is PID 1 inside with a changed hostname, system paths are read-only,
   *  and /app and /data get an empty tmpfs over them so the command cannot read
   *  the application source or the SQLite database.
   *
   *  Networking is the operator's call. The default gives the command its own
   *  empty net namespace with no route out. `--disable_clone_newnet` *shares the
   *  host's* network instead, which is what enables npm/pip/curl; the flag reads
   *  backwards but that is its actual meaning. Every other isolation property is
   *  unaffected either way, which was verified on a real host.
   *
   *  No cgroup limits: a plain container mounts cgroupfs read-only and nsjail
   *  needs --cgroupns=host for those, which would require host setup. Resource
   *  bounds come from rlimits instead, which need no extra privilege.
   */
  private nsjailArgs(command: string): { bin: string; args: string[] } {
    const args = ['--really_quiet', '--chroot', '/', '--cwd', this.root, '--bindmount', this.root];
    for (const dir of ['/usr', '/lib', '/lib64', '/bin', '/sbin', '/etc'])
      if (existsSync(dir)) args.push('--bindmount_ro', dir);
    // node is not under any of the paths above (/usr/local), so npm's own shebang
    // line would fail with "node: No such file or directory" the moment the
    // sandbox reaches for it. Make it visible read-only like the rest.
    if (existsSync('/usr/local')) args.push('--bindmount_ro', '/usr/local');
    // A writable scratch dir for npm's cache, git's objects, /tmp, and HOME.
    // It must be bound straight onto /tmp: adding a bare --bindmount for it and
    // a separate --tmpfsmount /tmp makes nsjail mount the same directory at both
    // destinations, which fails outright with "Launching child process failed".
    args.push(`--bindmount=${this.tmpDir}:/tmp`);
    // nsjail replaces the environment wholesale, so PATH and HOME have to be
    // stated here rather than inherited. HOME is not cosmetic: with it unset,
    // `env` (and so every `#!/usr/bin/env node` script, npm included) walks
    // "$HOME/.cargo/bin" and then reports "node: No such file or directory"
    // even though node is right there on PATH.
    args.push(`--env=PATH=${SANDBOX_PATH}`, `--env=HOME=/tmp`);
    // nsjail also drops TZ and LANG, so `date` fell back to UTC and the sandbox
    // clock disagreed with the persona's own "现在是…" line by the UTC offset.
    // Only the non-nsjail fallback path inherited these, which is why it looked
    // correct wherever namespaces were unavailable.
    const tz = this.options.timeZone?.() || process.env.TZ;
    args.push(`--env=LANG=${SANDBOX_LANG}`);
    if (tz) args.push(`--env=TZ=${tz}`);
    // Blank out the app and its data volume so the command cannot read the
    // source or the SQLite database. Never mask the sandbox's own directory:
    // mounting an empty tmpfs over the cwd would leave the shell with no
    // working directory at all.
    for (const hidden of ['/app', '/data']) {
      if (!existsSync(hidden)) continue;
      const rel = relative(resolve(hidden), this.root);
      if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) continue;
      args.push('--tmpfsmount', hidden);
    }
    if (this.options.network()) args.push('--disable_clone_newnet');
    const mem = this.options.memoryLimitMb?.() ?? 0;
    if (mem > 0) args.push('--rlimit_as', String(mem * 1024));
    args.push('--', '/bin/sh', '-c', command);
    return { bin: NSJAIL, args };
  }

  /** Plain subshell for hosts where nsjail is unusable. Still confined to the
   *  sandbox directory and the scrubbed environment, just without namespaces. */
  private fallbackArgs(command: string): { bin: string; args: string[] } {
    return { bin: '/bin/sh', args: ['-c', command] };
  }

  private spawn(
    { bin, args }: { bin: string; args: string[] },
    isolation: 'nsjail' | 'directory',
    started: number,
    signal?: AbortSignal,
  ): Promise<SandboxResult> {
    return new Promise<SandboxResult>((resolvePromise) => {
      const child = spawn(bin, args, {
        cwd: this.root,
        env: safeEnv(this.tmpDir, this.options.timeZone?.()),
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      });
      let stdout = '',
        stderr = '',
        settled = false;
      // Cap as we stream rather than after: a runaway `yes` would otherwise fill
      // memory before anyone notices. No-op when the limit is 0.
      const cap = (buf: Buffer, current: string): string => {
        if (!this.outputLimit) return current + buf.toString('utf8');
        return current.length >= this.outputLimit
          ? current
          : (current + buf.toString('utf8')).slice(0, this.outputLimit);
      };
      child.stdout.on('data', (b: Buffer) => (stdout = cap(b, stdout)));
      child.stderr.on('data', (b: Buffer) => (stderr = cap(b, stderr)));

      const onAbort = () => this.kill(child.pid);
      signal?.addEventListener('abort', onAbort, { once: true });

      const finish = (code: number | null) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        resolvePromise({
          ok: code === 0,
          code,
          stdout,
          stderr,
          truncated: this.outputLimit
            ? stdout.length >= this.outputLimit || stderr.length >= this.outputLimit
            : false,
          durationMs: Date.now() - started,
          isolation,
        });
      };
      child.on('error', (error) => {
        stderr += `\n${error.message}`;
        finish(null);
      });
      child.on('close', finish);
    });
  }

  /** Kill the whole process group: the shell forks, so killing only the shell
   *  would leave the actual command running. */
  private kill(pid?: number): void {
    if (!pid) return;
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
  }

  /** What the settings page shows so the operator knows what they are getting. */
  async isolationInfo(): Promise<{
    level: 'nsjail' | 'directory';
    note: string;
    network: string;
  }> {
    const wantsNetwork = this.options.network();
    const network = wantsNetwork ? '已启用（共享容器网络）' : '已禁用（独立网络命名空间）';
    if (process.platform === 'win32')
      return {
        level: 'directory',
        note: '本地 Windows 预览：目录级隔离。生产 Linux 容器内使用 nsjail。',
        // Wording kept identical to the Linux branch so the settings page reads
        // the same in both places; the note above is where the difference shows.
        network,
      };
    const nsjail = await this.nsjailAvailable();
    return {
      level: nsjail ? 'nsjail' : 'directory',
      note: nsjail
        ? 'nsjail 命名空间隔离：独立 mount/pid/ipc/uts/user 命名空间，系统目录只读挂载，沙箱目录是唯一可写路径，应用目录与数据库已被空 tmpfs 遮蔽。'
        : 'nsjail 不可用，已回退到目录级隔离（工作目录 + 环境变量白名单 + 配额 + 软链防护）；此时网络开关与文件系统隔离均无法强制，命令实际可联网。',
      network,
    };
  }
}
