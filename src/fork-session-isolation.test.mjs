// Read-only fork isolation (docs/architecture/fork-session-isolation.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb, openReadOnlyDb } from './db.mjs';
import { isForkSession, mainSessionFilter, markForkSession, readSessionKind } from './session-kind.mjs';
import { mergeSpecificPredecessor } from './session-merger.mjs';
import { executeFirstPromptHandoff } from './handoff-executor.mjs';
import { registerPendingHandoff } from './pending-handoff.mjs';
import {
  readExplicitSessionKind,
  readHandoffContext,
  readLatestProjectHandoffContext,
  readRecentProjectHandoffContext,
  run as runHandoffContext,
} from './cli/handoff-context.mjs';

const PROJECT = '/srv/bellteam/bots/bot-fork-test';

function withDb(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'tl-fork-'));
  const dbPath = join(dir, 'throughline.db');
  const db = openDb(dbPath);
  try {
    return fn(db, dbPath);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function addSession(db, sessionId, at, text) {
  db.prepare(
    `INSERT OR IGNORE INTO sessions (session_id, project_path, status, created_at, updated_at)
     VALUES (?, ?, 'active', ?, ?)`,
  ).run(sessionId, PROJECT, at, at);
  if (!text) return;
  const insert = db.prepare(
    `INSERT INTO bodies (session_id, origin_session_id, turn_number, role, text, created_at)
     VALUES (?, ?, 1, ?, ?, ?)`,
  );
  insert.run(sessionId, sessionId, 'user', `${text} question`, at);
  insert.run(sessionId, sessionId, 'assistant', `${text} answer`, at + 1);
}

const FORK = { forkId: 'fork-1', parentSessionId: 'main-old' };

test('a newer fork never becomes the latest or recent main session', () => {
  withDb((db, dbPath) => {
    addSession(db, 'main-old', 1_000, 'MAIN-BODY');
    addSession(db, 'fork-new', 2_000, 'FORK-BODY');
    assert.equal(markForkSession(db, 'fork-new', FORK), true);

    const latest = readLatestProjectHandoffContext(PROJECT, { dbPath });
    assert.equal(latest.sessionId, 'main-old');
    assert.match(latest.context, /MAIN-BODY/u);
    assert.doesNotMatch(latest.context, /FORK-BODY|fork-new/u);

    const recent = readRecentProjectHandoffContext(PROJECT, { dbPath });
    assert.equal(recent.sessionId, 'main-old');
    assert.doesNotMatch(recent.context, /FORK-BODY|fork-new/u);
    assert.deepEqual(recent.sessions.map((s) => s.sessionId), ['main-old']);
  });
});

test('a fork-only project yields no automatic memory', () => {
  withDb((db, dbPath) => {
    addSession(db, 'fork-only', 1_000, 'FORK-BODY');
    markForkSession(db, 'fork-only', FORK);
    assert.equal(readLatestProjectHandoffContext(PROJECT, { dbPath }), null);
    assert.equal(readRecentProjectHandoffContext(PROJECT, { dbPath }), null);
  });
});

test('explicit reads keep fork records and expose the label', () => {
  withDb((db, dbPath) => {
    addSession(db, 'fork-new', 2_000, 'FORK-BODY');
    markForkSession(db, 'fork-new', FORK);
    assert.match(readHandoffContext('fork-new', { dbPath }), /FORK-BODY/u);
    assert.deepEqual(readExplicitSessionKind('fork-new', { dbPath }), { kind: 'fork', ...FORK });

    let out = '';
    const code = runHandoffContext(['--session', 'fork-new', '--json'], {
      stdout: { write: (s) => { out += s; } },
      stderr: { write: () => {} },
      readContext: (id) => readHandoffContext(id, { dbPath }),
      readKind: (id) => readExplicitSessionKind(id, { dbPath }),
    });
    assert.equal(code, 0);
    const json = JSON.parse(out);
    assert.equal(json.sessionKind, 'fork');
    assert.equal(json.forkId, 'fork-1');
    assert.equal(json.parentSessionId, 'main-old');
  });
});

test('the label survives later captures and reopen', () => {
  withDb((db, dbPath) => {
    addSession(db, 'fork-new', 2_000, null);
    markForkSession(db, 'fork-new', FORK);
    addSession(db, 'fork-new', 3_000, null); // later capture INSERT OR IGNORE
    db.prepare('UPDATE sessions SET updated_at = ? WHERE session_id = ?').run(4_000, 'fork-new');
    const ro = openReadOnlyDb(dbPath);
    try {
      assert.equal(isForkSession(ro, 'fork-new'), true);
    } finally {
      ro.close();
    }
    assert.throws(() => markForkSession(db, 'fork-new', { forkId: '', parentSessionId: 'x' }), TypeError);
  });
});

test('a fork neither absorbs nor is absorbed into main records', () => {
  withDb((db) => {
    addSession(db, 'main-old', 1_000, 'MAIN-BODY');
    addSession(db, 'fork-new', 2_000, 'FORK-BODY');
    addSession(db, 'main-new', 3_000, null);
    markForkSession(db, 'fork-new', FORK);

    assert.equal(mergeSpecificPredecessor(db, { newSessionId: 'fork-new', predecessorId: 'main-old' }).skipReason, 'fork_session');
    assert.equal(mergeSpecificPredecessor(db, { newSessionId: 'main-new', predecessorId: 'fork-new' }).skipReason, 'fork_session');
    const owners = db.prepare('SELECT DISTINCT session_id FROM bodies ORDER BY session_id').all().map((r) => r.session_id);
    assert.deepEqual(owners, ['fork-new', 'main-old']);
  });
});

test('a fork leaves the main pending handoff and baton untouched', () => {
  withDb((db) => {
    addSession(db, 'fork-new', 2_000, null);
    markForkSession(db, 'fork-new', FORK);
    registerPendingHandoff(db, { sessionId: 'fork-new', projectPath: PROJECT, source: 'startup', autoPredecessorId: null, now: 2_000 });
    db.prepare('INSERT INTO handoff_batons (project_path, session_id, created_at) VALUES (?, ?, ?)').run(PROJECT, 'main-old', 1_500);

    const result = executeFirstPromptHandoff(db, { sessionId: 'fork-new', projectPath: PROJECT, now: 2_100 });
    assert.equal(result.attempted, false);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM handoff_batons').get().n, 1);
  });
});

test('a DB without the fork columns keeps ordinary main behaviour', () => {
  withDb((db) => {
    addSession(db, 'main-old', 1_000, 'MAIN-BODY');
    for (const col of ['session_kind', 'fork_id', 'fork_parent_session_id']) db.exec(`ALTER TABLE sessions DROP COLUMN ${col}`);
    assert.equal(mainSessionFilter(db), '');
    assert.equal(readSessionKind(db, 'main-old'), null);
    assert.equal(mergeSpecificPredecessor(db, { newSessionId: 'main-old', predecessorId: 'main-old' }).skipReason, 'self_handoff');
  });
});
