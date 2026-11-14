import test from 'node:test';
import assert from 'node:assert/strict';
import { Journal } from '../src/storage/journal.js';
import { Settings } from '../src/settings.js';

function fixture() {
  const journal = new Journal(':memory:');
  const settings = new Settings(journal, { LLM_API_KEY: 'primary-secret' });
  return { journal, settings };
}

test('备用渠道密钥独立，公开配置剥离两套密钥，留空保持、显式清除', () => {
  const { journal, settings } = fixture();
  try {
    settings.update({ fallback: { model: 'backup-model', apiKey: 'backup-secret' } });
    const publicConfig = JSON.stringify(settings.public());
    assert.ok(!publicConfig.includes('primary-secret'));
    assert.ok(!publicConfig.includes('backup-secret'));
    settings.update({ primary: { apiKey: '' }, fallback: { apiKey: '' } });
    assert.equal(settings.routes().primary.apiKey, 'primary-secret');
    assert.equal(settings.routes().fallback!.apiKey, 'backup-secret');
    settings.update({ fallback: { clearApiKey: true } });
    assert.equal(settings.routes().fallback!.apiKey, '');
    assert.equal(settings.routes().primary.apiKey, 'primary-secret');
    settings.update({ fallback: null });
    assert.equal(settings.routes().fallback, undefined);
  } finally {
    journal.close();
  }
});

test('无效更新不改变内存或持久配置', () => {
  const { journal, settings } = fixture();
  try {
    settings.update({ closeness: 60 });
    for (const patch of [
      { primary: { baseUrl: 'https://user:password@example.org' } },
      { fallback: { baseUrl: 'https://example.org?key=secret' } },
      { heartbeat: 'false' },
      { concurrency: 0 },
      { timezone: 'invalid/zone' },
      { turnTimeoutMs: 5000 },
      { unexpected: true },
    ])
      assert.throws(() => settings.update(patch));
    assert.equal(settings.get().closeness, 60);
    assert.equal(new Settings(journal, {}).get().closeness, 60);
  } finally {
    journal.close();
  }
});

test('配置快照不能从外部修改运行态', () => {
  const { journal, settings } = fixture();
  try {
    const snapshot = settings.get();
    snapshot.primary.apiKey = 'changed';
    assert.equal(settings.routes().primary.apiKey, 'primary-secret');
  } finally {
    journal.close();
  }
});
