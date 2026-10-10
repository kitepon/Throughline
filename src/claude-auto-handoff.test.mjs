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
  acceptClaudeAutoContinuation,
  runClaudeAutoHandoffWorker,
  readClaudeAutoHandoff,
  listClaudeAutoHandoffs,
  publicClaudeAutoHandoff,
  claudeContinuationInput,
  requestClaudeDesktopOpen,
  runClaudeDesktopOpen,
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
const toolUse = (id, name, input = {}) =>
  ({ type: 'assistant', message: { role: 'assistant', model: 'claude-fable-5-1', content: [{ type: 'tool_use', id, name, input }] } });
const toolResult = (id, text) => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] } });
const jsonl = entries => entries.map(entry => JSON.stringify(entry)).join('\n') + '\n';

function request(dir, overrides = {}) {
  const db = overrides.db ?? makeBatonDb();
  const result = requestClaudeAutoHandoff({
    payload: { session_id: SESSION, trigger: 'auto', cwd: '/work/app', transcript_path: overrides.transcriptPath ?? null,
      ...overrides.payload },
    env: overrides.env ?? {}, config: overrides.config ?? ENABLED, openDb: () => db, dir, now: overrides.now ?? 1_000,
    // 試験の project は POSIX の書き方（/work/app）。Windows の CI でも同じ値で比べる
    platform: overrides.platform ?? 'linux',
  });
  return { result, db };
}

test('PreCompact: 会話が別の project へ移っている時は、移った先で有効かどうかを決める（Claude Desktop）', () => withDir(dir => {
  // Desktop は「フォルダなし」で始めた会話を後から project へ移す。CLAUDE_PROJECT_DIR は移る前のまま届く。
  const scratch = '/Users/kite/Library/Application Support/Claude/scratch-workspaces/a/b/scratch-2026-10-05-ac3fa8';
  const moved = '/Users/kite/tl-claude-probe';
  const transcriptPath = join(dir, 'moved.jsonl');
  writeFileSync(transcriptPath, jsonl([user('読んで', '2026-10-05T22:38:17.050Z'), assistant('読みました', '2026-10-05T22:39:18.926Z'),
    { type: 'relocated', sessionId: SESSION, relocatedCwd: moved }]));
  const onlyMoved = { enabled: true, projects: [moved] };
  // SessionStart は移る前の場所で sessions の行を作っている
  const relocatedDb = makeBatonDb();
  relocatedDb.exec('CREATE TABLE sessions (session_id TEXT PRIMARY KEY, project_path TEXT NOT NULL)');
  relocatedDb.prepare('INSERT INTO sessions VALUES (?, ?)').run(SESSION, scratch);

  const { result, db } = request(dir, { db: relocatedDb, config: onlyMoved, transcriptPath, env: { CLAUDE_PROJECT_DIR: scratch }, payload: { cwd: moved } });
  assert.equal(result.status, 'requested');
  assert.equal(result.block, true);
  assert.equal(result.projectPath, moved);
  assert.equal(readClaudeAutoHandoff(SESSION, dir).project_path, moved);
  assert.equal(db.prepare('SELECT session_id FROM handoff_batons WHERE project_path = ?').get(moved).session_id, SESSION);
  assert.equal(db.prepare('SELECT project_path FROM sessions WHERE session_id = ?').get(SESSION).project_path, moved,
    '後継は同じ project の前任だけを合流させるので、sessions の project も移った先にそろえる');
}));

test('PreCompact: 移っていない会話は、これまでどおり起動した project で決める', () => withDir(dir => {
  const transcriptPath = join(dir, 'plain.jsonl');
  writeFileSync(transcriptPath, jsonl([user('読んで', '2026-10-05T22:38:17.050Z'), assistant('読みました', '2026-10-05T22:39:18.926Z')]));
  const { result } = request(dir, { config: { enabled: true, projects: ['/work/app/sub'] }, transcriptPath,
    env: { CLAUDE_PROJECT_DIR: '/work/app' }, payload: { cwd: '/work/app/sub' } });
  assert.equal(result.status, 'skipped');
  assert.equal(result.reason, 'auto_handoff_disabled');
  assert.equal(result.projectPath, '/work/app');
}));

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

test('PreCompact: Windows の `C:/…` の形の project は、後継が印を探す時の書き方（`C:\\…`）にそろえて残す', () => withDir(dir => {
  const db = makeBatonDb();
  const result = requestClaudeAutoHandoff({
    // Windows の Git Bash で走る hook には、project の場所が `C:/…` の形で渡る（実機では CLAUDE_PROJECT_DIR）
    payload: { session_id: SESSION, trigger: 'auto', cwd: 'C:/Users/k/proj/' },
    env: {}, platform: 'win32',
    config: { enabled: true, projects: [] }, openDb: () => db, dir, now: 1_000,
  });
  assert.equal(result.status, 'requested');
  assert.equal(result.projectPath, 'C:\\Users\\k\\proj');
  assert.equal(db.prepare('SELECT project_path FROM handoff_batons').get().project_path, 'C:\\Users\\k\\proj');
  assert.equal(readClaudeAutoHandoff(SESSION, dir).project_path, 'C:\\Users\\k\\proj');
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

test('PreCompact: 後継の会話が残っている引き継ぎの記録は、期限を過ぎても消さない', () => withDir(dir => {
  const now = Date.parse('2026-10-04T12:00:00Z');
  const old = new Date(now - 25 * 3_600_000);
  const projects = join(dir, 'claude', 'projects');
  mkdirSync(join(projects, '-work-app'), { recursive: true }); mkdirSync(join(projects, '-moved-app'), { recursive: true });
  const record = (id, fields) => {
    writeFileSync(join(dir, `${id}.json`), JSON.stringify({ schema: 'throughline.claude-auto-handoff.v2', handoff_id: `h-${id}`,
      source_session_id: id, project_path: '/work/app', transcript_path: join(projects, '-work-app', `${id}.jsonl`),
      state: 'sent', successor: { short_id: 'bbbbbbbb', session_id: `bbbbbbbb-${id.slice(9)}` }, ...fields }));
    utimesSync(join(dir, `${id}.json`), old, old);
    return fields?.successor?.session_id ?? `bbbbbbbb-${id.slice(9)}`;
  };
  const kept = 'aaaaaaaa-0000-4000-8000-000000000011', moved = 'aaaaaaaa-0000-4000-8000-000000000012';
  const gone = 'aaaaaaaa-0000-4000-8000-000000000013', unconfirmed = 'aaaaaaaa-0000-4000-8000-000000000014';
  const failed = 'aaaaaaaa-0000-4000-8000-000000000015';
  // 後継の transcript が、旧い会話と同じフォルダにある。別の project のフォルダにある（会話を移していた時）。
  writeFileSync(join(projects, '-work-app', `${record(kept)}.jsonl`), '');
  writeFileSync(join(projects, '-moved-app', `${record(moved)}.jsonl`), '');
  // 後継が消されている。受領を確かめられなかった（後継の session id が無い）。立ち上げに失敗した。
  record(gone);
  record(unconfirmed, { state: 'unknown', successor: { short_id: 'bbbbbbbb', session_id: null } });
  writeFileSync(join(projects, '-work-app', `${record(failed, { state: 'failed' })}.jsonl`), '');
  request(dir, { now });
  assert.deepEqual(readdirSync(dir).filter(name => name.endsWith('.json')).sort(), [`${SESSION}.json`, `${kept}.json`, `${moved}.json`].sort());
  // 残した記録の会話は、圧縮と道具を止め続ける。同じ会話から2つ目の後継は立たない。
  assert.equal(request(dir, { now, payload: { session_id: kept } }).result.status, 'already_requested');
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

/** 止めた直後の記録を作り、後継の起動を差し替えて worker を走らせる。 */
async function runWorker(dir, { spawn, onLaunched }) {
  request(dir);
  await stopClaudeTurnForHandoff({ payload: { session_id: SESSION, cwd: '/work/app', permission_mode: 'acceptEdits',
    effort: { level: 'high' } }, dir, launchWorker: async () => {} });
  const calls = { spawn: [] };
  const record = await runClaudeAutoHandoffWorker(SESSION, {
    dir, env: { PATH: '/bin', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'claude-desktop', CLAUDE_CODE_MESSAGING_SOCKET: '/old.sock',
      CLAUDE_CODE_MESSAGING_TOKEN: 'old-token', CLAUDE_PROJECT_DIR: '/work/app', CLAUDE_CODE_USE_BEDROCK: '1' },
    acceptTimeoutMs: 300, pollMs: 10,
    spawn: (command, args, options) => {
      calls.spawn.push({ command, args, options });
      const result = spawn(command, args, options);
      if (result.status === 0) onLaunched?.(args);
      return result;
    },
  });
  return { record, calls };
}

const launchedOk = () => ({ status: 0, stdout: 'Starting background service…\nbackgrounded · a41a97ae · tl-app-1234\n', stderr: '' });
// 後継の最初の UserPromptSubmit。起動時に渡された指示で、受領を残す。worker が後継の ID を記録へ写す前に届く。
const successorStarts = (dir, predecessorId = SESSION) => args => acceptClaudeAutoContinuation({
  predecessorId, successorSessionId: SUCCESSOR, prompt: args.at(-1), dir, now: 5_000 });

test('worker: 継続の指示を最初の指示として付けて後継を同じprojectに立て、後継の受領を待つ', () => withDir(async dir => {
  const { record, calls } = await runWorker(dir, { spawn: launchedOk, onLaunched: successorStarts(dir) });
  assert.equal(calls.spawn.length, 1);
  const { command, args, options } = calls.spawn[0];
  assert.equal(command, 'claude');
  assert.deepEqual(args, ['--bg', '--name=app（自動引き継ぎ）', '--effort', 'high',
    '--permission-mode', 'acceptEdits', '--settings', '{"worktree":{"bgIsolation":"none"}}', claudeContinuationInput(record)],
    '指示は起動時に渡す（外から送ると、権限のバイパス中の後継が承認まで止める）。モデルは transcript が無いので付かない。' +
    '名前は、前任の題も依頼も読めないので project 名と印だけ');
  assert.match(args.at(-1), new RegExp(`^Throughline自動継続 ${record.handoff_id}\\n注入された記憶と元のユーザー依頼に従い、未完了の作業をそのまま継続してください。`));
  assert.equal(options.cwd, '/work/app');
  assert.deepEqual(options.env, { PATH: '/bin', CLAUDE_CODE_USE_BEDROCK: '1' }, '会話ごとの環境変数は後継へ渡さない');
  assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe'], 'stdin を渡さない（claude は stdin も指示に足す）');

  assert.deepEqual([record.state, record.error_code, record.accepted_at], ['sent', null, 5_000]);
  assert.deepEqual(record.successor, { short_id: 'a41a97ae', session_id: SUCCESSOR });
  assert.equal(existsSync(join(dir, `${SESSION}.accepted`)), false, '受領の控えは読んだら消す');
  assert.equal(existsSync(join(dir, 'targets')), false, '受け口は控えない');

  // 引き継ぎ済みの会話の道具は、後継を案内して止める
  const output = await stopClaudeTurnForHandoff({ payload: { session_id: SESSION, cwd: '/work/app' }, dir,
    launchWorker: async () => { throw new Error('must not launch again'); } });
  assert.match(output.stopReason, /引き継ぎ済みです.*claude attach a41a97ae/);
}));

test('worker: 止めた時点の依頼とモデルを transcript から写し、色付きの出力からも後継のIDを読む。後継が止められた時は元の依頼を運ぶ', () => withDir(async dir => {
  const colored = () => ({ status: 0, stderr: '',
    stdout: 'backgrounded · \u001b[36ma41a97ae\u001b[39m · tl-app-1234\u001b[2m\u001b[22m\n' });
  const run = async (sessionId, transcriptPath, toolUseId) => {
    const db = makeBatonDb();
    requestClaudeAutoHandoff({ payload: { session_id: sessionId, trigger: 'auto', cwd: '/work/app', transcript_path: transcriptPath },
      env: {}, config: ENABLED, openDb: () => db, dir, platform: 'linux' });
    await stopClaudeTurnForHandoff({ payload: { session_id: sessionId, cwd: '/work/app', transcript_path: transcriptPath,
      tool_use_id: toolUseId }, dir, launchWorker: async () => {} });
    const calls = [];
    const record = await runClaudeAutoHandoffWorker(sessionId, { dir, env: {}, pollMs: 10, acceptTimeoutMs: 300,
      transcriptTimeoutMs: 300,
      spawn: (command, args) => {
        calls.push(args);
        // 止めた道具の呼び出しは、hook の後で transcript に書かれる
        successorStarts(dir, sessionId)(args);
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
  assert.deepEqual(first.calls[0].slice(1, 4), ['--name=app｜14個のファイルを順に読んで（自動引き継ぎ）', '--model', 'claude-opus-5'],
    '前任に題が無い時は、元の依頼を名前の概要にする');
  assert.deepEqual(first.record.in_flight, {
    user: { content: '14個のファイルを順に読んで', timestamp: Date.parse('2026-10-04T03:00:10Z') },
    last_fragment: { content: 'part05 を読みました。次に part06 を読みます。', timestamp: Date.parse('2026-10-04T03:00:14Z') },
    steps: [
      { kind: 'text', content: 'part04 を読みました。', timestamp: Date.parse('2026-10-04T03:00:12Z') },
      { kind: 'text', content: 'part05 を読みました。次に part06 を読みます。', timestamp: Date.parse('2026-10-04T03:00:14Z') },
    ],
    earlier_steps: null,
    stopped_tools: [{ name: 'Read', target: '' }],
    stopped_tools_total: 1,
    turn: null,
  }, '止めた道具の直前の発言まで出そろってから写す');

  // 後継 B が止められた時、最後の user 発言は A からの継続の指示。現在地には元の依頼を運ぶ
  const transcriptB = join(dir, 'b.jsonl');
  writeFileSync(transcriptB, jsonl([
    // `--name` で立てた会話には、Claude Code が名前を題として書く
    { type: 'custom-title', customTitle: first.calls[0][1].slice('--name='.length), sessionId: SUCCESSOR },
    user(claudeContinuationInput(first.record), '2026-10-04T03:01:00Z'),
    assistant('part09 を読みました。次に part10 を読みます。', '2026-10-04T03:01:20Z', 'claude-opus-5'),
    { type: 'assistant', message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'tool_use', id: 'toolu_10', name: 'Read', input: {} }] } },
  ]));
  const second = await run(SUCCESSOR, transcriptB, 'toolu_10');
  assert.deepEqual(second.record.in_flight, {
    user: { content: '14個のファイルを順に読んで', timestamp: Date.parse('2026-10-04T03:00:10Z') },
    last_fragment: { content: 'part09 を読みました。次に part10 を読みます。', timestamp: Date.parse('2026-10-04T03:01:20Z') },
    steps: [{ kind: 'text', content: 'part09 を読みました。次に part10 を読みます。', timestamp: Date.parse('2026-10-04T03:01:20Z') }],
    earlier_steps: null,
    stopped_tools: [{ name: 'Read', target: '' }],
    stopped_tools_total: 1,
    turn: null,
  });
  assert.equal(second.calls[0][1], first.calls[0][1], '引き継ぎを重ねても、project 名と印は積み重ならない');
}));

test('worker: 後継の名前は project 名・前任の題・自動引き継ぎの印で作る。人が付けた題を Claude Code の題より先に使う', () => withDir(async dir => {
  const nameFor = async (sessionId, titleLines) => {
    const transcriptPath = join(dir, `${sessionId}.jsonl`);
    writeFileSync(transcriptPath, jsonl([
      user('14個のファイルを順に読んで', '2026-10-04T03:00:10Z'),
      ...titleLines,
      assistant('part04 を読みました。', '2026-10-04T03:00:12Z'),
    ]));
    const db = makeBatonDb();
    requestClaudeAutoHandoff({ payload: { session_id: sessionId, trigger: 'auto', cwd: '/work/app', transcript_path: transcriptPath },
      env: {}, config: ENABLED, openDb: () => db, dir, platform: 'linux' });
    await stopClaudeTurnForHandoff({ payload: { session_id: sessionId, cwd: '/work/app', transcript_path: transcriptPath },
      dir, launchWorker: async () => {} });
    let name = null;
    await runClaudeAutoHandoffWorker(sessionId, { dir, env: {}, pollMs: 10, acceptTimeoutMs: 300, transcriptTimeoutMs: 50,
      spawn: (command, args) => { name = args[1]; successorStarts(dir, sessionId)(args); return launchedOk(); } });
    return name;
  };
  // 端末の会話: Claude Code が付けた題（新しい方）
  assert.equal(await nameFor('aaaaaaaa-0000-4000-8000-000000000001', [
    { type: 'ai-title', aiTitle: 'ファイルの読み込み' }, { type: 'ai-title', aiTitle: '14ファイル順序読み込みと結果記録' },
  ]), '--name=app｜14ファイル順序読み込みと結果記録（自動引き継ぎ）');
  // Claude Desktop の会話と、人が名前を変えた会話: 題は custom-title に入る
  assert.equal(await nameFor('aaaaaaaa-0000-4000-8000-000000000002', [
    { type: 'custom-title', customTitle: 'MCP共有ラッパー設計' }, { type: 'ai-title', aiTitle: '別の題' },
  ]), '--name=app｜MCP共有ラッパー設計（自動引き継ぎ）');
  // 改行・二重引用符・長い題は、1行の引数として渡せる形にする
  assert.equal(await nameFor('aaaaaaaa-0000-4000-8000-000000000003', [
    { type: 'custom-title', customTitle: `"結果" を\n${'長'.repeat(60)}` },
  ]), '--name=app｜結果 を（自動引き継ぎ）');
}));

function makeMemoryDb() {
  const db = makeBatonDb();
  db.exec(`
    CREATE TABLE sessions (session_id TEXT PRIMARY KEY, merged_into TEXT);
    CREATE TABLE bodies (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, origin_session_id TEXT NOT NULL,
      turn_number INTEGER NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL, token_count INTEGER, created_at INTEGER NOT NULL,
      turn_start TEXT, UNIQUE(session_id, origin_session_id, turn_number, role));
    CREATE TABLE details (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, origin_session_id TEXT,
      turn_number INTEGER, tool_name TEXT NOT NULL, input_text TEXT, output_text TEXT, token_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, kind TEXT, source_id TEXT);
    CREATE UNIQUE INDEX uq_details_source ON details(session_id, origin_session_id, source_id) WHERE source_id IS NOT NULL;
  `);
  return db;
}

test('worker: 止めたターンを DB へ取り込み、ここまでにしたことと、実行されなかった道具を記録へ写す', () => withDir(async dir => {
  const block = (id, content, timestamp) =>
    ({ type: 'assistant', timestamp, message: { id, role: 'assistant', model: 'claude-opus-5', content: [content] } });
  const result = (id, text, isError = false) =>
    ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text, ...(isError ? { is_error: true } : {}) }] } });
  const transcript = join(dir, 'work.jsonl');
  writeFileSync(transcript, jsonl([
    user('前の依頼', '2026-10-04T02:00:00Z'),
    assistant('前の回答', '2026-10-04T02:00:05Z', 'claude-opus-5'),
    user('a.mjs を直して', '2026-10-04T03:00:00Z'),
    block('m1', { type: 'text', text: '読みます。' }, '2026-10-04T03:00:01Z'),
    block('m1', { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/work/a.mjs' } }, '2026-10-04T03:00:01Z'),
    result('t1', 'export const a = 1;'),
    block('m2', { type: 'text', text: '直します。' }, '2026-10-04T03:00:03Z'),
    block('m2', { type: 'tool_use', id: 't2', name: 'Edit', input: { file_path: '/work/app/src/a.mjs', old_string: '1', new_string: '2' } }, '2026-10-04T03:00:03Z'),
    result('t2', 'ok'),
    block('m3', { type: 'tool_use', id: 't3', name: 'Bash', input: { command: 'npm test\n  --silent' } }, '2026-10-04T03:00:05Z'),
    result('t3', 'Exit code 1', true),
    // ここで自動圧縮を止めた。次の応答が呼んだ道具は、2つとも実行されていない
    block('m4', { type: 'text', text: '試験が落ちました。\n原因を見ます。' }, '2026-10-04T03:00:08Z'),
    block('m4', { type: 'tool_use', id: 't4', name: 'Read', input: { file_path: `/work/app/test/${'d'.repeat(200)}/a.test.mjs` } }, '2026-10-04T03:00:08Z'),
    block('m4', { type: 'tool_use', id: 't5', name: 'Grep', input: { pattern: 'expect\\(' } }, '2026-10-04T03:00:08Z'),
    result('t5', 'PreToolUse:Grep hook error', true),
    result('t4', 'PreToolUse:Read hook error', true),
  ]));
  const db = makeMemoryDb();
  requestClaudeAutoHandoff({ payload: { session_id: SESSION, trigger: 'auto', cwd: '/work/app', transcript_path: transcript },
    env: {}, config: ENABLED, openDb: () => db, dir, platform: 'linux' });
  // hook は並んで走る。記録に残る止めた道具は、応答の中の2つ目のこともある
  await stopClaudeTurnForHandoff({ payload: { session_id: SESSION, cwd: '/work/app', transcript_path: transcript, tool_use_id: 't5' },
    dir, launchWorker: async () => {} });
  const record = await runClaudeAutoHandoffWorker(SESSION, { dir, env: {}, pollMs: 10, acceptTimeoutMs: 300, transcriptTimeoutMs: 300,
    openDb: () => db,
    spawn: (command, args) => {
      successorStarts(dir)(args);
      return { status: 0, stderr: '', stdout: 'backgrounded · a41a97ae · tl-app\n' };
    } });
  assert.equal(record.state, 'sent');
  assert.deepEqual(record.in_flight.steps, [
    { kind: 'text', content: '読みます。', timestamp: Date.parse('2026-10-04T03:00:01Z') },
    { kind: 'tool', name: 'Read', target: '/work/a.mjs', failed: false },
    { kind: 'text', content: '直します。', timestamp: Date.parse('2026-10-04T03:00:03Z') },
    { kind: 'tool', name: 'Edit', target: 'src/a.mjs', failed: false },
    { kind: 'tool', name: 'Bash', target: 'npm test --silent', failed: true },
    { kind: 'text', content: '試験が落ちました。 原因を見ます。', timestamp: Date.parse('2026-10-04T03:00:08Z') },
  ], '前のターンは入れない。止めた道具は、ここまでにしたことに入れない。作業ディレクトリの中は相対で書く');
  assert.deepEqual(record.in_flight.stopped_tools, [
    { name: 'Read', target: `…${'d'.repeat(159 - '/a.test.mjs'.length)}/a.test.mjs` }, { name: 'Grep', target: 'expect\\(' }],
    '長い場所は末尾を残す');
  assert.equal(record.in_flight.stopped_tools_total, 2);
  assert.deepEqual(record.in_flight.turn, { origin_session_id: SESSION, turn_number: 5,
    user_at: Date.parse('2026-10-04T03:00:00Z'), assistant_at: Date.parse('2026-10-04T03:00:08Z'), details: 10 });
  assert.equal(publicClaudeAutoHandoff(record).in_flight_captured, true);
  assert.equal(JSON.stringify(publicClaudeAutoHandoff(record)).includes('a.mjs'), false, '道具の対象は外へ見せない');

  // DB: 止めたターンは、発言を全部つないだ本文と、道具の入出力（止めた道具を含む）で入る
  assert.deepEqual(db.prepare('SELECT session_id, turn_number, role, text, created_at FROM bodies ORDER BY id').all().map(row => ({ ...row })), [
    { session_id: SESSION, turn_number: 5, role: 'user', text: 'a.mjs を直して', created_at: Date.parse('2026-10-04T03:00:00Z') },
    { session_id: SESSION, turn_number: 5, role: 'assistant', text: '読みます。\n\n直します。\n\n試験が落ちました。\n原因を見ます。',
      created_at: Date.parse('2026-10-04T03:00:08Z') },
  ]);
  assert.deepEqual(db.prepare(`SELECT kind, tool_name, turn_number FROM details WHERE origin_session_id = ? ORDER BY id`).all(SESSION)
    .map(row => `${row.kind}:${row.tool_name}:${row.turn_number}`), [
    'tool_input:Read:5', 'tool_output:Read:5', 'tool_input:Edit:5', 'tool_output:Edit:5', 'tool_input:Bash:5', 'tool_output:Bash:5',
    'tool_input:Read:5', 'tool_input:Grep:5', 'tool_output:Grep:5', 'tool_output:Read:5']);
}));

test('worker: 止めたターンを取り込めなくても後継を立て、取り込めなかったことを記録に残す', () => withDir(async dir => {
  const transcript = join(dir, 'work.jsonl');
  writeFileSync(transcript, jsonl([user('依頼', '2026-10-04T03:00:00Z'), assistant('途中です。', '2026-10-04T03:00:02Z'), toolUse('toolu_1', 'Read')]));
  const db = makeBatonDb(); // bodies も sessions も無い
  requestClaudeAutoHandoff({ payload: { session_id: SESSION, trigger: 'auto', cwd: '/work/app', transcript_path: transcript },
    env: {}, config: ENABLED, openDb: () => db, dir, platform: 'linux' });
  await stopClaudeTurnForHandoff({ payload: { session_id: SESSION, cwd: '/work/app', transcript_path: transcript, tool_use_id: 'toolu_1' },
    dir, launchWorker: async () => {} });
  const record = await runClaudeAutoHandoffWorker(SESSION, { dir, env: {}, pollMs: 10, acceptTimeoutMs: 300, transcriptTimeoutMs: 300,
    openDb: () => db,
    spawn: (command, args) => {
      successorStarts(dir)(args);
      return { status: 0, stderr: '', stdout: 'backgrounded · a41a97ae · tl-app\n' };
    } });
  assert.equal(record.state, 'sent');
  assert.equal(record.in_flight.turn, null);
  assert.equal(record.in_flight.steps.length, 1);
  assert.equal(publicClaudeAutoHandoff(record).in_flight_captured, false);
}));

test('worker: 立ち上げの失敗は固定の理由を残し、受領を確かめられない時は後継を立て直さない', () => withDir(async dir => {
  const cases = [
    [{ spawn: () => ({ error: Object.assign(new Error('not found'), { code: 'ENOENT' }) }) }, 'failed', 'handoff_claude_cli_unavailable'],
    [{ spawn: () => ({ status: 1, stdout: '', stderr: 'Workspace not trusted' }) }, 'failed', 'handoff_successor_launch_failed'],
    [{ spawn: () => ({ status: 0, stdout: 'unexpected output', stderr: '' }) }, 'failed', 'handoff_successor_launch_failed'],
    // 後継は立ったが、最初の指示の受領が期限までに残らない
    [{ spawn: launchedOk }, 'unknown', 'handoff_delivery_unconfirmed'],
  ];
  for (const [deps, state, code] of cases) {
    rmSync(join(dir, `${SESSION}.json`), { force: true });
    rmSync(join(dir, `${SESSION}.claim`), { force: true });
    const { record } = await runWorker(dir, deps);
    assert.deepEqual([record.state, record.error_code], [state, code], code);
  }
  // 結果が不明な引き継ぎは、次の道具でも立ち上げ直さない
  const launched = [];
  await stopClaudeTurnForHandoff({ payload: { session_id: SESSION, cwd: '/work/app' }, dir, launchWorker: async id => { launched.push(id); } });
  assert.deepEqual(launched, []);
  assert.equal((await runClaudeAutoHandoffWorker(SESSION, { dir, spawn: () => { throw new Error('must not spawn'); } })).state, 'unknown');
}));

test('最初の指示: 後継だけが止めた時点の依頼を受け取り、この引き継ぎの指示だけが受領になる', () => withDir(async dir => {
  request(dir);
  await stopClaudeTurnForHandoff({ payload: { session_id: SESSION, cwd: '/work/app' }, dir, launchWorker: async () => {} });
  const accept = (overrides = {}) => acceptClaudeAutoContinuation({ predecessorId: SESSION, successorSessionId: SUCCESSOR, dir, ...overrides });
  const acceptance = () => existsSync(join(dir, `${SESSION}.accepted`))
    ? JSON.parse(readFileSync(join(dir, `${SESSION}.accepted`), 'utf8')) : null;
  const record = readClaudeAutoHandoff(SESSION, dir);
  const instruction = claudeContinuationInput(record);
  assert.equal(accept({ prompt: instruction }), null, '後継をまだ立てていない（stopped）');
  const inFlight = { user: { content: '依頼', timestamp: 1 }, last_fragment: null };
  const expected = { handoffId: record.handoff_id, projectPath: '/work/app', inFlight, transcriptPath: null };
  const write = fields => writeFileSync(join(dir, `${SESSION}.json`), JSON.stringify({ ...record, in_flight: inFlight, ...fields }));

  // 立ち上げ中（後継の ID はまだ記録に無い）: 指示が運ぶ引き継ぎ ID で後継と認める
  write({ state: 'launching' });
  assert.equal(accept(), null, '指示を持たない会話');
  assert.equal(accept({ prompt: '別の指示' }), null, '同じ project で人が始めた別の会話');
  assert.equal(accept({ prompt: 'Throughline自動継続 00000000-0000-4000-8000-000000000000\n…' }), null, '別の引き継ぎの指示');
  assert.equal(acceptance(), null);
  assert.deepEqual(accept({ prompt: instruction, now: 9_000 }), expected);
  assert.deepEqual(acceptance(), { handoff_id: record.handoff_id, successor_session_id: SUCCESSOR, accepted_at: 9_000 });
  assert.equal(readClaudeAutoHandoff(SESSION, dir).accepted_at, null, '記録は worker だけが書き換える');
  accept({ prompt: instruction, now: 9_999 });
  assert.equal(acceptance().accepted_at, 9_000, '受領は1回だけ残す');
  rmSync(join(dir, `${SESSION}.accepted`));

  // 後継の ID が記録に入った後: ID で後継と認める
  write({ state: 'launched', successor: { short_id: 'a41a97ae', session_id: null } });
  assert.equal(accept({ successorSessionId: 'bbbbbbbb-0000-4000-8000-000000000001', prompt: instruction }), null, '後継ではない会話');
  assert.equal(accept({ predecessorId: 'aaaaaaaa-0000-4000-8000-000000000009' }), null);
  assert.equal(accept({ predecessorId: `codex:${SESSION}` }), null);
  // 人が先に別の指示を打った時は、依頼は渡すが受領にはしない
  assert.deepEqual(accept({ prompt: '別の指示' }), expected);
  assert.equal(acceptance(), null);
  accept({ prompt: instruction, now: 9_500 });
  assert.equal(acceptance().accepted_at, 9_500);
}));

// ---- 後継を Claude Desktop で開く ----

function writeRecord(dir, sourceId, fields) {
  writeFileSync(join(dir, `${sourceId}.json`), JSON.stringify({ schema: 'throughline.claude-auto-handoff.v2', handoff_id: `h-${sourceId}`,
    source_session_id: sourceId, project_path: '/work/app', transcript_path: null, state: 'sent', requested_at: 1_000, updated_at: 1_000,
    settings: null, in_flight: null, successor: { short_id: SUCCESSOR.slice(0, 8), session_id: SUCCESSOR }, error_code: null, accepted_at: 2_000,
    desktop: { wanted: true, state: null, error_code: null, opened_at: null }, ...fields }));
}

test('PreCompact: Claude Desktop から始まった会話と、その後継の引き継ぎだけ、後継を Desktop で開く印を付ける（macOS）', () => withDir(dir => {
  const wanted = overrides => {
    rmSync(join(dir, `${SESSION}.json`), { force: true });
    request(dir, overrides);
    return readClaudeAutoHandoff(SESSION, dir).desktop;
  };
  const desktopTranscript = join(dir, 'desktop.jsonl');
  writeFileSync(desktopTranscript, jsonl([{ ...user('読んで', '2026-10-08T12:00:00.000Z'), entrypoint: 'claude-desktop' },
    { ...assistant('読みました', '2026-10-08T12:00:05.000Z'), entrypoint: 'claude-desktop' }]));
  const cliTranscript = join(dir, 'cli.jsonl');
  writeFileSync(cliTranscript, jsonl([{ ...user('読んで', '2026-10-08T12:00:00.000Z'), entrypoint: 'cli' }]));

  assert.deepEqual(wanted({ platform: 'darwin', transcriptPath: desktopTranscript }), { wanted: true, state: null, error_code: null, opened_at: null });
  assert.equal(wanted({ platform: 'darwin', env: { CLAUDE_CODE_ENTRYPOINT: 'claude-desktop' } }).wanted, true);
  assert.equal(wanted({ platform: 'darwin', transcriptPath: cliTranscript }).wanted, false, '端末から始めた会話の後継は、claude agents の一覧に出る');
  assert.equal(wanted({ platform: 'darwin' }).wanted, false);
  assert.equal(wanted({ platform: 'linux', transcriptPath: desktopTranscript }).wanted, false, 'Linux の Claude Code に --desktop は無い');
  assert.equal(wanted({ platform: 'linux', transcriptPath: desktopTranscript, env: { THROUGHLINE_AUTO_HANDOFF_OPEN: 'desktop' } }).wanted, false);
  assert.equal(wanted({ platform: 'win32', payload: { cwd: 'C:\\work\\app' }, env: { CLAUDE_CODE_ENTRYPOINT: 'claude-desktop' } }).wanted, true);
  assert.equal(wanted({ platform: 'win32', payload: { cwd: 'C:\\work\\app' } }).wanted, false);
  assert.equal(wanted({ platform: 'darwin', transcriptPath: cliTranscript, env: { THROUGHLINE_AUTO_HANDOFF_OPEN: 'desktop' } }).wanted, true);
  assert.equal(wanted({ platform: 'darwin', transcriptPath: desktopTranscript, env: { THROUGHLINE_AUTO_HANDOFF_OPEN: 'off' } }).wanted, false);

  // 裏で作業している後継がさらに引き継ぐ時は、元の会話の出どころを引き継ぐ（後継の transcript は cli）。
  writeRecord(dir, 'origin-desktop', { successor: { short_id: SESSION.slice(0, 8), session_id: SESSION } });
  assert.equal(wanted({ platform: 'darwin', transcriptPath: cliTranscript }).wanted, true);
  writeRecord(dir, 'origin-desktop', { successor: { short_id: SESSION.slice(0, 8), session_id: SESSION }, desktop: { wanted: false, state: null } });
  assert.equal(wanted({ platform: 'darwin', transcriptPath: cliTranscript }).wanted, false);
}));

test('PreToolUse: Desktop で開く引き継ぎは、止めた理由に、後継がターンを終えた時に Desktop へ開く事を書く', () => withDir(async dir => {
  const desktopTranscript = join(dir, 'desktop.jsonl');
  writeFileSync(desktopTranscript, jsonl([{ ...user('読んで', '2026-10-08T12:00:00.000Z'), entrypoint: 'claude-desktop' }]));
  request(dir, { platform: 'darwin', transcriptPath: desktopTranscript });
  const output = await stopClaudeTurnForHandoff({ payload: { session_id: SESSION, cwd: '/work/app', tool_use_id: 't1' }, dir, launchWorker: async () => 1 });
  assert.match(output.stopReason, /そのターンを終えた時にClaude Desktopへ開きます。途中の様子は `claude agents` の一覧で見られます。後継はリモートコントロール付きで立てるので、claude\.ai\/code とClaudeのアプリからも見られます。$/);
}));

test('PreCompact: Claude Desktop から始まった会話と、その後継の引き継ぎだけ、後継をリモートコントロール付きで立てる印を付ける（OS に関係なく）', () => withDir(dir => {
  const wanted = overrides => {
    rmSync(join(dir, `${SESSION}.json`), { force: true });
    request(dir, overrides);
    return readClaudeAutoHandoff(SESSION, dir).remote_control;
  };
  const desktopTranscript = join(dir, 'desktop.jsonl');
  writeFileSync(desktopTranscript, jsonl([{ ...user('読んで', '2026-10-10T05:00:00.000Z'), entrypoint: 'claude-desktop' }]));
  const cliTranscript = join(dir, 'cli.jsonl');
  writeFileSync(cliTranscript, jsonl([{ ...user('読んで', '2026-10-10T05:00:00.000Z'), entrypoint: 'cli' }]));
  for (const platform of ['darwin', 'win32', 'linux']) {
    const payload = platform === 'win32' ? { cwd: 'C:\\work\\app' } : undefined;
    assert.deepEqual(wanted({ platform, payload, transcriptPath: desktopTranscript }), { wanted: true, state: null }, platform);
    assert.equal(wanted({ platform, payload, env: { CLAUDE_CODE_ENTRYPOINT: 'claude-desktop' } }).wanted, true, platform);
    assert.equal(wanted({ platform, payload, transcriptPath: cliTranscript }).wanted, false, `${platform}: 端末から始めた会話の後継には付けない`);
    assert.equal(wanted({ platform, payload }).wanted, false, platform);
    assert.equal(wanted({ platform, payload, transcriptPath: cliTranscript, env: { THROUGHLINE_AUTO_HANDOFF_REMOTE_CONTROL: 'on' } }).wanted, true, platform);
    assert.equal(wanted({ platform, payload, transcriptPath: desktopTranscript, env: { THROUGHLINE_AUTO_HANDOFF_REMOTE_CONTROL: 'off' } }).wanted, false, platform);
  }
  // 裏で作業している後継がさらに引き継ぐ時は、元の会話の出どころを引き継ぐ（後継の transcript は cli）。
  writeRecord(dir, 'origin-desktop', { successor: { short_id: SESSION.slice(0, 8), session_id: SESSION }, remote_control: { wanted: true, state: 'requested' } });
  assert.equal(wanted({ platform: 'darwin', transcriptPath: cliTranscript }).wanted, true);
  writeRecord(dir, 'origin-desktop', { successor: { short_id: SESSION.slice(0, 8), session_id: SESSION }, remote_control: { wanted: false, state: null } });
  assert.equal(wanted({ platform: 'darwin', transcriptPath: cliTranscript }).wanted, false);
}));

test('worker: 印のある引き継ぎは、後継を --remote-control=<後継の名前> 付きで立てる。印の無い引き継ぎには付けない', () => withDir(async dir => {
  const run = async (sessionId, env) => {
    const transcriptPath = join(dir, `${sessionId}.jsonl`);
    writeFileSync(transcriptPath, jsonl([{ ...user('14個のファイルを順に読んで', '2026-10-10T05:00:10Z'), entrypoint: env.CLAUDE_CODE_ENTRYPOINT ?? 'cli' },
      { type: 'custom-title', customTitle: 'マビノギ BOT 開発' }, assistant('part04 を読みました。', '2026-10-10T05:00:12Z')]));
    const db = makeBatonDb();
    requestClaudeAutoHandoff({ payload: { session_id: sessionId, trigger: 'auto', cwd: '/work/OpenLogicool', transcript_path: transcriptPath },
      env, config: ENABLED, openDb: () => db, dir, platform: 'linux' });
    await stopClaudeTurnForHandoff({ payload: { session_id: sessionId, cwd: '/work/OpenLogicool', transcript_path: transcriptPath },
      dir, launchWorker: async () => {} });
    const launches = [];
    const record = await runClaudeAutoHandoffWorker(sessionId, { dir, env: {}, pollMs: 10, acceptTimeoutMs: 300, transcriptTimeoutMs: 50,
      spawn: (command, args) => { launches.push(args); successorStarts(dir, sessionId)(args); return launchedOk(); } });
    return { record, launches };
  };
  const desktop = await run('bbbbbbbb-0000-4000-8000-000000000001', { CLAUDE_CODE_ENTRYPOINT: 'claude-desktop' });
  assert.equal(desktop.launches.length, 1);
  assert.deepEqual(desktop.launches[0].slice(0, 3), ['--bg', '--name=OpenLogicool｜マビノギ BOT 開発（自動引き継ぎ）', '--remote-control=OpenLogicool｜マビノギ BOT 開発（自動引き継ぎ）']);
  assert.equal(desktop.record.state, 'sent');
  assert.deepEqual(desktop.record.remote_control, { wanted: true, state: 'requested' });
  assert.equal(publicClaudeAutoHandoff(desktop.record).remote_control_state, 'requested');

  const terminal = await run('bbbbbbbb-0000-4000-8000-000000000002', {});
  assert.ok(!terminal.launches[0].some(arg => arg.startsWith('--remote-control')));
  assert.deepEqual(terminal.record.remote_control, { wanted: false, state: null });
  assert.equal(publicClaudeAutoHandoff(terminal.record).remote_control_state, null);
}));

test('worker: リモートコントロールを付けると立てられない時は、付けずに立て直す。引き継ぎは止めない', () => withDir(async dir => {
  const sessionId = 'cccccccc-0000-4000-8000-000000000001';
  const transcriptPath = join(dir, `${sessionId}.jsonl`);
  writeFileSync(transcriptPath, jsonl([{ ...user('読んで', '2026-10-10T05:00:10Z'), entrypoint: 'claude-desktop' }, assistant('読みました。', '2026-10-10T05:00:12Z')]));
  const db = makeBatonDb();
  requestClaudeAutoHandoff({ payload: { session_id: sessionId, trigger: 'auto', cwd: '/work/app', transcript_path: transcriptPath },
    env: {}, config: ENABLED, openDb: () => db, dir, platform: 'darwin' });
  await stopClaudeTurnForHandoff({ payload: { session_id: sessionId, cwd: '/work/app', transcript_path: transcriptPath }, dir, launchWorker: async () => {} });
  const launches = [];
  const record = await runClaudeAutoHandoffWorker(sessionId, { dir, env: {}, pollMs: 10, acceptTimeoutMs: 300, transcriptTimeoutMs: 50,
    spawn: (command, args) => {
      launches.push(args.some(arg => arg.startsWith('--remote-control')));
      if (launches.length === 1) return { status: 1, stdout: '', stderr: 'Remote Control requires a claude.ai login' };
      successorStarts(dir, sessionId)(args); return launchedOk();
    } });
  assert.deepEqual(launches, [true, false], '1回目は付けて、2回目は付けずに立てる');
  assert.equal(record.state, 'sent'); assert.equal(record.error_code, null);
  assert.deepEqual(record.remote_control, { wanted: true, state: 'unavailable' });
  assert.equal(publicClaudeAutoHandoff(record).remote_control_state, 'unavailable');
  assert.equal(publicClaudeAutoHandoff(record).desktop_state, 'waiting', 'Desktop へ開く印は変わらない');
}));

test('Stop: Desktop で開く引き継ぎの後継がターンを終えたら、移す process を1回だけ起動する', () => withDir(async dir => {
  const launched = [];
  const launch = async (id) => { launched.push(id); };
  // 対象でない会話
  assert.equal(await requestClaudeDesktopOpen({ sessionId: SUCCESSOR, dir, launch }), null);
  writeRecord(dir, SESSION, { desktop: { wanted: false, state: null } });
  assert.equal(await requestClaudeDesktopOpen({ sessionId: SUCCESSOR, dir, launch }), null, '端末から始めた会話の後継は移さない');
  writeRecord(dir, SESSION, { state: 'unknown' });
  assert.equal(await requestClaudeDesktopOpen({ sessionId: SUCCESSOR, dir, launch }), null, '受領を確かめられていない後継は移さない');
  // 対象の後継
  writeRecord(dir, SESSION, {});
  assert.equal(await requestClaudeDesktopOpen({ sessionId: SESSION, dir, launch }), null, '旧い会話自身の Stop では動かない');
  assert.equal(await requestClaudeDesktopOpen({ sessionId: SUCCESSOR, dir, launch }), `h-${SESSION}`);
  assert.deepEqual(launched, [SESSION]);
  assert.equal(readClaudeAutoHandoff(SESSION, dir).desktop.state, 'requested');
  assert.equal(await requestClaudeDesktopOpen({ sessionId: SUCCESSOR, dir, launch }), null, '2回目の Stop では起動しない');
  assert.deepEqual(launched, [SESSION]);

  // 後継自身が引き継ぎの途中（作業は次の後継が続ける）なら、移さない
  writeRecord(dir, SESSION, {});
  writeRecord(dir, SUCCESSOR, { state: 'stopped', successor: null });
  assert.equal(await requestClaudeDesktopOpen({ sessionId: SUCCESSOR, dir, launch }), null);
  assert.deepEqual(launched, [SESSION]);

  // 起動に失敗した時は理由を残す
  rmSync(join(dir, `${SUCCESSOR}.json`));
  assert.equal(await requestClaudeDesktopOpen({ sessionId: SUCCESSOR, dir, launch: async () => { throw new Error('spawn'); } }), null);
  assert.deepEqual([readClaudeAutoHandoff(SESSION, dir).desktop.state, readClaudeAutoHandoff(SESSION, dir).desktop.error_code], ['failed', 'desktop_open_start_failed']);
}));

test('Desktop で開く: 後継が手すきになるのを待って止め、擬似端末の中で claude --desktop --resume を呼ぶ', () => withDir(async dir => {
  const shortId = SUCCESSOR.slice(0, 8);
  const run = async ({ statuses, stopStatus = 0, opened, beforePoll = () => {} }) => {
    writeRecord(dir, SESSION, { desktop: { wanted: true, state: 'requested', error_code: null, opened_at: null } });
    const calls = [];
    const spawn = (command, args, options) => {
      calls.push([command, ...args]);
      if (args[0] === 'agents') {
        beforePoll();
        const status = statuses.length > 1 ? statuses.shift() : statuses[0];
        return { status: 0, stdout: JSON.stringify([{ id: shortId, kind: 'interactive', status: 'idle' }, { id: 'ffffffff', kind: 'background', status: 'idle' },
          ...(status === null ? [] : [{ id: shortId, kind: 'background', status, sessionId: SUCCESSOR }])]) };
      }
      assert.deepEqual(options.env, { PATH: '/bin' }, '会話ごとの環境変数は渡さない');
      return { status: stopStatus, stdout: `stopped ${shortId}\n` };
    };
    const pty = (command, args, options) => { calls.push(['pty', command, ...args, options.cwd]); return opened; };
    const record = await runClaudeDesktopOpen(SESSION, { dir, env: { PATH: '/bin', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli' }, spawn, pty, idleTimeoutMs: 60, pollMs: 5 });
    return { record, calls };
  };
  const ok = { status: 0, stdout: `\u0004\b\bOpening session ${SUCCESSOR} in Claude Desktop\r\n`, stderr: '' };

  // macOS の実測（2026-10-08）: 作業中は busy、ターンを終えると idle。どちらも `--desktop --resume` は断られ、stop の後だけ通る。
  const done = await run({ statuses: ['busy', 'busy', 'idle'], opened: ok });
  assert.deepEqual(done.calls.slice(-2), [['claude', 'stop', shortId], ['pty', 'claude', '--desktop', '--resume', SUCCESSOR, '/work/app']]);
  assert.equal(done.calls.filter(call => call[1] === 'agents').length, 3);
  assert.deepEqual([done.record.desktop.state, done.record.desktop.error_code, typeof done.record.desktop.opened_at], ['opened', null, 'number']);
  assert.equal(done.record.state, 'sent', '引き継ぎの状態は変えない');
  assert.deepEqual([publicClaudeAutoHandoff(done.record).desktop_state, publicClaudeAutoHandoff(done.record).desktop_error_code], ['opened', null]);

  // 手すきにならない（次のターンが始まった）: 止めずに戻り、次の Stop でやり直せる状態にする
  const busy = await run({ statuses: ['busy'], opened: ok });
  assert.equal(busy.calls.some(call => call[1] === 'stop' || call[0] === 'pty'), false);
  assert.equal(busy.record.desktop.state, null);
  const missing = await run({ statuses: [null], opened: ok });
  assert.equal(missing.calls.some(call => call[1] === 'stop'), false, '一覧に無い会話は止めない');

  // 待つ間に、後継がさらに引き継ぎを始めた
  const superseded = await run({ statuses: ['busy'], opened: ok,
    beforePoll: () => writeRecord(dir, SUCCESSOR, { state: 'requested', successor: null }) });
  assert.equal(superseded.record.desktop.state, 'superseded');
  assert.equal(superseded.calls.some(call => call[1] === 'stop'), false);
  rmSync(join(dir, `${SUCCESSOR}.json`));

  // 止められない・開けない時は、固定の理由を残す
  const stopFailed = await run({ statuses: ['idle'], stopStatus: 1, opened: ok });
  assert.deepEqual([stopFailed.record.desktop.state, stopFailed.record.desktop.error_code], ['failed', 'desktop_open_stop_failed']);
  assert.equal(stopFailed.calls.some(call => call[0] === 'pty'), false);
  const refused = await run({ statuses: ['idle'], opened: { status: 1, stdout: `Session ${SUCCESSOR} is open in another terminal. Run /desktop there instead.\r\n`, stderr: '' } });
  assert.deepEqual([refused.record.desktop.state, refused.record.desktop.error_code], ['failed', 'desktop_open_failed']);

  // Windows は新しい console の中で動かすので、出た文を読めない。終了 code だけで成否を決める
  const windowsOk = await run({ statuses: ['idle'], opened: { status: 0, stdout: '', stderr: '', outputUnavailable: true } });
  assert.equal(windowsOk.record.desktop.state, 'opened');
  const windowsRefused = await run({ statuses: ['idle'], opened: { status: 1, stdout: '', stderr: '', outputUnavailable: true } });
  assert.deepEqual([windowsRefused.record.desktop.state, windowsRefused.record.desktop.error_code], ['failed', 'desktop_open_failed']);

  // 対象でない記録には何もしない
  writeRecord(dir, SESSION, {});
  const untouched = await runClaudeDesktopOpen(SESSION, { dir, spawn: () => { throw new Error('must not run'); }, pty: () => { throw new Error('must not run'); } });
  assert.equal(untouched.desktop.state, null);
}));

test('公開CLI: --host claude は enable・disable・status・worker を受け取る', () => {
  assert.equal(parseAutoHandoffArgs(['status', '--json']).host, 'codex');
  assert.deepEqual(
    (({ action, host, project, json }) => ({ action, host, project, json }))(parseAutoHandoffArgs(['enable', '--host', 'claude', '--project', REPO_ROOT, '--json'])),
    { action: 'enable', host: 'claude', project: REPO_ROOT, json: true },
  );
  assert.equal(parseAutoHandoffArgs(['status', '--host', 'claude', '--operation', 'id']).operation, 'id');
  assert.equal(parseAutoHandoffArgs(['worker', '--host', 'claude', '--operation', SESSION]).action, 'worker');
  assert.equal(parseAutoHandoffArgs(['desktop-open', '--host', 'claude', '--operation', SESSION]).action, 'desktop-open');
  for (const args of [['resume', '--host', 'claude', '--operation', 'id'], ['detail', '--host', 'claude', '--operation', 'id', '--origin', 'A', '--turn', '1'],
    ['worker', '--host', 'claude'], ['status', '--host', 'grok'], ['status', '--host'], ['disable', '--host', 'claude', '--project', REPO_ROOT],
    ['desktop-open', '--host', 'claude'], ['desktop-open', '--operation', SESSION]]) {
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
    toolUse('toolu_1', 'Read', { file_path: '/p/big1.txt' }),
    toolResult('toolu_1', 'big1 contents'),
    assistant('big1.txt を読み終えました。次に big2.txt を読みます。', at(12)),
    toolUse('toolu_2', 'Read', { file_path: '/p/big2.txt' }),
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
  const stopped = hook('pre-tool-use', { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_use_id: 'toolu_2', permission_mode: 'acceptEdits' });
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
  // worker は後継を立てる前に、止めたターンを DB へ取り込んでいる
  assert.equal(handoff.in_flight_captured, true);
  assert.equal(record.in_flight.turn.origin_session_id, SESSION);
  assert.equal(record.in_flight.turn.details, 3);
  // 後継の最初の指示は、worker が後継の ID を記録へ写す前（launching）に届くことがある
  writeFileSync(recordFile, JSON.stringify({ ...record, state: 'launching', error_code: null }));
  const started = hook('session-start', { hook_event_name: 'SessionStart', source: 'startup' }, SUCCESSOR);
  assert.equal(started.status, 0, started.stderr);
  assert.equal(started.stdout, '');
  assert.equal(existsSync(join(handoffDir, 'targets')), false, '受け口は控えない');

  const prompt = claudeContinuationInput(record);
  const first = cli(home, ['prompt-submit'], JSON.stringify({ session_id: SUCCESSOR, cwd: project, hook_event_name: 'UserPromptSubmit', prompt }), extra);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /^## Throughline: 自動継続の文脈\n/);
  assert.match(first.stdout, /### 現在地 \(作業の途中で止めたターン\)\n\*\*作業中のユーザー依頼\*\* \[\d\d:\d\d:\d\d\]: big1\.txt と big2\.txt を読んで result\.txt を作って\n/);
  assert.match(first.stdout, new RegExp('\\*\\*このターンでここまでにしたこと\\*\\*（古い順。どれも完了済み。道具の入出力の全文: `throughline detail \\d\\d:\\d\\d:\\d\\d`）:\\n' +
    '- 道具: Read /p/big1\\.txt\\n- 発言: big1\\.txt を読み終えました。次に big2\\.txt を読みます。\\n' +
    '\\*\\*止める直前に呼ぼうとして、実行されなかった道具\\*\\*: Read /p/big2\\.txt\\n'));
  assert.match(first.stdout, /\[user\]: 成果物の1行目には必ず「約束: MANGO-4417」と書くこと\n/);
  assert.equal(first.stdout.split('big1.txt と big2.txt を読んで').length, 2, '止めたターンの依頼は現在地に1回だけ');
  assert.doesNotMatch(first.stdout, /宣言|\/clear/);
  assert.ok(first.stdout.length <= 9_501);
  const acceptance = JSON.parse(readFileSync(join(handoffDir, `${SESSION}.accepted`), 'utf8'));
  assert.deepEqual([acceptance.handoff_id, acceptance.successor_session_id], [record.handoff_id, SUCCESSOR], '最初の指示が受領を残す');
  assert.ok(acceptance.accepted_at > 0);

  // 記憶は後継へ合流している（今の /tl の引き継ぎと同じ）
  const db = new DatabaseSync(join(home, '.throughline', 'throughline.db'));
  assert.equal(db.prepare('SELECT merged_into FROM sessions WHERE session_id = ?').get(SESSION).merged_into, SUCCESSOR);
  assert.deepEqual(db.prepare('SELECT DISTINCT session_id FROM bodies').all().map(row => row.session_id), [SUCCESSOR]);
  // 止めたターンは、道具の入出力ごと後継の記憶に入っている（`throughline detail` で取り出せる）
  assert.deepEqual(db.prepare(`SELECT b.role, b.text, (SELECT COUNT(*) FROM details d WHERE d.session_id = b.session_id
      AND d.origin_session_id = b.origin_session_id AND d.turn_number = b.turn_number) AS details
    FROM bodies b WHERE b.origin_session_id = ? AND b.turn_number = ? ORDER BY b.id`).all(SESSION, record.in_flight.turn.turn_number)
    .map(row => ({ ...row })), [
    { role: 'user', text: 'big1.txt と big2.txt を読んで result.txt を作って', details: 3 },
    { role: 'assistant', text: 'big1.txt を読み終えました。次に big2.txt を読みます。', details: 3 },
  ]);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM handoff_batons').get().c, 0);
  db.close();

  const decisions = readFileSync(join(home, '.throughline', 'logs', 'inheritance-decision.log'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(decisions.filter(entry => entry.phase === 'pre-compact').map(entry => [entry.trigger, entry.auto_continuation, entry.skip_reason]),
    [['manual', 'skipped', 'manual_compact'], ['auto', 'requested', null]]);
  assert.equal(decisions.filter(entry => entry.phase === 'pre-tool-use-stop').length, 1);
  const merged = decisions.find(entry => entry.phase === 'prompt-submit' && entry.merged);
  assert.deepEqual([merged.triggered_path, merged.injection.auto_handoff_id], ['baton', record.handoff_id]);
}));

test('hook: 別の project へ移した会話（Claude Desktop）を、移った後に1回も Stop を通らないまま引き継いでも、後継へ記憶が入る', () => withDir(async home => {
  // Desktop は「フォルダなし」で始めた会話を project へ移す。SessionStart は移る前の場所で呼ばれ、
  // CLAUDE_PROJECT_DIR は移った後も移る前の場所のまま届く。
  const scratch = join(home, 'scratch-2026-10-05-ac3fa8');
  const project = join(home, 'project');
  mkdirSync(scratch, { recursive: true });
  mkdirSync(project, { recursive: true });
  const transcriptPath = join(home, 'transcript.jsonl');
  const base = Date.parse('2026-10-05T22:38:00Z');
  const at = seconds => new Date(base + seconds * 1000).toISOString();
  const moved = { ...fakeClaudePath(home), CLAUDE_PROJECT_DIR: scratch };
  const hook = (command, payload, cwd = project) =>
    cli(home, [command], JSON.stringify({ session_id: SESSION, cwd, transcript_path: transcriptPath, ...payload }), moved);

  assert.equal(cli(home, ['auto-handoff', 'enable', '--host', 'claude', '--project', project, '--json']).status, 0);
  assert.equal(hook('session-start', { hook_event_name: 'SessionStart', source: 'startup' }, scratch).status, 0);
  writeFileSync(transcriptPath, jsonl([
    user('14個を順に読んで', at(0)),
    assistant('読み終えました。', at(60)),
    { type: 'relocated', sessionId: SESSION, relocatedCwd: project },
    user('part06 から part09 をもう一度読んで', at(3000)),
    assistant('part06 から読みます。', at(3002)),
    toolUse('toolu_6', 'Read', { file_path: join(project, 'part06.txt') }),
  ]));

  const pre = hook('pre-compact', { hook_event_name: 'PreCompact', trigger: 'auto' });
  assert.equal(pre.status, 2, pre.stderr);
  const stopped = hook('pre-tool-use', { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_use_id: 'toolu_6', permission_mode: 'bypassPermissions' });
  assert.equal(JSON.parse(stopped.stdout).continue, false);
  const status = () => JSON.parse(cli(home, ['auto-handoff', 'status', '--host', 'claude', '--json']).stdout).handoffs;
  let handoff;
  for (let i = 0; i < 100 && (handoff = status()[0]).state !== 'failed'; i++) await new Promise(r => setTimeout(r, 100));
  assert.equal(handoff.error_code, 'handoff_successor_launch_failed', '偽の claude で止まる。本物は起動しない');

  // 後継の最初の指示（起動時に渡された継続の指示）
  const recordFile = join(home, '.throughline', 'claude-auto-handoff', `${SESSION}.json`);
  const record = JSON.parse(readFileSync(recordFile, 'utf8'));
  writeFileSync(recordFile, JSON.stringify({ ...record, state: 'launching', error_code: null }));
  const successorPayload = { session_id: SUCCESSOR, cwd: project, hook_event_name: 'SessionStart', source: 'startup' };
  assert.equal(cli(home, ['session-start'], JSON.stringify(successorPayload), fakeClaudePath(home)).status, 0);
  const first = cli(home, ['prompt-submit'], JSON.stringify({ ...successorPayload, hook_event_name: 'UserPromptSubmit',
    prompt: claudeContinuationInput(record) }), fakeClaudePath(home));
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /^## Throughline: 自動継続の文脈\n/);
  assert.match(first.stdout, /\*\*作業中のユーザー依頼\*\* \[\d\d:\d\d:\d\d\]: part06 から part09 をもう一度読んで\n/);
  assert.match(first.stdout, /\*\*止める直前に呼ぼうとして、実行されなかった道具\*\*: Read .*part06\.txt\n/);

  const db = new DatabaseSync(join(home, '.throughline', 'throughline.db'));
  assert.equal(db.prepare('SELECT merged_into FROM sessions WHERE session_id = ?').get(SESSION).merged_into, SUCCESSOR);
  assert.equal(db.prepare('SELECT project_path FROM sessions WHERE session_id = ?').get(SESSION).project_path, project);
  db.close();
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
