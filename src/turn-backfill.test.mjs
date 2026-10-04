import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { backfillBodies, captureInFlightTurn, deriveTranscriptPath } from './turn-backfill.mjs';

function makeDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE bodies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      origin_session_id TEXT NOT NULL,
      turn_number INTEGER NOT NULL,
      role TEXT NOT NULL,
      text TEXT NOT NULL,
      token_count INTEGER,
      created_at INTEGER NOT NULL,
      turn_start TEXT,
      UNIQUE(session_id, origin_session_id, turn_number, role)
    );
  `);
  return db;
}

function withData(entries, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'tl-backfill-'));
  const path = join(dir, 'data.jsonl');
  writeFileSync(path, entries.map((entry) => JSON.stringify(entry)).join('\n'), 'utf8');
  try {
    return fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function entry(role, text, timestamp, extra = {}) {
  return {
    type: role,
    ...(timestamp === undefined ? {} : { timestamp }),
    ...extra,
    message: { role, content: [{ type: 'text', text }] },
  };
}

test('backfillBodies: multi-fragment group uses last fragment index for both body rows', () => {
  withData(
    [
      entry('user', 'question one'),
      entry('assistant', 'first fragment'),
      entry('assistant', 'last fragment'),
      entry('user', 'question two'),
      entry('assistant', 'second answer'),
    ],
    (path) => {
      const db = makeDb();
      const result = backfillBodies(db, {
        targetSessionId: 'target', originSessionId: 'origin', transcriptPath: path, now: 999,
      });
      assert.deepEqual(result, {
        groups: 2,
        insertedTurns: 2,
        skippedExisting: 0,
        lastTurnNumber: 4,
        turnNumbers: [2, 4],
      });
      assert.deepEqual(
        db.prepare('SELECT turn_number, role, text FROM bodies ORDER BY turn_number, role').all().map((row) => ({ ...row })),
        [
          { turn_number: 2, role: 'assistant', text: 'last fragment' },
          { turn_number: 2, role: 'user', text: 'question one' },
          { turn_number: 4, role: 'assistant', text: 'second answer' },
          { turn_number: 4, role: 'user', text: 'question two' },
        ],
      );
    },
  );
});

test('backfillBodies: junk final fragment falls back and all-junk group is dropped', () => {
  withData(
    [
      entry('user', 'keep this'),
      entry('assistant', 'real answer'),
      entry('assistant', "You've hit your session limit. Please try again later."),
      entry('user', 'drop this'),
      entry('assistant', 'API Error: unavailable'),
    ],
    (path) => {
      const db = makeDb();
      const result = backfillBodies(db, {
        targetSessionId: 'target', originSessionId: 'origin', transcriptPath: path, now: 999,
      });
      assert.equal(result.groups, 1);
      assert.equal(result.insertedTurns, 1);
      assert.deepEqual(
        db.prepare("SELECT turn_number, text FROM bodies WHERE role = 'assistant'").all().map((row) => ({ ...row })),
        [{ turn_number: 1, text: 'real answer' }],
      );
    },
  );
});

test('backfillBodies: user-only group is dropped', () => {
  withData([entry('user', 'unanswered')], (path) => {
    const db = makeDb();
    assert.deepEqual(
      backfillBodies(db, {
        targetSessionId: 'target', originSessionId: 'origin', transcriptPath: path, now: 999,
      }),
      { groups: 0, insertedTurns: 0, skippedExisting: 0, lastTurnNumber: null, turnNumbers: [] },
    );
  });
});

test('backfillBodies: a single pre-seeded fragment skips its whole group while other groups insert', () => {
  withData(
    [
      entry('user', 'first question'),
      entry('assistant', 'first fragment'),
      entry('assistant', 'last first fragment'),
      entry('user', 'second question'),
      entry('assistant', 'second answer'),
    ],
    (path) => {
      const db = makeDb();
      db.prepare(
        `INSERT INTO bodies
           (session_id, origin_session_id, turn_number, role, text, token_count, created_at)
         VALUES ('existing-target', 'origin', 1, 'assistant', 'existing fragment', 1, 1)`,
      ).run();
      const result = backfillBodies(db, {
        targetSessionId: 'target', originSessionId: 'origin', transcriptPath: path, now: 999,
      });
      assert.equal(result.insertedTurns, 1);
      assert.equal(result.skippedExisting, 1);
      assert.equal(
        db.prepare("SELECT COUNT(*) AS count FROM bodies WHERE text = 'last first fragment'").get().count,
        0,
      );
      assert.equal(
        db.prepare("SELECT COUNT(*) AS count FROM bodies WHERE turn_number = 4").get().count,
        2,
      );
    },
  );
});

test('backfillBodies: second run is idempotent', () => {
  withData([entry('user', 'question'), entry('assistant', 'answer')], (path) => {
    const db = makeDb();
    backfillBodies(db, { targetSessionId: 'target', originSessionId: 'origin', transcriptPath: path, now: 999 });
    assert.equal(
      backfillBodies(db, {
        targetSessionId: 'target', originSessionId: 'origin', transcriptPath: path, now: 999,
      }).insertedTurns,
      0,
    );
  });
});

test('backfillBodies: transcript timestamps are retained and absent timestamps use now', () => {
  withData(
    [
      entry('user', 'dated question', '2026-01-02T03:04:05.000Z'),
      entry('assistant', 'dated answer', '2026-01-02T03:04:06.000Z'),
      entry('user', 'undated question'),
      entry('assistant', 'undated answer'),
    ],
    (path) => {
      const db = makeDb();
      backfillBodies(db, { targetSessionId: 'target', originSessionId: 'origin', transcriptPath: path, now: 777 });
      assert.deepEqual(
        db.prepare('SELECT turn_number, role, created_at FROM bodies ORDER BY turn_number, role').all().map((row) => ({ ...row })),
        [
          { turn_number: 1, role: 'assistant', created_at: Date.parse('2026-01-02T03:04:06.000Z') },
          { turn_number: 1, role: 'user', created_at: Date.parse('2026-01-02T03:04:05.000Z') },
          { turn_number: 3, role: 'assistant', created_at: 777 },
          { turn_number: 3, role: 'user', created_at: 777 },
        ],
      );
    },
  );
});

test('backfillBodies: sidechain entries and missing or empty paths produce no groups', () => {
  withData(
    [entry('user', 'side question', undefined, { isSidechain: true }), entry('assistant', 'side answer', undefined, { isSidechain: true })],
    (path) => {
      const db = makeDb();
      assert.equal(
        backfillBodies(db, {
          targetSessionId: 'target', originSessionId: 'origin', transcriptPath: path, now: 999,
        }).groups,
        0,
      );
      assert.deepEqual(
        backfillBodies(db, {
          targetSessionId: 'target', originSessionId: 'origin', transcriptPath: null, now: 999,
        }),
        { groups: 0, insertedTurns: 0, skippedExisting: 0, lastTurnNumber: null, turnNumbers: [] },
      );
      assert.deepEqual(
        backfillBodies(db, {
          targetSessionId: 'target', originSessionId: 'origin', transcriptPath: '', now: 999,
        }),
        { groups: 0, insertedTurns: 0, skippedExisting: 0, lastTurnNumber: null, turnNumbers: [] },
      );
    },
  );
});

test('deriveTranscriptPath munges slash and dot characters with one leading dash', () => {
  assert.equal(
    deriveTranscriptPath('/Users/example/Developer/Through.line', 'session-id'),
    join(homedir(), '.claude', 'projects', '-Users-example-Developer-Through-line', 'session-id.jsonl'),
  );
});

test('backfillBodies: user row keeps the turn start and assistant row leaves it empty', () => {
  withData(
    [
      entry('user', 'wait for it', undefined, { origin: { kind: 'human' } }),
      entry('assistant', 'started'),
      entry('user', '<task-notification>\n<status>completed</status>\n</task-notification>', undefined, { origin: { kind: 'task-notification' } }),
      entry('assistant', 'finished'),
      entry('user', 'no marker'),
      entry('assistant', 'answered'),
    ],
    (path) => {
      const db = makeDb();
      backfillBodies(db, { targetSessionId: 'target', originSessionId: 'origin', transcriptPath: path, now: 1 });
      const rows = db.prepare('SELECT role, text, turn_start FROM bodies ORDER BY turn_number, role DESC').all();
      assert.deepEqual(rows.map((row) => [row.role, row.turn_start]), [
        ['user', 'prompt'], ['assistant', null],
        ['user', 'self'], ['assistant', null],
        ['user', 'unknown'], ['assistant', null],
      ]);
    },
  );
});

test('backfillBodies: 圧縮の要約行を数えていた頃に保存したターンは、重複させずにそのまま残す', () => {
  const summary = { type: 'user', isCompactSummary: true, message: { role: 'user', content: 'This session is being continued' } };
  withData(
    [
      entry('user', 'prompt', '2026-10-04T00:00:00Z'),
      entry('assistant', 'before compaction', '2026-10-04T00:00:01Z'),
      summary,
      entry('assistant', 'after compaction', '2026-10-04T00:00:03Z'),
      entry('user', 'next prompt', '2026-10-04T00:00:04Z'),
      entry('assistant', 'next answer', '2026-10-04T00:00:05Z'),
    ],
    (path) => {
      const db = makeDb();
      // 旧版は要約行を user 発言として、圧縮後の断片 (index 3) と組で保存していた
      const insert = db.prepare(
        `INSERT INTO bodies (session_id, origin_session_id, turn_number, role, text, token_count, created_at)
         VALUES ('S', 'S', 3, ?, ?, 1, 1)`,
      );
      insert.run('user', 'This session is being continued');
      insert.run('assistant', 'after compaction');
      const result = backfillBodies(db, { targetSessionId: 'S', originSessionId: 'S', transcriptPath: path, now: 1 });
      assert.equal(result.skippedExisting, 1, '同じ断片を持つ群は入れ直さない');
      assert.equal(result.insertedTurns, 1);
      assert.deepEqual(
        db.prepare('SELECT turn_number, role, text FROM bodies ORDER BY turn_number, role DESC').all().map((r) => [r.turn_number, r.role, r.text]),
        [
          [3, 'user', 'This session is being continued'],
          [3, 'assistant', 'after compaction'],
          [5, 'user', 'next prompt'],
          [5, 'assistant', 'next answer'],
        ],
      );
    },
  );
});

// --- 作業途中で止めたターンの取り込み (ADR 0033) ---

function withDetails(db) {
  db.exec(`
    CREATE TABLE details (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, origin_session_id TEXT,
      turn_number INTEGER, tool_name TEXT NOT NULL, input_text TEXT, output_text TEXT, token_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, kind TEXT, source_id TEXT);
    CREATE UNIQUE INDEX uq_details_source ON details(session_id, origin_session_id, source_id) WHERE source_id IS NOT NULL;
  `);
  return db;
}

const toolUse = (id, name, input) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
const toolResult = (id, content) => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] } });

test('captureInFlightTurn: 止めたターンの発言を全部つないで本文にし、末尾の道具まで details に入れる。合流時の回収は重ねない', () => {
  withData(
    [
      entry('user', '前の依頼', '2026-10-04T02:00:00Z'),
      entry('assistant', '前の回答', '2026-10-04T02:00:05Z'),
      entry('user', '3つ読んで', '2026-10-04T03:00:00Z'),
      toolUse('t1', 'Read', { file_path: '/w/1' }),
      toolResult('t1', 'one'),
      entry('assistant', '1 を読みました。', '2026-10-04T03:00:02Z'),
      toolUse('t2', 'Read', { file_path: '/w/2' }),
      toolResult('t2', 'two'),
      entry('assistant', '2 を読みました。', '2026-10-04T03:00:04Z'),
      toolUse('t3', 'Read', { file_path: '/w/3' }),
      toolResult('t3', 'PreToolUse:Read hook error'),
    ],
    (path) => {
      const db = withDetails(makeDb());
      const captured = captureInFlightTurn(db, { targetSessionId: 'S', originSessionId: 'S', transcriptPath: path, now: 9_000 });
      assert.deepEqual(captured, { turnNumber: 4, userAt: Date.parse('2026-10-04T03:00:00Z'),
        assistantAt: Date.parse('2026-10-04T03:00:04Z'), insertedBodies: true, details: 6 });
      assert.deepEqual(db.prepare('SELECT turn_number, role, text, turn_start FROM bodies ORDER BY id').all().map((row) => ({ ...row })), [
        { turn_number: 4, role: 'user', text: '3つ読んで', turn_start: 'unknown' },
        { turn_number: 4, role: 'assistant', text: '1 を読みました。\n\n2 を読みました。', turn_start: null },
      ]);
      assert.deepEqual(db.prepare('SELECT source_id, turn_number FROM details ORDER BY id').all().map((row) => `${row.source_id}@${row.turn_number}`),
        ['t1@4', 't1:result@4', 't2@4', 't2:result@4', 't3@4', 't3:result@4'], '最後の発言の後に呼んだ、止めた道具も入る');

      // もう一度取り込んでも増えない
      const again = captureInFlightTurn(db, { targetSessionId: 'S', originSessionId: 'S', transcriptPath: path, now: 9_500 });
      assert.equal(again.turnNumber, 4);
      assert.equal(again.insertedBodies, false);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM details').get().n, 6);

      // 後継が前任を合流させる時の回収: 完了した前のターンだけを入れ、止めたターンへ代表断片を重ねない
      const backfill = backfillBodies(db, { targetSessionId: 'S', originSessionId: 'S', transcriptPath: path, now: 9_900 });
      assert.equal(backfill.insertedTurns, 1);
      assert.equal(backfill.skippedExisting, 1);
      assert.equal(db.prepare(`SELECT text FROM bodies WHERE turn_number = 4 AND role = 'assistant'`).get().text,
        '1 を読みました。\n\n2 を読みました。');
    },
  );
});

test('captureInFlightTurn: 発言が1つも無いターンは、user の行と道具の入出力だけを入れる', () => {
  withData(
    [entry('user', '黙って読んで', '2026-10-04T03:00:00Z'), toolUse('t1', 'Read', { file_path: '/w/1' }), toolResult('t1', 'one'),
      toolUse('t2', 'Read', { file_path: '/w/2' })],
    (path) => {
      const db = withDetails(makeDb());
      const captured = captureInFlightTurn(db, { targetSessionId: 'S', originSessionId: 'S', transcriptPath: path, now: 9_000 });
      assert.deepEqual(captured, { turnNumber: 0, userAt: Date.parse('2026-10-04T03:00:00Z'), assistantAt: null, insertedBodies: true, details: 3 });
      assert.deepEqual(db.prepare('SELECT turn_number, role, text FROM bodies').all().map((row) => ({ ...row })),
        [{ turn_number: 0, role: 'user', text: '黙って読んで' }]);
      assert.equal(captureInFlightTurn(db, { targetSessionId: 'S', originSessionId: 'S', transcriptPath: join(path, 'none'), now: 1 }), null);
    },
  );
});

