// Run a shell snippet on the ATRI host, piping the file over stdin.
import { execFileSync } from 'node:child_process';
import { writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [host, password, snippetFile] = process.argv.slice(2);
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
      `root@${host}`,
      'sh -s',
    ],
    {
      encoding: 'utf8',
      input: readFileSync(snippetFile, 'utf8'),
      maxBuffer: 32 * 1024 * 1024,
      env: {
        ...process.env,
        SSH_ASKPASS: askpass,
        SSH_ASKPASS_REQUIRE: 'force',
        DISPLAY: '1',
      },
    },
  );
  process.stdout.write(out);
} finally {
  rmSync(askpass, { force: true });
}
