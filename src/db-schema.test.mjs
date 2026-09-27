import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function withIsolatedDb(testFn) {
  const home = mkdtempSync(join(tmpdir(), 'tl-db-schema-'));
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    const mod = await import(`./db.mjs?isolated=${Date.now()}-${Math.random()}`);
    const db = mod.getDb();
    try {
      await testFn(db);
    } finally {
      db.close();
    }
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    rmSync(home, { recursive: true, force: true });
  }
}

function columnNames(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
}

function indexNames(db) {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name")
    .all()
    .map((row) => row.name);
}

test('schema v10 preserves Claude-facing tables and adds room context', async () => {
  await withIsolatedDb((db) => {
    const version = db.prepare('PRAGMA user_version').get();
    assert.equal(version.user_version, 10);

    assert.deepEqual(columnNames(db, 'sessions'), [
      'session_id',
      'project_path',
      'status',
      'created_at',
      'updated_at',
      'merged_into',
    ]);
    assert.deepEqual(columnNames(db, 'skeletons'), [
      'id',
      'session_id',
      'turn_number',
      'role',
      'summary',
      'created_at',
      'origin_session_id',
    ]);
    assert.deepEqual(columnNames(db, 'bodies'), [
      'id',
      'session_id',
      'origin_session_id',
      'turn_number',
      'role',
      'text',
      'token_count',
      'created_at',
    ]);
    assert.deepEqual(columnNames(db, 'details'), [
      'id',
      'session_id',
      'turn_number',
      'tool_name',
      'input_text',
      'output_text',
      'token_count',
      'created_at',
      'origin_session_id',
      'kind',
      'source_id',
    ]);
    assert.deepEqual(columnNames(db, 'handoff_batons'), [
      'project_path',
      'session_id',
      'created_at',
    ]);
    assert.deepEqual(columnNames(db, 'pending_handoffs'), [
      'session_id',
      'project_path',
      'source',
      'auto_predecessor_id',
      'created_at',
    ]);
    assert.deepEqual(columnNames(db, 'room_turns'), [
      'project_path', 'room_id', 'message_id', 'speaker', 'text',
    ]);

    const indexes = indexNames(db);
    assert.ok(indexes.includes('uq_skeletons_turn_v3'));
    assert.ok(indexes.includes('uq_details_source'));
  });
});
