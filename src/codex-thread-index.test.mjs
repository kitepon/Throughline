import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  findCodexThreadCandidate,
  listCodexThreadCandidates,
  readSessionIndex,
} from './codex-thread-index.mjs';

test('readSessionIndex: reads JSONL rows and ignores corrupt rows', () => {
  const home = mkdtempSync(join(tmpdir(), 'tl-codex-home-'));
  try {
    writeFileSync(
      join(home, 'session_index.jsonl'),
      [
        '{"id":"thread-a","thread_name":"Work A","updated_at":"2026-05-06T01:00:00Z"}',
        '{broken',
        '{"id":"thread-b","thread_name":"Work B","updated_at":"2026-05-06T02:00:00Z"}',
        '',
      ].join('\n'),
    );

    const index = readSessionIndex(home);
    assert.equal(index.get('thread-a').thread_name, 'Work A');
    assert.equal(index.get('thread-b').updated_at, '2026-05-06T02:00:00Z');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('listCodexThreadCandidates: filters rollouts to current project and merges index metadata', () => {
  const home = mkdtempSync(join(tmpdir(), 'tl-codex-home-'));
  const project = mkdtempSync(join(tmpdir(), 'tl-codex-project-'));
  const otherProject = mkdtempSync(join(tmpdir(), 'tl-codex-other-'));
  try {
    writeFileSync(
      join(home, 'session_index.jsonl'),
      '{"id":"019dfaba-f87e-7f41-a144-d5ca7c6dd7f9","thread_name":"Throughline work","updated_at":"2026-05-06T02:00:00Z"}\n',
    );
    writeRollout(home, {
      day: '06',
      started: '2026-05-06T09-40-50',
      id: '019dfaba-f87e-7f41-a144-d5ca7c6dd7f9',
      cwd: project,
    });
    writeRollout(home, {
      day: '06',
      started: '2026-05-06T09-41-50',
      id: '019dfabb-1111-7111-8111-111111111111',
      cwd: otherProject,
    });

    const candidates = listCodexThreadCandidates({ codexHome: home, projectPath: project });

    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].id, '019dfaba-f87e-7f41-a144-d5ca7c6dd7f9');
    assert.equal(candidates[0].threadName, 'Throughline work');
    assert.equal(candidates[0].cwd, project);
    assert.equal(candidates[0].matchesProject, true);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
    rmSync(otherProject, { recursive: true, force: true });
  }
});

test('listCodexThreadCandidates: POSIX project path matching preserves case', {
  skip: process.platform === 'win32' ? 'Windows paths are case-insensitive' : undefined,
}, () => {
  const home = mkdtempSync(join(tmpdir(), 'tl-codex-home-'));
  const root = mkdtempSync(join(tmpdir(), 'tl-codex-case-'));
  const project = join(root, 'Project');
  const other = join(root, 'project');
  try {
    writeRollout(home, { day: '06', started: '2026-05-06T09-40-50', id: '019dfaba-f87e-7f41-a144-d5ca7c6dd7f9', cwd: project });
    writeRollout(home, { day: '06', started: '2026-05-06T09-41-50', id: '019dfabb-1111-7111-8111-111111111111', cwd: other });
    const candidates = listCodexThreadCandidates({ codexHome: home, projectPath: project });
    assert.deepEqual(candidates.map((entry) => entry.cwd), [project]);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('listCodexThreadCandidates: sorts by rollout mtime rather than stale index updated_at', () => {
  const home = mkdtempSync(join(tmpdir(), 'tl-codex-home-'));
  const project = mkdtempSync(join(tmpdir(), 'tl-codex-project-'));
  try {
    writeFileSync(
      join(home, 'session_index.jsonl'),
      [
        '{"id":"019dfaba-f87e-7f41-a144-d5ca7c6dd7f9","thread_name":"Old index newer","updated_at":"2026-05-06T20:00:00Z"}',
        '{"id":"019dfa40-1cc8-7d13-a110-16b09364fa6a","thread_name":"Current file older index","updated_at":"2026-05-05T20:00:00Z"}',
        '',
      ].join('\n'),
    );
    const oldPath = writeRollout(home, {
      day: '06',
      started: '2026-05-06T09-40-50',
      id: '019dfaba-f87e-7f41-a144-d5ca7c6dd7f9',
      cwd: project,
    });
    const currentPath = writeRollout(home, {
      day: '06',
      started: '2026-05-06T07-26-38',
      id: '019dfa40-1cc8-7d13-a110-16b09364fa6a',
      cwd: project,
    });
    utimesSync(oldPath, new Date('2026-05-06T01:00:00Z'), new Date('2026-05-06T01:00:00Z'));
    utimesSync(currentPath, new Date('2026-05-06T03:00:00Z'), new Date('2026-05-06T03:00:00Z'));

    const candidates = listCodexThreadCandidates({ codexHome: home, projectPath: project });

    assert.equal(candidates[0].id, '019dfa40-1cc8-7d13-a110-16b09364fa6a');
    assert.equal(candidates[0].indexedUpdatedAt, '2026-05-05T20:00:00Z');
    assert.equal(candidates[1].id, '019dfaba-f87e-7f41-a144-d5ca7c6dd7f9');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});

test('findCodexThreadCandidate: requires current project match for explicit thread id', () => {
  const home = mkdtempSync(join(tmpdir(), 'tl-codex-home-'));
  const project = mkdtempSync(join(tmpdir(), 'tl-codex-project-'));
  const otherProject = mkdtempSync(join(tmpdir(), 'tl-codex-other-'));
  try {
    writeRollout(home, {
      day: '06',
      started: '2026-05-06T09-41-50',
      id: '019dfabb-1111-7111-8111-111111111111',
      cwd: otherProject,
    });

    assert.equal(
      findCodexThreadCandidate({
        threadId: '019dfabb-1111-7111-8111-111111111111',
        codexHome: home,
        projectPath: project,
      }),
      null,
    );

    const candidate = findCodexThreadCandidate({
      threadId: '019dfabb-1111-7111-8111-111111111111',
      codexHome: home,
      projectPath: project,
      requireProjectMatch: false,
    });
    assert.equal(candidate.id, '019dfabb-1111-7111-8111-111111111111');
    assert.equal(candidate.cwd, otherProject);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
    rmSync(otherProject, { recursive: true, force: true });
  }
});

function writeRollout(home, { day, started, id, cwd }) {
  const dir = join(home, 'sessions', '2026', '05', day);
  mkdirSync(dir, { recursive: true });
  const fileStarted = started.replace(/:/g, '-');
  const path = join(dir, `rollout-${fileStarted}-${id}.jsonl`);
  writeFileSync(
    path,
    JSON.stringify({
      timestamp: '2026-05-06T00:40:54.808Z',
      type: 'session_meta',
      payload: {
        id,
        timestamp: '2026-05-06T00:40:50.588Z',
        cwd,
        source: 'vscode',
        cli_version: '0.128.0-alpha.1',
      },
    }) + '\n',
  );
  return path;
}

test('listCodexThreadCandidates: sessionMetaCache reuses a rollout cwd by dev/ino and drops rollouts that are gone', () => {
  const home = mkdtempSync(join(tmpdir(), 'tl-codex-home-'));
  const project = mkdtempSync(join(tmpdir(), 'tl-codex-project-'));
  const moved = mkdtempSync(join(tmpdir(), 'tl-codex-moved-'));
  try {
    const id = '019dfaba-f87e-7f41-a144-d5ca7c6dd7f9';
    const path = writeRollout(home, { day: '06', started: '2026-05-06T09-40-50', id, cwd: project });
    const sessionMetaCache = { entries: new Map(), dirty: false };
    assert.equal(listCodexThreadCandidates({ codexHome: home, projectPath: project, sessionMetaCache }).length, 1);
    assert.equal(sessionMetaCache.dirty, true);
    assert.equal(sessionMetaCache.entries.get(path).meta.cwd, project);

    // The cwd comes from the cache while dev/ino match, so the file is not opened again.
    sessionMetaCache.entries.get(path).meta.cwd = moved;
    assert.equal(listCodexThreadCandidates({ codexHome: home, projectPath: project, sessionMetaCache }).length, 0);
    assert.equal(listCodexThreadCandidates({ codexHome: home, projectPath: moved, sessionMetaCache })[0].cwd, moved);

    sessionMetaCache.entries.get(path).ino += 1; // a different file at the same path is read again
    assert.equal(listCodexThreadCandidates({ codexHome: home, projectPath: project, sessionMetaCache }).length, 1);

    sessionMetaCache.entries.get(path).meta.cwd = moved;
    sessionMetaCache.entries.get(path).size = 1e9; // a file smaller than when read was rewritten: read again
    assert.equal(listCodexThreadCandidates({ codexHome: home, projectPath: project, sessionMetaCache }).length, 1);

    sessionMetaCache.entries.set(join(home, 'sessions', 'gone.jsonl'), { dev: 1, ino: 1, size: 1, meta: { cwd: project } });
    listCodexThreadCandidates({ codexHome: home, projectPath: project, sessionMetaCache });
    assert.deepEqual([...sessionMetaCache.entries.keys()], [path]);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
    rmSync(moved, { recursive: true, force: true });
  }
});
