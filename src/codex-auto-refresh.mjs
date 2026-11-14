import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { foldPathCaseForPlatform } from './os/paths.mjs';
import { join, resolve } from 'node:path';

import { runCodexTrimExecution } from './codex-app-server.mjs';
import { buildCodexRolloutTrimSource } from './codex-rollout-memory.mjs';
import { buildTrimPlan } from './trim-model.mjs';
import { dataRoot } from './storage-roots.mjs';

export const CODEX_AUTO_REFRESH_THRESHOLD = 0.75;
export const CODEX_AUTO_REFRESH_USAGE_EPOCH_PERCENT = 5;
export const CODEX_AUTO_REFRESH_STATE_VERSION = 1;

const MAX_AUTO_REFRESH_STATE_ENTRIES = 50;

export function evaluateCodexAutoRefreshUsage(usage, { threshold = CODEX_AUTO_REFRESH_THRESHOLD } = {}) {
  if (!usage) {
    return {
      shouldRefresh: false,
      reason: 'usage_unavailable',
      threshold,
      ratio: null,
    };
  }

  if (usage.estimated) {
    return {
      shouldRefresh: false,
      reason: 'estimated_usage_not_allowed',
      threshold,
      ratio: null,
    };
  }

  if (usage.contextWindowEstimated) {
    return {
      shouldRefresh: false,
      reason: 'estimated_context_window_not_allowed',
      threshold,
      ratio: null,
    };
  }

  const tokens = Number(usage.tokens);
  const contextWindowSize = Number(usage.contextWindowSize);
  if (!Number.isFinite(tokens) || tokens < 0) {
    return {
      shouldRefresh: false,
      reason: 'invalid_usage_tokens',
      threshold,
      ratio: null,
    };
  }
  if (!Number.isFinite(contextWindowSize) || contextWindowSize <= 0) {
    return {
      shouldRefresh: false,
      reason: 'invalid_context_window',
      threshold,
      ratio: null,
    };
  }

  const ratio = tokens / contextWindowSize;
  return {
    shouldRefresh: ratio >= threshold,
    reason: ratio >= threshold ? 'threshold_reached' : 'below_threshold',
    threshold,
    ratio,
    tokens,
    contextWindowSize,
  };
}

export async function runCodexAutoRefresh({
  db,
  threadId,
  codexThreadIdSource = null,
  codexHome = undefined,
  projectPath = process.cwd(),
  sessionId = null,
  usage = null,
  threshold = CODEX_AUTO_REFRESH_THRESHOLD,
  command = process.env.THROUGHLINE_CODEX_APP_SERVER_BIN ?? 'codex',
  autoRefreshStateStore = null,
  enabled = false,
  deps = {},
} = {}) {
  if (!db) throw new Error('runCodexAutoRefresh: db is required');
  if (typeof threadId !== 'string' || threadId.length === 0) {
    throw new Error('runCodexAutoRefresh: threadId is required');
  }
  if (typeof projectPath !== 'string' || projectPath.length === 0) {
    throw new Error('runCodexAutoRefresh: projectPath is required');
  }

  if (!enabled) {
    return {
      status: 'skipped',
      reason: 'codex_auto_refresh_disabled',
    };
  }

  const decision = evaluateCodexAutoRefreshUsage(usage, { threshold });
  if (!decision.shouldRefresh) {
    return {
      status: 'skipped',
      reason: decision.reason,
      decision,
    };
  }

  const buildTrimSource = deps.buildTrimSource ?? buildCodexRolloutTrimSource;
  const buildPlan = deps.buildTrimPlan ?? buildTrimPlan;
  const executeTrim = deps.runTrimExecution ?? runCodexTrimExecution;
  const trimSource = buildTrimSource({
    threadId,
    codexHome,
    projectPath,
    sourceReason:
      codexThreadIdSource && codexThreadIdSource.startsWith('payload:')
        ? 'payload_codex_thread_rollout'
        : 'auto_refresh_codex_thread_rollout',
  });
  if (!trimSource) {
    return {
      status: 'skipped',
      reason: 'codex_rollout_unavailable',
      decision,
    };
  }

  const plan = buildPlan(db, {
    sessionId: sessionId ?? `codex:${threadId}`,
    projectPath,
    host: 'codex',
    trimAll: true,
    codexThreadId: threadId,
    codexThreadIdSource,
    trimSource,
  });

  const rolloutState = buildCodexAutoRefreshRolloutState({ trimSource, plan });
  const fingerprint = buildCodexAutoRefreshFingerprint({
    threadId,
    projectPath,
    usage,
    rolloutState,
  });
  const backoff = checkCodexAutoRefreshBackoff({
    autoRefreshStateStore,
    threadId,
    fingerprint,
    family: 'execute',
    suppressFamilies: ['execute'],
    rolloutState,
  });
  if (backoff.shouldBackoff) {
    return {
      status: 'skipped',
      reason: 'auto_refresh_backoff',
      decision,
      plan,
      backoff,
    };
  }

  if (plan.status === 'unavailable') {
    return recordCodexAutoRefreshResult({
      autoRefreshStateStore,
      threadId,
      fingerprint,
      family: 'execute',
      rolloutState,
      result: {
        status: 'skipped',
        reason: plan.reason,
        decision,
        plan,
      },
    });
  }
  if (plan.trim.rollbackTurns < 1) {
    return recordCodexAutoRefreshResult({
      autoRefreshStateStore,
      threadId,
      fingerprint,
      family: 'execute',
      rolloutState,
      result: {
        status: 'skipped',
        reason: 'nothing_to_trim',
        decision,
        plan,
      },
    });
  }
  if (!hasInjectableMemory(plan.memoryPreview)) {
    return recordCodexAutoRefreshResult({
      autoRefreshStateStore,
      threadId,
      fingerprint,
      family: 'execute',
      rolloutState,
      result: {
        status: 'skipped',
        reason: 'injectable_memory_required',
        decision,
        plan,
      },
    });
  }

  recordCodexAutoRefreshOutcome({
    autoRefreshStateStore,
    threadId,
    fingerprint,
    family: 'execute',
    outcome: {
      status: 'started',
      reason: 'threshold_reached',
    },
    rolloutState,
  });

  const execution = await executeTrim({
    threadId,
    cwd: projectPath,
    rollbackTurns: plan.trim.rollbackTurns,
    memoryText: plan.memoryPreview.text,
    expectedTurns: plan.trim.source === 'codex-rollout' ? plan.trim.capturedTurns : null,
    command,
  });
  if (execution.status === 'refused') {
    return recordCodexAutoRefreshResult({
      autoRefreshStateStore,
      threadId,
      fingerprint,
      family: 'execute',
      rolloutState,
      result: {
        status: 'refused',
        reason: execution.reason,
        decision,
        plan,
        execution,
      },
    });
  }

  const postInjectVisibilityStatus = execution.postInjectVisibilityCheck?.status ?? 'unchecked';
  if (postInjectVisibilityStatus !== 'match') {
    return recordCodexAutoRefreshResult({
      autoRefreshStateStore,
      threadId,
      fingerprint,
      family: 'execute',
      rolloutState,
      quietThreadUntilNewUserTurn: Boolean(execution.rollbackSent || execution.injectSent),
      result: {
        status: 'unverified',
        reason: execution.postInjectVisibilityCheck?.reason ?? 'post_inject_visibility_unverified',
        decision,
        plan,
        execution,
      },
    });
  }

  return recordCodexAutoRefreshResult({
    autoRefreshStateStore,
    threadId,
    fingerprint,
    family: 'execute',
    rolloutState,
    quietThreadUntilNewUserTurn: Boolean(execution.rollbackSent || execution.injectSent),
    result: {
      status: 'refreshed-live',
      reason: 'rollback_and_inject_sent_live',
      decision,
      plan,
      execution,
    },
  });
}

export function buildCodexAutoRefreshRolloutState({ captured = null, trimSource = null, plan = null } = {}) {
  const stats = trimSource?.stats ?? plan?.trim?.rolloutStats ?? captured?.stats ?? {};
  return {
    rolloutPath: plan?.trim?.rolloutPath ?? trimSource?.rolloutPath ?? captured?.rolloutPath ?? null,
    capturedTurns: numberOrNull(plan?.trim?.capturedTurns ?? trimSource?.capturedTurns ?? captured?.capturedTurns),
    rollbackTurns: numberOrNull(plan?.trim?.rollbackTurns),
    capturedRows: numberOrNull(captured?.capturedRows),
    capturedDetails: numberOrNull(captured?.capturedDetails),
    rollbackEvents: numberOrNull(stats?.rollbackEvents),
    rolledBackTurns: numberOrNull(stats?.rolledBackTurns),
    injectedDeveloperMessages: numberOrNull(stats?.injectedDeveloperMessages),
    userMessagesAfterRollback: numberOrNull(stats?.userMessagesAfterRollback),
  };
}

export function buildCodexAutoRefreshFingerprint({
  threadId,
  projectPath,
  usage,
  rolloutState,
} = {}) {
  return JSON.stringify({
    version: CODEX_AUTO_REFRESH_STATE_VERSION,
    threadId: typeof threadId === 'string' ? threadId : null,
    projectPath: normalizeProjectPath(projectPath),
    usageEpochPercent: usageEpochPercent(usage),
    contextWindowSize: numberOrNull(usage?.contextWindowSize),
    usageEstimated: Boolean(usage?.estimated),
    contextWindowEstimated: Boolean(usage?.contextWindowEstimated),
    usageSource: typeof usage?.source === 'string' ? usage.source : null,
    rolloutPath: rolloutState?.rolloutPath ?? null,
    capturedTurns: numberOrNull(rolloutState?.capturedTurns),
    rollbackTurns: numberOrNull(rolloutState?.rollbackTurns),
    rollbackEvents: numberOrNull(rolloutState?.rollbackEvents),
    rolledBackTurns: numberOrNull(rolloutState?.rolledBackTurns),
    injectedDeveloperMessages: numberOrNull(rolloutState?.injectedDeveloperMessages),
    userMessagesAfterRollback: numberOrNull(rolloutState?.userMessagesAfterRollback),
  });
}

export function checkCodexAutoRefreshBackoff({
  autoRefreshStateStore,
  threadId,
  fingerprint,
  family,
  suppressFamilies = [family],
  rolloutState = null,
} = {}) {
  if (!autoRefreshStateStore) {
    return { shouldBackoff: false, reason: 'state_store_unavailable' };
  }

  const state = normalizeAutoRefreshState(autoRefreshStateStore.read(threadId), threadId);
  const quiet = state.threadQuiet;
  if (
    quiet?.family === 'execute' &&
    suppressFamilies.includes('execute') &&
    shouldSuppressForThreadQuiet(quiet, rolloutState)
  ) {
    return {
      shouldBackoff: true,
      reason: 'thread_quiet_until_new_user_turn',
      family,
      suppressFamilies,
      entry: quiet,
    };
  }

  const entry = state.entries.find(
    (candidate) => suppressFamilies.includes(candidate.family) && candidate.fingerprint === fingerprint,
  );
  if (entry) {
    return {
      shouldBackoff: true,
      reason: 'matching_refresh_state',
      family,
      suppressFamilies,
      entry,
    };
  }

  return {
    shouldBackoff: false,
    reason: 'no_matching_refresh_state',
    family,
    suppressFamilies,
  };
}

export function recordCodexAutoRefreshOutcome({
  autoRefreshStateStore,
  threadId,
  fingerprint,
  family,
  outcome,
  rolloutState = null,
  quietThreadUntilNewUserTurn = false,
} = {}) {
  if (!autoRefreshStateStore) return null;

  const state = normalizeAutoRefreshState(autoRefreshStateStore.read(threadId), threadId);
  const entry = {
    family,
    fingerprint,
    outcomeStatus: outcome?.status ?? null,
    outcomeReason: outcome?.reason ?? null,
    recordedAt: Date.now(),
    rolloutState,
  };
  state.entries = [
    entry,
    ...state.entries.filter(
      (candidate) => candidate.family !== family || candidate.fingerprint !== fingerprint,
    ),
  ].slice(0, MAX_AUTO_REFRESH_STATE_ENTRIES);

  if (quietThreadUntilNewUserTurn) {
    state.threadQuiet = {
      family,
      reason: 'refresh_sent_quiet_until_new_user_turn',
      outcomeStatus: outcome?.status ?? null,
      outcomeReason: outcome?.reason ?? null,
      recordedAt: entry.recordedAt,
      userMessagesAfterRollback: numberOrNull(rolloutState?.userMessagesAfterRollback),
      rollbackEvents: numberOrNull(rolloutState?.rollbackEvents),
      injectedDeveloperMessages: numberOrNull(rolloutState?.injectedDeveloperMessages),
    };
  }

  autoRefreshStateStore.write(threadId, state);
  return entry;
}

export function createFileCodexAutoRefreshStateStore({
  dir = join(dataRoot(), 'codex-auto-refresh'),
} = {}) {
  return {
    read(threadId) {
      const file = codexAutoRefreshStatePath(dir, threadId);
      if (!existsSync(file)) return null;
      return JSON.parse(readFileSync(file, 'utf8'));
    },
    write(threadId, state) {
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(codexAutoRefreshStatePath(dir, threadId), JSON.stringify(state));
    },
  };
}

function recordCodexAutoRefreshResult({
  autoRefreshStateStore,
  threadId,
  fingerprint,
  family,
  rolloutState,
  quietThreadUntilNewUserTurn = false,
  result,
}) {
  recordCodexAutoRefreshOutcome({
    autoRefreshStateStore,
    threadId,
    fingerprint,
    family,
    outcome: result,
    rolloutState,
    quietThreadUntilNewUserTurn,
  });
  return result;
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

function normalizeAutoRefreshState(value, threadId) {
  if (!value || typeof value !== 'object') {
    return {
      version: CODEX_AUTO_REFRESH_STATE_VERSION,
      threadId,
      entries: [],
      threadQuiet: null,
    };
  }
  return {
    version: CODEX_AUTO_REFRESH_STATE_VERSION,
    threadId: typeof value.threadId === 'string' ? value.threadId : threadId,
    entries: Array.isArray(value.entries) ? value.entries.filter(isRefreshStateEntry) : [],
    threadQuiet: value.threadQuiet && typeof value.threadQuiet === 'object' ? value.threadQuiet : null,
  };
}

function isRefreshStateEntry(entry) {
  return (
    entry &&
    typeof entry === 'object' &&
    typeof entry.family === 'string' &&
    typeof entry.fingerprint === 'string'
  );
}

function shouldSuppressForThreadQuiet(quiet, rolloutState) {
  const quietUserMessages = numberOrNull(quiet?.userMessagesAfterRollback);
  const currentUserMessages = numberOrNull(rolloutState?.userMessagesAfterRollback);
  if (quietUserMessages === null || currentUserMessages === null) return false;
  return currentUserMessages <= quietUserMessages;
}

function usageEpochPercent(usage) {
  const tokens = Number(usage?.tokens);
  const contextWindowSize = Number(usage?.contextWindowSize);
  if (!Number.isFinite(tokens) || !Number.isFinite(contextWindowSize) || contextWindowSize <= 0) {
    return null;
  }
  const percent = (tokens / contextWindowSize) * 100;
  return Math.floor(percent / CODEX_AUTO_REFRESH_USAGE_EPOCH_PERCENT) * CODEX_AUTO_REFRESH_USAGE_EPOCH_PERCENT;
}

function normalizeProjectPath(value) {
  if (typeof value !== 'string' || value.length === 0) return '';
  let result = resolve(value).replace(/\\/g, '/');
  if (result.length > 1 && result.endsWith('/')) result = result.slice(0, -1);
  return foldPathCaseForPlatform(result);
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function codexAutoRefreshStatePath(dir, threadId) {
  if (typeof threadId !== 'string' || threadId.length === 0) {
    throw new Error('codex auto-refresh state requires threadId');
  }
  return join(dir, `${encodeURIComponent(threadId)}.json`);
}
