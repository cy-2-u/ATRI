import { spawn, execFile } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync as mkdirTemp,
  readdirSync,
  rmdirSync,
  rmSync,
  statSync,
  existsSync,
  lstatSync,
  readFileSync,
  writeFileSync,
  realpathSync,
  openSync,
  closeSync,
  fstatSync,
  constants as fsConstants,
} from 'node:fs';
import { join, resolve, dirname, isAbsolute, relative, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/** 代码沙箱：Linux 上强制 nsjail 命名空间隔离（系统目录只读、/app 与
 *  /data 用空 tmpfs 遮蔽、独立网络命名空间默认断网、rlimit 内存、硬
 *  时限杀进程组）；nsjail 不可用直接拒绝执行——退化为宿主 shell 不是
 *  "降级隔离"，是带着数据库与全部密钥的任意代码执行。 */

/** 单流输出上限：跑飞的 yes 不能把 API 进程堆吃穿。 */
const SANDBOX_OUTPUT_LIMIT = 256 * 1024;
const SANDBOX_READ_LIMIT = 2 * 1024 * 1024;

export interface SandboxResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  durationMs: number;
  /** 是否因超时限被终止；已有部分输出仍会返回。 */
  timedOut: boolean;
  /** 实际跑的是哪条隔离路径，UI 据此如实展示。 */
  isolation: 'persistent-workshop' | 'nsjail' | 'directory';
}

export interface SandboxOptions {
  /** 运维开关，每次调用现读：UI 里拨动后下一轮模型即生效。 */
  enabled: () => boolean;
  /** 沙箱目录总字节数上限；0 不限制。 */
  sizeLimitBytes: () => number;
  outputLimit?: number;
  /** 单条命令硬时限（毫秒）；0 不限制。 */
  timeoutMs?: () => number;
  /** 开发逃生口。生产必须 false：nsjail 建不了命名空间就拒绝执行，
   *  非 Linux 主机的测试显式开启。 */
  allowDirectoryFallback?: boolean;
  /** 地址空间上限（MB）；0 不限制。rlimit 不需要 cgroup 权限。 */
  memoryLimitMb?: () => number;
  /** 命令拿到的时区，与人格的时钟一致。 */
  timeZone?: () => string;
  /** 沙箱命令是否可联网；默认独立空网络命名空间。 */
  network: () => boolean;
  /** 她的窝的镜像（#7 常驻沙箱）：配置了才启用 docker 常驻容器模式
   *  （如 'node:24-slim'）。固定名常驻、restart unless-stopped 崩溃自拉
   *  起、可写层跨轮保留（她攒的环境不丢）、cap 全卸+no-new-privileges+
   *  pids/内存/CPU 三限——不占内存不越界。未配置走 nsjail 兜底。 */
  dockerImage?: () => string | undefined;
  /** 常驻容器挂载的作品目录（宿主机真实路径）；缺省用沙箱 root。
   *  compose 部署时传卷在宿主的挂载点，容器内 /data 里的嵌套 docker
   *  才能看见同一份作品。 */
  dockerWorks?: () => string | undefined;
}

class SandboxQuotaError extends Error {}

const NSJAIL = '/usr/local/bin/nsjail';
const SANDBOX_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
const SANDBOX_LANG = process.env.LANG || 'C.UTF-8';

/** 她的窝的 run spec：单独导出为纯函数——测试锁真身而不是手抄副本。 */
export function dockerSpec(name: string, network: boolean, works: string, tz: string): string[] {
  return [
    '--name',
    name,
    '--restart',
    'unless-stopped',
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges',
    '--pids-limit=64',
    '--memory=512m',
    '--cpus=1',
    '--network',
    network ? 'bridge' : 'none',
    '--mount',
    `type=bind,src=${works},dst=/work`,
    '--workdir=/work',
    '--env',
    `TZ=${tz}`,
  ];
}

/** 沙箱命令的环境：一切秘密（模型密钥、管理密码、SQLite 路径）刻意
 *  缺席，漏出来的 printenv 不会进聊天。HOME 指向可写暂存目录：npm/git
 *  需要可写缓存，空 HOME 会让 #!/usr/bin/env node 直接失效。 */
const safeEnv = (tmpDir: string, timeZone: string | undefined): NodeJS.ProcessEnv => ({
  PATH: SANDBOX_PATH,
  HOME: tmpDir,
  LANG: SANDBOX_LANG,
  TZ: timeZone || process.env.TZ,
});

export class Sandbox {
  readonly root: string;
  readonly tmpDir: string;
  private readonly outputLimit: number;
  private readonly allowDirectoryFallback: boolean;
  /** 探测结果缓存；可用性取决于网络开关，key 覆盖它。 */
  private nsjailProbe: string | null = null;
  private nsjailUsable = false;

  constructor(
    rootDir: string,
    private readonly options: SandboxOptions,
  ) {
    this.root = resolve(rootDir);
    mkdirSync(this.root, { recursive: true });
    // 只有沙箱根可写：工具链的暂存文件（npm _cacache、git objects）放
    // 外面，不占运维配额、不混进 list_files。
    this.tmpDir = mkdirTemp(join(tmpdir(), 'atri-sandbox-'));
    this.outputLimit = Math.max(0, options.outputLimit ?? SANDBOX_OUTPUT_LIMIT);
    this.allowDirectoryFallback = options.allowDirectoryFallback === true;
  }

  get enabled(): boolean {
    return this.options.enabled();
  }
  /** 单条命令硬时限，默认 10 分钟，0 不限制；每次现读，改设置即时生效。 */
  private get commandTimeoutMs(): number {
    return Math.max(0, this.options.timeoutMs?.() ?? 600000);
  }
  get sizeLimit(): number {
    return Math.max(0, this.options.sizeLimitBytes());
  }

  /** 探测 nsjail 是否真能建命名空间：用真实 flags 跑一次 no-op，
   *  "二进制存在"不等于"能用"。 */
  async nsjailAvailable(): Promise<boolean> {
    const key = String(this.options.network());
    if (this.nsjailProbe === key) return this.nsjailUsable;
    if (process.platform === 'win32' || !existsSync(NSJAIL)) {
      this.nsjailProbe = key;
      this.nsjailUsable = false;
      return false;
    }
    try {
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

  /** 目录用量：每个字节都算——豁免 node_modules/.git 会让配额读零时
   *  磁盘已被填满。符号链接按链接本身计，不按它指向的外部文件。 */
  usage(): { files: number; bytes: number } {
    let files = 0,
      bytes = 0;
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else {
          files++;
          try {
            bytes += lstatSync(full).size;
          } catch {
            // 走查中被删掉的文件不值得让整个计数失败。
          }
        }
      }
    };
    if (existsSync(this.root)) walk(this.root);
    return { files, bytes };
  }

  /** 清空沙箱内容但保留根目录本身：Docker 部署里 /sandbox 是挂载点，
   *  删挂载点要么 EACCES（容器以 node 用户跑、/ 属 root）要么 EBUSY；
   *  根目录必须活着，清它的子项即可。 */
  clear(): void {
    if (!existsSync(this.root)) {
      mkdirSync(this.root, { recursive: true });
      return;
    }
    for (const entry of readdirSync(this.root, { withFileTypes: true }))
      rmSync(join(this.root, entry.name), { recursive: true, force: true });
  }
  /** 释放暂存目录；不调用的话每次重启都在系统临时目录留一个孤儿。 */
  dispose(): void {
    rmSync(this.tmpDir, { recursive: true, force: true });
  }

  /** 明显会爆配额的写入提前拒绝，模型立刻得到反馈。 */
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

  /** 解析模型给的沙箱内路径：绝对路径按沙箱相对处理，.. 逃不出去；
   *  realpathSync 封住字符串检查漏掉的符号链接洞。 */
  private safePath(input: string): string {
    const raw = (input || '.').trim();
    if (raw.length > 200) throw new Error('路径过长');
    const target = resolve(this.root, isAbsolute(raw) ? raw.replace(/^([/\\])+/, '') : raw);
    const rel = relative(this.root, target);
    if (rel.startsWith('..') || isAbsolute(rel) || rel.split(sep).includes('..'))
      throw new Error('路径超出沙箱范围');
    // 路径（或最近的现存父级）是符号链接时查它真正指向哪。
    let probe = target;
    while (!existsSync(probe) && probe !== dirname(probe)) probe = dirname(probe);
    if (existsSync(probe)) {
      const real = realpathSync(probe);
      const realRel = relative(realpathSync(this.root), real);
      if (realRel.startsWith('..') || isAbsolute(realRel)) throw new Error('路径超出沙箱范围');
    }
    return target;
  }

  /** 文本与二进制共用的开柄：路径守卫 + 配额外的叶子竞速防护
   *  （沙箱命令可以把叶子换成 FIFO：O_NOFOLLOW/O_NONBLOCK + fstat 封掉
   *  检查与打开之间被换叶子的窗口）。调用方负责 close(fd)。 */
  private openForWrite(path: string): { fd: number; target: string } {
    const target = this.safePath(path);
    mkdirSync(dirname(target), { recursive: true });
    if (existsSync(target) && !lstatSync(target).isFile()) throw new Error('只能写入普通文件');
    const fd = openSync(
      target,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_TRUNC |
        (fsConstants.O_NOFOLLOW ?? 0) |
        (fsConstants.O_NONBLOCK ?? 0),
      0o600,
    );
    try {
      if (!fstatSync(fd).isFile()) throw new Error('只能写入普通文件');
    } catch (error) {
      closeSync(fd);
      throw error;
    }
    return { fd, target };
  }

  async write(path: string, content: string): Promise<{ bytes: number; path: string }> {
    if (!this.enabled) throw new Error('沙箱未启用');
    // 内容不限长：配额才是真边界。
    this.assertWithinQuota(Buffer.byteLength(content));
    const { fd, target } = this.openForWrite(path);
    try {
      writeFileSync(fd, content, 'utf8');
    } finally {
      closeSync(fd);
    }
    // 与 writeBytes/readFile 同一契约：路径用正斜杠（不随宿主分隔符漂移）。
    return {
      path: relative(this.root, target).split(sep).join('/') || '.',
      bytes: Buffer.byteLength(content),
    };
  }

  /** 写二进制（画笔产物的落盘）：与 write 同一套守卫，只是不做文本解码。 */
  async writeBytes(path: string, bytes: Buffer): Promise<{ bytes: number; path: string }> {
    if (!this.enabled) throw new Error('沙箱未启用');
    this.assertWithinQuota(bytes.length);
    const { fd, target } = this.openForWrite(path);
    try {
      writeFileSync(fd, bytes);
    } finally {
      closeSync(fd);
    }
    return { path: relative(this.root, target).split(sep).join('/') || '.', bytes: bytes.length };
  }

  async read(path: string): Promise<{ content: string; path: string }> {
    if (!this.enabled) throw new Error('沙箱未启用');
    const target = this.safePath(path);
    if (!existsSync(target)) throw new Error('文件不存在');
    if (!lstatSync(target).isFile()) throw new Error('只能读取普通文件');
    const fd = openSync(
      target,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0),
    );
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile()) throw new Error('只能读取普通文件');
      if (stat.size > SANDBOX_READ_LIMIT)
        throw new Error(`文件过大（上限 ${SANDBOX_READ_LIMIT / 1024 / 1024} MB）`);
      return {
        path: relative(this.root, target) || '.',
        content: readFileSync(fd, 'utf8'),
      };
    } finally {
      closeSync(fd);
    }
  }

  /** 读出沙箱文件的原始字节（发图片用）：与 read 同一套路径守卫和检查-
   *  打开竞速防护，但不做文本解码；大小上限由调用方按通道能力传入。
   *  返回路径按模型契约用正斜杠（不随宿主系统分隔符漂移）。 */
  async readFile(path: string, maxBytes: number): Promise<{ bytes: Buffer; path: string }> {
    if (!this.enabled) throw new Error('沙箱未启用');
    const target = this.safePath(path);
    if (!existsSync(target)) throw new Error(`图片文件不存在：${path}`);
    if (!lstatSync(target).isFile()) throw new Error('只能读取普通文件');
    const fd = openSync(
      target,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0),
    );
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile()) throw new Error('只能读取普通文件');
      if (stat.size > maxBytes)
        throw new Error(`图片超过 ${Math.round(maxBytes / 1024 / 1024)} MB 上限`);
      return {
        path: relative(this.root, target).split(sep).join('/') || '.',
        bytes: readFileSync(fd),
      };
    } finally {
      closeSync(fd);
    }
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
            // 与并发命令竞速：报 0 好过失败。
          }
          return {
            name: entry.name,
            kind: entry.isDirectory() ? 'dir' : entry.isFile() ? 'file' : 'other',
            size,
          };
        }),
    };
  }

  /** 删除沙箱内的文件或目录。与 write/read 一样是纯文件系统操作，不经过
   *  nsjail——此前删除只能靠 run_command 的 rm，Windows 预览和 nsjail
   *  不可用的主机连这条路也没有，模型写的临时产物永远清不掉。目录默认
   *  必须为空，显式 recursive 才递归删除；沙箱根本身不可删。 */
  async delete(path: string, recursive = false): Promise<{ deleted: number; path: string }> {
    if (!this.enabled) throw new Error('沙箱未启用');
    const target = this.safePath(path);
    if (target === resolve(this.root)) throw new Error('不能删除沙箱根目录');
    const stat = lstatSync(target, { throwIfNoEntry: false });
    if (!stat) throw new Error('文件不存在');
    // lstat 保证删的是链接本身而非其目标；safePath 的 realpath 检查已把
    // 指向沙箱外的符号链接挡在前面。目录分两路：空目录 rmdirSync 即可
    // （Windows 上 rmSync 不带 recursive 删目录会 EISDIR），recursive 才
    // 用递归删除。
    if (stat.isDirectory()) {
      if (!recursive && readdirSync(target).length)
        throw new Error('目录非空；确认后用 recursive 递归删除');
      if (recursive) rmSync(target, { recursive: true, force: false });
      else rmdirSync(target);
    } else rmSync(target, { force: false });
    return { deleted: 1, path: relative(this.root, target) || '.' };
  }

  async run(command: string, signal?: AbortSignal): Promise<SandboxResult> {
    const started = Date.now();
    if (!this.enabled) throw new Error('沙箱未启用');
    const trimmed = command.trim();
    if (!trimmed) throw new Error('命令不能为空');
    if (trimmed.length > 4000) throw new Error('命令过长');
    this.assertWithinQuota();
    // 隔离优先级：她的窝（docker 常驻，环境跨轮保留）→ nsjail → 拒绝。
    // 退化为宿主 shell 不是"降级隔离"，是带着数据库与全部密钥的任意
    // 代码执行——三个都不给时宁可拒绝。
    const image = this.options.dockerImage?.();
    if (image) return this.dockerRun(image, trimmed, started, signal);
    const useNsjail = await this.nsjailAvailable();
    if (!useNsjail && !this.allowDirectoryFallback)
      throw new Error(
        '当前主机无法使用 nsjail 命名空间隔离，沙箱命令已拒绝执行。' +
          '请部署在支持 user namespace 的 Linux 主机，配置 ATRI_SANDBOX_IMAGE 启用常驻容器，' +
          '或在开发环境显式开启目录回退。',
      );
    const result = await this.spawn(
      useNsjail ? this.nsjailArgs(trimmed) : this.fallbackArgs(trimmed),
      useNsjail ? 'nsjail' : 'directory',
      started,
      signal,
    );
    // 一条命令能一口气建很多文件：跑完再查，超了就让下一次调用被拦。
    if (result.ok) this.assertWithinQuota();
    return result;
  }

  /** 她的窝（#7，beta persistent-workshop 语义）：固定名常驻容器。inspect
   *  核对镜像与网络——不匹配就 rm -f 重建（配置改了，旧窝不配再住）；
   *  没在跑就 start（主机重启后 Docker 自动拉起 unless-stopped 的容器，
   *  手动 stop 的也要在 start 时扶起来）。执行走 exec + 容器内 timeout
   *  ——exec 客户端断开不影响容器内裁决，进程不悬挂。 */
  private async dockerRun(
    image: string,
    command: string,
    started: number,
    signal?: AbortSignal,
  ): Promise<SandboxResult> {
    const name = 'atri-sandbox';
    const network = this.options.network();
    const works = this.options.dockerWorks?.() ?? this.root;
    const tz = this.options.timeZone?.() || process.env.TZ || 'UTC';
    const spec = dockerSpec(name, network, works, tz);
    let existing: { running: boolean; image: string; network: string } | undefined;
    try {
      const info = JSON.parse(await this.capture('docker', ['inspect', name])) as {
        State?: { Running?: unknown };
        Config?: { Image?: unknown };
        HostConfig?: { NetworkMode?: unknown };
      }[];
      const node = info[0] ?? {};
      existing = {
        running: Boolean(node.State?.Running),
        image: String(node.Config?.Image ?? ''),
        network: String(node.HostConfig?.NetworkMode ?? ''),
      };
    } catch {
      existing = undefined; // 容器不存在 / docker 不可用：走新建
    }
    const wantNetwork = network ? 'bridge' : 'none';
    if (!existing || existing.image !== image || existing.network !== wantNetwork) {
      if (existing) await this.capture('docker', ['rm', '-f', name]);
      await this.capture('docker', ['run', '-d', ...spec, image, 'sleep', 'infinity']);
    } else if (!existing.running) {
      await this.capture('docker', ['start', name]);
    }
    // 配额对 docker 模式同样生效：写完就查，超了让下一次调用被拦。
    // timeoutMs=0（不限时）时容器内不装 timeout——ceil(0)=0 会让
    // "不限时"变成 1 秒被杀；此时外层 deadline 兜底（2147483647ms 上限）。
    const limitMs = this.commandTimeoutMs;
    const seconds = limitMs > 0 ? Math.max(1, Math.ceil(limitMs / 1000)) : 0;
    const deadline = AbortSignal.any([
      signal ?? new AbortController().signal,
      AbortSignal.timeout(limitMs > 0 ? limitMs : 2_147_483_647),
    ]);
    let stdout = '',
      stderr = '',
      timedOut = false;
    const cap = (chunk: Buffer, current: string): string =>
      current.length >= this.outputLimit
        ? current
        : (current + chunk.toString('utf8')).slice(0, this.outputLimit);
    return await new Promise<SandboxResult>((resolvePromise) => {
      const inner = seconds > 0 ? ['timeout', `${seconds}s`] : [];
      const child = spawn('docker', ['exec', name, ...inner, 'sh', '-c', command], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      const finish = (code: number | null) => {
        if (deadline.aborted && !timedOut) timedOut = true;
        resolvePromise({
          ok: code === 0 && !deadline.aborted,
          code,
          stdout,
          stderr,
          truncated: stdout.length >= this.outputLimit || stderr.length >= this.outputLimit,
          durationMs: Date.now() - started,
          timedOut,
          isolation: 'persistent-workshop',
        });
      };
      deadline.addEventListener(
        'abort',
        () => {
          timedOut = true;
          stderr = cap(Buffer.from('\n命令超时，已被终止。'), stderr);
          this.kill(child.pid);
        },
        { once: true },
      );
      child.stdout.on('data', (b: Buffer) => (stdout = cap(b, stdout)));
      child.stderr.on('data', (b: Buffer) => (stderr = cap(b, stderr)));
      child.on('error', (error) => {
        stderr += `\n容器执行不可用：${error.message}`;
        finish(null);
      });
      child.on('close', finish);
    });
  }

  /** 跑一个 docker 命令并收 stdout（inspect 解析 / rm / run / start 都用它）：
   *  非零退出或 docker 缺席都抛错——她的窝建不起来就交给上层降级路径。 */
  private capture(bin: string, args: string[]): Promise<string> {
    return new Promise((resolvePromise, reject) => {
      const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      let out = '',
        err = '';
      child.stdout.on('data', (c: Buffer) => (out += c.toString('utf8')));
      child.stderr.on('data', (c: Buffer) => (err += c.toString('utf8')));
      child.on('error', (error) => reject(new Error(`docker 不可用：${error.message}`)));
      child.on('close', (code) =>
        code === 0
          ? resolvePromise(out)
          : reject(new Error(err.trim() || `docker ${args[0]} 退出码 ${code}`)),
      );
    });
  }

  /** nsjail 参数：mount/pid/ipc/uts/user 命名空间（命令内是 PID 1），
   *  系统目录只读，/app 与 /data 用空 tmpfs 遮蔽（不能遮沙箱自己的
   *  目录——盖掉 cwd 命令就没有工作目录了）。网络是运维的决定：
   *  默认独立空网络命名空间；--disable_clone_newnet 是"共享宿主网络"，
   *  旗子名读着反，实际语义就是它。不用 cgroup：普通容器里 cgroupfs
   *  只读，nsjail 要 --cgroupns=host；rlimit 不需要额外权限。 */
  private nsjailArgs(command: string): { bin: string; args: string[] } {
    const args = ['--really_quiet', '--chroot', '/', '--cwd', this.root, '--bindmount', this.root];
    for (const dir of ['/usr', '/lib', '/lib64', '/bin', '/sbin', '/etc'])
      if (existsSync(dir)) args.push('--bindmount_ro', dir);
    // node 不在上面那些路径下（/usr/local），npm 的 shebang 会找不到它。
    if (existsSync('/usr/local')) args.push('--bindmount_ro', '/usr/local');
    // 可写暂存目录给 npm 缓存、git objects、/tmp 与 HOME。必须直接绑到
    // /tmp：裸 --bindmount 加单独 --tmpfsmount /tmp 会让同一目录被挂两
    // 次，nsjail 直接启动失败。
    args.push(`--bindmount=${this.tmpDir}:/tmp`);
    // nsjail 全量替换环境：PATH/HOME 必须显式给（空 HOME 会让 env 找
    // 不到 node），TZ/LANG 也要带（否则 date 走 UTC，与她的"现在是…"
    // 差一个时区偏移）。
    args.push(`--env=PATH=${SANDBOX_PATH}`, `--env=HOME=/tmp`);
    const tz = this.options.timeZone?.() || process.env.TZ;
    args.push(`--env=LANG=${SANDBOX_LANG}`);
    if (tz) args.push(`--env=TZ=${tz}`);
    for (const hidden of ['/app', '/data']) {
      if (!existsSync(hidden)) continue;
      const rel = relative(resolve(hidden), this.root);
      if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) continue;
      args.push('--tmpfsmount', hidden);
    }
    if (this.options.network()) args.push('--disable_clone_newnet');
    const mem = this.options.memoryLimitMb?.() ?? 0;
    // nsjail 的 rlimit_as 单位就是 MiB：乘 1024 会把 2 GiB 变成 2 TiB。
    if (mem > 0) args.push('--rlimit_as', String(mem));
    args.push('--', '/bin/sh', '-c', command);
    return { bin: NSJAIL, args };
  }
  /** nsjail 不可用时的普通子 shell：仍限制在沙箱目录与清洗过的环境，
   *  只是没有命名空间（仅测试显式开启）。 */
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
        settled = false,
        timedOut = false;
      // 边流边限，而不是读完再限。
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
      const limit = this.commandTimeoutMs;
      const timer =
        limit > 0
          ? setTimeout(() => {
              timedOut = true;
              stderr = cap(
                Buffer.from(`\n命令超过 ${Math.round(limit / 60000)} 分钟时限，已被终止。`),
                stderr,
              );
              this.kill(child.pid);
            }, limit)
          : undefined;
      const finish = (code: number | null) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
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
          timedOut,
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
  /** 杀整个进程组：shell 会 fork，只杀 shell 会留下真正的命令。 */
  private kill(pid?: number): void {
    if (!pid) return;
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // 已经退出。
      }
    }
  }

  /** 设置页展示的隔离真相。 */
  async isolationInfo(): Promise<{
    level: 'persistent-workshop' | 'nsjail' | 'directory';
    note: string;
    network: string;
  }> {
    const wantsNetwork = this.options.network();
    const network = wantsNetwork ? '已启用（共享容器网络）' : '已禁用（独立网络命名空间）';
    const image = this.options.dockerImage?.();
    if (image)
      return {
        level: 'persistent-workshop',
        note: `她的窝：固定名常驻容器（${image}），restart unless-stopped 崩溃自拉起，可写层跨轮保留——她攒的环境不丢。cap 全卸、no-new-privileges、pids/内存/CPU 三限，作品目录 bind 挂载，数据库与密钥不可见。`,
        network,
      };
    if (process.platform === 'win32')
      return {
        level: 'directory',
        note: '当前是 Windows 预览环境：无法提供 nsjail，沙箱命令会被拒绝执行。生产环境请使用 Linux 容器。',
        network,
      };
    const nsjail = await this.nsjailAvailable();
    return {
      level: nsjail ? 'nsjail' : 'directory',
      note: nsjail
        ? 'nsjail 命名空间隔离：独立 mount/pid/ipc/uts/user 命名空间，系统目录只读挂载，沙箱目录是唯一可写路径，应用目录与数据库已被空 tmpfs 遮蔽。'
        : 'nsjail 不可用：沙箱命令会被拒绝执行，避免以 API 进程权限直接运行。请检查内核 user namespace、容器权限，或配置 ATRI_SANDBOX_IMAGE 启用常驻容器。',
      network,
    };
  }
}
