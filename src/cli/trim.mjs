import { runCodexTrimExecution, runCodexTrimPreflight } from '../codex-app-server.mjs';
import { CODEX_HOST } from '../hosts/identity.mjs';
import {
  buildCodexRolloutTrimSource,
  parseCodexRolloutFile,
} from '../codex-rollout-memory.mjs';
import { resolveCodexThreadIdentity } from '../codex-thread-identity.mjs';
import { getDb } from '../db.mjs';
import {
  DEFAULT_TRIM_KEEP_RECENT,
  DEFAULT_TRIM_PREVIEW_MAX_CHARS,
  buildTrimPlan,
  renderTrimDryRunReport,
} from '../trim-model.mjs';

// 外部app-serverの記録用プロセスは高負荷時に起動が遅れるため、観測を最大3秒待つ。
const DURABLE_ROLLOUT_READ_ATTEMPTS = 30;
const DURABLE_ROLLOUT_READ_DELAY_MS = 100;

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
    dryRun: false,
    json: false,
    sessionId: null,
    host: 'unknown',
    keepRecent: DEFAULT_TRIM_KEEP_RECENT,
    trimAll: false,
    memoStdin: false,
    codexThreadId: null,
    previewMaxChars: DEFAULT_TRIM_PREVIEW_MAX_CHARS,
    preflight: false,
    execute: false,
    codexAppServerBin: null,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--dry-run') {
      out.dryRun = true;
    } else if (arg === '--json') {
      out.json = true;
    } else if (arg === '--session') {
      const value = args[++i];
      if (!value || value.startsWith('-')) {
        throw new Error('--session requires a session id');
      }
      out.sessionId = value;
    } else if (arg === '--host') {
      const value = args[++i];
      if (!['claude', 'codex', 'unknown'].includes(value)) {
        throw new Error('--host must be claude, codex, or unknown');
      }
      out.host = value;
    } else if (arg === '--keep-recent') {
      const value = args[++i];
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 0) {
        throw new Error('--keep-recent must be a non-negative integer');
      }
      out.keepRecent = parsed;
    } else if (arg === '--all') {
      out.trimAll = true;
    } else if (arg === '--memo-stdin') {
      out.memoStdin = true;
    } else if (arg === '--preview-max-chars') {
      const value = Number(args[++i]);
      if (!Number.isInteger(value) || value < 1) {
        throw new Error('--preview-max-chars must be a positive integer');
      }
      out.previewMaxChars = value;
    } else if (arg === '--codex-thread-id') {
      const value = args[++i];
      if (!value || value.startsWith('-')) {
        throw new Error('--codex-thread-id requires a thread id');
      }
      out.codexThreadId = value;
    } else if (arg === '--preflight') {
      out.preflight = true;
    } else if (arg === '--execute') {
      out.execute = true;
    } else if (arg === '--codex-app-server-bin') {
      const value = args[++i];
      if (!value || value.startsWith('-')) {
        throw new Error('--codex-app-server-bin requires a command path');
      }
      out.codexAppServerBin = value;
    } else if (!arg.startsWith('-') && !out.sessionId) {
      out.sessionId = arg;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  return out;
}

export async function run(args) {
  let parsed;
  try {
    parsed = parseArgs(args);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown';
    process.stderr.write(`[trim] ${msg}\n`);
    process.exit(1);
  }

  parsed = {
    ...parsed,
    ...resolveCodexThreadIdentity(parsed, process.env),
  };

  const inflightMemo = parsed.memoStdin ? await readStdin() : null;
  const db = getDb();
  const trimSource =
    parsed.host === CODEX_HOST && parsed.codexThreadId
      ? buildCodexRolloutTrimSource({
          threadId: parsed.codexThreadId,
          projectPath: process.cwd(),
          sourceReason:
            parsed.codexThreadIdSource && parsed.codexThreadIdSource.startsWith('env:')
              ? 'env_codex_thread_rollout'
              : 'explicit_codex_thread_rollout',
        })
      : null;
  const plan = buildTrimPlan(db, {
    sessionId: parsed.sessionId,
    projectPath: process.cwd(),
    host: parsed.host,
    keepRecent: parsed.keepRecent,
    trimAll: parsed.trimAll,
    inflightMemo,
    codexThreadId: parsed.codexThreadId,
    codexThreadIdSource: parsed.codexThreadIdSource,
    trimSource,
    previewMaxChars: parsed.previewMaxChars,
  });

  if (!parsed.dryRun) {
    if (parsed.preflight && parsed.execute) {
      process.stderr.write('[trim] choose either --preflight or --execute, not both.\n');
      process.exit(1);
    }

    if (!parsed.preflight && !parsed.execute) {
      process.stderr.write(
        '[trim] automatic rollback/inject is not implemented yet. Re-run with --dry-run, --preflight, or guarded --execute.\n',
      );
      process.exit(1);
    }

    const result = parsed.preflight ? await runPreflight(parsed, plan) : await runExecute(parsed, plan);
    if (parsed.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    } else {
      process.stdout.write(renderTrimActionReport(result) + '\n');
    }
    process.exitCode =
      result.status === 'preflight-ready' || result.status === 'execute-durable-verified'
        ? 0
        : 1;
    return;
  }

  if (parsed.json) {
    process.stdout.write(JSON.stringify(plan, null, 2) + '\n');
  } else {
    process.stdout.write(renderTrimDryRunReport(plan) + '\n');
  }

  process.exitCode = plan.status === 'unavailable' ? 1 : 0;
}

async function runExecute(parsed, plan) {
  const refusal = validateCodexAction(parsed, plan, 'execute');
  if (refusal) return refusal;

  if (!hasInjectableMemory(plan.memoryPreview)) {
    return {
      status: 'execute-refused',
      reason: 'injectable_memory_required',
      plan,
    };
  }

  const command = parsed.codexAppServerBin ?? process.env.THROUGHLINE_CODEX_APP_SERVER_BIN ?? 'codex';
  const execution = await runCodexTrimExecution({
    threadId: parsed.codexThreadId,
    cwd: process.cwd(),
    rollbackTurns: plan.trim.rollbackTurns,
    memoryText: plan.memoryPreview.text,
    expectedTurns: expectedCodexAppServerTurns(plan),
    command,
  });

  if (execution.status === 'refused') {
    return {
      status: 'execute-refused',
      reason: execution.reason,
      plan,
      execution,
    };
  }

  const classification = await classifyCodexExecutionResult({ plan, execution });
  return {
    status: classification.status,
    reason: classification.reason,
    durableVerification: classification.durableVerification,
    plan: {
      ...plan,
      mode: 'execute',
    },
    execution,
  };
}

async function classifyCodexExecutionResult({ plan, execution }) {
  const visibilityStatus = execution.postInjectVisibilityCheck?.status ?? 'unchecked';
  const restoreSafetyStatus = plan.trim?.restoreSafety?.status ?? 'unknown';
  const initialRolloutStats = plan.trim?.rolloutStats ?? {};
  const durableVerification = {
    liveMutationSent: Boolean(execution.rollbackSent && execution.injectSent),
    durableVerified: false,
    postInjectVisibilityStatus: visibilityStatus,
    restoreSafetyStatus,
    rolloutPath: plan.trim?.rolloutPath ?? null,
    rolloutChecked: false,
    postExecuteRestoreSafetyStatus: null,
    observedNewRollbackEvent: false,
    observedInjectedMemory: false,
    reasons: [],
  };

  if (visibilityStatus !== 'match') {
    durableVerification.reasons.push(
      execution.postInjectVisibilityCheck?.reason ?? 'post_inject_visibility_unverified',
    );
  }

  if (!durableVerification.rolloutPath) {
    durableVerification.reasons.push('rollout_path_unavailable_for_durable_verification');
    if (visibilityStatus !== 'match') {
      return {
        status: 'execute-unverified',
        reason: execution.postInjectVisibilityCheck?.reason ?? 'post_inject_visibility_unverified',
        durableVerification,
      };
    }
    return {
      status: 'execute-sent-live-only',
      reason: 'rollback_and_inject_sent_live_only',
      durableVerification,
    };
  }

  const evidence = await waitForDurableRolloutEvidence({
    durableVerification,
    initialRolloutStats,
    attempts: DURABLE_ROLLOUT_READ_ATTEMPTS,
    delayMs: DURABLE_ROLLOUT_READ_DELAY_MS,
  });

  if (evidence.error) {
    durableVerification.reasons.push('rollout_durable_verification_failed');
    durableVerification.error = evidence.error;
    return {
      status: 'execute-unverified',
      reason: 'rollout_durable_verification_failed',
      durableVerification,
    };
  }

  if (visibilityStatus !== 'match') {
    return {
      status: 'execute-unverified',
      reason: execution.postInjectVisibilityCheck?.reason ?? 'post_inject_visibility_unverified',
      durableVerification,
    };
  }

  if (!durableVerification.observedNewRollbackEvent) {
    durableVerification.reasons.push('rollback_marker_not_observed_in_rollout');
    return {
      status: 'execute-unverified',
      reason: 'rollback_marker_not_observed_in_rollout',
      durableVerification,
    };
  }

  if (!durableVerification.observedInjectedMemory) {
    durableVerification.reasons.push('injected_memory_not_observed_in_rollout');
    return {
      status: 'execute-unverified',
      reason: 'injected_memory_not_observed_in_rollout',
      durableVerification,
    };
  }

  durableVerification.durableVerified = true;
  durableVerification.reasons.push('rollout_durable_evidence_verified');
  durableVerification.restoreSafetyStatus = durableVerification.postExecuteRestoreSafetyStatus;
  return {
    status: 'execute-durable-verified',
    reason: 'rollback_and_inject_durable_verified',
    durableVerification,
  };
}

async function waitForDurableRolloutEvidence({
  durableVerification,
  initialRolloutStats,
  attempts,
  delayMs,
}) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (attempt > 1 && delayMs > 0) {
      await sleep(delayMs);
    }

    let parsedAfter;
    try {
      parsedAfter = parseCodexRolloutFile(durableVerification.rolloutPath);
    } catch (err) {
      durableVerification.rolloutChecked = true;
      return {
        error: err instanceof Error ? err.message : String(err),
      };
    }

    durableVerification.rolloutChecked = true;
    durableVerification.postExecuteRestoreSafetyStatus = parsedAfter.restoreSafety?.status ?? 'unknown';
    durableVerification.observedNewRollbackEvent =
      parsedAfter.stats.rollbackEvents > (initialRolloutStats.rollbackEvents ?? 0);
    durableVerification.observedInjectedMemory =
      parsedAfter.stats.injectedDeveloperMessages > (initialRolloutStats.injectedDeveloperMessages ?? 0);

    if (
      (durableVerification.observedNewRollbackEvent && durableVerification.observedInjectedMemory)
    ) {
      return {};
    }
  }

  return {};
}

async function runPreflight(parsed, plan) {
  const refusal = validateCodexAction(parsed, plan, 'preflight');
  if (refusal) return refusal;

  const command = parsed.codexAppServerBin ?? process.env.THROUGHLINE_CODEX_APP_SERVER_BIN ?? 'codex';
  const preflight = await runCodexTrimPreflight({
    threadId: parsed.codexThreadId,
    cwd: process.cwd(),
    rollbackTurns: plan.trim.rollbackTurns,
    expectedTurns: expectedCodexAppServerTurns(plan),
    command,
  });

  return {
    status: 'preflight-ready',
    reason: 'rollback_not_sent',
    plan,
    preflight,
  };
}

function validateCodexAction(parsed, plan, action) {
  if (parsed.host !== CODEX_HOST) {
    return {
      status: `${action}-refused`,
      reason: `${action}_requires_codex_host`,
      plan,
    };
  }

  if (!parsed.codexThreadId) {
    return {
      status: `${action}-refused`,
      reason: 'codex_thread_id_required',
      plan,
    };
  }

  if (plan.status === 'unavailable') {
    return {
      status: `${action}-refused`,
      reason: plan.reason,
      plan,
    };
  }

  if (plan.trim.rollbackTurns < 1) {
    return {
      status: `${action}-noop`,
      reason: 'nothing_to_trim',
      plan,
    };
  }

  return null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hasInjectableMemory(memoryPreview) {
  const text = memoryPreview?.text;
  return (
    memoryPreview?.stats?.source === 'throughline-db' &&
    typeof text === 'string' &&
    text.trim().length > 0 &&
    text !== '(no captured memory available)'
  );
}

function expectedCodexAppServerTurns(plan) {
  return plan?.trim?.source === 'codex-rollout' ? plan.trim.capturedTurns : null;
}

function renderTrimActionReport(result) {
  const lines = [];
  lines.push(result.status.startsWith('execute-') ? '## Throughline Trim Execute' : '## Throughline Trim Preflight');
  lines.push('');
  lines.push(`Status: ${result.status}`);
  if (result.reason) lines.push(`Reason: ${result.reason}`);
  if (result.requiredEnv) lines.push(`Required env: ${result.requiredEnv}`);
  if (result.durableVerification) {
    lines.push(`Live mutation sent: ${result.durableVerification.liveMutationSent ? 'yes' : 'no'}`);
    lines.push(`Durable verified: ${result.durableVerification.durableVerified ? 'yes' : 'no'}`);
    lines.push(`Post-inject visibility: ${result.durableVerification.postInjectVisibilityStatus}`);
    lines.push(`Restore safety: ${result.durableVerification.restoreSafetyStatus}`);
    if (result.durableVerification.rolloutPath) {
      lines.push(`Durable rollout: ${result.durableVerification.rolloutPath}`);
      lines.push(`Rollout checked: ${result.durableVerification.rolloutChecked ? 'yes' : 'no'}`);
      lines.push(`New rollback marker observed: ${result.durableVerification.observedNewRollbackEvent ? 'yes' : 'no'}`);
      lines.push(`Injected memory observed in rollout: ${result.durableVerification.observedInjectedMemory ? 'yes' : 'no'}`);
    }
    for (const reason of result.durableVerification.reasons ?? []) {
      lines.push(`Durable verification reason: ${reason}`);
    }
  }

  if (result.preflight) {
    lines.push('');
    lines.push(`Codex thread: ${result.preflight.threadId}`);
    lines.push(`Read turns: ${result.preflight.readTurns ?? 'unknown'}`);
    lines.push(`Resumed turns: ${result.preflight.resumedTurns ?? 'unknown'}`);
    if (result.preflight.turnCountCheck) {
      lines.push(`Turn count check: ${result.preflight.turnCountCheck.status}`);
      lines.push(`Expected turns: ${result.preflight.turnCountCheck.expectedTurns ?? 'unchecked'}`);
    }
    lines.push(`Rollback sent: ${result.preflight.rollbackSent ? 'yes' : 'no'}`);
    lines.push(`Inject sent: ${result.preflight.injectSent ? 'yes' : 'no'}`);
    lines.push(...renderTrimMemoryContractLines(result.plan?.memoryPreview?.stats, { planned: true }));
    lines.push(...renderRestoreSafetyLines(result.plan?.trim?.restoreSafety));
    lines.push(...renderPlannedRollbackRestoreSafetyLines(result.plan?.trim?.plannedRollbackRestoreSafety));
    lines.push(`Rollback candidate turns: ${result.plan.trim.rollbackTurns}`);
  }

  if (result.execution) {
    lines.push('');
    lines.push(`Codex thread: ${result.execution.threadId}`);
    lines.push(`Read turns: ${result.execution.readTurns ?? 'unknown'}`);
    lines.push(`Resumed turns: ${result.execution.resumedTurns ?? 'unknown'}`);
    if (result.execution.turnCountCheck) {
      lines.push(`Turn count check: ${result.execution.turnCountCheck.status}`);
      lines.push(`Expected turns: ${result.execution.turnCountCheck.expectedTurns ?? 'unchecked'}`);
    }
    lines.push(`Rollback sent: ${result.execution.rollbackSent ? 'yes' : 'no'}`);
    lines.push(`Inject sent: ${result.execution.injectSent ? 'yes' : 'no'}`);
    lines.push(`Injected items: ${result.execution.injectedItems}`);
    lines.push(...renderTrimMemoryContractLines(result.plan?.memoryPreview?.stats, { planned: false }));
    lines.push(...renderRestoreSafetyLines(result.plan?.trim?.restoreSafety));
    lines.push(...renderPlannedRollbackRestoreSafetyLines(result.plan?.trim?.plannedRollbackRestoreSafety));
    lines.push(`Rollback candidate turns: ${result.plan.trim.rollbackTurns}`);
  }

  if (result.hostPrimitiveAudit) {
    const hasNonResurrectionPrimitive =
      result.hostPrimitiveAudit.facts?.hasCurrentThreadNonResurrectionPrimitive ??
      result.hostPrimitiveAudit.facts?.hasCurrentThreadRemediationPrimitive;
    lines.push('');
    lines.push(`Host primitive audit: ${result.hostPrimitiveAudit.status}`);
    lines.push(`Host primitive audit reason: ${result.hostPrimitiveAudit.reason}`);
    lines.push(
      `Current-thread non-resurrection primitive: ${
        hasNonResurrectionPrimitive ? 'yes' : 'no'
      }`,
    );
    if (result.hostPrimitiveAudit.repairContract) {
      lines.push(`Same-thread repair contract: ${result.hostPrimitiveAudit.repairContract.status}`);
    }
  }

  return lines.join('\n');
}

function renderRestoreSafetyLines(restoreSafety) {
  if (!restoreSafety) return [];
  const lines = [];
  lines.push(`Restore safety: ${restoreSafety.status}`);
  lines.push(`Compacted rows: ${restoreSafety.compactedRows}`);
  lines.push(
    `Rollback text retained in compacted history: ${restoreSafety.rollbackTextRetainedInCompacted}`,
  );
  lines.push(`Resurrected user messages after rollback: ${restoreSafety.resurrectedUserMessages}`);
  for (const risk of restoreSafety.risks ?? []) {
    lines.push(`Restore safety risk: ${risk.type} (${risk.count})`);
  }
  return lines;
}

function renderPlannedRollbackRestoreSafetyLines(plannedSafety) {
  if (!plannedSafety) return [];
  const lines = [];
  lines.push(`Planned rollback restore safety: ${plannedSafety.status}`);
  lines.push(
    `Planned rollback text retained in compacted history: ${plannedSafety.rollbackTextRetainedInCompacted}`,
  );
  for (const risk of plannedSafety.risks ?? []) {
    lines.push(`Planned rollback restore safety risk: ${risk.type} (${risk.count})`);
  }
  return lines;
}

function renderTrimMemoryContractLines(stats, { planned }) {
  if (!stats) return [];

  const lines = [];
  const sourceLabel = planned ? 'Planned memory source' : 'Injected memory source';
  lines.push(`${sourceLabel}: ${stats.source ?? 'unknown'}`);

  if (stats.source !== 'throughline-db') return lines;

  const recentBodies =
    typeof stats.recentBodies === 'number'
      ? `${stats.recentBodies} rows (latest ${stats.recentTurnLimit ?? DEFAULT_TRIM_KEEP_RECENT} turns)`
      : 'unknown';
  lines.push('Memory contract: older L1 + latest 20 L2 full bodies + L3 references only');
  lines.push(`Recent L2 bodies: ${recentBodies}`);
  lines.push(`L3 bodies injected: no (references only: ${stats.l3References ?? 0})`);
  return lines;
}
