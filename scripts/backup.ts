import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { Store, createBackup } from '../src/db/index.js';

const dataDir = resolve(process.env.DATA_DIR || 'data');
// 库文件名新旧兼容：xing.db（本代）与 atri.db（4.0 时代就地升级的库）。
const dbFile =
  existsSync(join(dataDir, 'xing.db')) || !existsSync(join(dataDir, 'atri.db'))
    ? 'xing.db'
    : 'atri.db';
if (!existsSync(join(dataDir, dbFile))) throw new Error('数据目录中没有数据库');
const store = new Store(join(dataDir, dbFile));
try {
  const result = await createBackup(store, dataDir);
  console.log(`备份完成：${result.directory}`);
} finally {
  store.close();
}
