import { createHash } from 'node:crypto';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { listCodexThreadCandidates } from './codex-thread-index.mjs';
import { parseCodexRolloutFile } from './codex-rollout-memory.mjs';
import { hashAuditorBody } from './body-digest.mjs';
import { buildBodyRowsFromActiveTurns, buildCodexThroughlineSessionId } from './codex-capture.mjs';
import { readCompletedTurnReceiptSnapshot } from './completed-turn-receipts.mjs';
import { readCompletedPairProjection } from './auditor-context.mjs';
import { CODEX_HOST, hostOfSessionId } from './hosts/identity.mjs';
import { TURN_START_PROMPT, publicTurnStart } from './turn-start.mjs';

export const OBSERVER_CURSOR_SCHEMA = 'throughline.observer_cursor.v1';
export const OBSERVER_READ_SCHEMA = 'throughline.observer_read.v1';
export const OBSERVER_READ_SCHEMA_V2 = 'throughline.observer_read.v2';
export const OBSERVER_READ_WIRES = Object.freeze(['v1', 'v2']);
export const OBSERVER_PAGE_SCHEMA = 'throughline.observer_page.v1';
const CURSOR_PREFIX = 'tlc1.';
const PAGE_PREFIX = 'tlp1.';
const DEFAULT_PAGE_LIMIT = 10;
const MAX_PAGE_LIMIT = 100;

/**
 * Resolves the latest completed-only parent and validates an optional opaque cursor.
 * This core intentionally returns identities only as SHA-256 values; body projection is later work.
 */
export function resolveObserverTurnFeed({ projectPath, cursor = null, codexHome, receiptOptions, dbPath, maxBodyChars, maxTotalChars } = {}) {
  const project = canonicalExistingProject(projectPath);
  const projectSha256 = sha256(project);
  const claude = claudeCandidates(project, receiptOptions);
  const codex = codexCandidates(project, codexHome);
  const candidates = [...claude, ...codex];
  if (cursor === null || cursor === undefined) {
    const selected = selectLatest(candidates);
    if (selected?.ambiguous) return { schema: OBSERVER_CURSOR_SCHEMA, status: 'ambiguous_parent', cursor: null };
    const current = selected ?? emptyCandidate();
    const throughCursor = encodeObserverCursor(cursorShape(current, projectSha256));
    return withProjection(publicResult('snapshot', null, throughCursor, current), current, project, { dbPath, maxBodyChars, maxTotalChars });
  }

  let prior;
  try { prior = decodeObserverCursor(cursor); } catch { return { schema: OBSERVER_CURSOR_SCHEMA, status: 'resync_required', afterCursor: cursor, throughCursor: null }; }
  if (prior.schema !== OBSERVER_CURSOR_SCHEMA || prior.project_sha256 !== projectSha256) {
    return { schema: OBSERVER_CURSOR_SCHEMA, status: 'resync_required', afterCursor: cursor, throughCursor: null };
  }
  const priorCandidate = prior.host === null
    ? emptyCandidate()
    : candidates.find((item) => item.host === prior.host && item.threadHash === prior.thread_sha256);
  if (!priorCandidate || prior.host !== null &&
    (prior.history_floor < priorCandidate.historyFloor || prior.length > priorCandidate.chain.length ||
      prefixDigest(priorCandidate.chain.slice(0, prior.length)) !== prior.prefix_sha256)) {
    return { schema: OBSERVER_CURSOR_SCHEMA, status: 'resync_required', afterCursor: cursor, throughCursor: null };
  }
  const selected = selectLatest(candidates);
  if (selected?.ambiguous) return { schema: OBSERVER_CURSOR_SCHEMA, status: 'ambiguous_parent', cursor: null };
  const current = selected ?? emptyCandidate();
  const throughCursor = encodeObserverCursor(cursorShape(current, projectSha256));
  const status = prior.host === null && current.host !== null ? 'append'
    : prior.host !== null && current.host === null ? 'resync_required'
      : prior.host !== current.host ? 'host_switched'
        : prior.thread_sha256 !== current.threadHash ? 'thread_switched'
          : prior.length === current.chain.length ? 'unchanged' : 'append';
  return withProjection(publicResult(status, cursor, throughCursor, current), current, project, { dbPath, maxBodyChars, maxTotalChars });
}

/**
 * Reads one fixed Observer page. A continuation is bound to the exact project,
 * after cursor, through cursor, and verified logical-series prefix.
 */
export function readObserverTurnPage({
  projectPath, afterCursor = null, throughCursor = null, pageToken = null,
  limit = DEFAULT_PAGE_LIMIT, codexHome, receiptOptions, dbPath, maxBodyChars, maxTotalChars,
  wire = 'v1',
} = {}) {
  assertPageLimit(limit);
  if (!OBSERVER_READ_WIRES.includes(wire)) throw new TypeError('observer read wire must be v1 or v2');
  const project = canonicalExistingProject(projectPath);
  const projectSha256 = sha256(project);
  const candidates = [...claudeCandidates(project, receiptOptions), ...codexCandidates(project, codexHome)];
  const normalizedAfter = afterCursor ?? null;
  const normalizedThrough = throughCursor ?? null;
  const normalizedPageToken = pageToken ?? null;
  let decodedPageToken = null;
  if (normalizedPageToken !== null && (normalizedAfter === null || normalizedThrough === null)) {
    throw new TypeError('observer page token requires afterCursor and throughCursor');
  }
  if (normalizedPageToken !== null) {
    decodedPageToken = decodeObserverPageToken(normalizedPageToken);
    validatePageTokenBinding(decodedPageToken, {
      projectSha256, afterCursor: normalizedAfter, throughCursor: normalizedThrough,
    });
  }

  let fixedThrough;
  let fixedThroughCursor;
  if (normalizedThrough === null) {
    const selected = selectLatest(candidates);
    if (selected?.ambiguous) return emptyReadResult('ambiguous_parent', normalizedAfter, wire);
    fixedThrough = selected ?? emptyCandidate();
    fixedThroughCursor = encodeObserverCursor(cursorShape(fixedThrough, projectSha256));
  } else {
    const decodedThrough = decodeCursorForRead(normalizedThrough, projectSha256);
    if (!decodedThrough) return emptyReadResult('resync_required', normalizedAfter, wire);
    const throughCandidate = validateCursorCandidate(decodedThrough, candidates);
    if (!throughCandidate) return emptyReadResult('resync_required', normalizedAfter, wire);
    fixedThrough = fixedCandidate(throughCandidate, decodedThrough.length);
    fixedThroughCursor = normalizedThrough;
  }

  if (normalizedAfter === null) {
    if (normalizedPageToken !== null) throw new TypeError('snapshot does not accept a page token');
    const historyTruncated = fixedThrough.chain.length > limit;
    const pageEntries = fixedThrough.chain.slice(-limit);
    return projectReadPage({
      status: 'snapshot', afterCursor: null, throughCursor: fixedThroughCursor,
      current: fixedThrough, pageEntries, project, dbPath, maxBodyChars, maxTotalChars,
      historyTruncated, complete: true, nextToken: null, wire,
    });
  }

  const decodedAfter = decodeCursorForRead(normalizedAfter, projectSha256);
  if (!decodedAfter) return emptyReadResult('resync_required', normalizedAfter, wire);
  const afterCandidate = validateCursorCandidate(decodedAfter, candidates);
  if (!afterCandidate || fixedThrough.host === null && decodedAfter.host !== null) {
    return emptyReadResult('resync_required', normalizedAfter, wire);
  }

  const series = logicalDeltaSeries(decodedAfter, fixedThrough);
  if (!series) return emptyReadResult('resync_required', normalizedAfter, wire);
  const { status, entries } = series;
  let offset = 0;
  if (decodedPageToken !== null) {
    validatePageTokenPrefix(decodedPageToken, entries);
    offset = decodedPageToken.offset;
  }
  const pageEntries = entries.slice(offset, offset + limit);
  const nextOffset = offset + pageEntries.length;
  const complete = nextOffset >= entries.length;
  const nextToken = complete ? null : encodeObserverPageToken(pageTokenShape({
    projectSha256, afterCursor: normalizedAfter, throughCursor: fixedThroughCursor,
    offset: nextOffset, entries,
  }));
  return projectReadPage({
    status, afterCursor: normalizedAfter, throughCursor: fixedThroughCursor,
    current: fixedThrough, pageEntries, project, dbPath, maxBodyChars, maxTotalChars,
    historyTruncated: false, complete, nextToken, wire,
  });
}

export function encodeObserverCursor(value) {
  validateCursorShape(value);
  return `${CURSOR_PREFIX}${Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')}`;
}

export function decodeObserverCursor(token) {
  if (typeof token !== 'string' || token.length > 4096 || !token.startsWith(CURSOR_PREFIX)) {
    throw new TypeError('observer cursor invalid');
  }
  let value;
  try { value = JSON.parse(Buffer.from(token.slice(CURSOR_PREFIX.length), 'base64url').toString('utf8')); } catch { throw new TypeError('observer cursor invalid'); }
  validateCursorShape(value);
  return value;
}

function claudeCandidates(projectPath, receiptOptions) {
  const snapshot = readCompletedTurnReceiptSnapshot({ projectPath, ...(receiptOptions ?? {}) });
  const grouped = new Map();
  for (const receipt of snapshot.receipts) {
    const threadHash = sha256(receipt.target_session_id);
    const chain = grouped.get(threadHash) ?? [];
    chain.push({
      host: 'claude', thread_sha256: threadHash, origin_sha256: sha256(receipt.origin_session_id),
      user_sha256: receipt.user_sha256, assistant_sha256: receipt.assistant_sha256,
      completed_at: receipt.completed_at, source_sha256: sha256(`claude:${receipt.sequence}`), _sessionId: receipt.target_session_id,
    });
    grouped.set(threadHash, chain);
  }
  return [...grouped].map(([threadHash, chain]) => candidate('claude', threadHash, chain, snapshot.history_floor, chain.at(-1)?._sessionId ?? null));
}

function codexCandidates(projectPath, codexHome) {
  return listCodexThreadCandidates({ codexHome, projectPath, limit: Number.MAX_SAFE_INTEGER })
    .map((item) => {
      const parsed = parseCodexRolloutFile(item.rolloutPath);
      const chain = parsed.activeTurns.flatMap((turn) => codexTurnEntry(turn, item.id, item.rolloutPath));
      return candidate('codex', sha256(item.id), chain, 1, buildCodexThroughlineSessionId(item.id));
    })
    .filter((item) => item.chain.length > 0);
}

function codexTurnEntry(turn, threadId, rolloutPath) {
  if (!Number.isSafeInteger(turn.completedAt) || turn.completedAt < 0) return [];
  const sessionId = buildCodexThroughlineSessionId(threadId);
  const rows = buildBodyRowsFromActiveTurns([turn], { sessionId, now: turn.completedAt });
  const user = rows.find((row) => row.role === 'user');
  const assistant = rows.find((row) => row.role === 'assistant');
  if (!user || !assistant) return [];
  return [{
    host: 'codex', thread_sha256: sha256(threadId), origin_sha256: hashAuditorBody(sessionId),
    user_sha256: hashAuditorBody(user.text), assistant_sha256: hashAuditorBody(assistant.text),
    completed_at: turn.completedAt, source_sha256: sha256(`${rolloutPath}\0${turn.number}`),
  }];
}

function candidate(host, threadHash, chain, historyFloor, sessionId) {
  return { host, threadHash, chain, historyFloor, latestAt: chain.at(-1)?.completed_at ?? -1,
    sourceHash: chain.at(-1)?.source_sha256 ?? sha256(`${host}:${threadHash}`), sessionId };
}

function emptyCandidate() { return { host: null, threadHash: null, chain: [], historyFloor: 1, latestAt: -1, sourceHash: null, sessionId: null }; }

function selectLatest(candidates) {
  if (candidates.length === 0) return null;
  const latestAt = Math.max(...candidates.map((item) => item.latestAt));
  const latest = candidates.filter((item) => item.latestAt === latestAt);
  if (new Set(latest.map((item) => item.host)).size > 1) return { ambiguous: true };
  return latest.sort((a, b) => b.threadHash.localeCompare(a.threadHash) || b.sourceHash.localeCompare(a.sourceHash))[0];
}

function cursorShape(current, projectSha256) {
  return {
    schema: OBSERVER_CURSOR_SCHEMA, project_sha256: projectSha256, host: current.host,
    thread_sha256: current.threadHash, history_floor: current.historyFloor,
    length: current.chain.length, prefix_sha256: prefixDigest(current.chain),
  };
}

function publicResult(status, afterCursor, throughCursor, current) {
  return {
    schema: OBSERVER_CURSOR_SCHEMA, status, afterCursor, throughCursor,
    host: current.host, thread_sha256: current.threadHash,
    chain: current.chain.map(({ _sessionId: _sessionId, ...entry }) => ({ ...entry })),
  };
}

function withProjection(result, current, projectPath, { dbPath, maxBodyChars, maxTotalChars }) {
  if (!dbPath || current.chain.length === 0 || result.status === 'resync_required') return result;
  const projection = readCompletedPairProjection({
    dbPath, sessionId: current.sessionId, projectRoot: projectPath,
    expectedPairs: current.chain.map(({ origin_sha256, user_sha256, assistant_sha256 }) => ({ origin_sha256, user_sha256, assistant_sha256 })),
    ...(maxBodyChars === undefined ? {} : { maxBodyChars }),
    ...(maxTotalChars === undefined ? {} : { maxTotalChars }),
  });
  if (projection.status === 'pending') return { ...result, status: 'projection_pending', throughCursor: null, turns: [] };
  return { ...result, turns: projection.turns };
}

function decodeCursorForRead(token, projectSha256) {
  let decoded;
  try { decoded = decodeObserverCursor(token); } catch { return null; }
  return decoded.project_sha256 === projectSha256 ? decoded : null;
}

function validateCursorCandidate(cursor, candidates) {
  if (cursor.host === null) return emptyCandidate();
  const current = candidates.find((item) => item.host === cursor.host && item.threadHash === cursor.thread_sha256);
  if (!current || cursor.history_floor < current.historyFloor || cursor.length > current.chain.length ||
    prefixDigest(current.chain.slice(0, cursor.length)) !== cursor.prefix_sha256) return null;
  return current;
}

function fixedCandidate(current, length) {
  const chain = current.chain.slice(0, length);
  return {
    ...current, chain, latestAt: chain.at(-1)?.completed_at ?? -1,
    sourceHash: chain.at(-1)?.source_sha256 ?? current.sourceHash,
  };
}

function logicalDeltaSeries(after, through) {
  if (after.host === null) return { status: 'delta', entries: through.chain };
  if (through.host === null) return null;
  if (after.host !== through.host) return { status: 'host_switched', entries: through.chain };
  if (after.thread_sha256 !== through.threadHash) return { status: 'thread_switched', entries: through.chain };
  if (after.length > through.chain.length || prefixDigest(through.chain.slice(0, after.length)) !== after.prefix_sha256) return null;
  return { status: 'delta', entries: through.chain.slice(after.length) };
}

function projectReadPage({
  status, afterCursor, throughCursor, current, pageEntries, project, dbPath,
  maxBodyChars, maxTotalChars, historyTruncated, complete, nextToken, wire,
}) {
  const v2 = wire === 'v2';
  const host = v2 ? harnessOf(current) : current.host;
  const base = {
    schema: v2 ? OBSERVER_READ_SCHEMA_V2 : OBSERVER_READ_SCHEMA, status, host, thread_sha256: current.threadHash,
    afterCursor, throughCursor, turns: [], historyTruncated,
    page: { complete, nextToken },
  };
  if (pageEntries.length === 0) return base;
  const projection = readCompletedPairProjection({
    ...(dbPath === undefined ? {} : { dbPath }), sessionId: current.sessionId, projectRoot: project,
    expectedPairs: pageEntries.map(({ origin_sha256, user_sha256, assistant_sha256 }) => ({ origin_sha256, user_sha256, assistant_sha256 })),
    ...(v2 ? { fullBodies: true } : {}),
    ...(!v2 && maxBodyChars !== undefined ? { maxBodyChars } : {}),
    ...(!v2 && maxTotalChars !== undefined ? { maxTotalChars } : {}),
  });
  if (projection.status === 'pending') {
    return { ...base, status: 'projection_pending', throughCursor: null, page: { complete: false, nextToken: null } };
  }
  if (!v2) {
    return {
      ...base,
      turns: pageEntries.map((entry, index) => ({ ...publicTurnEntry(entry), ...projection.turns[index] })),
    };
  }
  return {
    ...base,
    turns: pageEntries.map((entry, index) => {
      const { turn_start: storedStart, ...projected } = projection.turns[index];
      return {
        ...publicTurnEntry(entry), ...projected, host,
        // Codex は入力でしかターンを始めず、feed は user 発言のある rollout turn だけを載せる。
        turn_start: host === CODEX_HOST ? TURN_START_PROMPT : publicTurnStart(storedStart),
      };
    }),
  };
}

/** receipt lane は Claude 互換 hook を共有するため、実際の harness は session ID から求める。 */
function harnessOf(current) {
  if (current.host === null) return null;
  if (current.host === CODEX_HOST) return CODEX_HOST;
  return hostOfSessionId(current.sessionId);
}

function publicTurnEntry({ _sessionId: _sessionId, ...entry }) { return entry; }

function emptyReadResult(status, afterCursor, wire = 'v1') {
  return {
    schema: wire === 'v2' ? OBSERVER_READ_SCHEMA_V2 : OBSERVER_READ_SCHEMA, status, host: null, thread_sha256: null,
    afterCursor, throughCursor: null, turns: [], historyTruncated: false,
    page: { complete: true, nextToken: null },
  };
}

function pageTokenShape({ projectSha256, afterCursor, throughCursor, offset, entries }) {
  return {
    schema: OBSERVER_PAGE_SCHEMA, project_sha256: projectSha256,
    after_sha256: cursorTokenDigest(afterCursor), through_sha256: cursorTokenDigest(throughCursor),
    offset, offset_prefix_sha256: prefixDigest(entries.slice(0, offset)),
  };
}

function encodeObserverPageToken(value) {
  validatePageTokenShape(value);
  return `${PAGE_PREFIX}${Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')}`;
}

function decodeObserverPageToken(token) {
  if (typeof token !== 'string' || token.length > 4096 || !token.startsWith(PAGE_PREFIX)) {
    throw new TypeError('observer page token invalid');
  }
  const encoded = token.slice(PAGE_PREFIX.length);
  let value;
  try {
    const bytes = Buffer.from(encoded, 'base64url');
    if (bytes.toString('base64url') !== encoded) throw new TypeError('non-canonical token');
    const json = bytes.toString('utf8');
    value = JSON.parse(json);
    if (JSON.stringify(value) !== json) throw new TypeError('non-canonical token');
  } catch { throw new TypeError('observer page token invalid'); }
  validatePageTokenShape(value);
  return value;
}

function validatePageTokenBinding(token, { projectSha256, afterCursor, throughCursor }) {
  if (token.project_sha256 !== projectSha256 || token.after_sha256 !== cursorTokenDigest(afterCursor) ||
    token.through_sha256 !== cursorTokenDigest(throughCursor)) {
    throw new TypeError('observer page token binding invalid');
  }
}

function validatePageTokenPrefix(token, entries) {
  if (token.offset > entries.length || token.offset_prefix_sha256 !== prefixDigest(entries.slice(0, token.offset))) {
    throw new TypeError('observer page token binding invalid');
  }
}

function cursorTokenDigest(value) { return sha256(value === null ? 'null' : value); }

function prefixDigest(chain) {
  return sha256(chain.map((entry) => [entry.host, entry.thread_sha256, entry.origin_sha256,
    entry.user_sha256, entry.assistant_sha256, entry.completed_at, entry.source_sha256].join('\0')).join('\n'));
}

function canonicalExistingProject(value) {
  if (typeof value !== 'string' || !isAbsolute(value) || !existsSync(value) || !statSync(value).isDirectory()) {
    throw new TypeError('projectPath must be an existing absolute directory');
  }
  return realpathSync.native(value);
}

function sha256(value) { return createHash('sha256').update(String(value), 'utf8').digest('hex'); }
function isSha256(value) { return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value); }
function assertPageLimit(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_PAGE_LIMIT) {
    throw new TypeError(`limit must be an integer between 1 and ${MAX_PAGE_LIMIT}`);
  }
}
function validatePageTokenShape(value) {
  const keys = ['schema', 'project_sha256', 'after_sha256', 'through_sha256', 'offset', 'offset_prefix_sha256'];
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length ||
    keys.some((key) => !(key in value)) || value.schema !== OBSERVER_PAGE_SCHEMA ||
    !isSha256(value.project_sha256) || !isSha256(value.after_sha256) || !isSha256(value.through_sha256) ||
    !Number.isSafeInteger(value.offset) || value.offset < 0 || !isSha256(value.offset_prefix_sha256)) {
    throw new TypeError('observer page token invalid');
  }
}
function validateCursorShape(value) {
  const keys = ['schema', 'project_sha256', 'host', 'thread_sha256', 'history_floor', 'length', 'prefix_sha256'];
  const emptyPrefix = prefixDigest([]);
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length ||
    keys.some((key) => !(key in value)) || value.schema !== OBSERVER_CURSOR_SCHEMA || !isSha256(value.project_sha256) ||
    !isSha256(value.prefix_sha256) || !Number.isSafeInteger(value.history_floor) || value.history_floor < 1 ||
    !Number.isSafeInteger(value.length) || value.length < 0 ||
    !((value.host === null && value.thread_sha256 === null && value.length === 0 && value.history_floor === 1 && value.prefix_sha256 === emptyPrefix) ||
      (['claude', 'codex'].includes(value.host) && isSha256(value.thread_sha256) && value.length >= 1))) {
    throw new TypeError('observer cursor invalid');
  }
}
