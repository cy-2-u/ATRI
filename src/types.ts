export type Target = { kind: 'c2c'; id: string };
export const peerKey = (target: Target): string => `${target.kind}:${target.id}`;
// 本地预演会话（e2e 驱动器全真链路，不出 QQ）：真实联系人计数与展示都要排除它。
export const PREVIEW_PEER = 'c2c:preview';

export interface Attachment {
  id: string;
  name: string;
  mime: string;
  url?: string;
  path?: string;
  size?: number;
  transcript?: string;
}

export interface Incoming {
  key: string;
  target: Target;
  messageId: string;
  author: string;
  text: string;
  at: number;
  reference?: { id: string; text?: string; author?: string };
  attachments: Attachment[];
}

export interface Peer {
  id: string;
  target: Target;
  name: string;
  enabled: boolean;
  autonomous: boolean;
  activeAllowed: boolean | null;
  lastReceived: number;
  lastAccepted: number;
}

export type EventKind = 'received' | 'accepted' | 'action' | 'due' | 'reflection' | 'feeling' | 'diary' | 'failure';

export interface Event {
  seq: number;
  id: string;
  peer: string;
  kind: EventKind;
  data: Record<string, unknown>;
  at: number;
  turn?: string;
}

/** 三轴情绪脉冲：valence 愉悦、arousal 唤醒、patience 耐心。 */
export interface Feeling {
  label: string;
  valence: number;
  arousal: number;
  patience: number;
  reason: string;
  sources: string[];
  at: number;
}

/** 她的身体与关系状态（每个会话一份）。
 *  closeness 黏人度从相处里长出来（每天一小步），配置只是种子。 */
export interface Self {
  closeness: number;
  closenessDay: string;
  social: number;
  expression: number;
  integratedAt: number;
  stimulatedAt: number;
  lastReceivedAt: number;
  lastDeliveredAt: number;
  activity: string;
  activitySince: number;
  pursuit: string;
  pursuitSince: number;
  interests: string[];
  updatedAt: number;
}

export interface Memory {
  id: string;
  peer: string;
  kind: 'fact' | 'interpretation' | 'identity';
  content: string;
  gist: string;
  slot: string;
  sources: string[];
  importance: number;
  emotion: number;
  /** 六变量：细节衰减由 detail/importance/emotion/consolidation/interference
   *  共同决定；identity 不衰减，只被修订。 */
  detail: number;
  consolidation: number;
  interference: number;
  status: 'active' | 'superseded';
  createdAt: number;
  evaluatedAt: number;
  lastRehearsedAt: number;
}

/** 念头：她挂在心上、还没说出口的事。同一批来源的念头只立一次。 */
export interface ThoughtEntry {
  id: string;
  peer: string;
  topic: string;
  meaning: string;
  sources: string[];
  evidence: string;
  dueAt?: number;
  state: 'idle' | 'dropped';
  createdAt: number;
  updatedAt: number;
}

/** 她对一个人的当前信念集：夜间整理轮整批修订，材料带陈旧度。 */
export interface Impressions {
  beliefs: { text: string; basis: string[] }[];
  updatedAt: number;
}

export type Recurrence = { unit: 'day' | 'week' | 'month' | 'year'; interval: number; timezone: string };

export interface Commitment {
  id: string;
  peer: string;
  kind: 'reminder' | 'concern' | 'promise';
  content: string;
  sources: string[];
  dueAt: number;
  recurrence?: Recurrence;
  status: 'open' | 'completed' | 'cancelled';
  version: number;
  notifiedDue: number;
  createdAt: number;
}

export type JobKind = 'chat' | 'beat' | 'night' | 'commitment' | 'reflection';

export interface Job {
  id: string;
  peer: string;
  kind: JobKind;
  reason: string;
  dueAt: number;
  data: Record<string, unknown>;
  attempts: number;
}

export interface Part {
  type: 'text' | 'image' | 'sticker' | 'file' | 'voice';
  text?: string;
  path?: string;
  slug?: string;
  reply?: string;
  notified?: string[];
}

export interface MemoryInput {
  kind: Memory['kind'];
  content: string;
  gist: string;
  slot?: string;
  sources: string[];
  importance?: number;
  emotion?: number;
  supersedes?: string[];
}

export interface CommitmentInput {
  op: 'keep' | 'complete' | 'cancel';
  id?: string;
  kind?: Commitment['kind'];
  content?: string;
  due?: string | number;
  recurrence?: Recurrence | null;
  sources: string[];
  afterPart?: number;
}

export interface ThoughtOp {
  op: 'keep' | 'drop';
  id?: string;
  topic?: string;
  meaning?: string;
  due?: string | number;
  sources: string[];
}

export interface DiaryInput {
  content: string;
  emotion: number;
  sources: string[];
}

export interface ImpressionsInput {
  beliefs: { text: string; basis: string[] }[];
}

export interface Thought {
  parts: Part[];
  /** 渐进投递时被轻校验丢弃的模型下标（apply 跳过这些气泡，不 draft 不投递）。 */
  dropped?: number[];
  feeling?: Omit<Feeling, 'at'>;
  reflection?: string;
  activity?: string;
  pursuit?: string;
  interests?: string[];
  memories: MemoryInput[];
  commitments: CommitmentInput[];
  thoughts?: ThoughtOp[];
  diary?: DiaryInput;
  impressions?: ImpressionsInput;
  intents: { reason: string; at: string | number; commitment?: string }[];
}

export interface Envelope {
  id: string;
  peer: string;
  turn: string;
  ordinal: number;
  part: Part;
  status: 'pending' | 'sending' | 'accepted' | 'failed' | 'unknown' | 'cancelled';
  effects: Record<string, unknown>;
  request?: Record<string, unknown>;
  dueAt: number;
  attempts: number;
  error?: string;
  platformId?: string;
  createdAt: number;
}

export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  images?: string[];
  calls?: ToolCall[];
  callId?: string;
  native?: unknown;
  reasoning?: string;
}

export interface ToolCall { id: string; name: string; args: Record<string, unknown> }
export interface ToolDefinition { name: string; description: string; parameters: Record<string, unknown> }
export interface Usage { input: number; output: number; cached: number; cacheWrite: number }
export interface Completion { message: Message; usage: Usage; finish: string }

export const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('需要对象');
  return value as Record<string, unknown>;
};
export const string = (value: unknown, name: string, max = 4000): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new TypeError(`${name} 无效`);
  return value.trim();
};
export const strings = (value: unknown, max = 32): string[] => {
  if (!Array.isArray(value) || value.length > max || value.some(v => typeof v !== 'string')) throw new TypeError('需要文本数组');
  return [...new Set(value as string[])];
};
export const axis = (value: unknown, fallback = 0): number => {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 1) throw new TypeError('情绪数值必须在 -1 到 1');
  return value;
};
export const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);
