import { recordRuntimeErrorBestEffort, resolveRecoveredRuntimeErrorBestEffort } from '../runtime-error-store.mjs';
import { logHookFailure } from '../hook-failure-log.mjs';

function parseArgs(argv) {
  const out = {
    event: null,
    codexThreadId: null,
    codexHome: null,
    projectPath: null,
    json: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('-') && !out.event) {
      out.event = arg;
    } else if (arg === '--codex-thread-id') {
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

  if (!out.event) out.event = 'stop';
  if (!['stop', 'user-prompt-submit', 'post-tool-use', 'pre-compact'].includes(out.event)) {
    throw new Error(`unknown Codex hook event: ${out.event}`);
  }
  return out;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function parsePayload(raw) {
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown';
    throw new Error(`failed to parse Codex hook stdin JSON: ${msg}`);
  }
}

function codexHomeFromTranscriptPath(transcriptPath) {
  if (typeof transcriptPath !== 'string') return null;
  const match = /[\\/]sessions[\\/]/.exec(transcriptPath);
  if (!match || match.index <= 0) return null;
  return transcriptPath.slice(0, match.index);
}

function suppressExperimentalWarnings() {
  if (process.env.THROUGHLINE_SHOW_EXPERIMENTAL_WARNINGS === '1') return;
  process.on('warning', (warning) => {
    if (warning?.name === 'ExperimentalWarning') return;
    process.stderr.write(`${warning.name}: ${warning.message}\n`);
  });
}

function codexAutoRefreshDisabledResult() {
  return {
    status: 'skipped',
    reason: 'codex_auto_refresh_disabled',
  };
}

async function captureCodexHookSession({
  args = {},
  payload = {},
  env = process.env,
  db = null,
  writeMonitorState = null,
  ensureMonitorTask = null,
  buildMonitorUsage = null,
  summarize = true,
} = {}) {
  if (isSpotterChildEnvironment(env)) {
    return {
      status: 'skipped',
      reason: 'spotter_child_backend',
      db,
      identity: null,
      projectPath: null,
      codexHome: null,
      captured: null,
      summarized: null,
      monitorState: null,
      usage: null,
    };
  }

  const [
    { getDb },
    { captureCodexRolloutToDb },
    { resolveCodexThreadIdentity },
    { summarizeCodexSession },
    { writeSessionState },
    { ensureMonitorTaskFile },
    { buildCodexMonitorUsage },
  ] = await Promise.all([
    import('../db.mjs'),
    import('../codex-capture.mjs'),
    import('../codex-thread-identity.mjs'),
    import('./codex-summarize.mjs'),
    import('../state-file.mjs'),
    import('../vscode-task.mjs'),
    import('../codex-usage.mjs'),
  ]);
  const actualDb = db ?? getDb();
  const identity = resolveCodexHookThreadIdentity({ args, payload, env, resolveCodexThreadIdentity });

  if (!identity.codexThreadId) {
    return {
      status: 'skipped',
      reason: 'codex_thread_id_not_available',
      db: actualDb,
      identity,
      projectPath: null,
      codexHome: null,
      captured: null,
      summarized: null,
      monitorState: null,
      usage: null,
    };
  }

  const projectPath =
    args.projectPath ??
    (typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : process.cwd());
  const codexHome =
    args.codexHome ??
    codexHomeFromTranscriptPath(payload.transcript_path ?? payload.transcriptPath) ??
    undefined;

  const ensureTask = ensureMonitorTask ?? ensureMonitorTaskFile;
  try {
    ensureTask({ cwd: projectPath, env });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown';
    process.stderr.write(`[codex-hook:vscode-task] ${msg}\n`);
  }

  const captured = captureCodexRolloutToDb(actualDb, {
    threadId: identity.codexThreadId,
    codexHome,
    projectPath,
  });

  if (captured.status !== 'captured') {
    return {
      status: 'skipped',
      reason: captured.reason ?? 'codex_capture_not_available',
      db: actualDb,
      identity,
      projectPath,
      codexHome,
      captured,
      summarized: null,
      monitorState: null,
      usage: null,
    };
  }

  const usage = (buildMonitorUsage ?? buildCodexMonitorUsage)(captured.rolloutPath);
  let monitorState = null;
  try {
    monitorState = {
      sessionId: captured.sessionId,
      host: 'codex',
      projectPath: captured.projectPath ?? projectPath,
      transcriptPath: null,
      rolloutPath: captured.rolloutPath ?? null,
      pid: process.pid,
      usage,
    };
    (writeMonitorState ?? writeSessionState)(monitorState);
  } catch (err) {
    monitorState = null;
    const msg = err instanceof Error ? err.message : 'unknown';
    process.stderr.write(`[codex-hook:monitor-state] ${msg}\n`);
  }

  const summarized = summarize
    ? summarizeCodexSession(actualDb, {
        sessionId: captured.sessionId,
        projectPath: captured.projectPath ?? projectPath,
        max: 1,
        env,
      })
    : null;

  return {
    status: 'ok',
    reason: 'codex_rollout_captured',
    db: actualDb,
    identity,
    projectPath,
    codexHome,
    captured,
    summarized,
    monitorState,
    usage,
  };
}

function isSpotterChildEnvironment(env = {}) {
  return ['SPOTTER_PARENT_PID', 'SPOTTER_BACKEND', 'SPOTTER_CHILD_BACKEND']
    .some((name) => typeof env?.[name] === 'string' && env[name].length > 0);
}

export async function runCodexStopHook({
  args = {},
  payload = {},
  env = process.env,
  db = null,
  writeMonitorState = null,
  ensureMonitorTask = null,
  buildMonitorUsage = null,
  runAutoRefresh = null,
  autoRefreshStateStore = null,
} = {}) {
  void runAutoRefresh;
  void autoRefreshStateStore;
  const capturedState = await captureCodexHookSession({
    args,
    payload,
    env,
    db,
    writeMonitorState,
    ensureMonitorTask,
    buildMonitorUsage,
    summarize: true,
  });

  if (capturedState.status !== 'ok') {
    return {
      status: capturedState.status,
      reason: capturedState.reason,
      codexThreadIdSource: capturedState.identity?.codexThreadIdSource,
      captured: capturedState.captured,
      summarized: capturedState.summarized,
    };
  }

  return {
    status: 'ok',
    reason: 'codex_rollout_captured',
    codexThreadIdSource: capturedState.identity.codexThreadIdSource,
    captured: capturedState.captured,
    summarized: capturedState.summarized,
    monitorState: capturedState.monitorState,
    autoRefresh: codexAutoRefreshDisabledResult(),
  };
}

export async function runCodexUserPromptSubmitHook({
  args = {},
  payload = {},
  env = process.env,
  db = null,
  writeMonitorState = null,
  ensureMonitorTask = null,
  buildMonitorUsage = null,
  autoRefreshStateStore = null,
} = {}) {
  return runCodexContextRefreshInstructionHook({
    eventName: 'UserPromptSubmit',
    args,
    payload,
    env,
    db,
    writeMonitorState,
    ensureMonitorTask,
    buildMonitorUsage,
    autoRefreshStateStore,
  });
}

export async function runCodexPostToolUseHook({
  args = {},
  payload = {},
  env = process.env,
  db = null,
  writeMonitorState = null,
  ensureMonitorTask = null,
  buildMonitorUsage = null,
  autoRefreshStateStore = null,
} = {}) {
  return runCodexContextRefreshInstructionHook({
    eventName: 'PostToolUse',
    args,
    payload,
    env,
    db,
    writeMonitorState,
    ensureMonitorTask,
    buildMonitorUsage,
    autoRefreshStateStore,
  });
}

async function runCodexContextRefreshInstructionHook({
  eventName,
  args = {},
  payload = {},
  env = process.env,
  db = null,
  writeMonitorState = null,
  ensureMonitorTask = null,
  buildMonitorUsage = null,
  autoRefreshStateStore = null,
} = {}) {
  void eventName;
  void autoRefreshStateStore;
  const capturedState = await captureCodexHookSession({
    args,
    payload,
    env,
    db,
    writeMonitorState,
    ensureMonitorTask,
    buildMonitorUsage,
    summarize: false,
  });

  if (capturedState.status !== 'ok') {
    return {
      status: capturedState.status,
      reason: capturedState.reason,
      codexThreadIdSource: capturedState.identity?.codexThreadIdSource,
      captured: capturedState.captured,
      monitorState: capturedState.monitorState,
      autoRefreshPrompt: null,
    };
  }

  return {
    status: 'ok',
    reason: 'codex_rollout_captured',
    codexThreadIdSource: capturedState.identity.codexThreadIdSource,
    captured: capturedState.captured,
    monitorState: capturedState.monitorState,
    autoRefreshPrompt: codexAutoRefreshDisabledResult(),
  };
}

const L1_SUMMARIZER_BACKEND_REASONS = new Set(['codex_cli_failed', 'empty_output']);

/**
 * Codex hook が失敗した時に記録する runtime error の code を決める（ADR 0028）。
 * L1 要約の backend（Codex CLI）が非0で終わった、または空を返した失敗は、取り込みの後に起きる
 * 外部 CLI の失敗なので、hook 処理の失敗とは別の code で数える。hook の終了 code と stderr は変えない。
 * @param {unknown} error
 * @returns {'HOOK_CODEX_FAILED' | 'L1_SUMMARIZER_BACKEND_FAILED'}
 */
export function codexHookFailureCode(error) {
  if (error?.source === 'codex-cli' && L1_SUMMARIZER_BACKEND_REASONS.has(error?.reason)) {
    return 'L1_SUMMARIZER_BACKEND_FAILED';
  }
  return 'HOOK_CODEX_FAILED';
}

export async function run(argv = []) {
  suppressExperimentalWarnings();
  let parsed;
  let payload;
  try {
    parsed = parseArgs(argv);
    payload = parsePayload(await readStdin());
  } catch (err) {
    recordRuntimeErrorBestEffort('HOOK_CODEX_FAILED', { env: process.env });
    logHookFailure('HOOK_CODEX_FAILED', err);
    const msg = err instanceof Error ? err.message : 'unknown';
    process.stderr.write(`[codex-hook] ${msg}\n`);
    process.exit(1);
  }

  try {
    let result;
    if (parsed.event === 'pre-compact') {
      try {
        const { requestCodexAutoHandoff } = await import('../codex-auto-handoff.mjs');
        result = await requestCodexAutoHandoff({ payload });
      } catch (error) {
        recordRuntimeErrorBestEffort('HOOK_CODEX_FAILED', { env: process.env });
        logHookFailure('HOOK_CODEX_FAILED', error);
        const code = typeof error.code === 'string' ? error.code : 'handoff_request_failed';
        result = { status: 'failed', continue: false,
          stopReason: `Throughline自動継続が失敗しました: ${code}。記憶の圧縮を停止します。` };
      }
    } else if (parsed.event === 'user-prompt-submit') {
      result = await runCodexUserPromptSubmitHook({
        args: parsed,
        payload,
        env: process.env,
      });
    } else if (parsed.event === 'post-tool-use') {
      result = await runCodexPostToolUseHook({
        args: parsed,
        payload,
        env: process.env,
      });
    } else {
      result = await runCodexStopHook({
        args: parsed,
        payload,
        env: process.env,
      });
      // backend が要約を返した。失敗の後なら、復帰を確認できた（ADR 0041）。失敗の記録が無い時は、ファイルの有無を見るだけ。
      if (result.summarized?.summarized?.some((turn) => turn.source === 'codex-cli')) {
        const { noteL1BackendSuccess } = await import('../l1-backend-recovery.mjs');
        if (noteL1BackendSuccess().reported) {
          resolveRecoveredRuntimeErrorBestEffort('L1_SUMMARIZER_BACKEND_UNRECOVERED', { env: process.env });
        }
      }
    }
    if (parsed.event === 'pre-compact' && result.continue === false) {
      process.stdout.write(JSON.stringify({ continue: false, stopReason: result.stopReason }) + '\n');
    } else if (parsed.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    } else if (result.autoRefreshPrompt?.output) {
      process.stdout.write(result.autoRefreshPrompt.output + '\n');
    }
    // continue=falseは、明示した失敗理由を含めてhostへ停止を届けた返答。背景処理の成否は引き継ぎ状態へ記録する。
    process.exit(result.continue === false || result.status === 'ok' || result.status === 'skipped' ? 0 : 1);
  } catch (err) {
    const code = codexHookFailureCode(err);
    if (code === 'L1_SUMMARIZER_BACKEND_FAILED') {
      // 取り込みは済み、要約は次の Stop がやり直す。1回ごとの失敗（通信の断・利用上限・取り消しを含む）は
      // 端末の診断（hook-failures.log）にだけ残す。復帰を24時間確認できていない時だけ数える（ADR 0041）。
      const { noteL1BackendFailure } = await import('../l1-backend-recovery.mjs');
      if (noteL1BackendFailure().unrecovered) {
        recordRuntimeErrorBestEffort('L1_SUMMARIZER_BACKEND_UNRECOVERED', { env: process.env });
      }
    } else {
      recordRuntimeErrorBestEffort(code, { env: process.env });
    }
    logHookFailure(code, err);
    const msg = err instanceof Error ? err.message : 'unknown';
    if (parsed.json) {
      process.stdout.write(
        JSON.stringify(
          {
            status: 'error',
            reason: err?.reason ?? 'codex_hook_failed',
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
      process.stderr.write(`[codex-hook] ${msg}\n`);
    }
    process.exit(1);
  }
}

export const _internal = {
  codexHomeFromTranscriptPath,
  parseArgs,
  parsePayload,
  resolveCodexHookThreadIdentity,
};

function resolveCodexHookThreadIdentity({ args = {}, payload = {}, env, resolveCodexThreadIdentity }) {
  if (args.codexThreadId) {
    return resolveCodexThreadIdentity({ codexThreadId: args.codexThreadId }, env);
  }

  if (typeof payload.session_id === 'string' && payload.session_id) {
    return {
      codexThreadId: payload.session_id,
      codexThreadIdSource: 'payload:session_id',
    };
  }

  if (typeof payload.sessionId === 'string' && payload.sessionId) {
    return {
      codexThreadId: payload.sessionId,
      codexThreadIdSource: 'payload:sessionId',
    };
  }

  return resolveCodexThreadIdentity({ codexThreadId: null }, env);
}
