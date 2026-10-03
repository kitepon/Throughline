/**
 * hosts/cursor.mjs — Cursor host 境界 (envelope 正規化 + hook adapter)
 *
 * Cursor は Claude PascalCase でも Grok camelCase wire でもない。
 * hook_event_name は sessionStart / beforeSubmitPrompt / stop などの
 * Cursor envelope。session 識別は conversation_id（sessionStart では
 * session_id と同じ）。L2 は ~/.cursor/projects/<slug>/agent-transcripts/<id>/<id>.jsonl。
 *
 * beforeSubmitPrompt の stdout は continue だけ（additional_context なし）。
 * 引き継ぎ注入は sessionStart の additional_context が公式口。
 * /tl 後継の自動起動はしない（次の新規 Cursor 会話の sessionStart が飲む）。
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  CURSOR_HOST,
  CURSOR_SESSION_PREFIX,
  cursorBareSessionId,
  isCursorSessionId,
} from './identity.mjs';

const CURSOR_HOOK_EVENTS = new Set([
  'sessionStart',
  'sessionEnd',
  'beforeSubmitPrompt',
  'stop',
  'preToolUse',
  'postToolUse',
  'postToolUseFailure',
  'subagentStart',
  'subagentStop',
  'beforeShellExecution',
  'afterShellExecution',
  'beforeMCPExecution',
  'afterMCPExecution',
  'beforeReadFile',
  'afterFileEdit',
  'preCompact',
  'afterAgentResponse',
  'afterAgentThought',
  'beforeTabFileRead',
  'afterTabFileEdit',
  'workspaceOpen',
]);

export function isCursorEnvelope(payload) {
  if (payload === null || typeof payload !== 'object') return false;
  if (typeof payload.cursor_version === 'string' && payload.cursor_version.length > 0) {
    return true;
  }
  return typeof payload.hook_event_name === 'string'
    && CURSOR_HOOK_EVENTS.has(payload.hook_event_name);
}

export function encodeCursorProjectDir(projectPath) {
  if (typeof projectPath !== 'string' || projectPath.length === 0) return null;
  // Cursor's utils/workspace-paths normalizes every non-ASCII-alphanumeric run.
  const encoded = projectPath.replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '');
  return encoded.length > 0 ? encoded : null;
}

export function deriveCursorTranscriptPath(projectPath, sessionId, { home = homedir() } = {}) {
  const bare = cursorBareSessionId(sessionId);
  const slug = encodeCursorProjectDir(projectPath);
  if (!bare || !slug) return null;
  return join(home, '.cursor', 'projects', slug, 'agent-transcripts', bare, `${bare}.jsonl`);
}

function cursorCwd(payload) {
  if (typeof payload.cwd === 'string' && payload.cwd.length > 0) return payload.cwd;
  const roots = payload.workspace_roots;
  if (Array.isArray(roots) && typeof roots[0] === 'string' && roots[0].length > 0) {
    return roots[0];
  }
  return undefined;
}

function cursorRawSessionId(payload) {
  if (typeof payload.conversation_id === 'string' && payload.conversation_id.length > 0) {
    return payload.conversation_id;
  }
  if (typeof payload.session_id === 'string' && payload.session_id.length > 0) {
    return payload.session_id;
  }
  return null;
}

export function normalizeCursorHookPayload(payload, { home = homedir() } = {}) {
  if (!isCursorEnvelope(payload)) return payload;
  const rawId = cursorRawSessionId(payload);
  const cwd = cursorCwd(payload);
  const prefixed = rawId ? `${CURSOR_SESSION_PREFIX}${cursorBareSessionId(rawId)}` : undefined;
  const givenTranscript = typeof payload.transcript_path === 'string' && payload.transcript_path.length > 0
    ? payload.transcript_path
    : null;
  const transcriptPath = givenTranscript ?? deriveCursorTranscriptPath(cwd, prefixed, { home });
  return {
    ...payload,
    session_id: prefixed,
    cwd,
    source: typeof payload.source === 'string' && payload.source.length > 0
      ? payload.source
      : 'startup',
    prompt: payload.prompt,
    hook_event_name: payload.hook_event_name,
    transcript_path: transcriptPath,
    last_assistant_message: payload.last_assistant_message ?? payload.text,
    is_background_agent: payload.is_background_agent === true,
  };
}

export const cursorHostAdapter = Object.freeze({
  host: CURSOR_HOST,
  matchesSessionId: isCursorSessionId,
  // transcript path も cwd から導くため、hook の cwd がそのまま起動 project である。
  completionProjectPath: ({ cwd }) => cwd,
  waitsForStopTranscriptFlush: false,
  consumesHandoffAtSessionStart: true,
  deliverHandoffInjection({ text, stdout = process.stdout }) {
    stdout.write(`${JSON.stringify({ additional_context: text })}\n`);
    return { delivered: true };
  },
  resolveCommandPrompt({ prompt }) {
    return prompt;
  },
  afterBatonWrite() {
    return { launched: false };
  },
});
