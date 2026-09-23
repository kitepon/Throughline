import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import {
  AUDITOR_CONTEXT_DB_SCHEMA_VERSION,
  buildCompletedPairs,
  defaultAuditorContextDbPath,
  deriveAuditorFreshnessExpectation,
  isSameProjectOrDescendant,
} from './auditor-context.mjs';
import { hashAuditorBody, normalizeAuditorBody } from './body-digest.mjs';

export const CAVEAT_CONTEXT_SCHEMA = 'throughline.caveat_context.v1';
export const CAVEAT_CONTEXT_TURNS = 3;
const MAX_USER_CHARS = 1_200;
const MAX_ASSISTANT_CHARS = 1_200;
const MAX_THINKING_CHARS = 1_800;

/** 直近の完了3ターンから会話と取得可能なThinkingだけを読み取る。 */
export function readCaveatContext({
  dbPath = defaultAuditorContextDbPath(), sessionId, projectRoot, host, transcriptPath,
} = {}) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) throw new TypeError('sessionId is required');
  if (typeof projectRoot !== 'string' || projectRoot.length === 0) throw new TypeError('projectRoot is required');
  if (Boolean(host) !== Boolean(transcriptPath) || (host && !['claude', 'codex'].includes(host))) {
    throw new TypeError('host and transcriptPath must be supplied together');
  }
  if (!existsSync(dbPath)) return empty('unavailable');

  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    db.exec('PRAGMA busy_timeout = 1000');
    const version = Number(db.prepare('PRAGMA user_version').get()?.user_version ?? 0);
    if (version !== AUDITOR_CONTEXT_DB_SCHEMA_VERSION) return empty('schema_mismatch');

    const session = db.prepare('SELECT project_path FROM sessions WHERE session_id = ?').get(sessionId);
    if (!session) return empty('unavailable');
    if (!isSameProjectOrDescendant(session.project_path, projectRoot)) return empty('session_mismatch');

    const bodies = db.prepare(
      `SELECT id, origin_session_id, turn_number, role, text, created_at
       FROM bodies WHERE session_id = ? AND role IN ('user', 'assistant')
       ORDER BY created_at ASC, id ASC`,
    ).all(sessionId);
    const pairs = buildCompletedPairs(bodies).slice(-CAVEAT_CONTEXT_TURNS);
    if (pairs.length < CAVEAT_CONTEXT_TURNS) return empty('incomplete', pairs.length);
    if (host && transcriptPath) {
      const expected = deriveAuditorFreshnessExpectation({ host, transcriptPath, sessionId });
      const latest = pairs.at(-1);
      if (!expected || latest.originSessionId !== expected.expectedOriginSessionId ||
        (expected.expectedTurnNumber !== null && latest.turnNumber !== expected.expectedTurnNumber) ||
        hashAuditorBody(latest.user) !== expected.expectedUserSha256 ||
        hashAuditorBody(latest.assistant) !== expected.expectedAssistantSha256) {
        return empty('projection_pending', pairs.length);
      }
    }

    const selectThinking = db.prepare(
      `SELECT output_text FROM details
       WHERE session_id = ? AND origin_session_id = ? AND turn_number = ? AND kind = 'thinking'
       ORDER BY created_at ASC, id ASC`,
    );
    const turns = pairs.map((pair) => {
      const thinking = selectThinking.all(sessionId, pair.originSessionId, pair.turnNumber)
        .map((row) => normalizeAuditorBody(row.output_text)).filter(Boolean).join('\n');
      return {
        originSessionId: pair.originSessionId,
        turnNumber: pair.turnNumber,
        user: tail(pair.user, MAX_USER_CHARS),
        assistant: tail(pair.assistant, MAX_ASSISTANT_CHARS),
        thinking: tail(thinking, MAX_THINKING_CHARS),
        truncated: pair.user.length > MAX_USER_CHARS || pair.assistant.length > MAX_ASSISTANT_CHARS || thinking.length > MAX_THINKING_CHARS,
      };
    });
    return {
      schema: CAVEAT_CONTEXT_SCHEMA,
      status: 'ready',
      sessionId,
      turns,
      thinkingAvailable: turns.some((turn) => turn.thinking.length > 0),
    };
  } finally {
    db?.close();
  }
}

function empty(status, capturedTurns = 0) {
  return { schema: CAVEAT_CONTEXT_SCHEMA, status, capturedTurns, turns: [], thinkingAvailable: false };
}

function tail(text, limit) {
  return text.length <= limit ? text : text.slice(-limit);
}
