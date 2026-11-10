import { getDb } from '../db.mjs';
import { buildHandoffRecord } from '../handoff-record.mjs';
import { buildCodexHandoffSmoke } from '../codex-handoff-smoke.mjs';
import { sameProjectPath } from '../project-path.mjs';
import { mainSessionFilter } from '../session-kind.mjs';

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

function parseNonNegativeInteger(args, index, flag) {
  const value = Number(args[index]);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${flag} must be a non-negative integer`);
  }
  return value;
}

function parsePositiveInteger(args, index, flag) {
  const value = Number(args[index]);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return value;
}

function parseArgs(args) {
  const out = {
    sessionId: null,
    json: false,
    printPrompt: false,
    memoStdin: false,
    maxPromptChars: undefined,
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
    } else if (arg === '--json') {
      out.json = true;
    } else if (arg === '--print-prompt') {
      out.printPrompt = true;
    } else if (arg === '--memo-stdin') {
      out.memoStdin = true;
    } else if (arg === '--max-prompt-chars') {
      out.maxPromptChars = parsePositiveInteger(args, ++i, '--max-prompt-chars');
    } else if (arg === '--max-detail-refs') {
      out.maxDetailRefs = parseNonNegativeInteger(args, ++i, '--max-detail-refs');
    } else if (arg === '--max-recent-bodies') {
      out.maxRecentBodies = parseNonNegativeInteger(args, ++i, '--max-recent-bodies');
    } else if (arg === '--max-body-chars') {
      out.maxBodyChars = parseNonNegativeInteger(args, ++i, '--max-body-chars');
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

function renderTextResult(result) {
  const lines = [];
  lines.push('throughline codex handoff smoke');
  lines.push('');
  lines.push(`  status:                 ${result.status}`);
  lines.push(`  reason:                 ${result.reason}`);
  lines.push(`  session:                ${result.sessionId}`);
  lines.push(`  source agent:           ${result.sourceAgent}`);
  lines.push(`  prompt chars:           ${result.promptChars}/${result.maxPromptChars}`);
  lines.push(`  estimated tokens:       ${result.estimatedTokens}`);
  lines.push(`  L1 summaries:           ${result.l1Summaries}`);
  lines.push(`  recent L2 bodies:       ${result.recentBodies}`);
  lines.push(`  L3 references:          ${result.l3References}`);
  lines.push(`  rendered detail suffixes: ${result.renderedDetailSuffixes}`);
  lines.push('');
  lines.push('  checks:');
  for (const check of result.checks) {
    lines.push(`    - ${check.id}: ${check.status}`);
  }
  if (result.prompt) {
    lines.push('');
    lines.push(result.prompt);
  }
  return lines.join('\n');
}

export async function run(args) {
  let parsed;
  try {
    parsed = parseArgs(args);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown';
    process.stderr.write(`[codex-handoff-smoke] ${msg}\n`);
    process.exit(1);
  }

  const inflightMemo = parsed.memoStdin ? await readStdin() : null;
  const db = getDb();
  const sessionId = parsed.sessionId ?? findLatestCodexSessionId(db, process.cwd());
  if (!sessionId) {
    process.stderr.write(
      '[codex-handoff-smoke] no Codex session found for this project. Pass --session codex:<thread-id> explicitly.\n',
    );
    process.exit(1);
  }

  const record = buildHandoffRecord(db, {
    sessionId,
    isInheritance: false,
    inflightMemo,
  });
  if (!record) {
    process.stderr.write(`[codex-handoff-smoke] no handoff memory found for session ${sessionId}\n`);
    process.exit(1);
  }

  const result = buildCodexHandoffSmoke(record, {
    maxPromptChars: parsed.maxPromptChars,
    maxDetailRefs: parsed.maxDetailRefs,
    maxRecentBodies: parsed.maxRecentBodies,
    maxBodyChars: parsed.maxBodyChars,
    includePrompt: parsed.printPrompt,
  });

  if (parsed.json) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  else process.stdout.write(renderTextResult(result) + '\n');
  process.exit(result.status === 'ready' ? 0 : 1);
}

export const _internal = {
  parseArgs,
  renderTextResult,
};
