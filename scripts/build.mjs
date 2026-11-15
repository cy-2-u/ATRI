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
    // fastify/avvio 在 CJS 里动态 require('node:events')——esbuild 的 ESM
    // bundle 无法静态转换它，运行时抛 "Dynamic require of ..."。注入
    // createRequire 让 bundle 内的 require 落回真实解析（CI 不启动生产
    // 产物，这个错只有真部署才炸得出来）。
    banner: {
      js: "import { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);",
    },
  });
}
cpSync('shared', 'dist/shared', { recursive: true });
console.log('build ok');
