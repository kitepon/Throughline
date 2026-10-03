import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { CURRENT_VERSION } from './db.mjs';
import { decodeObserverCursor, encodeObserverCursor, readObserverTurnPage, resolveObserverTurnFeed } from './observer-turn-feed.mjs';
import { writeCompletedTurnReceipt } from './completed-turn-receipts.mjs';
import { seedCompletedTurnReceiptStore } from './completed-turn-receipts-test-fixture.mjs';
import { hashAuditorBody } from './body-digest.mjs';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'tl-observer-feed-'));
  const project = join(root, 'project'); const other = join(root, 'other'); const home = join(root, 'codex');
  mkdirSync(project); mkdirSync(other); mkdirSync(home);
  // LOCALAPPDATA も state へ向け、win32 (LOCALAPPDATA layout) と POSIX (XDG layout) で
  // receipt store の実パスを一致させる (テスト内の削除・検査パスを OS 非依存にする)
  return { root, project, other, home, receiptOptions: { env: { HOME: root, USERPROFILE: root, XDG_STATE_HOME: join(root, 'state'), LOCALAPPDATA: join(root, 'state') } } };
}
function writeRollout(home, project, id, events) {
  const dir = join(home, 'sessions', '2026', '07', '15'); mkdirSync(dir, { recursive: true });
  const path = join(dir, `rollout-2026-07-15T00-00-00-${id}.jsonl`);
  const rows = [{ type: 'session_meta', timestamp: '2026-07-15T00:00:00.000Z', payload: { id, cwd: project } }, ...events];
  writeFileSync(path, rows.map(JSON.stringify).join('\n'));
  return path;
}
function event(type, message, timestamp) { return { type: 'event_msg', timestamp, payload: { type, ...(message === undefined ? {} : { message }) } }; }
function completeEvents(at = '2026-07-15T00:01:00.000Z') { return [event('user_message', 'request', '2026-07-15T00:00:01.000Z'), event('task_started', undefined, '2026-07-15T00:00:02.000Z'), event('agent_message', 'answer', '2026-07-15T00:00:03.000Z'), event('task_complete', undefined, at)]; }
function createProjectionDb(path, project, sessionId) {
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA user_version = 9;
    CREATE TABLE sessions (session_id TEXT PRIMARY KEY, project_path TEXT NOT NULL);
    CREATE TABLE bodies (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, origin_session_id TEXT NOT NULL, turn_number INTEGER NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL);`);
  db.prepare('INSERT INTO sessions (session_id, project_path) VALUES (?, ?)').run(sessionId, project);
  return db;
}
function addClaudeTurn(box, db, { sessionId = 'claude-session', origin, turn, user, assistant, at }) {
  writeCompletedTurnReceipt({
    projectPath: box.project, targetSessionId: sessionId, originSessionId: origin,
    userBody: user, assistantBody: assistant, completedAt: at,
  }, box.receiptOptions);
  if (!db) return;
  const insert = db.prepare('INSERT INTO bodies (session_id, origin_session_id, turn_number, role, text, created_at) VALUES (?, ?, ?, ?, ?, ?)');
  insert.run(sessionId, origin, turn, 'user', user, at * 2);
  insert.run(sessionId, origin, turn, 'assistant', assistant, at * 2 + 1);
}
function rewritePageToken(token, mutate) {
  const prefix = 'tlp1.';
  const value = JSON.parse(Buffer.from(token.slice(prefix.length), 'base64url').toString('utf8'));
  mutate(value);
  return `${prefix}${Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')}`;
}

test('observer feed: in-flight DB recordとStop continuationは最終task_completeまでchainを進めない', () => {
  const box = fixture();
  const dbPath = join(box.root, 'throughline.db');
  let db;
  try {
    const id = '019dfaba-f87e-7f41-a144-d5ca7c6dd7f9';
    const sessionId = `codex:${id}`;
    db = createProjectionDb(dbPath, box.project, sessionId);
    const insert = db.prepare('INSERT INTO bodies (session_id, origin_session_id, turn_number, role, text, created_at) VALUES (?, ?, ?, ?, ?, ?)');
    insert.run(sessionId, sessionId, 1, 'user', 'in-flight request', 1);
    insert.run(sessionId, sessionId, 1, 'assistant', 'in-flight answer', 2);
    writeRollout(box.home, box.project, id, completeEvents().slice(0, 3));
    const dbAhead = resolveObserverTurnFeed({ projectPath: box.project, codexHome: box.home, receiptOptions: box.receiptOptions, dbPath });
    assert.equal(dbAhead.status, 'snapshot');
    assert.equal(dbAhead.chain.length, 0, 'DBにpair本文があってもrollout未完了turnをcompleted feedへ出さない');
    const emptyCursor = decodeObserverCursor(dbAhead.throughCursor);
    assert.equal(emptyCursor.host, null);
    assert.equal(emptyCursor.thread_sha256, null);
    assert.equal(emptyCursor.length, 0);

    writeRollout(box.home, box.project, id, completeEvents());
    const baseline = resolveObserverTurnFeed({ projectPath: box.project, codexHome: box.home, receiptOptions: box.receiptOptions });
    writeRollout(box.home, box.project, id, [
      ...completeEvents(),
      event('user_message', 'continuation request', '2026-07-15T00:01:01.000Z'),
      event('task_started', undefined, '2026-07-15T00:01:02.000Z'),
      event('agent_message', 'Stop continuation', '2026-07-15T00:01:03.000Z'),
    ]);
    const beforeFinalComplete = resolveObserverTurnFeed({ projectPath: box.project, cursor: baseline.throughCursor, codexHome: box.home, receiptOptions: box.receiptOptions });
    assert.equal(beforeFinalComplete.status, 'unchanged');
    assert.equal(beforeFinalComplete.throughCursor, baseline.throughCursor);
    assert.equal(beforeFinalComplete.chain.length, 1);

    writeRollout(box.home, box.project, id, [
      ...completeEvents(),
      event('user_message', 'continuation request', '2026-07-15T00:01:01.000Z'),
      event('task_started', undefined, '2026-07-15T00:01:02.000Z'),
      event('agent_message', 'Stop continuation', '2026-07-15T00:01:03.000Z'),
      event('task_complete', undefined, '2026-07-15T00:01:04.000Z'),
    ]);
    const afterFinalComplete = resolveObserverTurnFeed({ projectPath: box.project, cursor: baseline.throughCursor, codexHome: box.home, receiptOptions: box.receiptOptions });
    assert.equal(afterFinalComplete.status, 'append');
    assert.notEqual(afterFinalComplete.throughCursor, baseline.throughCursor);
    assert.equal(afterFinalComplete.chain.length, 2);
  } finally {
    db?.close();
    rmSync(box.root, { recursive: true, force: true });
  }
});

test('observer feed: same-thread append, rollback prefix change, and project separation', () => {
  const box = fixture();
  try {
    const id = '019dfaba-f87e-7f41-a144-d5ca7c6dd7f9';
    writeRollout(box.home, box.project, id, completeEvents());
    const first = resolveObserverTurnFeed({ projectPath: box.project, codexHome: box.home, receiptOptions: box.receiptOptions });
    writeRollout(box.home, box.project, id, [...completeEvents(), ...completeEvents('2026-07-15T00:02:00.000Z')]);
    assert.equal(resolveObserverTurnFeed({ projectPath: box.project, cursor: first.throughCursor, codexHome: box.home, receiptOptions: box.receiptOptions }).status, 'append');
    writeRollout(box.home, box.project, id, [event('user_message', 'changed', '2026-07-15T00:00:01.000Z'), ...completeEvents().slice(1)]);
    assert.equal(resolveObserverTurnFeed({ projectPath: box.project, cursor: first.throughCursor, codexHome: box.home, receiptOptions: box.receiptOptions }).status, 'resync_required');
    const child = join(box.project, 'child'); mkdirSync(child);
    const childId = '019dfaba-f87e-7f41-a144-d5ca7c6dd7f7';
    writeRollout(box.home, child, childId, completeEvents('2026-07-15T00:03:00.000Z'));
    assert.equal(resolveObserverTurnFeed({ projectPath: box.project, codexHome: box.home, receiptOptions: box.receiptOptions }).chain.at(-1).completed_at, Date.parse('2026-07-15T00:03:00.000Z'), 'root配下cwdを含む');
    assert.equal(resolveObserverTurnFeed({ projectPath: box.other, codexHome: box.home, receiptOptions: box.receiptOptions }).chain.length, 0, '別projectは除外');
    assert.equal(resolveObserverTurnFeed({ projectPath: box.other, cursor: first.throughCursor, codexHome: box.home, receiptOptions: box.receiptOptions }).status, 'resync_required');
  } finally { rmSync(box.root, { recursive: true, force: true }); }
});

test('observer feed: Claude history floor, host/thread switch, cross-host tie, and opaque cursor', () => {
  const box = fixture();
  try {
    const options = box.receiptOptions;
    seedCompletedTurnReceiptStore({ projectPath: box.project, receiptOptions: options, targetSessionId: 'claude-session' });
    writeCompletedTurnReceipt({ projectPath: box.project, targetSessionId: 'claude-session', originSessionId: 'o257', userBody: 'u257', assistantBody: 'a257', completedAt: 257 }, options);
    const latest = resolveObserverTurnFeed({ projectPath: box.project, receiptOptions: options, codexHome: box.home });
    const decoded = decodeObserverCursor(latest.throughCursor);
    const beforeFloor = encodeObserverCursor({ ...decoded, history_floor: 1 });
    assert.equal(resolveObserverTurnFeed({ projectPath: box.project, cursor: beforeFloor, receiptOptions: options, codexHome: box.home }).status, 'resync_required');
    assert.equal(resolveObserverTurnFeed({ projectPath: box.project, cursor: `${latest.throughCursor}x`, receiptOptions: options, codexHome: box.home }).status, 'resync_required');
    const oldVersion = `tlc1.${Buffer.from(JSON.stringify({ ...decoded, schema: 'throughline.observer_cursor.v0' })).toString('base64url')}`;
    assert.equal(resolveObserverTurnFeed({ projectPath: box.project, cursor: oldVersion, receiptOptions: options, codexHome: box.home }).status, 'resync_required');
    const changedPrefix = encodeObserverCursor({ ...decoded, prefix_sha256: 'f'.repeat(64) });
    assert.equal(resolveObserverTurnFeed({ projectPath: box.project, cursor: changedPrefix, receiptOptions: options, codexHome: box.home }).status, 'resync_required');
    assert.throws(() => encodeObserverCursor({ ...decoded, length: 0 }), /cursor invalid/);
    assert.doesNotMatch(JSON.stringify(decoded), new RegExp(`${box.project}|claude-session|u257|a257`));
    const id = '019dfaba-f87e-7f41-a144-d5ca7c6dd7f9';
    writeRollout(box.home, box.project, id, completeEvents('2026-07-15T00:03:00.000Z'));
    const switched = resolveObserverTurnFeed({ projectPath: box.project, cursor: latest.throughCursor, receiptOptions: options, codexHome: box.home });
    assert.equal(switched.status, 'host_switched');
    const secondId = '019dfaba-f87e-7f41-a144-d5ca7c6dd7f8';
    writeRollout(box.home, box.project, secondId, completeEvents('2026-07-15T00:04:00.000Z'));
    assert.equal(resolveObserverTurnFeed({ projectPath: box.project, cursor: switched.throughCursor, receiptOptions: options, codexHome: box.home }).status, 'thread_switched');
    writeCompletedTurnReceipt({ projectPath: box.project, targetSessionId: 'claude-tie', originSessionId: 'tie', userBody: 'tu', assistantBody: 'ta', completedAt: Date.parse('2026-07-15T00:03:00.000Z') }, options);
    // Tie the current Codex parent, not a stale earlier one.
    writeCompletedTurnReceipt({ projectPath: box.project, targetSessionId: 'claude-tie-current', originSessionId: 'tie-current', userBody: 'tuc', assistantBody: 'tac', completedAt: Date.parse('2026-07-15T00:04:00.000Z') }, options);
    assert.equal(resolveObserverTurnFeed({ projectPath: box.project, receiptOptions: options, codexHome: box.home }).status, 'ambiguous_parent');
  } finally { rmSync(box.root, { recursive: true, force: true }); }
});

test('observer feed: Codex pair hashes reuse DB capture role aggregation', () => {
  const box = fixture();
  try {
    const id = '019dfaba-f87e-7f41-a144-d5ca7c6dd7f9';
    writeRollout(box.home, box.project, id, [
      event('user_message', 'user one', '2026-07-15T00:00:01.000Z'),
      event('task_started', undefined, '2026-07-15T00:00:02.000Z'),
      event('user_message', 'user two', '2026-07-15T00:00:03.000Z'),
      event('agent_message', 'assistant one', '2026-07-15T00:00:04.000Z'),
      event('agent_message', 'assistant two', '2026-07-15T00:00:05.000Z'),
      event('task_complete', undefined, '2026-07-15T00:00:06.000Z'),
    ]);
    const result = resolveObserverTurnFeed({ projectPath: box.project, codexHome: box.home, receiptOptions: box.receiptOptions });
    assert.equal(result.chain[0].user_sha256, hashAuditorBody('user one\n\nuser two'));
    assert.equal(result.chain[0].assistant_sha256, hashAuditorBody('assistant one\n\nassistant two'));
  } finally { rmSync(box.root, { recursive: true, force: true }); }
});

test('observer feed: prior source loss never downgrades into a switch', () => {
  const box = fixture();
  try {
    const primary = '019dfaba-f87e-7f41-a144-d5ca7c6dd7f9';
    const backup = '019dfaba-f87e-7f41-a144-d5ca7c6dd7f8';
    const primaryPath = writeRollout(box.home, box.project, primary, completeEvents('2026-07-15T00:03:00.000Z'));
    writeRollout(box.home, box.project, backup, completeEvents('2026-07-15T00:02:00.000Z'));
    const prior = resolveObserverTurnFeed({ projectPath: box.project, codexHome: box.home, receiptOptions: box.receiptOptions });
    rmSync(primaryPath);
    assert.equal(resolveObserverTurnFeed({ projectPath: box.project, cursor: prior.throughCursor, codexHome: box.home, receiptOptions: box.receiptOptions }).status, 'resync_required', 'old同hostへ露出してもswitchにしない');
    const backupPath = join(box.home, 'sessions', '2026', '07', '15', `rollout-2026-07-15T00-00-00-${backup}.jsonl`);
    writeCompletedTurnReceipt({ projectPath: box.project, targetSessionId: 'claude', originSessionId: 'origin', userBody: 'u', assistantBody: 'a', completedAt: Date.parse('2026-07-15T00:04:00.000Z') }, box.receiptOptions);
    rmSync(backupPath);
    assert.equal(resolveObserverTurnFeed({ projectPath: box.project, cursor: prior.throughCursor, codexHome: box.home, receiptOptions: box.receiptOptions }).status, 'resync_required', 'prior host消失で他hostが出てもresync');
    const claudePrior = resolveObserverTurnFeed({ projectPath: box.project, codexHome: box.home, receiptOptions: box.receiptOptions });
    const receiptPath = join(box.root, 'state', 'throughline', 'completed-turn-receipts');
    rmSync(receiptPath, { recursive: true, force: true });
    assert.equal(resolveObserverTurnFeed({ projectPath: box.project, cursor: claudePrior.throughCursor, codexHome: box.home, receiptOptions: box.receiptOptions }).status, 'resync_required', 'source全消失もresync');
  } finally { rmSync(box.root, { recursive: true, force: true }); }
});

test('observer feed: DB projection is all-or-nothing and never exposes raw session identity', () => {
  const box = fixture();
  const dbPath = join(box.root, 'throughline.db');
  let db;
  try {
    const options = box.receiptOptions;
    writeCompletedTurnReceipt({ projectPath: box.project, targetSessionId: 'private-session', originSessionId: 'private-origin', userBody: 'captured user', assistantBody: 'captured answer', completedAt: 1 }, options);
    const pending = resolveObserverTurnFeed({ projectPath: box.project, codexHome: box.home, receiptOptions: options, dbPath });
    assert.equal(pending.status, 'projection_pending');
    assert.deepEqual(pending.turns, []);
    db = new DatabaseSync(dbPath);
    db.exec(`PRAGMA user_version = 9;
      CREATE TABLE sessions (session_id TEXT PRIMARY KEY, project_path TEXT NOT NULL);
      CREATE TABLE bodies (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, origin_session_id TEXT NOT NULL, turn_number INTEGER NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL);`);
    db.prepare('INSERT INTO sessions (session_id, project_path) VALUES (?, ?)').run('private-session', box.project);
    db.prepare('INSERT INTO bodies (session_id, origin_session_id, turn_number, role, text, created_at) VALUES (?, ?, 1, ?, ?, ?)').run('private-session', 'private-origin', 'user', 'captured user', 1);
    db.prepare('INSERT INTO bodies (session_id, origin_session_id, turn_number, role, text, created_at) VALUES (?, ?, 1, ?, ?, ?)').run('private-session', 'private-origin', 'assistant', 'captured answer', 2);
    const fresh = resolveObserverTurnFeed({ projectPath: box.project, codexHome: box.home, receiptOptions: options, dbPath, maxTotalChars: 0 });
    assert.equal(fresh.status, 'snapshot');
    assert.equal(fresh.turns.length, 1);
    assert.equal(fresh.turns[0].truncated, true);
    assert.doesNotMatch(JSON.stringify(fresh), /private-session|private-origin|captured user|captured answer/);
  } finally {
    db?.close();
    rmSync(box.root, { recursive: true, force: true });
  }
});

test('observer read: snapshot returns only the latest bounded DB-projected turns without pagination', () => {
  const box = fixture();
  const dbPath = join(box.root, 'throughline.db');
  let db;
  try {
    db = createProjectionDb(dbPath, box.project, 'private-claude-session');
    for (let turn = 1; turn <= 3; turn++) {
      addClaudeTurn(box, db, {
        sessionId: 'private-claude-session', origin: `private-origin-${turn}`, turn,
        user: `user-${turn}`, assistant: `assistant-${turn}`, at: turn,
      });
    }
    const result = readObserverTurnPage({
      projectPath: box.project, codexHome: box.home, receiptOptions: box.receiptOptions,
      dbPath, limit: 2,
    });
    assert.equal(result.schema, 'throughline.observer_read.v1');
    assert.equal(result.status, 'snapshot');
    assert.equal(result.host, 'claude');
    assert.equal(result.historyTruncated, true);
    assert.deepEqual(result.page, { complete: true, nextToken: null });
    assert.deepEqual(result.turns.map((turn) => [turn.user, turn.assistant]), [
      ['user-2', 'assistant-2'], ['user-3', 'assistant-3'],
    ]);
    assert.equal(result.turns.every((turn) => turn.origin_sha256 && turn.source_sha256 && Number.isInteger(turn.completed_at)), true);
    assert.doesNotMatch(JSON.stringify(result), /private-claude-session|private-origin/);
    for (const limit of [0, 101, 1.5]) {
      assert.throws(() => readObserverTurnPage({
        projectPath: box.project, codexHome: box.home, receiptOptions: box.receiptOptions, dbPath, limit,
      }), /limit must be an integer between 1 and 100/);
    }
  } finally {
    db?.close();
    rmSync(box.root, { recursive: true, force: true });
  }
});

test('observer read: delta pages keep the first through boundary while newer turns arrive', () => {
  const box = fixture();
  const dbPath = join(box.root, 'throughline.db');
  let db;
  try {
    db = createProjectionDb(dbPath, box.project, 'claude-session');
    addClaudeTurn(box, db, { origin: 'origin-1', turn: 1, user: 'user-1', assistant: 'assistant-1', at: 1 });
    const baseline = resolveObserverTurnFeed({ projectPath: box.project, codexHome: box.home, receiptOptions: box.receiptOptions });
    for (let turn = 2; turn <= 4; turn++) {
      addClaudeTurn(box, db, { origin: `origin-${turn}`, turn, user: `user-${turn}`, assistant: `assistant-${turn}`, at: turn });
    }

    const first = readObserverTurnPage({
      projectPath: box.project, afterCursor: baseline.throughCursor, limit: 1,
      codexHome: box.home, receiptOptions: box.receiptOptions, dbPath,
    });
    assert.equal(first.status, 'delta');
    assert.equal(first.page.complete, false);
    assert.equal(first.turns[0].user, 'user-2');
    assert.equal(typeof first.page.nextToken, 'string');
    assert.doesNotMatch(first.page.nextToken, /claude-session|origin-2|user-2|assistant-2/);

    addClaudeTurn(box, db, { origin: 'origin-5', turn: 5, user: 'user-5', assistant: 'assistant-5', at: 5 });
    const second = readObserverTurnPage({
      projectPath: box.project, afterCursor: baseline.throughCursor, throughCursor: first.throughCursor,
      pageToken: first.page.nextToken, limit: 1, codexHome: box.home,
      receiptOptions: box.receiptOptions, dbPath,
    });
    const third = readObserverTurnPage({
      projectPath: box.project, afterCursor: baseline.throughCursor, throughCursor: second.throughCursor,
      pageToken: second.page.nextToken, limit: 1, codexHome: box.home,
      receiptOptions: box.receiptOptions, dbPath,
    });
    assert.equal(second.turns[0].user, 'user-3');
    assert.equal(third.turns[0].user, 'user-4');
    assert.deepEqual(third.page, { complete: true, nextToken: null });
    assert.equal(JSON.stringify([first, second, third]).includes('user-5'), false);

    const tamperedOffset = rewritePageToken(first.page.nextToken, (value) => { value.offset = 2; });
    assert.throws(() => readObserverTurnPage({
      projectPath: box.project, afterCursor: baseline.throughCursor, throughCursor: first.throughCursor,
      pageToken: tamperedOffset, limit: 1, codexHome: box.home,
      receiptOptions: box.receiptOptions, dbPath,
    }), /page token binding invalid/);
    assert.throws(() => readObserverTurnPage({
      projectPath: box.other, afterCursor: baseline.throughCursor, throughCursor: first.throughCursor,
      pageToken: first.page.nextToken, limit: 1, codexHome: box.home,
      receiptOptions: box.receiptOptions, dbPath,
    }), /page token binding invalid/);
  } finally {
    db?.close();
    rmSync(box.root, { recursive: true, force: true });
  }
});

test('observer read: a missing pair on a later page returns no partial body or continuation', () => {
  const box = fixture();
  const dbPath = join(box.root, 'throughline.db');
  let db;
  try {
    db = createProjectionDb(dbPath, box.project, 'claude-session');
    addClaudeTurn(box, db, { origin: 'origin-1', turn: 1, user: 'user-1', assistant: 'assistant-1', at: 1 });
    const baseline = resolveObserverTurnFeed({ projectPath: box.project, codexHome: box.home, receiptOptions: box.receiptOptions });
    addClaudeTurn(box, db, { origin: 'origin-2', turn: 2, user: 'user-2', assistant: 'assistant-2', at: 2 });
    addClaudeTurn(box, null, { origin: 'origin-3', turn: 3, user: 'user-3', assistant: 'assistant-3', at: 3 });
    const first = readObserverTurnPage({
      projectPath: box.project, afterCursor: baseline.throughCursor, limit: 1,
      codexHome: box.home, receiptOptions: box.receiptOptions, dbPath,
    });
    const pending = readObserverTurnPage({
      projectPath: box.project, afterCursor: baseline.throughCursor, throughCursor: first.throughCursor,
      pageToken: first.page.nextToken, limit: 1, codexHome: box.home,
      receiptOptions: box.receiptOptions, dbPath,
    });
    assert.equal(first.status, 'delta');
    assert.equal(pending.status, 'projection_pending');
    assert.deepEqual(pending.turns, []);
    assert.equal(pending.throughCursor, null);
    assert.deepEqual(pending.page, { complete: false, nextToken: null });
  } finally {
    db?.close();
    rmSync(box.root, { recursive: true, force: true });
  }
});

function createV11ProjectionDb(path, project, sessionId) {
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA user_version = ${CURRENT_VERSION};
    CREATE TABLE sessions (session_id TEXT PRIMARY KEY, project_path TEXT NOT NULL);
    CREATE TABLE bodies (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, origin_session_id TEXT NOT NULL, turn_number INTEGER NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL, turn_start TEXT);`);
  db.prepare('INSERT INTO sessions (session_id, project_path) VALUES (?, ?)').run(sessionId, project);
  return db;
}
function setTurnStart(db, sessionId, turn, start) {
  db.prepare("UPDATE bodies SET turn_start = ? WHERE session_id = ? AND turn_number = ? AND role = 'user'").run(start, sessionId, turn);
}

test('observer read v2: full bodies, real harness, and turn start while v1 stays unchanged', () => {
  const box = fixture();
  const dbPath = join(box.root, 'throughline.db');
  let db;
  try {
    const sessionId = 'grok:private-grok-session';
    db = createV11ProjectionDb(dbPath, box.project, sessionId);
    const long = (label) => `${label}-head ${'x'.repeat(3000)} ${label}-tail`;
    for (let turn = 1; turn <= 3; turn++) {
      addClaudeTurn(box, db, { sessionId, origin: sessionId, turn, user: long(`user-${turn}`), assistant: long(`assistant-${turn}`), at: turn });
    }
    setTurnStart(db, sessionId, 1, 'prompt');
    setTurnStart(db, sessionId, 2, 'self');
    const base = { projectPath: box.project, codexHome: box.home, receiptOptions: box.receiptOptions, dbPath };

    const v1 = readObserverTurnPage(base);
    assert.equal(v1.schema, 'throughline.observer_read.v1');
    assert.equal(v1.host, 'claude', 'v1 は既存の lane 名を返し続ける');
    assert.equal(v1.turns.some((turn) => turn.truncated), true);
    assert.deepEqual(Object.keys(v1.turns[0]).sort(), [
      'assistant', 'assistant_sha256', 'completed_at', 'host', 'origin_sha256', 'source_sha256',
      'thread_sha256', 'truncated', 'user', 'user_sha256',
    ]);
    assert.equal(v1.turns[0].host, 'claude');

    const v2 = readObserverTurnPage({ ...base, wire: 'v2' });
    assert.equal(v2.schema, 'throughline.observer_read.v2');
    assert.equal(v2.host, 'grok');
    assert.deepEqual(v2.turns.map((turn) => [turn.host, turn.turn_start, turn.truncated]), [
      ['grok', 'prompt', false], ['grok', 'self', false], ['grok', 'unknown', false],
    ]);
    assert.deepEqual(v2.turns.map((turn) => [turn.user, turn.assistant]), [1, 2, 3].map((turn) => [long(`user-${turn}`), long(`assistant-${turn}`)]));
    assert.equal(v2.throughCursor, v1.throughCursor, 'cursor は wire に依存しない');
    assert.doesNotMatch(JSON.stringify(v2), /private-grok-session/);
    assert.throws(() => readObserverTurnPage({ ...base, wire: 'v3' }), /wire must be v1 or v2/);
  } finally {
    db?.close();
    rmSync(box.root, { recursive: true, force: true });
  }
});

test('observer read v2: Cursor host, pre-v11 DB, Codex prompt, and empty states', () => {
  const box = fixture();
  const dbPath = join(box.root, 'throughline.db');
  let db;
  try {
    const sessionId = 'cursor:private-cursor-session';
    db = createProjectionDb(dbPath, box.project, sessionId);
    addClaudeTurn(box, db, { sessionId, origin: sessionId, turn: 1, user: 'u', assistant: 'a', at: 1 });
    const cursor = readObserverTurnPage({ projectPath: box.project, codexHome: box.home, receiptOptions: box.receiptOptions, dbPath, wire: 'v2' });
    assert.deepEqual(cursor.turns.map((turn) => [turn.host, turn.turn_start]), [['cursor', 'unknown']], 'turn_start 列の無い DB は unknown');

    const resync = readObserverTurnPage({ projectPath: box.project, codexHome: box.home, receiptOptions: box.receiptOptions, dbPath, afterCursor: 'tlc1.broken', wire: 'v2' });
    assert.equal(resync.schema, 'throughline.observer_read.v2');
    assert.equal(resync.status, 'resync_required');
  } finally {
    db?.close();
    rmSync(box.root, { recursive: true, force: true });
  }

  const codexBox = fixture();
  const codexDbPath = join(codexBox.root, 'throughline.db');
  let codexDb;
  try {
    const id = '019dfaba-f87e-7f41-a144-d5ca7c6dd7f9';
    const sessionId = `codex:${id}`;
    codexDb = createV11ProjectionDb(codexDbPath, codexBox.project, sessionId);
    const insert = codexDb.prepare('INSERT INTO bodies (session_id, origin_session_id, turn_number, role, text, created_at) VALUES (?, ?, ?, ?, ?, ?)');
    insert.run(sessionId, sessionId, 1, 'user', 'request', 1);
    insert.run(sessionId, sessionId, 1, 'assistant', 'answer', 2);
    writeRollout(codexBox.home, codexBox.project, id, completeEvents());
    const codex = readObserverTurnPage({ projectPath: codexBox.project, codexHome: codexBox.home, receiptOptions: codexBox.receiptOptions, dbPath: codexDbPath, wire: 'v2' });
    assert.equal(codex.host, 'codex');
    assert.deepEqual(codex.turns.map((turn) => [turn.host, turn.turn_start, turn.user, turn.assistant]), [['codex', 'prompt', 'request', 'answer']]);
  } finally {
    codexDb?.close();
    rmSync(codexBox.root, { recursive: true, force: true });
  }
});
