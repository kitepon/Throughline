// Read-only fork isolation (docs/architecture/fork-session-isolation.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb, openReadOnlyDb } from './db.mjs';
import {
  forkIdentityFromEnv, isForkSession, mainSessionFilter, markForkSession, markForkSessionFromEnv, readSessionKind,
} from './session-kind.mjs';
import { mergeSpecificPredecessor } from './session-merger.mjs';
import { captureCodexRolloutToDb } from './codex-capture.mjs';
import { ingestRemoteTranscript, readRemoteHandoffContext } from './remote-ingest.mjs';
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

// Entrypoints label the row before writing bodies.
function addFork(db, sessionId, at, text) {
  addSession(db, sessionId, at, null);
  assert.equal(markForkSession(db, sessionId, FORK), 'marked');
  addSession(db, sessionId, at, text);
}

test('a newer fork never becomes the latest or recent main session', () => {
  withDb((db, dbPath) => {
    addSession(db, 'main-old', 1_000, 'MAIN-BODY');
    addFork(db, 'fork-new', 2_000, 'FORK-BODY');

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
    addFork(db, 'fork-only', 1_000, 'FORK-BODY');
    assert.equal(readLatestProjectHandoffContext(PROJECT, { dbPath }), null);
    assert.equal(readRecentProjectHandoffContext(PROJECT, { dbPath }), null);
  });
});

test('explicit reads keep fork records and expose the label', () => {
  withDb((db, dbPath) => {
    addFork(db, 'fork-new', 2_000, 'FORK-BODY');
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
    addFork(db, 'fork-new', 2_000, null);
    addSession(db, 'fork-new', 3_000, null); // later capture INSERT OR IGNORE
    db.prepare('UPDATE sessions SET updated_at = ? WHERE session_id = ?').run(4_000, 'fork-new');
    const ro = openReadOnlyDb(dbPath);
    try {
      assert.equal(isForkSession(ro, 'fork-new'), true);
    } finally {
      ro.close();
    }
  });
});

test('a fork neither absorbs nor is absorbed into main records', () => {
  withDb((db) => {
    addSession(db, 'main-old', 1_000, 'MAIN-BODY');
    addFork(db, 'fork-new', 2_000, 'FORK-BODY');
    addSession(db, 'main-new', 3_000, null);

    assert.equal(mergeSpecificPredecessor(db, { newSessionId: 'fork-new', predecessorId: 'main-old' }).skipReason, 'fork_session');
    assert.equal(mergeSpecificPredecessor(db, { newSessionId: 'main-new', predecessorId: 'fork-new' }).skipReason, 'fork_session');
    const owners = db.prepare('SELECT DISTINCT session_id FROM bodies ORDER BY session_id').all().map((r) => r.session_id);
    assert.deepEqual(owners, ['fork-new', 'main-old']);
  });
});

test('a fork leaves the main pending handoff and baton untouched', () => {
  withDb((db) => {
    addFork(db, 'fork-new', 2_000, null);
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

test('the Aiterm env marker is the only fork authority', () => {
  assert.equal(forkIdentityFromEnv({}), null);
  assert.equal(forkIdentityFromEnv({ THROUGHLINE_PARENT_SESSION_ID: 'seat-main' }), null);
  assert.deepEqual(forkIdentityFromEnv({ THROUGHLINE_SESSION_KIND: 'fork', THROUGHLINE_PARENT_SESSION_ID: 'seat-main' }),
    { forkId: null, parentSessionId: 'seat-main' });
  withDb((db) => {
    assert.equal(markForkSessionFromEnv(db, 'plain', PROJECT, {}), null);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);
    const env = { THROUGHLINE_SESSION_KIND: 'fork', THROUGHLINE_PARENT_SESSION_ID: 'seat-main', THROUGHLINE_FORK_ID: 'f-9' };
    assert.equal(markForkSessionFromEnv(db, 'fork-a', PROJECT, env), 'marked');
    assert.equal(markForkSessionFromEnv(db, 'fork-a', PROJECT, env), 'marked'); // resumed fork keeps it
    assert.deepEqual(readSessionKind(db, 'fork-a'), { kind: 'fork', forkId: 'f-9', parentSessionId: 'seat-main' });
  });
});

test('a session that already holds main records is never relabelled as a fork', () => {
  withDb((db) => {
    addSession(db, 'main-old', 1_000, 'MAIN-BODY');
    assert.equal(markForkSession(db, 'main-old', FORK), 'main_records_exist');
    assert.equal(isForkSession(db, 'main-old'), false);
    assert.equal(markForkSession(db, 'absent', FORK), 'session_missing');
  });
});

function writeCodexRollout(home, id, cwd, meta = {}) {
  const dir = join(home, 'sessions', '2026', '11', '10');
  mkdirSync(dir, { recursive: true });
  const at = '2026-11-10T00:00:00.000Z';
  const rows = [
    { timestamp: at, type: 'session_meta', payload: { id, timestamp: at, cwd, source: 'cli', cli_version: '0.200.0', ...meta } },
    ...[['user_message', { message: 'codex question' }], ['task_started', {}], ['agent_message', { message: 'codex answer' }], ['task_complete', {}]]
      .map(([type, payload]) => ({ timestamp: at, type: 'event_msg', payload: { type, ...payload } })),
  ];
  writeFileSync(join(dir, `rollout-2026-11-10T00-00-00-${id}.jsonl`), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

test('Codex capture labels a fork only when the env marker and forked_from_id agree', () => {
  withDb((db) => {
    const home = mkdtempSync(join(tmpdir(), 'tl-fork-codex-'));
    try {
      const forked = '019e0000-0000-7000-8000-000000000001';
      const plain = '019e0000-0000-7000-8000-000000000002';
      const userFork = '019e0000-0000-7000-8000-000000000003';
      writeCodexRollout(home, forked, PROJECT, { forked_from_id: '019e0000-0000-7000-8000-0000000000aa' });
      writeCodexRollout(home, plain, PROJECT);
      writeCodexRollout(home, userFork, PROJECT, { forked_from_id: '019e0000-0000-7000-8000-0000000000aa' });
      const fork = { forkId: null, parentSessionId: 'seat-main' };
      const capture = (threadId, f) => captureCodexRolloutToDb(db, { threadId, codexHome: home, projectPath: PROJECT, fork: f });

      assert.equal(capture(forked, fork).forkLabel, 'marked');
      assert.equal(capture(forked, fork).forkLabel, 'marked'); // recapture keeps the label over its own bodies
      assert.equal(capture(plain, fork).forkLabel, 'not_fork_rollout');
      assert.equal(capture(userFork, null).forkLabel, null); // native fork without the Aiterm marker stays main
      assert.equal(isForkSession(db, `codex:${forked}`), true);
      assert.equal(isForkSession(db, `codex:${plain}`), false);
      assert.equal(isForkSession(db, `codex:${userFork}`), false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

test('remote intake persists the fork label and keeps it out of remote handoff memory', () => {
  const home = mkdtempSync(join(tmpdir(), 'tl-fork-remote-'));
  try {
    const line = (role, text, at) => JSON.stringify({ type: role,
      message: { role, content: [{ type: 'text', text }] }, timestamp: new Date(at).toISOString() }) + '\n';
    const send = (claudeSessionId, text, at, extra = {}) => {
      const entries = [line('user', `${text} question`, at), line('assistant', `${text} answer`, at + 1)];
      return ingestRemoteTranscript({ botId: 'bot-r', sessionName: 'bot-r', launchId: 'b'.repeat(32), claudeSessionId, entries,
        cursor: { claudeSessionId, offset: Buffer.byteLength(entries.join('')) }, ...extra }, { home, now: at });
    };
    send('claude-main', 'MAIN-BODY', 1_700_000_000_000);
    send('claude-fork', 'FORK-BODY', 1_700_000_010_000, { sessionKind: 'fork', parentSessionId: 'seat-main', forkId: 'f-1' });
    const memory = readRemoteHandoffContext('bot-r', { home });
    assert.match(memory.context, /MAIN-BODY/u);
    assert.doesNotMatch(memory.context, /FORK-BODY/u);
    assert.throws(() => send('claude-x', 'X', 1_700_000_020_000, { sessionKind: 'main' }), TypeError);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
