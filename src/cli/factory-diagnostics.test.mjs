import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CURRENT_VERSION } from '../db.mjs';
import {
  collectFactoryDiagnostics,
  inspectFactoryDatabase,
  inspectFactoryHooks,
  parseArgs,
  run,
} from './factory-diagnostics.mjs';

test('factory-diagnostics CLI: JSON-only contract and schema fixture', () => {
  const output = [];
  const exitCode = run(['--json'], {
    stdout: { write(value) { output.push(value); } },
    version: '0.6.1',
    inspectThread: () => ({ status: 'ready', rolloutAvailable: true }),
    inspectDatabase: () => ({
      status: 'ready',
      schemaVersion: CURRENT_VERSION,
      supportedSchemaVersion: CURRENT_VERSION,
      handoffMemory: true,
    }),
    inspectHooks: () => ({
      status: 'ready',
      claudeStatus: 'ready',
      events: { userPromptSubmit: 'ready', postToolUse: 'ready', stop: 'ready' },
    }),
  });

  assert.equal(exitCode, 0);
  assert.equal(output.length, 1);
  const parsed = JSON.parse(output[0]);
  assert.equal(parsed.schema, 'throughline.native_factory_diagnostics.v1');
  assert.equal(parsed.version, '0.6.1');
  assert.equal(parsed.databaseSchema.schema, `throughline.database.v${CURRENT_VERSION}`);
  assert.equal(parsed.databaseSchema.databaseSchemaVersion, CURRENT_VERSION);
  assert.equal(parsed.databaseSchema.supportedDatabaseSchemaVersion, CURRENT_VERSION);
  assert.equal(parsed.readiness.restore.status, 'ready');
  assert.equal(parsed.evidence.restoreSmoke.status, 'unverified');
});

test('factory-diagnostics CLI: invalid request is a fixed JSON error', () => {
  const output = [];
  const exitCode = run(['--project', '/secret/path'], {
    stdout: { write(value) { output.push(value); } },
  });

  assert.equal(exitCode, 2);
  assert.equal(output.length, 1);
  const parsed = JSON.parse(output[0]);
  assert.equal(parsed.error, 'invalid_diagnostics_request');
  assert.doesNotMatch(output[0], /secret\/path/);
  assert.throws(() => parseArgs([]), /usage error/);
  assert.throws(() => parseArgs(['--json', '--json']), /usage error/);
});

test('factory-diagnostics CLI: internal failure is not reported as a usage error', () => {
  const output = [];
  const exitCode = run(['--json'], {
    stdout: { write(value) { output.push(value); } },
    inspectThread: () => { throw new Error('/secret/internal'); },
  });

  assert.equal(exitCode, 1);
  assert.equal(JSON.parse(output[0]).error, 'diagnostics_internal_error');
  assert.doesNotMatch(output[0], /secret|internal\//);
});

test('factory-diagnostics CLI: unverified inspection remains unverified', () => {
  const result = collectFactoryDiagnostics({
    version: '0.6.1',
    inspectThread: () => ({ status: 'unverified', rolloutAvailable: false }),
    inspectDatabase: () => ({ status: 'unverified', schemaVersion: null, handoffMemory: false }),
    inspectHooks: () => ({ status: 'unverified', claudeStatus: 'unverified', events: {} }),
  });

  assert.equal(result.overall.status, 'unverified');
  assert.equal(result.readiness.capture.status, 'unverified');
  assert.equal(result.readiness.handoff.status, 'unverified');
  assert.throws(() => parseArgs(['--bad']), /usage error/);
});

test('factory-diagnostics DB inspection is read-only and does not create an absent DB', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tl-factory-diagnostics-'));
  const dbPath = join(dir, 'throughline.db');
  const missingPath = join(dir, 'missing.db');
  try {
    const db = new DatabaseSync(dbPath);
    createFactorySchema(db);
    db.close();
    const before = statSync(dbPath).mtimeMs;

    const result = inspectFactoryDatabase({ dbPath, threadId: 'thread-1' });
    assert.equal(result.status, 'ready');
    assert.equal(result.handoffMemory, false);
    assert.equal(statSync(dbPath).mtimeMs, before);

    const writer = new DatabaseSync(dbPath);
    writer.exec(`
      INSERT INTO sessions VALUES ('codex:thread-1', '/project/a', 'active', 1, 1, NULL);
      INSERT INTO skeletons VALUES (1, 'codex:thread-1', 1, 'assistant', 'safe', 1, 'codex:thread-1');
    `);
    writer.close();
    const matching = inspectFactoryDatabase({ dbPath, threadId: 'thread-1', projectPath: '/project/a' });
    const mismatch = inspectFactoryDatabase({ dbPath, threadId: 'thread-1', projectPath: '/project/b' });
    assert.equal(matching.handoffMemory, true);
    assert.equal(mismatch.handoffMemory, false);

    const missing = inspectFactoryDatabase({ dbPath: missingPath });
    assert.equal(missing.status, 'not_applicable');
    assert.equal(existsSync(missingPath), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('factory-diagnostics DB inspection rejects version-only fake schema', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tl-factory-fake-schema-'));
  const dbPath = join(dir, 'throughline.db');
  try {
    const db = new DatabaseSync(dbPath);
    db.exec(`PRAGMA user_version = ${CURRENT_VERSION}; CREATE TABLE sessions (session_id TEXT)`);
    db.close();
    assert.equal(inspectFactoryDatabase({ dbPath }).status, 'not_ready');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('factory-diagnostics DB inspection rejects missing runtime constraints', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tl-factory-fake-constraint-'));
  const dbPath = join(dir, 'throughline.db');
  try {
    const db = new DatabaseSync(dbPath);
    createFactorySchema(db);
    db.exec(`
      DROP TABLE handoff_batons;
      CREATE TABLE handoff_batons (project_path TEXT, session_id TEXT NOT NULL, created_at INTEGER NOT NULL);
    `);
    db.close();
    assert.equal(inspectFactoryDatabase({ dbPath }).status, 'not_ready');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('factory-diagnostics hook inspection rejects corrupt and false-ready shapes', () => {
  const corrupt = inspectFactoryHooks({
    readHooks: () => ({ configExists: true, configReadable: false, hooksExists: true, hooksReadable: false }),
  });
  assert.equal(corrupt.status, 'unverified');

  const malformed = inspectFactoryHooks({
    readHooks: () => ({
      configExists: true,
      configReadable: true,
      hooksExists: true,
      hooksReadable: true,
      featureEnabled: true,
      expectedPromptCommand: 'prompt',
      expectedPostToolUseCommand: 'post',
      expectedStopCommand: 'stop',
      managedPromptHooks: [{ type: 'command', command: 'prompt', timeout: 30, async: true }],
      legacyManagedPromptHooks: [],
      managedPostToolUseHooks: [{ type: 'command', command: 'post', timeout: 30, async: false }],
      legacyManagedPostToolUseHooks: [],
      managedStopHooks: [{ type: 'command', command: 'stop', timeout: 300, async: false }],
      legacyManagedStopHooks: [],
    }),
  });
  assert.equal(malformed.status, 'not_ready');
});

test('factory-diagnostics hook inspection summarizes every canonical ready event as ready', () => {
  const result = inspectFactoryHooks({
    readHooks: () => ({
      configExists: true,
      configReadable: true,
      hooksExists: true,
      hooksReadable: true,
      featureEnabled: true,
      expectedPromptCommand: 'prompt',
      expectedPostToolUseCommand: 'post',
      expectedStopCommand: 'stop',
      managedPromptHooks: [{ type: 'command', command: 'prompt', timeout: 30, async: false }],
      legacyManagedPromptHooks: [],
      managedPostToolUseHooks: [{ type: 'command', command: 'post', timeout: 30, async: false }],
      legacyManagedPostToolUseHooks: [],
      managedStopHooks: [{ type: 'command', command: 'stop', timeout: 300, async: false }],
      legacyManagedStopHooks: [],
    }),
  });

  assert.deepEqual(result.events, { userPromptSubmit: 'ready', postToolUse: 'ready', stop: 'ready' });
  assert.equal(result.status, 'ready');
  assert.equal(result.reason, 'hooks_inspected');
});

test('factory-diagnostics hook inspection: 最小 PATH 由来の node 別表記を not_ready にしない', () => {
  // launchd の factory reporter は PATH に /opt/homebrew/bin を持たないため、期待値の
  // node が PATH symlink ではなく実体表記になる。同一 node を指す限り ready を維持する。
  const dir = mkdtempSync(join(tmpdir(), 'tl-factory-hook-'));
  try {
    mkdirSync(join(dir, 'bin'));
    mkdirSync(join(dir, 'cellar'));
    const realNode = join(dir, 'cellar', 'node');
    const pathNode = join(dir, 'bin', 'node');
    const script = join(dir, 'throughline.mjs');
    writeFileSync(realNode, '');
    writeFileSync(script, '');
    symlinkSync(realNode, pathNode);
    const registered = (event) => `${pathNode} ${script} codex-hook ${event}`;
    const expected = (event) => `${realNode} ${script} codex-hook ${event}`;

    const result = inspectFactoryHooks({
      readHooks: () => ({
        configExists: true,
        configReadable: true,
        hooksExists: true,
        hooksReadable: true,
        featureEnabled: true,
        expectedPromptCommand: expected('user-prompt-submit'),
        expectedPostToolUseCommand: expected('post-tool-use'),
        expectedStopCommand: expected('stop'),
        managedPromptHooks: [{ type: 'command', command: registered('user-prompt-submit'), timeout: 30, async: false }],
        legacyManagedPromptHooks: [],
        managedPostToolUseHooks: [{ type: 'command', command: registered('post-tool-use'), timeout: 30, async: false }],
        legacyManagedPostToolUseHooks: [],
        managedStopHooks: [{ type: 'command', command: registered('stop'), timeout: 300, async: false }],
        legacyManagedStopHooks: [],
      }),
    });

    assert.deepEqual(result.events, { userPromptSubmit: 'ready', postToolUse: 'ready', stop: 'ready' });
    assert.equal(result.status, 'ready');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('factory-diagnostics hook inspection rejects legacy timeoutSec keys', () => {
  const result = inspectFactoryHooks({
    readHooks: () => ({
      configExists: true,
      configReadable: true,
      hooksExists: true,
      hooksReadable: true,
      featureEnabled: true,
      expectedPromptCommand: 'prompt',
      expectedPostToolUseCommand: 'post',
      expectedStopCommand: 'stop',
      managedPromptHooks: [{ type: 'command', command: 'prompt', timeoutSec: 30, async: false }],
      legacyManagedPromptHooks: [],
      managedPostToolUseHooks: [{ type: 'command', command: 'post', timeoutSec: 30, async: false }],
      legacyManagedPostToolUseHooks: [],
      managedStopHooks: [{ type: 'command', command: 'stop', timeoutSec: 300, async: false }],
      legacyManagedStopHooks: [],
    }),
  });

  assert.deepEqual(result.events, { userPromptSubmit: 'not_ready', postToolUse: 'not_ready', stop: 'not_ready' });
  assert.equal(result.status, 'not_ready');
});

function createFactorySchema(db) {
  db.exec(`
    PRAGMA user_version = ${CURRENT_VERSION};
    CREATE TABLE sessions (
      session_id TEXT PRIMARY KEY, project_path TEXT NOT NULL, status TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, merged_into TEXT
    );
    CREATE TABLE skeletons (
      id INTEGER, session_id TEXT, turn_number INTEGER, role TEXT, summary TEXT,
      created_at INTEGER, origin_session_id TEXT
    );
    CREATE TABLE bodies (
      id INTEGER, session_id TEXT, origin_session_id TEXT, turn_number INTEGER,
      role TEXT, text TEXT, token_count INTEGER, created_at INTEGER,
      UNIQUE(session_id, origin_session_id, turn_number, role)
    );
    CREATE TABLE details (
      id INTEGER, session_id TEXT, turn_number INTEGER, tool_name TEXT,
      input_text TEXT, output_text TEXT, token_count INTEGER, created_at INTEGER,
      origin_session_id TEXT, kind TEXT, source_id TEXT
    );
    CREATE TABLE handoff_batons (
      project_path TEXT PRIMARY KEY, session_id TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE pending_handoffs (
      session_id TEXT PRIMARY KEY, project_path TEXT NOT NULL, source TEXT,
      auto_predecessor_id TEXT, created_at INTEGER NOT NULL
    );
    CREATE TABLE room_turns (
      project_path TEXT NOT NULL, room_id TEXT NOT NULL, message_id TEXT NOT NULL,
      speaker TEXT NOT NULL, text TEXT NOT NULL,
      PRIMARY KEY (project_path, room_id, message_id)
    );
    CREATE UNIQUE INDEX uq_skeletons_turn_v3
      ON skeletons(session_id, origin_session_id, turn_number, role);
    CREATE UNIQUE INDEX uq_details_source
      ON details(session_id, origin_session_id, source_id)
      WHERE source_id IS NOT NULL;
  `);
}
