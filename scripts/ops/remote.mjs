// Remote operations for the ATRI host, in one entry point.
//
// The five old scripts duplicated the same askpass/SSH option setup. This one
// keeps the same operations as subcommands:
//
//   node scripts/ops/remote.mjs ssh <host> <user> <password> <command...>
//   node scripts/ops/remote.mjs script <host> <user> <password> <local-script>
//   node scripts/ops/remote.mjs scp <host> <user> <password> <remote-dir> <local-dir>
//   node scripts/ops/remote.mjs container <host> <password> <snippet-file>
//   node scripts/ops/remote.mjs host <host> <password> <snippet-file>
//
// Passwords travel through a throwaway askpass file, never through the remote
// shell. They are still positional arguments on the local side, so run these
// from a trusted terminal and avoid shell history where possible.
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SSH_OPTIONS = [
  '-o',
  'StrictHostKeyChecking=no',
  '-o',
  'UserKnownHostsFile=NUL',
  '-o',
  'LogLevel=ERROR',
];

const USAGE = `用法：
  node scripts/ops/remote.mjs ssh <host> <user> <password> <command...>
  node scripts/ops/remote.mjs script <host> <user> <password> <local-script>
  node scripts/ops/remote.mjs scp <host> <user> <password> <remote-dir> <local-dir>
  node scripts/ops/remote.mjs container <host> <password> <snippet-file>
  node scripts/ops/remote.mjs host <host> <password> <snippet-file>`;

function fail(message) {
  console.error(message);
  console.error(USAGE);
  process.exit(2);
}

function withAskpass(password, run) {
  if (!password) fail('缺少密码参数');
  const askpass = join(tmpdir(), `askpass-${process.pid}.cmd`);
  writeFileSync(askpass, `@echo off\r\necho ${password}\r\n`, 'utf8');
  const env = { ...process.env, SSH_ASKPASS: askpass, SSH_ASKPASS_REQUIRE: 'force', DISPLAY: '1' };
  try {
    return run(env);
  } finally {
    rmSync(askpass, { force: true });
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
  process.stdout.write(
    ssh(
      host,
      'root',
      password,
      'docker exec -i atri-atri-1 sh -s',
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
