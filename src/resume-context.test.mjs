import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  buildResumeContext,
  buildBudgetedResumeContext,
  buildCompactContinuationContext,
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

// --- 自動圧縮後の継続 (ADR 0032) ---

test('buildCompactContinuationContext: 完了したターンが無くても、作業途中のターンだけで組み立てる', () => {
  const db = makeDb();
  const result = buildCompactContinuationContext(db, {
    sessionId: 'S',
    inFlight: { user: { content: '最初の依頼', timestamp: null }, fragments: [] },
  });
  assert.match(result.text, /^## Throughline: 自動圧縮後の継続用コンテキスト\n/);
  assert.match(result.text, /### 現在地 \(作業途中のターン\)\n\*\*作業中のユーザー依頼\*\*: 最初の依頼\n/);
  assert.doesNotMatch(result.text, /圧縮直前のあなたの発言/);
  assert.doesNotMatch(result.text, /### 直前の対話/);
  assert.equal(result.injectedL2Turns, 0);
  assert.equal(buildCompactContinuationContext(db, { sessionId: 'S', inFlight: null }), null);
});

test('buildCompactContinuationContext: 現在地は作業途中のターンで、保存済みのターンはL2に並び、宣言は求めない', () => {
  const db = makeDb();
  insertBody(db, { session: 'S', origin: 'S', turn: 1, role: 'user', text: '前の依頼', createdAt: 1_000 });
  insertBody(db, { session: 'S', origin: 'S', turn: 1, role: 'assistant', text: '前の回答', createdAt: 2_000 });
  const result = buildCompactContinuationContext(db, {
    sessionId: 'S',
    inFlight: {
      user: { content: '今の依頼', timestamp: 3_000 },
      fragments: [{ content: '途中1', timestamp: 4_000 }, { content: '途中2', timestamp: 5_000 }],
    },
  });
  const anchor = result.text.slice(result.text.indexOf('### 現在地'), result.text.indexOf('### さらに前の記憶'));
  assert.match(anchor, /\*\*作業中のユーザー依頼\*\* \[\d\d:\d\d:\d\d\]: 今の依頼\n\*\*圧縮直前のあなたの発言\*\* \[\d\d:\d\d:\d\d\]: 途中2\n/);
  assert.doesNotMatch(anchor, /前の依頼|途中1/);
  assert.match(result.text, /### 直前の対話 \(L2 \/ active work thread, 古い順\)\n\[\d\d:\d\d:\d\d\] \[user\]: 前の依頼\n\[\d\d:\d\d:\d\d\] \[assistant\]: 前の回答/);
  assert.doesNotMatch(result.text, /宣言|\/clear/);
  assert.equal(result.injectedL2Turns, 1);
});

test('buildCompactContinuationContext: 長い依頼と多数のターンでも予算内に収め、依頼は切り詰めを明示する', () => {
  const db = makeDb();
  for (let turn = 1; turn <= 12; turn++) {
    insertBody(db, { session: 'S', origin: 'S', turn, role: 'user', text: `依頼${turn} ` + 'あ'.repeat(600), createdAt: turn * 1_000 });
    insertBody(db, { session: 'S', origin: 'S', turn, role: 'assistant', text: `回答${turn} ` + 'い'.repeat(600), createdAt: turn * 1_000 + 500 });
  }
  const result = buildCompactContinuationContext(db, {
    sessionId: 'S',
    inFlight: {
      user: { content: 'ヰ'.repeat(6_000), timestamp: 20_000 },
      fragments: [{ content: 'ヱ'.repeat(3_000), timestamp: 21_000 }],
    },
  });
  assert.ok(result.totalChars <= INJECTION_BUDGET_CHARS, `${result.totalChars}`);
  assert.equal((result.text.match(/ヰ/g) ?? []).length, 4_000);
  assert.equal((result.text.match(/ヱ/g) ?? []).length, 1_500);
  assert.match(result.text, /ヰ …\(長いため中略 2000 字\)… ヰ/);
  assert.match(result.text, /ヱ …\(長いため中略 1500 字\)… ヱ/);
  assert.ok(result.injectedL2Turns >= 1, '最新の保存済みターンは入る');
  assert.match(result.text, /回答12/);
  assert.equal(result.injectedL2Turns + result.remainingL2Turns, 12);
  assert.match(result.text, /throughline recall --l2 --session S /);
});

test('buildCompactContinuationContext: 長い依頼は先頭と末尾を残す。今の依頼が記録から読めない時は、その旨だけを現在地に書く', () => {
  const db = makeDb();
  const long = buildCompactContinuationContext(db, {
    sessionId: 'S',
    inFlight: { user: { content: '先頭の指示' + 'あ'.repeat(6_000) + '末尾の指示', timestamp: null }, fragments: [] },
  });
  assert.match(long.text, /\*\*作業中のユーザー依頼\*\*: 先頭の指示あ+ …\(長いため中略 2010 字\)… あ+末尾の指示\n/);

  const unreadable = buildCompactContinuationContext(db, { sessionId: 'S', inFlight: null, inFlightUnreadable: true });
  assert.match(unreadable.text, /### 現在地 \(作業途中のターン\)\n\*\*作業中のユーザー依頼\*\*: （記録からまだ読めません。圧縮後の文脈にある最新のユーザー依頼を続けてください）\n/);
});
