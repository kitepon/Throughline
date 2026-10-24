import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { testTempDir } from './test-temp-dir.mjs';
import { requestAutoHandoff, updateAutoHandoff, getAutoHandoff, freezeCodexMemory,
  claimAutoHandoff, continuationInput, failAutoHandoff } from './codex-auto-handoff-store.mjs';
import { collectAutoHandoffMemory, ensureAutoHandoffSummaries, renderAutoHandoffMemory,
  renderFrozenDetail } from './codex-auto-handoff-memory.mjs';
import { readCodexHandoffState, settingsMatch, threadStartSettings, resolvePreparedSettings } from './hosts/codex-handoff-state.mjs';
import { runAutoHandoffWorker, requestCodexAutoHandoff as realRequestCodexAutoHandoff, sourceBoundary,
  waitForCodexHandoffPreparation, renderAutoHandoffFailure, codexHandoffRequestFailureResult,
  autoHandoffTargetName, nameAutoHandoffTarget, findLiveAutoHandoffSuccessor,
  markAutoHandoffSource, markAutoHandoffSources, autoHandoffSourceFallbackTitle, carryAutoHandoffQueue,
  untrackedInheritedMemory, resolveAutoHandoffSuccessor, hookIdentityShape,
  checkAutoHandoffSourceGoal, pauseAutoHandoffSourceGoal, carryAutoHandoffGoal, settleAutoHandoffSourceGoal, launchAutoHandoffGoalSettle } from './codex-auto-handoff.mjs';
import { parseAutoHandoffArgs } from './cli/auto-handoff.mjs';

// 既存の要求試験ではlaunchWorkerもfixture。準備の完了も同じ境界のfixtureで返す。
const requestCodexAutoHandoff = args => realRequestCodexAutoHandoff({
  checkGoal: async () => {},
  waitForPreparation: async (db, id) => {
    const op = getAutoHandoff(db, id);
    updateAutoHandoff(db, id, { runtime_json: { ...op.runtime,
      sourceStopGate: { ...op.runtime.sourceStopGate, ready: true } } });
  }, ...args,
});

async function withDb(fn) {
  const home = mkdtempSync(join(tmpdir(), 'tl-auto-handoff-'));
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home; process.env.USERPROFILE = home;
  let db;
  try {
    const mod = await import(`./db.mjs?auto=${home}`);
    db = mod.getDb();
    await fn(db, home, mod);
  } finally {
    db?.close();
    for (const [key, value] of Object.entries(saved)) {
      if (value == null) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(home, { recursive: true, force: true });
  }
}

function request(db, threadId, extra = {}) {
  return requestAutoHandoff(db, { threadId, turnId: 'turn', projectPath: '/project',
    rolloutPath: '/codex/rollout.jsonl', codexHome: '/codex', openHost: 'desktop', ...extra });
}

function snapshot(db, operation, count, at = 1, control = null) {
  const session = operation.source_session_id;
  db.prepare('INSERT INTO sessions (session_id,project_path,created_at,updated_at) VALUES (?, ?, ?, ?)')
    .run(session, '/project', at, at);
  const body = db.prepare('INSERT INTO bodies (session_id,origin_session_id,turn_number,role,text,created_at) VALUES (?, ?, ?, ?, ?, ?)');
  for (let turn = 1; turn <= count; turn++) {
    body.run(session, session, turn, 'user', turn === 1 && control ? control : `依頼${at}-${turn}`, at + turn);
    body.run(session, session, turn, 'assistant', `応答${at}-${turn}`, at + turn);
  }
  db.prepare('INSERT INTO details (session_id,origin_session_id,turn_number,tool_name,kind,output_text,created_at) VALUES (?, ?, 1, ?, ?, ?, ?)')
    .run(session, session, 'exec_command', 'tool_output', 'L3だけの値', at);
  const frozen = freezeCodexMemory(db, operation, {}, { stoppedAt: at + count });
  return updateAutoHandoff(db, operation.handoff_id, { snapshot_json: frozen, state: 'memory_ready' }).operation;
}

test('製品migrationと元turnの一意性、workerのprocess誕生時刻を検証する', async () => withDb(db => {
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 12);
  const a = request(db, 'A');
  const duplicate = request(db, 'A');
  assert.equal(a.inserted, true); assert.equal(duplicate.inserted, false);
  assert.equal(a.operation.handoff_id, duplicate.operation.handoff_id);
  assert.equal(claimAutoHandoff(db, a.operation.handoff_id, { pid: 1, started_identity: 'old' }, []), true);
  assert.equal(claimAutoHandoff(db, a.operation.handoff_id, { pid: 2, started_identity: 'new' }, [{ pid: 1, started_identity: 'old' }]), false);
  assert.equal(claimAutoHandoff(db, a.operation.handoff_id, { pid: 1, started_identity: 'reused' }, [{ pid: 1, started_identity: 'reused' }]), true);
}));

test('v11の既存記憶を保持したまま正規migrationでv12へ移行する', async () => withDb((db, home, mod) => {
  db.prepare('INSERT INTO sessions (session_id,project_path,created_at,updated_at) VALUES (?, ?, 1, 1)').run('existing', '/project');
  db.exec('DROP TABLE codex_handoff_summaries; DROP TABLE codex_handoffs; PRAGMA user_version = 11;');
  assert.equal(mod.migrateDefaultDb().status, 'migrated');
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 12);
  assert.equal(db.prepare('SELECT session_id FROM sessions').get().session_id, 'existing');
}));

test('A→B→Cの全体で直近20ターンを保持し、古いL1と凍結L3を取得できる', async () => withDb(db => {
  let a = snapshot(db, request(db, 'A').operation, 12);
  a = updateAutoHandoff(db, a.handoff_id, { target_thread_id: 'B', state: 'continued' }).operation;
  let b = snapshot(db, request(db, 'B').operation, 12, 100, continuationInput(a));
  b = updateAutoHandoff(db, b.handoff_id, { target_thread_id: 'C' }).operation;
  assert.throws(() => updateAutoHandoff(db, b.handoff_id, { snapshot_json: { version: 1 } }), /handoff_snapshot_immutable/);
  let calls = 0;
  ensureAutoHandoffSummaries(db, b, { summarize: () => ({ summary: `古い要約${++calls}` }) });
  const memory = collectAutoHandoffMemory(db, b);
  assert.equal(memory.turnCount, 24); assert.equal(memory.recentTurnCount, 20);
  assert.equal(memory.olderSummaries.length, 4); assert.equal(calls, 4);
  const text = renderAutoHandoffMemory(db, b);
  assert.ok(text.includes('依頼100-12')); assert.ok(text.includes('古い要約1'));
  assert.ok(!text.includes('L3だけの値')); assert.ok(!text.includes(continuationInput(a)));
  db.prepare('DELETE FROM bodies WHERE session_id = ?').run(a.source_session_id);
  assert.ok(renderFrozenDetail(db, { operationId: a.handoff_id, originSessionId: a.source_session_id, turnNumber: 1 }).includes('L3だけの値'));
  assert.equal(collectAutoHandoffMemory(db, getAutoHandoff(db, b.handoff_id)).turnCount, 24);
  ensureAutoHandoffSummaries(db, b, { summarize: () => { throw Error('再生成してはいけない'); } });
}));

function workerDependencies(db, settings, submit, counters) {
  return {
    processes: () => [{ pid: process.pid, started_identity: 'test-worker' }],
    executable: () => '公式Desktop試験fixture',
    readSource: () => ({ latestTurnId: 'turn', stoppedAt: 2, pendingCallCount: 0, settings }),
    nativeState: async () => ({ projectId: null }),
    capture: (db, args) => {
      db.prepare('INSERT INTO sessions (session_id,project_path,created_at,updated_at) VALUES (?, ?, 1, 1)')
        .run(`codex:${args.threadId}`, '/project');
      db.prepare('INSERT INTO bodies (session_id,origin_session_id,turn_number,role,text,created_at) VALUES (?, ?, 1, ?, ?, 1)')
        .run(`codex:${args.threadId}`, `codex:${args.threadId}`, 'user', '未完了の依頼');
      return { status: 'captured' };
    },
    summaries: () => {},
    createTarget: async (db, operation) => {
      counters.created++;
      updateAutoHandoff(db, operation.handoff_id, { target_thread_id: 'same-target', mutation_stage: null,
        runtime_json: { ...operation.runtime, targetPrepared: true, targetMemoryInjected: true, preparedSettings: settings } });
    },
    readTarget: operation => ({ settings, latestTurnId: ['submitted', 'unknown'].includes(operation.state) ? 'new-turn' : null,
      correlatedTurnId: ['submitted', 'unknown'].includes(operation.state) ? 'new-turn' : null, progress: true }),
    openTarget: () => {}, verify: async () => {}, submit,
    pauseGoal: async operation => { (counters.goal ??= []).push(`pause:${operation.state}`); return counters.goalPause ?? 'none'; },
    carryGoal: async (operation, runtime, options) => {
      (counters.goal ??= []).push(`carry:${operation.state}:${options.wasActive}`); return counters.goalCarry ?? 'none';
    },
    carryQueue: async (db, operation) => { (counters.carried ??= []).push(`${operation.source_thread_id}:${operation.state}`); return { moved: 0, unknown: 0, left: 0 }; },
    markSource: async (operation, runtime, options) => {
      (counters.marked ??= []).push(`${operation.source_thread_id}:${operation.state}`);
      assert.ok('fallbackTitle' in options);
      return 'marked';
    },
    notify: () => { counters.notified++; },
    wait: async check => { const result = await check(); if (!result) throw Error('観測できません'); return result; },
  };
}

test('停止→記憶→作成→配送→進捗を確認し、重複workerは後継と指示を増やさない', async () => withDb(async db => {
  const operation = request(db, 'worker-source', { now: 1 }).operation;
  const counters = { created: 0, notified: 0, submitted: 0 };
  const deps = workerDependencies(db, {}, async () => { counters.submitted++; return { queued_submission_id: 'receipt' }; }, counters);
  const result = await runAutoHandoffWorker(operation.handoff_id, { db, dependencies: deps });
  assert.equal(result.state, 'continued'); assert.equal(result.started_turn_id, 'new-turn');
  await runAutoHandoffWorker(operation.handoff_id, { db, dependencies: deps });
  assert.equal(counters.created, 1); assert.equal(counters.submitted, 1); assert.equal(counters.notified, 0);
  assert.deepEqual(counters.marked, ['worker-source:continued'], '後継が作業を続けたのを確かめた後に、旧タスクへ印を1回だけ付ける');
  assert.deepEqual(counters.carried, ['worker-source:continued'], '後継が作業を続けたのを確かめた後に、順番待ちを1回だけ運ぶ');
}));

test('配送結果不明は再送せず、実際の入力・開始を観測して同じ後継から回復する', async () => withDb(async db => {
  const operation = request(db, 'worker-source', { now: 1 }).operation;
  const counters = { created: 0, notified: 0, submitted: 0 };
  const deps = workerDependencies(db, {}, async () => {
    counters.submitted++;
    throw Object.assign(Error('応答喪失'), { delivery_code: 'CODEX_RECEIVER_TIMEOUT', outcome_unknown: true });
  }, counters);
  const failed = await runAutoHandoffWorker(operation.handoff_id, { db, dependencies: deps });
  assert.equal(failed.state, 'unknown'); assert.equal(failed.mutation_stage, 'submit');
  const recovered = await runAutoHandoffWorker(operation.handoff_id, { db, dependencies: deps, resume: true });
  assert.equal(recovered.state, 'continued'); assert.equal(recovered.target_thread_id, 'same-target');
  assert.equal(counters.created, 1); assert.equal(counters.submitted, 1); assert.equal(counters.notified, 1);
}));

test('表示後の設定不一致は配送前に停止し、修正後は同じ後継を再利用する', async () => withDb(async db => {
  const op = request(db, 'settings-source', { now: 1 }).operation;
  const counters = { created: 0, submitted: 0, notified: 0 };
  const settings = { cwd: '/project', model: '元モデル' };
  const deps = workerDependencies(db, settings, async () => { counters.submitted++; return { queued_submission_id: 'receipt' }; }, counters);
  const readTarget = deps.readTarget;
  deps.readTarget = item => ({ ...readTarget(item), settings: { ...settings, model: '別モデル' } });
  const failed = await runAutoHandoffWorker(op.handoff_id, { db, dependencies: deps });
  assert.equal(failed.state, 'failed'); assert.equal(failed.error_code, 'handoff_target_settings_mismatch');
  assert.equal(counters.submitted, 0);
  deps.readTarget = readTarget;
  const result = await runAutoHandoffWorker(op.handoff_id, { db, dependencies: deps, resume: true });
  assert.equal(result.state, 'continued'); assert.equal(counters.created, 1); assert.equal(counters.submitted, 1);
}));

test('作成応答を失った時は結果不明を保存し、再開でも後継を再作成しない', async () => withDb(async db => {
  const op = request(db, 'create-source', { now: 1 }).operation;
  const counters = { created: 0, submitted: 0, notified: 0 };
  const deps = workerDependencies(db, {}, async () => { counters.submitted++; }, counters);
  deps.createTarget = async () => { counters.created++; throw Error('作成応答の喪失'); };
  const result = await runAutoHandoffWorker(op.handoff_id, { db, dependencies: deps });
  assert.equal(result.state, 'unknown'); assert.equal(result.mutation_stage, 'create');
  await runAutoHandoffWorker(op.handoff_id, { db, dependencies: deps, resume: true });
  assert.equal(counters.created, 1); assert.equal(counters.submitted, 0);
}));

test('実行中の子がある時は後継を作らない', async () => withDb(async db => {
  for (const code of ['handoff_native_child_pending']) {
    const op = request(db, code, { now: 1 }).operation;
    const counters = { created: 0, submitted: 0, notified: 0 };
    const deps = workerDependencies(db, {}, async () => { counters.submitted++; }, counters);
    deps.nativeState = async () => { throw Object.assign(Error(code), { code }); };
    const result = await runAutoHandoffWorker(op.handoff_id, { db, dependencies: deps });
    assert.equal(result.error_code, code); assert.equal(result.state, 'failed');
    assert.equal(counters.created, 0); assert.equal(counters.submitted, 0);
  }
}));

test('rollout の developer 記憶から、受け取った Throughline の記憶の本文を最初の1つだけ読む', () => {
  const dir = testTempDir('tl-inherited-');
  const file = join(dir, 'rollout.jsonl');
  const developer = text => ({ type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text }] } });
  const rows = [{ type: 'session_meta', payload: { id: 'T', cwd: '/project', originator: 'Codex Desktop', source: 'vscode' } },
    developer('ふつうの developer 文'),
    developer('## Throughline: New Codex Thread Handoff\n最初に受け取った記憶'),
    developer('## Throughline: Active Work Context\n後から入った別の記憶')];
  writeFileSync(file, rows.map(row => JSON.stringify({ timestamp: '2026-10-08T00:00:01.000Z', ...row })).join('\n') + '\n');
  const state = readCodexHandoffState(file, { threadId: 'T' });
  assert.equal(state.inheritedThroughlineMemory, true);
  assert.equal(state.inheritedThroughlineMemoryText, '## Throughline: New Codex Thread Handoff\n最初に受け取った記憶');
  writeFileSync(file, rows.slice(0, 2).map(row => JSON.stringify({ timestamp: '2026-10-08T00:00:01.000Z', ...row })).join('\n') + '\n');
  const plain = readCodexHandoffState(file, { threadId: 'T' });
  assert.equal(plain.inheritedThroughlineMemory, false); assert.equal(plain.inheritedThroughlineMemoryText, null);
});

test('前任をさかのぼれない記憶を受け取ったタスクも引き継ぎ、受け取った記憶をそのまま後継へ渡す', async () => withDb(async db => {
  const op = request(db, 'manual-origin', { now: 1 }).operation;
  const counters = { created: 0, submitted: 0, notified: 0 };
  const deps = workerDependencies(db, {}, async () => { counters.submitted++; return { queued_submission_id: 'receipt' }; }, counters);
  const read = deps.readSource;
  const inheritedText = '## Throughline: New Codex Thread Handoff\n手動の引き継ぎで受け取った記憶。前のタスクの合意: 4イベントを申請する';
  deps.readSource = (item, options) => ({ ...read(item, options), inheritedThroughlineMemory: true, inheritedThroughlineMemoryText: inheritedText });
  const result = await runAutoHandoffWorker(op.handoff_id, { db, dependencies: deps });
  assert.equal(result.state, 'continued', '断らずに引き継ぐ');
  assert.equal(result.error_code, null); assert.equal(counters.created, 1); assert.equal(counters.submitted, 1); assert.equal(counters.notified, 0);
  assert.deepEqual(result.runtime.inheritedMemory, { text: inheritedText, chars: Array.from(inheritedText).length, truncated: false });
}));

test('受け取った記憶は系列の最初の引き継ぎに残り、その先の後継の記憶にも出る。見出しは入れ子にしない', async () => withDb(db => {
  let a = snapshot(db, request(db, 'A').operation, 2);
  a = updateAutoHandoff(db, a.handoff_id, { target_thread_id: 'B', state: 'continued',
    runtime_json: { inheritedMemory: untrackedInheritedMemory('## Throughline: New Codex Thread Handoff\n前のタスクの合意: 4イベントを申請する') } }).operation;
  const first = renderAutoHandoffMemory(db, a);
  assert.ok(first.includes('### 系列の最初のタスクが受け取っていた記憶（そのまま）'));
  assert.ok(first.includes('前のタスクの合意: 4イベントを申請する'));
  assert.ok(first.includes('（元の見出し: New Codex Thread Handoff）'));
  assert.equal(first.match(/^## Throughline: /gm).length, 1, '見出しは後継の記憶の1つだけ');
  assert.ok(first.indexOf('系列の最初のタスクが受け取っていた記憶') < first.indexOf('直近'), '古い記憶を先に置く');

  let b = snapshot(db, request(db, 'B').operation, 2, 100, continuationInput(a));
  b = updateAutoHandoff(db, b.handoff_id, { target_thread_id: 'C' }).operation;
  assert.equal(b.previous_handoff_id, a.handoff_id);
  assert.ok(renderAutoHandoffMemory(db, b).includes('前のタスクの合意: 4イベントを申請する'), '次の後継にも渡る');

  // 受け取った記憶が無い系列には、この節を出さない
  const plain = snapshot(db, request(db, 'P').operation, 2);
  assert.ok(!renderAutoHandoffMemory(db, plain).includes('受け取っていた記憶'));
}));

test('長すぎる受け取った記憶は先頭だけを運び、切った事を後継の記憶に書く', async () => withDb(db => {
  const long = untrackedInheritedMemory('あ'.repeat(120_001));
  assert.equal(Array.from(long.text).length, 120_000); assert.equal(long.chars, 120_001); assert.equal(long.truncated, true);
  assert.deepEqual(untrackedInheritedMemory(null), { text: '', chars: 0, truncated: false });
  const a = updateAutoHandoff(db, snapshot(db, request(db, 'A').operation, 1).handoff_id, { runtime_json: { inheritedMemory: long } }).operation;
  const text = renderAutoHandoffMemory(db, a);
  assert.ok(text.includes('（長いので先頭だけ載せています。元は 120001 字）'));
  const empty = updateAutoHandoff(db, snapshot(db, request(db, 'E').operation, 1).handoff_id, { runtime_json: { inheritedMemory: untrackedInheritedMemory(null) } }).operation;
  assert.ok(renderAutoHandoffMemory(db, empty).includes('（本文を読めませんでした）'));
}));

test('開始eventからユーザー入力の保存までの間を別入力の混入と判定しない', async () => withDb(async db => {
  const op = request(db, 'gap-source', { now: 1 }).operation;
  const counters = { created: 0, submitted: 0, notified: 0 };
  const deps = workerDependencies(db, {}, async () => { counters.submitted++; return { queued_submission_id: 'receipt' }; }, counters);
  const read = deps.readTarget;
  let polls = 0;
  deps.readTarget = item => item.state === 'submitted' && polls++ === 0
    ? { latestTurnId: 'new-turn', hasTurnInput: false, correlatedTurnId: null, progress: false } : read(item);
  deps.wait = async check => { for (let i = 0; i < 3; i++) { const result = await check(); if (result) return result; } throw Error('観測失敗'); };
  assert.equal((await runAutoHandoffWorker(op.handoff_id, { db, dependencies: deps })).state, 'continued');
}));

test('実行中のnative sessionは停止境界で明示的に拒否する', () => {
  assert.throws(() => sourceBoundary({ source_turn_id: 'turn', created_at: 1 },
    { latestTurnId: 'turn', stoppedAt: 2, pendingCallCount: 0, pendingNativeSessionCount: 1 }), /handoff_native_session_pending/);
});

test('PreCompactの重複ではworkerを増やさず、manualと別projectでは発火しない', async () => withDb(async (db, home) => {
  const thread = '11111111-1111-1111-1111-111111111111', turn = '22222222-2222-2222-2222-222222222222';
  const dir = join(home, 'codex', 'sessions'); mkdirSync(dir, { recursive: true });
  const file = join(dir, 'rollout.jsonl');
  writeFileSync(file, [{ type: 'session_meta', payload: { id: thread, originator: 'Codex Desktop', source: 'vscode', cwd: home } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: turn } }].map(JSON.stringify).join('\n') + '\n');
  const payload = { trigger: 'auto', cwd: home, session_id: thread, turn_id: turn, transcript_path: file };
  const config = { enabled: true, projects: [home], openHost: 'desktop' };
  let launched = 0;
  const args = { db, config, payload, launchWorker: async () => { launched++; } };
  const first = await requestCodexAutoHandoff(args), second = await requestCodexAutoHandoff(args);
  assert.equal(first.continue, false); assert.equal(second.operationId, first.operationId); assert.equal(launched, 1);
  assert.equal((await requestCodexAutoHandoff({ ...args, payload: { ...payload, trigger: 'manual' } })).status, 'skipped');
  assert.equal((await requestCodexAutoHandoff({ ...args, config: { ...config, projects: ['/other'] } })).status, 'skipped');
}));

test('タスクの今の続きを引く。先までたどり、消えた後継は無い物として扱い、途中の引き継ぎと止まった引き継ぎを見分ける', async () => withDb(async db => {
  const id = n => `${String(n).repeat(8)}-${String(n).repeat(4)}-${String(n).repeat(4)}-${String(n).repeat(4)}-${String(n).repeat(12)}`;
  const [A, B, C, D, X, Y, Z] = [1, 2, 3, 4, 5, 6, 7].map(id);
  const done = (source, target) => updateAutoHandoff(db, request(db, source).operation.handoff_id,
    { state: 'continued', target_thread_id: target, queued_submission_id: `receipt-${target}` }).operation;
  const gone = new Set();
  const options = { findThread: ({ threadId }) => gone.has(threadId) ? null : { rolloutPath: `/r/${threadId}`, mtimeMs: 1 }, processes: () => [], now: 1_000_000 };
  // 引き継ぎの無いタスクは、自分が今の続き
  assert.deepEqual(resolveAutoHandoffSuccessor(db, X, options), { thread_id: X, handed_off: false, current_thread_id: X, chain: [], pending: null });

  const ab = done(A, B); const bc = done(B, C);
  const fromA = resolveAutoHandoffSuccessor(db, A, options);
  assert.equal(fromA.handed_off, true); assert.equal(fromA.current_thread_id, C); assert.equal(fromA.pending, null);
  assert.deepEqual(fromA.chain.map(item => [item.handoff_id, item.source_thread_id, item.target_thread_id, item.state]),
    [[ab.handoff_id, A, B, 'continued'], [bc.handoff_id, B, C, 'continued']]);
  assert.equal(resolveAutoHandoffSuccessor(db, B, options).current_thread_id, C);
  assert.deepEqual(resolveAutoHandoffSuccessor(db, B, options).chain.map(item => item.handoff_id), [bc.handoff_id]);
  assert.equal(resolveAutoHandoffSuccessor(db, C, options).handed_off, false);

  // 今の続き C が、さらに引き継いでいる最中（worker が動いている）
  const cd = updateAutoHandoff(db, request(db, C).operation.handoff_id, { state: 'memory_ready' }).operation;
  db.prepare('UPDATE codex_handoffs SET worker_identity_json = ?, updated_at = ? WHERE handoff_id = ?').run(JSON.stringify({ pid: 4242, started_identity: 'w' }), 999_000, cd.handoff_id);
  const running = resolveAutoHandoffSuccessor(db, A, { ...options, processes: () => [{ pid: 4242, started_identity: 'w' }] });
  assert.equal(running.current_thread_id, C); assert.equal(running.pending.handoff_id, cd.handoff_id);
  assert.equal(running.pending.in_flight, true); assert.equal(running.pending.state, 'memory_ready');
  // worker が居なくなっていれば、途中で止まった物として返す
  assert.equal(resolveAutoHandoffSuccessor(db, A, options).pending.in_flight, false);

  // C の引き継ぎが失敗して止まった
  updateAutoHandoff(db, cd.handoff_id, { state: 'failed', error_code: 'handoff_summarizer_backend_failed', resume_state: 'source_stopped' });
  const stopped = resolveAutoHandoffSuccessor(db, A, options);
  assert.equal(stopped.current_thread_id, C);
  assert.deepEqual([stopped.pending.state, stopped.pending.error_code, stopped.pending.resume_state, stopped.pending.in_flight],
    ['failed', 'handoff_summarizer_backend_failed', 'source_stopped', false]);

  // やり直して D へ続いた。C が消されても、D が残っていれば D が今の続き
  updateAutoHandoff(db, cd.handoff_id, { state: 'continued', error_code: null, resume_state: null, target_thread_id: D, queued_submission_id: 'receipt-D' });
  gone.add(C);
  const toD = resolveAutoHandoffSuccessor(db, A, options);
  assert.equal(toD.current_thread_id, D); assert.equal(toD.chain.length, 3); assert.equal(toD.pending, null);
  // 後継が全部消されたら、旧タスクが今の続きに戻る
  gone.add(D); gone.add(B);
  assert.deepEqual(resolveAutoHandoffSuccessor(db, A, options), { thread_id: A, handed_off: false, current_thread_id: A, chain: [], pending: null });

  // 後継が出来る前に失敗したタスク（後継なし）
  updateAutoHandoff(db, request(db, Y).operation.handoff_id, { state: 'failed', error_code: 'handoff_target_not_loaded', resume_state: 'memory_ready' });
  const failed = resolveAutoHandoffSuccessor(db, Y, options);
  assert.equal(failed.handed_off, false); assert.equal(failed.current_thread_id, Y); assert.equal(failed.pending.error_code, 'handoff_target_not_loaded');
  assert.throws(() => resolveAutoHandoffSuccessor(db, 'not-a-thread', options), /handoff_thread_id_invalid/);
  void Z;
}));

test('記録（rollout）を持たない会話からの圧縮の合図は、失敗にせず、圧縮にも手を出さない。引き継ぎは作らない', async () => withDb(async (db, home) => {
  // 2026-10-11 16:22 JST、macOS の Codex Desktop。会話の ID は引き継ぎ元でも引き継ぎ先でもなく、`transcript_path` が null だった
  const payload = { trigger: 'auto', cwd: home, session_id: '01a129d6-fe64-7010-9c79-19fe3b82c64d', turn_id: '01a129d6-fed1-7662-8286-280519f8d9bf',
    transcript_path: null, model: 'gpt-6.1-sol' };
  const config = { enabled: true, projects: [home], openHost: 'desktop' };
  let launched = 0; const passed = [], stopped = [];
  const args = { db, config, payload, launchWorker: async () => { launched++; }, recordUnrecordedCompaction: entry => passed.push(entry),
    recordInternalCompaction: entry => stopped.push(entry), now: Date.parse('2026-10-11T07:22:00.396Z') };
  const result = await requestCodexAutoHandoff(args);
  assert.deepEqual(result, { status: 'skipped', unrecordedThread: true }, '圧縮を止める指示（continue: false）を返さない');
  assert.equal(launched, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM codex_handoffs').get().n, 0, '引き継ぎの行は作らない');
  assert.deepEqual(passed, [{ at: '2026-10-11T07:22:00.396Z', thread_id: payload.session_id, turn_id: payload.turn_id, model: 'gpt-6.1-sol' }]);
  assert.deepEqual(stopped, []);

  // 項目そのものが無い時と、ターンの ID が内部の形の時も同じ。記号の混じる値は、記録へ中身を残さない
  await requestCodexAutoHandoff({ ...args, payload: { trigger: 'auto', cwd: home, session_id: payload.session_id, turn_id: 'auto-compact-1', model: 'a model/with spaces' } });
  assert.deepEqual(passed[1], { at: '2026-10-11T07:22:00.396Z', thread_id: payload.session_id, turn_id: 'auto-compact-1', model: 'text(19)' });
  assert.deepEqual(stopped, []);

  // 記録の場所が相対の時は、今までどおり失敗（記録を持つはずの会話で、場所だけが不正）
  await assert.rejects(requestCodexAutoHandoff({ ...args, payload: { ...payload, transcript_path: 'relative/rollout.jsonl' } }), /handoff_hook_identity_invalid/);
  // 無効な project と手動の圧縮は、記録も残さない
  assert.equal((await requestCodexAutoHandoff({ ...args, config: { ...config, projects: ['/other'] } })).status, 'skipped');
  assert.equal((await requestCodexAutoHandoff({ ...args, payload: { ...payload, trigger: 'manual' } })).status, 'skipped');
  assert.equal(passed.length, 2);
}));

test('Codexの内部の文脈（auto-compact-N）からの圧縮は、例外にせず止めて記録する。引き継ぎは作らない', async () => withDb(async (db, home) => {
  const thread = '11111111-1111-1111-1111-111111111111';
  const file = join(home, 'rollout.jsonl'); writeFileSync(file, '');
  const payload = { trigger: 'auto', cwd: home, session_id: thread, turn_id: 'auto-compact-3', transcript_path: file };
  const config = { enabled: true, projects: [home], openHost: 'desktop' };
  let launched = 0; const recorded = [];
  const args = { db, config, payload, launchWorker: async () => { launched++; }, recordInternalCompaction: entry => recorded.push(entry), now: Date.parse('2026-10-10T04:24:01.175Z') };
  const result = await requestCodexAutoHandoff(args);
  assert.equal(result.status, 'ok'); assert.equal(result.continue, false); assert.equal(result.internalCompaction, true);
  assert.match(result.stopReason, /ターンの外の自動圧縮を止めました/);
  assert.equal(launched, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM codex_handoffs').get().n, 0, '引き継ぎの行は作らない');
  assert.deepEqual(recorded, [{ at: '2026-10-10T04:24:01.175Z', thread_id: thread, turn_id: 'auto-compact-3' }]);

  // 無効な project と手動の圧縮は、今までどおり何もしない
  assert.equal((await requestCodexAutoHandoff({ ...args, config: { ...config, projects: ['/other'] } })).status, 'skipped');
  assert.equal((await requestCodexAutoHandoff({ ...args, payload: { ...payload, trigger: 'manual' } })).status, 'skipped');
  assert.equal(recorded.length, 1);

  // 形の決まっていない ID と、場所の分からない呼び出しは、今までどおり失敗として扱う
  for (const broken of [{ turn_id: 'something-else' }, { turn_id: undefined }, { turn_id: 'auto-compact-' }, { session_id: 'not-a-uuid' },
    { transcript_path: 'relative/rollout.jsonl' }]) {
    await assert.rejects(requestCodexAutoHandoff({ ...args, payload: { ...payload, ...broken } }), /handoff_hook_identity_invalid/);
  }
  assert.equal(recorded.length, 1);

  // 失敗には、どの値が不正だったかの形を付ける。path と記号の混じる値は、中身を残さない
  const shaped = await requestCodexAutoHandoff({ ...args, payload: { ...payload, turn_id: 'something else', transcript_path: 'relative/rollout.jsonl',
    agent_type: 'reviewer', model: 'gpt-5.5' } }).catch(error => error);
  assert.equal(shaped.code, 'handoff_hook_identity_invalid');
  assert.deepEqual(shaped.hookIdentity, { session_id: thread, turn_id: 'text(14)', transcript_path: 'relative(22)', cwd: 'absolute',
    agent_id: 'undefined', agent_type: 'reviewer', model: 'gpt-5.5', trigger: 'auto' });
  assert.deepEqual(hookIdentityShape({ session_id: thread, turn_id: 'auto-compact-', transcript_path: 'relative/rollout.jsonl', cwd: 7 }),
    { session_id: thread, turn_id: 'auto-compact-', transcript_path: 'relative(22)', cwd: 'number',
      agent_id: 'undefined', agent_type: 'undefined', model: 'undefined', trigger: 'undefined' });
}));

test('PreCompactの入口は、JS実装のrealpathが使えない環境（WindowsのCodex Desktopのhook）でも引き継ぎを作る', async () => withDb(async (db, home) => {
  const thread = '11111111-1111-1111-1111-111111111111', turn = '22222222-2222-2222-2222-222222222222';
  const dir = join(home, 'codex', 'sessions'); mkdirSync(dir, { recursive: true });
  const file = join(dir, 'rollout.jsonl');
  writeFileSync(file, [{ type: 'session_meta', payload: { id: thread, originator: 'Codex Desktop', source: 'vscode', cwd: home } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: turn } }].map(JSON.stringify).join('\n') + '\n');
  // foxの実測（2026-10-08）: Desktopが起動したhookの中では、JS実装が drive の根を lstat できずに落ちた。
  const original = fs.realpathSync;
  const broken = () => { throw Object.assign(new Error("EISDIR: illegal operation on a directory, lstat 'C:'"), { code: 'EISDIR' }); };
  broken.native = original.native;
  fs.realpathSync = broken; syncBuiltinESMExports();
  try {
    let launched = 0;
    const result = await requestCodexAutoHandoff({ db, config: { enabled: true, projects: [home], openHost: 'desktop' },
      payload: { trigger: 'auto', cwd: home, session_id: thread, turn_id: turn, transcript_path: file },
      launchWorker: async () => { launched++; } });
    assert.equal(result.status, 'ok'); assert.equal(result.inserted, true); assert.equal(launched, 1);
  } finally { fs.realpathSync = original; syncBuiltinESMExports(); }
}));

function desktopSource(home, thread, turn) {
  const dir = join(home, 'codex', 'sessions'); mkdirSync(dir, { recursive: true });
  const file = join(dir, `rollout-${thread}.jsonl`);
  writeFileSync(file, [{ type: 'session_meta', payload: { id: thread, originator: 'Codex Desktop', source: 'vscode', cwd: home } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: turn } }].map(JSON.stringify).join('\n') + '\n');
  return { trigger: 'auto', cwd: home, session_id: thread, turn_id: turn, transcript_path: file };
}

function delivered(db, home, source, turnId, target, now, fields = {}) {
  const operation = requestAutoHandoff(db, { threadId: source, turnId, projectPath: home,
    rolloutPath: '/codex/rollout.jsonl', codexHome: join(home, 'codex'), openHost: 'desktop', now }).operation;
  return updateAutoHandoff(db, operation.handoff_id, { target_thread_id: target, state: 'continued',
    queued_submission_id: `receipt-${target}`, runtime_json: { title: 'ベルチーム' }, ...fields }).operation;
}

test('引き継ぎ済みの旧タスクへ新しい入力が来ても後継を増やさず、止めて今の後継を示して開く', async () => withDb(async (db, home) => {
  const thread = '11111111-1111-1111-1111-111111111111';
  const first = delivered(db, home, thread, '22222222-2222-2222-2222-222222222222', 'successor-1', 1);
  const payload = desktopSource(home, thread, '33333333-3333-3333-3333-333333333333');
  const config = { enabled: true, projects: [home], openHost: 'desktop' };
  const seen = { launched: 0, opened: [], recorded: [], asked: [] };
  const args = { db, config, payload, launchWorker: async () => { seen.launched++; }, settleGoal: async () => false,
    findThread: query => { seen.asked.push(query); return { mtimeMs: 1 }; },
    openThread: operation => { seen.opened.push(operation.target_thread_id); return true; },
    recordRedirect: entry => { seen.recorded.push(entry); } };
  const result = await requestCodexAutoHandoff(args);
  assert.equal(result.continue, false); assert.equal(result.redirected, true); assert.equal(result.inserted, false);
  assert.equal(result.operationId, first.handoff_id); assert.equal(result.targetThreadId, 'successor-1');
  assert.match(result.stopReason, /引き継ぎ済み/);
  assert.match(result.stopReason, /codex:\/\/threads\/successor-1/);
  assert.ok(result.stopReason.includes('｜ベルチーム（自動引き継ぎ）」'));
  assert.equal(seen.launched, 0); assert.deepEqual(seen.opened, ['successor-1']);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM codex_handoffs').get().n, 1);
  assert.equal(seen.asked[0].threadId, 'successor-1'); assert.equal(seen.asked[0].codexHome, join(home, 'codex'));
  assert.equal(seen.recorded.length, 1);
  assert.deepEqual({ ...seen.recorded[0], at: null }, { at: null, source_thread_id: thread,
    source_turn_id: payload.turn_id, handoff_id: first.handoff_id, target_thread_id: 'successor-1', opened: true });

  // 後継がさらに引き継いでいれば、その先を示す。開けなくても止めて、止めた理由に後継を書く。
  delivered(db, home, 'successor-1', 'turn-b', 'successor-2', 2);
  const chained = await requestCodexAutoHandoff({ ...args, openThread: () => false });
  assert.equal(chained.targetThreadId, 'successor-2'); assert.equal(chained.opened, false);
  assert.match(chained.stopReason, /codex:\/\/threads\/successor-2/);
  assert.equal(seen.launched, 0);
}));

test('後継が残っていない旧タスクと、配送の前に失敗した旧タスクからは、新しい後継を立てる', async () => withDb(async (db, home) => {
  const thread = '11111111-1111-1111-1111-111111111111';
  const config = { enabled: true, projects: [home], openHost: 'desktop' };
  let launched = 0;
  const base = { db, config, launchWorker: async () => { launched++; },
    openThread: () => { throw new Error('開かない'); }, recordRedirect: () => { throw new Error('記録しない'); } };
  // 作成の途中で失敗した引き継ぎ（後継はあるが、継続の指示は送っていない）。
  const failed = requestAutoHandoff(db, { threadId: thread, turnId: 'turn-a', projectPath: home,
    rolloutPath: '/codex/rollout.jsonl', codexHome: join(home, 'codex'), openHost: 'desktop', now: 1 }).operation;
  updateAutoHandoff(db, failed.handoff_id, { target_thread_id: 'never-started', state: 'failed', error_code: 'handoff_target_not_loaded' });
  const afterFailure = await requestCodexAutoHandoff({ ...base, findThread: () => ({ mtimeMs: 1 }),
    payload: desktopSource(home, thread, '33333333-3333-3333-3333-333333333333') });
  assert.equal(afterFailure.inserted, true); assert.equal(afterFailure.redirected, undefined); assert.equal(launched, 1);
  // 継続の指示は届いたが、後継のrolloutが無い（消した、アーカイブした）。
  updateAutoHandoff(db, afterFailure.operationId, { target_thread_id: 'removed', state: 'continued', queued_submission_id: 'receipt' });
  const afterRemoval = await requestCodexAutoHandoff({ ...base, findThread: () => null,
    payload: desktopSource(home, thread, '44444444-4444-4444-4444-444444444444') });
  assert.equal(afterRemoval.inserted, true); assert.equal(launched, 2);
  // 同じturnのhookがもう一度来た時は、今までどおり同じ引き継ぎを返す。
  const again = await requestCodexAutoHandoff({ ...base, findThread: () => ({ mtimeMs: 1 }),
    payload: desktopSource(home, thread, '44444444-4444-4444-4444-444444444444') });
  assert.equal(again.operationId, afterRemoval.operationId); assert.equal(again.inserted, false); assert.equal(launched, 2);
}));

test('同じ旧タスクから複数の後継が立っていた記録では、最後に動いた後継を選ぶ', async () => withDb(async (db, home) => {
  delivered(db, home, 'old', 'turn-1', 'first', 1);
  const active = delivered(db, home, 'old', 'turn-2', 'second', 2);
  delivered(db, home, 'old', 'turn-3', 'third', 3);
  // 配送結果が不明のまま止まった引き継ぎも、指示が届いたかもしれないので数える。
  const unknown = requestAutoHandoff(db, { threadId: 'other', turnId: 'turn', projectPath: home,
    rolloutPath: '/codex/rollout.jsonl', codexHome: join(home, 'codex'), openHost: 'desktop', now: 4 }).operation;
  updateAutoHandoff(db, unknown.handoff_id, { target_thread_id: 'maybe', state: 'unknown', mutation_stage: 'submit' });
  const mtimes = { first: 10, second: 30, third: 20, maybe: 1 };
  const findThread = ({ threadId }) => ({ mtimeMs: mtimes[threadId] });
  assert.equal(findLiveAutoHandoffSuccessor(db, 'old', { findThread }).handoff_id, active.handoff_id);
  assert.equal(findLiveAutoHandoffSuccessor(db, 'old', { findThread, exceptHandoffId: active.handoff_id }).target_thread_id, 'third');
  assert.equal(findLiveAutoHandoffSuccessor(db, 'other', { findThread }).target_thread_id, 'maybe');
  assert.equal(findLiveAutoHandoffSuccessor(db, 'second', { findThread }), null);
}));

test('workerは、同じ旧タスクの別の引き継ぎが先に指示を送っていたら配送しない', async () => withDb(async db => {
  const counters = { created: 0, notified: 0, submitted: 0 };
  const submit = async () => { counters.submitted++; return { queued_submission_id: `receipt-${counters.submitted}` }; };
  const liveSuccessor = (database, threadId, options) =>
    findLiveAutoHandoffSuccessor(database, threadId, { ...options, findThread: () => ({ mtimeMs: 1 }) });
  const first = request(db, 'shared-source', { now: 1 }).operation;
  const firstResult = await runAutoHandoffWorker(first.handoff_id,
    { db, dependencies: { ...workerDependencies(db, {}, submit, counters), liveSuccessor } });
  assert.equal(firstResult.state, 'continued');
  const second = request(db, 'shared-source', { turnId: 'turn-2', now: 2 }).operation;
  const deps = workerDependencies(db, {}, submit, counters);
  const result = await runAutoHandoffWorker(second.handoff_id, { db, dependencies: { ...deps, liveSuccessor,
    readSource: () => ({ ...deps.readSource(), latestTurnId: 'turn-2' }),
    capture: () => ({ status: 'captured' }),
    createTarget: async (database, operation) => {
      updateAutoHandoff(database, operation.handoff_id, { target_thread_id: 'second-target', mutation_stage: null,
        runtime_json: { ...operation.runtime, targetPrepared: true, targetMemoryInjected: true,
          preparedSettings: deps.readTarget(operation).settings } });
    } } });
  assert.equal(result.state, 'failed'); assert.equal(result.error_code, 'handoff_source_already_continued');
  assert.equal(result.mutation_stage, null); assert.equal(result.queued_submission_id, null);
  assert.equal(counters.submitted, 1); assert.equal(counters.notified, 1);
}));

test('公開CLIはactionに適合する引数だけを受け取る', () => {
  assert.equal(parseAutoHandoffArgs(['status', '--json']).action, 'status');
  for (const args of [['enable', '--operation', 'id'], ['disable', '--project', '/p'], ['status', '--json', '--json'],
    ['status', '--project', '/p', '--operation', 'id'], ['detail', '--operation', 'id', '--origin', 'A', '--turn', '0']]) {
    assert.throws(() => parseAutoHandoffArgs(args));
  }
});

test('初回のstatusはDBを作成せず無効状態を表示する', () => {
  const home = mkdtempSync(join(tmpdir(), 'tl-auto-status-'));
  try {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('../bin/throughline.mjs', import.meta.url)),
      'auto-handoff', 'status', '--json'], { encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home } });
    assert.equal(result.status, 0, result.stderr);
    const status = JSON.parse(result.stdout);
    assert.equal(status.config.enabled, false); assert.equal(status.databaseStatus, 'not_applicable');
    assert.deepEqual(status.operations, []); assert.equal(existsSync(join(home, '.throughline', 'throughline.db')), false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('native commandの受付と完了を区別し、保存済みの実行中sessionを追跡する', async () => withDb((db, home) => {
  const file = join(home, 'native-rollout.jsonl');
  const rows = [
    { type: 'session_meta', payload: { id: 'thread', cwd: '/project' } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn' } },
    { type: 'function_call', name: 'exec_command', call_id: 'launch', arguments: '{"cmd":"試験"}' },
    { type: 'function_call_output', call_id: 'launch', output: JSON.stringify({ output: '処理中', wall_time_seconds: 1, session_id: 5 }) },
  ].map(row => row.type === 'function_call' || row.type === 'function_call_output' ? { type: 'response_item', payload: row } : row);
  const write = () => writeFileSync(file, rows.map(row => JSON.stringify({ timestamp: '2026-10-03T00:00:01.000Z', ...row })).join('\n') + '\n');
  write();
  assert.equal(readCodexHandoffState(file, { threadId: 'thread', turnId: 'turn' }).pendingNativeSessionCount, 1);
  rows.push({ type: 'response_item', payload: { type: 'function_call', name: 'write_stdin', call_id: 'poll', arguments: '{"session_id":5}' } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'poll', output: JSON.stringify({ output: '完了', wall_time_seconds: 2, exit_code: 0 }) } });
  write();
  assert.equal(readCodexHandoffState(file, { threadId: 'thread', turnId: 'turn' }).pendingNativeSessionCount, 0);
}));

test('元turnの停止だけを採用し、配送本文と開始・進捗を相関させる', async () => withDb((db, home) => {
  const file = join(home, 'rollout.jsonl');
  const native = { model: 'model', cwd: '/project', model_provider_id: 'openai',
    approval_policy: 'never', permission_profile: { type: 'disabled' }, reasoning_effort: 'high' };
  const rows = [
    { type: 'session_meta', payload: { id: 'thread', originator: 'Codex Desktop', cwd: '/project' } },
    { type: 'event_msg', payload: { type: 'thread_settings_applied', thread_settings: native } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'wanted' } },
    { type: 'event_msg', payload: { type: 'turn_aborted', turn_id: 'other' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ text: '配送本文' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ text: '作業再開' }] } },
    { type: 'event_msg', payload: { type: 'turn_aborted', turn_id: 'wanted' } },
  ];
  writeFileSync(file, rows.map(row => JSON.stringify({ timestamp: '2026-10-03T00:00:01.000Z', ...row })).join('\n') + '\n');
  const state = readCodexHandoffState(file, { threadId: 'thread', turnId: 'wanted', deliveryText: '配送本文' });
  assert.equal(state.stoppedAt, Date.parse('2026-10-03T00:00:01.000Z'));
  assert.equal(state.correlatedTurnId, 'wanted'); assert.equal(state.progress, true);
  assert.equal(threadStartSettings(state.settings).sandbox, 'danger-full-access');
  assert.equal(settingsMatch(state.settings, { ...state.settings, effort: 'low' }), false);
  assert.throws(() => readCodexHandoffState(file, { threadId: 'other' }), /handoff_thread_mismatch/);
}));

test('未指定のservice tierと"default"は同じ設定として扱い、別の枠は不一致にする', () => {
  // rabbitの実測（2026-10-08、Codex 0.162.0-alpha.2）: 旧タスクのrolloutにservice_tierは無く、
  // 後継の thread_settings_applied には service_tier:"default" が書かれた。0.160.1 までは後継にも書かれなかった。
  const source = { cwd: '/p', model: 'm', effort: 'high', approvalPolicy: 'never', serviceTier: null,
    collaborationMode: { mode: 'default', settings: { model: 'm', reasoning_effort: 'high', developer_instructions: null } } };
  const expanded = { ...source.collaborationMode, settings: { ...source.collaborationMode.settings, developer_instructions: '# Collaboration Mode: Default' } };
  const prepared = { ...source, serviceTier: 'default', collaborationMode: expanded };
  assert.equal(settingsMatch(source, { ...source, serviceTier: 'default' }), true);
  assert.equal(settingsMatch({ ...source, serviceTier: 'default' }, source), true);
  assert.equal(settingsMatch(source, { ...source, serviceTier: 'fast' }), false);
  assert.equal(settingsMatch({ ...source, serviceTier: 'fast' }, { ...source, serviceTier: 'default' }), false);
  const expected = resolvePreparedSettings(source, prepared);
  assert.deepEqual(expected.collaborationMode, expanded);
  // 表示後のrolloutが "default" でも、準備値（旧タスクの未指定を持つ）と一致する。
  assert.equal(settingsMatch(expected, prepared), true);
  assert.throws(() => resolvePreparedSettings(source, { ...prepared, serviceTier: 'fast' }), /handoff_prepared_settings_mismatch/);
});

test('forkした子の先頭metadataを保持し、継承された親metadataでIDを上書きしない', async () => withDb((db, home) => {
  const file = join(home, 'child-rollout.jsonl');
  const rows = [
    { type: 'session_meta', payload: { id: 'child', session_id: 'parent', parent_thread_id: 'parent' } },
    { type: 'session_meta', payload: { id: 'parent', session_id: 'parent' } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'parent-turn' } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'child-turn' } },
    { type: 'event_msg', payload: { type: 'turn_aborted', turn_id: 'child-turn' } },
  ];
  writeFileSync(file, rows.map(row => JSON.stringify({ timestamp: '2026-10-03T00:00:01.000Z', ...row })).join('\n') + '\n');
  const state = readCodexHandoffState(file, { threadId: 'child' });
  assert.equal(state.meta.id, 'child');
  assert.equal(state.meta.parent_thread_id, 'parent');
  assert.equal(state.latestTurnId, 'child-turn');
  assert.equal(state.stoppedAt, state.turnStartAt);
  assert.throws(() => readCodexHandoffState(file, { threadId: 'parent' }), /handoff_thread_mismatch/);
}));

test('後継タスクの名前は project 名・前任の題・自動引き継ぎの印で作り、名前の無い後継からは元のタスクの題をさかのぼる', async () => withDb(async db => {
  const named = (operation, title) => updateAutoHandoff(db, operation.handoff_id, { runtime_json: { projectId: null, title } }).operation;
  const a = named(request(db, 'A', { projectPath: '/Users/kite/Developer/BellTeam' }).operation, 'ASCからの連絡を確認');
  assert.equal(autoHandoffTargetName(db, a), 'BellTeam｜ASCからの連絡を確認（自動引き継ぎ）');

  // A の後継 B は、名前を付けない版が作った。題は継続の指示として見える
  updateAutoHandoff(db, a.handoff_id, { target_thread_id: 'B' });
  const b = named(request(db, 'B', { projectPath: '/Users/kite/Developer/BellTeam' }).operation, continuationInput(a));
  assert.equal(b.previous_handoff_id, a.handoff_id);
  assert.equal(autoHandoffTargetName(db, b), 'BellTeam｜ASCからの連絡を確認（自動引き継ぎ）');

  // B の後継 C は、この形の名前を持つ。重ねても同じ名前になる
  updateAutoHandoff(db, b.handoff_id, { target_thread_id: 'C' });
  const c = named(request(db, 'C', { projectPath: '/Users/kite/Developer/BellTeam' }).operation, autoHandoffTargetName(db, b));
  assert.equal(autoHandoffTargetName(db, c), 'BellTeam｜ASCからの連絡を確認（自動引き継ぎ）');

  // 題がどこにも無い時は project 名と印だけ
  const lone = named(request(db, 'D', { projectPath: 'C:\\Users\\kite_\\Throughline' }).operation, '');
  assert.equal(autoHandoffTargetName(db, lone), 'Throughline（自動引き継ぎ）');

  const sent = [];
  assert.equal(await nameAutoHandoffTarget(async (method, params) => { sent.push([method, params]); return {}; }, 'T', 'BellTeam（自動引き継ぎ）'), true);
  assert.deepEqual(sent, [['thread/name/set', { threadId: 'T', name: 'BellTeam（自動引き継ぎ）' }]]);
  const rejected = async () => { throw Object.assign(new Error('unknown method'), { delivery_code: 'CODEX_RECEIVER_REJECTED' }); };
  assert.equal(await nameAutoHandoffTarget(rejected, 'T', 'x'), false, '名前を付けられなくても、引き継ぎは止めない');
}));

test('引き継ぎが済んだ旧タスクの名前の頭へ印を付け、付けられなくても引き継ぎは止めない', async () => {
  const operation = { source_thread_id: 'S', codex_home: '/home' };
  const receiver = (thread, sent, fail = null) => async (profile, parent, action) => action(async (method, params) => {
    sent.push([method, params]);
    if (method === fail) throw Object.assign(new Error('rejected'), { delivery_code: 'CODEX_RECEIVER_REJECTED' });
    return method === 'thread/read' ? { thread } : {};
  });
  let sent = [];
  assert.equal(await markAutoHandoffSource(operation, {}, { connect: receiver({ name: 'ベルチーム' }, sent) }), 'marked');
  assert.deepEqual(sent, [['thread/read', { threadId: 'S', includeTurns: false }],
    ['thread/name/set', { threadId: 'S', name: '【引き継ぎ済み】ベルチーム' }]]);

  // 後継がさらに引き継いだ時は、後継の名前をそのまま残して印だけ足す
  sent = [];
  await markAutoHandoffSource(operation, {}, { connect: receiver({ name: 'BellTeam｜ベルチーム（自動引き継ぎ）' }, sent) });
  assert.equal(sent[1][1].name, '【引き継ぎ済み】BellTeam｜ベルチーム（自動引き継ぎ）');

  // 名前の無いタスクは、最初の依頼の1行目を使う
  sent = [];
  await markAutoHandoffSource(operation, {}, { connect: receiver({ name: null, preview: 'ASCの状況を確認して\n2行目' }, sent) });
  assert.equal(sent[1][1].name, '【引き継ぎ済み】ASCの状況を確認して');

  // もう印がある・名前にできる値が無い時は、付け直さない
  for (const thread of [{ name: '【引き継ぎ済み】ベルチーム' }, { name: null, preview: '' },
    { name: null, preview: 'Throughline自動継続 39cdb98e-9e68-4dff-8a53-38d1fd861a8b' }]) {
    sent = [];
    assert.equal(await markAutoHandoffSource(operation, {}, { connect: receiver(thread, sent) }), 'kept');
    assert.equal(sent.length, 1, '名前は書かない');
  }

  assert.equal(await markAutoHandoffSource(operation, {}, { connect: receiver({ name: 'x' }, [], 'thread/name/set') }), 'failed');
  assert.equal(await markAutoHandoffSource(operation, {}, { connect: receiver({ name: 'x' }, [], 'thread/read') }), 'failed');
});

test('印を付けた旧タスクから作る後継の名前には、印を持ち込まない', async () => withDb(async db => {
  const operation = updateAutoHandoff(db, request(db, 'A', { projectPath: '/Users/kite/Developer/BellTeam' }).operation.handoff_id,
    { runtime_json: { projectId: null, title: '【引き継ぎ済み】BellTeam｜ベルチーム（自動引き継ぎ）' } }).operation;
  assert.equal(autoHandoffTargetName(db, operation), 'BellTeam｜ベルチーム（自動引き継ぎ）');
}));

test('今までの引き継ぎへまとめて名前を付け直す。名前の無い後継へ名前を付け、生きている後継がある旧タスクへ印を付ける', async () => withDb(async db => {
  const done = (source, target, fields = {}) => updateAutoHandoff(db, request(db, source, { projectPath: '/Users/kite/Developer/BellTeam' }).operation.handoff_id,
    { state: 'continued', target_thread_id: target, queued_submission_id: `receipt-${target}`, ...fields }).operation;
  // A（利用者の題）→ B（名前を付けない版が作った。継続の指示が題に見える）→ C（同じ）。X の後継は消えた。Y は旧タスクがアーカイブ済み。
  const ab = done('A', 'B'); const bc = done('B', 'C');
  done('X', 'gone'); done('Y', 'Y2');
  updateAutoHandoff(db, request(db, 'F').operation.handoff_id, { state: 'failed', target_thread_id: 'F2', error_code: 'handoff_target_not_loaded' });
  const threads = new Map([
    ['A', { name: 'ベルチームの改良', preview: '最初の依頼' }],
    ['B', { name: null, preview: continuationInput(ab) }],
    ['C', { name: null, preview: continuationInput(bc) }],
    ['X', { name: 'Xの題', preview: 'x' }],
    ['Y', { name: 'Yの題', preview: 'y' }], ['Y2', { name: '利用者が付けた名前', preview: 'y2' }],
  ]);
  const calls = [];
  const connect = async (profile, parent, action) => action(async (method, params) => {
    if (method === 'thread/list') { assert.equal(params.archived, true); return { data: [{ id: 'Y' }], nextCursor: null }; }
    if (method === 'thread/read') {
      if (!threads.has(params.threadId)) throw Object.assign(new Error('no rollout'), { delivery_code: 'CODEX_RECEIVER_REJECTED' });
      return { thread: { id: params.threadId, ...threads.get(params.threadId) } };
    }
    assert.equal(method, 'thread/name/set');
    assert.notEqual(params.threadId, 'Y', 'アーカイブ済みのタスクは触らない');
    calls.push(`${params.threadId}=${params.name}`);
    threads.set(params.threadId, { ...threads.get(params.threadId), name: params.name });
    return {};
  });
  const options = { executable: 'fixture', connect,
    findThread: ({ threadId }) => threadId === 'gone' ? null : { rolloutPath: `/r/${threadId}`, mtimeMs: 1 } };
  // dryRun は名前を書かず、付ける名前だけを返す
  const preview = await markAutoHandoffSources(db, { ...options, dryRun: true });
  assert.deepEqual(calls, []);
  assert.deepEqual(preview.changes.map(change => `${change.thread_id}=${change.name}`), [
    'B=BellTeam｜ベルチームの改良（自動引き継ぎ）', 'A=【引き継ぎ済み】ベルチームの改良',
    'C=BellTeam｜ベルチームの改良（自動引き継ぎ）', 'B=【引き継ぎ済み】BellTeam｜ベルチームの改良（自動引き継ぎ）']);
  const { changes, ...result } = await markAutoHandoffSources(db, options);
  assert.equal(changes.length, 4);
  assert.deepEqual(calls, [
    'B=BellTeam｜ベルチームの改良（自動引き継ぎ）', 'A=【引き継ぎ済み】ベルチームの改良',
    'C=BellTeam｜ベルチームの改良（自動引き継ぎ）', 'B=【引き継ぎ済み】BellTeam｜ベルチームの改良（自動引き継ぎ）']);
  // X は後継が消えているので付けない。Y はアーカイブ済みなので付けない。
  assert.deepEqual(result, { marked: 2, named: 2, kept: 0, failed: 0, skipped: 2 });
  assert.equal(threads.get('C').name, 'BellTeam｜ベルチームの改良（自動引き継ぎ）', '印の無い1本が今の続き');
  assert.equal(threads.get('Y2').name, '利用者が付けた名前');

  // もう一度流しても、何も付け直さない
  calls.length = 0;
  assert.deepEqual(await markAutoHandoffSources(db, options), { marked: 0, named: 0, kept: 2, failed: 0, skipped: 2, changes: [] });
  assert.deepEqual(calls, []);
}));

test('名前の無い旧タスク（名前を付けない版が作った後継）がさらに引き継いだ時は、作り直した後継の名前へ印を付ける', async () => withDb(async db => {
  const first = updateAutoHandoff(db, request(db, 'A', { projectPath: '/Users/kite/Developer/BellTeam' }).operation.handoff_id,
    { state: 'continued', target_thread_id: 'B', queued_submission_id: 'receipt-B', runtime_json: { projectId: null, title: 'ベルチームの改良' } }).operation;
  const second = request(db, 'B', { projectPath: '/Users/kite/Developer/BellTeam' }).operation;
  assert.equal(autoHandoffSourceFallbackTitle(db, first), null, '最初の旧タスクは、どの引き継ぎの後継でもない');
  const fallbackTitle = autoHandoffSourceFallbackTitle(db, second);
  assert.equal(fallbackTitle, 'BellTeam｜ベルチームの改良（自動引き継ぎ）');
  const sent = [];
  const connect = async (profile, parent, action) => action(async (method, params) => {
    sent.push([method, params]);
    return method === 'thread/read' ? { thread: { name: null, preview: continuationInput(first) } } : {};
  });
  assert.equal(await markAutoHandoffSource(second, {}, { connect, fallbackTitle }), 'marked');
  assert.deepEqual(sent.at(-1), ['thread/name/set', { threadId: 'B', name: '【引き継ぎ済み】BellTeam｜ベルチームの改良（自動引き継ぎ）' }]);
}));

test('旧タスクの順番待ちに残った入力を、順番を保って後継へ運び、旧タスクから消す', async () => withDb(async db => {
  const operation = updateAutoHandoff(db, request(db, 'S').operation.handoff_id, { state: 'continued', target_thread_id: 'T' }).operation;
  const queues = { S: [{ id: 'q1', input: [{ type: 'text', text: '1つ目' }], clientUserMessageId: 'c1' },
    { id: 'q2', input: [{ type: 'text', text: '2つ目' }], clientUserMessageId: 'c2' }], T: [{ id: 't0', input: [], clientUserMessageId: 'continuation' }] };
  const calls = [];
  const receiver = (fail = () => null) => async (profile, parent, action) => action(async (method, params) => {
    calls.push(`${method}:${params.threadId}:${params.queuedSubmissionId ?? params.clientUserMessageId ?? ''}`);
    const failure = fail(method, params);
    if (failure) throw failure;
    if (method === 'thread/queue/list') return { data: queues[params.threadId], nextCursor: null };
    if (method === 'thread/queue/add') { queues[params.threadId].push({ id: `t-${params.clientUserMessageId}`, input: params.input, clientUserMessageId: params.clientUserMessageId }); return { queuedSubmission: {} }; }
    if (method === 'thread/queue/delete') { queues[params.threadId] = queues[params.threadId].filter(item => item.id !== params.queuedSubmissionId); return {}; }
    throw Error(method);
  });
  assert.deepEqual(await carryAutoHandoffQueue(db, operation, {}, { connect: receiver() }), { moved: 2, unknown: 0, left: 0 });
  assert.deepEqual(calls, ['thread/queue/list:S:', 'thread/queue/add:T:c1', 'thread/queue/delete:S:q1', 'thread/queue/add:T:c2', 'thread/queue/delete:S:q2']);
  assert.deepEqual(queues.T.map(item => item.clientUserMessageId), ['continuation', 'c1', 'c2'], '継続の指示の後ろへ、元の順番で並ぶ');
  assert.deepEqual(queues.S, []);
  assert.deepEqual(getAutoHandoff(db, operation.handoff_id).runtime.queueCarry, { moved: ['q1', 'q2'], unknown: [], moving: null });
  assert.equal(getAutoHandoff(db, operation.handoff_id).state, 'continued');

  // もう一度呼んでも、運んだ入力を入れ直さない
  calls.length = 0;
  assert.deepEqual(await carryAutoHandoffQueue(db, operation, {}, { connect: receiver() }), { moved: 2, unknown: 0, left: 0 });
  assert.deepEqual(calls, ['thread/queue/list:S:']);
}));

test('後継へ入れた結果が分からない入力は入れ直さず、断られた入力は旧タスクに残す。どちらも引き継ぎは止めない', async () => withDb(async db => {
  const make = name => updateAutoHandoff(db, request(db, name).operation.handoff_id, { state: 'continued', target_thread_id: `${name}-T` }).operation;
  const queue = () => [{ id: 'q1', input: [], clientUserMessageId: 'c1' }, { id: 'q2', input: [], clientUserMessageId: 'c2' }];
  const receiver = (items, added, fail) => async (profile, parent, action) => action(async (method, params) => {
    if (method === 'thread/queue/list') return { data: items, nextCursor: null };
    if (method === 'thread/queue/add') { const failure = fail(params); if (failure) throw failure; added.push(params.clientUserMessageId); return {}; }
    if (method === 'thread/queue/delete') { items.splice(items.findIndex(item => item.id === params.queuedSubmissionId), 1); return {}; }
    throw Error(method);
  });
  // 応答が途中で切れた（入ったかどうかが分からない）。そこで止め、次に呼ばれても入れ直さない
  const lost = make('lost'); let items = queue(); let added = [];
  const timeout = () => Object.assign(new Error('timeout'), { delivery_code: 'CODEX_RECEIVER_TIMEOUT' });
  assert.deepEqual(await carryAutoHandoffQueue(db, lost, {}, { connect: receiver(items, added, params => params.clientUserMessageId === 'c1' ? timeout() : null) }),
    { moved: 0, unknown: 1, left: 0 });
  assert.deepEqual(await carryAutoHandoffQueue(db, lost, {}, { connect: receiver(items, added, () => null) }), { moved: 1, unknown: 1, left: 0 });
  assert.deepEqual(added, ['c2']); assert.deepEqual(items.map(item => item.id), ['q1'], '結果不明の入力は旧タスクに残る');
  assert.equal(getAutoHandoff(db, lost.handoff_id).state, 'continued');

  // 前の worker が、入れる途中で終わっていた
  const crashed = make('crashed'); items = queue(); added = [];
  updateAutoHandoff(db, crashed.handoff_id, { runtime_json: { ...(crashed.runtime ?? {}), queueCarry: { moved: [], unknown: [], moving: 'q1' } } });
  assert.deepEqual(await carryAutoHandoffQueue(db, crashed, {}, { connect: receiver(items, added, () => null) }), { moved: 1, unknown: 1, left: 0 });
  assert.deepEqual(added, ['c2']);

  // はっきり断られた入力は後継に入っていない。旧タスクに残し、次の入力は運ぶ
  const rejected = make('rejected'); items = queue(); added = [];
  const reject = () => Object.assign(new Error('rejected'), { delivery_code: 'CODEX_RECEIVER_REJECTED' });
  assert.deepEqual(await carryAutoHandoffQueue(db, rejected, {}, { connect: receiver(items, added, params => params.clientUserMessageId === 'c1' ? reject() : null) }),
    { moved: 1, unknown: 0, left: 1 });
  assert.deepEqual(added, ['c2']); assert.deepEqual(items.map(item => item.id), ['q1']);
}));

// 元turn（止めた）の後に、旧タスクへ来た入力のturnが続くrollout。laterは後続turnの行。
function sourceRollout(home, thread, turn, later = [], stoppedAt = '2026-10-07T00:49:01.000Z') {
  const dir = join(home, 'codex', 'sessions'); mkdirSync(dir, { recursive: true });
  const file = join(dir, `rollout-${thread}.jsonl`);
  const rows = [
    { timestamp: '2026-10-07T00:47:00.000Z', type: 'session_meta', payload: { id: thread, originator: 'Codex Desktop', source: 'vscode', cwd: home } },
    { timestamp: '2026-10-07T00:47:08.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: turn } },
    { timestamp: '2026-10-07T00:47:09.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ text: '進めて' }] } },
    { timestamp: '2026-10-07T00:47:15.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ text: '進めるね' }] } },
    { timestamp: stoppedAt, type: 'event_msg', payload: { type: 'turn_aborted', turn_id: turn, reason: 'interrupted' } },
    ...later,
  ];
  writeFileSync(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  return file;
}

// hookが止めたturnの、Codex Desktop 0.160.1 の実物の並び（入力を受けて、1秒ほどで止まる）。
function stoppedInput(turn, at, { closed = true } = {}) {
  return [
    { timestamp: `${at}.071Z`, type: 'event_msg', payload: { type: 'thread_settings_applied', thread_settings: {
      model: 'model', cwd: '/project', model_provider_id: 'openai', approval_policy: 'never', permission_profile: { type: 'disabled' } } } },
    { timestamp: `${at}.078Z`, type: 'event_msg', payload: { type: 'task_started', turn_id: turn } },
    { timestamp: `${at}.206Z`, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ text: '動いてる？' }] } },
    { timestamp: `${at}.207Z`, type: 'event_msg', payload: { type: 'item_completed', turn_id: turn, item: { type: 'UserMessage' } } },
    ...(closed ? [{ timestamp: `${at}.213Z`, type: 'event_msg', payload: { type: 'turn_aborted', turn_id: turn, reason: 'interrupted' } }] : []),
  ];
}

test('入力を受けただけで止まった後続turnは元turnの境界を進めず、動きのある後続turnは進んだと判定する', async () => withDb((db, home) => {
  const thread = '11111111-1111-1111-1111-111111111111', turn = '22222222-2222-2222-2222-222222222222';
  const operation = { source_thread_id: thread, source_turn_id: turn, created_at: Date.parse('2026-10-07T00:49:00.000Z') };
  const read = later => readCodexHandoffState(sourceRollout(home, thread, turn, later), { threadId: thread, turnId: turn });
  assert.deepEqual(read([]).laterTurns, []);
  assert.equal(sourceBoundary(operation, read([])), true);
  // 止まった入力が2つ続いても、元turnの境界のまま。
  const two = read([...stoppedInput('turn-b', '2026-10-07T00:56:48'), ...stoppedInput('turn-c', '2026-10-07T00:56:58')]);
  assert.deepEqual(two.laterTurns, [{ turnId: 'turn-b', closed: true, activity: false }, { turnId: 'turn-c', closed: true, activity: false }]);
  assert.equal(two.latestTurnId, 'turn-c'); assert.equal(two.stoppedAt, Date.parse('2026-10-07T00:49:01.000Z'));
  assert.equal(sourceBoundary(operation, two), true);
  // まだ止まり切っていない入力は、止まるまで待つ（境界は未確認）。
  assert.equal(sourceBoundary(operation, read(stoppedInput('turn-b', '2026-10-07T00:56:48', { closed: false }))), false);
  // モデルの発言・道具の呼び出し・完了・圧縮があれば、旧タスクは進んでいる。
  const activity = [
    { timestamp: '2026-10-07T00:56:50.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ text: '動いてるよ' }] } },
    { timestamp: '2026-10-07T00:56:50.000Z', type: 'response_item', payload: { type: 'function_call', call_id: 'c1', name: 'exec_command', arguments: '{}' } },
    { timestamp: '2026-10-07T00:56:50.000Z', type: 'response_item', payload: { type: 'reasoning' } },
    { timestamp: '2026-10-07T00:56:50.000Z', type: 'event_msg', payload: { type: 'agent_message', message: '動いてるよ' } },
    { timestamp: '2026-10-07T00:56:50.000Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-b' } },
    { timestamp: '2026-10-07T00:56:50.000Z', type: 'compacted', payload: {} },
  ];
  for (const row of activity) {
    const state = read([...stoppedInput('turn-b', '2026-10-07T00:56:48', { closed: false }), row]);
    assert.equal(state.laterTurns[0].activity, true, JSON.stringify(row.payload));
    assert.throws(() => sourceBoundary(operation, state), /handoff_source_advanced/);
  }
  // 元turnの開始が見えないrolloutで最新turnが違う時は、今までどおり進んだと判定する。
  assert.throws(() => sourceBoundary(operation, { latestTurnId: 'other', stoppedAt: Date.now(), pendingCallCount: 0 }), /handoff_source_advanced/);
}));

test('引き継ぎの最中に旧タスクへ入力が来ても、別の引き継ぎを作らず、進んでいる引き継ぎを返して止める', async () => withDb(async (db, home) => {
  const thread = '11111111-1111-1111-1111-111111111111', turnA = '22222222-2222-2222-2222-222222222222';
  const turnB = '33333333-3333-3333-3333-333333333333', turnC = '44444444-4444-4444-4444-444444444444';
  const config = { enabled: true, projects: [home], openHost: 'desktop' };
  const seen = { launched: [], recorded: [], opened: 0 };
  const worker = { pid: 4242, started_identity: 'worker-born' };
  const base = { db, config, launchWorker: async (id, options) => { seen.launched.push([id, options?.resume ?? false]); },
    findThread: () => null, openThread: () => { seen.opened++; return true; }, recordRedirect: entry => { seen.recorded.push(entry); },
    processes: () => [worker], readTarget: () => null };
  const first = await requestCodexAutoHandoff({ ...base, payload: desktopSource(home, thread, turnA) });
  assert.equal(first.inserted, true); assert.equal(seen.launched.length, 1);
  const count = () => db.prepare('SELECT COUNT(*) AS n FROM codex_handoffs').get().n;

  // workerが名乗る前（起動した直後）に来た入力。
  const early = await requestCodexAutoHandoff({ ...base, payload: desktopSource(home, thread, turnB) });
  assert.equal(early.inFlight, true); assert.equal(early.inserted, false); assert.equal(early.continue, false);
  assert.equal(early.operationId, first.operationId); assert.match(early.stopReason, /引き継いでいる最中/);
  assert.equal(count(), 1); assert.equal(seen.launched.length, 1);

  // workerが後継を作った後（継続の指示を送る前）に来た入力。時間が経っていても、workerが動いていれば最中。
  updateAutoHandoff(db, first.operationId, { state: 'memory_ready', target_thread_id: 'target-1', worker_identity_json: worker });
  const later = await requestCodexAutoHandoff({ ...base, now: Date.now() + 3_600_000, payload: desktopSource(home, thread, turnC) });
  assert.equal(later.inFlight, true); assert.equal(later.operationId, first.operationId);
  assert.equal(count(), 1); assert.equal(seen.launched.length, 1); assert.equal(seen.opened, 0);
  assert.deepEqual(seen.recorded.map(entry => [entry.kind, entry.source_turn_id, entry.handoff_id, entry.target_thread_id, entry.opened]),
    [['in_flight', turnB, first.operationId, null, false], ['in_flight', turnC, first.operationId, 'target-1', false]]);

  // 同じturnのhookがもう一度来た時は、今までどおり同じ引き継ぎを返す（最中の扱いにしない）。
  const again = await requestCodexAutoHandoff({ ...base, payload: desktopSource(home, thread, turnA) });
  assert.equal(again.operationId, first.operationId); assert.equal(again.inFlight, undefined); assert.equal(again.inserted, false);

  // process一覧を読めない時は、記録が新しい間だけ最中として扱う（後継を2つにしない側へ倒す）。
  const unreadable = () => { throw new Error('process一覧を読めません'); };
  assert.equal((await requestCodexAutoHandoff({ ...base, processes: unreadable, payload: desktopSource(home, thread, turnC) })).inFlight, true);
  assert.equal(count(), 1);

  // workerが居なくなり、後継も残っていない引き継ぎは、最中に数えない。今までどおり新しい引き継ぎを作る。
  const dead = await requestCodexAutoHandoff({ ...base, processes: () => [], payload: desktopSource(home, thread, turnC) });
  assert.equal(dead.inserted, true); assert.notEqual(dead.operationId, first.operationId); assert.equal(count(), 2);
}));

test('後継が出来たまま止まった引き継ぎは、次の入力で同じ引き継ぎをやり直し、別の後継を作らない', async () => withDb(async (db, home) => {
  const thread = '11111111-1111-1111-1111-111111111111', turnA = '22222222-2222-2222-2222-222222222222';
  const turnB = '33333333-3333-3333-3333-333333333333';
  const config = { enabled: true, projects: [home], openHost: 'desktop' };
  const seen = { launched: [], recorded: [] };
  const base = { db, config, launchWorker: async (id, options) => { seen.launched.push([id, options?.resume ?? false]); },
    findThread: () => null, openThread: () => { throw new Error('開かない'); }, recordRedirect: entry => { seen.recorded.push(entry); },
    processes: () => [] };
  const count = () => db.prepare('SELECT COUNT(*) AS n FROM codex_handoffs').get().n;
  const fail = (turn, fields) => {
    const rollout = sourceRollout(home, thread, turn);
    const operation = requestAutoHandoff(db, { threadId: thread, turnId: turn, projectPath: home, rolloutPath: rollout,
      codexHome: join(home, 'codex'), openHost: 'desktop', now: 1 }).operation;
    return updateAutoHandoff(db, operation.handoff_id, { target_thread_id: 'target-1', state: 'failed',
      resume_state: 'memory_ready', error_code: 'handoff_target_not_loaded', ...fields }).operation;
  };
  const input = (turn, later) => {
    const file = sourceRollout(home, thread, turnA, later);
    return { trigger: 'auto', cwd: home, session_id: thread, turn_id: turn, transcript_path: file };
  };
  const failed = fail(turnA, {});
  const open = stoppedInput(turnB, '2026-10-07T00:56:48', { closed: false });

  // 後継が残っていて、まだ誰も使っておらず、旧タスクに動きが無い。同じ引き継ぎを再開する。
  const resumed = await requestCodexAutoHandoff({ ...base, readTarget: () => ({ latestTurnId: null }), payload: input(turnB, open) });
  assert.equal(resumed.resumed, true); assert.equal(resumed.inserted, false); assert.equal(resumed.continue, false);
  assert.equal(resumed.operationId, failed.handoff_id); assert.match(resumed.stopReason, /やり直します/);
  assert.deepEqual(seen.launched, [[failed.handoff_id, true]]); assert.equal(count(), 1);
  assert.deepEqual(seen.recorded.map(entry => [entry.kind, entry.handoff_id, entry.target_thread_id]), [['retry', failed.handoff_id, 'target-1']]);

  // 後継を利用者がもう使っている・後継が消えている・結果不明・旧タスクが進んでいる時は、今までどおり新しい引き継ぎを作る。
  const fresh = async (fields, readTarget, later = open) => {
    db.prepare('DELETE FROM codex_handoffs').run(); seen.launched.length = 0;
    const row = fail(turnA, fields);
    const result = await requestCodexAutoHandoff({ ...base, readTarget, payload: input(turnB, later) });
    assert.equal(result.inserted, true); assert.notEqual(result.operationId, row.handoff_id);
    assert.deepEqual(seen.launched, [[result.operationId, false]]); assert.equal(count(), 2);
  };
  await fresh({}, () => ({ latestTurnId: 'used-by-user' }));
  await fresh({}, () => null);
  await fresh({ state: 'unknown', mutation_stage: 'inject' }, () => ({ latestTurnId: null }));
  await fresh({ target_thread_id: null }, () => ({ latestTurnId: null }));
  await fresh({}, () => ({ latestTurnId: null }), [
    ...stoppedInput('turn-x', '2026-10-07T00:55:00', { closed: false }),
    { timestamp: '2026-10-07T00:55:02.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ text: '続けたよ' }] } },
    { timestamp: '2026-10-07T00:55:03.000Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-x' } },
    ...open,
  ]);
}));

test('workerは、最中に来て止まった入力では失敗せず、旧タスクが進んだ時だけ止まる', async () => withDb(async db => {
  const run = async (source, laterTurns) => {
    const operation = request(db, source, { now: 1 }).operation;
    const counters = { created: 0, submitted: 0, notified: 0 };
    const deps = workerDependencies(db, {}, async () => { counters.submitted++; return { queued_submission_id: 'receipt' }; }, counters);
    const read = deps.readSource;
    deps.readSource = item => ({ ...read(item), latestTurnId: 'input-during-handoff', laterTurns });
    return { result: await runAutoHandoffWorker(operation.handoff_id, { db, dependencies: deps }), counters };
  };
  const stopped = await run('stopped-input', [{ turnId: 'input-during-handoff', closed: true, activity: false }]);
  assert.equal(stopped.result.state, 'continued'); assert.equal(stopped.counters.submitted, 1); assert.equal(stopped.counters.notified, 0);
  const advanced = await run('advanced', [{ turnId: 'input-during-handoff', closed: true, activity: true }]);
  assert.equal(advanced.result.state, 'failed'); assert.equal(advanced.result.error_code, 'handoff_source_advanced');
  assert.equal(advanced.counters.created, 0); assert.equal(advanced.counters.submitted, 0);
}));

test('引き継ぎの最中に旧タスクへ来た入力は、凍結する記憶へ入れない', async () => withDb(db => {
  const operation = request(db, 'frozen-source', { now: 1 }).operation;
  const session = operation.source_session_id;
  db.prepare('INSERT INTO sessions (session_id,project_path,created_at,updated_at) VALUES (?, ?, 1, 1)').run(session, '/project');
  const body = db.prepare('INSERT INTO bodies (session_id,origin_session_id,turn_number,role,text,created_at) VALUES (?, ?, ?, ?, ?, ?)');
  body.run(session, session, 1, 'user', '進めて', 100); body.run(session, session, 1, 'assistant', '途中まで進めた', 100);
  body.run(session, session, 2, 'user', '動いてる？', 300); body.run(session, session, 3, 'user', 'ん？', 310);
  db.prepare('INSERT INTO details (session_id,origin_session_id,turn_number,tool_name,kind,output_text,created_at) VALUES (?, ?, 1, ?, ?, ?, ?)')
    .run(session, session, 'exec_command', 'tool_output', '結果', 999);
  const later = [{ turnId: 'b', closed: true, activity: false }, { turnId: 'c', closed: true, activity: false }];
  const frozen = freezeCodexMemory(db, operation, {}, { stoppedAt: 200, laterTurns: later });
  assert.deepEqual(frozen.bodies.map(row => row.text), ['進めて', '途中まで進めた']);
  assert.equal(frozen.sourceTurnNumber, 1); assert.equal(frozen.details.length, 1);
  // 後続turnが無い時と、止める前からあった発言は、今までどおり全部入れる。
  assert.equal(freezeCodexMemory(db, operation, {}, { stoppedAt: 200 }).bodies.length, 4);
  assert.equal(freezeCodexMemory(db, operation, {}, { stoppedAt: 305, laterTurns: later }).bodies.length, 3);
  assert.equal(freezeCodexMemory(db, operation, {}, { stoppedAt: 200, laterTurns: [later[0]] }).bodies.length, 3);
}));

test('要約のbackendが使えない時、workerは固定の理由で止まり、後継を作らない', async () => withDb(async db => {
  const backend = reason => Object.assign(new Error('Codex CLI summarizer failed: exit 1'), { source: 'codex-cli', reason });
  const cases = [[backend('codex_cli_failed'), 'handoff_summarizer_backend_failed'], [backend('empty_output'), 'handoff_summarizer_backend_failed'],
    [new Error('handoff_l1_unavailable'), 'handoff_summarizer_backend_failed'],
    // 製品側の誤り（要約の呼び方の間違い）と、他の失敗は、今までどおり汎用の理由。
    [backend('recursion_guard'), 'handoff_worker_failed'], [new Error('別の失敗'), 'handoff_worker_failed']];
  for (const [index, [cause, expected]] of cases.entries()) {
    const operation = request(db, `summarizer-${index}`, { now: 1 }).operation;
    const counters = { created: 0, submitted: 0, notified: 0 };
    const deps = workerDependencies(db, {}, async () => { counters.submitted++; }, counters);
    deps.summaries = () => { throw cause; };
    const result = await runAutoHandoffWorker(operation.handoff_id, { db, dependencies: deps });
    assert.equal(result.state, 'failed'); assert.equal(result.error_code, expected); assert.equal(result.resume_state, 'source_stopped');
    assert.equal(counters.created, 0); assert.equal(counters.submitted, 0); assert.equal(counters.notified, 1);
    assert.equal(counters.marked, undefined, '途中で止まった引き継ぎの旧タスクには印を付けない');
    assert.equal(counters.carried, undefined, '途中で止まった引き継ぎでは、順番待ちを動かさない');
  }
}));

// Codex のゴールの口の代わり。goals は thread id ごとの今のゴール（無ければ null）。
function goalReceiver(goals, sent, fail = null) {
  return async (profile, parent, action) => action(async (method, params) => {
    sent.push([method, params]);
    if (method === fail) throw Object.assign(new Error('rejected'), { delivery_code: 'CODEX_RECEIVER_REJECTED' });
    if (method === 'thread/goal/get') return { goal: goals[params.threadId] ?? null };
    if (method === 'thread/goal/set') {
      const { threadId, ...fields } = params;
      goals[threadId] = { tokenBudget: null, tokensUsed: 0, ...(goals[threadId] ?? {}), ...fields };
      return { goal: goals[threadId] };
    }
    throw new Error(`想定していない要求: ${method}`);
  });
}

test('旧タスクの動いているゴールを一時停止にし、止まっているゴールと無いゴールには触らない。扱えなくても引き継ぎは止めない', async () => {
  const operation = { source_thread_id: 'S', codex_home: '/home' };
  let sent = []; let goals = { S: { status: 'active', objective: '目標' } };
  assert.equal(await pauseAutoHandoffSourceGoal(operation, {}, { connect: goalReceiver(goals, sent) }), 'paused');
  assert.deepEqual(sent, [['thread/goal/get', { threadId: 'S' }], ['thread/goal/set', { threadId: 'S', status: 'paused' }]]);
  assert.equal(goals.S.objective, '目標', '目標の文は消さない');

  for (const [goal, expected] of [[null, 'none'], [{ status: 'paused', objective: '目標' }, 'idle'], [{ status: 'complete', objective: '目標' }, 'idle']]) {
    sent = [];
    assert.equal(await pauseAutoHandoffSourceGoal(operation, {}, { connect: goalReceiver({ S: goal }, sent) }), expected);
    assert.equal(sent.length, 1, '読むだけ');
  }
  // ゴールの口が無い版の Codex、口が断った時。
  assert.equal(await pauseAutoHandoffSourceGoal(operation, {}, { connect: goalReceiver({}, [], 'thread/goal/get') }), 'failed');
  assert.equal(await pauseAutoHandoffSourceGoal(operation, {}, { connect: goalReceiver({ S: { status: 'active', objective: 'x' } }, [], 'thread/goal/set') }), 'failed');
});

test('旧タスクのゴールを後継へ運ぶ。動いていた物は動かし、利用者が止めていた物は止めたまま運び、予算は残りを渡す', async () => {
  const operation = { source_thread_id: 'S', target_thread_id: 'T', codex_home: '/home' };
  // この製品が引き継ぎの初めに止めたゴール。後継では動かす。旧タスクのゴールは止めたまま残す。
  let goals = { S: { status: 'paused', objective: '目標', tokenBudget: 1000, tokensUsed: 300 } }; let sent = [];
  assert.equal(await carryAutoHandoffGoal(operation, {}, { connect: goalReceiver(goals, sent), wasActive: true }), 'active');
  assert.deepEqual(sent.at(-1), ['thread/goal/set', { threadId: 'T', objective: '目標', status: 'active', tokenBudget: 700 }]);
  assert.equal(goals.S.status, 'paused'); assert.equal(goals.S.objective, '目標');

  // 利用者が止めていたゴール。止めたまま運ぶ。予算の無いゴールは、予算を付けない。
  goals = { S: { status: 'paused', objective: '目標', tokenBudget: null, tokensUsed: 300 } }; sent = [];
  assert.equal(await carryAutoHandoffGoal(operation, {}, { connect: goalReceiver(goals, sent) }), 'paused');
  assert.deepEqual(sent.at(-1), ['thread/goal/set', { threadId: 'T', objective: '目標', status: 'paused' }]);

  // 初めの一時停止が効いていなかった時は、ここで旧タスクを先に止めてから、後継で動かす。
  goals = { S: { status: 'active', objective: '目標' } }; sent = [];
  assert.equal(await carryAutoHandoffGoal(operation, {}, { connect: goalReceiver(goals, sent) }), 'active');
  assert.deepEqual(sent.map(([method, params]) => `${method}:${params.threadId}:${params.status ?? ''}`),
    ['thread/goal/get:S:', 'thread/goal/set:S:paused', 'thread/goal/get:T:', 'thread/goal/set:T:active']);

  // 後継にもうゴールがある時は書き換えない。
  goals = { S: { status: 'paused', objective: '目標' }, T: { status: 'active', objective: '別の目標' } }; sent = [];
  assert.equal(await carryAutoHandoffGoal(operation, {}, { connect: goalReceiver(goals, sent), wasActive: true }), 'kept');
  assert.equal(goals.T.objective, '別の目標'); assert.ok(!sent.some(([method]) => method === 'thread/goal/set'));

  // ゴールが無い、完了した、Codex が上限や行き詰まりで止めた。運ばない。
  for (const goal of [null, { status: 'complete', objective: '目標' }, { status: 'budgetLimited', objective: '目標' },
    { status: 'usageLimited', objective: '目標' }, { status: 'blocked', objective: '目標' }]) {
    sent = [];
    assert.equal(await carryAutoHandoffGoal(operation, {}, { connect: goalReceiver({ S: goal }, sent), wasActive: true }), 'none');
    assert.equal(sent.length, 1, '読むだけ');
  }
  // 今も動いているゴールだけを運ぶ指定では、止まっているゴールに触らない。
  goals = { S: { status: 'paused', objective: '目標' } }; sent = [];
  assert.equal(await carryAutoHandoffGoal(operation, {}, { connect: goalReceiver(goals, sent), onlyActive: true }), 'none');
  assert.equal(sent.length, 1); assert.equal(goals.T, undefined);
  // 別の旧タスク（後継のさらに前のタスク）を指定できる。
  goals = { OLD: { status: 'active', objective: '目標' } }; sent = [];
  assert.equal(await carryAutoHandoffGoal(operation, {}, { connect: goalReceiver(goals, sent), onlyActive: true, sourceThreadId: 'OLD' }), 'active');
  assert.equal(goals.OLD.status, 'paused'); assert.equal(goals.T.status, 'active');
  // 運べなくても例外にしない。
  assert.equal(await carryAutoHandoffGoal(operation, {}, { connect: goalReceiver({ S: { status: 'paused', objective: 'x' } }, [], 'thread/goal/set') }), 'failed');
});

// 1つのDBで何度も引き継ぐ試験では、後継のIDを旧タスクごとに変える（後継のIDは一意）。
function uniqueTarget(deps, source) {
  const createTarget = deps.createTarget;
  deps.createTarget = async (db, operation) => {
    await createTarget(db, operation);
    updateAutoHandoff(db, operation.handoff_id, { target_thread_id: `target-${source}` });
  };
}

test('workerは、最初に旧タスクのゴールを止め、後継が作業を続けた後でゴールを運ぶ。順番待ちを運ぶより先', async () => withDb(async db => {
  const run = async (source, counters, before = () => {}) => {
    const operation = request(db, source, { now: 1 }).operation;
    before(operation);
    const deps = workerDependencies(db, {}, async () => ({ queued_submission_id: 'receipt' }), counters);
    uniqueTarget(deps, source);
    const order = []; const carryQueue = deps.carryQueue, carryGoal = deps.carryGoal;
    deps.carryQueue = async (...args) => { order.push('queue'); return carryQueue(...args); };
    deps.carryGoal = async (...args) => { order.push('goal'); return carryGoal(...args); };
    return { result: await runAutoHandoffWorker(operation.handoff_id, { db, dependencies: deps }), order };
  };
  // 動いているゴールがあった。
  let counters = { created: 0, notified: 0, goalPause: 'paused', goalCarry: 'active' };
  let { result, order } = await run('goal-active', counters);
  assert.equal(result.state, 'continued');
  assert.deepEqual(counters.goal, ['pause:requested', 'carry:continued:true']);
  assert.deepEqual(order, ['goal', 'queue']);
  assert.deepEqual(getAutoHandoff(db, result.handoff_id).runtime.goalCarry, { paused: true, carried: 'active' });
  assert.equal(getAutoHandoff(db, result.handoff_id).runtime.targetPrepared, true, 'ゴールの記録で、ほかの記録を消さない');

  // ゴールが無い・扱えない時も引き継ぎは進む。
  for (const [index, goalPause] of ['none', 'idle', 'failed'].entries()) {
    counters = { created: 0, notified: 0, goalPause, goalCarry: goalPause === 'idle' ? 'paused' : 'none' };
    ({ result } = await run(`goal-${index}`, counters));
    assert.equal(result.state, 'continued'); assert.equal(counters.notified, 0);
    assert.deepEqual(counters.goal, ['pause:requested', 'carry:continued:false']);
  }

  // 途中で止まった引き継ぎをやり直す時は、ゴールをもう一度は読まず、最初に止めた事を覚えている。
  counters = { created: 0, notified: 0, goalPause: 'paused', goalCarry: 'active' };
  const operation = request(db, 'goal-resume', { now: 1 }).operation;
  const deps = workerDependencies(db, {}, async () => ({ queued_submission_id: 'receipt' }), counters);
  uniqueTarget(deps, 'goal-resume');
  deps.summaries = () => { throw new Error('別の失敗'); };
  const failed = await runAutoHandoffWorker(operation.handoff_id, { db, dependencies: deps });
  assert.equal(failed.state, 'failed'); assert.deepEqual(failed.runtime.goalCarry, { paused: true });
  assert.deepEqual(counters.goal, ['pause:requested'], '途中で止まった引き継ぎでは、ゴールを後継へ運ばない');
  deps.summaries = () => {}; counters.goalPause = 'idle';
  const resumed = await runAutoHandoffWorker(operation.handoff_id, { db, resume: true, dependencies: deps });
  assert.equal(resumed.state, 'continued');
  assert.deepEqual(counters.goal, ['pause:requested', 'carry:continued:true']);

  // 同じ旧タスクの前の引き継ぎ（途中で止まった物）が止めていたゴールは、新しい引き継ぎでも動いていた物として運ぶ。
  counters = { created: 0, notified: 0, goalPause: 'idle', goalCarry: 'active' };
  ({ result } = await run('goal-earlier', counters, current => {
    const earlier = requestAutoHandoff(db, { threadId: 'goal-earlier', turnId: 'earlier-turn', projectPath: '/project',
      rolloutPath: '/codex/rollout.jsonl', codexHome: '/codex', openHost: 'desktop', now: 0 }).operation;
    updateAutoHandoff(db, earlier.handoff_id, { state: 'failed', runtime_json: { goalCarry: { paused: true } } });
    assert.notEqual(earlier.handoff_id, current.handoff_id);
  }));
  assert.deepEqual(counters.goal, ['pause:requested', 'carry:continued:true']);
}));

// Codex がゴールの続行で起こして、hook が止めたターンの実物の並び（Windows の Codex Desktop 0.162.0-alpha.17.2、2026-10-13）。
function goalContinuation(turn, at) {
  return [
    { timestamp: `${at}.460Z`, type: 'event_msg', payload: { type: 'task_started', turn_id: turn } },
    { timestamp: `${at}.782Z`, type: 'response_item', payload: { type: 'message', role: 'user',
      content: [{ type: 'input_text', text: '<codex_internal_context source="goal">\nContinue working toward the active thread goal.\n</codex_internal_context>' }] } },
    { timestamp: `${at}.802Z`, type: 'event_msg', payload: { type: 'turn_aborted', turn_id: turn, reason: 'interrupted' } },
  ];
}

test('rollout から、ターンの入力が Codex 自身の文脈だけだったかを読む', async () => withDb((db, home) => {
  const thread = '11111111-1111-1111-1111-111111111111';
  const file = sourceRollout(home, thread, 'turn-a', [...goalContinuation('turn-goal', '2026-10-07T00:50:00'),
    ...stoppedInput('turn-person', '2026-10-07T00:51:00')]);
  const read = turnId => readCodexHandoffState(file, { threadId: thread, turnId }).internalInputOnly;
  assert.equal(read('turn-goal'), true); assert.equal(read('turn-person'), false); assert.equal(read('turn-a'), false);
  assert.equal(readCodexHandoffState(file, { threadId: thread }).internalInputOnly, false, 'turn を指定しない時は最後の turn');
  // 入力が turn の開始より前に記録される並びでも同じ。
  const [started, input, aborted] = goalContinuation('turn-goal-2', '2026-10-07T00:52:00');
  const early = sourceRollout(home, '22222222-2222-2222-2222-222222222222', 'turn-a', [input, started, aborted]);
  assert.equal(readCodexHandoffState(early, { threadId: '22222222-2222-2222-2222-222222222222', turnId: 'turn-goal-2' }).internalInputOnly, true);
  // ターンの途中で Codex が足す環境の知らせ（日付が変わった時など）は、入力の出どころに数えない（macOS の Codex Desktop 0.162.0-alpha.17.2 の実物）。
  const [started3, input3, aborted3] = goalContinuation('turn-goal-3', '2026-10-07T00:53:00');
  const environment = { timestamp: '2026-10-07T00:53:00.790Z', type: 'response_item', payload: { type: 'message', role: 'user',
    content: [{ type: 'input_text', text: '<environment_context>\n  <current_date>2026-10-08</current_date>\n</environment_context>' }] } };
  const dated = sourceRollout(home, '33333333-3333-3333-3333-333333333333', 'turn-a', [started3, input3, environment, aborted3]);
  assert.equal(readCodexHandoffState(dated, { threadId: '33333333-3333-3333-3333-333333333333', turnId: 'turn-goal-3' }).internalInputOnly, true);
}));

test('引き継ぎ済みの旧タスクへゴールの続行が来た時は、止めるが後継を開かず、ゴールの片付けを起こす', async () => withDb(async (db, home) => {
  const thread = '11111111-1111-1111-1111-111111111111', turnA = '22222222-2222-2222-2222-222222222222';
  const goalTurn = '33333333-3333-3333-3333-333333333333', personTurn = '44444444-4444-4444-4444-444444444444';
  const first = delivered(db, home, thread, turnA, 'successor-1', 1);
  const config = { enabled: true, projects: [home], openHost: 'desktop' };
  const seen = { opened: [], recorded: [], settled: [] };
  const args = { db, config, launchWorker: async () => { throw new Error('後継を増やしてはいけない'); }, findThread: () => ({ mtimeMs: 1 }),
    openThread: operation => { seen.opened.push(operation.target_thread_id); return true; },
    recordRedirect: entry => { seen.recorded.push(entry); },
    settleGoal: async (threadId, operation) => { seen.settled.push([threadId, operation.handoff_id]); return seen.settled.length === 1; } };
  const payload = (turn, later) => ({ trigger: 'auto', cwd: home, session_id: thread, turn_id: turn,
    transcript_path: sourceRollout(home, thread, turnA, later) });

  const goal = await requestCodexAutoHandoff({ ...args, payload: payload(goalTurn, goalContinuation(goalTurn, '2026-10-07T00:50:00')) });
  assert.equal(goal.continue, false); assert.equal(goal.redirected, true); assert.equal(goal.opened, false);
  assert.deepEqual(seen.opened, [], '人が入力していないターンでは、画面を後継へ切り替えない');
  assert.deepEqual(seen.settled, [[thread, first.handoff_id]]);
  assert.deepEqual({ ...seen.recorded[0], at: null }, { at: null, source_thread_id: thread, source_turn_id: goalTurn,
    handoff_id: first.handoff_id, target_thread_id: 'successor-1', opened: false, internal: true, goal_settle: true });

  // 人の入力では、今までどおり後継を開く。ゴールの片付けは、起こす側が間隔を空ける（ここでは2回めを起こさない）。
  const person = await requestCodexAutoHandoff({ ...args, payload: payload(personTurn, stoppedInput(personTurn, '2026-10-07T00:51:00')) });
  assert.equal(person.opened, true); assert.deepEqual(seen.opened, ['successor-1']);
  assert.equal(seen.recorded[1].internal, undefined); assert.equal(seen.recorded[1].goal_settle, undefined);
  // 片付けを起こせなくても、ターンは止める。
  const broken = await requestCodexAutoHandoff({ ...args, settleGoal: async () => { throw new Error('起こせません'); },
    payload: payload(goalTurn, goalContinuation(goalTurn, '2026-10-07T00:50:00')) });
  assert.equal(broken.continue, false); assert.equal(broken.redirected, true);
}));

test('ゴールの片付けは、同じ旧タスクへは間隔を空けて1つだけ起こす', async () => withDb(async () => {
  const spawned = [];
  const spawn = (command, args, options) => {
    spawned.push({ args, detached: options.detached });
    const child = new EventEmitter(); child.unref = () => {}; child.pid = 1;
    queueMicrotask(() => child.emit('spawn'));
    return child;
  };
  const operation = { handoff_id: 'handoff-1' };
  assert.equal(await launchAutoHandoffGoalSettle('thread-a', operation, { spawn }), true);
  assert.deepEqual(spawned[0].args.slice(1), ['auto-handoff', 'settle-goal', '--operation', 'handoff-1', '--thread', 'thread-a', '--json']);
  assert.equal(spawned[0].detached, true);
  assert.equal(await launchAutoHandoffGoalSettle('thread-a', operation, { spawn }), false, '続けて来ても起こさない');
  assert.equal(await launchAutoHandoffGoalSettle('thread-b', operation, { spawn }), true, '別の旧タスクは別に数える');
  assert.equal(await launchAutoHandoffGoalSettle('thread-a', operation, { spawn, now: Date.now() + 31_000 }), true, '間隔が空けば、もう一度起こす');
  assert.equal(spawned.length, 3);
}));

test('片付けは、旧タスクの動いているゴールを止めて、今の一番先の後継へ運び、記録を1行残す', async () => withDb(async (db, home) => {
  const thread = '11111111-1111-1111-1111-111111111111';
  const first = delivered(db, home, thread, 'turn-a', 'successor-1', 1);
  const second = delivered(db, home, 'successor-1', 'turn-b', 'successor-2', 2);
  const seen = { carried: [], recorded: [] };
  const options = goal => ({ executable: () => '公式Desktop試験fixture', findThread: () => ({ mtimeMs: 1 }),
    carryGoal: async (operation, runtime, carry) => { seen.carried.push([operation.handoff_id, carry, runtime.executable]); return goal; },
    record: entry => { seen.recorded.push(entry); } });
  const settled = await settleAutoHandoffSourceGoal(db, { operationId: first.handoff_id, threadId: thread }, options('active'));
  assert.deepEqual(settled, { status: 'settled', goal: 'active' });
  assert.deepEqual(seen.carried, [[second.handoff_id, { sourceThreadId: thread, onlyActive: true }, '公式Desktop試験fixture']]);
  assert.deepEqual({ ...seen.recorded[0], at: null }, { at: null, source_thread_id: thread, handoff_id: second.handoff_id,
    target_thread_id: 'successor-2', goal: 'active' });
  // 動いているゴールが無ければ、記録を増やさない。
  assert.deepEqual(await settleAutoHandoffSourceGoal(db, { operationId: first.handoff_id, threadId: thread }, options('none')), { status: 'settled', goal: 'none' });
  assert.equal(seen.recorded.length, 1);
  // 後継が残っていない旧タスクは、今の続きなので触らない。
  const gone = await settleAutoHandoffSourceGoal(db, { operationId: first.handoff_id, threadId: thread }, { ...options('active'), findThread: () => null });
  assert.equal(gone.status, 'skipped'); assert.equal(seen.carried.length, 2);
  await assert.rejects(settleAutoHandoffSourceGoal(db, { operationId: first.handoff_id, threadId: 'x y' }, options('active')), /handoff_thread_id_invalid/);
}));

test('公開CLIのsettle-goalは、引き継ぎIDと旧タスクのIDの両方を要る', () => {
  const parsed = parseAutoHandoffArgs(['settle-goal', '--operation', 'id', '--thread', 'thread', '--json']);
  assert.equal(parsed.action, 'settle-goal'); assert.equal(parsed.operation, 'id'); assert.equal(parsed.thread, 'thread');
  for (const args of [['settle-goal', '--operation', 'id'], ['settle-goal', '--thread', 'thread'],
    ['settle-goal', '--operation', 'id', '--thread', 'thread', '--host', 'claude']]) {
    assert.throws(() => parseAutoHandoffArgs(args));
  }
});

async function pollPreparation(check) {
  for (let i = 0; i < 200; i++) {
    const result = await check();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  throw new Error('fixture_timeout');
}
const fastPreparation = (db, id) => waitForCodexHandoffPreparation(db, id, { wait: pollPreparation });

test('失敗画面は本人の会話を示し、停止未許可・元前進・作用不明に古い要求の再試行を勧めない', () => {
  const operation = { handoff_id: 'request', source_thread_id: 'source', state: 'failed', error_code: 'handoff_native_child_pending' };
  for (const fields of [
    { runtime: { sourceStopGate: { authorized: false } } },
    { error_code: 'handoff_source_advanced' },
    { state: 'unknown', mutation_stage: 'create' },
  ]) {
    const html = renderAutoHandoffFailure({ ...operation, ...fields });
    assert.ok(html.includes('href="codex://threads/source"'));
    assert.ok(!html.includes('auto-handoff resume'));
    assert.ok(!html.includes('後継の会話を開く'));
  }
  const resumable = renderAutoHandoffFailure({ ...operation, target_thread_id: 'target' });
  assert.ok(resumable.includes('href="codex://threads/target"'));
  assert.ok(resumable.includes('auto-handoff resume --operation request'));
});

test('本物のPreCompact CLI入口も、要求の照合例外だけでは親を止めず、不明な作用と既存後継は保護する', async () => withDb(async (db, home) => {
  const thread = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', turn = '22222222-2222-2222-2222-222222222222';
  const payload = desktopSource(home, '33333333-3333-3333-3333-333333333333', turn);
  payload.session_id = thread; // hostが渡したIDと記録先頭のIDが違う実例。
  writeFileSync(join(home, '.throughline', 'codex-auto-handoff.json'), JSON.stringify({
    schema: 'throughline.codex-auto-handoff.v1', enabled: true, openHost: 'desktop', projects: [] }));
  const run = (input = payload) => {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('../bin/throughline.mjs', import.meta.url)), 'codex-hook', 'pre-compact'], {
      cwd: home, input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env,
        XDG_CONFIG_HOME: join(home, 'config'), XDG_STATE_HOME: join(home, 'state'), LOCALAPPDATA: join(home, 'AppData', 'Local') } });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const safe = run();
  assert.equal(safe.continue, true); assert.match(safe.systemMessage, /handoff_thread_mismatch/);
  assert.ok(safe.systemMessage.includes(`codex://threads/${thread}`));
  assert.equal(db.prepare('SELECT count(*) AS n FROM codex_handoffs').get().n, 0);
  const op = request(db, thread).operation;
  for (const fields of [
    { state: 'requested', runtime_json: { sourceStopGate: { authorized: false } } },
    { state: 'unknown', mutation_stage: 'create', target_thread_id: null, queued_submission_id: null },
    { state: 'failed', mutation_stage: null, target_thread_id: '44444444-4444-4444-4444-444444444444' },
    { state: 'continued', queued_submission_id: 'receipt' },
  ]) {
    updateAutoHandoff(db, op.handoff_id, fields);
    assert.equal(run().continue, false, JSON.stringify(fields));
    assert.equal(run({ ...payload, session_id: thread.toUpperCase() }).continue, false, 'UUIDの表記差で所有確認を回避しない');
  }
  updateAutoHandoff(db, op.handoff_id, { state: 'failed', mutation_stage: null, target_thread_id: null, queued_submission_id: null });
  assert.equal(run().continue, true, '後継も作用も無い確定失敗は本人の会話で継続できる');
}));

test('要求例外の復旧判断は初回DBを作らず、読取不能や識別不能を作用なしと断定しない', async () => withDb((db, home) => {
  const payload = { session_id: '11111111-1111-1111-1111-111111111111' };
  const databasePath = join(home, 'missing.db');
  assert.equal(codexHandoffRequestFailureResult(Error('private'), payload, { databasePath }).continue, true);
  assert.equal(existsSync(databasePath), false);
  writeFileSync(databasePath, 'not-a-database');
  assert.equal(codexHandoffRequestFailureResult(Error('private'), payload, { databasePath }).continue, false);
  assert.equal(codexHandoffRequestFailureResult(Error('private'), { session_id: 'unknown' }).continue, false);
  db.exec('PRAGMA user_version = 99');
  assert.equal(codexHandoffRequestFailureResult(Error('private'), payload,
    { databasePath: db.prepare('PRAGMA database_list').get().file }).continue, false);
}));

test('元会話が継続した失敗だけを現在の待ちから除き、不明な作成・後継・元記録不明は保持する', async () => withDb((db, home) => {
  const thread = '11111111-1111-1111-1111-111111111111';
  const rolloutPath = sourceRollout(home, thread, 'turn', stoppedInput('next', '2026-10-07T00:56:48'));
  const options = { findThread: () => null, processes: () => [] };
  const make = (turnId, fields = {}) => updateAutoHandoff(db,
    request(db, thread, { turnId, rolloutPath }).operation.handoff_id,
    { state: 'failed', error_code: 'handoff_native_child_pending', ...fields }).operation;
  const old = make('turn');
  assert.equal(resolveAutoHandoffSuccessor(db, thread, options).pending.handoff_id, old.handoff_id,
    '入力が来ただけでは復帰と断定しない');
  fs.appendFileSync(rolloutPath, JSON.stringify({ type: 'response_item', payload: {
    type: 'message', role: 'assistant', content: [{ text: '元の会話で作業を再開しました' }] } }) + '\n');
  assert.equal(resolveAutoHandoffSuccessor(db, thread, options).pending, null);
  assert.equal(getAutoHandoff(db, old.handoff_id).state, 'failed', '失敗履歴を書き換えない');

  // 停止を許可していない準備失敗は、元会話の次turnを待たず通話を受けられる。
  const preparation = make('next', { runtime_json: { sourceStopGate: { authorized: false } } });
  assert.equal(resolveAutoHandoffSuccessor(db, thread, options).pending, null);
  for (const fields of [
    { state: 'unknown', mutation_stage: 'create' },
    { mutation_stage: 'inject' },
    { target_thread_id: '22222222-2222-2222-2222-222222222222' },
    { state: 'requested' },
  ]) {
    const op = make(`unsafe-${JSON.stringify(fields)}`, { runtime_json: preparation.runtime, ...fields });
    assert.equal(resolveAutoHandoffSuccessor(db, thread, options).pending.handoff_id, op.handoff_id);
    // より新しい安全な失敗が、不明な作用を隠さない。
    make(`safe-${op.handoff_id}`, { runtime_json: preparation.runtime });
    assert.equal(resolveAutoHandoffSuccessor(db, thread, options).pending.handoff_id, op.handoff_id);
    db.prepare('DELETE FROM codex_handoffs WHERE handoff_id = ?').run(op.handoff_id);
  }
  const missing = make('missing');
  rmSync(rolloutPath);
  assert.equal(resolveAutoHandoffSuccessor(db, thread, options).pending.handoff_id, missing.handoff_id);
}));

function gateFixture(db, home) {
  const thread = '11111111-1111-1111-1111-111111111111', turn = '22222222-2222-2222-2222-222222222222';
  const payload = desktopSource(home, thread, turn);
  const counters = { created: 0, notified: 0, submitted: 0, summaries: 0 };
  const deps = workerDependencies(db, { cwd: home }, async () => { counters.submitted++; return { queued_submission_id: 'receipt' }; }, counters);
  const read = deps.readSource;
  let stopped = false, captured = false, worker;
  deps.readSource = op => ({ ...read(op), latestTurnId: turn, stoppedAt: stopped ? Date.now() : null });
  deps.capture = (db, args) => {
    if (!captured) {
      captured = true;
      const session = `codex:${args.threadId}`;
      db.prepare('INSERT INTO sessions (session_id,project_path,created_at,updated_at) VALUES (?, ?, 1, 1)').run(session, home);
      db.prepare("INSERT INTO bodies (session_id,origin_session_id,turn_number,role,text,created_at) VALUES (?, ?, 1, 'user', '未完了の元依頼', 1)").run(session, session);
    }
    return { status: 'captured' };
  };
  deps.summaries = () => { counters.summaries++; assert.equal(stopped, false); assert.equal(counters.goal, undefined); };
  deps.wait = pollPreparation;
  const args = { db, payload, checkGoal: async () => {}, config: { enabled: true, projects: [home], openHost: 'desktop' },
    waitForPreparation: fastPreparation, launchWorker: async id => { worker = runAutoHandoffWorker(id, { db, dependencies: deps }); } };
  return { args, deps, counters, worker: () => worker, stop: () => { stopped = true; } };
}

test('子が未完了なら停止前に拒否し、同じ本人の会話を現在地として配送の待ちを残さない', async () => withDb(async (db, home) => {
  const f = gateFixture(db, home);
  f.deps.nativeState = async () => { throw Object.assign(Error('child active'), { code: 'handoff_native_child_pending' }); };
  const answer = await realRequestCodexAutoHandoff(f.args);
  const result = await f.worker();
  assert.equal(answer.continue, true); assert.equal(result.runtime.sourceStopGate.authorized, false);
  assert.equal(f.counters.created, 0); assert.equal(f.counters.submitted, 0); assert.equal(f.counters.goal, undefined);
  assert.equal(result.target_thread_id, null); assert.equal(result.queued_submission_id, null);
  assert.ok(answer.systemMessage.includes(`codex://threads/${f.args.payload.session_id}`));
  const current = resolveAutoHandoffSuccessor(db, f.args.payload.session_id, { findThread: () => null });
  assert.equal(current.current_thread_id, f.args.payload.session_id); assert.equal(current.pending, null);
}));

test('準備中に子が動き始めても、停止を許可する前に再照合して元会話を継続する', async () => withDb(async (db, home) => {
  const f = gateFixture(db, home);
  let active = false;
  f.deps.nativeState = async () => {
    if (active) throw Object.assign(Error('child active'), { code: 'handoff_native_child_pending' });
    return { projectId: null };
  };
  f.deps.summaries = () => { active = true; };
  const answer = await realRequestCodexAutoHandoff(f.args);
  const result = await f.worker();
  assert.equal(answer.continue, true);
  assert.equal(result.error_code, 'handoff_native_child_pending');
  assert.equal(result.runtime.sourceStopGate.authorized, false);
  assert.equal(f.counters.created, 0); assert.equal(f.counters.submitted, 0); assert.equal(f.counters.goal, undefined);
}));

test('要約の混雑は元ターン・ゴールを止める前に失敗し、理由だけを保持して元会話を継続する', async () => withDb(async (db, home) => {
  const f = gateFixture(db, home);
  f.deps.summaries = () => { throw Object.assign(Error('private-prompt-do-not-log'), {
    source: 'codex-cli', reason: 'codex_cli_failed', exitCode: 1,
    stderr: 'private-prompt-do-not-log ERROR: Selected model is at capacity. Please try a different model.' }); };
  const answer = await realRequestCodexAutoHandoff(f.args);
  const result = await f.worker();
  assert.equal(answer.continue, true); assert.equal(answer.status, 'failed'); assert.match(answer.systemMessage, /元の会話は停止せず/);
  assert.equal(result.state, 'failed'); assert.equal(result.resume_state, 'requested');
  assert.equal(result.error_code, 'handoff_summarizer_backend_failed');
  assert.equal(result.runtime.sourceStopGate.authorized, false);
  assert.equal(result.runtime.summarizerFailure.category, 'capacity');
  assert.equal(f.counters.created, 0); assert.equal(f.counters.submitted, 0); assert.equal(f.counters.goal, undefined); assert.equal(f.counters.notified, 0);
  const logged = fs.readFileSync(join(home, '.throughline', 'logs', 'hook-failures.log'), 'utf8');
  assert.ok(logged.includes('handoff_summarizer_capacity')); assert.ok(!logged.includes('private-prompt-do-not-log'));
}));

test('準備完了を確認してからだけ停止を許可し、停止実測後は外部要約を再実行せず後継を一度起動する', async () => withDb(async (db, home) => {
  const f = gateFixture(db, home);
  const answer = await realRequestCodexAutoHandoff(f.args);
  assert.equal(answer.continue, false);
  assert.equal(getAutoHandoff(db, answer.operationId).runtime.sourceStopGate.authorized, true);
  assert.equal(getAutoHandoff(db, answer.operationId).snapshot, null, '停止前の記憶は正規snapshotにしない');
  assert.equal(f.counters.created, 0); assert.equal(f.counters.submitted, 0);
  assert.equal(f.counters.goal, undefined, '停止許可だけでは旧ゴールを止めない');
  f.stop();
  const result = await f.worker();
  assert.equal(result.state, 'continued'); assert.equal(result.snapshot.bodies[0].text, '未完了の元依頼');
  assert.equal(f.counters.summaries, 1); assert.equal(f.counters.created, 1); assert.equal(f.counters.submitted, 1);
  await runAutoHandoffWorker(result.handoff_id, { db, dependencies: f.deps });
  assert.equal(f.counters.submitted, 1);
}));

test('準備の時間切れ後に遅れて来たworkerは、元会話の継続を取り消さず後継も作らない', async () => withDb(async (db, home) => {
  const f = gateFixture(db, home);
  let id;
  const answer = await realRequestCodexAutoHandoff({ ...f.args, launchWorker: async value => { id = value; },
    waitForPreparation: async () => { throw Object.assign(Error('timeout'), { code: 'handoff_preparation_timeout' }); } });
  assert.equal(answer.continue, true); assert.equal(answer.reason, 'handoff_preparation_timeout');
  const result = await runAutoHandoffWorker(id, { db, dependencies: f.deps });
  assert.equal(result.state, 'failed'); assert.equal(result.runtime.sourceStopGate.authorized, false);
  assert.equal(f.counters.created, 0); assert.equal(f.counters.submitted, 0); assert.equal(f.counters.goal, undefined);
}));

test('worker起動失敗でも元会話を止めず、同じturnの重複通知でも停止へ変わらない', async () => withDb(async (db, home) => {
  const f = gateFixture(db, home);
  const args = { ...f.args, launchWorker: async () => { throw Error('spawn failed'); } };
  const first = await realRequestCodexAutoHandoff(args), duplicate = await realRequestCodexAutoHandoff(args);
  assert.equal(first.continue, true); assert.equal(duplicate.continue, true);
  assert.equal(first.reason, 'handoff_worker_start_failed'); assert.equal(first.operationId, duplicate.operationId);
}));

test('要約の直後に準備取消になっても、遅れた完了で停止許可を復活させない', async () => withDb(async (db, home) => {
  const f = gateFixture(db, home);
  f.deps.summaries = (db, op) => {
    db.prepare("UPDATE codex_handoffs SET state='failed', error_code='handoff_preparation_timeout', resume_state='requested' WHERE handoff_id=?").run(op.handoff_id);
  };
  const answer = await realRequestCodexAutoHandoff(f.args);
  const result = await f.worker();
  assert.equal(answer.continue, true); assert.equal(result.state, 'failed'); assert.equal(result.runtime.sourceStopGate.authorized, false);
  assert.equal(f.counters.goal, undefined); assert.equal(f.counters.created, 0);
}));

test('停止許可をhostが受け取れず元turnが停止しない場合は、ゴールも後継も操作しない', async () => withDb(async (db, home) => {
  const f = gateFixture(db, home);
  f.deps.wait = async (check, options) => {
    if (options.timeoutCode === 'handoff_source_stop_unconfirmed') {
      assert.equal(await check(), null);
      throw Object.assign(Error('host did not stop'), { code: 'handoff_source_stop_unconfirmed' });
    }
    return pollPreparation(check);
  };
  const answer = await realRequestCodexAutoHandoff(f.args);
  assert.equal(answer.continue, false);
  const result = await f.worker();
  assert.equal(result.state, 'failed'); assert.equal(result.error_code, 'handoff_source_stop_unconfirmed');
  assert.equal(f.counters.goal, undefined); assert.equal(f.counters.created, 0); assert.equal(f.counters.submitted, 0);
}));


test('停止前goal判定: active goalは停止前に明示失敗し、goalと元会話を動かしたままにする', async () => withDb(async (db, home) => {
  const f = gateFixture(db, home), goals = { [f.args.payload.session_id]: { status: 'active', objective: 'fixture goal' } }, sent = [];
  const connect = goalReceiver(goals, sent);
  const before = JSON.stringify(goals);
  f.args.checkGoal = op => checkAutoHandoffSourceGoal(op, {}, { connect });
  const answer = await realRequestCodexAutoHandoff(f.args);
  const result = await f.worker();
  assert.equal(answer.continue, true);
  assert.equal(answer.reason, 'handoff_active_goal_conditional_resume_unavailable');
  assert.equal(result.runtime.sourceStopGate.authorized, false);
  assert.equal(JSON.stringify(goals), before);
  assert.equal(sent.some(([method]) => method === 'thread/goal/set'), false);
  assert.equal(f.counters.goal, undefined); assert.equal(f.counters.created, 0); assert.equal(f.counters.submitted, 0);
}));

test('停止前goal判定: goalなし・既存paused・完了では何も書かず通常の引き継ぎ判定へ返す', async () => {
  for (const goal of [null, { status: 'paused' }, { status: 'complete' }, { status: 'budgetLimited' }]) {
    const sent = [];
    await checkAutoHandoffSourceGoal({ source_thread_id: 'S' }, {}, { connect: goalReceiver({ S: goal }, sent) });
    assert.deepEqual(sent, [['thread/goal/get', { threadId: 'S' }]]);
  }
});


test('goal読取失敗は停止前に元会話へ戻し、後継やgoal書込みを行わない', async () => withDb(async (db, home) => {
  const f = gateFixture(db, home);
  f.args.checkGoal = op => checkAutoHandoffSourceGoal(op, {}, { connect: async () => {
    throw Object.assign(new Error('fixture read failed'), { code: 'fixture_goal_read_failed' });
  } });
  const answer = await realRequestCodexAutoHandoff(f.args);
  const result = await f.worker();
  assert.equal(answer.continue, true); assert.equal(answer.reason, 'fixture_goal_read_failed');
  assert.equal(result.runtime.sourceStopGate.authorized, false);
  assert.equal(f.counters.goal, undefined); assert.equal(f.counters.created, 0); assert.equal(f.counters.submitted, 0);
}));

test('goal判定中に要求が失敗した場合、遅れて停止を許可しない', async () => withDb(async (db, home) => {
  const f = gateFixture(db, home);
  f.args.checkGoal = async op => { failAutoHandoff(db, op.handoff_id, 'fixture_cancelled'); };
  const answer = await realRequestCodexAutoHandoff(f.args);
  const result = await f.worker();
  assert.equal(answer.continue, true);
  assert.equal(result.runtime.sourceStopGate.authorized, false);
  assert.equal(f.counters.created, 0); assert.equal(f.counters.submitted, 0);
}));
