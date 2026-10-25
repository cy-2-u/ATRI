import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { Sandbox } from '../src/api/sandbox.js';
import { cleanup } from './helpers.js';

/** 沙箱的文件工具（write/read/delete/list）：纯文件系统操作，跨平台
 *  可测（nsjail 只影响 run_command）。 */

function sandboxFixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'atri-sbx-'));
  const sandbox = new Sandbox(root, {
    enabled: () => true,
    network: () => false,
    sizeLimitBytes: () => 0,
    memoryLimitMb: () => 0,
    timeoutMs: () => 60000,
  });
  cleanup(t, () => sandbox.dispose());
  return { root, sandbox };
}

test('delete_file：删除文件后读取失败，删除不存在的报错', async (t) => {
  const { root, sandbox } = sandboxFixture(t);
  await sandbox.write('tmp.txt', '过期数据');
  writeFileSync(join(root, 'note.txt'), 'x'); // 预置文件同样可删
  const result = await sandbox.delete('tmp.txt');
  assert.equal(result.deleted, 1);
  await assert.rejects(sandbox.read('tmp.txt'), /文件不存在/);
  await sandbox.delete('note.txt');
  await assert.rejects(sandbox.delete('tmp.txt'), /文件不存在/);
});

test('delete_file：非空目录默认拒绝，recursive 才整棵删除', async (t) => {
  const { root, sandbox } = sandboxFixture(t);
  mkdirSync(join(root, 'work'));
  writeFileSync(join(root, 'work', 'a.txt'), 'a');
  await assert.rejects(sandbox.delete('work'), /目录非空/);
  const result = await sandbox.delete('work', true);
  assert.equal(result.deleted, 1);
  const listing = await sandbox.list('.');
  assert.ok(!listing.entries.some((e) => e.name === 'work'), '目录已被移除');
  // 空目录不需要 recursive
  mkdirSync(join(root, 'empty'));
  await sandbox.delete('empty');
  assert.ok(!(await sandbox.list('.')).entries.some((e) => e.name === 'empty'));
});

test('delete_file：路径逃逸与沙箱根本身都拒绝', async (t) => {
  const { sandbox } = sandboxFixture(t);
  await assert.rejects(sandbox.delete('../../etc/passwd'), /超出沙箱范围/);
  await assert.rejects(sandbox.delete('.'), /不能删除沙箱根目录/);
  await assert.rejects(sandbox.delete('/'), /不能删除沙箱根目录|超出沙箱范围/);
});

test('delete_file：未启用时一切文件工具拒绝', async () => {
  const root = mkdtempSync(join(tmpdir(), 'atri-sbx-'));
  const sandbox = new Sandbox(root, {
    enabled: () => false,
    network: () => false,
    sizeLimitBytes: () => 0,
  });
  sandbox.dispose();
  await assert.rejects(sandbox.delete('any.txt'), /沙箱未启用/);
});
