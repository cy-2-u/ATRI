// 首次部署可选：把 assets/stickers 自带表情库灌进数据目录。
// 用法：node scripts/seed-stickers.ts [数据目录]
import { readFile, mkdir, writeFile, copyFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const data = resolve(process.argv[2] ?? join(root, 'data'));
await mkdir(join(data, 'works'), { recursive: true });
const store = new Store(join(data, 'atri.db'));
const assets = join(root, 'assets', 'stickers');
const catalog: { slug: string; description: string; file: string }[] = JSON.parse(await readFile(join(assets, 'catalog.json'), 'utf8'));
const existing = store.get<{ slug: string; path: string; description: string }[]>('stickers', []);
const added: typeof existing = [];
for (const item of catalog) {
  if (existing.some(s => s.slug === item.slug)) continue;
  const extension = item.file.split('.').at(-1) ?? 'jpg';
  const path = `stickers/${item.slug}.${extension}`;
  const bytes = await readFile(join(assets, item.file));
  await mkdir(dirname(join(data, 'works', path)), { recursive: true });
  await writeFile(join(data, 'works', path), bytes);
  added.push({ slug: item.slug, path, description: item.description });
}
if (added.length) store.set('stickers', [...existing, ...added]);
console.log(`表情入库：新增 ${added.length} 个，共 ${existing.length + added.length} 个（数据目录 ${data}）`);
store.close();
