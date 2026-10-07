import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { requestAutoHandoff, updateAutoHandoff, getAutoHandoff, freezeCodexMemory,
  claimAutoHandoff, continuationInput } from './codex-auto-handoff-store.mjs';
import { collectAutoHandoffMemory, ensureAutoHandoffSummaries, renderAutoHandoffMemory,
  renderFrozenDetail } from './codex-auto-handoff-memory.mjs';
import { readCodexHandoffState, settingsMatch, threadStartSettings } from './hosts/codex-handoff-state.mjs';
import { runAutoHandoffWorker, requestCodexAutoHandoff, sourceBoundary,
  autoHandoffTargetName, nameAutoHandoffTarget, findLiveAutoHandoffSuccessor } from './codex-auto-handoff.mjs';
import { parseAutoHandoffArgs } from './cli/auto-handoff.mjs';

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

test('未処理入力・実行中の子・出所不明の継承記憶では後継を作らない', async () => withDb(async db => {
  for (const code of ['handoff_source_input_pending', 'handoff_native_child_pending', 'handoff_memory_lineage_untracked']) {
    const op = request(db, code, { now: 1 }).operation;
    const counters = { created: 0, submitted: 0, notified: 0 };
    const deps = workerDependencies(db, {}, async () => { counters.submitted++; }, counters);
    if (code === 'handoff_memory_lineage_untracked') {
      const read = deps.readSource;
      deps.readSource = item => ({ ...read(item), inheritedThroughlineMemory: true });
    } else deps.nativeState = async () => { throw Object.assign(Error(code), { code }); };
    const result = await runAutoHandoffWorker(op.handoff_id, { db, dependencies: deps });
    assert.equal(result.error_code, code); assert.equal(result.state, 'failed');
    assert.equal(counters.created, 0); assert.equal(counters.submitted, 0);
  }
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
  const args = { db, config, payload, launchWorker: async () => { seen.launched++; },
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
