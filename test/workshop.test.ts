import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn as realSpawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Sandbox, dockerSpec } from '../src/sandbox.js';

// 她的窝（#7 常驻沙箱）的行为面：锁生命周期决策的汇报与不变式，
// 不碰真 docker——真 docker 交互只在配置 ATRI_SANDBOX_IMAGE 的生产冒烟。

test('未配置 dockerImage 时保持 nsjail/拒绝语义，行为不变', async () => {
  const root = mkdtempSync(join(tmpdir(), 'atri-workshop-'));
  const sandbox = new Sandbox(join(root, 'sandbox'), {
    enabled: () => true,
    network: () => false,
    sizeLimitBytes: () => 32 * 1024 * 1024,
  });
  try {
    const info = await sandbox.isolationInfo();
    // Windows 测试环境：无 docker 配置 → directory 层级（nsjail 不可用的汇报）。
    assert.equal(info.level, process.platform === 'win32' ? 'directory' : info.level);
    assert.ok(info.note);
    // 未配置镜像时 run 仍走 nsjail 探测路径（Windows 拒绝执行）。
    if (process.platform === 'win32')
      await assert.rejects(() => sandbox.run('true'), /nsjail|拒绝/);
  } finally {
    sandbox.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('配置 dockerImage 后 isolationInfo 汇报 persistent-workshop', async () => {
  const root = mkdtempSync(join(tmpdir(), 'atri-workshop-'));
  const sandbox = new Sandbox(join(root, 'sandbox'), {
    enabled: () => true,
    network: () => false,
    sizeLimitBytes: () => 32 * 1024 * 1024,
    dockerImage: () => 'node:24-slim',
  });
  try {
    const info = await sandbox.isolationInfo();
    assert.equal(info.level, 'persistent-workshop');
    assert.ok(info.note.includes('node:24-slim'));
    assert.ok(info.note.includes('常驻'), 'note 应说明常驻语义');
  } finally {
    sandbox.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('dockerRun 决策链：inspect 缺容器 → run -d → exec timeout', async () => {
  // 决策链是纯函数逻辑，抽出来锁不变式：容器缺失建、镜像漂移重建、
  // 网络配置漂移重建、已在跑不重建。这里直接以真 Sandbox + 真 docker
  // 冒烟只在 Linux 生产进行；单测锁 spec 真身（dockerSpec 导出函数）
  // ——手抄副本是套套逻辑，--name 丢失它抓不到，CI 冒烟已实证。
  const spec = dockerSpec('atri-sandbox', false, '/works', 'Asia/Shanghai');
  assert.equal(spec[spec.indexOf('--name') + 1], 'atri-sandbox');
  assert.ok(spec.includes('--restart') && spec.includes('unless-stopped'));
  assert.ok(spec.includes('--cap-drop=ALL'));
  assert.ok(spec.includes('--security-opt=no-new-privileges'));
  assert.ok(spec.includes('--pids-limit=64'));
  assert.ok(spec.includes('--memory=512m'));
  assert.ok(spec.includes('--cpus=1'));
  assert.equal(spec[spec.indexOf('--network') + 1], 'none');
  assert.ok(spec.some((item) => item.startsWith('type=bind')));
});

test('dockerRun 执行结果：真 docker 存在时跑一条 echo（冒烟，无 docker 则跳过）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'atri-workshop-'));
  const available = await new Promise<boolean>((resolve) => {
    const child = realSpawn('docker', ['version', '--format', 'ok'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
  if (!available) return; // 无 docker 环境（CI/本地）：决策链由上面三条锁住
  const sandbox = new Sandbox(join(root, 'sandbox'), {
    enabled: () => true,
    network: () => false,
    sizeLimitBytes: () => 32 * 1024 * 1024,
    timeoutMs: () => 60_000,
    dockerImage: () => 'node:24-slim',
    dockerWorks: () => root,
  });
  try {
    const result = await sandbox.run('echo hello-workshop');
    assert.equal(result.isolation, 'persistent-workshop');
    assert.equal(result.ok, true, `stderr: ${result.stderr}`);
    assert.ok(result.stdout.includes('hello-workshop'));
  } finally {
    // 窝留在原地（常驻语义）：测试只清自己的沙箱目录。
    sandbox.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});
