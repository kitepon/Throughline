/**
 * turn-start.mjs — ターンの始まり方の判定
 *
 * prompt  : 人、または外部の配送が入力した発言で始まったターン
 * self    : host が自分から始めたターン（裏の作業の完了通知、自動継続）
 * unknown : 印が無い、または未知の印
 *
 * 判定は host が transcript に書いた印だけを使い、本文の言い回しからは推測しない。
 * Cursor だけは印の欄が無く、自分から始める時の固定文で見分ける。
 */

export const TURN_START_PROMPT = 'prompt';
export const TURN_START_SELF = 'self';
export const TURN_START_UNKNOWN = 'unknown';
export const TURN_STARTS = Object.freeze([TURN_START_PROMPT, TURN_START_SELF, TURN_START_UNKNOWN]);

const CLAUDE_ORIGIN_KINDS = Object.freeze({
  human: TURN_START_PROMPT,
  'task-notification': TURN_START_SELF,
  'auto-continuation': TURN_START_SELF,
});

const GROK_SYNTHETIC_REASONS = Object.freeze({
  task_completed: TURN_START_SELF,
});

const CURSOR_SELF_START_QUERY =
  '<user_query>Briefly inform the user about the task result and perform any follow-up actions (if needed).</user_query>';
const CURSOR_TIMESTAMP_PREFIX = /^<timestamp>[^<]*<\/timestamp>\s*/;

/**
 * transcript の user エントリ 1 件から始まり方を返す。
 * @param {object} entry transcript JSONL の 1 行
 * @param {string} text entry から取り出した本文（正規化前）
 * @returns {'prompt'|'self'|'unknown'}
 */
export function classifyTurnStart(entry, text) {
  if (!entry || typeof entry !== 'object') return TURN_START_UNKNOWN;

  // Claude Code: {type:"user", origin:{kind}, message:{...}}
  if (entry.type === 'user' && entry.message && typeof entry.message === 'object') {
    const kind = entry.origin?.kind;
    return Object.hasOwn(CLAUDE_ORIGIN_KINDS, kind) ? CLAUDE_ORIGIN_KINDS[kind] : TURN_START_UNKNOWN;
  }

  // Grok chat_history: {type:"user", content, prompt_index?, synthetic_reason?}
  if (entry.type === 'user' && entry.message === undefined) {
    if (typeof entry.synthetic_reason === 'string') {
      return Object.hasOwn(GROK_SYNTHETIC_REASONS, entry.synthetic_reason)
        ? GROK_SYNTHETIC_REASONS[entry.synthetic_reason]
        : TURN_START_UNKNOWN;
    }
    return Number.isSafeInteger(entry.prompt_index) ? TURN_START_PROMPT : TURN_START_UNKNOWN;
  }

  // Cursor agent-transcripts: {role:"user", message:{content}}（type 欄なし）
  if (entry.type === undefined && entry.role === 'user') {
    if (typeof text !== 'string') return TURN_START_UNKNOWN;
    const query = text.replace(CURSOR_TIMESTAMP_PREFIX, '').trim();
    if (query === CURSOR_SELF_START_QUERY) return TURN_START_SELF;
    return query.startsWith('<user_query>') ? TURN_START_PROMPT : TURN_START_UNKNOWN;
  }

  return TURN_START_UNKNOWN;
}

/** DB の値（旧行は NULL）を公開値へ写す。 */
export function publicTurnStart(value) {
  return TURN_STARTS.includes(value) ? value : TURN_START_UNKNOWN;
}
