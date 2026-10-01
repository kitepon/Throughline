import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { CURRENT_VERSION } from '../db.mjs';
import { MIGRATION_SCHEMA, parseArgs, run } from './migrate.mjs';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const BIN_PATH = join(REPO_ROOT, 'bin/throughline.mjs');

function runCli(home, args = ['migrate', '--json']) {
  return spawnSync(process.execPath, [BIN_PATH, ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, HOME: home, USERPROFILE: home },
    encoding: 'utf8',
  });
}

function createV8Db(home) {
  const dir = join(home, '.throughline');
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, 'throughline.db'));
  db.exec(`
    PRAGMA user_version = 8;
    CREATE TABLE sessions (session_id TEXT PRIMARY KEY, project_path TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, merged_into TEXT);
    CREATE TABLE skeletons (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, turn_number INTEGER NOT NULL, role TEXT NOT NULL, summary TEXT NOT NULL, created_at INTEGER NOT NULL, origin_session_id TEXT);
    CREATE TABLE bodies (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, origin_session_id TEXT NOT NULL, turn_number INTEGER NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL, token_count INTEGER, created_at INTEGER NOT NULL, UNIQUE(session_id, origin_session_id, turn_number, role));
    CREATE TABLE details (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, turn_number INTEGER, tool_name TEXT NOT NULL, input_text TEXT, output_text TEXT, token_count INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, origin_session_id TEXT, kind TEXT NOT NULL DEFAULT 'tool_input', source_id TEXT);
    CREATE TABLE handoff_batons (project_path TEXT PRIMARY KEY, session_id TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE UNIQUE INDEX uq_skeletons_turn_v3 ON skeletons(session_id, origin_session_id, turn_number, role);
    CREATE UNIQUE INDEX uq_details_source ON details(session_id, origin_session_id, source_id) WHERE source_id IS NOT NULL;
  `);
  db.close();
}

test('migrate CLI migrates a v8 fixture to the current schema', () => {
  const home = mkdtempSync(join(tmpdir(), 'tl-migrate-v8-'));
  try {
    createV8Db(home);
    const result = runCli(home);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      schema: MIGRATION_SCHEMA,
      status: 'migrated',
      beforeSchemaVersion: 8,
      afterSchemaVersion: CURRENT_VERSION,
      supportedSchemaVersion: CURRENT_VERSION,
    });
    const db = new DatabaseSync(join(home, '.throughline', 'throughline.db'), { readOnly: true });
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, CURRENT_VERSION);
    assert.deepEqual(db.prepare('PRAGMA table_info(pending_handoffs)').all().map((row) => row.name), [
      'session_id', 'project_path', 'source', 'auto_predecessor_id', 'created_at',
    ]);
    db.close();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('migrate CLI is idempotent for the current schema', () => {
  const home = mkdtempSync(join(tmpdir(), 'tl-migrate-current-'));
  try {
    createV8Db(home);
    assert.equal(runCli(home).status, 0);
    const result = runCli(home);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).status, 'already_current');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('migrate CLI does not create a missing database', () => {
  const home = mkdtempSync(join(tmpdir(), 'tl-migrate-missing-'));
  try {
    const result = runCli(home);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).status, 'not_applicable');
    assert.equal(existsSync(join(home, '.throughline')), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('migrate CLI rejects a future schema without changing it', () => {
  const home = mkdtempSync(join(tmpdir(), 'tl-migrate-future-'));
  try {
    createV8Db(home);
    const dbPath = join(home, '.throughline', 'throughline.db');
    const db = new DatabaseSync(dbPath);
    db.exec(`PRAGMA user_version = ${CURRENT_VERSION + 1}`);
    db.close();
    const result = runCli(home);
    assert.equal(result.status, 1, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      schema: MIGRATION_SCHEMA,
      status: 'future_schema',
      beforeSchemaVersion: CURRENT_VERSION + 1,
      afterSchemaVersion: CURRENT_VERSION + 1,
      supportedSchemaVersion: CURRENT_VERSION,
    });
    const verify = new DatabaseSync(dbPath, { readOnly: true });
    assert.equal(verify.prepare('PRAGMA user_version').get().user_version, CURRENT_VERSION + 1);
    verify.close();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('migrate CLI accepts only --json and does not reflect arguments', () => {
  for (const argv of [[], ['--json', '--json'], ['--db', '/private/secret.db', '--json']]) {
    const output = [];
    assert.equal(run(argv, { stdout: { write(value) { output.push(value); } } }), 2);
    assert.equal(JSON.parse(output[0]).status, 'invalid_request');
    assert.doesNotMatch(output[0], /private|secret/);
  }
  assert.deepEqual(parseArgs(['--json']), { json: true });
  assert.throws(() => parseArgs([]), /usage error/);
});

test('migrate CLI reports an internal migration failure without reflecting its cause', () => {
  const output = [];
  assert.equal(run(['--json'], {
    stdout: { write(value) { output.push(value); } },
    migrate() { throw new Error('/private/throughline.db contents'); },
  }), 1);
  assert.deepEqual(JSON.parse(output[0]), {
    schema: MIGRATION_SCHEMA,
    status: 'migration_failed',
    beforeSchemaVersion: null,
    afterSchemaVersion: null,
    supportedSchemaVersion: CURRENT_VERSION,
  });
  assert.doesNotMatch(output[0], /private|contents/);
});

test('migrate adds bodies.turn_start without touching existing rows', () => {
  const home = mkdtempSync(join(tmpdir(), 'tl-migrate-turn-start-'));
  try {
    createV8Db(home);
    const before = new DatabaseSync(join(home, '.throughline', 'throughline.db'));
    before.prepare('INSERT INTO bodies (session_id, origin_session_id, turn_number, role, text, created_at) VALUES (?, ?, ?, ?, ?, ?)').run('s', 's', 1, 'user', 'kept', 1);
    before.close();
    const result = runCli(home);
    assert.equal(result.status, 0, result.stderr);
    const db = new DatabaseSync(join(home, '.throughline', 'throughline.db'), { readOnly: true });
    try {
      assert.equal(db.prepare('PRAGMA user_version').get().user_version, CURRENT_VERSION);
      assert.deepEqual({ ...db.prepare('SELECT text, turn_start FROM bodies').get() }, { text: 'kept', turn_start: null });
    } finally { db.close(); }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
