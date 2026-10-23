import type { MoodState } from '@atri/db';

/** A mood delta produced by the rule fallback. `at` is added by the store. */
export type MoodPulse = Partial<Omit<MoodState, 'at'>>;

export interface MoodExchange {
  user: string;
  assistant: string;
  /** Hour of day (0–23) in the operator's timezone. Passed in so this policy
   *  stays pure and testable without clock or timezone mocking. */
  hour: number;
  /** Consecutive user turns ending with `user`, oldest first. */
  recentUserTexts?: string[];
}

const COLD_TOKEN =
  /^(?:嗯+|哦+|噢+|喔+|额+|呃+|知道了|知道|好的|好|行吧|行|可以|ok|收到|没事|算了|都行|随便|随你)/u;

/** True only for a bare acknowledgement with no warmth, question or content.
 *  Deliberately conservative: "好的宝", "好呀~", "行，听你的" and emoji-only
 *  messages are conversation bids, not coldness. A single ambiguous message
 *  never moves the mood; only a run of these across turns lowers patience. */
export function isColdAcknowledgement(text: string): boolean {
  const compact = text
    .normalize('NFKC')
    .replace(/[\s\p{P}\p{S}]/gu, '')
    .toLowerCase();
  let rest = compact;
  let matched = false;
  while (rest) {
    const token = COLD_TOKEN.exec(rest);
    if (!token) return false;
    matched = true;
    rest = rest.slice(token[0].length).replace(/^[啊呀哦嗯吧呢哈]+/u, '');
  }
  return matched;
}

/** Rule-based fallback mood pulse for one exchange.
 *
 *  The model's own `moodPulse` is the semantic source of truth; this function
 *  only covers observable signals that need no intent inference. In particular
 *  patience is NOT derived from message length: "好的宝" and "嗯" are both
 *  short, but only the latter is low-effort, and even that says little on its
 *  own. Patience is a social battery that drains only when several consecutive
 *  user turns are bare acknowledgements, and is restored by warmth, laughter
 *  or a genuine question. Night-time affects energy, never patience.
 */
export function moodPulseFromExchange(exchange: MoodExchange): MoodPulse | undefined {
  const text = exchange.user.replace(
    /(不|没|没有|不太|不怎么)(太|什么)?(累|疲|烦|难过|生气|委屈|难受|压力大?|崩溃)/g,
    '',
  );
  const distressed = /(烦|难过|累|好累|疲|生气|委屈|难受|不开心|不高兴|没意思|压力|崩溃|emo)/i.test(
    text,
  );
  const grateful = /(谢谢|感谢|辛苦|有你真好)/.test(text);
  const cheerful =
    !/(不开心|不高兴|没意思)/.test(text) && /(开心|哈哈哈|笑死|哈哈|嘻嘻|好耶)/.test(text);
  const affectionate =
    !/(不|没)(爱|喜欢|想)你/.test(text) &&
    /((?<!支付)宝|爱你|喜欢你|抱抱|亲亲|么么|晚安|好梦|辛苦|谢谢|想你了|想你|乖|可爱|亲爱的)/.test(
      text,
    );
  const windingDown = /(晚安|睡了|好困|困了)/.test(text);
  const asksQuestion = /[?？]|(?:吗|呢|怎么|为什么|什么|哪|谁|几点|多少)/.test(text);

  let valence = 0;
  let energy = 0;
  let reason: string | undefined;
  if (distressed) {
    valence = -0.3;
    energy = -0.2;
    reason = '对方提到了不开心的事';
  } else if (grateful) {
    valence = 0.2;
    reason = '对方表达了感谢';
  } else if (cheerful) {
    valence = 0.2;
    reason = '聊得挺开心';
  } else if (windingDown || (exchange.hour >= 1 && exchange.hour < 7)) {
    energy = -0.15;
  }

  let patience = 0;
  if (!distressed) {
    const history = (
      exchange.recentUserTexts?.length ? exchange.recentUserTexts : [exchange.user]
    ).slice(-6);
    let coldStreak = 0;
    for (let i = history.length - 1; i >= 0; i--) {
      if (!isColdAcknowledgement(history[i] ?? '')) break;
      coldStreak++;
    }
    if (coldStreak >= 2) patience -= Math.min(0.24, 0.06 * (coldStreak - 1));
    else if (affectionate || cheerful) patience += 0.05;
    else if (asksQuestion) patience += 0.03;
  }

  if (valence === 0 && energy === 0 && patience === 0) return undefined;
  return { valence, energy, patience, reason };
}
