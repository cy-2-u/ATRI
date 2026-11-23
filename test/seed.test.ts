import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { strict } from 'node:assert';
import { test } from 'node:test';
import { seedStickers } from '../src/seed.ts';

test('seedStickers 幂等灌库：首次全量、二次零新增、目录缺失静默跳过', async () => {
  const root = await mkdtemp(join(tmpdir(), 'atri-seed-'));
  try {
    await mkdir(join(root, 'assets', 'stickers', 'memes'), { recursive: true });
    await writeFile(join(root, 'assets', 'stickers', 'catalog.json'), JSON.stringify([
      { slug: 'cat001', description: '测试猫一', file: 'memes/001.jpg' },
      { slug: 'cat002', description: '测试猫二', file: 'memes/002.jpg' },
    ]), 'utf8');
    await writeFile(join(root, 'assets', 'stickers', 'memes', '001.jpg'), Buffer.from('a'), 'binary');
    await writeFile(join(root, 'assets', 'stickers', 'memes', '002.jpg'), Buffer.from('b'), 'binary');
    const data = join(root, 'data');
    await mkdir(data, { recursive: true }); // Store/DatabaseSync 不会自建目录
    const db = new DatabaseSync(join(data, 'atri.db'));
    let stickers: { slug: string }[] = [];
    const get = <T,>(key: string, fallback: T): T => key === 'stickers' ? (stickers as unknown as T) : fallback;
    const set = (key: string, value: unknown): void => { if (key === 'stickers') stickers = value as typeof stickers; };

    strict.equal(await seedStickers(data, root, get, set), 2);
    strict.equal(stickers.length, 2);
    strict.ok(await writeFile(join(data, 'works', 'stickers', 'cat001.jpg'), Buffer.from('a')).then(() => true));

    strict.equal(await seedStickers(data, root, get, set), 0); // 幂等：同 slug 不重复
    strict.equal(stickers.length, 2);

    strict.equal(await seedStickers(data, join(root, 'nowhere'), get, set), 0); // assets 缺失静默跳过
    db.close();
    strict.deepEqual(stickers.map(s => s.slug), ['cat001', 'cat002']);
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 3 }).catch(() => {}); } // Windows 下 node:sqlite 释放文件锁有延迟，清理失败不影响断言
});
