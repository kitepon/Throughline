import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildTrimPlan, renderTrimDryRunReport } from './trim-model.mjs';

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

function seedTurns(db, { count = 25 } = {}) {
  db.prepare(
    `INSERT INTO sessions (session_id, project_path, status, created_at, updated_at)
     VALUES ('sess-trim', '/repo', 'active', 1, 2)`,
  ).run();

  for (let turn = 1; turn <= count; turn++) {
    db.prepare(
      `INSERT INTO bodies
         (session_id, origin_session_id, turn_number, role, text, token_count, created_at)
       VALUES ('sess-trim', 'sess-trim', ?, 'user', ?, 1, ?)`,
    ).run(turn, `user body ${turn}`, turn * 1000);
    db.prepare(
      `INSERT INTO bodies
         (session_id, origin_session_id, turn_number, role, text, token_count, created_at)
       VALUES ('sess-trim', 'sess-trim', ?, 'assistant', ?, 1, ?)`,
    ).run(turn, `assistant body ${turn}`, turn * 1000 + 100);
  }

  db.prepare(
    `INSERT INTO details
       (session_id, origin_session_id, turn_number, tool_name, input_text, output_text,
        token_count, created_at, kind, source_id)
     VALUES ('sess-trim', 'sess-trim', 25, 'thinking', NULL, 'latest thought',
             1, 25100, 'thinking', 'thinking-25')`,
  ).run();
}

function seedSkeleton(db, { turn = 1, summary = 'old L1 summary' } = {}) {
  db.prepare(
    `INSERT INTO skeletons
       (session_id, origin_session_id, turn_number, role, summary, created_at)
     VALUES ('sess-trim', 'sess-trim', ?, 'assistant', ?, ?)`,
  ).run(turn, summary, turn * 1000 + 500);
}

function seedSessionTurns(db, { sessionId, projectPath = '/repo', updatedAt = 2, textPrefix, count = 2 }) {
  db.prepare(
    `INSERT INTO sessions (session_id, project_path, status, created_at, updated_at)
     VALUES (?, ?, 'active', 1, ?)`,
  ).run(sessionId, projectPath, updatedAt);

  for (let turn = 1; turn <= count; turn++) {
    db.prepare(
      `INSERT INTO bodies
         (session_id, origin_session_id, turn_number, role, text, token_count, created_at)
       VALUES (?, ?, ?, 'user', ?, 1, ?)`,
    ).run(sessionId, sessionId, turn, `${textPrefix} user ${turn}`, turn * 1000);
    db.prepare(
      `INSERT INTO bodies
         (session_id, origin_session_id, turn_number, role, text, token_count, created_at)
       VALUES (?, ?, ?, 'assistant', ?, 1, ?)`,
    ).run(sessionId, sessionId, turn, `${textPrefix} assistant ${turn}`, turn * 1000 + 100);
  }
}

test('buildTrimPlan: default dry-run keeps recent 20 and marks Claude as manual-only', () => {
  const db = makeDb();
  seedTurns(db);

  const plan = buildTrimPlan(db, {
    sessionId: 'sess-trim',
    host: 'claude',
  });

  assert.equal(plan.status, 'manual-only');
  assert.equal(plan.session.id, 'sess-trim');
  assert.equal(plan.host.reason, 'claude_rewind_conversation_only_not_automated');
  assert.equal(plan.trim.capturedTurns, 25);
  assert.equal(plan.trim.keepRecent, 20);
  assert.equal(plan.trim.rollbackTurns, 5);
  assert.equal(plan.trim.automaticExecutionAllowed, false);
  assert.equal(plan.memoryPreview.stats.recentBodies, 40);
  assert.match(plan.memoryPreview.text, /assistant body 25/);
  assert.match(plan.memoryPreview.text, /current-task context for continuation/);
  assert.match(plan.memoryPreview.text, /Do not treat every older line as still-current truth/);
});

test('buildTrimPlan: --all plans to roll back every captured turn and enables Codex automation', () => {
  const db = makeDb();
  seedTurns(db, { count: 3 });

  const plan = buildTrimPlan(db, {
    sessionId: 'sess-trim',
    host: 'codex',
    trimAll: true,
  });

  assert.equal(plan.status, 'ready');
  assert.equal(plan.host.reason, 'codex_rollback_inject_available');
  assert.deepEqual(plan.hostIdentity, {
    host: 'codex',
    codexThreadId: null,
    explicit: false,
    reason: 'codex_thread_id_not_provided',
  });
  assert.equal(plan.trim.keepRecent, 0);
  assert.equal(plan.trim.rollbackTurns, 3);
  assert.equal(plan.trim.automaticExecutionAllowed, true);
  assert.equal(plan.safeContinuation.status, 'fresh-thread-handoff-available');
  assert.equal(plan.safeContinuation.reason, 'optional_fresh_thread_continuation');
  assert.equal(
    plan.safeContinuation.safetyScope,
    'fresh_thread_handoff_no_current_thread_mutation',
  );
  assert.equal('restartSafe' in plan.safeContinuation, false);
  assert.equal(plan.safeContinuation.mutatesCurrentThread, false);
  assert.equal(
    plan.safeContinuation.guidedCommand,
    'throughline codex-handoff-start --session codex:<thread-id>',
  );
  assert.equal(
    plan.safeContinuation.smokeCommand,
    'throughline codex-handoff-smoke --session codex:<thread-id>',
  );
  assert.equal(
    plan.safeContinuation.modelSmokeDryRunCommand,
    'throughline codex-handoff-model-smoke --session codex:<thread-id> --dry-run --json',
  );
  assert.equal(
    plan.safeContinuation.memoryCommand,
    'throughline codex-resume --session codex:<thread-id> --format handoff',
  );
  assert.match(plan.safeContinuation.procedure.join('\n'), /Validate the fresh-thread handoff/);
  assert.match(plan.safeContinuation.procedure.join('\n'), /guided command/);
  assert.match(plan.safeContinuation.procedure.join('\n'), /dry-run the model smoke command/);
  assert.match(plan.safeContinuation.procedure.join('\n'), /Start a new Codex thread/);
});

test('buildTrimPlan: explicit Codex thread id is carried separately from Claude session id', () => {
  const db = makeDb();
  seedTurns(db, { count: 3 });

  const plan = buildTrimPlan(db, {
    sessionId: 'sess-trim',
    host: 'codex',
    codexThreadId: '019dfabf-thread',
    trimAll: true,
  });

  assert.deepEqual(plan.hostIdentity, {
    host: 'codex',
    codexThreadId: '019dfabf-thread',
    explicit: true,
    reason: 'explicit_codex_thread_id',
  });
  assert.equal(plan.session.id, 'sess-trim');
  assert.equal(plan.trim.automaticExecutionAllowed, true);
  assert.equal(
    plan.safeContinuation.memoryCommand,
    'throughline codex-resume --session codex:019dfabf-thread --format handoff',
  );
  assert.equal(
    plan.safeContinuation.guidedCommand,
    'throughline codex-handoff-start --session codex:019dfabf-thread',
  );
  assert.equal(
    plan.safeContinuation.smokeCommand,
    'throughline codex-handoff-smoke --session codex:019dfabf-thread',
  );
  assert.equal(
    plan.safeContinuation.modelSmokeDryRunCommand,
    'throughline codex-handoff-model-smoke --session codex:019dfabf-thread --dry-run --json',
  );
});

test('buildTrimPlan: Codex defaults memory session to the current Codex thread, not latest project session', () => {
  const db = makeDb();
  const threadId = '019dfabf-thread';
  seedSessionTurns(db, {
    sessionId: 'claude-latest',
    updatedAt: 999,
    textPrefix: 'claude latest memory',
  });
  seedSessionTurns(db, {
    sessionId: `codex:${threadId}`,
    updatedAt: 100,
    textPrefix: 'codex current memory',
  });

  const plan = buildTrimPlan(db, {
    projectPath: '/repo',
    host: 'codex',
    codexThreadId: threadId,
    trimAll: true,
  });

  assert.equal(plan.status, 'ready');
  assert.equal(plan.session.id, `codex:${threadId}`);
  assert.equal(plan.session.source, 'throughline-db');
  assert.equal(plan.trim.capturedTurns, 2);
  assert.match(plan.memoryPreview.text, /codex current memory assistant 2/);
  assert.doesNotMatch(plan.memoryPreview.text, /claude latest memory/);
});

test('buildTrimPlan: Codex without a thread id does not fall back to latest project session', () => {
  const db = makeDb();
  seedSessionTurns(db, {
    sessionId: 'claude-latest',
    updatedAt: 999,
    textPrefix: 'claude latest memory',
  });

  const plan = buildTrimPlan(db, {
    projectPath: '/repo',
    host: 'codex',
    trimAll: true,
  });

  assert.equal(plan.status, 'unavailable');
  assert.equal(plan.reason, 'no_session');
  assert.equal(plan.session, null);
});

test('buildTrimPlan: current-work memo is placed in curated memory preview', () => {
  const db = makeDb();
  seedTurns(db, { count: 3 });

  const plan = buildTrimPlan(db, {
    sessionId: 'sess-trim',
    host: 'claude',
    inflightMemo: '**次の一手**: keep implementing trim dry-run',
  });

  assert.match(plan.memoryPreview.text, /In-flight Memo/);
  assert.match(plan.memoryPreview.text, /keep implementing trim dry-run/);
});

test('buildTrimPlan: external Codex rollout source can drive trim without captured DB turns', () => {
  const db = makeDb();
  db.prepare(
    `INSERT INTO sessions (session_id, project_path, status, created_at, updated_at)
     VALUES ('sess-empty', '/repo', 'active', 1, 2)`,
  ).run();

  const plan = buildTrimPlan(db, {
    sessionId: 'sess-empty',
    host: 'codex',
    codexThreadId: '019dfabf-thread',
    keepRecent: 20,
    trimSource: {
      source: 'codex-rollout',
      sourceReason: 'explicit_codex_thread_rollout',
      threadId: '019dfabf-thread',
      projectPath: '/repo',
      capturedTurns: 22,
      memoryPreview: {
        text: '## Throughline Trim Memory Preview\n\n### Active Work Thread (Codex Rollout)\nactive',
        truncated: false,
        stats: { source: 'codex-rollout' },
      },
      contextEstimate: {
        method: 'chars_div_4',
        turns: [
          { turn: 1, chars: 40, estimatedTokens: 10 },
          { turn: 2, chars: 80, estimatedTokens: 20 },
          { turn: 3, chars: 120, estimatedTokens: 30 },
        ],
      },
    },
  });

  assert.equal(plan.status, 'ready');
  assert.equal(plan.trim.source, 'codex-rollout');
  assert.equal(plan.trim.sourceReason, 'explicit_codex_thread_rollout');
  assert.equal(plan.trim.capturedTurns, 22);
  assert.equal(plan.trim.rollbackTurns, 2);
  assert.equal(plan.trim.contextReductionEstimate.rollbackEstimatedTokens, 50);
  assert.equal(plan.trim.contextReductionEstimate.injectedMemoryEstimatedTokens, 21);
  assert.equal(plan.trim.contextReductionEstimate.netEstimatedTokens, 29);
  assert.equal(plan.trim.contextReductionEstimate.reductionPct, 58);
  assert.match(plan.memoryPreview.text, /Codex Rollout/);
});

test('buildTrimPlan: Codex rollout source uses Throughline DB memory when available', () => {
  const db = makeDb();
  seedTurns(db, { count: 25 });
  seedSkeleton(db, { turn: 1, summary: 'summarized old turn 1' });

  const plan = buildTrimPlan(db, {
    sessionId: 'sess-trim',
    host: 'codex',
    codexThreadId: '019dfabf-thread',
    keepRecent: 20,
    trimSource: {
      source: 'codex-rollout',
      sourceReason: 'explicit_codex_thread_rollout',
      threadId: '019dfabf-thread',
      projectPath: '/repo',
      capturedTurns: 25,
      memoryPreview: {
        text: '## Throughline Trim Memory Preview\n\n### Active Work Thread (Codex Rollout)\nwrong source',
        truncated: false,
        stats: { source: 'codex-rollout' },
      },
      contextEstimate: {
        method: 'chars_div_4',
        turns: [
          { turn: 1, chars: 40, estimatedTokens: 10 },
          { turn: 2, chars: 80, estimatedTokens: 20 },
          { turn: 3, chars: 120, estimatedTokens: 30 },
          { turn: 4, chars: 160, estimatedTokens: 40 },
          { turn: 5, chars: 200, estimatedTokens: 50 },
        ],
      },
    },
  });

  assert.equal(plan.trim.source, 'codex-rollout');
  assert.equal(plan.trim.rollbackTurns, 5);
  assert.equal(plan.memoryPreview.stats.source, 'throughline-db');
  assert.equal(plan.memoryPreview.stats.recentBodies, 40);
  assert.match(plan.memoryPreview.text, /L1 Summaries/);
  assert.match(plan.memoryPreview.text, /summarized old turn 1/);
  assert.match(plan.memoryPreview.text, /assistant body 25/);
  assert.doesNotMatch(plan.memoryPreview.text, /Codex Rollout/);
});

test('buildTrimPlan: external Codex rollout source can stand in when DB session is absent', () => {
  const db = makeDb();

  const plan = buildTrimPlan(db, {
    host: 'codex',
    codexThreadId: '019dfabf-thread',
    keepRecent: 1,
    trimSource: {
      source: 'codex-rollout',
      threadId: '019dfabf-thread',
      projectPath: '/repo',
      capturedTurns: 3,
      memoryPreview: {
        text: 'active rollout memory',
        truncated: false,
        stats: { source: 'codex-rollout' },
      },
    },
  });

  assert.equal(plan.status, 'ready');
  assert.equal(plan.session.id, 'codex:019dfabf-thread');
  assert.equal(plan.session.status, 'external');
  assert.equal(plan.session.source, 'codex-rollout');
  assert.equal(plan.trim.rollbackTurns, 2);
});

test('renderTrimDryRunReport: explains host boundary and curated memory', () => {
  const db = makeDb();
  seedTurns(db, { count: 2 });

  const plan = buildTrimPlan(db, {
    sessionId: 'sess-trim',
    host: 'unknown',
    keepRecent: 20,
  });
  const report = renderTrimDryRunReport(plan);

  assert.match(report, /Throughline Trim Dry-run/);
  assert.match(report, /Automatic execution allowed: no/);
  assert.match(report, /host_unknown/);
  assert.match(report, /Curated Memory Preview/);
});

test('renderTrimDryRunReport: includes Codex context reduction estimate when available', () => {
  const db = makeDb();

  const plan = buildTrimPlan(db, {
    host: 'codex',
    codexThreadId: '019dfabf-thread',
    keepRecent: 1,
    trimSource: {
      source: 'codex-rollout',
      threadId: '019dfabf-thread',
      projectPath: '/repo',
      capturedTurns: 3,
      memoryPreview: {
        text: 'short injected memory',
        truncated: false,
        stats: { source: 'codex-rollout' },
      },
      contextEstimate: {
        method: 'chars_div_4',
        turns: [
          { turn: 1, chars: 40, estimatedTokens: 10 },
          { turn: 2, chars: 80, estimatedTokens: 20 },
          { turn: 3, chars: 120, estimatedTokens: 30 },
        ],
      },
    },
  });
  const report = renderTrimDryRunReport(plan);

  assert.match(report, /Estimated rollback tokens: 50/);
  assert.match(report, /Estimated injected memory tokens: 6/);
  assert.match(report, /Estimated net token reduction: 44 \(88%, chars_div_4\)/);
  assert.match(report, /Safe Continuation Path/);
  assert.match(report, /fresh-thread-handoff-available/);
  assert.match(report, /safety scope: fresh_thread_handoff_no_current_thread_mutation/);
  assert.match(report, /throughline codex-handoff-start --session codex:019dfabf-thread/);
  assert.match(report, /throughline codex-handoff-smoke --session codex:019dfabf-thread/);
  assert.match(report, /throughline codex-resume --session codex:019dfabf-thread --format handoff/);
});

test('renderTrimDryRunReport: truncates text preview without truncating plan memory', () => {
  const db = makeDb();
  seedTurns(db, { count: 4 });

  const plan = buildTrimPlan(db, {
    sessionId: 'sess-trim',
    host: 'codex',
    codexThreadId: '019dfabf-thread',
    trimAll: true,
    previewMaxChars: 120,
  });
  const report = renderTrimDryRunReport(plan);

  assert.equal(plan.memoryPreview.truncated, false);
  assert.match(plan.memoryPreview.text, /assistant body 4/);
  assert.match(report, /\[preview truncated to 120 chars/);
  assert.match(report, /full memory remains available in JSON memoryPreview\.text/);
  assert.match(report, /throughline codex-handoff-start --session codex:019dfabf-thread/);
  assert.match(report, /throughline codex-resume --session codex:019dfabf-thread --format handoff/);
  assert.doesNotMatch(report, /assistant body 4/);
});

test('renderTrimDryRunReport: explains Codex restore-safety risk when compacted history can restore rollback text', () => {
  const db = makeDb();

  const plan = buildTrimPlan(db, {
    host: 'codex',
    codexThreadId: '019dfabf-thread',
    keepRecent: 1,
    trimSource: {
      source: 'codex-rollout',
      threadId: '019dfabf-thread',
      projectPath: '/repo',
      capturedTurns: 3,
      memoryPreview: {
        text: 'short injected memory',
        truncated: false,
        stats: { source: 'codex-rollout' },
      },
      restoreSafety: {
        status: 'risk',
        compactedRows: 1,
        compactedReplacementUserMessages: 2,
        rolledBackUserMessages: 1,
        rollbackTextRetainedInCompacted: 1,
        resurrectedUserMessages: 1,
        retainedTexts: [],
        resurrectedTexts: [],
        risks: [
          {
            type: 'rollback_text_retained_in_compacted_replacement_history',
            count: 1,
            message: 'risk',
          },
        ],
      },
    },
  });
  const report = renderTrimDryRunReport(plan);

  assert.equal(plan.trim.restoreSafety.status, 'risk');
  assert.match(report, /Restore safety: risk/);
  assert.match(report, /Rollback text retained in compacted history: 1/);
  assert.match(report, /Restore safety risk: rollback_text_retained_in_compacted_replacement_history \(1\)/);
});

test('renderTrimDryRunReport: explains planned Codex rollback restore-safety risk', () => {
  const db = makeDb();
  const dir = mkdtempSync(join(tmpdir(), 'tl-trim-model-rollout-'));
  try {
    const rolloutPath = writeRollout(dir, [
      event('user_message', { message: 'stable request' }),
      event('task_started'),
      event('agent_message', { message: 'stable answer' }),
      event('task_complete'),
      event('user_message', { message: 'planned compacted rollback request' }),
      event('task_started'),
      event('agent_message', { message: 'planned compacted answer' }),
      event('task_complete'),
      compacted([userReplacement('planned compacted rollback request')]),
      event('context_compacted'),
    ]);

    const plan = buildTrimPlan(db, {
      host: 'codex',
      codexThreadId: '019dfabf-thread',
      keepRecent: 1,
      trimSource: {
        source: 'codex-rollout',
        threadId: '019dfabf-thread',
        projectPath: '/repo',
        rolloutPath,
        capturedTurns: 2,
        memoryPreview: {
          text: 'short injected memory',
          truncated: false,
          stats: { source: 'codex-rollout' },
        },
      },
    });
    const report = renderTrimDryRunReport(plan);

    assert.equal(plan.trim.plannedRollbackRestoreSafety.status, 'risk');
    assert.match(report, /Planned rollback restore safety: risk/);
    assert.match(report, /Planned rollback text retained in compacted history: 1/);
    assert.match(
      report,
      /Planned rollback restore safety risk: planned_rollback_text_retained_in_compacted_replacement_history \(1\)/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function writeRollout(dir, events) {
  const path = join(dir, 'rollout.jsonl');
  const rows = [
    {
      timestamp: '2026-05-07T00:00:00.000Z',
      type: 'session_meta',
      payload: {
        id: '019dfabf-thread',
        cwd: '/repo',
        source: 'vscode',
      },
    },
    ...events,
  ];
  writeFileSync(path, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  return path;
}

function event(type, payload = {}) {
  return {
    timestamp: '2026-05-07T00:00:01.000Z',
    type: 'event_msg',
    payload: { type, ...payload },
  };
}

function compacted(replacementHistory) {
  return {
    timestamp: '2026-05-07T00:00:01.500Z',
    type: 'compacted',
    payload: {
      message: '',
      replacement_history: replacementHistory,
    },
  };
}

function userReplacement(text) {
  return {
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text }],
  };
}
