import { randomUUID } from 'node:crypto';

import { getDb } from '../db.mjs';
import { buildHandoffRecord } from '../handoff-record.mjs';
import { renderCodexNewThreadHandoff } from '../codex-handoff.mjs';
import { buildCodexHandoffSmoke } from '../codex-handoff-smoke.mjs';
import {
  buildCodexHandoffModelSmokePrompt,
  CODEX_HANDOFF_MODEL_SMOKE_ENV,
  DEFAULT_CODEX_HANDOFF_MODEL_SMOKE_TIMEOUT_MS,
  runCodexHandoffModelSmoke,
} from '../codex-handoff-model-smoke.mjs';
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
    dryRun: false,
    printPrompt: false,
    memoStdin: false,
    marker: `TL_CODEX_HANDOFF_${randomUUID().slice(0, 8)}`,
    codexCliBin: null,
    timeoutMs: DEFAULT_CODEX_HANDOFF_MODEL_SMOKE_TIMEOUT_MS,
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
    } else if (arg === '--dry-run') {
      out.dryRun = true;
    } else if (arg === '--print-prompt') {
      out.printPrompt = true;
    } else if (arg === '--memo-stdin') {
      out.memoStdin = true;
    } else if (arg === '--marker') {
      const value = args[++i];
      if (!value || value.startsWith('-')) {
        throw new Error('--marker requires a marker string');
      }
      out.marker = value;
    } else if (arg === '--codex-cli-bin') {
      const value = args[++i];
      if (!value || value.startsWith('-')) {
        throw new Error('--codex-cli-bin requires a command path');
      }
      out.codexCliBin = value;
    } else if (arg === '--timeout-ms') {
      out.timeoutMs = parsePositiveInteger(args, ++i, '--timeout-ms');
    } else if (arg === '--max-prompt-chars') {
      out.maxPromptChars = parsePositiveInteger(args, ++i, '--max-prompt-chars');
    } else if (arg === '--max-detail-refs') {
      out.maxDetailRefs = parseNonNegativeInteger(args, ++i, '--max-detail-refs');
    } else if (arg === '--max-recent-bodies') {
      out.maxRecentBodies = parseNonNegativeInteger(args, ++i, '--max-recent-bodies');
    } else if (arg === '--max-body-chars') {
      out.maxBodyChars = parseNonNegativeInteger(args, ++i, '--max-body-chars');
    } else if (arg === '--json') {
      out.json = true;
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
  lines.push('throughline codex handoff model smoke');
  lines.push('');
  lines.push(`  status:          ${result.status}`);
  lines.push(`  reason:          ${result.reason}`);
  lines.push(`  session:         ${result.sessionId}`);
  lines.push(`  marker:          ${result.marker}`);
  lines.push(`  handoff smoke:   ${result.handoffSmoke.status}`);
  lines.push(`  prompt chars:    ${result.handoffSmoke.promptChars}`);
  if (result.modelPromptChars !== undefined) {
    lines.push(`  model prompt:    ${result.modelPromptChars}`);
  }
  if (result.wouldRun !== undefined) {
    lines.push(`  would run:       ${result.wouldRun ? 'yes' : 'no'}`);
  }
  lines.push(`  marker visible:  ${result.markerVisible ? 'yes' : 'no'}`);
  if (result.commandPreview) {
    lines.push(`  command:         ${result.commandPreview.join(' ')}`);
  }
  if (result.stdout) {
    lines.push('');
    lines.push('stdout:');
    lines.push(result.stdout.trim());
  }
  if (result.stderr) {
    lines.push('');
    lines.push('stderr:');
    lines.push(result.stderr.trim());
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
    process.stderr.write(`[codex-handoff-model-smoke] ${msg}\n`);
    process.exit(1);
  }

  const command = parsed.codexCliBin ?? process.env.THROUGHLINE_CODEX_CLI_BIN ?? 'codex';
  if (!parsed.dryRun && process.env[CODEX_HANDOFF_MODEL_SMOKE_ENV] !== '1') {
    const result = {
      status: 'refused',
      reason: 'experimental_env_required',
      requiredEnv: `${CODEX_HANDOFF_MODEL_SMOKE_ENV}=1`,
    };
    if (parsed.json) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    else process.stderr.write(`[codex-handoff-model-smoke] ${result.reason}\n`);
    process.exit(1);
  }

  const inflightMemo = parsed.memoStdin ? await readStdin() : null;
  const db = getDb();
  const sessionId = parsed.sessionId ?? findLatestCodexSessionId(db, process.cwd());
  if (!sessionId) {
    process.stderr.write(
      '[codex-handoff-model-smoke] no Codex session found for this project. Pass --session codex:<thread-id> explicitly.\n',
    );
    process.exit(1);
  }

  const record = buildHandoffRecord(db, {
    sessionId,
    isInheritance: false,
    inflightMemo,
  });
  if (!record) {
    process.stderr.write(`[codex-handoff-model-smoke] no handoff memory found for session ${sessionId}\n`);
    process.exit(1);
  }

  const handoffSmoke = buildCodexHandoffSmoke(record, {
    maxPromptChars: parsed.maxPromptChars,
    maxDetailRefs: parsed.maxDetailRefs,
    maxRecentBodies: parsed.maxRecentBodies,
    maxBodyChars: parsed.maxBodyChars,
  });
  if (handoffSmoke.status !== 'ready') {
    const result = {
      status: 'refused',
      reason: 'handoff_smoke_not_ready',
      sessionId,
      handoffSmoke,
    };
    if (parsed.json) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    else process.stdout.write(renderTextResult({ ...result, marker: parsed.marker, markerVisible: false }) + '\n');
    process.exit(1);
  }

  const handoffPrompt = renderCodexNewThreadHandoff(record, {
    maxDetailRefs: parsed.maxDetailRefs,
    maxRecentBodies: parsed.maxRecentBodies,
    maxBodyChars: parsed.maxBodyChars,
  });
  const prompt = buildCodexHandoffModelSmokePrompt({
    handoffPrompt,
    marker: parsed.marker,
  });
  const commandPreview = [
    command,
    'exec',
    '--ephemeral',
    '--ignore-user-config',
    '--ignore-rules',
    '--skip-git-repo-check',
    '--sandbox',
    'read-only',
    '-C',
    process.cwd(),
    '<prompt>',
  ];
  if (parsed.dryRun) {
    const result = {
      status: 'dry-run',
      reason: 'codex_exec_not_started',
      sessionId,
      marker: parsed.marker,
      markerVisible: false,
      handoffSmoke,
      command,
      commandPreview,
      modelPromptChars: prompt.length,
      estimatedModelPromptTokens: Math.ceil(prompt.length / 4),
      proofScope: 'dry_run_only',
      wouldRun: false,
      mutatesCurrentThread: false,
      prompt: parsed.printPrompt ? prompt : undefined,
    };
    if (parsed.json) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    else process.stdout.write(renderTextResult(result) + '\n');
    process.exit(0);
  }
  const smoke = runCodexHandoffModelSmoke({
    prompt,
    marker: parsed.marker,
    cwd: process.cwd(),
    command,
    timeoutMs: parsed.timeoutMs,
    env: {
      ...process.env,
      [CODEX_HANDOFF_MODEL_SMOKE_ENV]: process.env[CODEX_HANDOFF_MODEL_SMOKE_ENV],
    },
  });
  const result = {
    ...smoke,
    sessionId,
    handoffSmoke,
    command,
    commandPreview,
    modelPromptChars: prompt.length,
    estimatedModelPromptTokens: Math.ceil(prompt.length / 4),
    proofScope: 'codex_exec_ephemeral_read_only',
    wouldRun: true,
    mutatesCurrentThread: false,
  };

  if (parsed.json) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  else process.stdout.write(renderTextResult(result) + '\n');
  process.exit(result.status === 'visible' ? 0 : 1);
}

export const _internal = {
  parseArgs,
  renderTextResult,
};
