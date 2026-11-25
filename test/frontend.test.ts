import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpStore } from './tmp.ts';
import { normalizeEvent } from '../src/qq.ts';

/** F6（直测真实规范化链路）：QQ 原始事件 → normalizeEvent → received 事件形状。
 *  前端 bubbleText 兜底的分类依据就是这里产出的 data 形状。 */
test('normalizeEvent：无 content 无 attachments 的合法入站产物（bubbleText 兜底依据）', () => {
  // QQ 网关可能投递 content 缺失、attachments 缺失的 C2C 事件（纯表情回执等）
  const incoming = normalizeEvent({ op: 0, t: 'C2C_MESSAGE_CREATE', d: { id: 'm1', author: { user_openid: 'openid-x' } } });
  assert.ok(incoming, '合法 C2C 事件必须被规范化');
  assert.equal(typeof incoming!.text, 'string', 'text 恒为 string（String(d.content ?? "")），空串合法');
  assert.equal(incoming!.text, '');
  assert.ok(Array.isArray(incoming!.attachments) && incoming!.attachments.length === 0, 'attachments 是数组可能为空');
  // 有附件时 MIME 字段名是 mime（不是原始 content_type），content_type 缺省兜底 application/octet-stream
  const withFile = normalizeEvent({ op: 0, t: 'C2C_MESSAGE_CREATE', d: { id: 'm2', author: { user_openid: 'openid-x' }, attachments: [{ filename: 'song.mp3' }] } });
  assert.equal((withFile!.attachments![0] as { mime: string }).mime, 'application/octet-stream', 'content_type 缺省归 octet-stream，前端按非图片处理');
  const withImage = normalizeEvent({ op: 0, t: 'C2C_MESSAGE_CREATE', d: { id: 'm3', author: { user_openid: 'openid-x' }, attachments: [{ filename: 'pic.png', content_type: 'image/png' }] } });
  assert.equal((withImage!.attachments![0] as { mime: string }).mime, 'image/png', 'image/* 前端显示 [图片]');
});

/** F1：作品墙 author 语义——工具 post 硬编码 'atri'（tools.ts L131），前端 title 判断以字面量比较。 */
test('作品墙：post 的 author 恒为 atri（前端 title 判断的依据）', () => {
  const store = tmpStore('atri-wall-');
  const peer = store.ensurePeer({ kind: 'c2c', id: 'wall-user' }).id;
  store.post(peer, 'atri', '今天的涂鸦');
  const items = store.wall(peer);
  assert.equal(items.length, 1);
  assert.equal(items[0]!.author, 'atri', '工具 post 写入的 author 必须是字面量 atri——前端不得用 peerId 比较');
  store.close();
});

/** F6：received 事件形状——QQ 入站规范化 text 恒为 string（可能空串），attachments 可能空数组（qq.ts L51）。 */
test('received 事件：无文本无附件时 text 为空串 attachments 为空数组（bubbleText 兜底依据）', () => {
  const store = tmpStore('atri-receive-');
  const peer = store.ensurePeer({ kind: 'c2c', id: 'recv-user' }).id;
  store.receive({ key: 'k1', target: { kind: 'c2c', id: 'recv-user' }, messageId: 'm1', author: 'openid-x', text: '', at: store.now(), attachments: [] }, 0);
  const event = store.recent(peer).find(e => e.kind === 'received');
  assert.ok(event, 'received 事件必须存在');
  const data = event!.data as { text: unknown; attachments: unknown[] };
  assert.equal(typeof data.text, 'string', 'text 恒为 string，空文本是合法态');
  assert.equal((data.text as string).length, 0);
  assert.ok(Array.isArray(data.attachments) && data.attachments.length === 0, 'attachments 是数组可能为空');
  // 附件 MIME 字段名是 mime（types.ts Attachment），前端据此分类
  store.receive({ key: 'k2', target: { kind: 'c2c', id: 'recv-user' }, messageId: 'm2', author: 'openid-x', text: '', at: store.now(), attachments: [{ id: 'a1', name: 'song.mp3', mime: 'audio/mpeg', url: undefined }] }, 0);
  const withMime = store.recent(peer).filter(e => e.kind === 'received')[1];
  assert.equal((withMime!.data as { attachments: { mime: string }[] }).attachments[0]!.mime, 'audio/mpeg', '附件 MIME 字段名是 mime，前端不得读 content_type');
  store.close();
});

/** bubbleText 前端逻辑的后端镜像测试（backend mirror contract test，非前端执行测试）：
 *  把 app.js 的 received 分支语义钉在后端测试里，防止前端兜底与后端数据形状漂移。
 *  逻辑与 public/app.js bubbleText 保持一比一，改动必须同步两处。 */
function bubbleReceived(data: { text?: unknown; attachments?: { mime?: string }[] }): string {
  const list = Array.isArray(data.attachments) ? data.attachments : [];
  if (typeof data.text === 'string' && data.text) return data.text;
  if (list.length) return list.every(a => String(a.mime ?? '').toLowerCase().startsWith('image/')) ? '[图片]' : '[附件]';
  return '[一条消息]';
}

test('bubbleText received 分支镜像：mime 分类与空兜底', () => {
  assert.equal(bubbleReceived({ text: '你好' }), '你好');
  assert.equal(bubbleReceived({ text: '', attachments: [{ mime: 'image/png' }] }), '[图片]');
  assert.equal(bubbleReceived({ text: '', attachments: [{ mime: 'audio/mpeg' }] }), '[附件]');
  assert.equal(bubbleReceived({ text: '', attachments: [{ mime: 'image/png' }, { mime: 'audio/mpeg' }] }), '[附件]', '混合附件不算图片');
  assert.equal(bubbleReceived({ text: '', attachments: [{ mime: 'application/octet-stream' }] }), '[附件]', 'MIME 缺省兜底归附件');
  assert.equal(bubbleReceived({ text: '', attachments: [{ mime: 'IMAGE/PNG' }] }), '[图片]', 'MIME 大小写不敏感（RFC 9110）');
  assert.equal(bubbleReceived({ text: '', attachments: [] }), '[一条消息]', '空文本空附件不是图片');
});
