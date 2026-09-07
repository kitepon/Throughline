import { getDb } from '../db.mjs';
import { buildHandoffRecord } from '../handoff-record.mjs';
import { renderCodexNewThreadHandoff } from '../codex-handoff.mjs';
import { buildCodexHandoffSmoke } from '../codex-handoff-smoke.mjs';
import { buildCodexHandoffModelSmokePrompt } from '../codex-handoff-model-smoke.mjs';
import { runCodexNewThreadHandoff } from '../codex-app-server.mjs';
import { estimateTokens } from '../token-estimator.mjs';
import { sameProjectPath } from '../project-path.mjs';
import { shQuote } from '../os/shell.mjs';
import { openUrlWithOsHandler } from '../os/open-url.mjs';
import { runTerminalDoScript } from '../os/macos-terminal.mjs';
import { resolveCodexRuntime } from '../os/codex-runtime.mjs';

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
    execute: false,
    openHost: 'auto',
    codexAppServerBin: null,
    timeoutMs: 120_000,
    requestTimeoutMs: 60_000,
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
    } else if (arg === '--execute') {
      out.execute = true;
    } else if (arg === '--open-host') {
      const value = args[++i];
      if (!['auto', 'desktop', 'vscode', 'cli', 'none'].includes(value)) {
        throw new Error('--open-host must be auto, desktop, vscode, cli, or none');
      }
      out.openHost = value;
    } else if (arg === '--codex-app-server-bin') {
      const value = args[++i];
      if (!value || value.startsWith('-')) {
        throw new Error('--codex-app-server-bin requires a command path');
      }
      out.codexAppServerBin = value;
    } else if (arg === '--timeout-ms') {
      out.timeoutMs = parsePositiveInteger(args, ++i, '--timeout-ms');
    } else if (arg === '--request-timeout-ms') {
      out.requestTimeoutMs = parsePositiveInteger(args, ++i, '--request-timeout-ms');
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
       WHERE session_id LIKE 'codex:%'
       ORDER BY updated_at DESC`,
    )
    .all();
  const row = rows.find((candidate) => sameProjectPath(candidate.project_path, projectPath));
  return row?.session_id ?? null;
}

function limitArgs(parsed, { includeMaxPromptChars = false } = {}) {
  const args = [];
  if (includeMaxPromptChars && parsed.maxPromptChars !== undefined) {
    args.push('--max-prompt-chars', String(parsed.maxPromptChars));
  }
  if (parsed.maxDetailRefs !== undefined) {
    args.push('--max-detail-refs', String(parsed.maxDetailRefs));
  }
  if (parsed.maxRecentBodies !== undefined) {
    args.push('--max-recent-bodies', String(parsed.maxRecentBodies));
  }
  if (parsed.maxBodyChars !== undefined) {
    args.push('--max-body-chars', String(parsed.maxBodyChars));
  }
  return args;
}

function memoArgs(parsed) {
  return parsed.memoStdin ? ['--memo-stdin'] : [];
}

function commandFor(parts) {
  return parts.join(' ');
}

function buildGuidance({ sessionId, parsed, handoffSmoke, handoffPrompt }) {
  const smokeArgs = limitArgs(parsed, { includeMaxPromptChars: true });
  const handoffArgs = limitArgs(parsed);
  const modelPrompt = buildCodexHandoffModelSmokePrompt({
    handoffPrompt,
    marker: 'TL_CODEX_HANDOFF_START_SMOKE',
  });
  const commands = {
    structuralSmoke: commandFor([
      'throughline',
      'codex-handoff-smoke',
      '--session',
      sessionId,
      ...smokeArgs,
      ...memoArgs(parsed),
      '--json',
    ]),
    modelSmokeDryRun: commandFor([
      'throughline',
      'codex-handoff-model-smoke',
      '--session',
      sessionId,
      ...smokeArgs,
      ...memoArgs(parsed),
      '--dry-run',
      '--json',
    ]),
    renderPrompt: commandFor([
      'throughline',
      'codex-resume',
      '--session',
      sessionId,
      '--format',
      'handoff',
      ...handoffArgs,
      ...memoArgs(parsed),
    ]),
    liveModelSmoke: commandFor([
      'THROUGHLINE_EXPERIMENTAL_CODEX_HANDOFF_MODEL_SMOKE=1',
      'throughline',
      'codex-handoff-model-smoke',
      '--session',
      sessionId,
      ...smokeArgs,
      ...memoArgs(parsed),
      '--json',
    ]),
  };
  const ready = handoffSmoke.status === 'ready';
  const requestedOpenHost = parsed.openHost;
  const resolvedOpenHost = resolveOpenHost(requestedOpenHost);
  return {
    status: ready ? 'ready' : 'not-ready',
    reason: ready ? 'fresh_thread_handoff_start_ready' : 'handoff_smoke_not_ready',
    sessionId,
    mutatesCurrentThread: false,
    startThreadManually: !parsed.execute,
    execute: parsed.execute,
    openHost: parsed.openHost,
    requestedOpenHost,
    resolvedOpenHost,
    handoffSmoke,
    modelPromptChars: modelPrompt.length,
    estimatedModelPromptTokens: estimateTokens(modelPrompt),
    memoStdin: parsed.memoStdin,
    memoReplayNote: parsed.memoStdin
      ? 'Commands include --memo-stdin; pipe the same memo when replaying them.'
      : null,
    commands,
    steps: ready
      ? [
          'Run the structural smoke command if you want to re-check the handoff prompt.',
          'Run the model smoke dry-run command if you want to inspect the Codex exec boundary without starting a model turn.',
          'Render the handoff prompt with the render prompt command, or pass --print-prompt to this command.',
          ...(parsed.memoStdin
            ? ['When replaying individual commands, pipe the same memo because they include --memo-stdin.']
            : []),
          parsed.execute
            ? 'This command will start a new Codex thread through app-server, inject handoff memory, then open the selected host.'
            : 'Start a new Codex thread and provide the handoff prompt as the opening context.',
        ]
      : [
          'Fix the failing handoff smoke checks before starting a new Codex thread.',
          'This handoff command does not run current-thread trim; use trim --execute --host codex for guarded current-thread rollback / inject.',
        ],
  };
}

function renderTextResult(result) {
  const lines = [];
  lines.push('throughline codex handoff start');
  lines.push('');
  lines.push(`  status:            ${result.status}`);
  lines.push(`  reason:            ${result.reason}`);
  lines.push(`  session:           ${result.sessionId}`);
  lines.push(`  mutates thread:    ${result.mutatesCurrentThread ? 'yes' : 'no'}`);
  lines.push(`  execute:           ${result.execute ? 'yes' : 'no'}`);
  lines.push(`  open requested:    ${result.requestedOpenHost ?? result.openHost}`);
  lines.push(`  open resolved:     ${result.resolvedOpenHost ?? result.open?.host ?? result.openHost}`);
  if (result.runtime) lines.push(`  Codex実行元:       ${result.runtime.command} (${result.runtime.source})`);
  lines.push(`  handoff smoke:     ${result.handoffSmoke.status}`);
  lines.push(`  prompt chars:      ${result.handoffSmoke.promptChars}/${result.handoffSmoke.maxPromptChars}`);
  lines.push(`  model prompt:      ${result.modelPromptChars}`);
  if (result.memoReplayNote) {
    lines.push(`  memo replay:       ${result.memoReplayNote}`);
  }
  if (result.newThread) {
    lines.push(`  new thread:        ${result.newThread.threadId}`);
    lines.push(`  turn status:       ${result.newThread.turnStatus}`);
  }
  if (result.open) {
    lines.push(`  open status:       ${result.open.status}`);
    lines.push(`  desktop url:       ${result.open.desktopUrl}`);
    lines.push(`  vscode url:        ${result.open.vscodeUrl}`);
    lines.push(`  resume command:    ${result.open.resumeCommand}`);
  }
  lines.push('');
  lines.push('  commands:');
  lines.push(`    structural smoke:    ${result.commands.structuralSmoke}`);
  lines.push(`    model smoke dry-run: ${result.commands.modelSmokeDryRun}`);
  lines.push(`    render prompt:       ${result.commands.renderPrompt}`);
  lines.push(`    live model smoke:    ${result.commands.liveModelSmoke}`);
  lines.push('');
  lines.push('  steps:');
  for (const step of result.steps) {
    lines.push(`    - ${step}`);
  }
  if (result.prompt) {
    lines.push('');
    lines.push(result.prompt);
  }
  return lines.join('\n');
}

function isCodexDesktopEnvironment(env) {
  const originator = env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE?.trim()
    .toLowerCase()
    .replace(/[_-]+/g, ' ');
  return originator === 'codex desktop' || env.__CFBundleIdentifier === 'com.openai.codex';
}

function resolveOpenHost(host, env = process.env) {
  if (host !== 'auto') return host;
  if (isCodexDesktopEnvironment(env)) return 'desktop';
  if (
    env.VSCODE_IPC_HOOK_CLI ||
    env.VSCODE_IPC_HOOK ||
    env.TERM_PROGRAM === 'vscode' ||
    env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE === 'codex_vscode'
  ) {
    return 'vscode';
  }
  return 'cli';
}

function buildCodexDesktopUrl(threadId) {
  return `codex://threads/${encodeURIComponent(threadId)}`;
}

function openStartedCodexThread({ threadId, host, cwd }) {
  const resolvedHost = resolveOpenHost(host);
  const desktopUrl = buildCodexDesktopUrl(threadId);
  const vscodeUrl = `vscode://openai.chatgpt/local/${encodeURIComponent(threadId)}`;
  const resumeCommand = `codex resume ${threadId} --no-alt-screen`;
  if (resolvedHost === 'none') {
    return {
      status: 'skipped',
      reason: 'open_host_none',
      host: resolvedHost,
      requestedHost: host,
      resolvedHost,
      desktopUrl,
      vscodeUrl,
      resumeCommand,
    };
  }

  if (resolvedHost === 'desktop' || resolvedHost === 'vscode') {
    const url = resolvedHost === 'desktop' ? desktopUrl : vscodeUrl;
    const result = openUrlWithOsHandler(url);
    if (result.status !== 0) {
      return {
        status: 'failed',
        reason: `${resolvedHost}_deep_link_open_failed`,
        host: resolvedHost,
        requestedHost: host,
        resolvedHost,
        desktopUrl,
        vscodeUrl,
        resumeCommand,
        error: (result.stderr || result.stdout || '').trim(),
      };
    }
    return {
      status: 'opened',
      reason: `${resolvedHost}_deep_link_opened`,
      host: resolvedHost,
      requestedHost: host,
      resolvedHost,
      desktopUrl,
      vscodeUrl,
      resumeCommand,
    };
  }

  if (resolvedHost === 'cli') {
    if (process.platform === 'darwin') {
      const shellCommand = `cd ${shQuote(cwd)} && TERM=xterm-256color codex resume ${shQuote(threadId)} --no-alt-screen`;
      const result = runTerminalDoScript(shellCommand);
      if (result.status !== 0) {
        return {
          status: 'failed',
          reason: 'terminal_open_failed',
          host: resolvedHost,
          requestedHost: host,
          resolvedHost,
          desktopUrl,
          vscodeUrl,
          resumeCommand,
          error: (result.stderr || result.stdout || '').trim(),
        };
      }
      return {
        status: 'opened',
        reason: 'terminal_resume_opened',
        host: resolvedHost,
        requestedHost: host,
        resolvedHost,
        desktopUrl,
        vscodeUrl,
        resumeCommand,
      };
    }
    return {
      status: 'manual',
      reason: 'cli_auto_open_unsupported_on_platform',
      host: resolvedHost,
      requestedHost: host,
      resolvedHost,
      desktopUrl,
      vscodeUrl,
      resumeCommand,
    };
  }

  return {
    status: 'failed',
    reason: 'unsupported_open_host',
    host: resolvedHost,
    requestedHost: host,
    resolvedHost,
    desktopUrl,
    vscodeUrl,
    resumeCommand,
  };
}

export async function run(args) {
  let parsed;
  try {
    parsed = parseArgs(args);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown';
    process.stderr.write(`[codex-handoff-start] ${msg}\n`);
    process.exit(1);
  }

  const inflightMemo = parsed.memoStdin ? await readStdin() : null;
  const db = getDb();
  const sessionId = parsed.sessionId ?? findLatestCodexSessionId(db, process.cwd());
  if (!sessionId) {
    process.stderr.write(
      '[codex-handoff-start] no Codex session found for this project. Pass --session codex:<thread-id> explicitly.\n',
    );
    process.exit(1);
  }

  const record = buildHandoffRecord(db, {
    sessionId,
    isInheritance: false,
    inflightMemo,
  });
  if (!record) {
    process.stderr.write(`[codex-handoff-start] no handoff memory found for session ${sessionId}\n`);
    process.exit(1);
  }

  const smokeOptions = {
    maxPromptChars: parsed.maxPromptChars,
    maxDetailRefs: parsed.maxDetailRefs,
    maxRecentBodies: parsed.maxRecentBodies,
    maxBodyChars: parsed.maxBodyChars,
  };
  const handoffSmoke = buildCodexHandoffSmoke(record, smokeOptions);
  const handoffPrompt = renderCodexNewThreadHandoff(record, {
    maxDetailRefs: parsed.maxDetailRefs,
    maxRecentBodies: parsed.maxRecentBodies,
    maxBodyChars: parsed.maxBodyChars,
  });
  const result = buildGuidance({
    sessionId,
    parsed,
    handoffSmoke,
    handoffPrompt,
  });
  if (parsed.printPrompt) {
    result.prompt = handoffPrompt;
  }

  if (parsed.execute && result.status === 'ready') {
    const runtime = resolveCodexRuntime({
      host: result.resolvedOpenHost,
      override: parsed.codexAppServerBin,
    });
    result.runtime = runtime;
    const startResult = await runCodexNewThreadHandoff({
      cwd: process.cwd(),
      prompt: handoffPrompt,
      command: runtime.command,
      commandArgs: runtime.commandArgs,
      timeoutMs: parsed.timeoutMs,
      requestTimeoutMs: parsed.requestTimeoutMs,
      waitForTurn: false,
      delivery: 'developer-item',
    });
    const openResult = openStartedCodexThread({
      threadId: startResult.threadId,
      host: parsed.openHost,
      cwd: process.cwd(),
    });
    result.status = startResult.status === 'started' && openResult.status !== 'failed' ? 'started' : 'started-unverified';
    result.reason =
      startResult.status === 'started' && openResult.status !== 'failed'
        ? 'new_thread_handoff_started'
        : 'new_thread_handoff_started_but_open_unverified';
    result.startThreadManually = openResult.status === 'manual';
    result.newThread = startResult;
    result.open = openResult;
  }

  if (parsed.json) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  else process.stdout.write(renderTextResult(result) + '\n');
  process.exit(result.status === 'ready' || result.status === 'started' ? 0 : 1);
}

export const _internal = {
  buildCodexDesktopUrl,
  isCodexDesktopEnvironment,
  parseArgs,
  renderTextResult,
  resolveOpenHost,
};
