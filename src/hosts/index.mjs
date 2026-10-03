/**
 * hosts/index.mjs — host 境界の入口
 *
 * 共有 hook 入口 (session-start / prompt-submit / turn-processor) はここから
 * `parseHookPayload` と `hostAdapterForSessionId` だけを使い、
 * ベンダー分岐を直接書かない。
 */
import { hostOfSessionId, CLAUDE_HOST, CODEX_HOST, GROK_HOST, CURSOR_HOST } from './identity.mjs';
import { claudeHostAdapter } from './claude.mjs';
import { codexHostAdapter } from './codex.mjs';
import { grokHostAdapter, isGrokEnvelope, normalizeGrokHookPayload } from './grok.mjs';
import { cursorHostAdapter, isCursorEnvelope, normalizeCursorHookPayload } from './cursor.mjs';

export * from './identity.mjs';
export { isGrokEnvelope, deriveGrokChatHistoryPath, normalizeGrokHookPayload } from './grok.mjs';
export {
  isCursorEnvelope,
  encodeCursorProjectDir,
  deriveCursorTranscriptPath,
  normalizeCursorHookPayload,
} from './cursor.mjs';

const ADAPTERS = Object.freeze({
  [CLAUDE_HOST]: claudeHostAdapter,
  [CODEX_HOST]: codexHostAdapter,
  [GROK_HOST]: grokHostAdapter,
  [CURSOR_HOST]: cursorHostAdapter,
});

/** Parse hook stdin, including the leading UTF-8 BOM emitted by Windows Cursor. */
export function parseHookPayload(raw, options = {}) {
  return normalizeHookPayload(JSON.parse(raw.replace(/^\uFEFF/, '')), options);
}

/**
 * hook stdin payload を Claude snake_case 契約へ正規化する。
 * Grok は camelCase wire、Cursor は hook_event_name が sessionStart 等。
 */
export function normalizeHookPayload(payload, options = {}) {
  if (options.env?.GROK_HOOK_EVENT || options.env?.GROK_SESSION_ID) {
    return normalizeGrokHookPayload(payload, { ...options, force: true });
  }
  if (isGrokEnvelope(payload)) return normalizeGrokHookPayload(payload, options);
  if (isCursorEnvelope(payload)) return normalizeCursorHookPayload(payload, options);
  return payload;
}

/**
 * @param {string} sessionId
 * @returns {typeof claudeHostAdapter}
 */
export function hostAdapterForSessionId(sessionId) {
  return ADAPTERS[hostOfSessionId(sessionId)];
}
