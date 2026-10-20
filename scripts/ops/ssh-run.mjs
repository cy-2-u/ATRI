// Run a command on the ATRI host over SSH with a password supplied via a
// throwaway askpass script, so the password never lands in argv or the shell
// history of the host itself.
import { execFileSync } from 'node:child_process';
import { writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [host, user, password, ...cmd] = process.argv.slice(2);
const askpass = join(tmpdir(), `askpass-${process.pid}.cmd`);
writeFileSync(askpass, `@echo off\r\necho ${password}\r\n`, 'utf8');
try {
  const out = execFileSync(
    'ssh',
    [
      '-o',
      'StrictHostKeyChecking=no',
      '-o',
      'UserKnownHostsFile=NUL',
      '-o',
      'LogLevel=ERROR',
      '-o',
      `SetEnv=SSH_ASKPASS_REQUIRE=force`,
      `${user}@${host}`,
      cmd.join(' '),
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
