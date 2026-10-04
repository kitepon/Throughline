import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import {
  recordClaudeCompactRequest,
  consumeClaudeCompactRequest,
  listClaudeCompactRequests,
} from './claude-auto-handoff.mjs';
import { parseAutoHandoffArgs } from './cli/auto-handoff.mjs';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(REPO_ROOT, 'bin', 'throughline.mjs');
const SESSION = '0f3a6c1e-7b2d-4e5f-9a81-3c4d5e6f7a8b';
const ENABLED = { enabled: true, projects: [] };

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'tl-claude-auto-'));
  try { return fn(dir); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

function childEnv(home) {
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
  };
}

function cli(home, args, input = '') {
  return spawnSync(process.execPath, [CLI, ...args], { cwd: REPO_ROOT, env: childEnv(home), input, encoding: 'utf8' });
}

const user = (text, timestamp) => ({ type: 'user', timestamp, message: { role: 'user', content: text } });
const assistant = (text, timestamp) => ({ type: 'assistant', timestamp, message: { role: 'assistant', content: [{ type: 'text', text }] } });
const toolUse = (id, name) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input: {} }] } });
const toolResult = (id, text) => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] } });
const compactSummary = () => ({ type: 'user', isCompactSummary: true, isVisibleInTranscriptOnly: true,
  message: { role: 'user', content: 'This session is being continued from a previous conversation that ran out of context.' } });
const jsonl = entries => entries.map(entry => JSON.stringify(entry)).join('\n') + '\n';

test('PreCompact: 自動圧縮で有効な時だけ印を残し、手動・無効・対象外のprojectでは古い印を消す', () => withDir(dir => {
  const payload = { session_id: SESSION, trigger: 'auto', cwd: '/work/app', transcript_path: '/t.jsonl' };
  const args = { payload, env: {}, config: ENABLED, dir, now: 1_000 };

  assert.deepEqual(recordClaudeCompactRequest(args), { status: 'requested', sessionId: SESSION, projectPath: '/work/app' });
  assert.deepEqual(listClaudeCompactRequests({ dir }), [{ session_id: SESSION, project_path: '/work/app', requested_at: 1_000 }]);

  for (const [override, reason] of [
    [{ payload: { ...payload, trigger: 'manual' } }, 'manual_compact'],
    [{ config: { enabled: false, projects: [] } }, 'auto_handoff_disabled'],
    [{ config: { enabled: true, projects: ['/work/other'] } }, 'auto_handoff_disabled'],
  ]) {
    recordClaudeCompactRequest(args);
    const result = recordClaudeCompactRequest({ ...args, ...override });
    assert.equal(result.status, 'skipped');
    assert.equal(result.reason, reason);
    assert.deepEqual(readdirSync(dir), [], reason);
  }

  // 有効判定は会話を起動した project で行う（cwd は Bash の cd に追従する）
  const started = recordClaudeCompactRequest({ ...args, payload: { ...payload, cwd: '/work/app/sub' },
    env: { CLAUDE_PROJECT_DIR: '/work/app' }, config: { enabled: true, projects: ['/work/app'] } });
  assert.equal(started.status, 'requested');
  assert.equal(started.projectPath, '/work/app');
}));

test('PreCompact: subagent の中の圧縮は親の会話の印に触らない', () => withDir(dir => {
  const payload = { session_id: SESSION, trigger: 'auto', cwd: '/work/app' };
  recordClaudeCompactRequest({ payload, env: {}, config: ENABLED, dir, now: 1_000 });
  for (const trigger of ['auto', 'manual']) {
    const result = recordClaudeCompactRequest({ payload: { ...payload, trigger, agent_id: 'agent-1' }, env: {}, config: ENABLED, dir, now: 2_000 });
    assert.deepEqual(result, { status: 'skipped', reason: 'subagent_compact', sessionId: SESSION });
  }
  assert.equal(listClaudeCompactRequests({ dir })[0].requested_at, 1_000);
}));

test('PreCompact: session id が無い・pathを含む時は失敗し、期限を過ぎた他の会話の印は掃除する', () => withDir(dir => {
  assert.throws(() => recordClaudeCompactRequest({ payload: { trigger: 'auto' }, env: {}, config: ENABLED, dir }), /Missing session_id/);
  assert.throws(() => recordClaudeCompactRequest({ payload: { session_id: '../escape', trigger: 'auto', cwd: '/w' }, env: {}, config: ENABLED, dir }),
    /auto_handoff_session_id_invalid/);

  const now = Date.parse('2026-10-04T12:00:00Z');
  mkdirSync(dir, { recursive: true });
  const stale = join(dir, 'aaaaaaaa-0000-4000-8000-000000000001.json');
  const fresh = join(dir, 'aaaaaaaa-0000-4000-8000-000000000002.json');
  for (const path of [stale, fresh]) writeFileSync(path, '{}');
  utimesSync(stale, new Date(now - 25 * 3_600_000), new Date(now - 25 * 3_600_000));
  utimesSync(fresh, new Date(now - 3_600_000), new Date(now - 3_600_000));
  recordClaudeCompactRequest({ payload: { session_id: SESSION, trigger: 'auto', cwd: '/w' }, env: {}, config: ENABLED, dir, now });
  assert.deepEqual(readdirSync(dir).sort(), [`${SESSION}.json`, 'aaaaaaaa-0000-4000-8000-000000000002.json'].sort());
}));

test('SessionStart: 印は一度だけ取り出せる。別の会話・他hostの会話は取り出さない', () => withDir(dir => {
  recordClaudeCompactRequest({ payload: { session_id: SESSION, trigger: 'auto', cwd: '/work/app', transcript_path: '/t.jsonl' },
    env: {}, config: ENABLED, dir, now: 5_000 });
  assert.equal(consumeClaudeCompactRequest({ sessionId: 'aaaaaaaa-0000-4000-8000-000000000009', dir }), null);
  assert.equal(consumeClaudeCompactRequest({ sessionId: `grok:${SESSION}`, dir }), null);
  const request = consumeClaudeCompactRequest({ sessionId: SESSION, dir });
  assert.equal(request.trigger, 'auto');
  assert.equal(request.project_path, '/work/app');
  assert.equal(request.transcript_path, '/t.jsonl');
  assert.equal(request.requested_at, 5_000);
  assert.equal(consumeClaudeCompactRequest({ sessionId: SESSION, dir }), null);

  writeFileSync(join(dir, `${SESSION}.json`), JSON.stringify({ schema: 'other', session_id: SESSION, trigger: 'auto' }));
  assert.throws(() => consumeClaudeCompactRequest({ sessionId: SESSION, dir }), /auto_handoff_request_invalid/);
  assert.deepEqual(readdirSync(dir), [], '読めない印は残さない');
}));

test('公開CLI: --host claude は enable・disable・status だけを受け取る', () => {
  assert.equal(parseAutoHandoffArgs(['status', '--json']).host, 'codex');
  assert.deepEqual(
    (({ action, host, project, json }) => ({ action, host, project, json }))(parseAutoHandoffArgs(['enable', '--host', 'claude', '--project', REPO_ROOT, '--json'])),
    { action: 'enable', host: 'claude', project: REPO_ROOT, json: true },
  );
  for (const args of [['resume', '--host', 'claude', '--operation', 'id'], ['status', '--host', 'claude', '--operation', 'id'],
    ['worker', '--host', 'claude', '--operation', 'id'], ['status', '--host', 'grok'], ['status', '--host'], ['disable', '--host', 'claude', '--project', '/p']]) {
    assert.throws(() => parseAutoHandoffArgs(args), JSON.stringify(args));
  }
});

test('公開CLI: enable は PreCompact hook と設定を書き、Codex の設定には触らない', () => withDir(home => {
  const settingsPath = join(home, '.claude', 'settings.json');
  mkdirSync(dirname(settingsPath), { recursive: true });
  // 他製品のhookと、matcher付きの古い自分の登録がある状態から始める
  writeFileSync(settingsPath, JSON.stringify({ model: 'sonnet', hooks: { PreCompact: [
    { matcher: 'auto', hooks: [{ type: 'command', command: 'throughline pre-compact' }] },
    { hooks: [{ type: 'command', command: 'other-product pre-compact' }] },
  ] } }));

  const before = JSON.parse(cli(home, ['auto-handoff', 'status', '--host', 'claude', '--json']).stdout);
  assert.deepEqual(before, { host: 'claude', config: { schema: 'throughline.claude-auto-handoff.v1', enabled: false, projects: [] },
    hook: { registered: false }, pending: [] });
  assert.equal(existsSync(join(home, '.throughline')), false, 'status は何も作らない');

  const enabled = cli(home, ['auto-handoff', 'enable', '--host', 'claude', '--json']);
  assert.equal(enabled.status, 0, enabled.stderr);
  assert.equal(JSON.parse(enabled.stdout).status, 'enabled');
  const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  assert.equal(settings.model, 'sonnet');
  assert.deepEqual(settings.hooks.PreCompact, [
    { hooks: [{ type: 'command', command: 'throughline pre-compact' }] },
    { hooks: [{ type: 'command', command: 'other-product pre-compact' }] },
  ]);
  const again = cli(home, ['auto-handoff', 'enable', '--host', 'claude', '--json']);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(readFileSync(settingsPath, 'utf8'), JSON.stringify(settings, null, 2) + '\n', '2回目は書き換えない');

  const text = cli(home, ['auto-handoff', 'status', '--host', 'claude']);
  assert.equal(text.stdout, '自動継続: 有効（Claude Code）\nPreCompact hook: 登録済み\n');
  assert.equal(existsSync(join(home, '.throughline', 'codex-auto-handoff.json')), false);
  assert.equal(JSON.parse(cli(home, ['auto-handoff', 'status', '--json']).stdout).config.enabled, false, 'Codex は無効のまま');

  const disabled = JSON.parse(cli(home, ['auto-handoff', 'disable', '--host', 'claude', '--json']).stdout);
  assert.equal(disabled.config.enabled, false);
  const unsupported = cli(home, ['auto-handoff', 'resume', '--host', 'claude', '--operation', 'x', '--json']);
  assert.equal(unsupported.status, 1);
  assert.deepEqual(JSON.parse(unsupported.stdout), { status: 'failed', code: 'auto_handoff_action_unsupported' });
}));

test('hook: 自動圧縮の直後に、作業途中のターンと直近の会話を同じ会話へ注入し、最終回答は1ターンとして保存する', () => withDir(home => {
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
  ]));
  const common = { session_id: SESSION, cwd: project, transcript_path: transcriptPath };
  const hook = (command, payload) => cli(home, [command], JSON.stringify({ ...common, ...payload }));

  assert.equal(cli(home, ['auto-handoff', 'enable', '--host', 'claude', '--project', project, '--json']).status, 0);
  assert.equal(hook('session-start', { hook_event_name: 'SessionStart', source: 'startup' }).status, 0);

  // 手動の /compact では注入しない
  const manual = hook('pre-compact', { hook_event_name: 'PreCompact', trigger: 'manual' });
  assert.equal(manual.status, 0, manual.stderr);
  assert.equal(manual.stdout, '', 'PreCompact の stdout は空（JSON の decision を返さない）');
  assert.equal(hook('session-start', { hook_event_name: 'SessionStart', source: 'compact' }).stdout, '');

  // 自動圧縮
  const pre = hook('pre-compact', { hook_event_name: 'PreCompact', trigger: 'auto' });
  assert.equal(pre.status, 0, pre.stderr);
  assert.equal(pre.stdout, '');
  assert.equal(JSON.parse(cli(home, ['auto-handoff', 'status', '--host', 'claude', '--json']).stdout).pending.length, 1);
  appendFileSync(transcriptPath, jsonl([compactSummary()]));

  const compacted = hook('session-start', { hook_event_name: 'SessionStart', source: 'compact' });
  assert.equal(compacted.status, 0, compacted.stderr);
  assert.match(compacted.stdout, /^## Throughline: 自動圧縮後の継続用コンテキスト\n/);
  assert.match(compacted.stdout, /### 現在地 \(作業途中のターン\)\n\*\*作業中のユーザー依頼\*\* \[\d\d:\d\d:\d\d\]: big1\.txt と big2\.txt を読んで result\.txt を作って\n/);
  assert.match(compacted.stdout, /\*\*圧縮直前のあなたの発言\*\* \[\d\d:\d\d:\d\d\]: big1\.txt を読み終えました。次に big2\.txt を読みます。\n/);
  assert.match(compacted.stdout, /\[user\]: 成果物の1行目には必ず「約束: MANGO-4417」と書くこと\n/);
  assert.match(compacted.stdout, /\[assistant\]: 了解しました。/);
  assert.doesNotMatch(compacted.stdout, /This session is being continued/, '圧縮の要約は記録に入れない');
  assert.ok(compacted.stdout.length <= 9_501);

  const db = new DatabaseSync(join(home, '.throughline', 'throughline.db'));
  const bodies = () => db.prepare('SELECT turn_number, role, text FROM bodies ORDER BY turn_number, role DESC').all()
    .map(row => [row.turn_number, row.role, row.text]);
  assert.deepEqual(bodies(), [
    [1, 'user', '成果物の1行目には必ず「約束: MANGO-4417」と書くこと'],
    [1, 'assistant', '了解しました。'],
  ], '作業途中のターンは保存しない（途中の発言を回答として固定しない）');

  // 印は消費済み。次の圧縮が手動なら何も出さない
  assert.equal(JSON.parse(cli(home, ['auto-handoff', 'status', '--host', 'claude', '--json']).stdout).pending.length, 0);
  assert.equal(hook('session-start', { hook_event_name: 'SessionStart', source: 'compact' }).stdout, '');

  // 圧縮の後、作業が終わる
  appendFileSync(transcriptPath, jsonl([
    toolUse('toolu_2', 'Read'),
    toolResult('toolu_2', 'big2 contents'),
    assistant('result.txt を作りました。', at(40)),
  ]));
  const stop = hook('process-turn', { hook_event_name: 'Stop', last_assistant_message: 'result.txt を作りました。' });
  assert.equal(stop.status, 0, stop.stderr);
  assert.deepEqual(bodies().slice(2), [
    [5, 'user', 'big1.txt と big2.txt を読んで result.txt を作って'],
    [5, 'assistant', 'result.txt を作りました。'],
  ]);
  const tools = db.prepare("SELECT tool_name FROM details WHERE kind = 'tool_input' AND turn_number = 5 ORDER BY id").all();
  assert.deepEqual(tools.map(row => row.tool_name), ['Read', 'Read'], '圧縮より前のtoolも同じターンのL3に入る');
  db.close();

  const decisions = readFileSync(join(home, '.throughline', 'logs', 'inheritance-decision.log'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(decisions.filter(entry => entry.phase === 'pre-compact').map(entry => [entry.trigger, entry.auto_continuation, entry.skip_reason]),
    [['manual', 'skipped', 'manual_compact'], ['auto', 'requested', null]]);
  const continuation = decisions.filter(entry => entry.phase === 'compact-continuation');
  assert.equal(continuation.length, 1);
  assert.equal(continuation[0].injected, true);
  assert.equal(continuation[0].in_flight_fragments, 1);
  assert.equal(continuation[0].injected_l2_turns, 1);
}));

test('hook: transcript に今の依頼がまだ無い時（prompt_id が合わない）、前のターンを作業中として見せず、保存もしない', () => withDir(home => {
  const project = join(home, 'project');
  mkdirSync(project, { recursive: true });
  const transcriptPath = join(home, 'transcript.jsonl');
  writeFileSync(transcriptPath, jsonl([
    { ...user('最初の依頼', '2026-10-04T03:00:00Z'), promptId: 'prompt-1' },
    assistant('最初の回答', '2026-10-04T03:00:01Z'),
    { ...user('前の依頼', '2026-10-04T03:00:10Z'), promptId: 'prompt-2' },
    assistant('前の回答', '2026-10-04T03:00:11Z'),
  ]));
  const common = { session_id: SESSION, cwd: project, transcript_path: transcriptPath, prompt_id: 'prompt-3' };
  const hook = (command, payload) => cli(home, [command], JSON.stringify({ ...common, ...payload }));
  assert.equal(cli(home, ['auto-handoff', 'enable', '--host', 'claude', '--json']).status, 0);
  assert.equal(hook('pre-compact', { hook_event_name: 'PreCompact', trigger: 'auto' }).status, 0);

  const compacted = hook('session-start', { hook_event_name: 'SessionStart', source: 'compact' });
  assert.equal(compacted.status, 0, compacted.stderr);
  assert.match(compacted.stdout, /\*\*作業中のユーザー依頼\*\*: （記録からまだ読めません。/);
  assert.doesNotMatch(compacted.stdout, /前の依頼|前の回答|圧縮直前のあなたの発言/);
  assert.match(compacted.stdout, /\[user\]: 最初の依頼\n/);
  const db = new DatabaseSync(join(home, '.throughline', 'throughline.db'));
  assert.deepEqual(db.prepare('SELECT text FROM bodies ORDER BY id').all().map(row => row.text), ['最初の依頼', '最初の回答']);
  db.close();

  // prompt_id が合う時は、その群が作業途中のターン
  assert.equal(hook('pre-compact', { hook_event_name: 'PreCompact', trigger: 'auto', prompt_id: 'prompt-2' }).status, 0);
  const matched = hook('session-start', { hook_event_name: 'SessionStart', source: 'compact', prompt_id: 'prompt-2' });
  assert.match(matched.stdout, /\*\*作業中のユーザー依頼\*\* \[\d\d:\d\d:\d\d\]: 前の依頼\n\*\*圧縮直前のあなたの発言\*\* \[\d\d:\d\d:\d\d\]: 前の回答\n/);
}));

test('hook: 自動継続が無効な時、自動圧縮の前後で何も残さず何も出さない', () => withDir(home => {
  const project = join(home, 'project');
  mkdirSync(project, { recursive: true });
  const transcriptPath = join(home, 'transcript.jsonl');
  writeFileSync(transcriptPath, jsonl([user('依頼'), assistant('途中')]));
  const common = { session_id: SESSION, cwd: project, transcript_path: transcriptPath };
  const hook = (command, payload) => cli(home, [command], JSON.stringify({ ...common, ...payload }));

  const pre = hook('pre-compact', { hook_event_name: 'PreCompact', trigger: 'auto' });
  assert.equal(pre.status, 0, pre.stderr);
  assert.equal(pre.stdout, '');
  assert.equal(existsSync(join(home, '.throughline', 'claude-auto-handoff')), false);
  const compacted = hook('session-start', { hook_event_name: 'SessionStart', source: 'compact' });
  assert.equal(compacted.status, 0, compacted.stderr);
  assert.equal(compacted.stdout, '');
}));

test('hook: PreCompact が失敗しても圧縮を止める終了コード(2)を返さず、理由を端末に残す', () => withDir(home => {
  const failed = cli(home, ['pre-compact'], '{"trigger":"auto"}');
  assert.equal(failed.status, 1);
  assert.equal(failed.stdout, '');
  const log = readFileSync(join(home, '.throughline', 'logs', 'hook-failures.log'), 'utf8');
  assert.match(log, /HOOK_PRE_COMPACT_FAILED/);
  assert.match(log, /Missing session_id in PreCompact payload/);
}));
