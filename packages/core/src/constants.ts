/** Tuning knobs that were previously scattered as magic numbers. */

/** Recent user messages feeding the auto-recall query. */
export const RECALL_QUERY_MESSAGES = 3;
export const RECALL_QUERY_MAX_CHARS = 1000;
/** Auto-recalled hits and long-term memories placed into the system prompt. */
export const RECALL_HITS = 3;
/** Candidates scored before the rarity gate. Scoring a few extra costs nothing
 *  — the retrieval pass is the same either way — and it keeps one rejected hit
 *  from burning one of the RECALL_HITS slots. */
export const RECALL_CANDIDATES = 12;
/** Newest messages the auto-recall must never return. The query is built from
 *  these very messages, so they match best — without this the recall slots fill
 *  with text the model is already reading in the recent block, and the old
 *  material it was supposed to surface never arrives. */
export const RECALL_PROTECT = 10;
/** An auto-recalled hit must match at least one term this rare, as a fraction
 *  of the peer's indexed rows: matching a word that appears in 2% of the chat
 *  identifies something, matching one in a third of it does not. Floored by
 *  RECALL_RARE_TERM_MIN_DF so a young, small history can still recall. */
export const RECALL_RARE_TERM_SHARE = 0.02;
export const RECALL_RARE_TERM_MIN_DF = 5;
/** A strong semantic match is recalled even with no rare lexical overlap — it
 *  is the paraphrase case lexical retrieval cannot serve at all. */
export const RECALL_MIN_SEMANTIC = 0.45;
export const PROMPT_MEMORIES = 10;
/** Strongest memories that are re-shown every turn regardless of the cooldown
 *  — the facts that define the relationship should not flicker in and out. The
 *  rest of the list rotates (see MEMORY_HIT_COOLDOWN_MINUTES): a memory that
 *  filled a slot last turn moves behind ones that did not, so the prompt stops
 *  being the same ten rows forever when more facts are stored than fit. */
export const MEMORY_COOLDOWN_CORE = 3;
/** Per-item truncation for prompt materials. */
export const RECALL_CONTENT_MAX_CHARS = 600;
export const MEMORY_CONTENT_MAX_CHARS = 500;
/** Sticker window shown to the model. Kept below the 32-sticker catalog cap
 *  (apps/api/src/stickers.ts) on purpose: with window === cap the rotation and
 *  recent-use sink in rotateStickers never ran, so the tail of the catalog was
 *  unreachable and a just-sent sticker stayed advertised as fresh. */
export const PROMPT_STICKERS = 24;

/** Prompt budget shares. `HISTORY_RESERVE_SHARE` is what stays free for the
 *  recent turns; the three material shares are applied independently to what
 *  the fixed system prompt leaves over. A single running `-=` chain let a long
 *  topic note consume the whole allowance, which starved memories and recall to
 *  zero turns on the default 24k input budget. */
export const HISTORY_RESERVE_SHARE = 0.4;
export const PROMPT_NOTES_SHARE = 0.4;
export const PROMPT_MEMORY_SHARE = 0.35;
export const PROMPT_RECALL_SHARE = 0.25;
export const PROMPT_MEMORY_MAX_TOKENS = 3000;
export const PROMPT_RECALL_MAX_TOKENS = 3000;

/** Fraction of the input budget reserved for tools and the latest turns. */
export const TOOL_RESERVE_MAX_TOKENS = 6000;
export const CONTEXT_FLEX_FRACTION = 0.25;
/** Minimum headroom kept when assembling the system prompt. */
export const PROMPT_HEADROOM_TOKENS = 256;
/** Tool-loop limits per reply. */
export const MAX_TOOL_ROUNDS = 2;
export const MAX_TOOL_CALLS = 4;
export const MAX_REPLY_ATTEMPTS = 4;
/** Tool result budget shared across one reply. */
export const TOOL_RESULT_BUDGET_TOKENS = 6000;
/** Cap on assistant bubbles and memory updates per reply. */
export const MAX_REPLY_PARTS = 6;
export const MAX_MEMORY_UPDATES = 3;
export const MAX_IMAGE_DESCRIPTIONS = 4;
/** Notes (topic summary) token cap inside prompts. The prompt asks for at most
 *  1000 Chinese characters; 1500 tokens truncated compliant notes. */
export const NOTES_MAX_TOKENS = 3000;
/** Notes trigger: recent window length and its share of the input budget. */
export const NOTES_MIN_MESSAGES = 20;
export const NOTES_WINDOW = 200;
export const NOTES_BUDGET_SHARE = 0.65;
/** Messages kept after the notes cursor (recent turns stay out of notes). */
export const NOTES_TAIL_EXEMPT = 13;

/** Diary batching limits. */
export const DIARY_MAX_CHARS = 22000;
export const DIARY_MAX_SECTIONS = 6;

/** Sticker usage feedback shown to the model. */
export const STICKER_RECENT_SHOWN = 8;

/** Time awareness: silence gaps rendered for the model. */
export const SILENCE_NOTIFY_MINUTES = 30;
export const SILENCE_HOURS_THRESHOLD = 4;
/** Days of silence after which the diary written just before the gap is
 *  pulled in as reconnect material. Shorter gaps are still covered by the
 *  recent messages, so the extra block would only repeat them. */
export const DIARY_GAP_MIN_DAYS = 2;
/** How far back from the last message before the gap the window reaches. */
export const DIARY_GAP_LOOKBACK_DAYS = 2;
export const DIARY_GAP_MAX_SECTIONS = 4;
export const DIARY_GAP_MAX_TOKENS = 700;

/** Proactive contact jitter: attempts get a random delay inside this window. */
export const PROACTIVE_JITTER_MINUTES = 20;
/** Shared brake/expire knobs live in @atri/db; re-exported for one source of truth. */
export {
  MEMORY_HIT_COOLDOWN_MINUTES,
  OPEN_LOOP_EXPIRE_DAYS,
  PROACTIVE_IGNORE_LIMIT,
  PROACTIVE_IGNORE_COOLDOWN_DAYS,
  SOFT_THREAD_EXPIRE_DAYS,
  SOFT_THREAD_MAX,
  SOFT_THREAD_REVISIT_DAYS,
  SOFT_THREAD_REVISIT_MAX_DAYS,
} from '@atri/db';
export const OPEN_LOOP_PROMPT_MAX = 5;
/** Upper bound on new soft threads accepted from one reply. */
export const SOFT_THREAD_PROMPT_MAX = 3;
/**
 * New-memory cosine similarity above which the closest active memory is
 * auto-superseded: restatements of a known fact in fresh wording replace the
 * old row instead of duplicating it.
 */
export const SIMILARITY_SUPERSEDE = 0.9;
/** Rhythm hint: minimum hourly messages before a bucket counts as habitual. */
export const RHYTHM_MIN_BUCKET = 3;
/** How many busiest hours to describe when a user has no clear routine. */
export const RHYTHM_PEAK_BUCKETS = 6;
/** Embedding refresh: batch size per backfill pass. */
export const EMBED_BACKFILL_BATCH = 64;
