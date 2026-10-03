import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import {
  buildDetailRowsFromActiveTurns,
  buildBodyRowsFromActiveTurns,
  buildCodexThroughlineSessionId,
  captureCodexRolloutToDb,
  codexSessionIdToThreadId,
} from './codex-capture.mjs';
import { buildHandoffRecord } from './handoff-record.mjs';
import { toThroughlineHandoffBlock } from './codex-handoff.mjs';

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

test('buildCodexThroughlineSessionId: namespaces Codex thread ids', () => {
  assert.equal(
    buildCodexThroughlineSessionId('019dfaba-f87e-7f41-a144-d5ca7c6dd7f9'),
    'codex:019dfaba-f87e-7f41-a144-d5ca7c6dd7f9',
  );
  assert.equal(
    codexSessionIdToThreadId('codex:019dfaba-f87e-7f41-a144-d5ca7c6dd7f9'),
    '019dfaba-f87e-7f41-a144-d5ca7c6dd7f9',
  );
});

test('buildBodyRowsFromActiveTurns: groups roles and preserves developer injected memory', () => {
  const sessionId = buildCodexThroughlineSessionId('019dfaba-f87e-7f41-a144-d5ca7c6dd7f9');
  const rows = buildBodyRowsFromActiveTurns(
    [
      {
        messages: [
          { role: 'user', text: 'first request', time: '2026-05-06T00:00:01.000Z' },
          { role: 'assistant', text: 'first answer', time: '2026-05-06T00:00:02.000Z' },
        ],
      },
      {
        messages: [
          {
            role: 'developer',
            text: '## Throughline: Active Work Context\nactive memory',
            time: '2026-05-06T00:00:03.000Z',
          },
        ],
      },
    ],
    { sessionId, now: 1 },
  );

  assert.deepEqual(
    rows.map((row) => [row.turnNumber, row.role, row.text]),
    [
      [1, 'user', 'first request'],
      [1, 'assistant', 'first answer'],
      [2, 'developer', '## Throughline: Active Work Context\nactive memory'],
    ],
  );
  assert.equal(rows[0].originSessionId, sessionId);
  assert.equal(rows[0].createdAt, Date.parse('2026-05-06T00:00:01.000Z'));
});

test('buildDetailRowsFromActiveTurns: stores Codex function call input and output', () => {
  const sessionId = buildCodexThroughlineSessionId('019dfaba-f87e-7f41-a144-d5ca7c6dd7f9');
  const rows = buildDetailRowsFromActiveTurns(
    [
      {
        messages: [{ role: 'assistant', text: 'I will inspect files' }],
        details: [
          {
            kind: 'tool_input',
            tool_name: 'exec_command',
            source_id: 'call_123',
            input_text: '{"cmd":"rtk rg TODO"}',
            output_text: null,
            time: '2026-05-06T00:00:02.000Z',
          },
          {
            kind: 'tool_output',
            tool_name: 'exec_command',
            source_id: 'call_123:output',
            input_text: null,
            output_text: 'TODO item\n',
            time: '2026-05-06T00:00:03.000Z',
          },
        ],
      },
    ],
    { sessionId, now: 1 },
  );

  assert.deepEqual(
    rows.map((row) => [
      row.turnNumber,
      row.kind,
      row.toolName,
      row.sourceId,
      row.inputText,
      row.outputText,
    ]),
    [
      [1, 'tool_input', 'exec_command', 'call_123', '{"cmd":"rtk rg TODO"}', null],
      [1, 'tool_output', 'exec_command', 'call_123:output', null, 'TODO item\n'],
    ],
  );
  assert.equal(rows[0].createdAt, Date.parse('2026-05-06T00:00:02.000Z'));
});

test('captureCodexRolloutToDb: rebuilds namespaced Codex session from active rollout turns', () => {
  const db = makeDb();
  const home = mkdtempSync(join(tmpdir(), 'tl-codex-home-'));
  const project = mkdtempSync(join(tmpdir(), 'tl-codex-project-'));
  const threadId = '019dfaba-f87e-7f41-a144-d5ca7c6dd7f9';
  try {
    writeRollout(home, {
      id: threadId,
      cwd: project,
      events: [
        event('user_message', { message: 'keep request' }),
        event('task_started'),
        responseItem({
          type: 'function_call',
          name: 'exec_command',
          arguments: '{"cmd":"rtk pwd"}',
          call_id: 'call_keep',
        }),
        responseItem({
          type: 'function_call_output',
          call_id: 'call_keep',
          output: 'Output:\n/tmp/project\n',
        }),
        event('agent_message', { message: 'keep answer' }),
        event('task_complete'),
        event('user_message', { message: 'rolled back request' }),
        event('task_started'),
        event('agent_message', { message: 'rolled back answer' }),
        event('task_complete'),
        event('thread_rolled_back', { num_turns: 1 }),
        responseItem({
          type: 'message',
          role: 'developer',
          content: [{ type: 'input_text', text: '## Throughline Trim Memory Preview\nmemory' }],
        }),
      ],
    });

    const result = captureCodexRolloutToDb(db, {
      threadId,
      codexHome: home,
      projectPath: project,
      now: 1234,
    });

    assert.equal(result.status, 'captured');
    assert.equal(result.sessionId, `codex:${threadId}`);
    assert.equal(result.capturedTurns, 1);
    assert.equal(result.capturedRows, 2);
    assert.equal(result.capturedDetails, 2);

    const rows = db
      .prepare('SELECT session_id, origin_session_id, turn_number, role, text FROM bodies ORDER BY id')
      .all();
    assert.deepEqual(
      rows.map((row) => [row.session_id, row.origin_session_id, row.turn_number, row.role, row.text]),
      [
        [`codex:${threadId}`, `codex:${threadId}`, 1, 'user', 'keep request'],
        [`codex:${threadId}`, `codex:${threadId}`, 1, 'assistant', 'keep answer'],
      ],
    );
    assert.equal(rows.some((row) => row.text.includes('rolled back')), false);

    const details = db
      .prepare(
        'SELECT turn_number, kind, tool_name, source_id, input_text, output_text FROM details ORDER BY id',
      )
      .all();
    assert.deepEqual(
      details.map((row) => [
        row.turn_number,
        row.kind,
        row.tool_name,
        row.source_id,
        row.input_text,
        row.output_text,
      ]),
      [
        [1, 'tool_input', 'exec_command', 'call_keep', '{"cmd":"rtk pwd"}', null],
        [1, 'tool_output', 'exec_command', 'call_keep:output', null, 'Output:\n/tmp/project\n'],
      ],
    );

    const record = buildHandoffRecord(db, { sessionId: `codex:${threadId}` });
    assert.equal(record.source.adapter, 'codex');
    const block = toThroughlineHandoffBlock(record, { hostMode: 'codex-primary' });
    assert.equal(block.data.sourceAgent, 'codex');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});

test('captureCodexRolloutToDb: Codex 0.151 response_item会話を取り込み旧event_msgとの重複を除く', () => {
  const db = makeDb();
  const home = mkdtempSync(join(tmpdir(), 'tl-codex-home-'));
  const project = mkdtempSync(join(tmpdir(), 'tl-codex-project-'));
  const threadId = '019dfaba-f87e-7f41-a144-d5ca7c6dd7f9';
  try {
    writeRollout(home, {
      id: threadId,
      cwd: project,
      events: [
        event('task_started'),
        responseItem({
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'current request' }],
        }),
        responseItem({
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'current answer' }],
        }),
        event('task_complete'),
        event('user_message', { message: 'dual request' }),
        event('task_started'),
        responseItem({
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'dual request' }],
        }),
        event('agent_message', { message: 'dual answer' }),
        responseItem({
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'dual answer' }],
        }),
        event('task_complete'),
      ],
    });

    const result = captureCodexRolloutToDb(db, {
      threadId,
      codexHome: home,
      projectPath: project,
      now: 1234,
    });

    assert.equal(result.capturedTurns, 2);
    assert.equal(result.capturedRows, 4);
    assert.deepEqual(
      db.prepare('SELECT turn_number, role, text FROM bodies ORDER BY id').all().map((row) => ({ ...row })),
      [
        { turn_number: 1, role: 'user', text: 'current request' },
        { turn_number: 1, role: 'assistant', text: 'current answer' },
        { turn_number: 2, role: 'user', text: 'dual request' },
        { turn_number: 2, role: 'assistant', text: 'dual answer' },
      ],
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});

test('captureCodexRolloutToDb: second capture removes stale rows from previous active tail', () => {
  const db = makeDb();
  const home = mkdtempSync(join(tmpdir(), 'tl-codex-home-'));
  const project = mkdtempSync(join(tmpdir(), 'tl-codex-project-'));
  const threadId = '019dfaba-f87e-7f41-a144-d5ca7c6dd7f9';
  try {
    const rollout = writeRollout(home, {
      id: threadId,
      cwd: project,
      events: [
        event('user_message', { message: 'stable request' }),
        event('task_started'),
        event('agent_message', { message: 'stable answer' }),
        event('task_complete'),
        event('user_message', { message: 'old tail request' }),
        event('task_started'),
        event('agent_message', { message: 'old tail answer' }),
        event('task_complete'),
      ],
    });

    captureCodexRolloutToDb(db, { threadId, codexHome: home, projectPath: project, now: 1 });
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM bodies').get().c, 4);

    writeRolloutRows(rollout, [
      sessionMeta(threadId, project),
      event('user_message', { message: 'stable request' }),
      event('task_started'),
      event('agent_message', { message: 'stable answer' }),
      event('task_complete'),
      event('user_message', { message: 'old tail request' }),
      event('task_started'),
      event('agent_message', { message: 'old tail answer' }),
      event('task_complete'),
      event('thread_rolled_back', { num_turns: 1 }),
    ]);

    captureCodexRolloutToDb(db, { threadId, codexHome: home, projectPath: project, now: 2 });

    const texts = db.prepare('SELECT text FROM bodies ORDER BY id').all().map((row) => row.text);
    assert.deepEqual(texts, ['stable request', 'stable answer']);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});

test('Desktopのcustom tool callと複数ブロックの結果をL3へ保存する', () => {
  const db = makeDb();
  const home = mkdtempSync(join(tmpdir(), 'tl-codex-custom-'));
  const project = mkdtempSync(join(tmpdir(), 'tl-codex-project-'));
  const threadId = '019dfaba-f87e-7f41-a144-d5ca7c6dd7f9';
  try {
    const output = [{ type: 'text', text: '処理結果' }, { type: 'text', text: '検証完了' }];
    writeRollout(home, { id: threadId, cwd: project, events: [
      event('task_started'), event('user_message', { message: '作業を続ける' }),
      responseItem({ type: 'custom_tool_call', call_id: 'custom-1', name: 'exec', input: 'await tools.exec_command({cmd:"pwd"})' }),
      responseItem({ type: 'custom_tool_call_output', call_id: 'custom-1', output }), event('task_complete'),
    ] });
    const captured = captureCodexRolloutToDb(db, { threadId, codexHome: home, projectPath: project });
    assert.equal(captured.capturedDetails, 2);
    const rows = db.prepare('SELECT kind, tool_name, input_text, output_text FROM details ORDER BY id').all();
    assert.equal(rows[0].kind, 'tool_input'); assert.equal(rows[0].tool_name, 'exec');
    assert.ok(rows[0].input_text.includes('exec_command'));
    assert.equal(rows[1].kind, 'tool_output'); assert.equal(rows[1].tool_name, 'exec');
    assert.deepEqual(JSON.parse(rows[1].output_text), output);
  } finally {
    db.close(); rmSync(home, { recursive: true, force: true }); rmSync(project, { recursive: true, force: true });
  }
});

test('codex-capture CLI captures an explicit Codex thread as JSON', () => {
  const home = mkdtempSync(join(tmpdir(), 'tl-codex-home-'));
  const userHome = mkdtempSync(join(tmpdir(), 'tl-user-home-'));
  const project = mkdtempSync(join(tmpdir(), 'tl-codex-project-'));
  const threadId = '019dfaba-f87e-7f41-a144-d5ca7c6dd7f9';
  try {
    writeRollout(home, {
      id: threadId,
      cwd: project,
      events: [
        event('user_message', { message: 'cli request' }),
        event('task_started'),
        event('agent_message', { message: 'cli answer' }),
        event('task_complete'),
      ],
    });

    const result = spawnSync(
      process.execPath,
      [
        join(process.cwd(), 'bin/throughline.mjs'),
        'codex-capture',
        '--json',
        '--codex-thread-id',
        threadId,
        '--codex-home',
        home,
      ],
      {
        cwd: project,
        encoding: 'utf8',
        env: {
          ...process.env,
          HOME: userHome,
          USERPROFILE: userHome,
        },
      },
    );

    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.status, 'captured');
    assert.equal(output.sessionId, `codex:${threadId}`);
    assert.equal(output.capturedTurns, 1);
    assert.equal(output.capturedRows, 2);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(userHome, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});

test('同じ会話の再captureはL1を保持し、ユーザー本文が変わったターンのL1だけを除く', () => {
  const db = makeDb();
  const home = mkdtempSync(join(tmpdir(), 'tl-codex-l1-'));
  const project = mkdtempSync(join(tmpdir(), 'tl-codex-project-'));
  const threadId = '019dfaba-f87e-7f41-a144-d5ca7c6dd7f9';
  const sessionId = `codex:${threadId}`;
  try {
    const events = request => [event('user_message', { message: request }), event('task_started'),
      event('agent_message', { message: '応答' }), event('task_complete')];
    const rollout = writeRollout(home, { id: threadId, cwd: project, events: events('依頼') });
    captureCodexRolloutToDb(db, { threadId, codexHome: home, projectPath: project });
    db.prepare('INSERT INTO skeletons (session_id, origin_session_id, turn_number, role, summary, created_at) VALUES (?, ?, 1, ?, ?, 1)')
      .run(sessionId, sessionId, 'assistant', '保存済み要約');
    captureCodexRolloutToDb(db, { threadId, codexHome: home, projectPath: project });
    assert.equal(db.prepare('SELECT summary FROM skeletons').get()?.summary, '保存済み要約');
    writeRolloutRows(rollout, [sessionMeta(threadId, project), ...events('変更後の依頼')]);
    captureCodexRolloutToDb(db, { threadId, codexHome: home, projectPath: project });
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM skeletons').get().c, 0);
  } finally {
    db.close();
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});

function writeRollout(home, { id, cwd, events }) {
  const dir = join(home, 'sessions', '2026', '05', '06');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `rollout-2026-05-06T09-40-50-${id}.jsonl`);
  writeRolloutRows(path, [sessionMeta(id, cwd), ...events]);
  return path;
}

function writeRolloutRows(path, rows) {
  writeFileSync(path, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
}

function sessionMeta(id, cwd) {
  return {
    timestamp: '2026-05-06T00:40:50.000Z',
    type: 'session_meta',
    payload: {
      id,
      timestamp: '2026-05-06T00:40:50.000Z',
      cwd,
      source: 'vscode',
      cli_version: '0.128.0-alpha.1',
    },
  };
}

function event(type, payload = {}) {
  return {
    timestamp: '2026-05-06T00:40:51.000Z',
    type: 'event_msg',
    payload: {
      type,
      ...payload,
    },
  };
}

function responseItem(payload) {
  return {
    timestamp: '2026-05-06T00:40:52.000Z',
    type: 'response_item',
    payload,
  };
}
