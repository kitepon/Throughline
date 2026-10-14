import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { backfillBodies, captureInFlightTurn, deriveTranscriptPath, TRANSCRIPT_GENERATION_SPAN } from './turn-backfill.mjs';

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

// --- host が書き直す transcript（Grok。ADR 0056） ---

const GROK = 'grok:11111111-2222-3333-4444-555555555555';
const grokUser = (text, extra = {}) => ({ type: 'user', content: [{ type: 'text', text }], ...extra });
const grokAssistant = (text) => ({ type: 'assistant', content: text, model_id: 'm' });
const grokSystem = { type: 'system', content: 'system prompt' };
const storedRows = (db) => db
  .prepare('SELECT turn_number, role, text FROM bodies ORDER BY turn_number, role DESC')
  .all()
  .map((row) => `${row.turn_number}${row.role[0]}=${row.text}`);
const grokBackfill = (db, entries) =>
  withData(entries, (path) => backfillBodies(db, { targetSessionId: GROK, originSessionId: GROK, transcriptPath: path, now: 999 }));

const GROK_BEFORE_COMPACTION = [
  grokSystem,
  grokUser('preamble'),
  grokUser('reminder', { synthetic_reason: 'system_reminder' }),
  grokUser('request 1', { prompt_index: 0 }),
  grokAssistant('working 1'),
  grokAssistant('answer 1'), // 4
  grokUser('request 2', { prompt_index: 1 }),
  grokAssistant('working 2'),
  grokAssistant('working 2b'),
  grokAssistant('answer 2'), // 8
];
// 圧縮の後。位置 4〜9 に、圧縮をまたいだターンの断片が並ぶ。位置 4 と 8 は保存済みの番号と重なる。
const grokAfterCompaction = (fragments) => [
  grokSystem,
  grokUser('summary', { synthetic_reason: 'compaction_meta' }),
  grokUser('line kept by the compaction'),
  grokUser('continue', { synthetic_reason: 'compaction_meta' }),
  grokUser('reminder', { synthetic_reason: 'system_reminder' }),
  ...fragments.map(grokAssistant),
];

test('backfillBodies: Grok が圧縮で書き直した後のターンは、番号が保存済みのターンと重なっても、新しい世代の番号で保存する', () => {
  const db = makeDb();
  const first = grokBackfill(db, GROK_BEFORE_COMPACTION);
  assert.deepEqual(first.turnNumbers, [4, 8]);
  assert.equal(first.rewritten, false);

  // 代表ではない断片（位置 8）だけが保存済みの番号と重なる形。直す前は、群を飛ばした後に受領で失敗した。
  const after = grokAfterCompaction(['after 1', 'after 2', 'after 3', 'after 4', 'after 5', 'answer 3']);
  const second = grokBackfill(db, after);
  const span = TRANSCRIPT_GENERATION_SPAN;
  assert.deepEqual(
    { groups: second.groups, insertedTurns: second.insertedTurns, skippedExisting: second.skippedExisting, rewritten: second.rewritten },
    { groups: 1, insertedTurns: 1, skippedExisting: 0, rewritten: true },
  );
  assert.deepEqual(second.turnNumbers, [span + 9]);
  assert.equal(second.lastTurnNumber, span + 9);
  assert.deepEqual(storedRows(db), [
    '4u=request 1', '4a=answer 1', '8u=request 2', '8a=answer 2',
    `${span + 9}u=line kept by the compaction`, `${span + 9}a=answer 3`,
  ]);

  // 同じ transcript をもう一度読んでも増えず、世代も進まない。
  const again = grokBackfill(db, after);
  assert.deepEqual(
    { insertedTurns: again.insertedTurns, skippedExisting: again.skippedExisting, rewritten: again.rewritten, turnNumbers: again.turnNumbers },
    { insertedTurns: 0, skippedExisting: 1, rewritten: false, turnNumbers: [span + 9] },
  );

  // 次のターンは同じ世代の続きの番号で入る。
  const next = grokBackfill(db, [...after, grokUser('request 4', { prompt_index: 3 }), grokAssistant('answer 4')]);
  assert.deepEqual(next.turnNumbers, [span + 9, span + 11]);
  assert.equal(next.insertedTurns, 1);
  assert.equal(next.rewritten, false);
});

test('backfillBodies: Grok の書き直し後に、代表の断片の番号が保存済みのターンと重なっても、黙って落とさない', () => {
  const db = makeDb();
  grokBackfill(db, GROK_BEFORE_COMPACTION);
  // 代表（位置 8）が、保存済みの「answer 2」の番号と重なる形。直す前は、失敗も出さずに落としていた。
  const result = grokBackfill(db, grokAfterCompaction(['after 1', 'after 2', 'after 3', 'after 4', 'answer 3']));
  assert.equal(result.insertedTurns, 1);
  assert.deepEqual(result.turnNumbers, [TRANSCRIPT_GENERATION_SPAN + 8]);
  assert.equal(
    db.prepare(`SELECT text FROM bodies WHERE turn_number = ? AND role = 'assistant'`).get(TRANSCRIPT_GENERATION_SPAN + 8).text,
    'answer 3',
  );
  assert.equal(db.prepare(`SELECT text FROM bodies WHERE turn_number = 8 AND role = 'assistant'`).get().text, 'answer 2');
});

test('backfillBodies: Grok の2回目の書き直しは、さらに次の世代の番号になる', () => {
  const db = makeDb();
  const span = TRANSCRIPT_GENERATION_SPAN;
  grokBackfill(db, GROK_BEFORE_COMPACTION);
  grokBackfill(db, grokAfterCompaction(['after 1', 'answer 3'])); // 世代 1 の位置 5
  const third = grokBackfill(db, grokAfterCompaction(['later 1', 'later 2', 'answer 5']));
  assert.equal(third.rewritten, true);
  assert.deepEqual(third.turnNumbers, [2 * span + 6]);
  assert.deepEqual(storedRows(db).filter((row) => row.includes('a=')), [
    '4a=answer 1', '8a=answer 2', `${span + 5}a=answer 3`, `${2 * span + 6}a=answer 5`,
  ]);
});

test('backfillBodies: Grok の巻き戻しで後ろだけが変わった時、変わっていないターンは重ねて入れない', () => {
  const db = makeDb();
  grokBackfill(db, GROK_BEFORE_COMPACTION);
  // 「request 2」より後ろを巻き戻して、別の依頼をした。位置 6〜7 に別の本文が入る。
  const rewound = [...GROK_BEFORE_COMPACTION.slice(0, 6), grokUser('request 2 again', { prompt_index: 1 }), grokAssistant('working'), grokAssistant('new answer 2')];
  const result = grokBackfill(db, rewound);
  assert.deepEqual(
    { insertedTurns: result.insertedTurns, skippedExisting: result.skippedExisting, rewritten: result.rewritten },
    { insertedTurns: 1, skippedExisting: 1, rewritten: true },
  );
  assert.deepEqual(result.turnNumbers, [4, TRANSCRIPT_GENERATION_SPAN + 7]);
  assert.deepEqual(storedRows(db).filter((row) => row.includes('a=')), [
    '4a=answer 1', '8a=answer 2', `${TRANSCRIPT_GENERATION_SPAN + 7}a=new answer 2`,
  ]);
});

test('backfillBodies: Grok の合成行を user として保存していた頃のターンは、群がまとまっても重ねて入れない', () => {
  const db = makeDb();
  // 直す前は、ターンの途中の system_reminder が群を2つに割っていた（代表は位置 3 と 5）。
  const insert = db.prepare(`INSERT INTO bodies (session_id, origin_session_id, turn_number, role, text, created_at) VALUES (?, ?, ?, ?, ?, 1)`);
  for (const [turn, role, text] of [[3, 'user', 'request 1'], [3, 'assistant', 'working 1'], [5, 'user', 'reminder'], [5, 'assistant', 'answer 1']]) {
    insert.run(GROK, GROK, turn, role, text);
  }
  const result = grokBackfill(db, [
    grokSystem,
    grokUser('preamble'),
    grokUser('reminder', { synthetic_reason: 'system_reminder' }),
    grokUser('request 1', { prompt_index: 0 }),
    grokAssistant('working 1'), // 3
    grokUser('reminder', { synthetic_reason: 'system_reminder' }),
    grokAssistant('answer 1'), // 5
  ]);
  assert.deepEqual(
    { groups: result.groups, insertedTurns: result.insertedTurns, skippedExisting: result.skippedExisting, rewritten: result.rewritten },
    { groups: 1, insertedTurns: 0, skippedExisting: 1, rewritten: false },
  );
  // 受領は、行が実際にある番号（最後に当たった行）で出す。
  assert.deepEqual(result.turnNumbers, [5]);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM bodies').get().n, 4);
});

test('backfillBodies: 追記だけの host（Claude Code）は、今までどおり位置だけで保存済みを決める', () => {
  const db = makeDb();
  const insert = db.prepare(`INSERT INTO bodies (session_id, origin_session_id, turn_number, role, text, created_at) VALUES (?, ?, ?, ?, ?, 1)`);
  insert.run('target', 'origin', 1, 'user', 'stored under another text');
  insert.run('target', 'origin', 1, 'assistant', 'stored under another text');
  withData([entry('user', 'question'), entry('assistant', 'answer')], (path) => {
    const result = backfillBodies(db, { targetSessionId: 'target', originSessionId: 'origin', transcriptPath: path, now: 999 });
    assert.deepEqual(
      { insertedTurns: result.insertedTurns, skippedExisting: result.skippedExisting, turnNumbers: result.turnNumbers },
      { insertedTurns: 0, skippedExisting: 1, turnNumbers: [1] },
    );
    assert.equal(result.rewritten, undefined);
  });
});

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


// --- ADR 0060: host が書いた meta の行でターンを区切っていた頃の行と、途中で届いた入力 ---

test('backfillBodies: meta の行で区切っていた頃に保存したターンは、群がまとまっても重ねて入れない', () => {
  const meta = { type: 'user', isMeta: true, message: { role: 'user', content: [{ type: 'text', text: 'skill の本文' }] } };
  const human = (text) => entry('user', text, undefined, { origin: { kind: 'human' } });
  const seeded = (turns) => {
    const db = makeDb();
    const insert = db.prepare(`INSERT INTO bodies (session_id, origin_session_id, turn_number, role, text, created_at) VALUES (?, ?, ?, ?, ?, 1)`);
    for (const [turn, user] of turns) {
      insert.run('target', 'origin', turn, 'user', user);
      insert.run('target', 'origin', turn, 'assistant', 'saved');
    }
    return db;
  };
  const run = (db, entries) => withData(entries, (path) =>
    backfillBodies(db, { targetSessionId: 'target', originSessionId: 'origin', transcriptPath: path, now: 999 }));

  // 前の版: [依頼, 途中の報告] と [skill の本文, 最終回答] の2群。今の版: 1群（断片 1 と 3）。
  const both = seeded([[1, '依頼'], [3, 'skill の本文']]);
  const split = [human('依頼'), entry('assistant', '途中の報告'), meta, entry('assistant', '最終回答')];
  assert.deepEqual(pick(run(both, split)), { groups: 1, insertedTurns: 0, skippedExisting: 1 });
  assert.equal(both.prepare('SELECT COUNT(*) AS n FROM bodies').get().n, 4);

  // 前の版: 依頼は本文の無い群で消え、[skill の本文, 最終回答] だけが入っていた。
  const lost = seeded([[2, 'skill の本文']]);
  assert.deepEqual(pick(run(lost, [human('依頼'), meta, entry('assistant', '最終回答')])),
    { groups: 1, insertedTurns: 0, skippedExisting: 1 });

  // 新しい会話では、依頼が user の行になる。
  const fresh = makeDb();
  assert.deepEqual(pick(run(fresh, [human('依頼'), meta, entry('assistant', '最終回答')])),
    { groups: 1, insertedTurns: 1, skippedExisting: 0 });
  assert.deepEqual(fresh.prepare('SELECT turn_number, role, text, turn_start FROM bodies ORDER BY role DESC').all().map((r) => ({ ...r })), [
    { turn_number: 2, role: 'user', text: '依頼', turn_start: 'prompt' },
    { turn_number: 2, role: 'assistant', text: '最終回答', turn_start: null },
  ]);
});

// --- ADR 0065: 予定（cron）が起こしたターンと、保存の後に断片が増えた群の受領の番号 ---

test('backfillBodies: 予定が起こしたターンは、前のターンへ足さず、新しいターンとして入れる', () => {
  const human = (text) => entry('user', text, undefined, { origin: { kind: 'human' } });
  const scheduled = {
    type: 'user', isMeta: true, promptId: 'p-cron', turnOrigin: 'scheduled', scheduledTaskId: '5ab219dd',
    promptSource: 'system', message: { role: 'user', content: '子の答えを見て、指揮官へ知らせる' },
  };
  const fire = { type: 'system', subtype: 'scheduled_task_fire', content: 'Running scheduled task', prompt: '子の答えを見て' };
  const db = makeDb();
  const run = (entries) => withData(entries, (path) =>
    backfillBodies(db, { targetSessionId: 'target', originSessionId: 'origin', transcriptPath: path, now: 999 }));

  const first = [human('待ってればいいの？'), entry('assistant', 'はい、待っていて')];
  assert.deepEqual(run(first), { groups: 1, insertedTurns: 1, skippedExisting: 0, lastTurnNumber: 1, turnNumbers: [1] });

  const result = run([...first, fire, scheduled, entry('assistant', 'Idle になった'), entry('assistant', '結果を送った')]);
  assert.deepEqual(result, { groups: 2, insertedTurns: 1, skippedExisting: 1, lastTurnNumber: 4, turnNumbers: [1, 4] });
  assert.deepEqual(db.prepare('SELECT turn_number, role, text, turn_start FROM bodies ORDER BY turn_number, role DESC').all().map((r) => ({ ...r })), [
    { turn_number: 1, role: 'user', text: '待ってればいいの？', turn_start: 'prompt' },
    { turn_number: 1, role: 'assistant', text: 'はい、待っていて', turn_start: null },
    { turn_number: 4, role: 'user', text: '子の答えを見て、指揮官へ知らせる', turn_start: 'self' },
    { turn_number: 4, role: 'assistant', text: '結果を送った', turn_start: null },
  ]);
});

test('backfillBodies: 保存の後に断片が増えた群は、保存した番号を受領の番号に返す', () => {
  const meta = { type: 'user', isMeta: true, message: { role: 'user', content: [{ type: 'text', text: 'skill の本文' }] } };
  const db = makeDb();
  const run = (entries) => withData(entries, (path) =>
    backfillBodies(db, { targetSessionId: 'target', originSessionId: 'origin', transcriptPath: path, now: 999 }));

  const first = [entry('user', '依頼', undefined, { origin: { kind: 'human' } }), entry('assistant', '途中の報告')];
  run(first);
  // 群の代表は 3 へ移るが、bodies にあるのは 1。3 を返すと、受領を出す所で「completed pair was not captured」になる。
  assert.deepEqual(run([...first, meta, entry('assistant', '最終回答')]),
    { groups: 1, insertedTurns: 0, skippedExisting: 1, lastTurnNumber: 1, turnNumbers: [1] });
});

function pick(result) {
  return { groups: result.groups, insertedTurns: result.insertedTurns, skippedExisting: result.skippedExisting };
}

test('backfillBodies / captureInFlightTurn: ターンの途中で届いた入力は、依頼の行へ入る', () => {
  const steer = (prompt) => ({ type: 'attachment', attachment: { type: 'queued_command', prompt, origin: { kind: 'human' } } });
  const entries = [
    entry('user', '依頼', undefined, { origin: { kind: 'human' } }),
    steer('追加の指示'),
    entry('assistant', '回答'),
  ];
  const done = makeDb();
  withData(entries, (path) => backfillBodies(done, { targetSessionId: 'target', originSessionId: 'origin', transcriptPath: path, now: 999 }));
  assert.equal(done.prepare(`SELECT text FROM bodies WHERE role = 'user'`).get().text, '依頼\n\n（作業の途中で届いた入力）\n追加の指示');

  const stopped = makeDb();
  stopped.exec(`CREATE TABLE details (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, origin_session_id TEXT, turn_number INTEGER,
    tool_name TEXT, input_text TEXT, output_text TEXT, token_count INTEGER, created_at INTEGER, kind TEXT, source_id TEXT)`);
  withData(entries.slice(0, 2), (path) => captureInFlightTurn(stopped, { targetSessionId: 'target', originSessionId: 'origin', transcriptPath: path, now: 999 }));
  assert.equal(stopped.prepare(`SELECT text FROM bodies WHERE role = 'user'`).get().text, '依頼\n\n（作業の途中で届いた入力）\n追加の指示');
});
