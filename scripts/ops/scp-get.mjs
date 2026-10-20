// Pull the backup archive bundle from the server over SSH (password via askpass,
// same approach as ssh-run.mjs: the password never lands in argv or shell history).
import { execFileSync } from 'node:child_process';
import { writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [host, user, password, remoteDir, localDir] = process.argv.slice(2);
const askpass = join(tmpdir(), `askpass-${process.pid}.cmd`);
writeFileSync(askpass, `@echo off\r\necho ${password}\r\n`, 'utf8');
mkdirSync(localDir, { recursive: true });
try {
  const out = execFileSync(
    'scp',
    [
      '-o',
      'StrictHostKeyChecking=no',
      '-o',
      'UserKnownHostsFile=NUL',
      '-o',
      'LogLevel=ERROR',
      '-r',
      `${user}@${host}:${remoteDir}`,
      localDir,
    ],
    {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, SSH_ASKPASS: askpass, SSH_ASKPASS_REQUIRE: 'force', DISPLAY: '1' },
    },
  );
  process.stdout.write(out);
} finally {
  rmSync(askpass, { force: true });
}
