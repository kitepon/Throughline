import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';

const ROLLOUT_RE =
  /^rollout-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/;

export function defaultCodexHome() {
  return process.env.CODEX_HOME || join(homedir(), '.codex');
}

/**
 * sessionMetaCache ({ entries: Map, dirty }) is optional. A rollout's session_meta line is written once and the
 * file only grows, so its cwd is reused while dev/ino match and the file is not smaller than when it was read;
 * this skips opening every rollout on each call.
 */
export function listCodexThreadCandidates({
  codexHome = defaultCodexHome(),
  projectPath = process.cwd(),
  allProjects = false,
  limit = 10,
  sessionMetaCache,
} = {}) {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error('limit must be an integer >= 1');
  }

  const index = readSessionIndex(codexHome);
  const rollouts = findRolloutFiles(join(codexHome, 'sessions'));
  const normalizedProject = normalizePath(projectPath);

  const projectOf = new Map(); // cwd -> matches; normalizePath hits the disk, and rollouts share few cwds
  const candidates = rollouts
    .map((rollout) => {
      const meta = cachedSessionMeta(rollout, sessionMetaCache);
      const indexed = index.get(rollout.threadId) ?? {};
      const cwd = meta?.cwd ?? null;
      if (cwd && !projectOf.has(cwd)) projectOf.set(cwd, isSameProjectOrDescendant(normalizePath(cwd), normalizedProject));
      const matchesProject = cwd ? projectOf.get(cwd) : false;
      return {
        id: rollout.threadId,
        threadName: indexed.thread_name ?? null,
        updatedAt: rollout.mtimeIso,
        indexedUpdatedAt: indexed.updated_at ?? null,
        rolloutStartedAt: rollout.startedAt,
        rolloutPath: rollout.path,
        cwd,
        source: meta?.source ?? null,
        cliVersion: meta?.cli_version ?? null,
        matchesProject,
        mtimeMs: rollout.mtimeMs,
      };
    })
    .filter((candidate) => allProjects || candidate.matchesProject)
    .sort(compareCandidates);

  if (sessionMetaCache) pruneSessionMetaCache(sessionMetaCache, rollouts);
  return candidates.slice(0, limit);
}

export function findCodexThreadCandidate({
  threadId,
  codexHome = defaultCodexHome(),
  projectPath = process.cwd(),
  requireProjectMatch = true,
} = {}) {
  if (typeof threadId !== 'string' || threadId.length === 0) {
    throw new Error('threadId is required');
  }

  const index = readSessionIndex(codexHome);
  const rollouts = findRolloutFiles(join(codexHome, 'sessions'));
  const normalizedProject = normalizePath(projectPath);

  const matches = rollouts
    .filter((rollout) => rollout.threadId === threadId)
    .map((rollout) => {
      const meta = readSessionMeta(rollout.path);
      const indexed = index.get(rollout.threadId) ?? {};
      const cwd = meta?.cwd ?? null;
      const matchesProject = cwd ? isSameProjectOrDescendant(normalizePath(cwd), normalizedProject) : false;
      return {
        id: rollout.threadId,
        threadName: indexed.thread_name ?? null,
        updatedAt: rollout.mtimeIso,
        indexedUpdatedAt: indexed.updated_at ?? null,
        rolloutStartedAt: rollout.startedAt,
        rolloutPath: rollout.path,
        cwd,
        source: meta?.source ?? null,
        cliVersion: meta?.cli_version ?? null,
        forkedFromId: typeof meta?.forked_from_id === 'string' && meta.forked_from_id ? meta.forked_from_id : null,
        matchesProject,
        mtimeMs: rollout.mtimeMs,
      };
    })
    .filter((candidate) => !requireProjectMatch || candidate.matchesProject)
    .sort(compareCandidates);

  return matches[0] ?? null;
}

export function readSessionIndex(codexHome = defaultCodexHome()) {
  const path = join(codexHome, 'session_index.jsonl');
  const index = new Map();
  if (!existsSync(path)) return index;

  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row && typeof row.id === 'string') {
        index.set(row.id, row);
      }
    } catch {
      // Corrupt index rows are ignored; rollout files remain the source of candidates.
    }
  }
  return index;
}

function findRolloutFiles(root) {
  if (!existsSync(root)) return [];

  const out = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(path);
        continue;
      }
      if (!entry.isFile()) continue;
      const match = ROLLOUT_RE.exec(entry.name);
      if (!match) continue;
      const stat = statSync(path);
      out.push({
        path,
        threadId: match[2],
        startedAt: match[1],
        dev: stat.dev,
        ino: stat.ino,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        mtimeIso: stat.mtime.toISOString(),
      });
    }
  }
  return out;
}

function cachedSessionMeta(rollout, cache) {
  const hit = cache?.entries.get(rollout.path);
  if (hit && hit.dev === rollout.dev && hit.ino === rollout.ino && rollout.size >= hit.size) return hit.meta;
  const meta = readSessionMeta(rollout.path);
  // A missing or half-written first line is not cached; it is read again next time.
  if (cache && typeof meta?.cwd === 'string' && meta.cwd) {
    cache.entries.set(rollout.path, { dev: rollout.dev, ino: rollout.ino, size: rollout.size, meta: { cwd: meta.cwd, source: meta.source, cli_version: meta.cli_version } });
    cache.dirty = true;
  }
  return meta;
}

function pruneSessionMetaCache(cache, rollouts) {
  const live = new Set(rollouts.map((rollout) => rollout.path));
  for (const path of cache.entries.keys()) if (!live.has(path)) { cache.entries.delete(path); cache.dirty = true; }
}

function readSessionMeta(path) {
  const firstLine = readFirstLine(path);
  if (!firstLine?.trim()) return null;
  try {
    const row = JSON.parse(firstLine);
    if (row?.type !== 'session_meta' || !row.payload) return null;
    return row.payload;
  } catch {
    return null;
  }
}

const FIRST_LINE_BUFFER = Buffer.allocUnsafe(64 * 1024);

function readFirstLine(path) {
  const fd = openSync(path, 'r');
  try {
    const bytes = readSync(fd, FIRST_LINE_BUFFER, 0, FIRST_LINE_BUFFER.length, 0);
    const newline = FIRST_LINE_BUFFER.subarray(0, bytes).indexOf(10);
    return FIRST_LINE_BUFFER.toString('utf8', 0, newline < 0 ? bytes : newline); // decode one line, not 64 KiB
  } finally {
    closeSync(fd);
  }
}

function compareCandidates(a, b) {
  if (a.mtimeMs !== b.mtimeMs) {
    return b.mtimeMs - a.mtimeMs;
  }
  return String(b.rolloutPath).localeCompare(String(a.rolloutPath));
}

function normalizePath(value) {
  const raw = String(value);
  if (/^[A-Za-z]:[\\/]/.test(raw)) {
    let resolved = raw;
    try {
      if (existsSync(raw)) resolved = realpathSync.native(raw);
    } catch {
      // Keep the lexical Windows path when it cannot be resolved.
    }
    return resolved.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  }
  let resolved = resolve(value);
  try {
    if (existsSync(resolved)) resolved = realpathSync.native(resolved);
  } catch {
    // Keep the lexical path when it cannot be resolved.
  }
  return resolved.split(sep).join('/').replace(/\/+$/, '');
}

function isSameProjectOrDescendant(candidate, root) {
  if (!candidate || !root) return false;
  return candidate === root || candidate.startsWith(`${root}/`);
}

export { normalizePath as normalizeCodexProjectPath, isSameProjectOrDescendant as isCodexProjectOrDescendant };
