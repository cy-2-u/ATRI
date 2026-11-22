import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';
import { Store } from '../src/store.ts';

// 临时区登记制：文件全部测试结束后统一关库、删目录（Windows 文件锁尽力重试）。
const roots = new Set<string>();
const stores = new Set<Store>();
after(() => {
  for (const s of stores) { try { s.close(); } catch { /* 已关 */ } }
  for (const d of roots) { try { rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* 尽力清理 */ } }
});
export const tmpRoot = (prefix: string): string => { const d = mkdtempSync(join(tmpdir(), prefix)); roots.add(d); return d; };
export const tmpOpen = (path: string, now?: () => number): Store => { const s = new Store(path, now); stores.add(s); return s; };
export const tmpStore = (prefix: string, now?: () => number): Store => tmpOpen(join(tmpRoot(prefix), 'atri.db'), now);
