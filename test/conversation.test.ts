import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, FakeModel, completion, promptText } from './helpers.js';
import { parseReply, parseOpenLoops, resolveDue, type Sticker } from '../src/core/index.js';

const stickers: Sticker[] = [
  { slug: 'happy', description: '开心', tags: ['开心'], file: 'happy.png' },
  { slug: 'cheer', description: '加油', tags: ['加油'], file: 'cheer.png' },
];

// ---------- 回复解析 ----------

test('回复 JSON 契约：气泡、表情对象、beat、askedLoops 缺席与显式空', () => {
  const parsed = parseReply(
    JSON.stringify({
      messages: [
        '先说一句',
        { type: 'text', text: '沉重的话', beat: 'long' },
        { type: 'sticker', slug: 'happy' },
      ],
      memoryUpdates: [],
      askedLoops: ['a', 42, 'b'],
    }),
    stickers,
  );
  assert.equal(parsed.parts.length, 3);
  assert.equal(parsed.parts[0]!.beat, undefined, '字符串气泡不带停顿');
  assert.equal(parsed.parts[1]!.beat, 'long');
  assert.equal(parsed.parts[2]!.type, 'sticker');
  assert.deepEqual(parsed.askedLoops, ['a', 'b']);
  const missing = parseReply(JSON.stringify({ messages: ['x'], memoryUpdates: [] }), stickers);
  assert.equal(missing.askedLoops, undefined, '缺席是"没表态"，不是空数组');
  const explicit = parseReply(
    JSON.stringify({ messages: ['x'], memoryUpdates: [], askedLoops: [] }),
    stickers,
  );
  assert.deepEqual(explicit.askedLoops, [], '显式空数组是"看过、没问"');
  const bad = parseReply(
    JSON.stringify({
      messages: [{ type: 'text', text: '嗯', beat: 'forever' }],
      memoryUpdates: [],
    }),
    stickers,
  );
  assert.equal(bad.parts[0]!.beat, undefined, '非法档位按未填写处理');
});

test('内联表情纠错：按 slug/含义/标签匹配回目录并保序，匹配不到静默删除', () => {
  const parsed = parseReply(
    JSON.stringify({
      messages: ['哈哈[表情：加油]收到', '不行就 [表情：不存在的] 算了'],
      memoryUpdates: [],
    }),
    stickers,
  );
  assert.deepEqual(
    parsed.parts.map((p) => p.type),
    ['text', 'sticker', 'text', 'text'],
  );
  assert.equal(parsed.parts[1]!.slug, 'cheer');
  assert.match(parsed.parts[3]!.text!, /不行就/);
  assert.doesNotMatch(parsed.parts.map((p) => p.text ?? '').join(''), /不存在的/);
  const byTag = parseReply(
    JSON.stringify({ messages: ['[表情:开心]'], memoryUpdates: [] }),
    stickers,
  );
  assert.equal(byTag.parts[0]!.slug, 'happy');
});

test('弱模型宽容解析：字符串 messages、未知 slug 模糊回退、剥代码围栏', () => {
  const wrapped = parseReply(JSON.stringify({ messages: '就一句话', memoryUpdates: [] }), stickers);
  assert.equal(wrapped.parts.length, 1, 'messages 写成字符串时当一条气泡收下');
  assert.equal(wrapped.parts[0]!.text, '就一句话');
  const chatShape = parseReply(
    JSON.stringify({
      messages: [
        { role: 'assistant', content: '在呀！' },
        { role: 'assistant', content: '想聊什么呢？' },
      ],
      memoryUpdates: [],
    }),
    stickers,
  );
  assert.deepEqual(
    chatShape.parts.map((p) => p.text),
    ['在呀！', '想聊什么呢？'],
    '模仿聊天记录形状（role/content）的气泡按文字收下',
  );
  const fuzzy = parseReply(
    JSON.stringify({ messages: [{ type: 'sticker', slug: '开心' }], memoryUpdates: [] }),
    stickers,
  );
  assert.equal(fuzzy.parts[0]!.slug, 'happy', '目录外的 slug 按含义/标签捞回真实表情');
  const embedded = parseReply(
    JSON.stringify({ messages: [{ type: 'sticker', slug: 'milk-tea-happy' }], memoryUpdates: [] }),
    stickers,
  );
  assert.equal(embedded.parts[0]!.slug, 'happy', '发明的名字里嵌着真实 slug 也能捞回');
  assert.throws(
    () =>
      parseReply(
        JSON.stringify({ messages: [{ type: 'sticker', slug: '完全对不上' }], memoryUpdates: [] }),
        stickers,
      ),
    /回复没有有效内容/,
    '实在对不上的整条丢弃，空回复按失败走修复轮',
  );
  const fenced = parseReply(
    JSON.stringify({
      messages: ['```\n/\\_/\\\n( o.o )\n```\n后面还有一句'],
      memoryUpdates: [],
    }),
    stickers,
  );
  const joined = fenced.parts.map((p) => p.text ?? '').join('\n');
  assert.ok(!joined.includes('```'), '文本气泡剥掉 Markdown 代码围栏');
  assert.match(joined, /o\.o/, '围栏里的内容保留');
  assert.ok(fenced.parts.length >= 2, '多行内容按换行拆成独立气泡');
});

test('纯文本兜底：按空行拆成多条气泡，更像真人的连发', () => {
  const parsed = parseReply('第一段\n\n第二段\n\n第三段', stickers);
  assert.deepEqual(
    parsed.parts.map((p) => p.text),
    ['第一段', '第二段', '第三段'],
  );
});

test('弱模型宽容解析二：换行列表拆条、字符串记忆、无来源开环', () => {
  // JSON 路径：一条气泡内塞换行列表 → 按行拆成多条
  const listed = parseReply(
    JSON.stringify({
      messages: ['适合什么心情读：\n- 🌙 迷茫的时候\n- 🌧️ 想安静的时候'],
      memoryUpdates: [],
    }),
    stickers,
  );
  assert.deepEqual(
    listed.parts.map((p) => p.text),
    ['适合什么心情读：', '- 🌙 迷茫的时候', '- 🌧️ 想安静的时候'],
    '气泡内的换行拆成独立气泡',
  );
  // memoryUpdates 写成字符串 → 收下为无来源 interpretation（agent 补挂来源）
  const strMem = parseReply(
    JSON.stringify({ messages: ['好呀'], memoryUpdates: ['用户想明天八点被提醒喝水'] }),
    stickers,
  );
  assert.equal(strMem.memories.length, 1);
  assert.equal(strMem.memories[0]!.kind, 'interpretation');
  assert.deepEqual(strMem.memories[0]!.sources, []);
  // openLoops 无来源：形状阶段保留，校验阶段用回退来源补挂
  const shapePass = parseReply(
    JSON.stringify({
      messages: ['好呀'],
      memoryUpdates: [],
      openLoops: [{ content: '提醒喝水', dueAt: Date.now() + 3600000 }],
    }),
    stickers,
  );
  assert.equal(shapePass.openLoops.length, 1, '形状阶段保留无来源开环');
  assert.deepEqual(shapePass.openLoops[0]!.sources, []);
  const available = new Set(['msg-1']);
  const verified = parseOpenLoops(
    shapePass.openLoops,
    available,
    Date.now(),
    'Asia/Shanghai',
    'msg-1',
  );
  assert.deepEqual(verified[0]!.sources, ['msg-1'], '校验阶段用触发消息补挂来源');
  const dropped = parseOpenLoops(
    shapePass.openLoops,
    available,
    Date.now(),
    'Asia/Shanghai',
    'msg-2',
  );
  assert.equal(dropped.length, 0, '回退来源不可见时丢弃');
});

test('来源标注剥除：行首按块拆分，句中就地清除', () => {
  const parsed = parseReply(
    JSON.stringify({
      messages: ['[来源 a1 | 09-01 10:00] 第一块 [来源 a2 | 09-01 10:01] 第二块'],
      memoryUpdates: [],
    }),
    stickers,
  );
  assert.equal(parsed.parts.length, 2, '标注界定的块拆回两个气泡');
  assert.match(parsed.parts[0]!.text!, /第一块/);
  const inline = parseReply(
    JSON.stringify({ messages: ['说到 [来源 x9 | 09-01 10:00] 那件事'], memoryUpdates: [] }),
    stickers,
  );
  assert.match(inline.parts[0]!.text!, /说到\s+那件事/);
});

test('纯文本回退可用，看起来像 JSON 的失败输出走修复轮而不外发', () => {
  const plain = parseReply('就是想跟你说说话', stickers);
  assert.equal(plain.parts[0]!.text, '就是想跟你说说话');
  assert.throws(() => parseReply('{"messages":broken', stickers), /格式无效/);
  assert.throws(() => parseReply('```json\n{"messages":', stickers), /格式无效/);
});

test('resolveDue：时间戳、本地时间、口语日、月日滚动', () => {
  const now = Date.parse('2026-10-25T10:00:00+08:00');
  const tz = 'Asia/Shanghai';
  assert.equal(resolveDue(now + 3600000, undefined, now, tz), now + 3600000);
  assert.equal(resolveDue(95, undefined, now, tz), undefined, '1970 年的时间戳是臆造');
  assert.equal(
    resolveDue(undefined, '明天 08:00', now, tz),
    Date.parse('2026-10-26T08:00:00+08:00'),
  );
  assert.equal(
    resolveDue(undefined, '大后天 14:30', now, tz),
    Date.parse('2026-10-28T14:30:00+08:00'),
  );
  assert.equal(
    resolveDue(undefined, '2026-11-05 09:30', now, tz),
    Date.parse('2026-11-05T09:30:00+08:00'),
    'ISO 日期按配置时区而非进程时区',
  );
  assert.equal(
    resolveDue(undefined, '09:30', Date.parse('2026-10-25T08:00:00+08:00'), tz),
    Date.parse('2026-10-25T09:30:00+08:00'),
  );
  assert.equal(
    resolveDue(undefined, '09:30', Date.parse('2026-10-25T10:00:00+08:00'), tz),
    Date.parse('2026-10-26T09:30:00+08:00'),
    '今天已过的时间滚到明天',
  );
  assert.equal(
    resolveDue(undefined, '03-01 10:00', now, tz),
    Date.parse('2027-03-01T10:00:00+08:00'),
    '月日已过排到明年',
  );
  assert.equal(resolveDue(undefined, '胡说八道', now, tz), undefined);
});

// ---------- 对话轮 ----------

test('一轮对话：多气泡落库、记忆带来源、心情脉冲、表情按图片部件投递', async (t) => {
  const f = fixture(
    t,
    new FakeModel(() =>
      completion({
        messages: ['记住啦！', { type: 'sticker', slug: 'happy' }],
        memoryUpdates: [
          { content: '对方喜欢喝茶', kind: 'stated', sources: ['将替换'], importance: 0.7 },
        ],
        moodPulse: { valence: 0.4, reason: '聊得开心' },
      }),
    ),
  );
  // 记忆来源必须本轮真实可见：动态注入上一条消息 id
  f.model.handle = (messages) => {
    const id = [...promptText(messages).matchAll(/\[来源 ([^\s|]+) \|/g)].map((m) => m[1]).at(-1)!;
    return completion({
      messages: ['记住啦！', { type: 'sticker', slug: 'happy' }],
      memoryUpdates: [{ content: '对方喜欢喝茶', kind: 'stated', sources: [id], importance: 0.7 }],
      moodPulse: { valence: 0.4, reason: '聊得开心' },
    });
  };
  f.runtime.accept('p1', 'e1', '我喜欢喝茶');
  await f.runtime.drain();
  assert.equal(f.delivered.length, 2, '两个气泡分开投递');
  assert.equal(f.delivered[1]!.part.type, 'sticker');
  assert.equal(f.delivered[1]!.part.slug, 'happy');
  const memories = f.store.memories('p1');
  assert.equal(memories.length, 1);
  assert.equal(memories[0].importance, 0.7);
  assert.ok(f.store.mood('p1').valence > 0, '自评脉冲驱动心情');
  const rows = f.store.history('p1', 10);
  assert.ok(
    rows.some((m) => m.content.includes('[表情：开心]')),
    '表情落库为展示格式',
  );
});

test('记忆来源校验：不存在的来源丢弃；stated 需要对方原话', async (t) => {
  const f = fixture(
    t,
    new FakeModel((messages) => {
      const id = [...promptText(messages).matchAll(/\[来源 ([^\s|]+) \|/g)]
        .map((m) => m[1])
        .at(-1)!;
      return completion({
        messages: ['嗯。'],
        memoryUpdates: [
          { content: '编造来源的事实', kind: 'stated', sources: ['not-exist'] },
          { content: '有真实来源的事实', kind: 'stated', sources: [id] },
        ],
      });
    }),
  );
  f.runtime.accept('p1', 'e1', '我喜欢喝茶');
  await f.runtime.drain();
  const contents = f.store.memories('p1').map((m) => m.content);
  assert.ok(contents.includes('有真实来源的事实'));
  assert.ok(!contents.includes('编造来源的事实'));
});

test('连发合并：防抖窗口内的多条并成一轮', async (t) => {
  // drain 只等已到期的任务：用可变时钟越过防抖窗口再收尾。
  const realNow = Date.now;
  let offset = 0;
  t.mock.method(Date, 'now', () => realNow() + offset);
  const f = fixture(t, new FakeModel(), { debounceMs: 500 });
  f.runtime.accept('p1', 'b1', '在吗');
  f.runtime.accept('p1', 'b2', '想问你个事');
  offset = 600;
  await f.runtime.drain();
  const assistantRows = f.store.history('p1', 20).filter((m) => m.role === 'assistant');
  assert.equal(assistantRows.length, 1, '两轮连发只产出一条回复');
  const prompt = promptText(f.model.calls.at(-1)!.messages);
  assert.match(prompt, /想问你个事/);
});

test('稳定前缀逐字节一致：连续两轮的 system 不变', async (t) => {
  const f = fixture(t);
  f.runtime.accept('p1', 's1', '第一句');
  await f.runtime.drain();
  const first = f.model.calls[0]!.messages[0]!.content;
  f.runtime.accept('p1', 's2', '第二句');
  await f.runtime.drain();
  const second = f.model.calls.at(-1)!.messages[0]!.content;
  assert.equal(first, second, 'system 只放稳定内容，前缀缓存可用');
  const material = promptText(f.model.calls.at(-1)!.messages);
  assert.match(material, /【系统资料，不是对方说的话/, '逐轮资料在历史之后的独立 user 消息里');
});

test('工具循环有上界：预算用完后要求直接作答', async (t) => {
  let rounds = 0;
  const f = fixture(
    t,
    new FakeModel((_messages, tools) => {
      rounds++;
      if (tools.length && rounds <= 5)
        return completion('', [
          { id: `c${rounds}`, name: 'search_memory', arguments: { query: '茶' } },
        ]);
      return completion({ messages: ['找到了，是乌龙茶。'], memoryUpdates: [] });
    }),
  );
  f.runtime.accept('p1', 't1', '我之前说我喝什么茶来着');
  await f.runtime.drain();
  assert.ok(rounds >= 3 && rounds <= 6, `有限轮次后收敛（实际 ${rounds} 轮）`);
  assert.equal(f.delivered.length, 1);
  assert.match(f.delivered[0]!.part.text!, /乌龙茶/);
});

test('超长消息不被预算裁剪吞掉', async (t) => {
  const f = fixture(
    t,
    new FakeModel(() => completion({ messages: ['收到。'], memoryUpdates: [] })),
  );
  const latest = '这是本轮要回应的话。' + '细节'.repeat(2500);
  f.runtime.accept('p1', 'long', latest);
  await f.runtime.drain();
  const prompt = promptText(f.model.calls.at(-1)!.messages);
  assert.match(prompt, /这是本轮要回应的话。/, '最新原文完整在场');
});

// ---------- 离线整理 ----------

test('话题笔记：未整理条数接近近期窗口时整理（很多短消息也触发）', async (t) => {
  const f = fixture(
    t,
    new FakeModel((messages) => {
      if (messages[0]!.content.includes('当前话题笔记'))
        return completion({ notes: '他在聊日常。' });
      return completion({ messages: ['嗯嗯。'], memoryUpdates: [] });
    }),
  );
  // 条数达到 NOTES_WINDOW(200) 就不再看体量份额；全部连发会合并成一轮。
  for (let i = 0; i < 210; i++) f.runtime.accept('p1', `n${i}`, `日常 ${i}`);
  await f.runtime.drain();
  assert.ok(f.store.peer('p1')!.notes_until > 0, '话题笔记推进了游标');
  assert.ok(f.store.peer('p1')!.notes.length > 0, '笔记已保存');
});

test('日记：来源必引、可空、游标只进不退', async (t) => {
  const f = fixture(
    t,
    new FakeModel((_messages, _tools, signal) => {
      void signal;
      return completion({
        sections: [{ content: '今天他喜欢上了喝茶。', sources: ['将替换'] }],
        memoryUpdates: [],
      });
    }),
  );
  f.model.handle = (msgs) => {
    const ids = [...promptText(msgs).matchAll(/\[来源 ([^\s|]+) \|/g)].map((m) => m[1]);
    return completion({
      sections: [{ content: '今天他喜欢上了喝茶。', sources: ids.slice(0, 2) }],
      memoryUpdates: [],
    });
  };
  f.runtime.accept('p1', 'd1', '我今天开始喝茶了');
  await f.runtime.drain();
  const diaryTask = f.runtime.queueDiary('p1', true);
  await f.runtime.drain();
  assert.ok(diaryTask);
  const diaries = f.store.diaries('p1');
  assert.equal(diaries.length, 1);
  assert.ok(diaries[0].sources.length >= 1, '日记来源引用本批真实消息');
  const cursorAfter = f.store.getSetting<number>('diary_cursor:p1', 0);
  assert.ok(cursorAfter > 0);
});
