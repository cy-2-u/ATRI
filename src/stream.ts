/** 流式 JSON 路径跟踪器：逐字符扫描模型输出，在顶层 parts 数组的每个气泡元素
 *  闭合的那一刻发出回调——气泡不必等整个 JSON 生成完就能投递（渐进投递）。
 *
 *  协议约定：parts 必须是顶层第一个键且只出现一次。重复 parts 按错误处理
 *  （停止回调，等全量 JSON 走修复轮）。记账字段写在 parts 前面是合法降态：
 *  渐进退化为现状速度，正确性无损。
 *
 *  实现：全量缓冲（元素边界用 buf.slice 提取）+ 栈式结构状态机只负责找元素边界；
 *  字符串转义态内的一切花括号引号都不算结构。语法坏不在这里判定——停止回调即可，
 *  思考层对聚合全文的 JSON.parse 会给出权威错误。 */
interface Frame {
  kind: 'object' | 'array';
  /** object：open（刚开括号）| key（等键）| value（等值）| comma（等逗号或闭括号） */
  phase: 'open' | 'key' | 'value' | 'comma' | 'element';
  key?: string;
  /** array：当前未闭合元素的起始偏移；-1 = 尚未开始 */
  elementStart: number;
  /** array：是否是被跟踪的顶层 parts 数组 */
  track?: boolean;
}

export class JsonStreamParser {
  private buf = '';
  private stack: Frame[] = [];
  private pos = 0;
  private inString = false;
  private escaped = false;
  private quoteStart = -1;
  private rootSeen = false;
  private partsSeen = false;
  private halted: string | undefined;
  private readonly onPart: ((element: unknown) => void) | undefined;
  constructor(onPart?: (element: unknown) => void) {
    this.onPart = onPart;
  }

  /** 结构性失败原因（重复 parts、括号不匹配等）；undefined = 一切正常。 */
  get error(): string | undefined {
    return this.halted;
  }

  write(chunk: string): void {
    if (this.halted || this.rootSeen) return;
    const start = this.buf.length;
    this.buf += chunk;
    for (let i = start; i < this.buf.length; i++) {
      this.pos = i;
      if (this.step(i)) return;
    }
    this.pos = this.buf.length;
  }

  /** 返回 true = 已 halted，停止扫描。 */
  private step(i: number): boolean {
    const ch = this.buf[i]!;
    if (this.inString) {
      if (this.escaped) this.escaped = false;
      else if (ch === '\\') this.escaped = true;
      else if (ch === '"') {
        this.inString = false;
        this.quoteClosed(i);
      }
      return false;
    }
    if (ch === '"') {
      this.inString = true;
      this.escaped = false;
      this.quoteStart = i;
      this.valueChar(i);
      return false;
    }
    if (ch === '{') return this.open('object', i);
    if (ch === '[') return this.open('array', i);
    if (ch === '}' || ch === ']') return this.close(i);
    if (ch === ',') return this.comma();
    if (ch === ':') return this.colon();
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') return false;
    return this.primitiveChar(i);
  }

  /** 键字符串闭合：提取键名。值字符串闭合：仅对被跟踪数组的字符串元素收尾。 */
  private quoteClosed(i: number): void {
    const frame = this.stack.at(-1);
    if (!frame) return;
    if (frame.kind === 'object' && frame.phase === 'key')
      frame.key = this.buf.slice(this.quoteStart + 1, i);
    if (frame.kind === 'array' && frame.phase === 'element') this.emitElement(i);
  }

  /** 非结构字符（primitive 内容或字符串）：标记值/元素开始。 */
  private valueChar(i: number): void {
    const frame = this.stack.at(-1);
    if (!frame) return;
    if (frame.kind === 'object' && frame.phase === 'open') frame.phase = 'key'; // 首键是字符串
    if (frame.kind === 'array' && frame.elementStart < 0) {
      frame.elementStart = i;
      frame.phase = 'element';
    }
  }

  private primitiveChar(i: number): boolean {
    const frame = this.stack.at(-1);
    if (!frame) return this.halt('根之外的内容');
    this.valueChar(i);
    if (frame.kind === 'object' && frame.phase === 'open') frame.phase = 'key';
    return false;
  }

  private open(kind: 'object' | 'array', i: number): boolean {
    const parent = this.stack.at(-1);
    if (!parent) {
      if (kind !== 'object') return this.halt('根必须是对象');
      this.stack.push({ kind, phase: 'open', elementStart: -1 });
      return false;
    }
    if (parent.kind === 'array') this.valueChar(i);
    else if (parent.phase !== 'value' && parent.phase !== 'open') return this.halt('意外的 {');
    let track = false;
    if (parent.kind === 'object' && this.stack.length === 1 && parent.key === 'parts') {
      if (this.partsSeen) return this.halt('parts 重复出现');
      this.partsSeen = true;
      track = kind === 'array';
    }
    if (parent.kind === 'object') parent.phase = 'comma';
    this.stack.push({ kind, phase: kind === 'object' ? 'open' : 'value', elementStart: -1, track });
    return false;
  }

  private close(i: number): boolean {
    const frame = this.stack.at(-1);
    if (!frame) return this.halt('多余的闭合括号');
    const expected = this.buf[i] === '}' ? 'object' : 'array';
    if (frame.kind !== expected) return this.halt('括号不匹配');
    if (frame.kind === 'array' && frame.elementStart >= 0) this.emitElement(i - 1); // primitive 尾元素：不含终止符
    this.stack.pop();
    const parent = this.stack.at(-1);
    if (!parent) {
      this.rootSeen = true;
      return false;
    }
    if (
      parent.kind === 'array' &&
      parent.track &&
      parent.elementStart >= 0 &&
      parent.phase === 'element'
    )
      this.emitElement(i); // 容器元素闭合
    else if (parent.kind === 'object') parent.phase = 'comma';
    return false;
  }

  private comma(): boolean {
    const frame = this.stack.at(-1);
    if (!frame) return this.halt('根之外的逗号');
    if (frame.kind === 'array') {
      if (frame.elementStart >= 0) this.emitElement(this.pos - 1);
      frame.phase = 'value';
      return false;
    }
    if (frame.phase === 'value') {
      frame.phase = 'key';
      frame.key = undefined;
      return false;
    } // primitive 值结束
    if (frame.phase === 'comma' || frame.phase === 'open') {
      frame.phase = 'key';
      return false;
    }
    return this.halt(`意外的逗号（phase=${frame.phase}）`);
  }

  private colon(): boolean {
    const frame = this.stack.at(-1);
    if (!frame || frame.kind !== 'object' || frame.phase !== 'key') return this.halt('意外的冒号');
    frame.phase = 'value';
    return false;
  }

  private emitElement(end: number): void {
    const frame = this.stack.at(-1)!;
    if (!frame.track) {
      frame.elementStart = -1;
      return;
    }
    const raw = this.buf.slice(frame.elementStart, end + 1);
    frame.elementStart = -1;
    let element: unknown;
    try {
      element = JSON.parse(raw);
    } catch {
      this.halt('元素片段不是合法 JSON');
      return;
    }
    this.onPart?.(element);
  }

  private halt(reason: string): boolean {
    this.halted = reason;
    return true;
  }
}
