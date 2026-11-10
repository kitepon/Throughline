import { randomUUID } from 'node:crypto';
import { CODEX_SESSION_PREFIX, codexSessionIdToThreadId, isCodexSessionId } from '../hosts/identity.mjs';

import { getDb } from '../db.mjs';
import { buildHandoffRecord } from '../handoff-record.mjs';
import { mainSessionFilter } from '../session-kind.mjs';
import { renderCodexActiveWorkContext } from '../codex-handoff.mjs';
import { runCodexModelVisibilitySmoke } from '../codex-app-server.mjs';

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
    codexThreadId: null,
    marker: `TL_CODEX_VISIBLE_${randomUUID().slice(0, 8)}`,
    json: false,
    codexAppServerBin: null,
    timeoutMs: 180_000,
    requestTimeoutMs: 150_000,
    memoStdin: false,
    resumeAfterInject: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--session') {
      const value = args[++i];
      if (!value || value.startsWith('-')) {
        throw new Error('--session requires a session id');
      }
      out.sessionId = value;
    } else if (arg === '--codex-thread-id') {
      const value = args[++i];
      if (!value || value.startsWith('-')) {
        throw new Error('--codex-thread-id requires a thread id');
      }
      out.codexThreadId = value;
    } else if (arg === '--marker') {
      const value = args[++i];
      if (!value || value.startsWith('-')) {
        throw new Error('--marker requires a marker string');
      }
      out.marker = value;
    } else if (arg === '--codex-app-server-bin') {
      const value = args[++i];
      if (!value || value.startsWith('-')) {
        throw new Error('--codex-app-server-bin requires a command path');
      }
      out.codexAppServerBin = value;
    } else if (arg === '--timeout-ms') {
      const value = Number(args[++i]);
      if (!Number.isInteger(value) || value < 1) {
        throw new Error('--timeout-ms must be a positive integer');
      }
      out.timeoutMs = value;
    } else if (arg === '--request-timeout-ms') {
      const value = Number(args[++i]);
      if (!Number.isInteger(value) || value < 1) {
        throw new Error('--request-timeout-ms must be a positive integer');
      }
      out.requestTimeoutMs = value;
    } else if (arg === '--memo-stdin') {
      out.memoStdin = true;
    } else if (arg === '--resume-after-inject') {
      out.resumeAfterInject = true;
    } else if (arg === '--json') {
      out.json = true;
    } else if (!arg.startsWith('-') && !out.sessionId) {
      out.sessionId = arg;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  if (!out.sessionId && out.codexThreadId) {
    out.sessionId = `${CODEX_SESSION_PREFIX}${out.codexThreadId}`;
  }
  if (!out.codexThreadId && isCodexSessionId(out.sessionId)) {
    out.codexThreadId = codexSessionIdToThreadId(out.sessionId);
  }

  return out;
}

function findLatestCodexSessionId(db, projectPath) {
  const row = db
    .prepare(
      `SELECT session_id
       FROM sessions
       WHERE lower(project_path) = lower(?)
         AND session_id LIKE 'codex:%' ${mainSessionFilter(db)}
       ORDER BY updated_at DESC
       LIMIT 1`,
    )
    .get(projectPath);
  return row?.session_id ?? null;
}

function renderTextResult(result) {
  const lines = [];
  lines.push('throughline codex visibility smoke');
  lines.push('');
  lines.push(`  status:         ${result.status}`);
  lines.push(`  reason:         ${result.reason}`);
  lines.push(`  thread:         ${result.threadId}`);
  lines.push(`  marker:         ${result.marker}`);
  lines.push(`  readTurns:      ${result.readTurns ?? 'unknown'}`);
  lines.push(`  resumedTurns:   ${result.resumedTurns ?? 'unknown'}`);
  if (result.resumeAfterInject) {
    lines.push(`  postInjectResumeTurns: ${result.postInjectResumedTurns ?? 'unknown'}`);
  }
  lines.push(`  injectSent:     ${result.injectSent ? 'yes' : 'no'}`);
  lines.push(`  resumeAfterInject: ${result.resumeAfterInject ? 'yes' : 'no'}`);
  lines.push(`  turnStartSent:  ${result.turnStartSent ? 'yes' : 'no'}`);
  if (result.agentText) {
    lines.push('');
    lines.push('agent text:');
    lines.push(result.agentText);
  }
  return lines.join('\n');
}

export async function run(args) {
  let parsed;
  try {
    parsed = parseArgs(args);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown';
    process.stderr.write(`[codex-visibility-smoke] ${msg}\n`);
    process.exit(1);
  }

  if (process.env.THROUGHLINE_EXPERIMENTAL_CODEX_MODEL_VISIBLE_SMOKE !== '1') {
    const result = {
      status: 'refused',
      reason: 'experimental_env_required',
      requiredEnv: 'THROUGHLINE_EXPERIMENTAL_CODEX_MODEL_VISIBLE_SMOKE=1',
    };
    if (parsed.json) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    else process.stderr.write(`[codex-visibility-smoke] ${result.reason}\n`);
    process.exit(1);
  }

  const inflightMemo = parsed.memoStdin ? await readStdin() : null;
  const db = getDb();
  const sessionId = parsed.sessionId ?? findLatestCodexSessionId(db, process.cwd());
  const codexThreadId =
    parsed.codexThreadId ?? codexSessionIdToThreadId(sessionId);
  if (!sessionId || !codexThreadId) {
    process.stderr.write(
      '[codex-visibility-smoke] pass --session codex:<thread-id> or --codex-thread-id <id>.\n',
    );
    process.exit(1);
  }

  const record = buildHandoffRecord(db, { sessionId, isInheritance: false, inflightMemo });
  if (!record) {
    process.stderr.write(`[codex-visibility-smoke] no handoff memory found for session ${sessionId}\n`);
    process.exit(1);
  }

  const memoryText = [
    renderCodexActiveWorkContext(record),
    '',
    '### Model Visibility Smoke',
    `When asked for the Throughline model-visible smoke marker, reply exactly: ${parsed.marker}`,
  ].join('\n');
  const command = parsed.codexAppServerBin ?? process.env.THROUGHLINE_CODEX_APP_SERVER_BIN ?? 'codex';
  const result = await runCodexModelVisibilitySmoke({
    threadId: codexThreadId,
    cwd: process.cwd(),
    memoryText,
    marker: parsed.marker,
    command,
    timeoutMs: parsed.timeoutMs,
    requestTimeoutMs: parsed.requestTimeoutMs,
    resumeAfterInject: parsed.resumeAfterInject,
  });

  if (parsed.json) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  else process.stdout.write(renderTextResult(result) + '\n');
  process.exit(result.status === 'visible' ? 0 : 1);
}

export const _internal = {
  parseArgs,
};
