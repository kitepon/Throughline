import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { buildBudgetedResumeContext, INJECTION_BUDGET_CHARS } from '../resume-context.mjs';
import {
  parseArgs,
  readLatestProjectHandoffContext,
  readRecentProjectHandoffContext,
  readSessionProjectPath,
} from './handoff-context.mjs';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const BIN_PATH = join(REPO_ROOT, 'bin/throughline.mjs');
const SESSION_ID = 'claude-source-session';

function runCli(home, args = ['handoff-context', '--session', SESSION_ID, '--json']) {
  return spawnSync(process.execPath, [BIN_PATH, ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, HOME: home, USERPROFILE: home },
    encoding: 'utf8',
  });
}

function createFixture(home) {
  const dir = join(home, '.throughline');
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, 'throughline.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA user_version = 9;
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
      turn_number INTEGER NOT NULL,
      role TEXT NOT NULL,
      summary TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      origin_session_id TEXT
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
      turn_number INTEGER,
      tool_name TEXT NOT NULL,
      input_text TEXT,
      output_text TEXT,
      token_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      origin_session_id TEXT,
      kind TEXT NOT NULL DEFAULT 'tool_input',
      source_id TEXT
    );
  `);
  db.prepare(
    `INSERT INTO sessions
       (session_id, project_path, status, created_at, updated_at, merged_into)
     VALUES (?, ?, 'active', ?, ?, NULL)`,
  ).run(SESSION_ID, '/work/project', 1_700_000_000_000, 1_700_000_004_000);
  db.prepare(
    `INSERT INTO skeletons
       (session_id, origin_session_id, turn_number, role, summary, created_at)
     VALUES (?, ?, 1, 'assistant', ?, ?)`,
  ).run(SESSION_ID, 'older-origin', '以前に portable fork の方針を決めた', 1_700_000_001_000);
  const insertBody = db.prepare(
    `INSERT INTO bodies
       (session_id, origin_session_id, turn_number, role, text, token_count, created_at)
     VALUES (?, ?, 2, ?, ?, 8, ?)`,
  );
  insertBody.run(SESSION_ID, SESSION_ID, 'user', '所有権を変えずに記憶を渡して', 1_700_000_002_000);
  insertBody.run(SESSION_ID, SESSION_ID, 'assistant', 'read-only I/F を実装する', 1_700_000_003_000);
  db.prepare(
    `INSERT INTO details
       (session_id, origin_session_id, turn_number, tool_name, output_text, created_at, kind, source_id)
     VALUES (?, ?, 2, 'Read', 'schema inspected', ?, 'tool_output', 'detail-1')`,
  ).run(SESSION_ID, SESSION_ID, 1_700_000_003_500);
  return { db, dbPath };
}

function ownershipSnapshot(db) {
  return {
    sessions: db.prepare('SELECT session_id, merged_into FROM sessions ORDER BY session_id').all(),
    skeletons: db.prepare('SELECT id, session_id FROM skeletons ORDER BY id').all(),
    bodies: db.prepare('SELECT id, session_id FROM bodies ORDER BY id').all(),
    details: db.prepare('SELECT id, session_id FROM details ORDER BY id').all(),
  };
}

test('handoff-context emits the exact inheritance context without changing DB ownership', () => {
  const home = mkdtempSync(join(tmpdir(), 'tl-handoff-context-'));
  try {
    const { db, dbPath } = createFixture(home);
    const before = ownershipSnapshot(db);
    const expected = buildBudgetedResumeContext(db, {
      sessionId: SESSION_ID,
      isInheritance: true,
    })?.text;
    db.close();

    const result = runCli(home);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      schema: 'throughline.handoff_context.v1',
      status: 'ready',
      sessionId: SESSION_ID,
      context: expected,
    });

    const verify = new DatabaseSync(dbPath, { readOnly: true });
    assert.deepEqual(ownershipSnapshot(verify), before);
    verify.close();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('handoff-context adds a project-bound supplement inside the shared budget', () => {
  const home = mkdtempSync(join(tmpdir(), 'tl-handoff-supplement-'));
  try {
    const { db, dbPath } = createFixture(home);
    const before = ownershipSnapshot(db);
    db.close();
    const supplementFile = join(home, 'supplement.json');
    writeFileSync(supplementFile, JSON.stringify({
      schema: 'throughline.handoff_supplement.v1',
      projectPath: '/work/project',
      sections: [
        { title: '長期記憶', content: 'オーナーとの約束を大切にしている' },
        { title: '関連知識', content: 'BellTeamではBotごとにprojectを分離する' },
      ],
    }));

    const result = runCli(home, [
      'handoff-context', '--session', SESSION_ID, '--json',
      '--supplement-file', supplementFile,
    ]);
    assert.equal(result.status, 0, result.stderr);
    const context = JSON.parse(result.stdout).context;
    assert.match(context, /このBotの長期記憶と関連知識/);
    assert.match(context, /オーナーとの約束を大切にしている/);
    assert.match(context, /BellTeamではBotごとにprojectを分離する/);
    assert.match(context, /所有権を変えずに記憶を渡して/);
    assert.ok(context.indexOf('長期記憶') < context.indexOf('直前の対話'));
    assert.ok(context.length <= INJECTION_BUDGET_CHARS);

    const verify = new DatabaseSync(dbPath, { readOnly: true });
    assert.deepEqual(ownershipSnapshot(verify), before);
    verify.close();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('handoff-context supplement can silence disclosure without changing normal default', () => {
  const home = mkdtempSync(join(tmpdir(), 'tl-handoff-silent-'));
  try {
    const { db } = createFixture(home);
    db.close();
    const supplementFile = join(home, 'supplement.json');
    writeFileSync(supplementFile, JSON.stringify({
      schema: 'throughline.handoff_supplement.v1',
      projectPath: '/work/project',
      handoffDisclosure: 'silent',
      sections: [{ title: 'Botプロフィール', content: 'BellTeamのBot' }],
    }));

    const normal = runCli(home);
    assert.equal(normal.status, 0, normal.stderr);
    assert.match(JSON.parse(normal.stdout).context, /この引き継ぎ直後の最初の応答だけ/);

    const silent = runCli(home, [
      'handoff-context', '--session', SESSION_ID, '--json',
      '--supplement-file', supplementFile,
    ]);
    assert.equal(silent.status, 0, silent.stderr);
    const context = JSON.parse(silent.stdout).context;
    assert.doesNotMatch(context, /この引き継ぎ直後の最初の応答だけ/);
    assert.doesNotMatch(context, /Throughline で前のセッションから .* ターン分/);
    assert.match(context, /BellTeamのBot/);
    assert.match(context, /所有権を変えずに記憶を渡して/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('handoff-context can silence disclosure without a long-term-memory supplement', () => {
  const home = mkdtempSync(join(tmpdir(), 'tl-handoff-direct-silent-'));
  try {
    const { db } = createFixture(home);
    db.close();

    const result = runCli(home, [
      'handoff-context', '--session', SESSION_ID, '--json',
      '--disclosure', 'silent',
    ]);
    assert.equal(result.status, 0, result.stderr);
    const context = JSON.parse(result.stdout).context;
    assert.doesNotMatch(context, /この引き継ぎ直後の最初の応答だけ/);
    assert.doesNotMatch(context, /Throughline で前のセッションから .* ターン分/);
    assert.match(context, /所有権を変えずに記憶を渡して/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('handoff-context project selector skips the newest empty session', () => {
  const home = mkdtempSync(join(tmpdir(), 'tl-handoff-project-'));
  try {
    const { db, dbPath } = createFixture(home);
    db.prepare(
      `INSERT INTO sessions
         (session_id, project_path, status, created_at, updated_at, merged_into)
       VALUES ('newest-empty', '/work/project', 'active', ?, ?, NULL)`,
    ).run(1_700_000_005_000, 1_700_000_006_000);
    db.prepare(
      `INSERT INTO sessions
         (session_id, project_path, status, created_at, updated_at, merged_into)
       VALUES ('other-newest', '/work/other', 'active', ?, ?, NULL)`,
    ).run(1_700_000_007_000, 1_700_000_008_000);
    db.prepare(
      `INSERT INTO bodies
         (session_id, origin_session_id, turn_number, role, text, token_count, created_at)
       VALUES ('other-newest', 'other-newest', 1, 'user', 'OTHER_PROJECT_PRIVATE', 4, ?)`,
    ).run(1_700_000_007_500);
    db.close();

    const selected = readLatestProjectHandoffContext('/work/project', {
      dbPath,
      handoffDisclosure: 'silent',
    });
    assert.equal(selected.sessionId, SESSION_ID);
    assert.match(selected.context, /所有権を変えずに記憶を渡して/);

    const result = runCli(home, [
      'handoff-context', '--project', '/work/project', '--json',
      '--disclosure', 'silent',
    ]);
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, 'ready');
    assert.equal(payload.sessionId, SESSION_ID);
    assert.match(payload.context, /所有権を変えずに記憶を渡して/);
    assert.doesNotMatch(payload.context, /OTHER_PROJECT_PRIVATE/);
    assert.doesNotMatch(payload.context, /この引き継ぎ直後の最初の応答だけ/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('handoff-context project selector returns empty when the project has no dialogue', () => {
  const home = mkdtempSync(join(tmpdir(), 'tl-handoff-project-empty-'));
  try {
    const { db } = createFixture(home);
    db.exec('DELETE FROM details; DELETE FROM bodies; DELETE FROM skeletons;');
    db.close();

    const result = runCli(home, [
      'handoff-context', '--project', '/work/project', '--json',
      '--disclosure', 'silent',
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      schema: 'throughline.handoff_context.v1',
      status: 'empty',
      sessionId: null,
      context: '',
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('handoff-context returns a project-bound supplement when the captured session has no dialogue yet', () => {
  const home = mkdtempSync(join(tmpdir(), 'tl-handoff-supplement-only-'));
  try {
    const { db, dbPath } = createFixture(home);
    db.exec('DELETE FROM details; DELETE FROM bodies; DELETE FROM skeletons;');
    const before = ownershipSnapshot(db);
    db.close();
    const supplementFile = join(home, 'supplement.json');
    writeFileSync(supplementFile, JSON.stringify({
      schema: 'throughline.handoff_supplement.v1',
      projectPath: '/work/project',
      sections: [{ title: 'Botプロフィール', content: '名前はCursor確認担当' }],
    }));

    const result = runCli(home, [
      'handoff-context', '--session', SESSION_ID, '--json',
      '--supplement-file', supplementFile,
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      schema: 'throughline.handoff_context.v1',
      status: 'ready',
      sessionId: SESSION_ID,
      context: '## このBotの長期記憶と関連知識\n\n### Botプロフィール\n名前はCursor確認担当',
    });

    const verify = new DatabaseSync(dbPath, { readOnly: true });
    assert.deepEqual(ownershipSnapshot(verify), before);
    verify.close();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('handoff-context refuses a supplement from another bot project', () => {
  const home = mkdtempSync(join(tmpdir(), 'tl-handoff-supplement-scope-'));
  try {
    const { db } = createFixture(home);
    db.close();
    const supplementFile = join(home, 'supplement.json');
    writeFileSync(supplementFile, JSON.stringify({
      schema: 'throughline.handoff_supplement.v1',
      projectPath: '/work/other-bot',
      sections: [{ title: '長期記憶', content: 'B_PRIVATE_MEMORY' }],
    }));

    const result = runCli(home, [
      'handoff-context', '--session', SESSION_ID, '--json',
      '--supplement-file', supplementFile,
    ]);
    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stdout, /B_PRIVATE_MEMORY/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('handoff-context accepts only the documented supplement argument shape', () => {
  assert.deepEqual(parseArgs(['--session', 's', '--json']), {
    sessionId: 's',
    projectPath: null,
    supplementFile: null,
    handoffDisclosure: 'visible',
    projectSessions: 'latest',
  });
  assert.deepEqual(parseArgs([
    '--session', 's', '--json', '--supplement-file', '/tmp/memory.json',
  ]), {
    sessionId: 's',
    projectPath: null,
    supplementFile: '/tmp/memory.json',
    handoffDisclosure: 'visible',
    projectSessions: 'latest',
  });
  assert.deepEqual(parseArgs([
    '--project', '.', '--json', '--disclosure', 'silent',
  ]), {
    sessionId: null,
    projectPath: process.cwd(),
    supplementFile: null,
    handoffDisclosure: 'silent',
    projectSessions: 'latest',
  });
  assert.deepEqual(parseArgs([
    '--project', '.', '--json', '--disclosure', 'silent', '--sessions', 'recent',
  ]), {
    sessionId: null,
    projectPath: process.cwd(),
    supplementFile: null,
    handoffDisclosure: 'silent',
    projectSessions: 'recent',
  });
  assert.equal(parseArgs(['--project', '.', '--json', '--sessions', 'latest']).projectSessions, 'latest');
  // 複数 session をまたぐのは --project だけ。--session の意味は変えない
  assert.throws(() => parseArgs(['--session', 's', '--json', '--sessions', 'recent']));
  assert.throws(() => parseArgs(['--session', 's', '--json', '--sessions', 'latest']));
  assert.throws(() => parseArgs(['--project', '.', '--json', '--sessions', 'all']));
  assert.throws(() => parseArgs(['--project', '.', '--json', '--sessions', 'recent', '--sessions', 'recent']));
  assert.throws(() => parseArgs(['--session', 's', '--supplement-file', '/tmp/memory.json', '--json']));
  assert.throws(() => parseArgs(['--project', '.', '--json', '--supplement-file', '/tmp/memory.json']));
  assert.throws(() => parseArgs(['--session', 's', '--json', '--disclosure', 'hidden']));
  assert.throws(() => parseArgs([
    '--session', 's', '--json', '--disclosure', 'silent',
    '--supplement-file', '/tmp/memory.json',
  ]));
});

test('readSessionProjectPath returns the source session project', () => {
  const home = mkdtempSync(join(tmpdir(), 'tl-session-project-'));
  try {
    const { db, dbPath } = createFixture(home);
    db.close();
    assert.equal(readSessionProjectPath(SESSION_ID, { dbPath }), '/work/project');
    assert.equal(readSessionProjectPath('missing', { dbPath }), null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('handoff-context excludes another bot project from every memory layer', () => {
  const home = mkdtempSync(join(tmpdir(), 'tl-handoff-context-project-scope-'));
  try {
    const { db } = createFixture(home);
    db.prepare(
      `INSERT INTO sessions
         (session_id, project_path, status, created_at, updated_at, merged_into)
       VALUES ('bot-b-session', '/work/other-bot', 'active', 1, 4, NULL)`,
    ).run();
    db.prepare(
      `INSERT INTO skeletons
         (session_id, origin_session_id, turn_number, role, summary, created_at)
       VALUES ('bot-b-session', 'bot-b-session', 1, 'assistant', 'B_PRIVATE_L1', 1)`,
    ).run();
    db.prepare(
      `INSERT INTO bodies
         (session_id, origin_session_id, turn_number, role, text, token_count, created_at)
       VALUES ('bot-b-session', 'bot-b-session', 2, 'user', 'B_PRIVATE_L2', 4, 2)`,
    ).run();
    db.prepare(
      `INSERT INTO details
         (session_id, origin_session_id, turn_number, tool_name, output_text, created_at, kind, source_id)
       VALUES ('bot-b-session', 'bot-b-session', 2, 'B_PRIVATE_L3', 'B_PRIVATE_DETAIL', 3, 'tool_output', 'bot-b-detail')`,
    ).run();
    db.close();

    const result = runCli(home);
    assert.equal(result.status, 0, result.stderr);
    const context = JSON.parse(result.stdout).context;
    assert.doesNotMatch(context, /B_PRIVATE_L1|B_PRIVATE_L2|B_PRIVATE_L3|B_PRIVATE_DETAIL/);
    assert.match(context, /所有権を変えずに記憶を渡して/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('handoff-context fails without creating a missing database', () => {
  const home = mkdtempSync(join(tmpdir(), 'tl-handoff-context-missing-'));
  try {
    const result = runCli(home);
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(join(home, '.throughline')), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

function insertProjectSession(db, { sessionId, projectPath = '/work/project', updatedAt, turns }) {
  db.prepare(
    `INSERT INTO sessions
       (session_id, project_path, status, created_at, updated_at, merged_into)
     VALUES (?, ?, 'active', ?, ?, NULL)`,
  ).run(sessionId, projectPath, updatedAt - 1000, updatedAt);
  const insertBody = db.prepare(
    `INSERT INTO bodies
       (session_id, origin_session_id, turn_number, role, text, token_count, created_at)
     VALUES (?, ?, ?, ?, ?, 4, ?)`,
  );
  turns.forEach(([user, assistant, at], index) => {
    insertBody.run(sessionId, sessionId, index + 1, 'user', user, at);
    insertBody.run(sessionId, sessionId, index + 1, 'assistant', assistant, at + 500);
  });
}

const PROJECT_ARGS = ['handoff-context', '--project', '/work/project', '--json', '--disclosure', 'silent'];

test('handoff-context --sessions recent adds earlier sessions of the same project only', () => {
  const home = mkdtempSync(join(tmpdir(), 'tl-handoff-recent-'));
  try {
    const { db, dbPath } = createFixture(home);
    // 5 ターンの作業の会話が、最新の 1 ターンの会話より前にある
    insertProjectSession(db, {
      sessionId: 'earlier-work',
      updatedAt: 1_699_999_990_000,
      turns: [1, 2, 3, 4, 5].map((n) => [
        `EARLIER_REQUEST_${n}`, `EARLIER_RESULT_${n}`, 1_699_999_900_000 + n * 10_000,
      ]),
    });
    insertProjectSession(db, {
      sessionId: 'other-project-work',
      projectPath: '/work/other',
      updatedAt: 1_700_000_009_000,
      turns: [['OTHER_PROJECT_PRIVATE', 'OTHER_PROJECT_ANSWER', 1_700_000_008_000]],
    });
    const before = ownershipSnapshot(db);
    db.close();

    // 引数を付けない時と --sessions latest は、今までと同じ出力
    const latest = runCli(home, PROJECT_ARGS);
    assert.equal(latest.status, 0, latest.stderr);
    const latestPayload = JSON.parse(latest.stdout);
    assert.deepEqual(Object.keys(latestPayload), ['schema', 'status', 'sessionId', 'context']);
    assert.doesNotMatch(latestPayload.context, /EARLIER_REQUEST/);
    assert.equal(runCli(home, [...PROJECT_ARGS, '--sessions', 'latest']).stdout, latest.stdout);

    const recent = runCli(home, [...PROJECT_ARGS, '--sessions', 'recent']);
    assert.equal(recent.status, 0, recent.stderr);
    const payload = JSON.parse(recent.stdout);
    assert.deepEqual(Object.keys(payload), ['schema', 'status', 'sessionId', 'context', 'sessions']);
    assert.equal(payload.schema, 'throughline.handoff_context.v1');
    assert.equal(payload.status, 'ready');
    assert.equal(payload.sessionId, SESSION_ID);
    assert.ok(payload.context.startsWith(`${latestPayload.context}\n\n## Throughline: このprojectで記録された過去の会話`));
    assert.ok(payload.context.length <= INJECTION_BUDGET_CHARS);
    for (let n = 1; n <= 5; n += 1) {
      assert.ok(payload.context.includes(`EARLIER_REQUEST_${n}`));
      assert.ok(payload.context.includes(`EARLIER_RESULT_${n}`));
    }
    assert.match(payload.context, /（5ターン \/ session earlier-work）/);
    assert.doesNotMatch(payload.context, /OTHER_PROJECT_PRIVATE|OTHER_PROJECT_ANSWER|other-project-work/);
    assert.deepEqual(payload.sessions, [
      {
        sessionId: SESSION_ID,
        role: 'current',
        firstTurnAt: new Date(1_700_000_002_000).toISOString(),
        lastTurnAt: new Date(1_700_000_003_000).toISOString(),
        turns: 1,
        includedTurns: 1,
      },
      {
        sessionId: 'earlier-work',
        role: 'past',
        firstTurnAt: new Date(1_699_999_910_000).toISOString(),
        lastTurnAt: new Date(1_699_999_950_500).toISOString(),
        turns: 5,
        includedTurns: 5,
      },
    ]);

    const selected = readRecentProjectHandoffContext('/work/project', {
      dbPath,
      handoffDisclosure: 'silent',
    });
    assert.equal(selected.context, payload.context);

    const verify = new DatabaseSync(dbPath, { readOnly: true });
    assert.deepEqual(ownershipSnapshot(verify), before);
    verify.close();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('handoff-context --sessions recent matches the default when the project has one session', () => {
  const home = mkdtempSync(join(tmpdir(), 'tl-handoff-recent-single-'));
  try {
    const { db } = createFixture(home);
    // 本文の無い session と別 project の session は、過去の会話に数えない
    db.prepare(
      `INSERT INTO sessions
         (session_id, project_path, status, created_at, updated_at, merged_into)
       VALUES ('newest-empty', '/work/project', 'active', ?, ?, NULL)`,
    ).run(1_700_000_005_000, 1_700_000_006_000);
    insertProjectSession(db, {
      sessionId: 'other-project-work',
      projectPath: '/work/other',
      updatedAt: 1_699_999_990_000,
      turns: [['OTHER_PROJECT_PRIVATE', 'OTHER_PROJECT_ANSWER', 1_699_999_900_000]],
    });
    db.close();

    for (const disclosure of ['silent', 'visible']) {
      const args = ['handoff-context', '--project', '/work/project', '--json', '--disclosure', disclosure];
      const latest = runCli(home, args);
      const recent = runCli(home, [...args, '--sessions', 'recent']);
      assert.equal(latest.status, 0, latest.stderr);
      assert.equal(recent.status, 0, recent.stderr);
      const latestPayload = JSON.parse(latest.stdout);
      const { sessions, ...rest } = JSON.parse(recent.stdout);
      assert.deepEqual(rest, latestPayload);
      assert.deepEqual(sessions.map((s) => [s.sessionId, s.role, s.turns, s.includedTurns]), [
        [SESSION_ID, 'current', 1, 1],
      ]);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('handoff-context --sessions recent returns empty with an empty session list', () => {
  const home = mkdtempSync(join(tmpdir(), 'tl-handoff-recent-empty-'));
  try {
    const { db } = createFixture(home);
    db.exec('DELETE FROM details; DELETE FROM bodies; DELETE FROM skeletons;');
    db.close();

    const result = runCli(home, [...PROJECT_ARGS, '--sessions', 'recent']);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      schema: 'throughline.handoff_context.v1',
      status: 'empty',
      sessionId: null,
      context: '',
      sessions: [],
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('handoff-context rejects --sessions together with --session', () => {
  const home = mkdtempSync(join(tmpdir(), 'tl-handoff-recent-usage-'));
  try {
    const { db } = createFixture(home);
    db.close();

    for (const args of [
      ['handoff-context', '--session', SESSION_ID, '--json', '--sessions', 'recent'],
      [...PROJECT_ARGS, '--sessions', 'everything'],
    ]) {
      const result = runCli(home, args);
      assert.equal(result.status, 2);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /^Usage: throughline handoff-context /);
      assert.match(result.stderr, /\[--sessions latest\|recent\]/);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
