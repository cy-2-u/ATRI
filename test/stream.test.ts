import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { JsonStreamParser } from '../src/stream.ts';

/** 分块喂入：size 控制切块大小，覆盖字符边界落在任何位置的场景。 */
function feed(input: string, size: number, callbacks: { onPart?: (e: unknown) => void; onCommitment?: (e: unknown) => void } = {}): JsonStreamParser {
  const parser = new JsonStreamParser(callbacks);
  for (let i = 0; i < input.length; i += size) parser.write(input.slice(i, i + size));
  return parser;
}

const full = JSON.stringify({
  parts: [{ type: 'text', text: '你好呀', reply: 'e1' }, { type: 'sticker', slug: 'smile' }],
  feeling: { label: '开心', valence: 0.5, sources: ['e1'] },
  commitments: [{ op: 'keep', kind: 'reminder', content: '提醒喝水', afterPart: 1, sources: ['e1'] }],
  memories: [],
});

describe('JsonStreamParser', () => {
  it('完整流：气泡与承诺按闭合顺序回调，与整体 JSON.parse 一致', () => {
    const expected = JSON.parse(full);
    const parts: unknown[] = [], commitments: unknown[] = [];
    const parser = feed(full, 7, { onPart: e => parts.push(e), onCommitment: e => commitments.push(e) });
    assert.equal(parser.error, undefined);
    assert.deepEqual(parts, expected.parts);
    assert.deepEqual(commitments, expected.commitments);
  });

  it('逐字符喂入（最恶劣边界）与一次性喂入结果一致', () => {
    const oneParts: unknown[] = [], oneCommitments: unknown[] = [];
    const byCharParts: unknown[] = [], byCharCommitments: unknown[] = [];
    feed(full, full.length, { onPart: e => oneParts.push(e), onCommitment: e => oneCommitments.push(e) });
    const byChar = feed(full, 1, { onPart: e => byCharParts.push(e), onCommitment: e => byCharCommitments.push(e) });
    assert.deepEqual(oneParts, JSON.parse(full).parts);
    assert.deepEqual(oneCommitments, JSON.parse(full).commitments);
    assert.deepEqual(byCharParts, JSON.parse(full).parts);
    assert.deepEqual(byCharCommitments, JSON.parse(full).commitments);
    assert.equal(byChar.error, undefined);
  });

  it('字符串内转义引号与花括号不干扰结构', () => {
    const input = JSON.stringify({ parts: [{ type: 'text', text: '他说 "你好 {[再 见]"' }] });
    const parts: unknown[] = [];
    const parser = feed(input, 3, { onPart: e => parts.push(e) });
    assert.equal(parser.error, undefined);
    assert.deepEqual(parts, JSON.parse(input).parts);
  });

  it('记账字段在 parts 前面（合法降态）：承诺先到，气泡照常回调', () => {
    const input = JSON.stringify({ commitments: [{ op: 'keep', content: 'x', afterPart: 0 }], parts: [{ type: 'text', text: '好' }] });
    const order: string[] = [];
    const parser = feed(input, 2, { onPart: () => order.push('part'), onCommitment: () => order.push('commitment') });
    assert.equal(parser.error, undefined);
    assert.deepEqual(order, ['commitment', 'part']);
  });

  it('重复 parts：结构性失败，停止回调', () => {
    const input = `{"parts":[{"type":"text","text":"a"}],"parts":[{"type":"text","text":"b"}]}`;
    const parts: unknown[] = [];
    const parser = feed(input, 5, { onPart: e => parts.push(e) });
    assert.match(parser.error ?? '', /parts 重复/);
    assert.deepEqual(parts, [{ type: 'text', text: 'a' }]); // 重复出现前的回调仍有效
  });

  it('流中途截断：已闭合的元素照常回调（权威语法错误由思考层 JSON.parse 裁定）', () => {
    const parts: unknown[] = [];
    const parser = feed('{"parts":[{"type":"text","text":"早"},{"type":"tex', 1, { onPart: e => parts.push(e) });
    assert.deepEqual(parts, [{ type: 'text', text: '早' }]); // 第一个气泡闭合即回调，不等全文
    assert.equal(parser.error, undefined); // 截断不是结构错误，等聚合层整体 parse 报错
  });

  it('空 parts 与根不是对象都正确处理', () => {
    assert.equal(feed(JSON.stringify({ parts: [] }), 4).error, undefined);
    assert.match(feed('[1,2]', 4).error ?? '', /根必须是对象/);
  });

  it('primitive 尾元素与嵌套数组元素不污染回调边界', () => {
    // commitments 里放个带数字字段的元素；parts 里放嵌套数组值字段
    const input = JSON.stringify({ parts: [{ type: 'text', text: 'x', notified: [] }], commitments: [{ op: 'keep', due: 0, sources: ['e'] }] });
    const commitments: unknown[] = [];
    const parser = feed(input, 1, { onCommitment: e => commitments.push(e) });
    assert.equal(parser.error, undefined);
    assert.deepEqual(commitments, [{ op: 'keep', due: 0, sources: ['e'] }]);
  });

  it('根闭合后写入被忽略', () => {
    const parts: unknown[] = [];
    const parser = feed('{"parts":[]}', 3, { onPart: e => parts.push(e) });
    parser.write('"junk"');
    assert.equal(parser.error, undefined);
    assert.deepEqual(parts, []);
  });
});
