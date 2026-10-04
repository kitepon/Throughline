import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import {
  requestClaudeAutoHandoff,
  stopClaudeTurnForHandoff,
  completeClaudeTurnWithoutHandoff,
  recordClaudeSuccessorTarget,
  acceptClaudeAutoContinuation,
  runClaudeAutoHandoffWorker,
  readClaudeAutoHandoff,
  listClaudeAutoHandoffs,
  publicClaudeAutoHandoff,
  claudeContinuationInput,
} from './claude-auto-handoff.mjs';
import { parseAutoHandoffArgs } from './cli/auto-handoff.mjs';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(REPO_ROOT, 'bin', 'throughline.mjs');
const SESSION = '0f3a6c1e-7b2d-4e5f-9a81-3c4d5e6f7a8b';
const SUCCESSOR = 'a41a97ae-6b2a-421b-b2d5-1a0b07988d06';
const ENABLED = { enabled: true, projects: [] };

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'tl-claude-auto-'));
  const finish = () => rmSync(dir, { recursive: true, force: true });
  let result;
  try { result = fn(dir); }
  catch (error) { finish(); throw error; }
  if (result && typeof result.then === 'function') return result.finally(finish);
  finish();
  return result;
}

function makeBatonDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE handoff_batons (project_path TEXT PRIMARY KEY, session_id TEXT NOT NULL, created_at INTEGER NOT NULL)');
  return db;
}

const user = (text, timestamp, extra = {}) => ({ type: 'user', timestamp, ...extra, message: { role: 'user', content: text } });
const assistant = (text, timestamp, model = 'claude-fable-5-1') =>
  ({ type: 'assistant', timestamp, message: { role: 'assistant', model, content: [{ type: 'text', text }] } });
const toolUse = (id, name) =>
  ({ type: 'assistant', message: { role: 'assistant', model: 'claude-fable-5-1', content: [{ type: 'tool_use', id, name, input: {} }] } });
const toolResult = (id, text) => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] } });
const jsonl = entries => entries.map(entry => JSON.stringify(entry)).join('\n') + '\n';

function request(dir, overrides = {}) {
  const db = overrides.db ?? makeBatonDb();
  const result = requestClaudeAutoHandoff({
    payload: { session_id: SESSION, trigger: 'auto', cwd: '/work/app', transcript_path: overrides.transcriptPath ?? null,
      ...overrides.payload },
    env: overrides.env ?? {}, config: overrides.config ?? ENABLED, openDb: () => db, dir, now: overrides.now ?? 1_000,
  });
  return { result, db };
}

test('PreCompact: 自動圧縮で有効な時だけ、印と記録を残して圧縮を止める', () => withDir(dir => {
  const { result, db } = request(dir);
  assert.equal(result.status, 'requested');
  assert.equal(result.block, true);
  assert.equal(result.projectPath, '/work/app');
  assert.deepEqual({ ...db.prepare('SELECT project_path, session_id, created_at FROM handoff_batons').get() },
    { project_path: '/work/app', session_id: SESSION, created_at: 1_000 }, '/tl と同じ印');
  const record = readClaudeAutoHandoff(SESSION, dir);
  assert.equal(record.state, 'requested');
  assert.equal(record.handoff_id, result.handoffId);

  // 同じ圧縮で hook が2回届いても、同じ引き継ぎのまま止め続ける
  const again = request(dir, { db, now: 6_000 }).result;
  assert.deepEqual([again.status, again.block, again.handoffId], ['already_requested', true, result.handoffId]);
  assert.equal(db.prepare('SELECT created_at FROM handoff_batons').get().created_at, 1_000);

  // 有効判定は会話を起動した project で行う（cwd は Bash の cd に追従する）
  rmSync(join(dir, `${SESSION}.json`));
  const started = request(dir, { payload: { cwd: '/work/app/sub' }, env: { CLAUDE_PROJECT_DIR: '/work/app' },
    config: { enabled: true, projects: ['/work/app'] } }).result;
  assert.deepEqual([started.status, started.projectPath], ['requested', '/work/app']);
}));

test('PreCompact: 手動・無効・対象外のproject・scriptから起動した会話・subagent では圧縮を止めない', () => withDir(dir => {
  for (const [overrides, reason] of [
    [{ payload: { trigger: 'manual' } }, 'manual_compact'],
    [{ config: { enabled: false, projects: [] } }, 'auto_handoff_disabled'],
    [{ config: { enabled: true, projects: ['/work/other'] } }, 'auto_handoff_disabled'],
    [{ env: { CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' } }, 'handoff_host_unsupported'],
    [{ payload: { agent_id: 'agent-1' } }, 'subagent_compact'],
  ]) {
    const { result, db } = request(dir, overrides);
    assert.deepEqual([result.status, result.block, result.reason], ['skipped', false, reason]);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM handoff_batons').get().c, 0, reason);
    assert.deepEqual(listClaudeAutoHandoffs({ dir }), [], reason);
  }
  assert.equal(request(dir, { env: { CLAUDE_CODE_ENTRYPOINT: 'claude-desktop' } }).result.status, 'requested');
}));

test('PreCompact: 手動の/compactは止める前の記録を取り下げ、subagentの圧縮は親の記録に触らない', () => withDir(dir => {
  request(dir);
  assert.equal(request(dir, { payload: { trigger: 'auto', agent_id: 'agent-1' } }).result.reason, 'subagent_compact');
  assert.equal(readClaudeAutoHandoff(SESSION, dir).state, 'requested');
  assert.equal(request(dir, { payload: { trigger: 'manual' } }).result.reason, 'manual_compact');
  assert.equal(readClaudeAutoHandoff(SESSION, dir), null);
}));

test('PreCompact: session id が無い・pathを含む時は失敗し、期限を過ぎた記録は掃除する', () => withDir(dir => {
  assert.throws(() => requestClaudeAutoHandoff({ payload: { trigger: 'auto' }, env: {}, config: ENABLED, openDb: makeBatonDb, dir }),
    /Missing session_id/);
  assert.throws(() => request(dir, { payload: { session_id: '../escape' } }), /auto_handoff_session_id_invalid/);

  const now = Date.parse('2026-10-04T12:00:00Z');
  mkdirSync(join(dir, 'targets'), { recursive: true });
  const stale = [join(dir, 'aaaaaaaa-0000-4000-8000-000000000001.json'), join(dir, 'targets', 'aaaaaaaa-0000-4000-8000-000000000003.json')];
  const fresh = join(dir, 'aaaaaaaa-0000-4000-8000-000000000002.json');
  for (const path of [...stale, fresh]) writeFileSync(path, '{}');
  for (const path of stale) utimesSync(path, new Date(now - 25 * 3_600_000), new Date(now - 25 * 3_600_000));
  utimesSync(fresh, new Date(now - 3_600_000), new Date(now - 3_600_000));
  request(dir, { now });
  assert.deepEqual(readdirSync(dir).filter(name => name.endsWith('.json')).sort(),
    [`${SESSION}.json`, 'aaaaaaaa-0000-4000-8000-000000000002.json'].sort());
  assert.deepEqual(readdirSync(join(dir, 'targets')), []);
}));

test('PreToolUse: 記録のある会話の道具を実行させずに止め、止めた時点の依頼と設定を写して worker を1回だけ起動する', () => withDir(async dir => {
  const transcriptPath = join(dir, 'transcript.jsonl');
  writeFileSync(transcriptPath, jsonl([
    user('前の依頼', '2026-10-04T03:00:00Z'),
    assistant('前の回答', '2026-10-04T03:00:01Z'),
    user('big1 と big2 を読んで result.txt を作って', '2026-10-04T03:00:10Z'),
    toolUse('toolu_1', 'Read'),
    toolResult('toolu_1', 'contents'),
    assistant('big1 を読み終えました。次に big2 を読みます。', '2026-10-04T03:00:12Z'),
    { type: 'assistant', message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'tool_use', id: 'toolu_2', name: 'Read', input: {} }] } },
  ]));
  const launched = [];
  const launchWorker = async sessionId => { launched.push(sessionId); };
  const payload = { session_id: SESSION, transcript_path: transcriptPath, cwd: '/work/app', tool_name: 'Read', tool_use_id: 'toolu_2',
    permission_mode: 'acceptEdits', effort: { level: 'high' } };

  assert.equal(await stopClaudeTurnForHandoff({ payload, dir, launchWorker }), null, '記録が無い会話には何もしない');
  const { result } = request(dir, { transcriptPath });
  assert.equal(await stopClaudeTurnForHandoff({ payload: { ...payload, agent_id: 'agent-1' }, dir, launchWorker }), null,
    'subagent の中の道具は止めない');

  // 同じ応答に並んだ2つの道具
  const [first, second] = await Promise.all([
    stopClaudeTurnForHandoff({ payload, dir, launchWorker, now: 2_000 }),
    stopClaudeTurnForHandoff({ payload: { ...payload, tool_name: 'Write' }, dir, launchWorker, now: 2_000 }),
  ]);
  for (const output of [first, second]) {
    assert.equal(output.continue, false);
    assert.match(output.stopReason, new RegExp(`自動圧縮の代わりに新しい会話へ引き継ぎます（引き継ぎID: ${result.handoffId}）`));
    assert.deepEqual(output.hookSpecificOutput, { hookEventName: 'PreToolUse', permissionDecision: 'deny',
      permissionDecisionReason: output.stopReason });
  }
  assert.deepEqual(launched, [SESSION]);
  const record = readClaudeAutoHandoff(SESSION, dir);
  assert.equal(record.state, 'stopped');
  assert.deepEqual(record.settings, { model: null, effort: 'high', permission_mode: 'acceptEdits' },
    '権限と推論強度は hook の入力から写す。モデルと依頼は worker が transcript から読む');
  assert.equal(record.stopped_tool_use_id, 'toolu_2');
  assert.equal(record.in_flight, null);

  // 止めた後に届いた道具も止める。worker はもう起動しない
  assert.equal((await stopClaudeTurnForHandoff({ payload, dir, launchWorker })).continue, false);
  assert.deepEqual(launched, [SESSION]);
}));

test('PreToolUse: worker を起動できなければ failed にし、次の道具でもう一度立ち上げる', () => withDir(async dir => {
  request(dir);
  const payload = { session_id: SESSION, cwd: '/work/app', tool_name: 'Read' };
  const failing = async () => { throw new Error('spawn failed'); };
  const output = await stopClaudeTurnForHandoff({ payload, dir, launchWorker: failing });
  assert.equal(output.continue, false, '立ち上げに失敗しても、圧縮されていない会話の道具は止める');
  assert.deepEqual([readClaudeAutoHandoff(SESSION, dir).state, readClaudeAutoHandoff(SESSION, dir).error_code],
    ['failed', 'handoff_worker_start_failed']);
  const launched = [];
  await stopClaudeTurnForHandoff({ payload, dir, launchWorker: async sessionId => { launched.push(sessionId); } });
  assert.deepEqual(launched, [SESSION]);
  assert.equal(readClaudeAutoHandoff(SESSION, dir).state, 'stopped');
}));

test('Stop: 圧縮を止めた後、道具を呼ばずにターンが終わったら記録を取り下げる（印は残す）', () => withDir(async dir => {
  const { db } = request(dir);
  assert.equal(completeClaudeTurnWithoutHandoff({ sessionId: 'aaaaaaaa-0000-4000-8000-000000000009', dir }), false);
  assert.equal(completeClaudeTurnWithoutHandoff({ sessionId: `grok:${SESSION}`, dir }), false);
  assert.equal(completeClaudeTurnWithoutHandoff({ sessionId: SESSION, dir }), true);
  assert.equal(readClaudeAutoHandoff(SESSION, dir), null);
  assert.equal(db.prepare('SELECT session_id FROM handoff_batons').get().session_id, SESSION);

  // 止めた後（worker が動いている）の記録は取り下げない
  request(dir);
  await stopClaudeTurnForHandoff({ payload: { session_id: SESSION, cwd: '/work/app' }, dir, launchWorker: async () => {} });
  assert.equal(completeClaudeTurnWithoutHandoff({ sessionId: SESSION, dir }), false);
  assert.equal(readClaudeAutoHandoff(SESSION, dir).state, 'stopped');
}));

/** 止めた直後の記録を作り、後継の SessionStart と配送を差し替えて worker を走らせる。 */
async function runWorker(dir, { spawn, send, onLaunched }) {
  request(dir);
  await stopClaudeTurnForHandoff({ payload: { session_id: SESSION, cwd: '/work/app', permission_mode: 'acceptEdits',
    effort: { level: 'high' } }, dir, launchWorker: async () => {} });
  const calls = { spawn: [], send: [] };
  const record = await runClaudeAutoHandoffWorker(SESSION, {
    dir, env: { PATH: '/bin', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'claude-desktop', CLAUDE_CODE_MESSAGING_SOCKET: '/old.sock',
      CLAUDE_CODE_MESSAGING_TOKEN: 'old-token', CLAUDE_PROJECT_DIR: '/work/app', CLAUDE_CODE_USE_BEDROCK: '1' },
    targetTimeoutMs: 300, sendTimeoutMs: 300, pollMs: 10,
    spawn: (command, args, options) => {
      calls.spawn.push({ command, args, options });
      const result = spawn(command, args, options);
      if (result.status === 0) onLaunched?.();
      return result;
    },
    send: async (target, text, options) => { calls.send.push({ target, text }); return send(target, text, options); },
  });
  return { record, calls };
}

const launchedOk = () => ({ status: 0, stdout: 'Starting background service…\nbackgrounded · a41a97ae · tl-app-1234 (idle — send a prompt to start)\n', stderr: '' });
const successorStarts = dir => () => recordClaudeSuccessorTarget({
  payload: { session_id: SUCCESSOR, source: 'startup', cwd: '/work/app' },
  env: { CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/cc-socks/271650.sock', CLAUDE_CODE_MESSAGING_TOKEN: 'secret-token' }, dir });

test('worker: 指示を待つ後継を同じprojectに立て、後継の受け口へ継続の指示を1通送る', () => withDir(async dir => {
  const { record, calls } = await runWorker(dir, {
    spawn: launchedOk,
    onLaunched: successorStarts(dir),
    send: async (target, text, options) => {
      // 届いた指示で、後継の最初の UserPromptSubmit が受領を記録する
      const accepted = acceptClaudeAutoContinuation({ predecessorId: SESSION, successorSessionId: SUCCESSOR, prompt: text, dir });
      assert.ok(accepted);
      return await options.confirm_acceptance(new AbortController().signal)
        ? { status: 'accepted', outcome_unknown: false, reason: 'receiver_confirmed' }
        : { status: 'unknown', outcome_unknown: true, reason: 'unconfirmed' };
    },
  });
  assert.equal(calls.spawn.length, 1);
  const { command, args, options } = calls.spawn[0];
  assert.equal(command, 'claude');
  assert.deepEqual(args, ['--bg', '--name', `tl-app-${record.handoff_id.slice(0, 8)}`, '--effort', 'high',
    '--permission-mode', 'acceptEdits', '--settings', '{"worktree":{"bgIsolation":"none"}}'],
    '指示は起動時に渡さない。モデルは transcript が無いので付かない');
  assert.equal(options.cwd, '/work/app');
  assert.deepEqual(options.env, { PATH: '/bin', CLAUDE_CODE_USE_BEDROCK: '1' }, '会話ごとの環境変数は後継へ渡さない');

  assert.equal(calls.send.length, 1);
  assert.deepEqual(calls.send[0].target, { socket_path: '/tmp/cc-socks/271650.sock', token: 'secret-token' });
  assert.equal(calls.send[0].text, claudeContinuationInput(record));
  assert.match(calls.send[0].text, new RegExp(`^Throughline自動継続 ${record.handoff_id}\\n注入された記憶と元のユーザー依頼に従い、未完了の作業をそのまま継続してください。`));

  assert.deepEqual([record.state, record.error_code], ['sent', null]);
  assert.deepEqual(record.successor, { short_id: 'a41a97ae', session_id: SUCCESSOR });
  assert.deepEqual(readdirSync(join(dir, 'targets')), [], '受け口の控えは読んだら消す');
  assert.doesNotMatch(JSON.stringify(publicClaudeAutoHandoff(record)), /secret-token|cc-socks/);
  assert.doesNotMatch(readFileSync(join(dir, `${SESSION}.json`), 'utf8'), /secret-token/, 'token は記録に残さない');

  // 引き継ぎ済みの会話の道具は、後継を案内して止める
  const output = await stopClaudeTurnForHandoff({ payload: { session_id: SESSION, cwd: '/work/app' }, dir,
    launchWorker: async () => { throw new Error('must not launch again'); } });
  assert.match(output.stopReason, /引き継ぎ済みです.*claude attach a41a97ae/);
}));

test('worker: 止めた時点の依頼とモデルを transcript から写し、色付きの出力からも後継のIDを読む。後継が止められた時は元の依頼を運ぶ', () => withDir(async dir => {
  const sendOk = async () => ({ status: 'accepted', outcome_unknown: false, reason: 'receiver_confirmed' });
  const colored = () => ({ status: 0, stderr: '',
    stdout: 'backgrounded · \u001b[36ma41a97ae\u001b[39m · tl-app-1234\u001b[2m (idle — send a prompt to start)\u001b[22m\n' });
  const run = async (sessionId, transcriptPath, toolUseId) => {
    const db = makeBatonDb();
    requestClaudeAutoHandoff({ payload: { session_id: sessionId, trigger: 'auto', cwd: '/work/app', transcript_path: transcriptPath },
      env: {}, config: ENABLED, openDb: () => db, dir });
    await stopClaudeTurnForHandoff({ payload: { session_id: sessionId, cwd: '/work/app', transcript_path: transcriptPath,
      tool_use_id: toolUseId }, dir, launchWorker: async () => {} });
    const calls = [];
    const record = await runClaudeAutoHandoffWorker(sessionId, { dir, env: {}, send: sendOk, pollMs: 10, targetTimeoutMs: 300,
      transcriptTimeoutMs: 300,
      spawn: (command, args) => {
        calls.push(args);
        // 止めた道具の呼び出しは、hook の後で transcript に書かれる
        recordClaudeSuccessorTarget({ payload: { session_id: SUCCESSOR, source: 'startup', cwd: '/work/app' },
          env: { CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/cc-socks/1.sock' }, dir });
        return colored();
      } });
    return { record, calls };
  };

  // 対話の会話 A。止めた道具の行は、worker が待っている間に書かれる
  const transcriptA = join(dir, 'a.jsonl');
  writeFileSync(transcriptA, jsonl([
    user('14個のファイルを順に読んで', '2026-10-04T03:00:10Z'),
    assistant('part04 を読みました。', '2026-10-04T03:00:12Z', 'claude-opus-5'),
  ]));
  setTimeout(() => writeFileSync(transcriptA, jsonl([
    user('14個のファイルを順に読んで', '2026-10-04T03:00:10Z'),
    assistant('part04 を読みました。', '2026-10-04T03:00:12Z', 'claude-opus-5'),
    assistant('part05 を読みました。次に part06 を読みます。', '2026-10-04T03:00:14Z', 'claude-opus-5'),
    { type: 'assistant', message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'tool_use', id: 'toolu_6', name: 'Read', input: {} }] } },
  ])), 50);
  const first = await run(SESSION, transcriptA, 'toolu_6');
  assert.equal(first.record.state, 'sent');
  assert.equal(first.record.successor.short_id, 'a41a97ae');
  assert.equal(first.record.settings.model, 'claude-opus-5');
  assert.deepEqual(first.calls[0].slice(3, 5), ['--model', 'claude-opus-5']);
  assert.deepEqual(first.record.in_flight, {
    user: { content: '14個のファイルを順に読んで', timestamp: Date.parse('2026-10-04T03:00:10Z') },
    last_fragment: { content: 'part05 を読みました。次に part06 を読みます。', timestamp: Date.parse('2026-10-04T03:00:14Z') },
  }, '止めた道具の直前の発言まで出そろってから写す');

  // 後継 B が止められた時、最後の user 発言は A からの継続の指示。現在地には元の依頼を運ぶ
  const transcriptB = join(dir, 'b.jsonl');
  writeFileSync(transcriptB, jsonl([
    user(`Another Claude session sent a message:\n${claudeContinuationInput(first.record)}\n\nThis came from another Claude session — not typed by your user.`,
      '2026-10-04T03:01:00Z'),
    assistant('part09 を読みました。次に part10 を読みます。', '2026-10-04T03:01:20Z', 'claude-opus-5'),
    { type: 'assistant', message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'tool_use', id: 'toolu_10', name: 'Read', input: {} }] } },
  ]));
  rmSync(join(dir, 'targets'), { recursive: true, force: true });
  const second = await run(SUCCESSOR, transcriptB, 'toolu_10');
  assert.deepEqual(second.record.in_flight, {
    user: { content: '14個のファイルを順に読んで', timestamp: Date.parse('2026-10-04T03:00:10Z') },
    last_fragment: { content: 'part09 を読みました。次に part10 を読みます。', timestamp: Date.parse('2026-10-04T03:01:20Z') },
  });
}));

test('worker: 立ち上げ・受け口・配送の失敗は固定の理由を残し、結果が不明な配送は再送しない', () => withDir(async dir => {
  const sendOk = async () => ({ status: 'accepted', outcome_unknown: false, reason: 'receiver_confirmed' });
  const cases = [
    [{ spawn: () => ({ error: Object.assign(new Error('not found'), { code: 'ENOENT' }) }), send: sendOk }, 'failed', 'handoff_claude_cli_unavailable', 0],
    [{ spawn: () => ({ status: 1, stdout: '', stderr: 'Workspace not trusted' }), send: sendOk }, 'failed', 'handoff_successor_launch_failed', 0],
    [{ spawn: () => ({ status: 0, stdout: 'unexpected output', stderr: '' }), send: sendOk }, 'failed', 'handoff_successor_launch_failed', 0],
    [{ spawn: launchedOk, send: sendOk }, 'failed', 'handoff_successor_target_unavailable', 0],
    [{ spawn: launchedOk, onLaunched: successorStarts(dir),
      send: async () => ({ status: 'not_sent', outcome_unknown: false, reason: 'connect_failed' }) }, 'failed', 'handoff_delivery_connect_failed', 1],
    [{ spawn: launchedOk, onLaunched: successorStarts(dir),
      send: async () => ({ status: 'unknown', outcome_unknown: true, reason: 'unconfirmed' }) }, 'unknown', 'handoff_delivery_unconfirmed', 1],
  ];
  for (const [deps, state, code, sends] of cases) {
    rmSync(join(dir, `${SESSION}.json`), { force: true });
    rmSync(join(dir, `${SESSION}.claim`), { force: true });
    const { record, calls } = await runWorker(dir, deps);
    assert.deepEqual([record.state, record.error_code, calls.send.length], [state, code, sends], code);
  }
  // 結果が不明な引き継ぎは、次の道具でも立ち上げ直さない
  const launched = [];
  await stopClaudeTurnForHandoff({ payload: { session_id: SESSION, cwd: '/work/app' }, dir, launchWorker: async id => { launched.push(id); } });
  assert.deepEqual(launched, []);
  assert.equal((await runClaudeAutoHandoffWorker(SESSION, { dir, spawn: () => { throw new Error('must not spawn'); } })).state, 'unknown');
}));

test('SessionStart: 後継の立ち上げ中の引き継ぎがある project の、新しく始まった会話だけが受け口を控える', () => withDir(async dir => {
  const env = { CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/cc-socks/1.sock', CLAUDE_CODE_MESSAGING_TOKEN: 't' };
  const start = (overrides = {}, environment = env) => recordClaudeSuccessorTarget({
    payload: { session_id: SUCCESSOR, source: 'startup', cwd: '/work/app', ...overrides }, env: environment, dir });
  assert.equal(start(), false, '引き継ぎが無い');
  request(dir);
  assert.equal(start(), false, 'まだ旧い会話を止めていない');

  const write = fields => writeFileSync(join(dir, `${SESSION}.json`),
    JSON.stringify({ ...readClaudeAutoHandoff(SESSION, dir), ...fields }));
  write({ state: 'launching' });
  assert.equal(start({ cwd: '/work/other' }), false, '別の project');
  assert.equal(start({ source: 'resume' }), false);
  assert.equal(start({ source: 'compact' }), false);
  assert.equal(start({ agent_id: 'agent-1' }), false);
  assert.equal(start({}, {}), false, '受け口を持たない会話');
  assert.equal(start({ session_id: `grok:${SUCCESSOR}` }), false);
  assert.equal(start(), true);
  rmSync(join(dir, 'targets'), { recursive: true });

  write({ state: 'launched', successor: { short_id: 'a41a97ae', session_id: null } });
  assert.equal(start({ session_id: 'bbbbbbbb-0000-4000-8000-000000000001' }), false, '後継のIDと合わない会話');
  assert.equal(start(), true);
  write({ state: 'sent' });
  rmSync(join(dir, 'targets'), { recursive: true });
  assert.equal(start(), false, '送り終えた引き継ぎ');
}));

test('最初の指示: 後継だけが止めた時点の依頼を受け取り、この引き継ぎの配送だけが受領になる', () => withDir(async dir => {
  request(dir);
  await stopClaudeTurnForHandoff({ payload: { session_id: SESSION, cwd: '/work/app' }, dir, launchWorker: async () => {} });
  const accept = (overrides = {}) => acceptClaudeAutoContinuation({ predecessorId: SESSION, successorSessionId: SUCCESSOR, dir, ...overrides });
  assert.equal(accept(), null, '後継がまだ立っていない');
  const record = readClaudeAutoHandoff(SESSION, dir);
  const inFlight = { user: { content: '依頼', timestamp: 1 }, last_fragment: null };
  writeFileSync(join(dir, `${SESSION}.json`), JSON.stringify({ ...record, state: 'sending',
    successor: { short_id: 'a41a97ae', session_id: SUCCESSOR }, in_flight: inFlight }));
  assert.equal(accept({ successorSessionId: 'bbbbbbbb-0000-4000-8000-000000000001' }), null, '後継ではない会話');
  assert.equal(accept({ predecessorId: 'aaaaaaaa-0000-4000-8000-000000000009' }), null);
  assert.equal(accept({ predecessorId: `codex:${SESSION}` }), null);

  // 人が先に別の指示を打った時は、依頼は渡すが受領にはしない
  assert.deepEqual(accept({ prompt: '別の指示' }), { handoffId: record.handoff_id, projectPath: '/work/app', inFlight, transcriptPath: null });
  assert.equal(readClaudeAutoHandoff(SESSION, dir).accepted_at, null);
  accept({ prompt: `Another Claude session sent a message:\n${claudeContinuationInput(record)}`, now: 9_000 });
  assert.equal(readClaudeAutoHandoff(SESSION, dir).accepted_at, 9_000);
}));

test('公開CLI: --host claude は enable・disable・status・worker を受け取る', () => {
  assert.equal(parseAutoHandoffArgs(['status', '--json']).host, 'codex');
  assert.deepEqual(
    (({ action, host, project, json }) => ({ action, host, project, json }))(parseAutoHandoffArgs(['enable', '--host', 'claude', '--project', REPO_ROOT, '--json'])),
    { action: 'enable', host: 'claude', project: REPO_ROOT, json: true },
  );
  assert.equal(parseAutoHandoffArgs(['status', '--host', 'claude', '--operation', 'id']).operation, 'id');
  assert.equal(parseAutoHandoffArgs(['worker', '--host', 'claude', '--operation', SESSION]).action, 'worker');
  for (const args of [['resume', '--host', 'claude', '--operation', 'id'], ['detail', '--host', 'claude', '--operation', 'id', '--origin', 'A', '--turn', '1'],
    ['worker', '--host', 'claude'], ['status', '--host', 'grok'], ['status', '--host'], ['disable', '--host', 'claude', '--project', REPO_ROOT]]) {
    assert.throws(() => parseAutoHandoffArgs(args), JSON.stringify(args));
  }
});

// ---- 実際の CLI を temp HOME で動かす ----

function childEnv(home, extra = {}) {
  // 設定とstateの置き場も一時HOMEへ向ける（本物のruntime error storeへ書かない）。
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_STATE_HOME: join(home, '.local', 'state'),
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
    THROUGHLINE_NO_VSCODE: '1',
    CLAUDE_PROJECT_DIR: '',
    CLAUDE_CODE_ENTRYPOINT: 'cli',
    CLAUDE_CODE_MESSAGING_SOCKET: '',
    CLAUDE_CODE_MESSAGING_TOKEN: '',
    ...extra,
  };
}

function cli(home, args, input = '', extra = {}) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd: REPO_ROOT, env: childEnv(home, extra), input, encoding: 'utf8' });
}

/** 本物の claude を起動させない。すぐ失敗する偽物を PATH の先頭に置く。 */
function fakeClaudePath(home) {
  const bin = join(home, 'fake-bin');
  mkdirSync(bin, { recursive: true });
  if (process.platform === 'win32') writeFileSync(join(bin, 'claude.cmd'), '@echo off\r\nexit /b 1\r\n');
  else {
    writeFileSync(join(bin, 'claude'), '#!/bin/sh\nexit 1\n');
    chmodSync(join(bin, 'claude'), 0o755);
  }
  const pathKey = Object.keys(process.env).find(key => key.toLowerCase() === 'path') ?? 'PATH';
  return { [pathKey]: `${bin}${delimiter}${process.env[pathKey] ?? ''}` };
}

test('公開CLI: enable は2つの hook と設定を書き、disable は自分の hook だけを外す。Codex の設定には触らない', () => withDir(home => {
  const settingsPath = join(home, '.claude', 'settings.json');
  mkdirSync(dirname(settingsPath), { recursive: true });
  // 他製品の hook と、0.13.0 が置いた PreCompact がある状態から始める
  const others = { PreCompact: [{ hooks: [{ type: 'command', command: 'other-product pre-compact' }] }],
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'rtk hook claude' }] }] };
  writeFileSync(settingsPath, JSON.stringify({ model: 'sonnet', hooks: {
    PreCompact: [{ hooks: [{ type: 'command', command: 'throughline pre-compact' }] }, ...others.PreCompact],
    PreToolUse: others.PreToolUse } }));

  const before = JSON.parse(cli(home, ['auto-handoff', 'status', '--host', 'claude', '--json']).stdout);
  assert.deepEqual(before, { host: 'claude', config: { schema: 'throughline.claude-auto-handoff.v1', enabled: false, projects: [] },
    hooks: { registered: false }, handoffs: [] });
  assert.equal(existsSync(join(home, '.throughline')), false, 'status は何も作らない');

  const enabled = cli(home, ['auto-handoff', 'enable', '--host', 'claude', '--json']);
  assert.equal(enabled.status, 0, enabled.stderr);
  assert.equal(JSON.parse(enabled.stdout).status, 'enabled');
  const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  assert.equal(settings.model, 'sonnet');
  assert.deepEqual(settings.hooks, {
    PreCompact: [...others.PreCompact, { hooks: [{ type: 'command', command: 'throughline pre-compact' }] }],
    PreToolUse: [...others.PreToolUse, { hooks: [{ type: 'command', command: 'throughline pre-tool-use', timeout: 15 }] }],
  });
  const again = cli(home, ['auto-handoff', 'enable', '--host', 'claude', '--json']);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(readFileSync(settingsPath, 'utf8'), JSON.stringify(settings, null, 2) + '\n', '2回目は書き換えない');

  assert.equal(cli(home, ['auto-handoff', 'status', '--host', 'claude']).stdout,
    '自動継続: 有効（Claude Code）\nhook（PreCompact・PreToolUse）: 登録済み\n');
  assert.equal(existsSync(join(home, '.throughline', 'codex-auto-handoff.json')), false);
  assert.equal(JSON.parse(cli(home, ['auto-handoff', 'status', '--json']).stdout).config.enabled, false, 'Codex は無効のまま');

  const disabled = JSON.parse(cli(home, ['auto-handoff', 'disable', '--host', 'claude', '--json']).stdout);
  assert.equal(disabled.config.enabled, false);
  assert.deepEqual(JSON.parse(readFileSync(settingsPath, 'utf8')).hooks, others);
  const unsupported = cli(home, ['auto-handoff', 'resume', '--host', 'claude', '--operation', 'x', '--json']);
  assert.equal(unsupported.status, 1);
  assert.deepEqual(JSON.parse(unsupported.stdout), { status: 'failed', code: 'auto_handoff_action_unsupported' });
}));

test('hook: 自動圧縮を止め、次の道具を止めて worker を起動し、後継の最初の指示へ止めた時点の依頼と記憶を注入する', () => withDir(async home => {
  const project = join(home, 'project');
  mkdirSync(project, { recursive: true });
  const transcriptPath = join(home, 'transcript.jsonl');
  const base = Date.parse('2026-10-04T03:00:00Z');
  const at = seconds => new Date(base + seconds * 1000).toISOString();
  writeFileSync(transcriptPath, jsonl([
    user('成果物の1行目には必ず「約束: MANGO-4417」と書くこと', at(0)),
    assistant('了解しました。', at(1)),
    user('big1.txt と big2.txt を読んで result.txt を作って', at(10)),
    toolUse('toolu_1', 'Read'),
    toolResult('toolu_1', 'big1 contents'),
    assistant('big1.txt を読み終えました。次に big2.txt を読みます。', at(12)),
    toolUse('toolu_2', 'Read'),
  ]));
  const extra = fakeClaudePath(home);
  const hook = (command, payload, sessionId = SESSION) =>
    cli(home, [command], JSON.stringify({ session_id: sessionId, cwd: project, transcript_path: transcriptPath, ...payload }), extra);
  const status = () => JSON.parse(cli(home, ['auto-handoff', 'status', '--host', 'claude', '--json']).stdout).handoffs;

  assert.equal(cli(home, ['auto-handoff', 'enable', '--host', 'claude', '--project', project, '--json']).status, 0);
  assert.equal(hook('session-start', { hook_event_name: 'SessionStart', source: 'startup' }).status, 0);

  // 記録が無い間、道具の hook は何も出さずに終わる
  const idle = hook('pre-tool-use', { hook_event_name: 'PreToolUse', tool_name: 'Read' });
  assert.deepEqual([idle.status, idle.stdout, idle.stderr], [0, '', '']);
  // 手動の /compact は止めない
  const manual = hook('pre-compact', { hook_event_name: 'PreCompact', trigger: 'manual' });
  assert.deepEqual([manual.status, manual.stdout], [0, '']);

  // 自動圧縮: 止める（exit code 2）
  const pre = hook('pre-compact', { hook_event_name: 'PreCompact', trigger: 'auto' });
  assert.equal(pre.status, 2, pre.stderr);
  assert.equal(pre.stdout, '');
  assert.match(pre.stderr, /Throughlineが自動圧縮を止めました。新しい会話へ引き継ぎます/);
  assert.deepEqual(status().map(item => item.state), ['requested']);

  // 次の道具: 実行させずに止め、worker を起動する
  const stopped = hook('pre-tool-use', { hook_event_name: 'PreToolUse', tool_name: 'Read', permission_mode: 'acceptEdits' });
  assert.equal(stopped.status, 0, stopped.stderr);
  const output = JSON.parse(stopped.stdout);
  assert.equal(output.continue, false);
  assert.equal(output.hookSpecificOutput.permissionDecision, 'deny');
  // worker は偽の claude（すぐ失敗）で止まる。本物の claude は起動しない
  let handoff;
  for (let i = 0; i < 100 && (handoff = status()[0]).state !== 'failed'; i++) await new Promise(r => setTimeout(r, 100));
  assert.deepEqual([handoff.state, handoff.error_code], ['failed', 'handoff_successor_launch_failed']);

  // 後継が立って指示が届いた場面を、記録を進めて再現する
  const handoffDir = join(home, '.throughline', 'claude-auto-handoff');
  const recordFile = join(handoffDir, `${SESSION}.json`);
  const record = JSON.parse(readFileSync(recordFile, 'utf8'));
  assert.equal(record.settings.permission_mode, 'acceptEdits');
  writeFileSync(recordFile, JSON.stringify({ ...record, state: 'launching', error_code: null }));
  const started = hook('session-start', { hook_event_name: 'SessionStart', source: 'startup' }, SUCCESSOR);
  assert.equal(started.status, 0, started.stderr);
  assert.equal(started.stdout, '');
  assert.equal(existsSync(join(handoffDir, 'targets')), false, '受け口を持たない会話は控えない');
  const withSocket = cli(home, ['session-start'], JSON.stringify({ session_id: SUCCESSOR, cwd: project, hook_event_name: 'SessionStart', source: 'startup' }),
    { ...extra, CLAUDE_CODE_MESSAGING_SOCKET: join(home, 'in.sock'), CLAUDE_CODE_MESSAGING_TOKEN: 'secret-token' });
  assert.equal(withSocket.status, 0, withSocket.stderr);
  assert.deepEqual(readdirSync(join(handoffDir, 'targets')), [`${SUCCESSOR}.json`]);
  writeFileSync(recordFile, JSON.stringify({ ...record, state: 'sending', error_code: null,
    successor: { short_id: SUCCESSOR.slice(0, 8), session_id: SUCCESSOR } }));

  const prompt = `Another Claude session sent a message:\n${claudeContinuationInput(record)}`;
  const first = cli(home, ['prompt-submit'], JSON.stringify({ session_id: SUCCESSOR, cwd: project, hook_event_name: 'UserPromptSubmit', prompt }), extra);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /^## Throughline: 自動継続の文脈\n/);
  assert.match(first.stdout, /### 現在地 \(作業の途中で止めたターン\)\n\*\*作業中のユーザー依頼\*\* \[\d\d:\d\d:\d\d\]: big1\.txt と big2\.txt を読んで result\.txt を作って\n/);
  assert.match(first.stdout, /\*\*止める直前のあなたの発言\*\* \[\d\d:\d\d:\d\d\]: big1\.txt を読み終えました。次に big2\.txt を読みます。\n/);
  assert.match(first.stdout, /\[user\]: 成果物の1行目には必ず「約束: MANGO-4417」と書くこと\n/);
  assert.doesNotMatch(first.stdout, /宣言|\/clear/);
  assert.ok(first.stdout.length <= 9_501);
  assert.ok(JSON.parse(readFileSync(recordFile, 'utf8')).accepted_at > 0, '届いた指示で受領を記録する');

  // 記憶は後継へ合流している（今の /tl の引き継ぎと同じ）
  const db = new DatabaseSync(join(home, '.throughline', 'throughline.db'));
  assert.equal(db.prepare('SELECT merged_into FROM sessions WHERE session_id = ?').get(SESSION).merged_into, SUCCESSOR);
  assert.deepEqual(db.prepare('SELECT DISTINCT session_id FROM bodies').all().map(row => row.session_id), [SUCCESSOR]);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM handoff_batons').get().c, 0);
  db.close();

  const decisions = readFileSync(join(home, '.throughline', 'logs', 'inheritance-decision.log'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(decisions.filter(entry => entry.phase === 'pre-compact').map(entry => [entry.trigger, entry.auto_continuation, entry.skip_reason]),
    [['manual', 'skipped', 'manual_compact'], ['auto', 'requested', null]]);
  assert.equal(decisions.filter(entry => entry.phase === 'pre-tool-use-stop').length, 1);
  const merged = decisions.find(entry => entry.phase === 'prompt-submit' && entry.merged);
  assert.deepEqual([merged.triggered_path, merged.injection.auto_handoff_id], ['baton', record.handoff_id]);
}));

test('hook: 自動継続が無効な時、自動圧縮を止めず、何も残さない', () => withDir(home => {
  const project = join(home, 'project');
  mkdirSync(project, { recursive: true });
  const payload = { session_id: SESSION, cwd: project, hook_event_name: 'PreCompact', trigger: 'auto' };
  const pre = cli(home, ['pre-compact'], JSON.stringify(payload));
  assert.deepEqual([pre.status, pre.stdout, pre.stderr], [0, '', '']);
  assert.equal(existsSync(join(home, '.throughline', 'claude-auto-handoff')), false);
  assert.equal(existsSync(join(home, '.throughline', 'throughline.db')), false, '無効な時は DB も開かない');
}));

test('hook: 自分の失敗では圧縮も道具も止めず（exit code 1）、理由を端末に残す', () => withDir(home => {
  const compact = cli(home, ['pre-compact'], '{"trigger":"auto"}');
  assert.deepEqual([compact.status, compact.stdout], [1, '']);
  const tool = cli(home, ['pre-tool-use'], '{not json');
  assert.deepEqual([tool.status, tool.stdout], [1, '']);
  const log = readFileSync(join(home, '.throughline', 'logs', 'hook-failures.log'), 'utf8');
  assert.match(log, /HOOK_PRE_COMPACT_FAILED/);
  assert.match(log, /Missing session_id in PreCompact payload/);
  assert.match(log, /HOOK_PRE_TOOL_USE_FAILED/);
}));
