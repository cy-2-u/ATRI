export interface SelfState {
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
}

export interface Mood {
  pleasure: number;
  energy: number;
  patience: number;
  at: number;
}

const clamp = (value: number, min = 0, max = 1): number => Math.min(max, Math.max(min, value));

export function initialSelf(now: number): SelfState {
  return {
    social: 0.8,
    expression: 0,
    integratedAt: now,
    stimulatedAt: now,
    lastReceivedAt: 0,
    lastDeliveredAt: 0,
    activity: '',
    activitySince: now,
    pursuit: '',
    pursuitSince: now,
  };
}

// 时间积分只依赖 integratedAt；修改正在做的事不会吞掉这段时间。
export function projectSelf(state: SelfState, now: number): SelfState {
  const hours = Math.max(0, now - state.integratedAt) / 3_600_000;
  return {
    ...state,
    social: clamp(state.social + hours / 6),
    expression: state.expression * 2 ** (-hours / 2),
    integratedAt: Math.max(now, state.integratedAt),
  };
}

export type SelfEvent =
  | { kind: 'received' }
  | { kind: 'delivered' }
  | { kind: 'experienced'; salience: number }
  | { kind: 'activity'; value: string }
  | { kind: 'pursuit'; value: string };

export function evolveSelf(previous: SelfState, now: number, event: SelfEvent): SelfState {
  const state = projectSelf(previous, now);
  switch (event.kind) {
    case 'received':
      return {
        ...state,
        social: clamp(state.social - 0.025),
        stimulatedAt: now,
        lastReceivedAt: now,
      };
    case 'delivered':
      return {
        ...state,
        social: clamp(state.social - 0.025),
        expression: state.expression * 0.4,
        lastDeliveredAt: now,
      };
    case 'experienced':
      return {
        ...state,
        expression: clamp(state.expression + clamp(event.salience) * 0.2),
        stimulatedAt: now,
      };
    case 'activity':
      return state.activity === event.value
        ? state
        : { ...state, activity: event.value, activitySince: now };
    case 'pursuit':
      return state.pursuit === event.value
        ? state
        : { ...state, pursuit: event.value, pursuitSince: now };
  }
}

export function motives(state: SelfState, now: number): { boredom: number; longing: number } {
  return {
    boredom: clamp((now - state.stimulatedAt) / (4 * 3_600_000)),
    longing: state.lastReceivedAt ? clamp((now - state.lastReceivedAt) / (20 * 3_600_000)) : 0.5,
  };
}

export function projectMood(mood: Mood, now: number): Mood {
  const decay = 2 ** (-Math.max(0, now - mood.at) / (4 * 3_600_000));
  return {
    pleasure: mood.pleasure * decay,
    energy: mood.energy * decay,
    patience: mood.patience * decay,
    at: Math.max(now, mood.at),
  };
}

export function affect(mood: Mood, pulse: Omit<Mood, 'at'>, now: number): Mood {
  const current = projectMood(mood, now);
  const fold = (base: number, value: number) =>
    clamp(base + clamp(value, -1, 1) * (1 - Math.abs(base)), -1, 1);
  return {
    pleasure: fold(current.pleasure, pulse.pleasure),
    energy: fold(current.energy, pulse.energy),
    patience: fold(current.patience, pulse.patience),
    at: now,
  };
}

export interface MemoryStrength {
  detail: number;
  importance: number;
  emotion: number;
  consolidation: number;
  interference: number;
  createdAt: number;
  evaluatedAt: number;
  lastRehearsedAt: number;
}

export function projectMemory(memory: MemoryStrength, now: number): MemoryStrength {
  const days = Math.max(0, now - memory.evaluatedAt) / 86_400_000;
  const rate =
    0.12 *
    (1 - 0.55 * Math.abs(memory.emotion)) *
    (1 - 0.65 * memory.consolidation) *
    (1 + 0.9 * memory.interference);
  return {
    ...memory,
    detail: memory.detail * Math.exp(-Math.max(0.005, rate) * days),
    importance: memory.importance * Math.exp(-0.002 * days),
    emotion: memory.emotion * 2 ** (-days / 10),
    evaluatedAt: Math.max(now, memory.evaluatedAt),
  };
}

export function rehearseMemory(memory: MemoryStrength, now: number): MemoryStrength {
  const current = projectMemory(memory, now);
  if (now - memory.lastRehearsedAt < 180 * 60_000) return current;
  return {
    ...current,
    consolidation: clamp(current.consolidation + 0.15 * (1 - current.consolidation)),
    lastRehearsedAt: now,
  };
}

export function sleepContains(minute: number, start: number, end: number): boolean {
  const normalize = (value: number) => ((value % 1440) + 1440) % 1440;
  const length = normalize(end - start);
  return length > 0 && normalize(minute - start) < length;
}

export function beatDelay(
  state: SelfState,
  now: number,
  closeness: number,
  random = Math.random(),
): number {
  const needs = motives(state, now);
  let minutes = 90 - 72 * clamp(closeness / 100);
  if (state.lastReceivedAt && now - state.lastReceivedAt < 15 * 60_000)
    minutes = Math.min(minutes, 5);
  if (Math.max(needs.boredom, needs.longing, state.expression) > 0.75) minutes *= 0.55;
  if (state.social < 0.3) minutes *= 1.6;
  return clamp(minutes * (0.75 + clamp(random) * 0.5), 3, 240) * 60_000;
}
