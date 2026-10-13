import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { testTempDir } from './test-temp-dir.mjs';
import { spikeInject, generateSpikeTracer } from './spike-transcript-writer.mjs';

function makeDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE sessions (
      session_id TEXT PRIMARY KEY,
      project_path TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      merged_into TEXT
    );
    CREATE TABLE skeletons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      origin_session_id TEXT,
      turn_number INTEGER NOT NULL,
      role TEXT NOT NULL,
      summary TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE bodies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      origin_session_id TEXT NOT NULL,
      turn_number INTEGER NOT NULL,
      role TEXT NOT NULL,
      text TEXT NOT NULL,
      token_count INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE details (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      origin_session_id TEXT,
      turn_number INTEGER,
      tool_name TEXT NOT NULL,
      input_text TEXT,
      output_text TEXT,
      token_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      kind TEXT,
      source_id TEXT
    );
  `);
  return db;
}

function seedSession(db, { newSessionId = 'NEW', originId = 'ORIG' } = {}) {
  db.prepare(
    `INSERT INTO sessions (session_id, project_path, status, created_at, updated_at)
     VALUES (?, '/repo', 'active', 1, 2)`,
  ).run(newSessionId);
  // 2 user / 2 assistant turn を新 session 配下に origin_session_id=ORIG で配置
  // (handoff-record は inheritance mode で origin != current を recent bodies に拾う)
  const rows = [
    { turn: 1, role: 'user', text: 'こんにちは。tracer 検証だ', createdAt: 1000 },
    { turn: 2, role: 'assistant', text: '了解です。テスト用ターン 1', createdAt: 1100 },
    { turn: 3, role: 'user', text: '続きを書け', createdAt: 1200 },
    { turn: 4, role: 'assistant', text: '最後のアシスタント発話 (tracer 受け取り側)', createdAt: 1300 },
  ];
  for (const r of rows) {
    db.prepare(
      `INSERT INTO bodies (session_id, origin_session_id, turn_number, role, text, token_count, created_at)
       VALUES (?, ?, ?, ?, ?, 1, ?)`,
    ).run(newSessionId, originId, r.turn, r.role, r.text, r.createdAt);
  }
  return rows;
}

function makeTempJsonl() {
  const dir = testTempDir('spike-writer-test-');
  return join(dir, 'session.jsonl');
}

test('generateSpikeTracer returns 8 hex chars', () => {
  const t = generateSpikeTracer();
  assert.match(t, /^[0-9a-f]{8}$/);
  assert.notEqual(t, generateSpikeTracer()); // 衝突しない (実質)
});

test('spikeInject: returns skipReason when no recentBodies', () => {
  const db = makeDb();
  db.prepare(
    `INSERT INTO sessions (session_id, project_path, status, created_at, updated_at)
     VALUES ('NEW', '/repo', 'active', 1, 2)`,
  ).run();
  const target = makeTempJsonl();
  const result = spikeInject({
    db,
    targetJsonlPath: target,
    newSessionId: 'NEW',
    cwd: '/repo',
    version: '2.1.x',
    gitBranch: 'main',
    tracer: 'abcd1234',
  });
  assert.equal(result.appended, 0);
  assert.equal(result.skipReason, 'no_record_or_empty_l2');
  assert.equal(result.tracer, null);
  assert.equal(result.tracerAppendedAt, null);
});

test('spikeInject: appends bodies, embeds tracer in last assistant only', () => {
  const db = makeDb();
  seedSession(db);
  const target = makeTempJsonl();
  const tracer = 'deadbeef';

  const result = spikeInject({
    db,
    targetJsonlPath: target,
    newSessionId: 'NEW',
    cwd: '/repo',
    version: '2.1.x',
    gitBranch: 'main',
    tracer,
  });
  assert.equal(result.appended, 4);
  assert.equal(result.parentUuidStart, null); // empty file 起点
  assert.equal(result.tracer, tracer);
  assert.equal(result.tracerAppendedAt, 3); // index of last assistant

  const lines = readFileSync(target, 'utf8').split('\n').filter((l) => l.trim());
  assert.equal(lines.length, 4);

  const parsed = lines.map((l) => JSON.parse(l));
  // 順序 (古い順): user → assistant → user → assistant
  assert.deepEqual(parsed.map((o) => o.type), ['user', 'assistant', 'user', 'assistant']);
  // tracer は最後の assistant のみ
  const lastAssistant = parsed[3];
  assert.match(lastAssistant.message.content[0].text, /\[spike-tracer: deadbeef\]$/);
  // 中間の assistant には tracer が無い
  const midAssistant = parsed[1];
  assert.doesNotMatch(midAssistant.message.content[0].text, /spike-tracer/);
  // user 行にも無い
  for (const u of [parsed[0], parsed[2]]) {
    assert.doesNotMatch(u.message.content[0].text, /spike-tracer/);
  }
});

test('spikeInject: omits tracer entirely when tracer=null', () => {
  const db = makeDb();
  seedSession(db);
  const target = makeTempJsonl();

  const result = spikeInject({
    db,
    targetJsonlPath: target,
    newSessionId: 'NEW',
    cwd: '/repo',
    version: '2.1.x',
    gitBranch: 'main',
    tracer: null,
  });
  assert.equal(result.appended, 4);
  assert.equal(result.tracer, null);
  assert.equal(result.tracerAppendedAt, null);

  const content = readFileSync(target, 'utf8');
  assert.doesNotMatch(content, /spike-tracer/);
});

test('spikeInject: chains from last uuid when target has preexisting lines', () => {
  const db = makeDb();
  seedSession(db);
  const target = makeTempJsonl();
  const preexisting = { type: 'attachment', uuid: 'pre-attachment-uuid', parentUuid: null };
  writeFileSync(target, JSON.stringify(preexisting) + '\n', 'utf8');

  const result = spikeInject({
    db,
    targetJsonlPath: target,
    newSessionId: 'NEW',
    cwd: '/repo',
    version: '2.1.x',
    gitBranch: 'main',
    tracer: 'cafef00d',
  });
  assert.equal(result.parentUuidStart, 'pre-attachment-uuid');

  const lines = readFileSync(target, 'utf8').split('\n').filter((l) => l.trim());
  // 1 件目 (preexisting) は preserve、2 件目が最初の spike user
  const firstSpike = JSON.parse(lines[1]);
  assert.equal(firstSpike.parentUuid, 'pre-attachment-uuid');
  // chain は spike 内で繋がる
  const secondSpike = JSON.parse(lines[2]);
  assert.equal(secondSpike.parentUuid, firstSpike.uuid);
});

test('spikeInject: defaults assistant model to a real Claude model name', () => {
  const db = makeDb();
  seedSession(db);
  const target = makeTempJsonl();
  spikeInject({
    db,
    targetJsonlPath: target,
    newSessionId: 'NEW',
    cwd: '/repo',
    version: '2.1.x',
    gitBranch: 'main',
    tracer: 'aabbccdd',
  });
  const lines = readFileSync(target, 'utf8').split('\n').filter((l) => l.trim());
  const firstAssistant = JSON.parse(lines[1]); // index 1 = first assistant in [user, assistant, user, assistant]
  assert.equal(firstAssistant.message.model, 'claude-opus-4-7', 'Phase 0-5 retry: real model name not fake');
});

test('spikeInject: assistantModel override is honored', () => {
  const db = makeDb();
  seedSession(db);
  const target = makeTempJsonl();
  spikeInject({
    db,
    targetJsonlPath: target,
    newSessionId: 'NEW',
    cwd: '/repo',
    version: '2.1.x',
    gitBranch: 'main',
    tracer: '11223344',
    assistantModel: 'claude-overridden-model',
  });
  const lines = readFileSync(target, 'utf8').split('\n').filter((l) => l.trim());
  const firstAssistant = JSON.parse(lines[1]);
  assert.equal(firstAssistant.message.model, 'claude-overridden-model');
});

test('spikeInject: writes Claude Code-compatible shape (top-level fields)', () => {
  const db = makeDb();
  seedSession(db, { newSessionId: 'NEW-SESSION' });
  const target = makeTempJsonl();

  spikeInject({
    db,
    targetJsonlPath: target,
    newSessionId: 'NEW-SESSION',
    cwd: '/repo',
    version: '2.1.145',
    gitBranch: 'main',
    tracer: '00000000',
  });

  const lines = readFileSync(target, 'utf8').split('\n').filter((l) => l.trim());
  const u = JSON.parse(lines[0]);
  // user turn の必須 14 フィールド (Plan §6 リバース結果より)
  for (const k of [
    'parentUuid',
    'isSidechain',
    'promptId',
    'type',
    'message',
    'uuid',
    'timestamp',
    'permissionMode',
    'userType',
    'entrypoint',
    'cwd',
    'sessionId',
    'version',
    'gitBranch',
  ]) {
    assert.ok(k in u, `user line missing field: ${k}`);
  }
  assert.equal(u.type, 'user');
  assert.equal(u.sessionId, 'NEW-SESSION');
  assert.equal(u.version, '2.1.145');
  assert.equal(u.message.role, 'user');

  const a = JSON.parse(lines[1]);
  // assistant turn の必須 13 フィールド
  for (const k of [
    'parentUuid',
    'isSidechain',
    'message',
    'requestId',
    'type',
    'uuid',
    'timestamp',
    'userType',
    'entrypoint',
    'cwd',
    'sessionId',
    'version',
    'gitBranch',
  ]) {
    assert.ok(k in a, `assistant line missing field: ${k}`);
  }
  assert.equal(a.type, 'assistant');
  assert.equal(a.message.role, 'assistant');
  assert.ok(a.message.usage);
});
