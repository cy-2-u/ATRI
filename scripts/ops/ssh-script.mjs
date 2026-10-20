// Run a local shell script on the ATRI host. The script is base64-encoded and
// decoded remotely, so none of its quoting has to survive the local shell, the
// ssh argv, or the remote sh before it runs.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [host, user, password, scriptPath] = process.argv.slice(2);
const b64 = readFileSync(scriptPath).toString('base64');
const askpass = join(tmpdir(), `askpass-${process.pid}.cmd`);
writeFileSync(askpass, `@echo off\r\necho ${password}\r\n`, 'utf8');
try {
  const out = execFileSync(
    'ssh',
    [
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'UserKnownHostsFile=NUL',
      '-o', 'LogLevel=ERROR',
      `${user}@${host}`,
      `echo ${b64} | base64 -d | sh`,
    ],
    {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, SSH_ASKPASS: askpass, SSH_ASKPASS_REQUIRE: 'force', DISPLAY: '1' },
    },
  );
  process.stdout.write(out);
} finally {
  rmSync(askpass, { force: true });
}
