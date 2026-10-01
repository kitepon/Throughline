/**
 * hosts/grok.mjs — Grok host 境界 (envelope 正規化 + hook adapter)
 *
 * Grok sends Claude-compatible hook commands and may expose both camelCase
 * and snake_case aliases. The reserved GROK_* hook environment binds the
 * host; Throughline normalizes either wire to the Claude snake_case contract
 * and prefixes session ids so they never mix with other host identities.
 *
 * Grok 固有の挙動 (v0.10.0 / ADR 0021):
 *   - UserPromptSubmit stdout はモデルへ渡らないため、引き継ぎ注入は
 *     chat_history.jsonl への直接書き込みで行う
 *   - hook prompt は `<user_query>` 包装のため、裸の slash command 判定には
 *     chat_history の最新 user 発話を使う
 *   - `/tl` 成功後だけ grok-continue で後継の対話 grok を立てる
 *   - Stop hook の transcript flush barrier は Claude transcript 専用のため使わない
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

import { GROK_HOST, GROK_SESSION_PREFIX, grokBareSessionId, isGrokSessionId } from './identity.mjs';
import { injectGrokHandoffContext } from '../grok-history-inject.mjs';
import { readTranscript } from '../transcript-reader.mjs';
import { run as runGrokContinue } from '../cli/grok-continue.mjs';

export { GROK_SESSION_PREFIX, grokBareSessionId };

export function isGrokEnvelope(payload) {
  return payload !== null
    && typeof payload === 'object'
    && typeof payload.sessionId === 'string'
    && payload.sessionId.length > 0
    && typeof payload.hookEventName === 'string'
    && payload.hookEventName.length > 0;
}

export function deriveGrokChatHistoryPath(projectPath, sessionId, { home = homedir() } = {}) {
  const bare = grokBareSessionId(sessionId);
  if (!projectPath || !bare) return null;
  return join(home, '.grok', 'sessions', encodeURIComponent(projectPath), bare, 'chat_history.jsonl');
}

export function normalizeGrokHookPayload(payload, { home = homedir(), force = false, env = {} } = {}) {
  if (!force && !isGrokEnvelope(payload)) return payload;
  const rawSessionId = payload.sessionId ?? payload.session_id ?? env.GROK_SESSION_ID;
  const hookEventName = payload.hookEventName ?? payload.hook_event_name ?? env.GROK_HOOK_EVENT;
  const cwd = typeof payload.cwd === 'string' && payload.cwd.length > 0
    ? payload.cwd
    : (typeof payload.workspaceRoot === 'string' ? payload.workspaceRoot : env.GROK_WORKSPACE_ROOT);
  // Live Grok Stop sets transcriptPath to updates.jsonl (sessionUpdate frames,
  // no user/assistant rows). L2 lives in chat_history.jsonl only.
  const transcriptPath = deriveGrokChatHistoryPath(cwd, rawSessionId, { home });
  return {
    ...payload,
    session_id: `${GROK_SESSION_PREFIX}${rawSessionId}`,
    cwd,
    source: payload.source,
    prompt: payload.prompt,
    hook_event_name: hookEventName,
    transcript_path: transcriptPath,
    last_assistant_message: payload.lastAssistantMessage,
  };
}

function lastUserPromptText(transcriptPath) {
  const turns = readTranscript(transcriptPath);
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].role === 'user') return turns[i].content;
  }
  return '';
}

export const grokHostAdapter = Object.freeze({
  host: GROK_HOST,
  matchesSessionId: isGrokSessionId,
  // transcript path も cwd から導くため、hook の cwd がそのまま起動 project である。
  completionProjectPath: ({ cwd }) => cwd,
  // Claude Stop transcript flush barrier は Claude transcript の完了行を待つ機構。
  // Grok の chat_history には適用しない (既存挙動)。
  waitsForStopTranscriptFlush: false,
  // Grok は UserPromptSubmit stdout をモデルへ渡さないため chat_history に直接注入する。
  deliverHandoffInjection({ payload, text }) {
    const injected = injectGrokHandoffContext(payload.transcript_path, text);
    return injected.injected
      ? { delivered: true }
      : { delivered: false, reason: `grok chat_history inject skipped: ${injected.reason}` };
  },
  // Grok の hook prompt は `<user_query>` 包装 + skill 本文のため、裸の /tl 判定は
  // chat_history の最新 user 発話へ fallback する。
  resolveCommandPrompt({ prompt, payload, isCommandPrompt }) {
    if (isCommandPrompt(prompt)) return prompt;
    return lastUserPromptText(payload.transcript_path);
  },
  // Grok `/tl` 成功後だけ、源セッションの project_path で後継の対話 grok を立てる。
  consumesHandoffAtSessionStart: false,
  afterBatonWrite({ trigger, sessionId, cwd, continueRun = runGrokContinue }) {
    if (trigger !== 'tl') return { launched: false };
    const code = continueRun(['--session', sessionId], { cwd });
    return { launched: true, exitCode: code };
  },
});
