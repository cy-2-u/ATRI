// Run a shell snippet inside the ATRI container. The snippet goes over stdin so
// the local shell never tries to interpret the remote quoting.
import { execFileSync } from 'node:child_process';
import { writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [host, password, snippetFile] = process.argv.slice(2);
const snippet = readFileSync(snippetFile, 'utf8');
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
      'docker exec -i atri-atri-1 sh -s',
    ],
    {
      encoding: 'utf8',
      input: snippet,
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
