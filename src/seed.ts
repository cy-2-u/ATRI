// 启动时把 assets/stickers 自带表情库灌进数据目录（幂等：按 slug 去重，已入库则零开销）。
// 容器镜像不带 scripts/，灌库必须走启动流程；assets 由 Dockerfile COPY 进镜像。
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const seedStickers = async (data: string, root: string, get: <T>(key: string, fallback: T) => T, set: (key: string, value: unknown) => void): Promise<number> => {
  let catalog: { slug: string; description: string; file: string }[];
  try { catalog = JSON.parse(await readFile(join(root, 'assets', 'stickers', 'catalog.json'), 'utf8')); }
  catch { return 0; // 没带表情库的部署（如本地裸数据目录）静默跳过
  }
  const existing = get<{ slug: string; path: string; description: string }[]>('stickers', []);
  const added: typeof existing = [];
  for (const item of catalog) {
    if (existing.some(s => s.slug === item.slug)) continue;
    const extension = item.file.split('.').at(-1) ?? 'jpg';
    const path = `stickers/${item.slug}.${extension}`;
    const bytes = await readFile(join(root, 'assets', 'stickers', item.file));
    await mkdir(dirname(join(data, 'works', path)), { recursive: true });
    await writeFile(join(data, 'works', path), bytes);
    added.push({ slug: item.slug, path, description: item.description });
  }
  if (added.length) set('stickers', [...existing, ...added]);
  return added.length;
};
