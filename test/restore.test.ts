import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { restore } from '../scripts/restore.js';

/** 备份→恢复闭环：备份能写出去（backup.test），恢复能把它们带回来——
 *  只测一半的备份链路等于没测：灾备的价值全在恢复那一端。 */

function restoreFixture() {
  const backupDir = mkdtempSync(join(tmpdir(), 'atri-restore-src-'));
  const dataDir = mkdtempSync(join(tmpdir(), 'atri-restore-dst-'));
  const sandboxDir = mkdtempSync(join(tmpdir(), 'atri-restore-sandbox-'));
  return {
    backupDir,
    dataDir,
    sandboxDir,
    close() {
      rmSync(backupDir, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(sandboxDir, { recursive: true, force: true });
    },
  };
}

test('备份→恢复闭环：数据库、表情、墙图与沙箱作品全部回到位', () => {
  const env = restoreFixture();
  try {
    // 造一份 backup.ts 形状的产物：db.gz + custom/ + wall/ + sandbox/（含两层）。
    writeFileSync(join(env.backupDir, 'atri.db.gz'), gzipSync(Buffer.from('db-bytes')));
    mkdirSync(join(env.backupDir, 'custom'), { recursive: true });
    writeFileSync(join(env.backupDir, 'custom', 'meme.png'), 'png-bytes');
    mkdirSync(join(env.backupDir, 'wall'), { recursive: true });
    writeFileSync(join(env.backupDir, 'wall', 'note.png'), 'wall-bytes');
    mkdirSync(join(env.backupDir, 'sandbox', 'pictures', '2026'), { recursive: true });
    writeFileSync(join(env.backupDir, 'sandbox', 'pictures', '2026', 'jelly.png'), 'jelly-bytes');

    restore(env.backupDir, env.dataDir, env.sandboxDir);

    assert.equal(readFileSync(join(env.dataDir, 'atri.db'), 'utf8'), 'db-bytes');
    assert.equal(readFileSync(join(env.dataDir, 'custom', 'meme.png'), 'utf8'), 'png-bytes');
    assert.equal(readFileSync(join(env.dataDir, 'wall', 'note.png'), 'utf8'), 'wall-bytes');
    assert.equal(
      readFileSync(join(env.sandboxDir, 'pictures', '2026', 'jelly.png'), 'utf8'),
      'jelly-bytes',
    );
    // 恢复后的目录不再是"空库"：二次恢复必须被拒（不覆盖更活的现在）。
    assert.throws(() => restore(env.backupDir, env.dataDir, env.sandboxDir), /已有 atri\.db/);
  } finally {
    env.close();
  }
});

test('恢复拒绝：目标目录已有内容时不合并两个时代', () => {
  const env = restoreFixture();
  try {
    writeFileSync(join(env.backupDir, 'atri.db.gz'), gzipSync(Buffer.from('db-bytes')));
    mkdirSync(join(env.backupDir, 'wall'), { recursive: true });
    writeFileSync(join(env.backupDir, 'wall', 'new.png'), 'new-bytes');
    mkdirSync(join(env.backupDir, 'sandbox', 'pictures'), { recursive: true });
    writeFileSync(join(env.backupDir, 'sandbox', 'pictures', 'old.png'), 'old-bytes');
    // 沙箱目标里已有她现在的东西：直接拷贝等于把两个时代搅在一起。
    mkdirSync(join(env.sandboxDir, 'pictures'), { recursive: true });
    writeFileSync(join(env.sandboxDir, 'pictures', 'current.png'), 'current-bytes');
    assert.throws(() => restore(env.backupDir, env.dataDir, env.sandboxDir), /已有内容/);
    // 拒绝发生在任何拷贝之前：wall 一个字节都没落地。
    assert.ok(!existsSync(join(env.dataDir, 'wall')));
  } finally {
    env.close();
  }
});
