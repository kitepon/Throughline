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
import { runAutoHandoffWorker, requestCodexAutoHandoff, sourceBoundary } from './codex-auto-handoff.mjs';
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
