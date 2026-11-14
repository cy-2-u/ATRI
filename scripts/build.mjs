import { build } from 'esbuild';
import { cpSync, mkdirSync } from 'node:fs';

const entries = ['src/index.ts', 'scripts/backup.ts', 'scripts/restore.ts', 'scripts/migrate.ts'];
mkdirSync('dist', { recursive: true });
for (const entry of entries) {
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'esm',
    outfile: entry
      .replace(/^src\//, 'dist/')
      .replace(/^scripts\//, 'dist/')
      .replace(/\.ts$/, '.js'),
    external: ['node:*'],
    sourcemap: false,
    logLevel: 'warning',
  });
}
cpSync('shared', 'dist/shared', { recursive: true });
console.log('build ok');
