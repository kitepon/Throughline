import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { backfillBodies, deriveTranscriptPath } from './turn-backfill.mjs';

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

test('backfillBodies: beforeUserTurnNumber は作業途中のターンを回収から外す', () => {
  withData(
    [
      entry('user', 'done prompt', '2026-10-04T00:00:00Z'),
      entry('assistant', 'done answer', '2026-10-04T00:00:01Z'),
      entry('user', 'in-flight prompt', '2026-10-04T00:00:02Z'),
      entry('assistant', 'interim remark', '2026-10-04T00:00:03Z'),
    ],
    (path) => {
      const db = makeDb();
      const partial = backfillBodies(db, { targetSessionId: 'S', originSessionId: 'S', transcriptPath: path, now: 1, beforeUserTurnNumber: 2 });
      assert.equal(partial.insertedTurns, 1);
      assert.deepEqual(partial.turnNumbers, [1]);
      assert.deepEqual(db.prepare('SELECT text FROM bodies ORDER BY id').all().map((r) => r.text), ['done prompt', 'done answer']);
      // Stop で改めて全体を回収すると、作業途中だったターンが最終回答つきで入る
      const full = backfillBodies(db, { targetSessionId: 'S', originSessionId: 'S', transcriptPath: path, now: 1 });
      assert.equal(full.insertedTurns, 1);
      assert.equal(full.skippedExisting, 1);
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
