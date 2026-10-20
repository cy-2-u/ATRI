// Remote operations for the ATRI host, in one entry point.
//
// The five old scripts duplicated the same askpass/SSH option setup. This one
// keeps the same operations as subcommands:
//
//   node scripts/ops/remote.mjs ssh <host> <user> <password|-> <command...>
//   node scripts/ops/remote.mjs script <host> <user> <password|-> <local-script>
//   node scripts/ops/remote.mjs scp <host> <user> <password|-> <remote-dir> <local-dir>
//   node scripts/ops/remote.mjs container <host> <password|-> <snippet-file>
//   node scripts/ops/remote.mjs host <host> <password|-> <snippet-file>
//
// Pass "-" as the password to read it from ATRI_SSH_PASSWORD instead of argv.
// The secret reaches askpass through the child environment, never through a
// temporary file or the remote shell. Host keys use TOFU (accept-new), so a
// changed key is still rejected — the old NUL known_hosts disabled that check.
import { execFileSync } from 'node:child_process';
import { chmodSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SSH_OPTIONS = ['-o', 'StrictHostKeyChecking=accept-new', '-o', 'LogLevel=ERROR'];

const USAGE = `用法：
  node scripts/ops/remote.mjs ssh <host> <user> <password|-> <command...>
  node scripts/ops/remote.mjs script <host> <user> <password|-> <local-script>
  node scripts/ops/remote.mjs scp <host> <user> <password|-> <remote-dir> <local-dir>
  node scripts/ops/remote.mjs container <host> <password|-> <snippet-file>
  node scripts/ops/remote.mjs host <host> <password|-> <snippet-file>
密码位传 - 时从 ATRI_SSH_PASSWORD 读取，避免出现在进程参数和 shell 历史里。`;

function fail(message) {
  console.error(message);
  console.error(USAGE);
  process.exit(2);
}

function resolvePassword(value) {
  if (value === '-') return process.env.ATRI_SSH_PASSWORD || '';
  return value || '';
}
function withAskpass(passwordArg, run) {
  const password = resolvePassword(passwordArg);
  if (!password) fail('缺少密码参数（也可用 ATRI_SSH_PASSWORD 环境变量并传 -）');
  const base = join(tmpdir(), `atri-askpass-${process.pid}-${randomUUID().slice(0, 8)}`);
  const secretScript = `${base}.mjs`;
  const askpass = process.platform === 'win32' ? `${base}.cmd` : `${base}.sh`;
  // The password lives only in the child environment. Interpolating it into a
  // .cmd file broke on &, |, %, ^ and friends, and briefly wrote a plaintext
  // secret to disk.
  writeFileSync(secretScript, "process.stdout.write(process.env.ATRI_ASKPASS_SECRET || '');\n", {
    encoding: 'utf8',
    mode: 0o600,
  });
  if (process.platform === 'win32') {
    writeFileSync(askpass, `@echo off\r\n"${process.execPath}" "${secretScript}"\r\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
  } else {
    writeFileSync(askpass, `#!/bin/sh\nexec "${process.execPath}" "${secretScript}"\n`, {
      encoding: 'utf8',
      mode: 0o700,
    });
    try {
      chmodSync(askpass, 0o700);
    } catch {
      /* best effort */
    }
  }
  const env = {
    ...process.env,
    SSH_ASKPASS: askpass,
    SSH_ASKPASS_REQUIRE: 'force',
    DISPLAY: '1',
    ATRI_ASKPASS_SECRET: password,
  };
  try {
    return run(env);
  } finally {
    rmSync(askpass, { force: true });
    rmSync(secretScript, { force: true });
  }
}

function ssh(host, user, password, command, input) {
  return withAskpass(password, (env) =>
    execFileSync('ssh', [...SSH_OPTIONS, `${user}@${host}`, command], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      input,
      env,
    }),
  );
}

const [mode, ...args] = process.argv.slice(2);

if (!mode || mode === 'help' || mode === '--help') {
  console.log(USAGE);
  process.exit(0);
}

if (mode === 'ssh') {
  const [host, user, password, ...command] = args;
  if (!host || !user || !command.length) fail('ssh 需要 host、user 和命令');
  process.stdout.write(ssh(host, user, password, command.join(' ')));
} else if (mode === 'script') {
  const [host, user, password, scriptPath] = args;
  if (!host || !user || !scriptPath) fail('script 需要 host、user 和脚本路径');
  const encoded = readFileSync(scriptPath).toString('base64');
  process.stdout.write(ssh(host, user, password, `echo ${encoded} | base64 -d | sh`));
} else if (mode === 'scp') {
  const [host, user, password, remoteDir, localDir] = args;
  if (!host || !user || !remoteDir || !localDir) fail('scp 需要 host、user、远端目录和本地目录');
  withAskpass(password, (env) => {
    const output = execFileSync(
      'scp',
      [...SSH_OPTIONS, '-r', `${user}@${host}:${remoteDir}`, localDir],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env },
    );
    process.stdout.write(output);
  });
} else if (mode === 'container') {
  const [host, password, snippetFile] = args;
  if (!host || !snippetFile) fail('container 需要 host 和片段文件');
  // Resolve the compose service instead of a hard-coded container name:
  // `docker compose` prefixes containers with the project directory, so the
  // old atri-atri-1 broke as soon as the checkout was renamed. ATRI_CONTAINER
  // overrides the lookup for non-compose deployments.
  const findContainer =
    process.env.ATRI_CONTAINER ||
    '$(docker ps -q --filter label=com.docker.compose.service=atri | head -n1)';
  process.stdout.write(
    ssh(
      host,
      'root',
      password,
      `cid=${findContainer}; [ -n "$cid" ] || { echo "atri container not found" >&2; exit 1; }; docker exec -i "$cid" sh -s`,
      readFileSync(snippetFile, 'utf8'),
    ),
  );
} else if (mode === 'host') {
  const [host, password, snippetFile] = args;
  if (!host || !snippetFile) fail('host 需要 host 和片段文件');
  process.stdout.write(ssh(host, 'root', password, 'sh -s', readFileSync(snippetFile, 'utf8')));
} else {
  fail(`未知子命令：${mode}`);
}
