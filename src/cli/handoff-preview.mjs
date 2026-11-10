import { getDb } from '../db.mjs';
import { buildHandoffRecord } from '../handoff-record.mjs';
import { toThroughlineHandoffBlock } from '../codex-handoff.mjs';
import { sameProjectPath } from '../project-path.mjs';
import { mainSessionFilter } from '../session-kind.mjs';

function parseArgs(args) {
  const out = {
    sessionId: null,
    hostMode: 'claude-primary',
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--session') {
      const value = args[++i];
      if (!value || value.startsWith('-')) {
        throw new Error('--session requires a session id');
      }
      out.sessionId = value;
    } else if (arg === '--host-mode') {
      const value = args[++i];
      if (!['claude-primary', 'codex-primary', 'unknown'].includes(value)) {
        throw new Error('--host-mode must be claude-primary, codex-primary, or unknown');
      }
      out.hostMode = value;
    } else if (!arg.startsWith('-') && !out.sessionId) {
      out.sessionId = arg;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  return out;
}

function findLatestSessionId(db, projectPath) {
  const rows = db
    .prepare(
      `SELECT session_id, project_path
       FROM sessions
       WHERE 1 = 1 ${mainSessionFilter(db)}
       ORDER BY updated_at DESC`,
    )
    .all();
  const row = rows.find((candidate) => sameProjectPath(candidate.project_path, projectPath));
  return row?.session_id ?? null;
}

export function run(args) {
  let parsed;
  try {
    parsed = parseArgs(args);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown';
    process.stderr.write(`[handoff-preview] ${msg}\n`);
    process.exit(1);
  }

  const db = getDb();
  const sessionId = parsed.sessionId ?? findLatestSessionId(db, process.cwd());
  if (!sessionId) {
    process.stderr.write(
      '[handoff-preview] no session found for this project. Pass --session <id> explicitly.\n',
    );
    process.exit(1);
  }

  const record = buildHandoffRecord(db, {
    sessionId,
    isInheritance: false,
  });
  if (!record) {
    process.stderr.write(`[handoff-preview] no handoff memory found for session ${sessionId}\n`);
    process.exit(1);
  }

  const block = toThroughlineHandoffBlock(record, { hostMode: parsed.hostMode });
  process.stdout.write(JSON.stringify(block, null, 2) + '\n');
}
