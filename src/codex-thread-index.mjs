import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';

const ROLLOUT_RE =
  /^rollout-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/;

export function defaultCodexHome() {
  return process.env.CODEX_HOME || join(homedir(), '.codex');
}

export function listCodexThreadCandidates({
  codexHome = defaultCodexHome(),
  projectPath = process.cwd(),
  allProjects = false,
  limit = 10,
} = {}) {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error('limit must be an integer >= 1');
  }

  const index = readSessionIndex(codexHome);
  const rollouts = findRolloutFiles(join(codexHome, 'sessions'));
  const normalizedProject = normalizePath(projectPath);

  const candidates = rollouts
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
        matchesProject,
        mtimeMs: rollout.mtimeMs,
      };
    })
    .filter((candidate) => allProjects || candidate.matchesProject)
    .sort(compareCandidates);

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
        mtimeMs: stat.mtimeMs,
        mtimeIso: stat.mtime.toISOString(),
      });
    }
  }
  return out;
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

function readFirstLine(path) {
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(64 * 1024);
    const bytes = readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytes).toString('utf8').split('\n', 1)[0];
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
