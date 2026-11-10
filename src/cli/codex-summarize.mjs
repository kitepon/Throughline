import { getDb } from '../db.mjs';
import { isCodexSessionId } from '../hosts/identity.mjs';
import {
  L2_WINDOW,
  countDistinctBodyTurns,
  pickOldestUnsummarizedTurn,
} from '../turn-processor.mjs';
import { summarizeToL1 } from '../haiku-summarizer.mjs';
import { sameProjectPath } from '../project-path.mjs';
import { mainSessionFilter } from '../session-kind.mjs';

function parseArgs(args) {
  const out = {
    sessionId: null,
    codexThreadId: null,
    json: false,
    max: 1,
    projectPath: process.cwd(),
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--session') {
      const value = args[++i];
      if (!value || value.startsWith('-')) throw new Error('--session requires a session id');
      out.sessionId = value;
    } else if (arg === '--codex-thread-id') {
      const value = args[++i];
      if (!value || value.startsWith('-')) {
        throw new Error('--codex-thread-id requires a thread id');
      }
      out.codexThreadId = value;
    } else if (arg === '--max') {
      const value = Number(args[++i]);
      if (!Number.isInteger(value) || value < 1) throw new Error('--max must be a positive integer');
      out.max = value;
    } else if (arg === '--project') {
      const value = args[++i];
      if (!value || value.startsWith('-')) throw new Error('--project requires a path');
      out.projectPath = value;
    } else if (arg === '--json') {
      out.json = true;
    } else if (!arg.startsWith('-') && !out.sessionId) {
      out.sessionId = arg;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  if (!out.sessionId && out.codexThreadId) {
    out.sessionId = `codex:${out.codexThreadId}`;
  }
  return out;
}

function findLatestCodexSessionId(db, projectPath) {
  const rows = db
    .prepare(
      `SELECT session_id, project_path
       FROM sessions
       WHERE session_id LIKE 'codex:%' ${mainSessionFilter(db)}
       ORDER BY updated_at DESC`,
    )
    .all();
  const row = rows.find((candidate) => sameProjectPath(candidate.project_path, projectPath));
  return row?.session_id ?? null;
}

function buildL2ForSummary(rows) {
  return rows
    .map((row) => `[${row.role}]: ${row.text}`)
    .join('\n\n')
    .trim();
}

function loadTurnRows(db, { sessionId, originSessionId, turnNumber }) {
  return db
    .prepare(
      `SELECT role, text, created_at
       FROM bodies
       WHERE session_id = ? AND origin_session_id = ? AND turn_number = ?
       ORDER BY created_at ASC, id ASC`,
    )
    .all(sessionId, originSessionId, turnNumber);
}

function insertSkeleton(db, { sessionId, originSessionId, turnNumber, summary, createdAt }) {
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO skeletons
         (session_id, origin_session_id, turn_number, role, summary, created_at)
       VALUES (?, ?, ?, 'assistant', ?, ?)`,
    )
    .run(sessionId, originSessionId, turnNumber, summary, createdAt);
  return result.changes > 0;
}

export function summarizeCodexSession(db, { sessionId, projectPath, max, env = process.env }) {
  if (!isCodexSessionId(sessionId)) {
    throw new Error('codex-summarize requires a codex:<thread-id> session');
  }

  const totalTurns = countDistinctBodyTurns(db, sessionId);
  if (totalTurns <= L2_WINDOW) {
    return {
      status: 'skipped',
      reason: 'within_l2_window',
      sessionId,
      totalTurns,
      l2Window: L2_WINDOW,
      summarized: [],
    };
  }

  const summarized = [];
  for (let i = 0; i < max; i++) {
    const oldest = pickOldestUnsummarizedTurn(db, sessionId);
    if (!oldest) break;
    const rows = loadTurnRows(db, {
      sessionId,
      originSessionId: oldest.origin_session_id,
      turnNumber: oldest.turn_number,
    });
    const l2Text = buildL2ForSummary(rows);
    const result = summarizeToL1(l2Text, {
      projectPath,
      hostMode: 'codex-primary',
      env,
    });
    const inserted = insertSkeleton(db, {
      sessionId,
      originSessionId: oldest.origin_session_id,
      turnNumber: oldest.turn_number,
      summary: result.summary,
      createdAt: oldest.created_at,
    });
    summarized.push({
      originSessionId: oldest.origin_session_id,
      turnNumber: oldest.turn_number,
      source: result.source ?? 'codex-cli',
      inserted,
    });
  }

  return {
    status: summarized.length > 0 ? 'summarized' : 'skipped',
    reason: summarized.length > 0 ? 'codex_cli_l1_written' : 'no_unsummarized_turns',
    sessionId,
    totalTurns,
    l2Window: L2_WINDOW,
    summarized,
  };
}

function renderTextResult(result) {
  const lines = [];
  lines.push('throughline codex summarize');
  lines.push('');
  lines.push(`  status:       ${result.status}`);
  lines.push(`  reason:       ${result.reason}`);
  lines.push(`  session:      ${result.sessionId}`);
  lines.push(`  totalTurns:   ${result.totalTurns}`);
  lines.push(`  l2Window:     ${result.l2Window}`);
  lines.push(`  summarized:   ${result.summarized.length}`);
  for (const row of result.summarized) {
    lines.push(`    - turn ${row.turnNumber} (${row.source})`);
  }
  return lines.join('\n');
}

export async function run(args) {
  let parsed;
  try {
    parsed = parseArgs(args);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown';
    process.stderr.write(`[codex-summarize] ${msg}\n`);
    process.exit(1);
  }

  const db = getDb();
  const sessionId = parsed.sessionId ?? findLatestCodexSessionId(db, parsed.projectPath);
  if (!sessionId) {
    process.stderr.write(
      '[codex-summarize] no Codex session found for this project. Pass --session codex:<thread-id> explicitly.\n',
    );
    process.exit(1);
  }

  try {
    const result = summarizeCodexSession(db, {
      sessionId,
      projectPath: parsed.projectPath,
      max: parsed.max,
    });
    if (parsed.json) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    else process.stdout.write(renderTextResult(result) + '\n');
    process.exit(result.status === 'summarized' || result.status === 'skipped' ? 0 : 1);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown';
    if (parsed.json) {
      process.stdout.write(
        JSON.stringify(
          {
            status: 'error',
            reason: err?.reason ?? 'codex_summarize_failed',
            source: err?.source ?? null,
            message: msg,
            stderr: err?.stderr ?? '',
            exitCode: err?.exitCode ?? null,
          },
          null,
          2,
        ) + '\n',
      );
    } else {
      process.stderr.write(`[codex-summarize] ${msg}\n`);
    }
    process.exit(1);
  }
}

export const _internal = {
  parseArgs,
  summarizeCodexSession,
};
