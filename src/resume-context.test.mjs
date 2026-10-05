import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  buildResumeContext,
  buildBudgetedResumeContext,
  buildAutoContinuationContext,
  buildRecentSessionsContext,
  INJECTION_BUDGET_CHARS,
} from './resume-context.mjs';

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

function insertSkeleton(db, row) {
  db.prepare(
    `INSERT INTO skeletons (session_id, origin_session_id, turn_number, role, summary, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(row.session, row.origin, row.turn, row.role, row.summary, row.createdAt);
}

function insertBody(db, row) {
  db.prepare(
    `INSERT INTO bodies (session_id, origin_session_id, turn_number, role, text, token_count, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(row.session, row.origin, row.turn, row.role, row.text, 1, row.createdAt);
}

function insertDetail(db, row) {
  db.prepare(
    `INSERT INTO details
       (session_id, origin_session_id, turn_number, tool_name, input_text, output_text,
        token_count, created_at, kind, source_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.session,
    row.origin,
    row.turn,
    row.toolName ?? row.kind,
    row.input ?? null,
    row.output ?? null,
    row.tokenCount ?? 1,
    row.createdAt,
    row.kind,
    row.sourceId ?? null,
  );
}

test('buildResumeContext: header is terse and announces the Bash invocation contract', () => {
  const db = makeDb();
  insertBody(db, {
    session: 'new',
    origin: 'old',
    turn: 1,
    role: 'user',
    text: 'hi',
    createdAt: 1000,
  });

  const text = buildResumeContext(db, {
    sessionId: 'new',
    isInheritance: true,
  });

  assert.ok(text);
  // A 経路: 「直前スレッドの継続応答用コンテキスト」 framing (元の「中断した作業の再開」よりも
  // 強い directive。モデルが /clear 後の短い prompt を新規依頼として扱うのを抑止する目的)
  assert.match(text, /^## Throughline: 直前スレッドの継続応答用コンテキスト/);

  // 旧版の冗長な行は全部削除
  assert.ok(!text.includes('と報告してください'), 'meta-report instruction must be gone');
  assert.ok(!text.includes('一番下の'), 'redundant ordering hint must be gone');
  assert.ok(!text.includes('内訳の読み方'), 'glossary block must be gone');
  assert.ok(!text.includes('現在進行中の作業の active work context'), 'verbose framing must be gone');

  // A 経路の必須シグナル: 「あなた自身が直前にユーザーと交わした会話」 + 「新規依頼ではなく続き」
  // + 短い指示の扱い + 「新規会話ではない」明示
  assert.match(text, /あなた自身が直前にユーザーと交わした会話/);
  assert.match(text, /新規依頼ではなく、上記スレッドの \*\*続き\*\*/);
  assert.match(text, /続きよろしく.*OK.*次は？/s);
  assert.match(text, /新規会話ではない/);
  // 通常のThroughline引き継ぎは最初の一度だけ可視化し、後続応答では反復させない。
  assert.match(text, /この引き継ぎ直後の最初の応答だけ/);
  assert.match(text, /Throughline で前のセッションから .* ターン分の記憶を引き継いだ状態で続けます/);
  assert.match(text, /2 回目以降の応答では、この宣言を繰り返さない/);
  assert.match(
    text,
    /\*\*各ターンの詳細\*\*: \*\*`Bash` ツールで `throughline detail HH:MM:SS` を実行\*\* \(該当ターンの本文＋詳細を stdout に返します\)/,
  );

  // v2.1: 古い番号リスト (1/2/3) を最新ユーザーが「2 をやれ」のように参照しても、
  // 直前アシスタントで既に実行済みなら再実行ではなく結果確認に回るというガード。
  // (このセッションで実際にハマった misread の再発防止)
  assert.match(text, /古い番号リストの再実行禁止/);
  assert.match(text, /既に直前アシスタントターンで実装\/実行済み/);
  assert.match(text, /最新アシスタント発話の指示が、過去ターンのリストへの参照より上位/);
});

test('buildResumeContext: silent disclosure keeps inheritance internal', () => {
  const db = makeDb();
  insertBody(db, {
    session: 'new',
    origin: 'old',
    turn: 1,
    role: 'assistant',
    text: '続きの本文',
    createdAt: 1000,
  });

  const text = buildResumeContext(db, {
    sessionId: 'new',
    isInheritance: true,
    handoffDisclosure: 'silent',
  });

  assert.ok(text);
  assert.doesNotMatch(text, /この引き継ぎ直後の最初の応答だけ/);
  assert.doesNotMatch(text, /Throughline で前のセッションから .* ターン分の記憶を引き継いだ状態で続けます/);
  assert.match(text, /\[assistant\]: 続きの本文/);
});

test('buildResumeContext: legacy disclosure is removed only from assistant memory', () => {
  const db = makeDb();
  const disclosure = '「Throughline で前のセッションから 20 ターン分の記憶を引き継いだ状態で続けます」';
  insertBody(db, {
    session: 'new',
    origin: 'old',
    turn: 1,
    role: 'user',
    text: `この表示は何？ ${disclosure}`,
    createdAt: 1000,
  });
  insertBody(db, {
    session: 'new',
    origin: 'old',
    turn: 1,
    role: 'assistant',
    text: `${disclosure}\n\n本題の応答です。`,
    createdAt: 1001,
  });

  const text = buildResumeContext(db, {
    sessionId: 'new',
    isInheritance: true,
  });

  assert.ok(text);
  assert.equal(text.split(disclosure).length - 1, 2, 'user quote remains in anchor and L2 only');
  assert.doesNotMatch(text, /\[assistant\]: 「Throughline で前のセッションから/);
  assert.match(text, /\[assistant\]: 本題の応答です。/);
  assert.match(text, /\*\*直前のアシスタント\*\* \[\d\d:\d\d:\d\d\]: 本題の応答です。/);
});

test('buildResumeContext: 現在地 anchor surfaces the latest user/assistant exchange above L1/L2', () => {
  const db = makeDb();
  // 25 turns to exercise an L2 window edge and ensure the anchor picks the newest.
  for (let t = 1; t <= 25; t += 1) {
    insertBody(db, {
      session: 'new',
      origin: 'old',
      turn: t,
      role: 'user',
      text: `user turn ${t}`,
      createdAt: 1000 + t * 10,
    });
    insertBody(db, {
      session: 'new',
      origin: 'old',
      turn: t,
      role: 'assistant',
      text: `assistant turn ${t}`,
      createdAt: 1000 + t * 10 + 1,
    });
  }

  const text = buildResumeContext(db, {
    sessionId: 'new',
    isInheritance: true,
  });

  assert.ok(text);

  const anchorIdx = text.indexOf('### 現在地 (直前のやりとり)');
  const l2Idx = text.indexOf('### 直前の対話 (L2 / active work thread, 古い順)');
  assert.ok(anchorIdx > 0, '現在地 anchor section should be present');
  assert.ok(l2Idx > anchorIdx, '現在地 anchor must appear before the L2 section');

  // The anchor must point to turn 25 (the latest), not any earlier turn.
  assert.match(text, /\*\*最新ユーザー指示\*\* \[\d\d:\d\d:\d\d\]: user turn 25$/m);
  assert.match(text, /\*\*直前のアシスタント\*\* \[\d\d:\d\d:\d\d\]: assistant turn 25$/m);
});

test('buildResumeContext: 現在地 anchor truncates long bodies but full body still appears in L2', () => {
  const db = makeDb();
  const longText = 'a'.repeat(1200);
  insertBody(db, {
    session: 'new',
    origin: 'old',
    turn: 1,
    role: 'assistant',
    text: longText,
    createdAt: 1000,
  });

  const text = buildResumeContext(db, {
    sessionId: 'new',
    isInheritance: true,
  });

  assert.ok(text);

  const anchorLine = text
    .split('\n')
    .find((l) => l.startsWith('**直前のアシスタント**'));
  assert.ok(anchorLine, '直前のアシスタント anchor line should be present');
  // Anchor must be truncated with ellipsis (originally 1200 chars > 600 cap).
  assert.ok(anchorLine.endsWith(' …'), 'long anchor body must end with the ellipsis marker');
  assert.ok(
    anchorLine.length < longText.length,
    'anchor line should be shorter than the original body',
  );

  // Full body must still appear in the L2 section below.
  assert.match(text, new RegExp(`\\[assistant\\]: ${longText}`));
});

test('buildResumeContext: 現在地 anchor is omitted for non-inheritance sessions', () => {
  const db = makeDb();
  insertBody(db, {
    session: 'new',
    origin: 'old',
    turn: 1,
    role: 'assistant',
    text: 'a body',
    createdAt: 1000,
  });

  const text = buildResumeContext(db, {
    sessionId: 'new',
    isInheritance: false,
  });

  assert.ok(text);
  assert.ok(
    !text.includes('現在地'),
    'normal sessions (isInheritance=false) must not include the 現在地 anchor',
  );
  assert.ok(
    !text.includes('最新ユーザー指示'),
    'normal sessions must not surface a latest-user pointer',
  );
});

test('buildResumeContext: 現在地 anchor handles a single-role recent window', () => {
  const db = makeDb();
  // Only user rows (no assistant) — anchor should still render with just the user line.
  insertBody(db, {
    session: 'new',
    origin: 'old',
    turn: 1,
    role: 'user',
    text: 'lone user message',
    createdAt: 1000,
  });

  const text = buildResumeContext(db, {
    sessionId: 'new',
    isInheritance: true,
  });

  assert.ok(text);
  assert.ok(text.includes('### 現在地 (直前のやりとり)'));
  assert.match(text, /\*\*最新ユーザー指示\*\* \[\d\d:\d\d:\d\d\]: lone user message/);
  assert.ok(
    !text.includes('**直前のアシスタント**'),
    'no assistant body present → no 直前のアシスタント line',
  );
});

test('buildResumeContext: L2 is the very last section (anchored at bottom for attention)', () => {
  const db = makeDb();
  insertSkeleton(db, {
    session: 'new',
    origin: 'old',
    turn: 1,
    role: 'assistant',
    summary: 'older L1 summary',
    createdAt: 800,
  });
  insertBody(db, {
    session: 'new',
    origin: 'old',
    turn: 2,
    role: 'user',
    text: 'recent user body',
    createdAt: 2000,
  });
  insertBody(db, {
    session: 'new',
    origin: 'old',
    turn: 2,
    role: 'assistant',
    text: 'recent assistant body — this should be the last line',
    createdAt: 2100,
  });

  const text = buildResumeContext(db, {
    sessionId: 'new',
    isInheritance: true,
  });

  assert.ok(text);

  assert.ok(!text.includes('**再開指示:**'), 'continuation reminder should be removed');
  assert.ok(!text.includes('### L3 詳細参照'), 'standalone L3 section should be removed');

  const lines = text.split('\n').filter((l) => l.length > 0);
  assert.match(
    lines[lines.length - 1],
    /\[assistant\]: recent assistant body — this should be the last line/,
  );

  const l1Idx = text.indexOf('### それ以前の要約 (L1)');
  const l2Idx = text.indexOf('### 直前の対話 (L2 / active work thread, 古い順)');
  assert.ok(l1Idx > 0, 'L1 section should be present');
  assert.ok(l2Idx > l1Idx, 'L2 section should follow L1');
});

test('buildResumeContext: L2 entries get inline (詳細：…) suffixes with tool-name-aware labels', () => {
  const db = makeDb();
  insertBody(db, {
    session: 'new',
    origin: 'old',
    turn: 5,
    role: 'assistant',
    text: 'turn with tools',
    createdAt: 5000,
  });
  insertDetail(db, {
    session: 'new',
    origin: 'old',
    turn: 5,
    kind: 'thinking',
    toolName: 'thinking',
    output: 'thinking text',
    createdAt: 5010,
  });
  insertDetail(db, {
    session: 'new',
    origin: 'old',
    turn: 5,
    kind: 'tool_input',
    toolName: 'Bash',
    input: 'ls',
    createdAt: 5020,
  });
  insertDetail(db, {
    session: 'new',
    origin: 'old',
    turn: 5,
    kind: 'tool_input',
    toolName: 'Bash',
    input: 'pwd',
    createdAt: 5030,
  });
  insertDetail(db, {
    session: 'new',
    origin: 'old',
    turn: 5,
    kind: 'tool_output',
    toolName: 'Bash',
    output: 'home',
    createdAt: 5040,
  });
  insertDetail(db, {
    session: 'new',
    origin: 'old',
    turn: 5,
    kind: 'system',
    toolName: 'UserPromptSubmit',
    output: 'hook ran',
    createdAt: 5050,
  });
  // MCP tool: 末尾の関数名だけにすべき
  insertDetail(db, {
    session: 'new',
    origin: 'old',
    turn: 5,
    kind: 'tool_input',
    toolName: 'mcp__plugin_everything-claude-code_playwright__browser_navigate',
    input: '{"url":"http://example.com"}',
    createdAt: 5060,
  });
  insertBody(db, {
    session: 'new',
    origin: 'old',
    turn: 6,
    role: 'user',
    text: 'plain user message',
    createdAt: 6000,
  });

  const text = buildResumeContext(db, {
    sessionId: 'new',
    isInheritance: true,
  });

  assert.ok(text);

  // Look for the L2 body line specifically (not the 現在地 anchor line which also
  // contains the latest assistant body).
  const turnWithToolsLine = text
    .split('\n')
    .find((l) => /^\[\d\d:\d\d:\d\d\] \[assistant\]: turn with tools/.test(l));
  assert.ok(turnWithToolsLine, 'L2 line for turn 5 should exist');
  // - tool_input + tool_output は tool 名で集約 (Bash ×2)
  // - hook 出力 (system) は suffix から除外
  // - MCP ツール名は末尾の関数名 (browser_navigate) だけ
  assert.match(
    turnWithToolsLine,
    /\(詳細：思考, Bash ×2, browser_navigate\)$/,
  );
  assert.ok(
    !turnWithToolsLine.includes('hook 出力'),
    'hook 出力 (system) must be excluded from the suffix',
  );
  assert.ok(
    !turnWithToolsLine.includes('mcp__'),
    'MCP full path must be shortened to function name only',
  );

  // 旧版にあった `[→ throughline detail HH:MM:SS]` のリンク表記は per-line には出さない
  assert.ok(
    !turnWithToolsLine.includes('throughline detail'),
    'per-line should not repeat the throughline detail command (the header announces it)',
  );

  const plainLine = text
    .split('\n')
    .find((l) => /^\[\d\d:\d\d:\d\d\] \[user\]: plain user message/.test(l));
  assert.ok(plainLine, 'L2 line for turn 6 should exist');
  assert.ok(
    !plainLine.includes('詳細：'),
    'L2 turns without L3 should not carry a (詳細：…) suffix',
  );

  // 旧版にあった独立 `### Detail References` セクションも出ない
  assert.ok(!text.includes('### L3 詳細参照'));
});

test('buildResumeContext: (詳細：…) suffix appears only on the last role row of each turn (no duplication)', () => {
  const db = makeDb();
  // Turn 5: both user and assistant rows. L3 attached at turn level.
  insertBody(db, {
    session: 'new',
    origin: 'old',
    turn: 5,
    role: 'user',
    text: 'user side of turn 5',
    createdAt: 5000,
  });
  insertBody(db, {
    session: 'new',
    origin: 'old',
    turn: 5,
    role: 'assistant',
    text: 'assistant side of turn 5',
    createdAt: 5100,
  });
  insertDetail(db, {
    session: 'new',
    origin: 'old',
    turn: 5,
    kind: 'thinking',
    toolName: 'thinking',
    output: 'thinking',
    createdAt: 5050,
  });
  insertDetail(db, {
    session: 'new',
    origin: 'old',
    turn: 5,
    kind: 'tool_input',
    toolName: 'Bash',
    input: 'ls',
    createdAt: 5060,
  });

  // Turn 6: only user row (e.g. compact session ending on user). suffix should
  // attach to the user row since it's the last role of the turn.
  insertBody(db, {
    session: 'new',
    origin: 'old',
    turn: 6,
    role: 'user',
    text: 'lone user turn',
    createdAt: 6000,
  });
  insertDetail(db, {
    session: 'new',
    origin: 'old',
    turn: 6,
    kind: 'image',
    toolName: 'image',
    output: '[img]',
    createdAt: 6010,
  });

  const text = buildResumeContext(db, {
    sessionId: 'new',
    isInheritance: true,
  });

  assert.ok(text);

  // Match L2 body lines specifically (`[HH:MM:SS] [role]: ...`) to avoid colliding
  // with the 現在地 anchor lines (`**最新ユーザー指示** [HH:MM:SS]: ...`).
  const lines = text.split('\n');
  const userTurn5 = lines.find((l) => /^\[\d\d:\d\d:\d\d\] \[user\]: user side of turn 5/.test(l));
  const assistantTurn5 = lines.find(
    (l) => /^\[\d\d:\d\d:\d\d\] \[assistant\]: assistant side of turn 5/.test(l),
  );
  const userTurn6 = lines.find((l) => /^\[\d\d:\d\d:\d\d\] \[user\]: lone user turn/.test(l));

  assert.ok(userTurn5 && assistantTurn5 && userTurn6);
  // Turn 5: only assistant (last role of the turn) gets the suffix
  assert.ok(!userTurn5.includes('詳細：'), 'user row should not duplicate the turn suffix');
  assert.match(assistantTurn5, /\(詳細：思考, Bash\)$/);
  // Turn 6: user is the only role, so it gets the suffix
  assert.match(userTurn6, /\(詳細：画像\)$/);
});

test('buildResumeContext: L1 entries display the body time at the start and prepend "本文" to the suffix', () => {
  const db = makeDb();
  // L1 summary was created at turn-processor run time (8000), but the original
  // body was written at 1500. The line prefix [HH:MM:SS] must be the body time
  // so `Bash で throughline detail HH:MM:SS` resolves correctly.
  insertSkeleton(db, {
    session: 'new',
    origin: 'old',
    turn: 1,
    role: 'assistant',
    summary: 'old turn summary',
    createdAt: 8000,
  });
  insertBody(db, {
    session: 'new',
    origin: 'old',
    turn: 1,
    role: 'assistant',
    text: 'original body text from turn 1',
    createdAt: 1500,
  });
  // Push turn 1 out of L2 window
  for (let t = 2; t <= 25; t += 1) {
    insertBody(db, {
      session: 'new',
      origin: 'old',
      turn: t,
      role: 'user',
      text: `filler turn ${t}`,
      createdAt: 9000 + t,
    });
  }

  const text = buildResumeContext(db, {
    sessionId: 'new',
    isInheritance: true,
  });

  assert.ok(text);

  const l1Line = text.split('\n').find((l) => l.includes('old turn summary'));
  assert.ok(l1Line, 'L1 line should be present');

  // 行頭 [HH:MM:SS] が body 時刻を指している (skeleton 時刻ではない)
  const bodyTime = new Date(1500).toTimeString().slice(0, 8);
  const skeletonTime = new Date(8000).toTimeString().slice(0, 8);
  assert.ok(
    l1Line.startsWith(`[${bodyTime}] `),
    `L1 line should start with body time [${bodyTime}], got: ${l1Line}`,
  );
  assert.ok(
    !l1Line.startsWith(`[${skeletonTime}] `),
    'L1 line must not start with skeleton (summarization) time',
  );

  // (詳細：本文) suffix が付く (body が引けるという案内)
  assert.match(l1Line, /\(詳細：本文\)$/);
});

test('buildResumeContext: returns null when no memory rows or inflight memo exist', () => {
  const db = makeDb();
  assert.equal(
    buildResumeContext(db, { sessionId: 'empty', isInheritance: true }),
    null,
  );
});

test('buildResumeContext: excludeOriginId omits rows from the current origin', () => {
  const db = makeDb();

  insertBody(db, {
    session: 'new',
    origin: 'old',
    turn: 1,
    role: 'assistant',
    text: 'old origin body',
    createdAt: 1000,
  });
  insertBody(db, {
    session: 'new',
    origin: 'new',
    turn: 1,
    role: 'assistant',
    text: 'current origin body',
    createdAt: 2000,
  });

  const text = buildResumeContext(db, {
    sessionId: 'new',
    isInheritance: false,
    excludeOriginId: 'new',
  });

  assert.ok(text);
  assert.ok(text.includes('old origin body'));
  assert.ok(!text.includes('current origin body'));
});

test('buildResumeContext: ignores inflightMemo (kept only for signature compatibility)', () => {
  const db = makeDb();
  insertBody(db, {
    session: 'new',
    origin: 'old',
    turn: 1,
    role: 'user',
    text: 'hi',
    createdAt: 1000,
  });

  const text = buildResumeContext(db, {
    sessionId: 'new',
    isInheritance: true,
    inflightMemo: '**Next**: keep going (should NOT appear)',
  });

  assert.ok(text);
  assert.ok(!text.includes('**Next**: keep going'));
});

// ---- buildBudgetedResumeContext (ADR 0014: hook stdout の 10k file 化対策) ----

test('INJECTION_BUDGET_CHARS stays under the measured 10k persisted-output limit', () => {
  assert.ok(INJECTION_BUDGET_CHARS <= 9_501, '実測 inline 通過上限 9,501 字以下であること');
});

test('budgeted: under budget keeps all L2 turns, no L1 section, guidance always present', () => {
  const db = makeDb();
  insertBody(db, { session: 'new', origin: 'old', turn: 1, role: 'user', text: 'short question', createdAt: 1000 });
  insertBody(db, { session: 'new', origin: 'old', turn: 1, role: 'assistant', text: 'short answer', createdAt: 1100 });

  const budgeted = buildBudgetedResumeContext(db, { sessionId: 'new', isInheritance: true });

  assert.ok(budgeted);
  assert.equal(budgeted.injectedL2Turns, 1);
  assert.equal(budgeted.remainingL2Turns, 0);
  assert.equal(budgeted.olderTurns, 0);
  assert.equal(budgeted.truncatedNewestL2, false);
  assert.ok(budgeted.totalChars <= INJECTION_BUDGET_CHARS);
  // 案内セクションは無条件表示 (データ無し側も「なし」と明示)
  assert.ok(budgeted.text.includes('### さらに前の記憶（必要な時だけ取得）'));
  assert.match(budgeted.text, /これより前の続き: なし/);
  assert.match(budgeted.text, /それ以前のターン: なし/);
  // L1 セクションは注入しない
  assert.ok(!budgeted.text.includes('### それ以前の要約 (L1)'));
});

test('budgeted: packs whole turns newest-first, bakes --before/--last/--session into guidance', () => {
  const db = makeDb();
  // 各 ~800 字 × 10 ターン = 本文だけで ~8,000 字 → maxChars 5000 で古いターンが落ちる
  for (let turn = 1; turn <= 10; turn += 1) {
    insertBody(db, {
      session: 'new',
      origin: 'old',
      turn,
      role: 'user',
      text: `q-${String(turn).padStart(2, '0')} question`,
      createdAt: 1000 + turn * 100,
    });
    insertBody(db, {
      session: 'new',
      origin: 'old',
      turn,
      role: 'assistant',
      text: `turn-${String(turn).padStart(2, '0')} ` + 'x'.repeat(800),
      createdAt: 1050 + turn * 100,
    });
  }

  const budgeted = buildBudgetedResumeContext(db, {
    sessionId: 'new',
    isInheritance: true,
    maxChars: 5000,
  });

  assert.ok(budgeted);
  assert.ok(budgeted.totalChars <= 5000, `totalChars ${budgeted.totalChars} must fit budget`);
  assert.ok(budgeted.injectedL2Turns > 0, 'newest turns must be injected');
  assert.ok(budgeted.remainingL2Turns > 0, 'some old turns must be left for pull');
  assert.equal(budgeted.injectedL2Turns + budgeted.remainingL2Turns, 10);
  assert.ok(budgeted.text.includes('turn-10'), 'newest L2 turn must survive');
  assert.ok(!budgeted.text.includes('turn-01 '), 'oldest L2 turn must be left for pull');

  // ターン原子性: 注入されたターンは user 行と assistant 行が揃っている
  const oldestInjectedTurn = 10 - budgeted.injectedL2Turns + 1;
  const tag = String(oldestInjectedTurn).padStart(2, '0');
  assert.ok(budgeted.text.includes(`q-${tag} question`), 'user row of injected turn must be present');
  assert.ok(budgeted.text.includes(`turn-${tag} `), 'assistant row of injected turn must be present');

  // 案内: --before は実注入最古ターンの min(created_at) の ISO ms、--last は残り件数
  const boundaryMs = 1000 + oldestInjectedTurn * 100; // 最古注入ターンの user 行時刻
  const iso = new Date(boundaryMs).toISOString().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  assert.match(
    budgeted.text,
    new RegExp(
      `これより前の続き${budgeted.remainingL2Turns}ターン .*` +
        '`throughline recall --l2 --session new ' +
        `--before ${iso} --last ${budgeted.remainingL2Turns}\``,
    ),
    'guidance must bake session, ISO ms boundary, and remaining count',
  );
  // 全 10 ターンとも窓内なので、窓より古い側は正直に「なし」と明示される
  assert.match(budgeted.text, /それ以前のターン: なし/);
});

test('budgeted: --l1 guidance bakes the same boundary and the --l2 skip count', () => {
  const db = makeDb();
  // 窓 (20) + 窓外 5 ターン。予算を絞って窓内にも pull 残りを作る
  for (let turn = 1; turn <= 25; turn += 1) {
    insertBody(db, {
      session: 'new',
      origin: 'old',
      turn,
      role: 'assistant',
      text: `turn-${String(turn).padStart(2, '0')} ` + 'x'.repeat(700),
      createdAt: 1000 + turn * 100,
    });
  }

  const budgeted = buildBudgetedResumeContext(db, {
    sessionId: 'new',
    isInheritance: true,
    maxChars: 4000,
  });

  assert.ok(budgeted);
  assert.ok(budgeted.remainingL2Turns > 0);
  assert.equal(budgeted.olderTurns, 5);
  const oldestInjectedTurn = 25 - budgeted.injectedL2Turns + 1;
  const boundaryMs = 1000 + oldestInjectedTurn * 100;
  const iso = new Date(boundaryMs).toISOString().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  assert.match(
    budgeted.text,
    new RegExp(`--l2 --session new --before ${iso} --last ${budgeted.remainingL2Turns}`),
  );
  assert.match(
    budgeted.text,
    new RegExp(`--l1 --session new --before ${iso} --skip ${budgeted.remainingL2Turns}`),
    '--l1 guidance must bake the same boundary and skip count',
  );
});

test('budgeted: window turns beyond budget never fall into a blank band (guidance covers them)', () => {
  const db = makeDb();
  // 40 ターン: 窓は最新 20 ターン、そこからさらに予算落ちが出る構成
  for (let turn = 1; turn <= 40; turn += 1) {
    insertBody(db, {
      session: 'new',
      origin: 'old',
      turn,
      role: 'assistant',
      text: `turn-${String(turn).padStart(2, '0')} ` + 'x'.repeat(700),
      createdAt: 1000 + turn * 1000,
    });
  }

  const budgeted = buildBudgetedResumeContext(db, {
    sessionId: 'new',
    isInheritance: true,
    maxChars: 4000,
  });

  assert.ok(budgeted);
  assert.ok(budgeted.totalChars <= 4000);
  // 窓 20 ターンのうち注入できなかった分は全部 recall --l2 の担当として案内される
  assert.equal(budgeted.injectedL2Turns + budgeted.remainingL2Turns, 20);
  // 窓より古い 20 ターンは --l1 側 (未要約でも件数として見える)
  assert.equal(budgeted.olderTurns, 20);
  assert.match(budgeted.text, /それ以前の全20ターン（要約済み 0 \/ 未要約 20）/);
});

test('budgeted: older summarized/unsummarized counts are honest in the guidance', () => {
  const db = makeDb();
  for (let turn = 1; turn <= 25; turn += 1) {
    insertBody(db, {
      session: 'new',
      origin: 'old',
      turn,
      role: 'assistant',
      text: `turn-${turn}`,
      createdAt: 1000 + turn * 1000,
    });
  }
  // 窓 (最新 20 ターン = turn 6..25) より古い turn 1..5 のうち 2 件だけ要約済み
  insertSkeleton(db, { session: 'new', origin: 'old', turn: 1, role: 'assistant', summary: 's1', createdAt: 90_000 });
  insertSkeleton(db, { session: 'new', origin: 'old', turn: 2, role: 'assistant', summary: 's2', createdAt: 90_001 });

  const budgeted = buildBudgetedResumeContext(db, { sessionId: 'new', isInheritance: true });

  assert.ok(budgeted);
  assert.equal(budgeted.olderTurns, 5);
  assert.equal(budgeted.olderSummarized, 2);
  assert.match(budgeted.text, /それ以前の全5ターン（要約済み 2 \/ 未要約 3）/);
});

test('budgeted: a single oversized newest L2 row is truncated with a detail pointer', () => {
  const db = makeDb();
  insertBody(db, {
    session: 'new',
    origin: 'old',
    turn: 1,
    role: 'assistant',
    text: 'HEAD-MARKER ' + 'y'.repeat(20_000),
    createdAt: 1000,
  });

  const budgeted = buildBudgetedResumeContext(db, {
    sessionId: 'new',
    isInheritance: true,
    maxChars: 4000,
  });

  assert.ok(budgeted);
  assert.ok(budgeted.totalChars <= 4000);
  assert.equal(budgeted.truncatedNewestL2, true);
  assert.ok(budgeted.text.includes('HEAD-MARKER'), 'the head of the newest row must survive');
  assert.match(budgeted.text, /全文: throughline detail /, 'truncation must point to detail command');
});

test('budgeted: header and anchor always survive even under pressure', () => {
  const db = makeDb();
  for (let turn = 1; turn <= 5; turn += 1) {
    insertBody(db, {
      session: 'new',
      origin: 'old',
      turn,
      role: 'assistant',
      text: 'z'.repeat(3000),
      createdAt: 1000 + turn,
    });
  }

  const budgeted = buildBudgetedResumeContext(db, {
    sessionId: 'new',
    isInheritance: true,
    maxChars: 4000,
  });

  assert.ok(budgeted);
  assert.match(budgeted.text, /^## Throughline: 直前スレッドの継続応答用コンテキスト/);
  assert.ok(budgeted.text.includes('### 現在地 (直前のやりとり)'));
});

// --- 自動継続で立てた新しい会話への注入 (ADR 0033) ---

test('buildAutoContinuationContext: 保存済みのターンが無くても、止めた時点の依頼だけで組み立てる', () => {
  const db = makeDb();
  const result = buildAutoContinuationContext(db, {
    sessionId: 'S',
    inFlight: { user: { content: '最初の依頼', timestamp: null }, last_fragment: null },
  });
  assert.match(result.text, /^## Throughline: 自動継続の文脈\n/);
  assert.match(result.text, /### 現在地 \(作業の途中で止めたターン\)\n\*\*作業中のユーザー依頼\*\*: 最初の依頼\n/);
  assert.doesNotMatch(result.text, /止める直前のあなたの発言/);
  assert.doesNotMatch(result.text, /### 直前の対話/);
  assert.equal(result.injectedL2Turns, 0);
  assert.equal(buildAutoContinuationContext(db, { sessionId: 'S', inFlight: null }), null);
});

test('buildAutoContinuationContext: 現在地は止めた時点のターンで、保存済みのターンはL2に並び、宣言は求めない', () => {
  const db = makeDb();
  insertBody(db, { session: 'S', origin: 'P', turn: 1, role: 'user', text: '前の依頼', createdAt: 1_000 });
  insertBody(db, { session: 'S', origin: 'P', turn: 1, role: 'assistant', text: '前の回答', createdAt: 2_000 });
  const result = buildAutoContinuationContext(db, {
    sessionId: 'S',
    inFlight: {
      user: { content: '今の依頼', timestamp: 3_000 },
      last_fragment: { content: '途中2', timestamp: 5_000 },
    },
  });
  const anchor = result.text.slice(result.text.indexOf('### 現在地'), result.text.indexOf('### さらに前の記憶'));
  assert.match(anchor, /\*\*作業中のユーザー依頼\*\* \[\d\d:\d\d:\d\d\]: 今の依頼\n\*\*止める直前のあなたの発言\*\* \[\d\d:\d\d:\d\d\]: 途中2\n/);
  assert.doesNotMatch(anchor, /前の依頼/);
  assert.match(result.text, /### 直前の対話 \(L2 \/ active work thread, 古い順\)\n\[\d\d:\d\d:\d\d\] \[user\]: 前の依頼\n\[\d\d:\d\d:\d\d\] \[assistant\]: 前の回答/);
  assert.doesNotMatch(result.text, /宣言|\/clear|圧縮の要約/);
  assert.match(result.text, /未実行なのは「実行されなかった道具」だけです/);
  assert.equal(result.injectedL2Turns, 1);
});

test('buildAutoContinuationContext: 長い依頼は先頭と末尾を残し、多数のターンでも予算内に収める', () => {
  const db = makeDb();
  for (let turn = 1; turn <= 12; turn++) {
    insertBody(db, { session: 'S', origin: 'P', turn, role: 'user', text: `依頼${turn} ` + 'あ'.repeat(600), createdAt: turn * 1_000 });
    insertBody(db, { session: 'S', origin: 'P', turn, role: 'assistant', text: `回答${turn} ` + 'い'.repeat(600), createdAt: turn * 1_000 + 500 });
  }
  const result = buildAutoContinuationContext(db, {
    sessionId: 'S',
    inFlight: {
      user: { content: '先頭の指示' + 'ヰ'.repeat(6_000) + '末尾の指示', timestamp: 20_000 },
      last_fragment: { content: 'ヱ'.repeat(3_000), timestamp: 21_000 },
    },
  });
  assert.ok(result.totalChars <= INJECTION_BUDGET_CHARS, `${result.totalChars}`);
  assert.match(result.text, /\*\*作業中のユーザー依頼\*\* \[\d\d:\d\d:\d\d\]: 先頭の指示ヰ+ …\(長いため中略 2510 字\)… ヰ+末尾の指示\n/);
  assert.equal((result.text.match(/ヰ/g) ?? []).length, 3_490);
  assert.equal((result.text.match(/ヱ/g) ?? []).length, 1_500);
  assert.match(result.text, /ヱ …\(長いため中略 1500 字\)… ヱ/);
  assert.ok(result.injectedL2Turns >= 1, '最新の保存済みターンは入る');
  assert.match(result.text, /回答12/);
  assert.equal(result.injectedL2Turns + result.remainingL2Turns, 12);
  assert.match(result.text, /throughline recall --l2 --session S /);
});

test('buildAutoContinuationContext: 止めたターンでここまでにしたことと、実行されなかった道具を現在地に載せ、そのターンをL2に重ねない', () => {
  const db = makeDb();
  insertBody(db, { session: 'S', origin: 'P0', turn: 1, role: 'user', text: '前の依頼', createdAt: 1_000 });
  insertBody(db, { session: 'S', origin: 'P0', turn: 1, role: 'assistant', text: '前の回答', createdAt: 2_000 });
  // worker が取り込んだ止めたターン（発言を全部つないだ本文）
  insertBody(db, { session: 'S', origin: 'P', turn: 7, role: 'user', text: '今の依頼', createdAt: 3_000 });
  insertBody(db, { session: 'S', origin: 'P', turn: 7, role: 'assistant', text: 'a を直しました。\n\nb を読みます。', createdAt: 5_000 });
  const result = buildAutoContinuationContext(db, {
    sessionId: 'S',
    inFlight: {
      user: { content: '今の依頼', timestamp: 3_000 },
      last_fragment: { content: 'b を読みます。', timestamp: 5_000 },
      steps: [
        { kind: 'tool', name: 'Edit', target: '/work/a.mjs', failed: false },
        { kind: 'tool', name: 'Bash', target: 'npm test', failed: true },
        { kind: 'text', content: 'a を直しました。', timestamp: 4_000 },
        { kind: 'text', content: 'b を読みます。', timestamp: 5_000 },
      ],
      earlier_steps: null,
      stopped_tools: [{ name: 'Read', target: '/work/b.mjs' }, { name: 'Read', target: '/work/c.mjs' }],
      stopped_tools_total: 3,
      turn: { origin_session_id: 'P', turn_number: 7, user_at: 3_000, assistant_at: 5_000 },
    },
  });
  const anchor = result.text.slice(result.text.indexOf('### 現在地'), result.text.indexOf('### さらに前の記憶'));
  assert.match(anchor, new RegExp(
    '\\*\\*作業中のユーザー依頼\\*\\* \\[\\d\\d:\\d\\d:\\d\\d\\]: 今の依頼\\n' +
    '\\*\\*このターンでここまでにしたこと\\*\\*（古い順。どれも完了済み。道具の入出力の全文: `throughline detail \\d\\d:\\d\\d:\\d\\d`）:\\n' +
    '- 道具: Edit /work/a\\.mjs\\n- 道具: Bash npm test → 失敗\\n- 発言: a を直しました。\\n- 発言: b を読みます。\\n' +
    '\\*\\*止める直前に呼ぼうとして、実行されなかった道具\\*\\*: Read /work/b\\.mjs、Read /work/c\\.mjs（ほか 1 件）\\n'));
  assert.doesNotMatch(anchor, /止める直前のあなたの発言/, '一覧に同じ文が載っている発言は重ねない');
  const l2 = result.text.slice(result.text.indexOf('### 直前の対話'));
  assert.match(l2, /\[user\]: 前の依頼\n\[\d\d:\d\d:\d\d\] \[assistant\]: 前の回答/);
  assert.doesNotMatch(l2, /今の依頼|a を直しました/, '止めたターンは現在地だけに載せる');
  assert.equal(result.injectedL2Turns, 1);
  assert.equal(result.olderTurns, 0, '止めたターンを、窓の外の古いターンに数えない');
});

test('buildAutoContinuationContext: 改行のある直前の発言は全文を載せ、多い手順は新しい側から入るだけ載せて残りは件数にする', () => {
  const db = makeDb();
  const steps = [];
  for (let n = 1; n <= 80; n++) {
    steps.push({ kind: 'tool', name: 'Read', target: `/work/file-${String(n).padStart(3, '0')}-${'x'.repeat(40)}.mjs`, failed: false });
  }
  steps.push({ kind: 'text', content: '方針: 1. 型を直す 2. 試験を足す', timestamp: 9_000 });
  const result = buildAutoContinuationContext(db, {
    sessionId: 'S',
    inFlight: {
      user: { content: '大きな依頼', timestamp: 1_000 },
      last_fragment: { content: '方針:\n1. 型を直す\n2. 試験を足す', timestamp: 9_000 },
      steps,
      earlier_steps: { texts: 4, tools: { Read: 30, Edit: 6 } },
      stopped_tools: [{ name: 'Edit', target: '/work/types.mjs' }],
      stopped_tools_total: 1,
      turn: null,
    },
  });
  assert.ok(result.totalChars <= INJECTION_BUDGET_CHARS, `${result.totalChars}`);
  assert.match(result.text, /\*\*このターンでここまでにしたこと\*\*（古い順。どれも完了済み）:\n- （これより前に、発言 4 件・道具 (\d+) 回）\n- 道具: Read /);
  const omittedTools = Number(/これより前に、発言 4 件・道具 (\d+) 回/.exec(result.text)[1]);
  const shownTools = (result.text.match(/^- 道具: Read /gm) ?? []).length;
  assert.equal(omittedTools + shownTools, 36 + 80, '載せた分と件数にした分で全部');
  assert.ok(shownTools >= 20 && shownTools < 80, `${shownTools}`);
  assert.doesNotMatch(result.text, /- 発言: 方針/, '下に全文を載せる発言は、一覧に重ねない');
  assert.match(result.text, /- 道具: Read \/work\/file-080-x+\.mjs\n\*\*止める直前のあなたの発言\*\* \[\d\d:\d\d:\d\d\]: 方針:\n1\. 型を直す\n2\. 試験を足す\n\*\*止める直前に呼ぼうとして、実行されなかった道具\*\*: Edit \/work\/types\.mjs\n/);
});


// ---- 同じ project の過去の会話 (ADR 0034) ----

const RECENT_BASE = 1_700_000_000_000;
const RECENT_MINUTE = 60_000;

/** 1 ターン (user + assistant) を入れる。at は user 行の時刻で、assistant 行は 30 秒後。 */
function insertTurn(db, { session, origin = session, turn, user, assistant, at }) {
  insertBody(db, { session, origin, turn, role: 'user', text: user, createdAt: at });
  insertBody(db, { session, origin, turn, role: 'assistant', text: assistant, createdAt: at + 30_000 });
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function countOccurrences(text, needle) {
  return text.split(needle).length - 1;
}

test('recent: 過去の会話が無い時は buildBudgetedResumeContext と同じ文になる', () => {
  const db = makeDb();
  insertTurn(db, { session: 'only', turn: 1, user: 'ひとつだけの依頼', assistant: 'ひとつだけの回答', at: RECENT_BASE });

  const expected = buildBudgetedResumeContext(db, {
    sessionId: 'only',
    isInheritance: true,
    handoffDisclosure: 'silent',
  });
  // 本文の無い新しい session は飛ばし、現在の会話に選ばない
  const recent = buildRecentSessionsContext(db, {
    sessionIds: ['newer-empty', 'only', 'older-empty'],
    handoffDisclosure: 'silent',
  });

  assert.equal(recent.text, expected.text);
  assert.equal(recent.sessionId, 'only');
  assert.deepEqual(recent.sessions, [
    {
      sessionId: 'only',
      role: 'current',
      firstTurnAt: new Date(RECENT_BASE).toISOString(),
      lastTurnAt: new Date(RECENT_BASE + 30_000).toISOString(),
      turns: 1,
      includedTurns: 1,
    },
  ]);
  assert.equal(buildRecentSessionsContext(db, { sessionIds: ['newer-empty'] }), null);
});

test('recent: 短い最新の会話の後ろに、前の作業の会話が入る', () => {
  const db = makeDb();
  // 6 ターンの作業 → 1 ターンの連絡（最新）
  for (let turn = 1; turn <= 6; turn += 1) {
    insertTurn(db, {
      session: 'work',
      turn,
      user: `作業の依頼${turn}`,
      assistant: `作業の結果${turn}`,
      at: RECENT_BASE + turn * RECENT_MINUTE,
    });
  }
  insertDetail(db, {
    session: 'work', origin: 'work', turn: 6, kind: 'tool_input', toolName: 'Bash', createdAt: RECENT_BASE + 6 * RECENT_MINUTE + 1000,
  });
  insertTurn(db, { session: 'note', turn: 1, user: '短い連絡', assistant: '連絡への返事', at: RECENT_BASE + 60 * RECENT_MINUTE });

  const latestOnly = buildBudgetedResumeContext(db, {
    sessionId: 'note',
    isInheritance: true,
    handoffDisclosure: 'silent',
  });
  const recent = buildRecentSessionsContext(db, { sessionIds: ['note', 'work'], handoffDisclosure: 'silent' });

  // 現在の会話の部分は今と同じ文で、その後ろに過去の会話が続く
  assert.ok(recent.text.startsWith(`${latestOnly.text}\n\n## Throughline: このprojectで記録された過去の会話（新しい順）\n`));
  assert.ok(recent.text.length <= INJECTION_BUDGET_CHARS);
  assert.equal(recent.sessionId, 'note');
  // 「直前の会話」「短い返事は GO」の案内は現在の会話の1回だけ
  assert.equal(countOccurrences(recent.text, '短文/相槌の判定'), 1);
  assert.equal(countOccurrences(recent.text, '### 現在地 (直前のやりとり)'), 1);
  assert.match(recent.text, /次のユーザー入力は、ここへの返事ではありません/);

  const past = recent.text.slice(latestOnly.text.length);
  assert.match(past, /### 過去の会話 \d{4}-\d{2}-\d{2} \d{2}:\d{2}〜\d{2}:\d{2}（6ターン \/ session work）/);
  for (let turn = 1; turn <= 6; turn += 1) {
    assert.match(past, new RegExp(`\\[\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\] \\[user\\]: 作業の依頼${turn}\\n`));
  }
  // ターンは古い順に並び、道具の案内は今と同じくターンの最後の行に付く
  assert.ok(past.indexOf('作業の依頼1') < past.indexOf('作業の結果1'));
  assert.ok(past.indexOf('作業の結果1') < past.indexOf('作業の依頼2'));
  assert.match(past, /\[assistant\]: 作業の結果6 \(詳細：Bash\)/);
  // 全部入ったので、recall の案内と一覧は付かない
  assert.ok(!past.includes('throughline recall --l2 --session work'));
  assert.ok(!past.includes('### 本文を載せていない過去の会話'));

  assert.deepEqual(
    recent.sessions.map((s) => [s.sessionId, s.role, s.turns, s.includedTurns]),
    [['note', 'current', 1, 1], ['work', 'past', 6, 6]],
  );
  assert.equal(recent.sessions[1].firstTurnAt, new Date(RECENT_BASE + RECENT_MINUTE).toISOString());
  assert.equal(recent.sessions[1].lastTurnAt, new Date(RECENT_BASE + 6 * RECENT_MINUTE + 30_000).toISOString());
});

test('recent: 入らないターンから先は載せず、recall の案内と一覧にする', () => {
  const db = makeDb();
  insertTurn(db, { session: 'oldest', turn: 1, user: 'OLDEST_REQUEST', assistant: 'OLDEST_ANSWER', at: RECENT_BASE });
  insertTurn(db, { session: 'oldest', turn: 2, user: 'OLDEST_REQUEST_2', assistant: 'OLDEST_ANSWER_2', at: RECENT_BASE + RECENT_MINUTE });
  for (let turn = 1; turn <= 14; turn += 1) {
    insertTurn(db, {
      session: 'work',
      turn,
      user: `work-q-${String(turn).padStart(2, '0')}`,
      assistant: `work-a-${String(turn).padStart(2, '0')} ` + 'x'.repeat(600),
      at: RECENT_BASE + (10 + turn) * RECENT_MINUTE,
    });
  }
  insertTurn(db, { session: 'note', turn: 1, user: '短い連絡', assistant: '連絡への返事', at: RECENT_BASE + 60 * RECENT_MINUTE });

  const recent = buildRecentSessionsContext(db, {
    sessionIds: ['note', 'work', 'oldest'],
    handoffDisclosure: 'silent',
    maxChars: 6000,
  });

  assert.ok(recent.text.length <= 6000, `length ${recent.text.length} must fit budget`);
  const work = recent.sessions.find((s) => s.sessionId === 'work');
  assert.ok(work.includedTurns > 0 && work.includedTurns < 14, `includedTurns ${work.includedTurns}`);
  assert.equal(work.turns, 14);
  // 新しい側から続けて入り、ターンは user 行と assistant 行が揃う。それより古いターンは1行も入らない
  for (let turn = 1; turn <= 14; turn += 1) {
    const tag = String(turn).padStart(2, '0');
    const included = turn > 14 - work.includedTurns;
    assert.equal(recent.text.includes(`work-q-${tag}`), included, `user row of turn ${tag}`);
    assert.equal(recent.text.includes(`work-a-${tag} `), included, `assistant row of turn ${tag}`);
  }
  // 残りは recall で引ける。境界は載せた最古ターンの時刻、件数は 10 まで
  const rest = 14 - work.includedTurns;
  const oldestIncluded = 14 - work.includedTurns + 1;
  const boundary = new Date(RECENT_BASE + (10 + oldestIncluded) * RECENT_MINUTE).toISOString();
  assert.ok(recent.text.includes(`（14ターンのうち新しい${work.includedTurns}ターン / session work）`));
  assert.ok(
    recent.text.includes(
      `- これより前の${rest}ターン: ${rest > 10 ? '新しい10ターンの本文は ' : '本文は '}` +
        `\`throughline recall --l2 --session work --before ${boundary} --last ${Math.min(rest, 10)}\``,
    ),
    recent.text,
  );
  // 途中で止まった会話より古い会話は、本文を載せず一覧にする
  assert.ok(!recent.text.includes('OLDEST_REQUEST'));
  const afterLast = new Date(RECENT_BASE + RECENT_MINUTE + 30_000 + 1).toISOString();
  assert.match(
    recent.text,
    new RegExp(
      '### 本文を載せていない過去の会話\\n' +
        '- \\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}〜\\d{2}:\\d{2}（2ターン）: 本文は ' +
        escapeRegExp(`\`throughline recall --l2 --session oldest --before ${afterLast} --last 2\``) +
        '$',
    ),
  );
  assert.deepEqual(
    recent.sessions.map((s) => [s.sessionId, s.role, s.includedTurns]),
    [['note', 'current', 1], ['work', 'past', work.includedTurns], ['oldest', 'past', 0]],
  );
});

test('recent: 現在の会話に載せ残しがある時は、その文を変えず、余りに一覧だけ付ける', () => {
  const db = makeDb();
  // 一覧の1行が長くなる session id（余りに入る場合と入らない場合の両方を作る）
  const pastId = `past-${'p'.repeat(195)}`;
  insertTurn(db, { session: pastId, turn: 1, user: 'PAST_SHORT_REQUEST', assistant: 'PAST_SHORT_ANSWER', at: RECENT_BASE });
  for (let turn = 1; turn <= 10; turn += 1) {
    insertTurn(db, {
      session: 'long',
      turn,
      user: `long-q-${String(turn).padStart(2, '0')}`,
      assistant: `long-a-${String(turn).padStart(2, '0')} ` + 'x'.repeat(800),
      at: RECENT_BASE + (10 + turn) * RECENT_MINUTE,
    });
  }

  // 現在の会話の文は、過去の会話の有無でも予算でも変わらない
  const listed = new Set();
  for (const maxChars of [4600, 4800, 4900, 5000, 5200, 5400, 5600, 5700]) {
    const latestOnly = buildBudgetedResumeContext(db, {
      sessionId: 'long',
      isInheritance: true,
      handoffDisclosure: 'silent',
      maxChars,
    });
    const recent = buildRecentSessionsContext(db, {
      sessionIds: ['long', pastId],
      handoffDisclosure: 'silent',
      maxChars,
    });
    listed.add(recent.sessions.length === 2);

    assert.ok(latestOnly.remainingL2Turns > 0, 'the current session must have turns left for pull');
    assert.ok(recent.text.length <= maxChars, `length ${recent.text.length} must fit budget ${maxChars}`);
    assert.equal(recent.sessions[0].includedTurns, latestOnly.injectedL2Turns);
    // 新しいターンを飛ばして古い会話の本文を載せない
    assert.ok(!recent.text.includes('PAST_SHORT_REQUEST'));
    assert.ok(!recent.text.includes('### 過去の会話 '));
    if (recent.sessions.length === 1) {
      // 余りに一覧の1行も入らない時は、今と同じ文
      assert.equal(recent.text, latestOnly.text);
      continue;
    }
    assert.ok(recent.text.startsWith(`${latestOnly.text}\n\n## Throughline: このprojectで記録された過去の会話（新しい順）\n`));
    assert.ok(recent.text.includes('### 本文を載せていない過去の会話\n'));
    assert.ok(recent.text.includes(`（1ターン）: 本文は \`throughline recall --l2 --session ${pastId} --before `));
    assert.deepEqual(recent.sessions.map((s) => [s.sessionId, s.includedTurns]), [
      ['long', latestOnly.injectedL2Turns],
      [pastId, 0],
    ]);
  }
  assert.deepEqual([...listed].sort(), [false, true], '一覧が入る予算と入らない予算の両方を確かめる');
});

test('recent: 同じ origin と turn は新しい会話の1回だけ載せる', () => {
  const db = makeDb();
  // 後継の会話 (current) が、前任 (shared) のターンを引き継いで持っている
  insertTurn(db, { session: 'current', origin: 'shared', turn: 1, user: 'SHARED_REQUEST', assistant: 'SHARED_ANSWER', at: RECENT_BASE });
  insertTurn(db, { session: 'current', turn: 1, user: '最新の依頼', assistant: '最新の回答', at: RECENT_BASE + 30 * RECENT_MINUTE });
  // 同じターンの行が別の session にも残っている
  insertTurn(db, { session: 'copy', origin: 'shared', turn: 1, user: 'SHARED_REQUEST', assistant: 'SHARED_ANSWER', at: RECENT_BASE });
  insertTurn(db, { session: 'mixed', origin: 'shared', turn: 1, user: 'SHARED_REQUEST', assistant: 'SHARED_ANSWER', at: RECENT_BASE });
  insertTurn(db, { session: 'mixed', turn: 1, user: 'MIXED_OWN_REQUEST', assistant: 'MIXED_OWN_ANSWER', at: RECENT_BASE - 10 * RECENT_MINUTE });

  const recent = buildRecentSessionsContext(db, {
    sessionIds: ['current', 'copy', 'mixed'],
    handoffDisclosure: 'silent',
  });

  const past = recent.text.slice(recent.text.indexOf('## Throughline: このprojectで記録された過去の会話'));
  assert.ok(!past.includes('SHARED_REQUEST'));
  assert.ok(past.includes('MIXED_OWN_REQUEST'));
  assert.match(past, /（1ターン \/ session mixed）/);
  // 重なるターンしか持たない会話は、過去の会話に数えない
  assert.deepEqual(
    recent.sessions.map((s) => [s.sessionId, s.turns, s.includedTurns]),
    [['current', 2, 2], ['mixed', 1, 1]],
  );
});

test('recent: 一覧は5件までで、それより古い会話があることを書く', () => {
  const db = makeDb();
  insertTurn(db, { session: 'current', turn: 1, user: '最新の依頼', assistant: '最新の回答', at: RECENT_BASE + 100 * RECENT_MINUTE });
  const sessionIds = ['current'];
  for (let n = 1; n <= 7; n += 1) {
    // どの会話も最新のターンが予算に入らない
    insertTurn(db, {
      session: `big-${n}`,
      turn: 1,
      user: `BIG_REQUEST_${n}`,
      assistant: 'y'.repeat(INJECTION_BUDGET_CHARS),
      at: RECENT_BASE + (50 - n) * RECENT_MINUTE,
    });
    sessionIds.push(`big-${n}`);
  }

  const recent = buildRecentSessionsContext(db, { sessionIds, handoffDisclosure: 'silent' });

  assert.ok(recent.text.length <= INJECTION_BUDGET_CHARS);
  assert.ok(!recent.text.includes('BIG_REQUEST_'));
  const index = recent.text.slice(recent.text.indexOf('### 本文を載せていない過去の会話\n')).split('\n');
  assert.equal(index.length, 7);
  for (let n = 1; n <= 5; n += 1) {
    assert.ok(index[n].includes(`--session big-${n} `), index[n]);
    assert.ok(index[n].endsWith('--last 1`'), index[n]);
  }
  assert.equal(index[6], '- これより古い会話は、この一覧に載せていません。');
  assert.deepEqual(
    recent.sessions.map((s) => [s.sessionId, s.includedTurns]),
    [['current', 1], ['big-1', 0], ['big-2', 0], ['big-3', 0], ['big-4', 0], ['big-5', 0]],
  );
});
