import { parseCodexRolloutFile } from './codex-rollout-memory.mjs';
import { defaultCodexHome, findCodexThreadCandidate } from './codex-thread-index.mjs';
import {
  CODEX_SESSION_PREFIX,
  buildCodexThroughlineSessionId,
  codexSessionIdToThreadId,
  isCodexSessionId,
} from './hosts/identity.mjs';

// session identity の正本は hosts/identity.mjs。既存 import 面のため再 export する。
export {
  CODEX_SESSION_PREFIX,
  buildCodexThroughlineSessionId,
  codexSessionIdToThreadId,
};
export const isCodexThroughlineSessionId = isCodexSessionId;

export function captureCodexRolloutToDb(
  db,
  {
    threadId,
    codexHome = defaultCodexHome(),
    projectPath = process.cwd(),
    now = Date.now(),
  } = {},
) {
  if (!db) throw new Error('db is required');
  if (typeof threadId !== 'string' || threadId.trim().length === 0) {
    throw new Error('threadId is required');
  }

  const candidate = findCodexThreadCandidate({
    threadId: threadId.trim(),
    codexHome,
    projectPath,
    requireProjectMatch: true,
  });
  if (!candidate) {
    return {
      status: 'unavailable',
      reason: 'codex_rollout_not_found_for_project',
      threadId: threadId.trim(),
      sessionId: buildCodexThroughlineSessionId(threadId),
      projectPath,
      capturedTurns: 0,
      capturedRows: 0,
    };
  }

  const parsed = parseCodexRolloutFile(candidate.rolloutPath);
  const sessionId = buildCodexThroughlineSessionId(candidate.id);
  const rows = buildBodyRowsFromActiveTurns(parsed.activeTurns, {
    sessionId,
    now,
  });
  const detailRows = buildDetailRowsFromActiveTurns(parsed.activeTurns, {
    sessionId,
    now,
  });

  let detailSync = null;
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(
      `INSERT INTO sessions (session_id, project_path, status, created_at, updated_at)
       VALUES (?, ?, 'active', ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         project_path = excluded.project_path,
         status = 'active',
         updated_at = excluded.updated_at`,
    ).run(sessionId, candidate.cwd ?? projectPath, now, now);

    // 全発言の本文が一致するターンの要約は保持する。rollbackや本文変更で古くなった要約だけを除く。
    const before = db.prepare('SELECT turn_number, role, text FROM bodies WHERE session_id = ? ORDER BY id').all(sessionId);
    const beforeTurns = bodyTurnTexts(before.map(row => ({ turnNumber: row.turn_number, ...row })));
    const afterTurns = bodyTurnTexts(rows);
    const deleteSummary = db.prepare('DELETE FROM skeletons WHERE session_id = ? AND turn_number = ?');
    for (const row of db.prepare('SELECT DISTINCT turn_number FROM skeletons WHERE session_id = ?').all(sessionId)) {
      if (!beforeTurns.has(row.turn_number) || beforeTurns.get(row.turn_number) !== afterTurns.get(row.turn_number)) {
        deleteSummary.run(sessionId, row.turn_number);
      }
    }
    db.prepare('DELETE FROM bodies WHERE session_id = ?').run(sessionId);

    const insertBody = db.prepare(
      `INSERT INTO bodies
         (session_id, origin_session_id, turn_number, role, text, token_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );

    for (const row of rows) {
      insertBody.run(
        row.sessionId,
        row.originSessionId,
        row.turnNumber,
        row.role,
        row.text,
        row.tokenCount,
        row.createdAt,
      );
    }
    detailSync = syncDetailRows(db, sessionId, detailRows, now);

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return {
    status: 'captured',
    source: 'codex-rollout',
    sourceAgent: 'codex',
    threadId: candidate.id,
    sessionId,
    projectPath: candidate.cwd ?? projectPath,
    rolloutPath: candidate.rolloutPath,
    capturedTurns: parsed.activeTurnCount,
    capturedRows: rows.length,
    capturedDetails: detailRows.length,
    keptDetails: detailSync.kept,
    writtenDetails: detailSync.inserted,
    removedDetails: detailSync.removed,
    stats: parsed.stats,
  };
}

/**
 * L3 (details) を rollout の今の中身へ合わせる。変わっていない先頭の行はそのまま残し、
 * 最初に食い違った行から後ろだけを消して入れ直す (ADR 0042)。
 *
 * hook は道具を1回使うたびに走る。会話の全行を消して入れ直すと、長い会話では1回の hook が
 * 会話全体と同じ量を WAL へ書く。rollout は追記で伸びるので、普通は末尾の数行だけが変わる。
 *
 * 残った行の並び (id の順) は、全部入れ直した時と同じになる。食い違いは本文まで比べて決める。
 */
function syncDetailRows(db, sessionId, detailRows, now) {
  const wanted = dropIgnoredDuplicates(detailRows);
  const existing = db
    .prepare(
      `SELECT id, origin_session_id, turn_number, tool_name, kind, source_id, token_count, created_at
         FROM details WHERE session_id = ? ORDER BY id`,
    )
    .all(sessionId);
  const sameText = db.prepare(
    'SELECT 1 AS same FROM details WHERE id = ? AND input_text IS ? AND output_text IS ?',
  );

  let kept = 0;
  while (kept < existing.length && kept < wanted.length) {
    const have = existing[kept];
    const want = wanted[kept];
    if (!sameDetailColumns(have, want, now)) break;
    if (!sameText.get(have.id, want.inputText, want.outputText)) break;
    kept++;
  }

  if (kept < existing.length) {
    db.prepare('DELETE FROM details WHERE session_id = ? AND id >= ?').run(sessionId, existing[kept].id);
  }

  const insertDetail = db.prepare(
    `INSERT OR IGNORE INTO details
       (session_id, origin_session_id, turn_number, tool_name, input_text, output_text,
        token_count, created_at, kind, source_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const row of wanted.slice(kept)) {
    insertDetail.run(
      row.sessionId,
      row.originSessionId,
      row.turnNumber,
      row.toolName,
      row.inputText,
      row.outputText,
      row.tokenCount,
      row.createdAt,
      row.kind,
      row.sourceId,
    );
  }

  return { kept, removed: existing.length - kept, inserted: wanted.length - kept };
}

// uq_details_source (session_id, origin_session_id, source_id) は、同じ source_id の2件目を
// INSERT OR IGNORE で捨てる。DB に入る並びと比べるため、入れる前に同じ形へ揃える。
function dropIgnoredDuplicates(detailRows) {
  const seen = new Set();
  const rows = [];
  for (const row of detailRows) {
    if (row.sourceId !== null) {
      const key = `${row.originSessionId}\0${row.sourceId}`;
      if (seen.has(key)) continue;
      seen.add(key);
    }
    rows.push(row);
  }
  return rows;
}

function sameDetailColumns(have, want, now) {
  return (
    have.origin_session_id === want.originSessionId &&
    have.turn_number === want.turnNumber &&
    have.tool_name === want.toolName &&
    have.kind === want.kind &&
    have.source_id === want.sourceId &&
    have.token_count === want.tokenCount &&
    // rollout に時刻が無い行は取り込んだ時刻が入る。その行は最初に取り込んだ時刻のまま残す。
    (have.created_at === want.createdAt || want.createdAt === now)
  );
}

function bodyTurnTexts(rows) {
  const turns = new Map();
  for (const row of rows) {
    const text = turns.get(row.turnNumber) ?? [];
    text.push([row.role, row.text]);
    turns.set(row.turnNumber, text);
  }
  return new Map([...turns].map(([turn, text]) => [turn, JSON.stringify(text)]));
}

export function buildBodyRowsFromActiveTurns(activeTurns, { sessionId, now = Date.now() } = {}) {
  if (!isCodexThroughlineSessionId(sessionId)) {
    throw new Error('Codex capture requires a codex:<thread_id> session id');
  }

  const rows = [];
  let turnNumber = 0;
  for (const turn of activeTurns ?? []) {
    const grouped = groupMessagesByRole(turn.messages ?? []);
    const details = turn.details ?? [];
    if (grouped.length === 0 && details.length === 0) continue;

    turnNumber++;
    const createdAt = pickTurnCreatedAt(turn.messages ?? [], now);
    for (const [role, text] of grouped) {
      rows.push({
        sessionId,
        originSessionId: sessionId,
        turnNumber,
        role,
        text,
        tokenCount: Math.round(text.length / 4),
        createdAt,
      });
    }
  }
  return rows;
}

export function buildDetailRowsFromActiveTurns(activeTurns, { sessionId, now = Date.now() } = {}) {
  if (!isCodexThroughlineSessionId(sessionId)) {
    throw new Error('Codex capture requires a codex:<thread_id> session id');
  }

  const rows = [];
  let turnNumber = 0;
  for (const turn of activeTurns ?? []) {
    const grouped = groupMessagesByRole(turn.messages ?? []);
    const details = turn.details ?? [];
    if (grouped.length === 0 && details.length === 0) continue;

    turnNumber++;
    for (const detail of details) {
      if (!detail?.kind || !detail?.tool_name) continue;
      const inputText = detail.input_text ?? null;
      const outputText = detail.output_text ?? null;
      rows.push({
        sessionId,
        originSessionId: sessionId,
        turnNumber,
        toolName: String(detail.tool_name),
        inputText,
        outputText,
        tokenCount: Math.round(((inputText?.length ?? 0) + (outputText?.length ?? 0)) / 4),
        createdAt: pickDetailCreatedAt(detail, now),
        kind: String(detail.kind),
        sourceId: detail.source_id ?? null,
      });
    }
  }
  return rows;
}

function groupMessagesByRole(messages) {
  const grouped = new Map();
  for (const message of messages) {
    if (!message?.role || !message?.text) continue;
    const role = String(message.role);
    const existing = grouped.get(role);
    grouped.set(role, existing ? `${existing}\n\n${message.text}` : message.text);
  }

  const preferred = ['user', 'assistant', 'developer'];
  return [...grouped.entries()].sort(([a], [b]) => {
    const ai = preferred.indexOf(a);
    const bi = preferred.indexOf(b);
    if (ai !== -1 || bi !== -1) {
      return (ai === -1 ? preferred.length : ai) - (bi === -1 ? preferred.length : bi);
    }
    return a.localeCompare(b);
  });
}

function pickTurnCreatedAt(messages, fallback) {
  const times = messages
    .map((message) => Date.parse(message.time ?? ''))
    .filter((time) => Number.isFinite(time));
  if (times.length === 0) return fallback;
  return Math.min(...times);
}

function pickDetailCreatedAt(detail, fallback) {
  const time = Date.parse(detail?.time ?? '');
  return Number.isFinite(time) ? time : fallback;
}
