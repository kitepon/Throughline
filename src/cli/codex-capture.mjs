import { getDb } from '../db.mjs';
import { captureCodexRolloutToDb } from '../codex-capture.mjs';
import { resolveCodexThreadIdentity } from '../codex-thread-identity.mjs';
import { forkIdentityFromEnv } from '../session-kind.mjs';

function parseArgs(argv) {
  const out = {
    codexThreadId: null,
    codexHome: null,
    projectPath: process.cwd(),
    json: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--codex-thread-id') {
      const value = argv[++i];
      if (!value || value.startsWith('-')) throw new Error('--codex-thread-id requires an id');
      out.codexThreadId = value;
    } else if (arg === '--codex-home') {
      const value = argv[++i];
      if (!value || value.startsWith('-')) throw new Error('--codex-home requires a path');
      out.codexHome = value;
    } else if (arg === '--project') {
      const value = argv[++i];
      if (!value || value.startsWith('-')) throw new Error('--project requires a path');
      out.projectPath = value;
    } else if (arg === '--json') {
      out.json = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  return out;
}

export async function run(argv) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown';
    process.stderr.write(`[codex-capture] ${msg}\n`);
    process.exit(1);
  }

  const identity = resolveCodexThreadIdentity({ codexThreadId: parsed.codexThreadId }, process.env);
  if (!identity.codexThreadId) {
    process.stderr.write(
      '[codex-capture] missing Codex thread id. Pass --codex-thread-id <id> or set THROUGHLINE_CODEX_THREAD_ID / CODEX_THREAD_ID.\n',
    );
    process.exit(1);
  }

  let result;
  try {
    result = captureCodexRolloutToDb(getDb(), {
      threadId: identity.codexThreadId,
      codexHome: parsed.codexHome ?? undefined,
      projectPath: parsed.projectPath,
      fork: forkIdentityFromEnv(process.env),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown';
    process.stderr.write(`[codex-capture] ${msg}\n`);
    process.exit(1);
  }

  const output = {
    ...result,
    codexThreadIdSource: identity.codexThreadIdSource,
  };

  if (parsed.json) {
    process.stdout.write(JSON.stringify(output, null, 2) + '\n');
  } else {
    process.stdout.write(renderReport(output) + '\n');
  }

  process.exit(result.status === 'captured' ? 0 : 1);
}

function renderReport(result) {
  const lines = [];
  lines.push('## Throughline Codex Capture');
  lines.push('');
  lines.push(`Status: ${result.status}`);
  if (result.reason) lines.push(`Reason: ${result.reason}`);
  lines.push(`Codex thread: ${result.threadId}`);
  lines.push(`Throughline session: ${result.sessionId}`);
  lines.push(`Project: ${result.projectPath}`);
  if (result.rolloutPath) lines.push(`Rollout: ${result.rolloutPath}`);
  lines.push(`Captured turns: ${result.capturedTurns}`);
  lines.push(`Captured rows: ${result.capturedRows}`);
  return lines.join('\n');
}
