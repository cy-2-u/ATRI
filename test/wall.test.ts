import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal } from '../src/storage/journal.js';
import { Wall } from '../src/wall.js';
import { Sandbox } from '../src/sandbox.js';
import { lifeTools } from '../src/domain/tools.js';

function wallFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'atri-wall-'));
  const journal = new Journal(':memory:');
  const sandbox = new Sandbox(join(dir, 'sandbox'), {
    enabled: () => true,
    network: () => false,
    sizeLimitBytes: () => 32 * 1024 * 1024,
  });
  const wall = new Wall(journal.db, dir);
  return { dir, journal, sandbox, wall, close: () => journal.close() };
}

// 最小合法 PNG（1x1）：发布校验认头四字节就够。
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c626001000000ffff03000006000557bfabd40000000049454e44ae426082',
  'hex',
);
const CALL = { signal: new AbortController().signal, deadlineAt: Date.now() + 1000 };

test('留言墙：双方可发、图片快照独立于沙箱、限容、路径白名单', async () => {
  const env = wallFixture();
  try {
    await env.sandbox.writeBytes('pictures/a.png', PNG);
    const hers = await env.wall.post('her', '小水母上墙！', 'pictures/a.png', env.sandbox);
    assert.equal(hers.from, 'her');
    assert.ok(hers.image, '图片应快照进 wall 目录');
    // 快照独立：沙箱里删了原图，墙上的还在。
    await env.sandbox.delete('pictures/a.png');
    const file = env.wall.imageFile(hers.image!);
    assert.ok(file && existsSync(file), '快照文件必须仍在');
    // 他直接写。
    const his = await env.wall.post('him', '收到，验收通过');
    assert.equal(his.from, 'him');
    // 时间线倒序。
    assert.deepEqual(
      env.wall.list().map((note) => note.from),
      ['him', 'her'],
    );
    // 图片配额：累计超 20MB 拒新图（单张被沙箱 5MB 上限天然限住），
    // 文字仍可写。4MB×5 张 = 20.9MB > 20MB，第 5 张触发。
    const big = Buffer.concat([PNG, Buffer.alloc(4 * 1024 * 1024)]);
    for (let i = 0; i < 4; i++) {
      const path = `pictures/big${i}.png`;
      await env.sandbox.writeBytes(path, big);
      await env.wall.post('her', `大图${i}`, path, env.sandbox);
      await env.sandbox.delete(path);
    }
    await env.sandbox.writeBytes('pictures/onemore.png', big);
    await assert.rejects(
      () => env.wall.post('her', '还想贴', 'pictures/onemore.png', env.sandbox),
      /图库满了/,
    );
    assert.ok(env.wall.post('him', '文字不受限'));
    // 路径穿越与伪造名全拒。
    assert.equal(env.wall.imageFile('../journal.db'), undefined);
    assert.equal(env.wall.imageFile('not-png.txt'), undefined);
    // 全空留言拒。
    await assert.rejects(() => env.wall.post('him', ''));
  } finally {
    env.close();
    rmSync(env.dir, { recursive: true, force: true });
  }
});

test('publish 工具：她贴图上墙，非 PNG 拒', async () => {
  const env = wallFixture();
  try {
    await env.sandbox.writeBytes('pictures/ok.png', PNG);
    await env.sandbox.write('pictures/bad.txt', 'not a png');
    const tools = lifeTools(env.journal, { sandbox: env.sandbox, wall: env.wall });
    const publish = tools.find((tool) => tool.definition.name === 'publish');
    assert.ok(publish, 'publish 工具必须注册');
    const result = (await publish!.execute({ text: '第一幅作品', path: 'pictures/ok.png' }, CALL, {
      id: 't',
      peer: 'p',
      version: 0,
      kind: 'beat',
    })) as { posted: boolean };
    assert.equal(result.posted, true);
    const notes = env.wall.list();
    assert.equal(notes.length, 1);
    assert.equal(notes[0]!.from, 'her');
    assert.equal(notes[0]!.text, '第一幅作品');
    // 非 PNG 拒，工具把错误如实报回给她。
    await assert.rejects(() =>
      publish!.execute({ text: 'x', path: 'pictures/bad.txt' }, CALL, {
        id: 't',
        peer: 'p',
        version: 0,
        kind: 'beat',
      }),
    );
  } finally {
    env.close();
    rmSync(env.dir, { recursive: true, force: true });
  }
});

test('墙是场所不是信道：SQL 下推翻阅 + unseen 提示牌 + read_wall 推进 seen', async () => {
  const env = wallFixture();
  try {
    await env.sandbox.writeBytes('pictures/p.png', PNG);
    // 三张便签：两他一她，间隔 1ms 保证时序确定。
    const his1 = await env.wall.post('him', '第一张便签');
    const hers = await env.wall.post('her', '我自己的便签', 'pictures/p.png', env.sandbox);
    const his2 = await env.wall.post('him', '第二张便签');
    assert.ok(his1.at <= hers.at && hers.at <= his2.at);

    // notes()：作者过滤 + limit 下推，文本截断是工具层的事这里给全量。
    assert.deepEqual(
      env.wall.notes({ from: 'him', limit: 10 }).map((n) => n.text),
      ['第二张便签', '第一张便签'],
    );
    assert.equal(env.wall.notes({ from: 'her' }).length, 1);
    assert.equal(env.wall.notes({ limit: 1 }).length, 1);
    assert.equal(env.wall.notes({ limit: 99 }).length, 3, 'limit 硬顶 20，99 收敛（全墙 3 张）');
    assert.equal(env.wall.notes({ from: 'him', limit: 99 }).length, 2, 'from 过滤仍生效');
    // note(id) 单张全量；图名有效、坏名 undefined。
    const single = env.wall.note(hers.id);
    assert.equal(single?.text, '我自己的便签');
    assert.equal(env.wall.note('nope'), undefined);
    assert.ok(env.wall.imageBytes(hers.image!), '图字节可读');
    assert.equal(env.wall.imageBytes('../journal.db'), undefined);

    // unseen：她没看过 → 两张他的都在牌上；read_wall（列表 or 单张）推进 seen → 清零。
    assert.equal(env.wall.unseenByHim().count, 2);
    assert.equal(env.wall.unseenByHim().latest?.text, '第二张便签');
    const tools = lifeTools(env.journal, { sandbox: env.sandbox, wall: env.wall });
    const readWall = tools.find((tool) => tool.definition.name === 'read_wall');
    assert.ok(readWall, 'read_wall 工具必须注册');
    const catalog = (await readWall.execute({}, CALL, {
      id: 't',
      peer: 'p',
      version: 0,
      kind: 'beat',
    })) as Array<{ id: string; hasImage: boolean }>;
    assert.equal(catalog.length, 3, '目录含双方便签');
    assert.equal(catalog.filter((n) => n.hasImage).length, 1);
    assert.equal(env.wall.unseenByHim().count, 0, '翻过即看过');

    // 单张全量 + 图复制进沙箱：她凑近看那张带图的。
    await env.sandbox.writeBytes('pictures/p.png', PNG); // 上面 post 时快照已拷走，沙箱原件可再写
    const viewed = (await readWall.execute({ id: hers.id }, CALL, {
      id: 't',
      peer: 'p',
      version: 0,
      kind: 'beat',
    })) as { from: string; text: string; image?: string };
    assert.equal(viewed.from, 'her');
    assert.equal(viewed.text, '我自己的便签');
    assert.ok(viewed.image?.startsWith('wall-'), '墙图应复制进沙箱供她看');
    assert.ok(env.sandbox.readFile(viewed.image!, 1024 * 1024), '复制出的文件真实可读');
    // 不存在的 id 报错给她。
    await assert.rejects(() =>
      readWall.execute({ id: 'nope' }, CALL, { id: 't', peer: 'p', version: 0, kind: 'beat' }),
    );
  } finally {
    env.close();
    rmSync(env.dir, { recursive: true, force: true });
  }
});
