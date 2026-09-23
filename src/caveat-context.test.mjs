import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { CAVEAT_CONTEXT_SCHEMA, readCaveatContext } from './caveat-context.mjs';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'throughline-caveat-context-'));
  const path = join(root, 'throughline.db');
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA user_version = 9;
    CREATE TABLE sessions (session_id TEXT PRIMARY KEY, project_path TEXT NOT NULL);
    CREATE TABLE bodies (id INTEGER PRIMARY KEY, session_id TEXT, origin_session_id TEXT, turn_number INTEGER, role TEXT, text TEXT, created_at INTEGER);
    CREATE TABLE details (id INTEGER PRIMARY KEY, session_id TEXT, origin_session_id TEXT, turn_number INTEGER, kind TEXT, output_text TEXT, created_at INTEGER);
  `);
  db.prepare('INSERT INTO sessions VALUES (?, ?)').run('claude-1', root);
  const body = db.prepare('INSERT INTO bodies (session_id, origin_session_id, turn_number, role, text, created_at) VALUES (?, ?, ?, ?, ?, ?)');
  const detail = db.prepare('INSERT INTO details (session_id, origin_session_id, turn_number, kind, output_text, created_at) VALUES (?, ?, ?, ?, ?, ?)');
  for (let turn = 1; turn <= 4; turn++) {
    body.run('claude-1', 'claude-1', turn, 'user', `user ${turn}`, turn * 10);
    body.run('claude-1', 'claude-1', turn, 'assistant', `assistant ${turn}`, turn * 10 + 1);
    detail.run('claude-1', 'claude-1', turn, 'tool_output', `private tool log ${turn}`, turn * 10 + 2);
    detail.run('claude-1', 'claude-1', turn, 'thinking', `I should reconsider turn ${turn}`, turn * 10 + 3);
  }
  db.close();
  return { root, path };
}

test('Caveat projection returns only three completed turns with thinking, excluding tool logs', () => {
  const { root, path } = fixture();
  try {
    const result = readCaveatContext({ dbPath: path, sessionId: 'claude-1', projectRoot: root });
    assert.equal(result.schema, CAVEAT_CONTEXT_SCHEMA);
    assert.equal(result.status, 'ready');
    assert.deepEqual(result.turns.map((turn) => turn.turnNumber), [2, 3, 4]);
    assert.equal(result.turns[2].thinking, 'I should reconsider turn 4');
    assert.equal(result.thinkingAvailable, true);
    assert.doesNotMatch(JSON.stringify(result), /private tool log/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Caveat projection does not expose another project or an incomplete history', () => {
  const { root, path } = fixture();
  try {
    assert.equal(readCaveatContext({ dbPath: path, sessionId: 'claude-1', projectRoot: tmpdir() }).status, 'ready');
    const unrelated = mkdtempSync(join(tmpdir(), 'unrelated-project-'));
    try {
      assert.equal(readCaveatContext({ dbPath: path, sessionId: 'claude-1', projectRoot: unrelated }).status, 'session_mismatch');
    } finally { rmSync(unrelated, { recursive: true, force: true }); }
    const db = new DatabaseSync(path);
    db.exec('DELETE FROM bodies WHERE turn_number > 2');
    db.close();
    const result = readCaveatContext({ dbPath: path, sessionId: 'claude-1', projectRoot: root });
    assert.equal(result.status, 'incomplete');
    assert.equal(result.capturedTurns, 2);
    assert.deepEqual(result.turns, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('caveat-context CLI emits JSON and rejects malformed arguments', () => {
  const { root, path } = fixture();
  try {
    const bin = fileURLToPath(new URL('../bin/throughline.mjs', import.meta.url));
    const good = spawnSync(process.execPath, [bin, 'caveat-context', '--session', 'claude-1', '--project', root, '--db', path, '--json'], { encoding: 'utf8' });
    assert.equal(good.status, 0, good.stderr);
    assert.equal(JSON.parse(good.stdout).status, 'ready');
    const bad = spawnSync(process.execPath, [bin, 'caveat-context', '--session', 'claude-1', '--project', root, '--host', 'claude', '--db', path, '--json'], { encoding: 'utf8' });
    assert.equal(bad.status, 1);
    assert.equal(JSON.parse(bad.stderr).code, 'E_CAVEAT_CONTEXT_ARGS');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Caveat projection reports pending when the stored latest turn differs from the host transcript', () => {
  const { root, path } = fixture();
  try {
    const transcriptPath = join(root, 'session.jsonl');
    const rows = [
      { type: 'user', message: { role: 'user', content: 'user 4' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'a newer answer' }] } },
    ];
    writeFileSync(transcriptPath, rows.map(JSON.stringify).join('\n'));
    const result = readCaveatContext({ dbPath: path, sessionId: 'claude-1', projectRoot: root,
      host: 'claude', transcriptPath });
    assert.equal(result.status, 'projection_pending');
    assert.deepEqual(result.turns, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
