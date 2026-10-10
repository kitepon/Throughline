import { spawnPortable as spawn } from './os/portable-spawn-sync.mjs';
import { randomUUID } from 'node:crypto';

export const CODEX_APP_SERVER_METHODS = Object.freeze({
  initialize: 'initialize',
  initialized: 'initialized',
  threadStart: 'thread/start',
  threadRead: 'thread/read',
  threadResume: 'thread/resume',
  threadTurnsList: 'thread/turns/list',
  threadRollback: 'thread/rollback',
  threadInjectItems: 'thread/inject_items',
  turnStart: 'turn/start',
});

const MAX_APP_SERVER_STDERR_CHARS = 4000;

export function encodeAppServerMessage(message) {
  if (!isRecord(message)) {
    throw new Error('encodeAppServerMessage: message must be an object');
  }
  return `${JSON.stringify(message)}\n`;
}

export function parseAppServerLine(line) {
  if (typeof line !== 'string') {
    throw new Error('parseAppServerLine: line must be a string');
  }

  const trimmed = line.trim();
  if (!trimmed) {
    throw new Error('parseAppServerLine: line must not be empty');
  }

  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown';
    throw new Error(`parseAppServerLine: invalid JSON: ${msg}`);
  }

  if (!isRecord(parsed)) {
    throw new Error('parseAppServerLine: decoded message must be an object');
  }

  if ('error' in parsed && 'id' in parsed) {
    if (!isRequestId(parsed.id) || !isRecord(parsed.error)) {
      throw new Error('parseAppServerLine: invalid error response');
    }
    const { code, message, data } = parsed.error;
    if (typeof code !== 'number' || typeof message !== 'string') {
      throw new Error('parseAppServerLine: invalid error response');
    }
    return {
      kind: 'error',
      id: parsed.id,
      error: { code, message, data },
    };
  }

  if ('result' in parsed && 'id' in parsed) {
    if (!isRequestId(parsed.id)) {
      throw new Error('parseAppServerLine: invalid response id');
    }
    return {
      kind: 'response',
      id: parsed.id,
      result: parsed.result,
    };
  }

  if (typeof parsed.method === 'string') {
    if ('id' in parsed) {
      if (!isRequestId(parsed.id)) {
        throw new Error('parseAppServerLine: invalid server request id');
      }
      return {
        kind: 'request',
        id: parsed.id,
        method: parsed.method,
        params: parsed.params,
      };
    }
    return {
      kind: 'notification',
      method: parsed.method,
      params: parsed.params,
    };
  }

  throw new Error('parseAppServerLine: unrecognized message shape');
}

export function buildInitializeRequest({
  id,
  clientName = 'throughline',
  clientTitle = 'Throughline',
  version = '0.0.0',
  optOutNotificationMethods = [],
}) {
  assertRequestId(id, 'buildInitializeRequest');
  if (!Array.isArray(optOutNotificationMethods)) {
    throw new Error('buildInitializeRequest: optOutNotificationMethods must be an array');
  }
  return {
    id,
    method: CODEX_APP_SERVER_METHODS.initialize,
    params: {
      clientInfo: {
        name: clientName,
        title: clientTitle,
        version,
      },
      capabilities: {
        experimentalApi: true,
        optOutNotificationMethods,
      },
    },
  };
}

export function buildInitializedNotification() {
  return {
    method: CODEX_APP_SERVER_METHODS.initialized,
  };
}

export function buildThreadStartRequest({
  id,
  cwd,
  approvalPolicy = null,
  sandbox = null,
  model = null,
  sessionStartSource = 'clear',
}) {
  assertRequestId(id, 'buildThreadStartRequest');
  assertNonEmptyString(cwd, 'buildThreadStartRequest: cwd');
  if (sessionStartSource !== 'startup' && sessionStartSource !== 'clear') {
    throw new Error('buildThreadStartRequest: sessionStartSource must be startup or clear');
  }
  return {
    id,
    method: CODEX_APP_SERVER_METHODS.threadStart,
    params: compactNullish({
      cwd,
      approvalPolicy,
      sandbox,
      model,
      sessionStartSource,
    }),
  };
}

export function buildThreadReadRequest({ id, threadId, includeTurns = true }) {
  assertRequestId(id, 'buildThreadReadRequest');
  assertNonEmptyString(threadId, 'buildThreadReadRequest: threadId');
  return {
    id,
    method: CODEX_APP_SERVER_METHODS.threadRead,
    params: {
      threadId,
      includeTurns: Boolean(includeTurns),
    },
  };
}

export function buildThreadResumeRequest({
  id,
  threadId,
  cwd,
  approvalPolicy = null,
  sandbox = null,
  model = null,
  excludeTurns = false,
}) {
  assertRequestId(id, 'buildThreadResumeRequest');
  assertNonEmptyString(threadId, 'buildThreadResumeRequest: threadId');
  return compactNullish({
    id,
    method: CODEX_APP_SERVER_METHODS.threadResume,
    params: compactNullish({
      threadId,
      cwd,
      approvalPolicy,
      sandbox,
      model,
      excludeTurns: Boolean(excludeTurns),
    }),
  });
}

export function buildThreadTurnsListRequest({
  id,
  threadId,
  cursor = null,
  limit = null,
  sortDirection = 'asc',
}) {
  assertRequestId(id, 'buildThreadTurnsListRequest');
  assertNonEmptyString(threadId, 'buildThreadTurnsListRequest: threadId');
  if (cursor !== null && cursor !== undefined) {
    assertNonEmptyString(cursor, 'buildThreadTurnsListRequest: cursor');
  }
  if (limit !== null && limit !== undefined) {
    assertPositiveInteger(limit, 'buildThreadTurnsListRequest: limit');
  }
  if (sortDirection !== null && sortDirection !== undefined && sortDirection !== 'asc' && sortDirection !== 'desc') {
    throw new Error('buildThreadTurnsListRequest: sortDirection must be asc or desc');
  }
  return {
    id,
    method: CODEX_APP_SERVER_METHODS.threadTurnsList,
    params: compactNullish({
      threadId,
      cursor,
      limit,
      sortDirection,
    }),
  };
}

export function buildThreadRollbackRequest({ id, threadId, numTurns }) {
  assertRequestId(id, 'buildThreadRollbackRequest');
  assertNonEmptyString(threadId, 'buildThreadRollbackRequest: threadId');
  if (!Number.isInteger(numTurns) || numTurns < 1) {
    throw new Error('buildThreadRollbackRequest: numTurns must be an integer >= 1');
  }
  return {
    id,
    method: CODEX_APP_SERVER_METHODS.threadRollback,
    params: {
      threadId,
      numTurns,
    },
  };
}

export function resolveRollbackTurnsForAppServer({
  plannedRollbackTurns,
  expectedTurns = null,
  readTurns = null,
  resumedTurns = null,
} = {}) {
  if (!Number.isInteger(plannedRollbackTurns) || plannedRollbackTurns < 1) {
    throw new Error('resolveRollbackTurnsForAppServer: plannedRollbackTurns must be an integer >= 1');
  }
  assertOptionalTurnCount(expectedTurns, 'resolveRollbackTurnsForAppServer: expectedTurns');

  const result = {
    plannedRollbackTurns,
    requestedRollbackTurns: plannedRollbackTurns,
    adjustment: 0,
    basis: 'planned',
    reason: 'using_planned_rollback_turns',
  };

  if (
    Number.isInteger(expectedTurns) &&
    Number.isInteger(readTurns) &&
    Number.isInteger(resumedTurns) &&
    readTurns === resumedTurns &&
    readTurns !== expectedTurns
  ) {
    const adjustment = readTurns - expectedTurns;
    const adjustedTurns = plannedRollbackTurns + adjustment;
    if (adjustedTurns >= 1) {
      return {
        plannedRollbackTurns,
        requestedRollbackTurns: Math.min(adjustedTurns, readTurns),
        adjustment,
        basis: 'app_server_turn_count',
        reason: 'adjusted_by_app_server_turn_delta',
      };
    }
  }

  return result;
}

export function buildThreadInjectItemsRequest({ id, threadId, items }) {
  assertRequestId(id, 'buildThreadInjectItemsRequest');
  assertNonEmptyString(threadId, 'buildThreadInjectItemsRequest: threadId');
  if (!Array.isArray(items)) {
    throw new Error('buildThreadInjectItemsRequest: items must be an array');
  }
  return {
    id,
    method: CODEX_APP_SERVER_METHODS.threadInjectItems,
    params: {
      threadId,
      items,
    },
  };
}

export function buildTurnStartRequest({ id, threadId, text }) {
  assertRequestId(id, 'buildTurnStartRequest');
  assertNonEmptyString(threadId, 'buildTurnStartRequest: threadId');
  assertNonEmptyString(text, 'buildTurnStartRequest: text');
  return {
    id,
    method: CODEX_APP_SERVER_METHODS.turnStart,
    params: {
      threadId,
      input: [buildTextInputItem(text)],
    },
  };
}

export function buildTextInputItem(text) {
  assertNonEmptyString(text, 'buildTextInputItem: text');
  return {
    type: 'text',
    text,
    text_elements: [],
  };
}

export function buildDeveloperMessageItem(text) {
  assertNonEmptyString(text, 'buildDeveloperMessageItem: text');
  return {
    type: 'message',
    role: 'developer',
    content: [{ type: 'input_text', text }],
  };
}

export async function runCodexTrimPreflight({
  threadId,
  cwd,
  rollbackTurns,
  expectedTurns = null,
  command = 'codex',
  commandArgs = ['app-server', '--listen', 'stdio://'],
  timeoutMs = 30_000,
  requestTimeoutMs = 10_000,
} = {}) {
  assertNonEmptyString(threadId, 'runCodexTrimPreflight: threadId');
  assertNonEmptyString(cwd, 'runCodexTrimPreflight: cwd');
  assertNonEmptyString(command, 'runCodexTrimPreflight: command');
  if (!Number.isInteger(rollbackTurns) || rollbackTurns < 1) {
    throw new Error('runCodexTrimPreflight: rollbackTurns must be an integer >= 1');
  }
  assertOptionalTurnCount(expectedTurns, 'runCodexTrimPreflight: expectedTurns');
  if (!Array.isArray(commandArgs)) {
    throw new Error('runCodexTrimPreflight: commandArgs must be an array');
  }

  const client = startAppServerClient({
    command,
    args: commandArgs,
    cwd,
    timeoutMs,
    requestTimeoutMs,
  });

  try {
    await client.request(
      buildInitializeRequest({
        id: randomUUID(),
        clientName: 'throughline-trim',
        clientTitle: 'Throughline Trim',
      }),
    );
    client.notify(buildInitializedNotification());

    const beforeRead = await client.request(
      buildThreadReadRequest({
        id: randomUUID(),
        threadId,
        includeTurns: true,
      }),
    );
    const resumed = await client.request(
      buildThreadResumeRequest({
        id: randomUUID(),
        threadId,
        cwd,
        excludeTurns: false,
      }),
    );
    const readTurns = countTurns(beforeRead);
    const resumedTurns = countTurns(resumed);
    const rollbackResolution = resolveRollbackTurnsForAppServer({
      plannedRollbackTurns: rollbackTurns,
      expectedTurns,
      readTurns,
      resumedTurns,
    });

    return {
      status: 'preflight-ready',
      threadId,
      rollbackSent: false,
      injectSent: false,
      readTurns,
      resumedTurns,
      rollbackRequestedTurns: rollbackResolution.requestedRollbackTurns,
      rollbackResolution,
      turnCountCheck: compareTurnCounts({
        expectedTurns,
        readTurns,
        resumedTurns,
      }),
      rollbackRequestPreview: buildThreadRollbackRequest({
        id: 'rollback-preview',
        threadId,
        numTurns: rollbackResolution.requestedRollbackTurns,
      }),
      notifications: [...new Set(client.notifications)],
      stderr: client.stderr,
    };
  } finally {
    await client.close();
  }
}

export async function runCodexThreadRestoreSmoke({
  threadId,
  cwd,
  expectedTurns = null,
  restoreTextNeedles = [],
  command = 'codex',
  commandArgs = ['app-server', '--listen', 'stdio://'],
  timeoutMs = 30_000,
  requestTimeoutMs = 10_000,
  cycles = 2,
  turnsListLimit = 200,
  maxTurnsListPages = 50,
} = {}) {
  assertNonEmptyString(threadId, 'runCodexThreadRestoreSmoke: threadId');
  assertNonEmptyString(cwd, 'runCodexThreadRestoreSmoke: cwd');
  assertNonEmptyString(command, 'runCodexThreadRestoreSmoke: command');
  assertOptionalTurnCount(expectedTurns, 'runCodexThreadRestoreSmoke: expectedTurns');
  assertRestoreTextNeedles(restoreTextNeedles, 'runCodexThreadRestoreSmoke: restoreTextNeedles');
  if (!Array.isArray(commandArgs)) {
    throw new Error('runCodexThreadRestoreSmoke: commandArgs must be an array');
  }
  assertPositiveInteger(cycles, 'runCodexThreadRestoreSmoke: cycles');
  assertPositiveInteger(turnsListLimit, 'runCodexThreadRestoreSmoke: turnsListLimit');
  assertPositiveInteger(maxTurnsListPages, 'runCodexThreadRestoreSmoke: maxTurnsListPages');

  const observations = [];
  for (let cycle = 1; cycle <= cycles; cycle++) {
    observations.push(
      await readCodexThreadWithFreshAppServer({
        cycle,
        threadId,
        cwd,
        expectedTurns,
        restoreTextNeedles,
        command,
        commandArgs,
        timeoutMs,
        requestTimeoutMs,
        turnsListLimit,
        maxTurnsListPages,
      }),
    );
  }

  const baseline = observations[0] ?? null;
  const stableAcrossCycles =
    Boolean(baseline) &&
    observations.every(
      (observation) =>
        observation.readTurns === baseline.readTurns &&
        observation.resumedTurns === baseline.resumedTurns &&
        observation.turnsListTurns === baseline.turnsListTurns &&
        observation.turnsListComplete === baseline.turnsListComplete,
    );
  const turnCountsMatchExpected = observations.every(
    (observation) => observation.turnCountCheck.status === 'match',
  );
  const turnCountsKnown = observations.every(
    (observation) =>
      Number.isInteger(observation.readTurns) &&
      Number.isInteger(observation.resumedTurns) &&
      Number.isInteger(observation.turnsListTurns) &&
      observation.turnsListComplete === true,
  );
  const restoreTextMatchCheck = summarizeAppServerRestoreTextMatches(observations);
  const status =
    restoreTextMatchCheck.status === 'matches-found' &&
    restoreTextMatchCheck.hasBlockingCandidates === true
      ? 'app-server-restore-text-retained'
      : restoreTextMatchCheck.status === 'matches-found'
      ? 'app-server-restore-text-quoted'
      : stableAcrossCycles && (expectedTurns === null || expectedTurns === undefined
      ? turnCountsKnown
      : turnCountsMatchExpected)
      ? 'app-server-restart-stable'
      : 'app-server-restart-mismatch';

  return {
    status,
    reason:
      status === 'app-server-restore-text-retained'
        ? 'restore_text_seen_in_app_server_response'
        : status === 'app-server-restore-text-quoted'
        ? 'restore_text_seen_only_in_quoted_or_output_response_fields'
        : status === 'app-server-restart-stable'
        ? 'fresh_app_server_restore_counts_stable'
        : 'fresh_app_server_restore_counts_mismatch',
    proofScope: 'app_server_process_restart_only',
    restartSafe: false,
    threadId,
    expectedTurns,
    cycles,
    restoreTextNeedles: restoreTextNeedles.map(({ id, textPreview }) => ({ id, textPreview })),
    restoreTextMatchCheck,
    observations,
  };
}

export async function runCodexDeveloperMemoryInject({
  threadId,
  cwd,
  memoryText,
  command = 'codex',
  commandArgs = ['app-server', '--listen', 'stdio://'],
  timeoutMs = 30_000,
  requestTimeoutMs = 10_000,
} = {}) {
  assertNonEmptyString(threadId, 'runCodexDeveloperMemoryInject: threadId');
  assertNonEmptyString(cwd, 'runCodexDeveloperMemoryInject: cwd');
  assertNonEmptyString(memoryText, 'runCodexDeveloperMemoryInject: memoryText');
  assertNonEmptyString(command, 'runCodexDeveloperMemoryInject: command');
  if (!Array.isArray(commandArgs)) {
    throw new Error('runCodexDeveloperMemoryInject: commandArgs must be an array');
  }

  const client = startAppServerClient({
    command,
    args: commandArgs,
    cwd,
    timeoutMs,
    requestTimeoutMs,
  });

  try {
    await client.request(
      buildInitializeRequest({
        id: randomUUID(),
        clientName: 'throughline-codex-memory-inject',
        clientTitle: 'Throughline Codex Memory Inject',
      }),
    );
    client.notify(buildInitializedNotification());

    const beforeRead = await client.request(
      buildThreadReadRequest({
        id: randomUUID(),
        threadId,
        includeTurns: true,
      }),
    );
    const resumed = await client.request(
      buildThreadResumeRequest({
        id: randomUUID(),
        threadId,
        cwd,
        approvalPolicy: 'never',
        sandbox: 'read-only',
        excludeTurns: false,
      }),
    );
    const inject = await client.request(
      buildThreadInjectItemsRequest({
        id: randomUUID(),
        threadId,
        items: [buildDeveloperMessageItem(memoryText)],
      }),
    );

    return {
      status: 'injected',
      reason: 'developer_memory_injected',
      threadId,
      readTurns: countTurns(beforeRead),
      resumedTurns: countTurns(resumed),
      injectResultTurns: countTurns(inject),
      injectSent: true,
      injectedItems: 1,
      notifications: [...new Set(client.notifications)],
      stderr: client.stderr,
    };
  } finally {
    await client.close();
  }
}

async function readCodexThreadWithFreshAppServer({
  cycle,
  threadId,
  cwd,
  expectedTurns,
  restoreTextNeedles,
  command,
  commandArgs,
  timeoutMs,
  requestTimeoutMs,
  turnsListLimit,
  maxTurnsListPages,
}) {
  const client = startAppServerClient({
    command,
    args: commandArgs,
    cwd,
    timeoutMs,
    requestTimeoutMs,
  });

  try {
    await client.request(
      buildInitializeRequest({
        id: randomUUID(),
        clientName: 'throughline-codex-restore-smoke',
        clientTitle: 'Throughline Codex Restore Smoke',
      }),
    );
    client.notify(buildInitializedNotification());

    const beforeRead = await client.request(
      buildThreadReadRequest({
        id: randomUUID(),
        threadId,
        includeTurns: true,
      }),
    );
    const resumed = await client.request(
      buildThreadResumeRequest({
        id: randomUUID(),
        threadId,
        cwd,
        excludeTurns: false,
      }),
    );
    const turnsList = await listAllCodexThreadTurns({
      client,
      threadId,
      limit: turnsListLimit,
      maxPages: maxTurnsListPages,
    });
    const readTurns = countTurns(beforeRead);
    const resumedTurns = countTurns(resumed);
    const turnsListTurns = turnsList.turns.length;
    const responseTextMatches = inspectAppServerRestoreTextMatches({
      readResult: beforeRead,
      resumeResult: resumed,
      turnsListTurns: turnsList.turns,
      needles: restoreTextNeedles,
    });

    return {
      cycle,
      readTurns,
      resumedTurns,
      turnsListTurns,
      turnsListPages: turnsList.pages,
      turnsListComplete: turnsList.complete,
      turnsListNextCursor: turnsList.nextCursor,
      responseTextMatches,
      turnCountCheck: compareRestoreTurnCounts({
        expectedTurns,
        readTurns,
        resumedTurns,
        turnsListTurns,
        turnsListComplete: turnsList.complete,
      }),
      notifications: [...new Set(client.notifications)],
      stderr: client.stderr,
    };
  } finally {
    await client.close();
  }
}

function inspectAppServerRestoreTextMatches({ readResult, resumeResult, turnsListTurns, needles }) {
  if (!Array.isArray(needles) || needles.length === 0) {
    return {
      status: 'unchecked',
      reason: 'restore_text_needles_not_provided',
      sources: [],
      matchedNeedles: [],
    };
  }

  const sources = [
    { id: 'thread_read', value: readResult },
    { id: 'thread_resume', value: resumeResult },
    { id: 'thread_turns_list', value: turnsListTurns },
  ].map((source) => inspectTextMatchesInValue(source, needles));
  const matchedIds = new Set();
  for (const source of sources) {
    for (const match of source.matches) matchedIds.add(match.id);
  }
  const locations = sources.flatMap((source) =>
    (source.matches ?? []).flatMap((match) => match.locations ?? []),
  );
  const blockingKinds = [
    ...new Set(
      locations
        .filter((location) => location.blockingCandidate)
        .map((location) => location.kind),
    ),
  ];
  const nonBlockingKinds = [
    ...new Set(
      locations
        .filter((location) => !location.blockingCandidate)
        .map((location) => location.kind),
    ),
  ];
  const locationRisks = [
    ...new Set(locations.map((location) => location.risk).filter(Boolean)),
  ];

  return {
    status: matchedIds.size > 0 ? 'matches-found' : 'no-matches',
    reason:
      matchedIds.size > 0
        ? 'restore_text_seen_in_app_server_response'
        : 'restore_text_not_seen_in_app_server_response',
    hasBlockingCandidates: matchedIds.size > 0 ? blockingKinds.length > 0 : false,
    blockingKinds,
    nonBlockingKinds,
    locationRisks,
    sources,
    matchedNeedles: needles
      .filter((needle) => matchedIds.has(needle.id))
      .map(({ id, textPreview }) => ({ id, textPreview })),
  };
}

function summarizeAppServerRestoreTextMatches(observations) {
  const summaries = observations
    .map((observation) => ({
      cycle: observation.cycle,
      responseTextMatches: observation.responseTextMatches,
    }))
    .filter(({ responseTextMatches }) => Boolean(responseTextMatches));
  if (summaries.length === 0) {
    return {
      status: 'unchecked',
      reason: 'restore_text_match_observations_not_available',
      sources: [],
      matchedNeedles: [],
    };
  }

  const matchedNeedles = new Map();
  const sources = new Map();
  for (const { cycle, responseTextMatches } of summaries) {
    for (const needle of responseTextMatches.matchedNeedles ?? []) {
      if (!matchedNeedles.has(needle.id)) matchedNeedles.set(needle.id, needle);
    }
    for (const source of responseTextMatches.sources ?? []) {
      const matches = source.matches ?? [];
      if (matches.length === 0) continue;
      if (!sources.has(source.source)) {
        sources.set(source.source, {
          source: source.source,
          cycles: new Set(),
          matchedNeedleIds: new Set(),
        });
      }
      const sourceSummary = sources.get(source.source);
      sourceSummary.cycles.add(cycle);
      if (!sourceSummary.samplePaths) sourceSummary.samplePaths = new Set();
      if (!sourceSummary.locationKinds) sourceSummary.locationKinds = new Set();
      if (!sourceSummary.locationRisks) sourceSummary.locationRisks = new Set();
      if (!sourceSummary.blockingKinds) sourceSummary.blockingKinds = new Set();
      if (!sourceSummary.nonBlockingKinds) sourceSummary.nonBlockingKinds = new Set();
      for (const match of matches) {
        sourceSummary.matchedNeedleIds.add(match.id);
        for (const location of match.locations ?? []) {
          if (sourceSummary.samplePaths.size < 10) {
            sourceSummary.samplePaths.add(location.path);
          }
          sourceSummary.locationKinds.add(location.kind);
          sourceSummary.locationRisks.add(location.risk);
          if (location.blockingCandidate) {
            sourceSummary.blockingKinds.add(location.kind);
          } else {
            sourceSummary.nonBlockingKinds.add(location.kind);
          }
        }
      }
    }
  }

  if (matchedNeedles.size > 0) {
    const sourceEntries = [...sources.values()];
    const hasBlockingCandidates = sourceEntries.some(
      (source) => source.blockingKinds?.size > 0,
    );
    return {
      status: 'matches-found',
      reason: 'restore_text_seen_in_app_server_response',
      hasBlockingCandidates,
      blockingKinds: [
        ...new Set(sourceEntries.flatMap((source) => [...(source.blockingKinds ?? [])])),
      ],
      nonBlockingKinds: [
        ...new Set(sourceEntries.flatMap((source) => [...(source.nonBlockingKinds ?? [])])),
      ],
      locationRisks: [
        ...new Set(sourceEntries.flatMap((source) => [...(source.locationRisks ?? [])])),
      ],
      sources: sourceEntries.map((source) => ({
        source: source.source,
        cycles: [...source.cycles],
        matchedNeedleIds: [...source.matchedNeedleIds],
        samplePaths: [...(source.samplePaths ?? [])],
        locationKinds: [...(source.locationKinds ?? [])],
        locationRisks: [...(source.locationRisks ?? [])],
        blockingKinds: [...(source.blockingKinds ?? [])],
        nonBlockingKinds: [...(source.nonBlockingKinds ?? [])],
        hasBlockingCandidates: (source.blockingKinds?.size ?? 0) > 0,
      })),
      matchedNeedles: [...matchedNeedles.values()],
    };
  }

  const checked = summaries.some(
    ({ responseTextMatches }) => responseTextMatches.status !== 'unchecked',
  );
  return {
    status: checked ? 'no-matches' : 'unchecked',
    reason: checked
      ? 'restore_text_not_seen_in_app_server_response'
      : 'restore_text_needles_not_provided',
    sources: [],
    matchedNeedles: [],
  };
}

function inspectTextMatchesInValue(source, needles) {
  const text = safeJsonStringify(source.value);
  const matches = [];
  for (const needle of needles) {
    if (!needle.value || !text.includes(needle.value)) continue;
    const locations = findNeedleLocationsInValue(source.value, needle.value);
    matches.push({
      id: needle.id,
      textPreview: needle.textPreview,
      locations,
    });
  }
  return {
    source: source.id,
    inspectedChars: text.length,
    matches,
  };
}

function findNeedleLocationsInValue(value, needleValue, path = '$', out = []) {
  if (out.length >= 20) return out;
  if (typeof value === 'string') {
    if (value.includes(needleValue)) {
      out.push({
        path,
        ...classifyResponseTextLocation(path),
        valuePreview: value.length > 160 ? `${value.slice(0, 160)}...` : value,
      });
    }
    return out;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length && out.length < 20; index++) {
      findNeedleLocationsInValue(value[index], needleValue, `${path}[${index}]`, out);
    }
    return out;
  }
  if (isRecord(value)) {
    for (const [key, child] of Object.entries(value)) {
      if (out.length >= 20) break;
      findNeedleLocationsInValue(child, needleValue, `${path}.${jsonPathKey(key)}`, out);
    }
  }
  return out;
}

function jsonPathKey(key) {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key);
}

function classifyResponseTextLocation(path) {
  if (path.includes('.replacement_history') || path.includes('.replacementHistory')) {
    return {
      kind: 'replacement_history',
      risk: 'durable_restore_source',
      blockingCandidate: true,
    };
  }
  if (path.endsWith('.aggregatedOutput')) {
    return {
      kind: 'aggregated_output',
      risk: 'quoted_or_tool_output_context',
      blockingCandidate: false,
    };
  }
  if (/\.items\[\d+\]\.text$/.test(path)) {
    return {
      kind: 'item_text_field',
      risk: 'direct_turn_text_candidate',
      blockingCandidate: true,
    };
  }
  if (path.includes('.content[')) {
    return {
      kind: 'content_field',
      risk: 'direct_turn_content_candidate',
      blockingCandidate: true,
    };
  }
  if (path.includes('.turns[')) {
    return {
      kind: 'turn_payload',
      risk: 'unknown_turn_payload_field',
      blockingCandidate: true,
    };
  }
  return {
    kind: 'unknown',
    risk: 'unknown_response_field',
    blockingCandidate: true,
  };
}

function safeJsonStringify(value) {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

async function listAllCodexThreadTurns({ client, threadId, limit, maxPages }) {
  const turns = [];
  let cursor = null;
  let nextCursor = null;
  for (let page = 1; page <= maxPages; page++) {
    const result = await client.request(
      buildThreadTurnsListRequest({
        id: randomUUID(),
        threadId,
        cursor,
        limit,
        sortDirection: 'asc',
      }),
    );
    const data = isRecord(result) && Array.isArray(result.data) ? result.data : [];
    turns.push(...data);
    nextCursor = isRecord(result) && typeof result.nextCursor === 'string' ? result.nextCursor : null;
    if (!nextCursor) {
      return {
        turns,
        pages: page,
        complete: true,
        nextCursor: null,
      };
    }
    cursor = nextCursor;
  }

  return {
    turns,
    pages: maxPages,
    complete: false,
    nextCursor,
  };
}

export async function runCodexTrimExecution({
  threadId,
  cwd,
  rollbackTurns,
  memoryText,
  expectedTurns = null,
  command = 'codex',
  commandArgs = ['app-server', '--listen', 'stdio://'],
  timeoutMs = 30_000,
  requestTimeoutMs = 10_000,
  postInjectReadAttempts = 5,
  postInjectReadDelayMs = 100,
} = {}) {
  assertNonEmptyString(threadId, 'runCodexTrimExecution: threadId');
  assertNonEmptyString(cwd, 'runCodexTrimExecution: cwd');
  assertNonEmptyString(command, 'runCodexTrimExecution: command');
  assertNonEmptyString(memoryText, 'runCodexTrimExecution: memoryText');
  if (!Number.isInteger(rollbackTurns) || rollbackTurns < 1) {
    throw new Error('runCodexTrimExecution: rollbackTurns must be an integer >= 1');
  }
  assertOptionalTurnCount(expectedTurns, 'runCodexTrimExecution: expectedTurns');
  if (!Array.isArray(commandArgs)) {
    throw new Error('runCodexTrimExecution: commandArgs must be an array');
  }
  assertPositiveInteger(postInjectReadAttempts, 'runCodexTrimExecution: postInjectReadAttempts');
  assertNonNegativeInteger(postInjectReadDelayMs, 'runCodexTrimExecution: postInjectReadDelayMs');

  const client = startAppServerClient({
    command,
    args: commandArgs,
    cwd,
    timeoutMs,
    requestTimeoutMs,
  });

  try {
    await client.request(
      buildInitializeRequest({
        id: randomUUID(),
        clientName: 'throughline-trim',
        clientTitle: 'Throughline Trim',
      }),
    );
    client.notify(buildInitializedNotification());

    const beforeRead = await client.request(
      buildThreadReadRequest({
        id: randomUUID(),
        threadId,
        includeTurns: true,
      }),
    );
    const resumed = await client.request(
      buildThreadResumeRequest({
        id: randomUUID(),
        threadId,
        cwd,
        excludeTurns: false,
      }),
    );
    const readTurns = countTurns(beforeRead);
    const resumedTurns = countTurns(resumed);
    const turnCountCheck = compareTurnCounts({
      expectedTurns,
      readTurns,
      resumedTurns,
    });
    const rollbackResolution = resolveRollbackTurnsForAppServer({
      plannedRollbackTurns: rollbackTurns,
      expectedTurns,
      readTurns,
      resumedTurns,
    });
    const rollback = await client.request(
      buildThreadRollbackRequest({
        id: randomUUID(),
        threadId,
        numTurns: rollbackResolution.requestedRollbackTurns,
      }),
    );
    const inject = await client.request(
      buildThreadInjectItemsRequest({
        id: randomUUID(),
        threadId,
        items: [buildDeveloperMessageItem(memoryText)],
      }),
    );
    const rollbackResultTurns = countTurns(rollback);
    const injectResultTurns = countTurns(inject);
    const expectedPostInjectTurns = expectedPostInjectTurnCount({
      rollbackResultTurns,
      injectResultTurns,
    });
    const postInjectRead = await waitForThreadTurnCount({
      client,
      threadId,
      expectedTurns: expectedPostInjectTurns,
      attempts: postInjectReadAttempts,
      delayMs: postInjectReadDelayMs,
    });

    return {
      status: 'executed',
      threadId,
      rollbackSent: true,
      injectSent: true,
      injectedItems: 1,
      readTurns,
      resumedTurns,
      rollbackRequestedTurns: rollbackResolution.requestedRollbackTurns,
      rollbackResolution,
      rollbackResultTurns,
      injectResultTurns,
      afterTurns: postInjectRead.turns,
      postInjectReadAttempts: postInjectRead.attempts,
      postInjectVisibilityCheck: postInjectRead.visibilityCheck,
      turnCountCheck,
      notifications: [...new Set(client.notifications)],
      stderr: client.stderr,
    };
  } finally {
    await client.close();
  }
}

export async function runCodexModelVisibilitySmoke({
  threadId,
  cwd,
  memoryText,
  marker,
  resumeAfterInject = false,
  command = 'codex',
  commandArgs = ['app-server', '--listen', 'stdio://'],
  timeoutMs = 60_000,
  requestTimeoutMs = 45_000,
} = {}) {
  assertNonEmptyString(threadId, 'runCodexModelVisibilitySmoke: threadId');
  assertNonEmptyString(cwd, 'runCodexModelVisibilitySmoke: cwd');
  assertNonEmptyString(memoryText, 'runCodexModelVisibilitySmoke: memoryText');
  assertNonEmptyString(marker, 'runCodexModelVisibilitySmoke: marker');
  assertNonEmptyString(command, 'runCodexModelVisibilitySmoke: command');
  if (!Array.isArray(commandArgs)) {
    throw new Error('runCodexModelVisibilitySmoke: commandArgs must be an array');
  }

  const client = startAppServerClient({
    command,
    args: commandArgs,
    cwd,
    timeoutMs,
    requestTimeoutMs,
  });

  try {
    await client.request(
      buildInitializeRequest({
        id: randomUUID(),
        clientName: 'throughline-codex-visibility-smoke',
        clientTitle: 'Throughline Codex Visibility Smoke',
      }),
    );
    client.notify(buildInitializedNotification());

    const beforeRead = await client.request(
      buildThreadReadRequest({
        id: randomUUID(),
        threadId,
        includeTurns: true,
      }),
    );
    const resumed = await client.request(
      buildThreadResumeRequest({
        id: randomUUID(),
        threadId,
        cwd,
        approvalPolicy: 'never',
        sandbox: 'read-only',
        excludeTurns: false,
      }),
    );

    await client.request(
      buildThreadInjectItemsRequest({
        id: randomUUID(),
        threadId,
        items: [buildDeveloperMessageItem(memoryText)],
      }),
    );
    let postInjectResumedTurns = null;
    if (resumeAfterInject) {
      const postInjectResumed = await client.request(
        buildThreadResumeRequest({
          id: randomUUID(),
          threadId,
          cwd,
          approvalPolicy: 'never',
          sandbox: 'read-only',
          excludeTurns: false,
        }),
      );
      postInjectResumedTurns = countTurns(postInjectResumed);
    }

    const prompt =
      `Throughline model-visible smoke. Reply with exactly this marker and nothing else: ${marker}`;
    await client.request(
      buildTurnStartRequest({
        id: randomUUID(),
        threadId,
        text: prompt,
      }),
    );
    const observedTurnEvent = await client.waitForNotification({
      predicate: (event) =>
        event.method === 'turn/completed' ||
        (event.method === 'item/agentMessage/delta' &&
          typeof event.params?.delta === 'string' &&
          event.params.delta.includes(marker)),
      timeoutMs: requestTimeoutMs,
    });

    const agentText = collectAgentText(client.notificationEvents);
    const markerVisible = agentText.includes(marker);

    return {
      status: markerVisible ? 'visible' : 'not-visible',
      reason: markerVisible
        ? 'marker_found_in_agent_message'
        : observedTurnEvent
          ? 'turn_completed_without_marker'
          : 'turn_notification_timeout',
      threadId,
      marker,
      readTurns: countTurns(beforeRead),
      resumedTurns: countTurns(resumed),
      postInjectResumedTurns,
      injectSent: true,
      resumeAfterInject: Boolean(resumeAfterInject),
      turnStartSent: true,
      agentText,
      notifications: [...new Set(client.notifications)],
      stderr: client.stderr,
    };
  } finally {
    await client.close();
  }
}

export async function runCodexRollbackModelVisiblePrepare({
  threadId,
  cwd,
  marker,
  command = 'codex',
  commandArgs = ['app-server', '--listen', 'stdio://'],
  timeoutMs = 60_000,
  requestTimeoutMs = 45_000,
} = {}) {
  assertNonEmptyString(threadId, 'runCodexRollbackModelVisiblePrepare: threadId');
  assertNonEmptyString(cwd, 'runCodexRollbackModelVisiblePrepare: cwd');
  assertNonEmptyString(marker, 'runCodexRollbackModelVisiblePrepare: marker');
  assertNonEmptyString(command, 'runCodexRollbackModelVisiblePrepare: command');
  if (!Array.isArray(commandArgs)) {
    throw new Error('runCodexRollbackModelVisiblePrepare: commandArgs must be an array');
  }

  const client = startAppServerClient({
    command,
    args: commandArgs,
    cwd,
    timeoutMs,
    requestTimeoutMs,
  });

  try {
    await initializeThroughlineAppServerClient(client, {
      clientName: 'throughline-codex-rollback-model-visible-smoke',
      clientTitle: 'Throughline Codex Rollback Model-Visible Smoke',
    });

    const beforeRead = await client.request(
      buildThreadReadRequest({
        id: randomUUID(),
        threadId,
        includeTurns: true,
      }),
    );
    const resumed = await client.request(
      buildThreadResumeRequest({
        id: randomUUID(),
        threadId,
        cwd,
      }),
    );
    const setupPrompt = [
      'Throughline controlled rollback model-visible setup.',
      `This user message contains this rollback visibility marker: ${marker}`,
      'Reply exactly: TL_ROLLBACK_MODEL_VISIBLE_SETUP_DONE',
    ].join(' ');
    await client.request(
      buildTurnStartRequest({
        id: randomUUID(),
        threadId,
        text: setupPrompt,
      }),
    );
    const observedSetupEvent = await client.waitForNotification({
      predicate: (event) => event.method === 'turn/completed',
      timeoutMs: requestTimeoutMs,
    });
    const rollback = await client.request(
      buildThreadRollbackRequest({
        id: randomUUID(),
        threadId,
        numTurns: 1,
      }),
    );
    const afterRollbackRead = await client.request(
      buildThreadReadRequest({
        id: randomUUID(),
        threadId,
        includeTurns: true,
      }),
    );

    return {
      status: 'prepared',
      reason: 'controlled_marker_turn_started_and_rolled_back',
      proofScope: 'controlled_same_thread_rollback_setup_only',
      restartSafe: false,
      threadId,
      marker,
      setupTurnStartSent: true,
      setupTurnCompletedObserved: Boolean(observedSetupEvent),
      rollbackSent: true,
      rollbackRequestedTurns: 1,
      beforeTurns: countTurns(beforeRead),
      resumedTurns: countTurns(resumed),
      rollbackResultTurns: countTurns(rollback),
      afterRollbackTurns: countTurns(afterRollbackRead),
      verifyPromptIncludesMarker: false,
      notifications: [...new Set(client.notifications)],
      stderr: client.stderr,
    };
  } finally {
    await client.close();
  }
}

export async function runCodexRollbackModelVisibleVerify({
  threadId,
  cwd,
  marker,
  markerPrefix = 'TL_ROLLBACK_MODEL_VISIBLE_',
  notVisibleToken = 'TL_ROLLBACK_MODEL_VISIBLE_NOT_VISIBLE',
  command = 'codex',
  commandArgs = ['app-server', '--listen', 'stdio://'],
  timeoutMs = 60_000,
  requestTimeoutMs = 45_000,
} = {}) {
  assertNonEmptyString(threadId, 'runCodexRollbackModelVisibleVerify: threadId');
  assertNonEmptyString(cwd, 'runCodexRollbackModelVisibleVerify: cwd');
  assertNonEmptyString(marker, 'runCodexRollbackModelVisibleVerify: marker');
  assertNonEmptyString(markerPrefix, 'runCodexRollbackModelVisibleVerify: markerPrefix');
  assertNonEmptyString(notVisibleToken, 'runCodexRollbackModelVisibleVerify: notVisibleToken');
  assertNonEmptyString(command, 'runCodexRollbackModelVisibleVerify: command');
  if (!Array.isArray(commandArgs)) {
    throw new Error('runCodexRollbackModelVisibleVerify: commandArgs must be an array');
  }
  if (marker.includes(notVisibleToken)) {
    throw new Error('runCodexRollbackModelVisibleVerify: marker must not contain notVisibleToken');
  }

  const client = startAppServerClient({
    command,
    args: commandArgs,
    cwd,
    timeoutMs,
    requestTimeoutMs,
  });

  try {
    await initializeThroughlineAppServerClient(client, {
      clientName: 'throughline-codex-rollback-model-visible-smoke',
      clientTitle: 'Throughline Codex Rollback Model-Visible Smoke',
    });

    const beforeRead = await client.request(
      buildThreadReadRequest({
        id: randomUUID(),
        threadId,
        includeTurns: true,
      }),
    );
    const resumed = await client.request(
      buildThreadResumeRequest({
        id: randomUUID(),
        threadId,
        cwd,
      }),
    );
    const verifyPrompt = [
      'Throughline controlled rollback model-visible verification.',
      `If your visible previous conversation context contains a token beginning with ${markerPrefix}, reply with exactly that complete token.`,
      `If no such token is visible, reply exactly: ${notVisibleToken}.`,
      'Do not invent or guess a token.',
    ].join(' ');
    await client.request(
      buildTurnStartRequest({
        id: randomUUID(),
        threadId,
        text: verifyPrompt,
      }),
    );
    const observedTurnEvent = await client.waitForNotification({
      predicate: (event) =>
        event.method === 'turn/completed' ||
        (event.method === 'item/agentMessage/delta' &&
          typeof event.params?.delta === 'string' &&
          (event.params.delta.includes(marker) || event.params.delta.includes(notVisibleToken))),
      timeoutMs: requestTimeoutMs,
    });
    const agentText = collectAgentText(client.notificationEvents);
    const observedMarkers = extractRollbackModelVisibleMarkers(agentText, markerPrefix);
    const markerVisible = observedMarkers.includes(marker);
    const notVisible = agentText.includes(notVisibleToken);
    const status = markerVisible ? 'reproduced' : notVisible ? 'not-reproduced' : 'inconclusive';

    return {
      status,
      reason: markerVisible
        ? 'rolled_back_marker_returned_by_model'
        : notVisible
        ? 'model_reported_rolled_back_marker_not_visible'
        : observedTurnEvent
        ? 'turn_completed_without_expected_marker_or_not_visible_token'
        : 'turn_notification_timeout',
      proofScope: 'controlled_same_thread_model_visible_verification',
      restartSafe: false,
      threadId,
      marker,
      markerPrefix,
      promptIncludesMarker: verifyPrompt.includes(marker),
      rolledBackMarkerModelVisible:
        status === 'reproduced' ? true : status === 'not-reproduced' ? false : null,
      modelReportedNotVisible: notVisible,
      turnStartSent: true,
      readTurns: countTurns(beforeRead),
      resumedTurns: countTurns(resumed),
      observedMarkers,
      notVisibleToken,
      agentText,
      notifications: [...new Set(client.notifications)],
      stderr: client.stderr,
    };
  } finally {
    await client.close();
  }
}

export async function runCodexNewThreadHandoff({
  cwd,
  prompt,
  command = 'codex',
  commandArgs = ['app-server', '--listen', 'stdio://'],
  timeoutMs = 120_000,
  requestTimeoutMs = 60_000,
  waitForTurn = true,
  sessionStartSource = 'clear',
  delivery = 'user-turn',
} = {}) {
  assertNonEmptyString(cwd, 'runCodexNewThreadHandoff: cwd');
  assertNonEmptyString(prompt, 'runCodexNewThreadHandoff: prompt');
  assertNonEmptyString(command, 'runCodexNewThreadHandoff: command');
  if (!Array.isArray(commandArgs)) {
    throw new Error('runCodexNewThreadHandoff: commandArgs must be an array');
  }
  if (sessionStartSource !== 'startup' && sessionStartSource !== 'clear') {
    throw new Error('runCodexNewThreadHandoff: sessionStartSource must be startup or clear');
  }
  if (delivery !== 'user-turn' && delivery !== 'developer-item') {
    throw new Error('runCodexNewThreadHandoff: delivery must be user-turn or developer-item');
  }

  const client = startAppServerClient({
    command,
    args: commandArgs,
    cwd,
    timeoutMs,
    requestTimeoutMs,
  });

  try {
    await initializeThroughlineAppServerClient(client, {
      clientName: 'throughline-codex-new-thread-handoff',
      clientTitle: 'Throughline Codex New Thread Handoff',
    });

    const threadStart = await client.request(
      buildThreadStartRequest({
        id: randomUUID(),
        cwd,
        sessionStartSource,
      }),
    );
    const threadId = findThreadIdInAppServerPayload(threadStart);
    if (!isCodexThreadId(threadId)) {
      throw new Error(`thread/start did not return a Codex thread id: ${JSON.stringify(threadStart).slice(0, 500)}`);
    }

    if (delivery === 'developer-item') {
      await client.request(
        buildThreadInjectItemsRequest({
          id: randomUUID(),
          threadId,
          items: [buildDeveloperMessageItem(prompt)],
        }),
      );
      return {
        status: 'started',
        reason: 'new_thread_started_and_developer_memory_injected',
        threadId,
        delivery,
        injectSent: true,
        turnStatus: 'not-started',
        notifications: [...new Set(client.notifications)],
        agentText: collectAgentText(client.notificationEvents),
        stderr: client.stderr,
      };
    }

    await client.request(buildTurnStartRequest({ id: randomUUID(), threadId, text: prompt }));
    const observedTurnEvent = waitForTurn
      ? await client.waitForNotification({
          predicate: (event) => event.method === 'turn/completed' || event.method === 'turn/failed',
          timeoutMs: requestTimeoutMs,
        })
      : null;
    const turnStatus =
      observedTurnEvent?.method === 'turn/completed'
        ? 'completed'
        : observedTurnEvent?.method === 'turn/failed'
          ? 'failed'
          : waitForTurn
            ? 'timeout'
            : 'unchecked';

    return {
      status: turnStatus === 'failed' || turnStatus === 'timeout' ? 'started-unverified' : 'started',
      reason:
        turnStatus === 'completed'
          ? 'new_thread_started_and_turn_completed'
          : turnStatus === 'failed'
            ? 'new_thread_started_but_turn_failed'
            : turnStatus === 'timeout'
              ? 'new_thread_started_but_turn_completion_not_observed'
              : 'new_thread_started_without_waiting_for_turn',
      threadId,
      delivery,
      injectSent: false,
      turnStatus,
      notifications: [...new Set(client.notifications)],
      agentText: collectAgentText(client.notificationEvents),
      stderr: client.stderr,
    };
  } finally {
    await client.close();
  }
}

function initializeThroughlineAppServerClient(client, { clientName, clientTitle }) {
  return client
    .request(
      buildInitializeRequest({
        id: randomUUID(),
        clientName,
        clientTitle,
      }),
    )
    .then(() => {
      client.notify(buildInitializedNotification());
    });
}

function extractRollbackModelVisibleMarkers(text, markerPrefix) {
  if (typeof text !== 'string' || !markerPrefix) return [];
  const escaped = markerPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`${escaped}[A-Za-z0-9_-]+`, 'g');
  return [...new Set(text.match(pattern) ?? [])];
}

function findThreadIdInAppServerPayload(value) {
  if (!isRecord(value)) return null;
  if (isCodexThreadId(value.id)) return value.id;
  if (isCodexThreadId(value.threadId)) return value.threadId;
  if (isRecord(value.thread)) {
    const nested = findThreadIdInAppServerPayload(value.thread);
    if (nested) return nested;
  }
  if (isRecord(value.params)) {
    const nested = findThreadIdInAppServerPayload(value.params);
    if (nested) return nested;
  }
  return null;
}

function isCodexThreadId(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

async function waitForThreadTurnCount({ client, threadId, expectedTurns, attempts, delayMs }) {
  let lastTurns = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (attempt > 1 && delayMs > 0) {
      await sleep(delayMs);
    }
    const read = await client.request(
      buildThreadReadRequest({
        id: randomUUID(),
        threadId,
        includeTurns: true,
      }),
    );
    lastTurns = countTurns(read);
    if (expectedTurns === null || expectedTurns === undefined) {
      return {
        turns: lastTurns,
        attempts: attempt,
        visibilityCheck: {
          status: 'unchecked',
          reason: 'expected_post_inject_turn_count_unavailable',
          expectedTurns,
          actualTurns: lastTurns,
        },
      };
    }
    if (lastTurns === expectedTurns) {
      return {
        turns: lastTurns,
        attempts: attempt,
        visibilityCheck: {
          status: 'match',
          reason: 'post_inject_turn_count_visible',
          expectedTurns,
          actualTurns: lastTurns,
        },
      };
    }
  }

  return {
    turns: lastTurns,
    attempts,
    visibilityCheck: {
      status: 'timeout',
      reason: 'post_inject_turn_count_not_visible_after_reads',
      expectedTurns,
      actualTurns: lastTurns,
    },
  };
}

function expectedPostInjectTurnCount({ rollbackResultTurns, injectResultTurns }) {
  if (Number.isInteger(injectResultTurns)) return injectResultTurns;
  if (Number.isInteger(rollbackResultTurns)) return rollbackResultTurns;
  return null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function startAppServerClient({ command, args, cwd, timeoutMs, requestTimeoutMs }) {
  const child = spawn(command, args, {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stdoutBuffer = '';
  let stderr = '';
  let closed = false;
  let failure = null;
  const pending = new Map();
  const notifications = [];
  const notificationEvents = [];
  const notificationWaiters = [];

  const overallTimer = setTimeout(() => {
    if (!closed) {
      child.kill('SIGTERM');
    }
  }, timeoutMs);

  child.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk.toString('utf8');
    let newlineIndex;
    while ((newlineIndex = stdoutBuffer.indexOf('\n')) >= 0) {
      const line = stdoutBuffer.slice(0, newlineIndex);
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
      if (!line.trim()) continue;
      let message;
      try {
        message = parseAppServerLine(line);
      } catch {
        continue;
      }

      if ((message.kind === 'response' || message.kind === 'error') && pending.has(message.id)) {
        const pendingRequest = pending.get(message.id);
        pending.delete(message.id);
        pendingRequest.finish(message);
      } else if (message.kind === 'notification') {
        const event = {
          method: message.method,
          params: message.params,
        };
        notifications.push(message.method);
        notificationEvents.push(event);
        resolveNotificationWaiters(event);
      }
    }
  });

  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
  });

  child.on('error', (err) => {
    failure = err instanceof Error ? err : new Error(String(err));
    closed = true;
    clearTimeout(overallTimer);
    rejectPending(`codex app-server failed to start: ${failure.message}`);
  });

  child.on('exit', (code, signal) => {
    closed = true;
    clearTimeout(overallTimer);
    rejectPending(`codex app-server exited before response: code=${code} signal=${signal}`);
  });

  return {
    notifications,
    notificationEvents,
    get stderr() {
      return summarizeAppServerStderr(stderr);
    },
    request(message) {
      if (!isRequestId(message.id)) {
        throw new Error('app-server request message requires an id');
      }
      if (failure) {
        return Promise.reject(new Error(`codex app-server is unavailable: ${failure.message}`));
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          if (pending.has(message.id)) {
            pending.delete(message.id);
            reject(new Error(`timeout waiting for app-server response to ${message.method}`));
          }
        }, requestTimeoutMs);
        pending.set(message.id, {
          reject,
          finish(response) {
            clearTimeout(timer);
            if (response.kind === 'error') {
              reject(new Error(`${message.method}: ${JSON.stringify(response.error)}`));
            } else {
              resolve(response.result);
            }
          },
        });
        try {
          child.stdin.write(encodeAppServerMessage(message));
        } catch (err) {
          clearTimeout(timer);
          pending.delete(message.id);
          const msg = err instanceof Error ? err.message : 'unknown';
          reject(new Error(`failed to write app-server request ${message.method}: ${msg}`));
        }
      });
    },
    notify(message) {
      child.stdin.write(encodeAppServerMessage(message));
    },
    waitForNotification({ predicate, timeoutMs }) {
      if (typeof predicate !== 'function') {
        throw new Error('waitForNotification: predicate must be a function');
      }
      const existing = notificationEvents.find(predicate);
      if (existing) return Promise.resolve(existing);

      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          const index = notificationWaiters.findIndex((waiter) => waiter.resolve === resolve);
          if (index >= 0) notificationWaiters.splice(index, 1);
          resolve(null);
        }, timeoutMs);
        notificationWaiters.push({
          predicate,
          resolve(event) {
            clearTimeout(timer);
            resolve(event);
          },
        });
      });
    },
    close() {
      clearTimeout(overallTimer);
      child.kill('SIGTERM');
      child.stdin.destroy();
      if (closed) return Promise.resolve();
      return new Promise((resolve) => {
        child.once('exit', resolve);
        setTimeout(resolve, 1_000);
      });
    },
  };

  function rejectPending(reason) {
    for (const [id, pendingRequest] of pending) {
      pending.delete(id);
      pendingRequest.reject(new Error(`${reason}; request=${id}`));
    }
  }

  function resolveNotificationWaiters(event) {
    for (let i = notificationWaiters.length - 1; i >= 0; i--) {
      const waiter = notificationWaiters[i];
      if (!waiter.predicate(event)) continue;
      notificationWaiters.splice(i, 1);
      waiter.resolve(event);
    }
  }
}

function collectAgentText(notificationEvents) {
  return notificationEvents
    .filter((event) => event.method === 'item/agentMessage/delta')
    .map((event) => (typeof event.params?.delta === 'string' ? event.params.delta : ''))
    .join('');
}

function countTurns(result) {
  const thread = isRecord(result) && isRecord(result.thread) ? result.thread : result;
  return isRecord(thread) && Array.isArray(thread.turns) ? thread.turns.length : null;
}

export function compareTurnCounts({ expectedTurns = null, readTurns = null, resumedTurns = null } = {}) {
  assertOptionalTurnCount(expectedTurns, 'compareTurnCounts: expectedTurns');
  const counts = { expectedTurns, readTurns, resumedTurns };
  if (expectedTurns === null || expectedTurns === undefined) {
    return {
      status: 'unchecked',
      reason: 'expected_turns_not_available',
      ...counts,
    };
  }

  if (!Number.isInteger(readTurns) || !Number.isInteger(resumedTurns)) {
    return {
      status: 'unknown',
      reason: 'app_server_turn_count_unavailable',
      ...counts,
    };
  }

  if (readTurns === expectedTurns && resumedTurns === expectedTurns) {
    return {
      status: 'match',
      reason: 'rollout_and_app_server_turn_counts_match',
      ...counts,
    };
  }

  return {
    status: 'mismatch',
    reason: 'rollout_and_app_server_turn_counts_differ',
    ...counts,
  };
}

function compareRestoreTurnCounts({
  expectedTurns = null,
  readTurns = null,
  resumedTurns = null,
  turnsListTurns = null,
  turnsListComplete = true,
} = {}) {
  assertOptionalTurnCount(expectedTurns, 'compareRestoreTurnCounts: expectedTurns');
  const counts = { expectedTurns, readTurns, resumedTurns, turnsListTurns };
  if (expectedTurns === null || expectedTurns === undefined) {
    return {
      status: 'unchecked',
      reason: 'expected_turns_not_available',
      ...counts,
      turnsListComplete,
    };
  }

  if (
    !Number.isInteger(readTurns) ||
    !Number.isInteger(resumedTurns) ||
    !Number.isInteger(turnsListTurns)
  ) {
    return {
      status: 'unknown',
      reason: 'app_server_turn_count_unavailable',
      ...counts,
      turnsListComplete,
    };
  }

  if (turnsListComplete !== true) {
    return {
      status: 'unknown',
      reason: 'app_server_turns_list_incomplete',
      ...counts,
      turnsListComplete,
    };
  }

  if (readTurns === expectedTurns && resumedTurns === expectedTurns && turnsListTurns === expectedTurns) {
    return {
      status: 'match',
      reason: 'rollout_and_app_server_restore_counts_match',
      ...counts,
      turnsListComplete,
    };
  }

  return {
    status: 'mismatch',
    reason: 'rollout_and_app_server_restore_counts_differ',
    ...counts,
    turnsListComplete,
  };
}

export function summarizeAppServerStderr(stderr) {
  if (typeof stderr !== 'string' || stderr.length === 0) return '';

  const lines = stderr.split('\n');
  const out = [];
  const suppressedByTurn = new Map();
  const unknownTurnWarning =
    /WARN codex_app_server_protocol::protocol::thread_history: dropping turn-scoped item for unknown turn id `([^`]+)` item_id=/;

  for (const line of lines) {
    if (line === '') continue;
    const match = line.match(unknownTurnWarning);
    if (!match) {
      out.push(line);
      continue;
    }

    const turnId = match[1];
    const current = suppressedByTurn.get(turnId) ?? { seen: 0, suppressed: 0 };
    if (current.seen === 0) {
      out.push(line);
    } else {
      current.suppressed++;
    }
    current.seen++;
    suppressedByTurn.set(turnId, current);
  }

  for (const [turnId, { suppressed }] of suppressedByTurn.entries()) {
    if (suppressed > 0) {
      out.push(
        `[throughline] suppressed ${suppressed} repeated Codex app-server unknown-turn item warnings for turn ${turnId}`,
      );
    }
  }

  const summarized = out.length === 0 ? '' : `${out.join('\n')}\n`;
  if (summarized.length <= MAX_APP_SERVER_STDERR_CHARS) return summarized;

  const omitted = summarized.length - MAX_APP_SERVER_STDERR_CHARS;
  return `${summarized.slice(0, MAX_APP_SERVER_STDERR_CHARS)}\n[throughline] truncated ${omitted} chars of Codex app-server stderr\n`;
}

function compactNullish(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== null && entry !== undefined),
  );
}

function assertRequestId(id, caller) {
  if (!isRequestId(id)) {
    throw new Error(`${caller}: id must be a string or integer`);
  }
}

function assertNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
}

function assertOptionalTurnCount(value, label) {
  if (value === null || value === undefined) return;
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer when provided`);
  }
}

function assertRestoreTextNeedles(value, label) {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  for (const [index, needle] of value.entries()) {
    if (!isRecord(needle)) {
      throw new Error(`${label}[${index}] must be an object`);
    }
    assertNonEmptyString(needle.id, `${label}[${index}].id`);
    assertNonEmptyString(needle.value, `${label}[${index}].value`);
    assertNonEmptyString(needle.textPreview, `${label}[${index}].textPreview`);
  }
}

function assertPositiveInteger(value, label) {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${label} must be an integer >= 1`);
  }
}

function assertNonNegativeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
}

function isRequestId(value) {
  return typeof value === 'string' || (typeof value === 'number' && Number.isInteger(value));
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
