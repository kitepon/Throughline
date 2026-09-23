import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { buildBodyRowsFromActiveTurns } from './codex-capture.mjs';
import { CLAUDE_HOST, CODEX_HOST, isCodexSessionId } from './hosts/identity.mjs';
import { parseCodexRolloutFile } from './codex-rollout-memory.mjs';
import { getLogicalTurnGroups } from './transcript-reader.mjs';
import { hashAuditorBody, normalizeAuditorBody } from './body-digest.mjs';

export { hashAuditorBody, normalizeAuditorBody } from './body-digest.mjs';

export const AUDITOR_CONTEXT_SCHEMA = 'throughline.auditor_context.v1';
export const AUDITOR_CONTEXT_DB_SCHEMA_VERSION = 9;
export const DEFAULT_AUDITOR_RECENT_TURNS = 2;
export const DEFAULT_AUDITOR_MAX_BODY_CHARS = 1200;
export const DEFAULT_AUDITOR_MAX_TOTAL_CHARS = 4000;
const OBSERVER_PROJECTION_BUSY_TIMEOUT_MS = 1_000;

export function defaultAuditorContextDbPath() {
  return join(homedir(), '.throughline', 'throughline.db');
}

export function deriveAuditorFreshnessExpectation({ host, transcriptPath, sessionId } = {}) {
  assertNonEmptyString(transcriptPath, 'transcriptPath');
  assertNonEmptyString(sessionId, 'sessionId');
  if (host === CLAUDE_HOST) {
    const latest = getLogicalTurnGroups(transcriptPath).at(-1);
    if (!latest) return null;
    return {
      expectedOriginSessionId: sessionId,
      expectedTurnNumber: latest.representative.index,
      expectedUserSha256: hashAuditorBody(latest.user.content),
      expectedAssistantSha256: hashAuditorBody(latest.representative.content),
    };
  }
  if (host === CODEX_HOST) {
    const parsed = parseCodexRolloutFile(transcriptPath, { includeInFlightTurn: false });
    const rows = buildBodyRowsFromActiveTurns(parsed.activeTurns, { sessionId, now: 0 });
    const latestTurnNumber = rows.reduce((max, row) => Math.max(max, row.turnNumber), 0);
    if (latestTurnNumber < 1) return null;
    const user = rows.find((row) => row.turnNumber === latestTurnNumber && row.role === 'user');
    const assistant = rows.find((row) => row.turnNumber === latestTurnNumber && row.role === 'assistant');
    if (!user || !assistant) return null;
    return {
      expectedOriginSessionId: sessionId,
      // Codex active turns are rebuilt after rollback/in-flight filtering. Their ordinal can
      // shift between Stop capture and the next UserPromptSubmit, so it is not a stable identity.
      // Exact session/origin plus both normalized pair hashes remain mandatory below.
      expectedTurnNumber: null,
      expectedUserSha256: hashAuditorBody(user.text),
      expectedAssistantSha256: hashAuditorBody(assistant.text),
    };
  }
  throw new TypeError('host must be claude or codex');
}

export function readAuditorContext({
  dbPath = defaultAuditorContextDbPath(),
  sessionId,
  projectRoot,
  expectedOriginSessionId,
  expectedTurnNumber,
  expectedUserSha256,
  expectedAssistantSha256,
  recentTurns = DEFAULT_AUDITOR_RECENT_TURNS,
  maxBodyChars = DEFAULT_AUDITOR_MAX_BODY_CHARS,
  maxTotalChars = DEFAULT_AUDITOR_MAX_TOTAL_CHARS,
} = {}) {
  assertNonEmptyString(sessionId, 'sessionId');
  assertNonEmptyString(projectRoot, 'projectRoot');
  assertPositiveInteger(recentTurns, 'recentTurns');
  assertPositiveInteger(maxBodyChars, 'maxBodyChars');
  assertPositiveInteger(maxTotalChars, 'maxTotalChars');

  if (!existsSync(dbPath)) {
    return emptyResult('unavailable', 'db_not_found', { sessionId, projectRoot, recentTurns });
  }

  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch (cause) {
    throw new AuditorContextError('E_AUDITOR_CONTEXT_DB_OPEN', 'auditor context DB could not be opened', { cause });
  }

  try {
    const version = Number(db.prepare('PRAGMA user_version').get()?.user_version ?? 0);
    if (version !== AUDITOR_CONTEXT_DB_SCHEMA_VERSION) {
      return emptyResult('schema_mismatch', 'unsupported_db_schema', {
        sessionId,
        projectRoot,
        recentTurns,
        dbSchemaVersion: version,
      });
    }

    const session = db.prepare(
      `SELECT session_id, project_path
       FROM sessions
       WHERE session_id = ?`,
    ).get(sessionId);
    if (!session) {
      return emptyResult('empty', 'session_not_found', { sessionId, projectRoot, recentTurns });
    }
    if (!isSameProjectOrDescendant(session.project_path, projectRoot)) {
      return emptyResult('session_mismatch', 'project_mismatch', { sessionId, projectRoot, recentTurns });
    }

    const rows = db.prepare(
      `SELECT id, origin_session_id, turn_number, role, text, created_at
       FROM bodies
       WHERE session_id = ? AND role IN ('user', 'assistant')
       ORDER BY created_at ASC, id ASC`,
    ).all(sessionId);
    const completed = buildCompletedPairs(rows);
    if (completed.length === 0) {
      return emptyResult('empty', 'completed_pair_not_found', { sessionId, projectRoot, recentTurns });
    }

    const latest = completed.at(-1);
    const stableTurnIdentityAvailable = Number.isInteger(expectedTurnNumber) && expectedTurnNumber >= 0;
    const codexPairIdentity = isCodexSessionId(sessionId) && expectedOriginSessionId === sessionId;
    const expectationComplete =
      typeof expectedOriginSessionId === 'string' && expectedOriginSessionId.length > 0 &&
      (stableTurnIdentityAvailable || codexPairIdentity) &&
      isSha256(expectedUserSha256) && isSha256(expectedAssistantSha256);
    if (!expectationComplete) {
      return emptyResult('stale', 'freshness_expectation_incomplete', { sessionId, projectRoot, recentTurns });
    }

    const expectedUserHash = expectedUserSha256.toLowerCase();
    const expectedAssistantHash = expectedAssistantSha256.toLowerCase();
    const matchedIndex = stableTurnIdentityAvailable
      ? completed.length - 1
      : completed.findLastIndex((pair) =>
          pair.originSessionId === expectedOriginSessionId &&
          hashAuditorBody(pair.user) === expectedUserHash &&
          hashAuditorBody(pair.assistant) === expectedAssistantHash);
    const matched = matchedIndex >= 0 ? completed[matchedIndex] : latest;
    const identityMatched = matchedIndex >= 0 && matched.originSessionId === expectedOriginSessionId &&
      (!stableTurnIdentityAvailable || matched.turnNumber === expectedTurnNumber);
    const userMatched = matchedIndex >= 0 && hashAuditorBody(matched.user) === expectedUserHash;
    const assistantMatched = matchedIndex >= 0 && hashAuditorBody(matched.assistant) === expectedAssistantHash;
    if (!identityMatched || !userMatched || !assistantMatched) {
      return emptyResult('stale', 'latest_pair_mismatch', { sessionId, projectRoot, recentTurns });
    }

    const stableCompleted = completed.slice(0, matchedIndex + 1);
    const bounded = boundCompletedPairs(stableCompleted.slice(-recentTurns), { maxBodyChars, maxTotalChars });
    return {
      schema: AUDITOR_CONTEXT_SCHEMA,
      status: 'fresh',
      reason: 'latest_pair_matched',
      sessionId,
      projectPath: canonicalProjectPath(projectRoot),
      source: 'throughline-db-l2',
      freshness: {
        originSessionId: matched.originSessionId,
        turnNumber: matched.turnNumber,
        identityMatched: true,
        userMatched: true,
        assistantMatched: true,
      },
      turns: bounded.turns,
      stats: {
        requestedTurns: recentTurns,
        returnedTurns: bounded.turns.length,
        chars: bounded.chars,
        truncated: bounded.truncated,
      },
    };
  } catch (cause) {
    if (cause instanceof AuditorContextError) throw cause;
    throw new AuditorContextError('E_AUDITOR_CONTEXT_QUERY', 'auditor context query failed', { cause });
  } finally {
    db.close();
  }
}

/** Read-only, ordered completed-pair projection for the Observer feed. */
export function readCompletedPairProjection({
  dbPath = defaultAuditorContextDbPath(), sessionId, projectRoot, expectedPairs,
  maxBodyChars = DEFAULT_AUDITOR_MAX_BODY_CHARS, maxTotalChars = DEFAULT_AUDITOR_MAX_TOTAL_CHARS,
} = {}) {
  assertNonEmptyString(sessionId, 'sessionId');
  assertNonEmptyString(projectRoot, 'projectRoot');
  assertExpectedPairs(expectedPairs);
  assertPositiveInteger(maxBodyChars, 'maxBodyChars');
  if (!Number.isInteger(maxTotalChars) || maxTotalChars < 0) throw new TypeError('maxTotalChars must be an integer >= 0');
  if (!existsSync(dbPath)) return { status: 'pending', reason: 'db_not_found', turns: [] };
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    db.exec(`PRAGMA busy_timeout = ${OBSERVER_PROJECTION_BUSY_TIMEOUT_MS}`);
  } catch (cause) {
    db?.close();
    throw new AuditorContextError('E_AUDITOR_CONTEXT_DB_OPEN', 'auditor context DB could not be opened', { cause });
  }
  try {
    const version = Number(db.prepare('PRAGMA user_version').get()?.user_version ?? 0);
    if (version !== AUDITOR_CONTEXT_DB_SCHEMA_VERSION) throw new AuditorContextError('E_AUDITOR_CONTEXT_SCHEMA', 'auditor context DB schema is unsupported');
    const session = db.prepare('SELECT session_id, project_path FROM sessions WHERE session_id = ?').get(sessionId);
    if (!session) return { status: 'pending', reason: 'session_not_found', turns: [] };
    if (!isSameProjectOrDescendant(session.project_path, projectRoot)) throw new AuditorContextError('E_AUDITOR_CONTEXT_PROJECT', 'auditor context DB project does not match');
    const rows = db.prepare(
      `SELECT id, origin_session_id, turn_number, role, text, created_at FROM bodies
       WHERE session_id = ? AND role IN ('user', 'assistant') ORDER BY created_at ASC, id ASC`,
    ).all(sessionId);
    const matched = matchExpectedPairs(buildCompletedPairs(rows), expectedPairs);
    if (!matched) return { status: 'pending', reason: 'pair_not_found', turns: [] };
    return { status: 'fresh', turns: boundProjectedPairs(matched, { maxBodyChars, maxTotalChars }) };
  } catch (cause) {
    if (cause instanceof AuditorContextError) throw cause;
    throw new AuditorContextError('E_AUDITOR_CONTEXT_QUERY', 'auditor context query failed', { cause });
  } finally { db.close(); }
}

export class AuditorContextError extends Error {
  constructor(code, message, { cause } = {}) {
    super(message, { cause });
    this.name = 'AuditorContextError';
    this.code = code;
  }
}

export function buildCompletedPairs(rows) {
  const grouped = new Map();
  for (const row of rows) {
    if (!row?.origin_session_id || !Number.isInteger(row.turn_number)) continue;
    const key = `${row.origin_session_id}\u0000${row.turn_number}`;
    const pair = grouped.get(key) ?? {
      originSessionId: row.origin_session_id,
      turnNumber: row.turn_number,
      user: null,
      assistant: null,
      createdAt: Number(row.created_at) || 0,
      lastId: Number(row.id) || 0,
    };
    if (row.role === 'user' && pair.user === null) pair.user = normalizeAuditorBody(row.text);
    if (row.role === 'assistant' && pair.assistant === null) pair.assistant = normalizeAuditorBody(row.text);
    pair.createdAt = Math.max(pair.createdAt, Number(row.created_at) || 0);
    pair.lastId = Math.max(pair.lastId, Number(row.id) || 0);
    grouped.set(key, pair);
  }
  return [...grouped.values()]
    .filter((pair) => pair.user !== null && pair.assistant !== null)
    .sort((a, b) => a.createdAt - b.createdAt || a.lastId - b.lastId)
    .map(({ lastId: _lastId, ...pair }) => pair);
}

function boundCompletedPairs(pairs, { maxBodyChars, maxTotalChars }) {
  const prepared = pairs.map((pair) => {
    const user = tail(pair.user, maxBodyChars);
    const assistant = tail(pair.assistant, maxBodyChars);
    return {
      ...pair,
      user,
      assistant,
      truncated: user.length < pair.user.length || assistant.length < pair.assistant.length,
    };
  });

  const selected = [];
  let chars = 0;
  let truncated = prepared.some((pair) => pair.truncated);
  for (let i = prepared.length - 1; i >= 0; i--) {
    const pair = prepared[i];
    const remaining = maxTotalChars - chars;
    if (remaining <= 0) {
      truncated = true;
      continue;
    }
    let user = pair.user;
    let assistant = pair.assistant;
    if (user.length + assistant.length > remaining) {
      const assistantBudget = Math.min(assistant.length, Math.ceil(remaining / 2));
      const userBudget = Math.max(0, remaining - assistantBudget);
      user = tail(user, userBudget);
      assistant = tail(assistant, assistantBudget);
      truncated = true;
    }
    if (user.length === 0 || assistant.length === 0) {
      truncated = true;
      continue;
    }
    chars += user.length + assistant.length;
    selected.unshift({
      originSessionId: pair.originSessionId,
      turnNumber: pair.turnNumber,
      user,
      assistant,
      createdAt: pair.createdAt,
    });
  }
  return { turns: selected, chars, truncated };
}

function matchExpectedPairs(completed, expectedPairs) {
  const matched = [];
  let searchStart = 0;
  for (const expected of expectedPairs) {
    const index = completed.findIndex((pair, pairIndex) => pairIndex >= searchStart &&
      hashAuditorBody(pair.originSessionId) === expected.origin_sha256 &&
      hashAuditorBody(pair.user) === expected.user_sha256 && hashAuditorBody(pair.assistant) === expected.assistant_sha256);
    if (index < 0) return null;
    matched.push({ ...completed[index], expected });
    searchStart = index + 1;
  }
  return matched;
}

function boundProjectedPairs(pairs, { maxBodyChars, maxTotalChars }) {
  let remaining = maxTotalChars;
  return pairs.map((pair) => {
    const user = tail(pair.user, Math.min(maxBodyChars, remaining));
    remaining -= user.length;
    const assistant = tail(pair.assistant, Math.min(maxBodyChars, remaining));
    remaining -= assistant.length;
    return {
      origin_sha256: pair.expected.origin_sha256, user_sha256: pair.expected.user_sha256,
      assistant_sha256: pair.expected.assistant_sha256, user, assistant,
      truncated: user.length < pair.user.length || assistant.length < pair.assistant.length,
    };
  });
}

function emptyResult(status, reason, { sessionId, projectRoot, recentTurns, dbSchemaVersion } = {}) {
  return {
    schema: AUDITOR_CONTEXT_SCHEMA,
    status,
    reason,
    sessionId,
    projectPath: canonicalProjectPath(projectRoot),
    source: 'throughline-db-l2',
    freshness: {
      identityMatched: false,
      userMatched: false,
      assistantMatched: false,
    },
    turns: [],
    stats: {
      requestedTurns: recentTurns,
      returnedTurns: 0,
      chars: 0,
      truncated: false,
      ...(Number.isInteger(dbSchemaVersion) ? { dbSchemaVersion } : {}),
    },
  };
}

function canonicalProjectPath(value) {
  const raw = String(value ?? '');
  if (/^[A-Za-z]:[\\/]/.test(raw)) {
    // Windows の 8.3 短縮名 (例: RUNNER~1) を実体の長い名前へ解決してから比較形へ
    // 正規化する。GitHub Actions は TEMP が短縮名で来るため、realpath を挟まないと
    // 同一ディレクトリの短縮形/長形が別 project と判定される (codex-thread-index の
    // normalizePath と同型)。存在しないパスは lexical のまま (fixture の仮パスを壊さない)。
    let resolved = raw;
    try {
      if (existsSync(raw)) resolved = realpathSync.native(raw);
    } catch {
      // Keep the lexical Windows path when it cannot be resolved.
    }
    return resolved.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  }
  let normalized = isAbsolute(raw) ? raw : resolve(raw);
  try {
    if (existsSync(normalized)) normalized = realpathSync.native(normalized);
  } catch {
    // Keep the lexical path when the filesystem cannot resolve it.
  }
  return normalized.split(sep).join('/').replace(/\/+$/, '');
}

export function isSameProjectOrDescendant(candidate, root) {
  const normalizedCandidate = canonicalProjectPath(candidate);
  const normalizedRoot = canonicalProjectPath(root);
  const left = /^[A-Za-z]:\//.test(normalizedCandidate) ? normalizedCandidate.toLowerCase() : normalizedCandidate;
  const right = /^[A-Za-z]:\//.test(normalizedRoot) ? normalizedRoot.toLowerCase() : normalizedRoot;
  return left === right || left.startsWith(`${right}/`);
}

function tail(value, maxChars) {
  if (maxChars <= 0) return '';
  return value.length <= maxChars ? value : value.slice(value.length - maxChars);
}

function isSha256(value) {
  return typeof value === 'string' && /^[a-fA-F0-9]{64}$/.test(value);
}

function assertNonEmptyString(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
}

function assertPositiveInteger(value, name) {
  if (!Number.isInteger(value) || value < 1) {
    throw new TypeError(`${name} must be an integer >= 1`);
  }
}

function assertExpectedPairs(value) {
  if (!Array.isArray(value) || value.length < 1 || value.some((pair) => !pair || typeof pair !== 'object' ||
    Object.keys(pair).length !== 3 || !isLowercaseSha256(pair.origin_sha256) || !isLowercaseSha256(pair.user_sha256) || !isLowercaseSha256(pair.assistant_sha256))) {
    throw new TypeError('expectedPairs must be a non-empty SHA-256 chain');
  }
}

function isLowercaseSha256(value) { return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value); }
