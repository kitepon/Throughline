import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  L2_WINDOW,
  CLAUDE_STOP_TRANSCRIPT_FLUSH_INTERVAL_MS,
  CLAUDE_STOP_TRANSCRIPT_FLUSH_TIMEOUT_MS,
  countDistinctBodyTurns,
  pickOldestUnsummarizedTurn,
  publishCapturedClaudeCompletionReceipt,
  waitForClaudeStopTranscriptFlush,
} from './turn-processor.mjs';

function makeDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
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
  `);
  return db;
}

/** 1 往復 (user+assistant) を同じ turn_number で保存。実装と同じペアリング規約。 */
function insertTurn(db, { session, origin, turn, createdAt }) {
  const stmt = db.prepare(
    `INSERT INTO bodies (session_id, origin_session_id, turn_number, role, text, token_count, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  stmt.run(session, origin, turn, 'user', `u${turn}`, 1, createdAt);
  stmt.run(session, origin, turn, 'assistant', `a${turn}`, 1, createdAt);
}

function insertSkeleton(db, { session, origin, turn, createdAt }) {
  db.prepare(
    `INSERT INTO skeletons (session_id, origin_session_id, turn_number, role, summary, created_at)
     VALUES (?, ?, ?, 'assistant', ?, ?)`,
  ).run(session, origin, turn, `s${turn}`, createdAt);
}

test('L2_WINDOW is 20', () => {
  assert.equal(L2_WINDOW, 20);
});

test('Claude Stop flush barrierはlatest userの遅延assistantを待ち、過去の同文answerを採用しない', async () => {
  const root = mkdtempSync(join(tmpdir(), 'throughline-stop-flush-'));
  const transcriptPath = join(root, 'transcript.jsonl');
  const answer = 'same answer';
  let elapsed = 0;
  let waits = 0;
  try {
    writeFileSync(
      transcriptPath,
      [
        { type: 'user', message: { role: 'user', content: 'old question' } },
        { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: answer }] } },
        { type: 'user', message: { role: 'user', content: 'current question' } },
      ].map((entry) => JSON.stringify(entry)).join('\n'),
      'utf8',
    );
    const result = await waitForClaudeStopTranscriptFlush({
      transcriptPath,
      lastAssistantMessage: answer,
      timeoutMs: 100,
      intervalMs: 10,
      now: () => elapsed,
      wait: async (milliseconds) => {
        elapsed += milliseconds;
        waits++;
        if (waits === 1) {
          appendFileSync(
            transcriptPath,
            `\n${JSON.stringify({
              type: 'assistant',
              message: { role: 'assistant', content: [{ type: 'text', text: answer }] },
            })}`,
            'utf8',
          );
        }
      },
    });
    assert.deepEqual(result, { status: 'ready', userTurnNumber: 2, assistantTurnNumber: 3 });
    assert.equal(waits, 1, 'past identical answer must not satisfy the current user group');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Claude Stop flush barrierは、前後の空白を除いてmarkerと本文を比べる', async () => {
  const root = mkdtempSync(join(tmpdir(), 'throughline-stop-flush-trim-'));
  const transcriptPath = join(root, 'transcript.jsonl');
  const text = (role, value) => ({ type: role, message: { role, content: [{ type: 'text', text: value }] } });
  let elapsed = 0;
  const clock = { now: () => elapsed, wait: async (milliseconds) => { elapsed += milliseconds; } };
  const write = (entries) => writeFileSync(
    transcriptPath, entries.map((entry) => JSON.stringify(entry)).join('\n'), 'utf8');
  try {
    // 実測（2026-08-31、Mac）: 本文が空白で始まるturn。Claude Codeはmarkerを `.trim()` して渡す。
    write([text('user', 'request'), text('assistant', ' answer with a leading space')]);
    assert.deepEqual(await waitForClaudeStopTranscriptFlush({
      transcriptPath, lastAssistantMessage: 'answer with a leading space', timeoutMs: 100, intervalMs: 10, ...clock,
    }), { status: 'ready', userTurnNumber: 0, assistantTurnNumber: 1 });
    assert.equal(elapsed, 0, 'a whitespace-only difference must not wait for the deadline');

    write([text('user', 'request'), text('assistant', '\n\nanswer with newlines\n')]);
    assert.deepEqual(await waitForClaudeStopTranscriptFlush({
      transcriptPath, lastAssistantMessage: 'answer with newlines', timeoutMs: 100, intervalMs: 10, ...clock,
    }), { status: 'ready', userTurnNumber: 0, assistantTurnNumber: 1 });

    // 1つ前のgroupを採用する経路（ADR 0026）も同じ比べ方をする。
    write([text('user', 'request'), text('assistant', ' answer'), text('user', 'queued request')]);
    assert.deepEqual(await waitForClaudeStopTranscriptFlush({
      transcriptPath, lastAssistantMessage: 'answer', timeoutMs: 100, intervalMs: 10,
      isTurnCaptured: () => false, ...clock,
    }), { status: 'ready', userTurnNumber: 0, assistantTurnNumber: 1 });
    assert.equal(elapsed, 0);

    // 空白以外が違う本文は一致させない。
    write([text('user', 'request'), text('assistant', ' answer')]);
    await assert.rejects(waitForClaudeStopTranscriptFlush({
      transcriptPath, lastAssistantMessage: 'another answer', timeoutMs: 30, intervalMs: 10, ...clock,
    }), /not visible before deadline/);
    await assert.rejects(waitForClaudeStopTranscriptFlush({
      transcriptPath, lastAssistantMessage: 'ans wer', timeoutMs: 30, intervalMs: 10, ...clock,
    }), /not visible before deadline/);

    // 空白だけのmarkerは、無いものとして扱う。
    assert.deepEqual(await waitForClaudeStopTranscriptFlush({
      transcriptPath, lastAssistantMessage: ' \n', timeoutMs: 30, intervalMs: 10, ...clock,
    }), { status: 'marker_unavailable' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Claude Stop flush barrierは、Stop直後に次のuser行が届いても、未捕捉の完了turnを待たずに採用する', async () => {
  const root = mkdtempSync(join(tmpdir(), 'throughline-stop-flush-next-user-'));
  const transcriptPath = join(root, 'transcript.jsonl');
  const text = (role, value) => ({ type: role, message: { role, content: [{ type: 'text', text: value }] } });
  let elapsed = 0;
  const clock = { now: () => elapsed, wait: async (milliseconds) => { elapsed += milliseconds; } };
  try {
    writeFileSync(transcriptPath, [
      text('user', 'first request'),
      text('assistant', 'first answer'),
      text('user', 'second request'),
      text('assistant', 'second answer'),
      text('user', 'queued request delivered right after Stop'),
    ].map((entry) => JSON.stringify(entry)).join('\n'), 'utf8');

    const captured = [];
    const result = await waitForClaudeStopTranscriptFlush({
      transcriptPath,
      lastAssistantMessage: 'second answer',
      timeoutMs: 100,
      intervalMs: 10,
      isTurnCaptured: (fragmentTurnNumbers) => { captured.push(fragmentTurnNumbers); return false; },
      ...clock,
    });
    assert.deepEqual(result, { status: 'ready', userTurnNumber: 2, assistantTurnNumber: 3 });
    assert.deepEqual(captured, [[3]]);
    assert.equal(elapsed, 0, 'the completed turn is already flushed; no waiting');

    // 捕捉済みの同文answerは今回のStopの完了ではない。待って、deadlineで明示失敗する。
    elapsed = 0;
    await assert.rejects(waitForClaudeStopTranscriptFlush({
      transcriptPath, lastAssistantMessage: 'second answer', timeoutMs: 100, intervalMs: 10,
      isTurnCaptured: () => true, ...clock,
    }), /not visible before deadline/);
    assert.equal(elapsed, 100);

    // DBを確かめられない呼び出しは、前のturnを採用しない（既定）。
    elapsed = 0;
    await assert.rejects(waitForClaudeStopTranscriptFlush({
      transcriptPath, lastAssistantMessage: 'second answer', timeoutMs: 30, intervalMs: 10, ...clock,
    }), /not visible before deadline/);

    // 2つ前のturnは採用しない。
    elapsed = 0;
    await assert.rejects(waitForClaudeStopTranscriptFlush({
      transcriptPath, lastAssistantMessage: 'first answer', timeoutMs: 30, intervalMs: 10,
      isTurnCaptured: () => false, ...clock,
    }), /not visible before deadline/);

    // 次のturnが本文を書き始めていたら採用しない。進行中のturnを完了扱いで捕捉しないため。
    appendFileSync(transcriptPath, `\n${JSON.stringify(text('assistant', 'working on the queued request'))}`, 'utf8');
    elapsed = 0;
    await assert.rejects(waitForClaudeStopTranscriptFlush({
      transcriptPath, lastAssistantMessage: 'second answer', timeoutMs: 30, intervalMs: 10,
      isTurnCaptured: () => false, ...clock,
    }), /not visible before deadline/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Claude Stop flush barrierはmarker不一致をdeadlineで明示失敗する', async () => {
  let elapsed = 0;
  await assert.rejects(
    waitForClaudeStopTranscriptFlush({
      transcriptPath: '/missing',
      lastAssistantMessage: 'expected',
      timeoutMs: 30,
      intervalMs: 10,
      readCompletion: () => ({ userTurnNumber: 4, assistantTurnNumber: null, assistantContent: null }),
      now: () => elapsed,
      wait: async (milliseconds) => { elapsed += milliseconds; },
    }),
    /not visible before deadline/,
  );
  assert.equal(elapsed, 30);
});

test('Claude Stop flush barrierはmarkerなし旧payloadをone-shot互換へ残す', async () => {
  let reads = 0;
  const result = await waitForClaudeStopTranscriptFlush({
    transcriptPath: '/unused',
    lastAssistantMessage: undefined,
    readCompletion: () => { reads++; return null; },
  });
  assert.deepEqual(result, { status: 'marker_unavailable' });
  assert.equal(reads, 0);
  assert.equal(CLAUDE_STOP_TRANSCRIPT_FLUSH_TIMEOUT_MS, 2_000);
  assert.equal(CLAUDE_STOP_TRANSCRIPT_FLUSH_INTERVAL_MS, 25);
});

test('publishCapturedClaudeCompletionReceipt: L2 capture済みpairをL1/L3より先にprivate receiptへ固定する', () => {
  const db = makeDb();
  const root = mkdtempSync(join(tmpdir(), 'throughline-turn-receipt-'));
  const storePath = join(root, 'state', 'completed-turn-receipts.json');
  try {
    insertTurn(db, { session: 'target', origin: 'origin', turn: 7, createdAt: 1234 });
    db.prepare(
      `UPDATE bodies SET text = CASE role WHEN 'user' THEN ' request\r\n' ELSE 'answer' END
       WHERE session_id = 'target' AND origin_session_id = 'origin' AND turn_number = 7`,
    ).run();
    const first = publishCapturedClaudeCompletionReceipt(db, {
      target: 'target', origin: 'origin', turnNumber: 7, projectPath: '/repo',
      receiptOptions: { storePath },
    });
    const second = publishCapturedClaudeCompletionReceipt(db, {
      target: 'target', origin: 'origin', turnNumber: 7, projectPath: '/repo',
      receiptOptions: { storePath },
    });
    assert.equal(first.sequence, 1);
    assert.deepEqual(second, first, 'Stop retry must return the original receipt');
    assert.equal(first.completed_at, 1234);
    if (process.platform !== 'win32') {
      // POSIX permission 契約 (0700/0600) の表現形式検査。Windows の秘匿は stat mode
      // ではなく owner-only ACL で担保され、writeCompletedTurnReceipt 内部の
      // applyAndVerifyWindowsAcl が書き込みのたびに apply + verify して失敗を throw
      // するため、win32 ではこのテストが receipt を作れた時点で ACL 検証済み。
      assert.equal(statSync(join(root, 'state')).mode & 0o777, 0o700);
      assert.equal(statSync(storePath).mode & 0o777, 0o600);
    }
    const bytes = readFileSync(storePath, 'utf8');
    assert.doesNotMatch(bytes, /request|answer|\/repo/);
    assert.match(bytes, /"host":"claude"/);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('publishCapturedClaudeCompletionReceipt: incomplete DB pairはreceiptを作らず失敗する', () => {
  const db = makeDb();
  const root = mkdtempSync(join(tmpdir(), 'throughline-turn-receipt-'));
  const storePath = join(root, 'state', 'completed-turn-receipts.json');
  try {
    db.prepare(
      `INSERT INTO bodies (session_id, origin_session_id, turn_number, role, text, token_count, created_at)
       VALUES ('target', 'origin', 8, 'user', 'only user', 1, 1)`,
    ).run();
    assert.throws(
      () => publishCapturedClaudeCompletionReceipt(db, {
        target: 'target', origin: 'origin', turnNumber: 8, projectPath: '/repo',
        receiptOptions: { storePath },
      }),
      /completed pair was not captured/,
    );
    assert.throws(() => statSync(storePath), { code: 'ENOENT' });
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('countDistinctBodyTurns: 2 ロール行 = 1 ターンとして数える', () => {
  const db = makeDb();
  insertTurn(db, { session: 'S', origin: 'S', turn: 1, createdAt: 100 });
  insertTurn(db, { session: 'S', origin: 'S', turn: 2, createdAt: 200 });
  assert.equal(countDistinctBodyTurns(db, 'S'), 2);
});

test('countDistinctBodyTurns: merge 跨ぎで origin が違うターンも別勘定', () => {
  const db = makeDb();
  // 前任 (origin=P) 15 ターン + 合流先 (origin=S) 10 ターン = 25
  for (let i = 1; i <= 15; i++) {
    insertTurn(db, { session: 'S', origin: 'P', turn: i, createdAt: i * 100 });
  }
  for (let i = 1; i <= 10; i++) {
    insertTurn(db, { session: 'S', origin: 'S', turn: i, createdAt: 10000 + i * 100 });
  }
  assert.equal(countDistinctBodyTurns(db, 'S'), 25);
});

test('pickOldestUnsummarizedTurn: 全ターンが未要約なら created_at 最小を返す', () => {
  const db = makeDb();
  insertTurn(db, { session: 'S', origin: 'S', turn: 2, createdAt: 200 });
  insertTurn(db, { session: 'S', origin: 'S', turn: 1, createdAt: 100 });
  insertTurn(db, { session: 'S', origin: 'S', turn: 3, createdAt: 300 });
  const oldest = pickOldestUnsummarizedTurn(db, 'S');
  assert.equal(oldest?.turn_number, 1);
  assert.equal(oldest?.origin_session_id, 'S');
  assert.equal(oldest?.created_at, 100);
});

test('pickOldestUnsummarizedTurn: 既に要約済みのターンはスキップ', () => {
  const db = makeDb();
  insertTurn(db, { session: 'S', origin: 'S', turn: 1, createdAt: 100 });
  insertTurn(db, { session: 'S', origin: 'S', turn: 2, createdAt: 200 });
  insertTurn(db, { session: 'S', origin: 'S', turn: 3, createdAt: 300 });
  insertSkeleton(db, { session: 'S', origin: 'S', turn: 1, createdAt: 100 });
  insertSkeleton(db, { session: 'S', origin: 'S', turn: 2, createdAt: 200 });
  const oldest = pickOldestUnsummarizedTurn(db, 'S');
  assert.equal(oldest?.turn_number, 3);
});

test('pickOldestUnsummarizedTurn: 全部要約済みなら null', () => {
  const db = makeDb();
  insertTurn(db, { session: 'S', origin: 'S', turn: 1, createdAt: 100 });
  insertSkeleton(db, { session: 'S', origin: 'S', turn: 1, createdAt: 100 });
  assert.equal(pickOldestUnsummarizedTurn(db, 'S'), null);
});

test('pickOldestUnsummarizedTurn: merge 跨ぎで前任の最古ターンを優先', () => {
  const db = makeDb();
  // 前任 (origin=P) 15 ターン + 合流先 (origin=S) 10 ターン
  for (let i = 1; i <= 15; i++) {
    insertTurn(db, { session: 'S', origin: 'P', turn: i, createdAt: i * 100 });
  }
  for (let i = 1; i <= 10; i++) {
    insertTurn(db, { session: 'S', origin: 'S', turn: i, createdAt: 10000 + i * 100 });
  }
  const oldest = pickOldestUnsummarizedTurn(db, 'S');
  assert.equal(oldest?.origin_session_id, 'P');
  assert.equal(oldest?.turn_number, 1);
  assert.equal(oldest?.created_at, 100);
});

test('pickOldestUnsummarizedTurn: 同じ turn_number でも origin が違えば別扱い', () => {
  const db = makeDb();
  // 前任 turn 1 (未要約) と 合流先 turn 1 (要約済) が共存
  insertTurn(db, { session: 'S', origin: 'P', turn: 1, createdAt: 100 });
  insertTurn(db, { session: 'S', origin: 'S', turn: 1, createdAt: 500 });
  insertSkeleton(db, { session: 'S', origin: 'S', turn: 1, createdAt: 500 });
  const oldest = pickOldestUnsummarizedTurn(db, 'S');
  assert.equal(oldest?.origin_session_id, 'P');
  assert.equal(oldest?.turn_number, 1);
});

test('逐次要約シナリオ: 20 ターンまでは要約発火しない、21 ターン目で発火', () => {
  const db = makeDb();
  // 20 ターン投入
  for (let i = 1; i <= 20; i++) {
    insertTurn(db, { session: 'S', origin: 'S', turn: i, createdAt: i * 100 });
  }
  // 20 ターン時点: window を超えていないので要約しない
  assert.equal(countDistinctBodyTurns(db, 'S') > L2_WINDOW, false);

  // 21 ターン目投入
  insertTurn(db, { session: 'S', origin: 'S', turn: 21, createdAt: 2100 });
  assert.equal(countDistinctBodyTurns(db, 'S') > L2_WINDOW, true);

  // 最古 = turn 1 が要約対象として選ばれる
  const target1 = pickOldestUnsummarizedTurn(db, 'S');
  assert.equal(target1?.turn_number, 1);

  // turn 1 を要約済にして次のターンを模擬
  insertSkeleton(db, { session: 'S', origin: 'S', turn: 1, createdAt: 100 });
  insertTurn(db, { session: 'S', origin: 'S', turn: 22, createdAt: 2200 });

  // 次は turn 2 が選ばれる
  const target2 = pickOldestUnsummarizedTurn(db, 'S');
  assert.equal(target2?.turn_number, 2);
});
