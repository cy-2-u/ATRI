import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal } from '../src/storage/journal.js';
import { Stickers } from '../src/stickers.js';

function fixture() {
  const journal = new Journal(':memory:');
  const dataDir = mkdtempSync(join(tmpdir(), 'atri-stickers-'));
  // root 指向项目根（cwd）：catalog.json 是真实内置目录。
  const stickers = new Stickers(process.cwd(), dataDir, journal);
  return {
    stickers,
    journal,
    close() {
      journal.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

test('表情目录渲染：头部带挑选方法，行按 slug 排序且字节稳定', () => {
  const env = fixture();
  try {
    const prompt = env.stickers.catalogPrompt();
    assert.match(prompt, /按当下情绪挑最贴的/);
    assert.match(prompt, /slug 必须原样照抄/);
    const slugs = prompt
      .split('\n')
      .slice(1)
      .map((line) => line.split('：')[0]!);
    assert.ok(slugs.length > 0, '内置目录应渲染出表情行');
    const sorted = [...slugs].sort((a, b) => a.localeCompare(b));
    assert.deepEqual(slugs, sorted);
    assert.equal(env.stickers.catalogPrompt(), prompt);
  } finally {
    env.close();
  }
});

test('停用的表情退出目录，自定义表情进入目录', () => {
  const env = fixture();
  try {
    const first = env.stickers.list()[0]!;
    env.stickers.disable(first.slug);
    assert.ok(!env.stickers.catalogPrompt().includes(`${first.slug}：`));
    env.journal.setSetting('stickers:custom', [
      { slug: 'zz_custom', description: '自定义测试表情', tags: ['测试'], file: 'custom/x.png' },
    ]);
    assert.ok(env.stickers.catalogPrompt().includes('zz_custom：自定义测试表情'));
  } finally {
    env.close();
  }
});

test('表情解析：slug、含义片段与近义标签都能命中，未匹配返回空', () => {
  const env = fixture();
  try {
    const target = env.stickers.list().find((s) => s.slug === 'cat009');
    assert.ok(target, '内置目录应含 cat009');
    assert.equal(env.stickers.resolve('cat009'), 'cat009');
    // 含义片段（模型常写描述而非 slug）。
    assert.equal(env.stickers.resolve('举着牌'), 'cat009');
    // 标签命中（tag 全等/包含皆可）。
    assert.equal(env.stickers.resolve('加油'), 'cat009');
    assert.equal(env.stickers.resolve('不存在的东西'), undefined);
  } finally {
    env.close();
  }
});
