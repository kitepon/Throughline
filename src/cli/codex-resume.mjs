import { getDb } from '../db.mjs';
import { buildHandoffRecord } from '../handoff-record.mjs';
import {
  renderCodexActiveWorkContext,
  renderCodexNewThreadHandoff,
  toCodexDeveloperMessageItem,
} from '../codex-handoff.mjs';
import { sameProjectPath } from '../project-path.mjs';
import { mainSessionFilter } from '../session-kind.mjs';

const FORMATS = new Set(['text', 'handoff', 'item-json']);

async function readStdin() {
  let raw = '';
  await new Promise((resolve) => {
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      raw += chunk;
    });
    process.stdin.on('end', resolve);
  });
  return raw;
}

function parseArgs(args) {
  const out = {
    sessionId: null,
    format: 'text',
    memoStdin: false,
    maxDetailRefs: undefined,
    maxRecentBodies: undefined,
    maxBodyChars: undefined,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--session') {
      const value = args[++i];
      if (!value || value.startsWith('-')) {
        throw new Error('--session requires a session id');
      }
      out.sessionId = value;
    } else if (arg === '--format') {
      const value = args[++i];
      if (!FORMATS.has(value)) {
        throw new Error('--format must be text, handoff, or item-json');
      }
      out.format = value;
    } else if (arg === '--max-detail-refs') {
      const value = Number(args[++i]);
      if (!Number.isInteger(value) || value < 0) {
        throw new Error('--max-detail-refs must be a non-negative integer');
      }
      out.maxDetailRefs = value;
    } else if (arg === '--max-recent-bodies') {
      const value = Number(args[++i]);
      if (!Number.isInteger(value) || value < 0) {
        throw new Error('--max-recent-bodies must be a non-negative integer');
      }
      out.maxRecentBodies = value;
    } else if (arg === '--max-body-chars') {
      const value = Number(args[++i]);
      if (!Number.isInteger(value) || value < 0) {
        throw new Error('--max-body-chars must be a non-negative integer');
      }
      out.maxBodyChars = value;
    } else if (arg === '--memo-stdin') {
      out.memoStdin = true;
    } else if (!arg.startsWith('-') && !out.sessionId) {
      out.sessionId = arg;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
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

export async function run(args) {
  let parsed;
  try {
    parsed = parseArgs(args);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown';
    process.stderr.write(`[codex-resume] ${msg}\n`);
    process.exit(1);
  }

  const inflightMemo = parsed.memoStdin ? await readStdin() : null;
  const db = getDb();
  const sessionId = parsed.sessionId ?? findLatestCodexSessionId(db, process.cwd());
  if (!sessionId) {
    process.stderr.write(
      '[codex-resume] no Codex session found for this project. Pass --session codex:<thread-id> explicitly.\n',
    );
    process.exit(1);
  }

  const record = buildHandoffRecord(db, {
    sessionId,
    isInheritance: false,
    inflightMemo,
  });
  if (!record) {
    process.stderr.write(`[codex-resume] no handoff memory found for session ${sessionId}\n`);
    process.exit(1);
  }

  if (parsed.format === 'item-json') {
    process.stdout.write(JSON.stringify(toCodexDeveloperMessageItem(record), null, 2) + '\n');
    return;
  }

  if (parsed.format === 'handoff') {
    process.stdout.write(
      renderCodexNewThreadHandoff(record, {
        maxDetailRefs: parsed.maxDetailRefs,
        maxRecentBodies: parsed.maxRecentBodies,
        maxBodyChars: parsed.maxBodyChars,
      }) + '\n',
    );
    return;
  }

  process.stdout.write(renderCodexActiveWorkContext(record) + '\n');
}
