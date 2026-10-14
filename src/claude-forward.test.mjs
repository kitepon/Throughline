import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CLAUDE_FORWARD_CONTEXT_MAX_CHARS,
  CLAUDE_FORWARD_MARK,
  claimClaudeForwards,
  claudeForwardCarriesHumanInput,
  claudeForwardWaiterAlive,
  registerClaudeForwardWaiter,
  claudeForwardInboxDir,
  acquireClaudeWakeClaim,
  enqueueClaudeForward,
  ensureClaudeForwardInbox,
  holdClaudeForward,
  hasPendingClaudeForwards,
  moveClaudeForwards,
  readClaudeForwardStatus,
  removeStaleClaudeForwards,
  settleClaudeForwards,
  takeClaudeForwardsAsContext,
  unwrapClaudeForwardedDelivery,
} from './claude-forward.mjs';
import { waitForClaudeForwards } from './claude-forward-wait.mjs';
import { CLAUDE_WAKE_TEXT_MAX_CHARS, acceptClaudeAutoContinuation, publicClaudeAutoHandoff, readClaudeSessionStopped, redirectClaudeHandedOffPrompt } from './claude-auto-handoff.mjs';
import { MID_TURN_INPUT_MARK, readTranscript } from './transcript-reader.mjs';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(REPO_ROOT, 'bin', 'throughline.mjs');
const OLD = 'aaaaaaaa-0000-4000-8000-000000000041';
const NEXT = 'bbbbbbbb-0000-4000-8000-000000000042';
const LAST = 'cccccccc-0000-4000-8000-000000000043';

// 一覧を読めない `claude`（試験では本物の claude を呼ばない）
const NO_CLAUDE = () => ({ error: Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }) });
// 後継の transcript を、止まってしばらく経った物にする（書かれたばかりの transcript の後継は、動いていると見なす）
const settled = path => { const past = new Date(Date.now() - 60_000); utimesSync(path, past, past); };

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'tl-claude-forward-'));
  const finish = () => rmSync(dir, { recursive: true, force: true });
  let result;
  try { result = fn(dir); }
  catch (error) { finish(); throw error; }
  if (result && typeof result.then === 'function') return result.finally(finish);
  finish();
  return result;
}

const put = (dir, to, text, { kind = 'prompt', now = 1_760_000_000_000, from = OLD } = {}) =>
  enqueueClaudeForward({ successorSessionId: to, sourceSessionId: from, handoffId: 'h-1', kind, text, now, dir });
const forwardLog = dir => existsSync(join(dir, 'forward.jsonl'))
  ? readFileSync(join(dir, 'forward.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
const jsonl = entries => entries.map(entry => JSON.stringify(entry)).join('\n') + '\n';

test('置き場: 届いた順に1つの文にまとめて受け取り、出力した後で消す。本文は記録へ書かない', () => withDir(dir => {
  assert.equal(claimClaudeForwards({ sessionId: NEXT, dir }), null, '置き場が無い');
  assert.equal(put(dir, NEXT, '   '), false, '空の入力は置かない');
  assert.equal(put(dir, '../escape', '文'), false, '置き場の名前に使えない会話 ID');
  assert.equal(put(dir, NEXT, '1通目の依頼', { now: 1_760_000_000_000 }), true);
  assert.equal(put(dir, NEXT, '<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n</task-notification>',
    { kind: 'task-notification', now: 1_760_000_001_000 }), true);
  assert.equal(put(dir, NEXT, '2通目の依頼', { now: 1_760_000_002_000 }), true);
  assert.equal(hasPendingClaudeForwards(NEXT, dir), true);
  assert.deepEqual(readClaudeForwardStatus(NEXT, { dir }), { pending: 3, unknown: 0 });

  const claim = claimClaudeForwards({ sessionId: NEXT, dir });
  assert.deepEqual([claim.count, claim.humans, claim.notifications], [3, 2, 1]);
  const lines = claim.text.split('\n');
  assert.equal(lines[0], `${CLAUDE_FORWARD_MARK}引き継ぎ前の会話（aaaaaaaa）へ届いた入力を、Throughlineがこの会話へ運びました（利用者の入力 2 通、裏の作業の通知 1 通）。作業はこの会話が引き継いでいます。引き継ぎID: h-1`);
  assert.match(lines[1], /^--- 利用者の入力（\d{4}-\d\d-\d\d \d\d:\d\d に届いた。利用者がこの会話へ打った入力として扱ってください）---$/);
  assert.equal(lines[2], '1通目の依頼');
  assert.match(lines[3], /^--- 裏の作業の通知（.*引き継ぎ前の会話が裏で起こした作業の通知です。結果が要る時は、出力の file を読んで確かめてください）---$/);
  assert.equal(lines.at(-1), '2通目の依頼');
  assert.equal(claimClaudeForwards({ sessionId: NEXT, dir }), null, '受け取った入力は、もう受け取れない');
  assert.deepEqual(readClaudeForwardStatus(NEXT, { dir }), { pending: 0, unknown: 0 }, '受け取った直後は、届いたか分からない数に入れない');
  settleClaudeForwards(claim);
  assert.deepEqual(readdirSync(join(claudeForwardInboxDir(NEXT, dir), 'claimed')), []);
}));

test('置き場: 受け取った後で出力する前に落ちた入力は、置き場へ戻らない（届いたか分からない数に出る）', () => withDir(dir => {
  put(dir, NEXT, '落ちる前に受け取られた依頼');
  const claim = claimClaudeForwards({ sessionId: NEXT, dir });
  assert.equal(claim.count, 1);
  // 出力も片付けもせずに落ちた事にする
  const old = new Date(Date.now() - 120_000);
  utimesSync(claim.paths[0], old, old);
  assert.equal(claimClaudeForwards({ sessionId: NEXT, dir }), null, '入れ直さない');
  assert.deepEqual(readClaudeForwardStatus(NEXT, { dir }), { pending: 0, unknown: 1 });
}));

test('置き場: 文脈として足す道は、9,000 字に収まる分だけを届いた順に運ぶ。収まらない入力は番の終わりの道に残す', () => withDir(dir => {
  put(dir, NEXT, '短い依頼', { now: 1_760_000_000_000 });
  put(dir, NEXT, 'あ'.repeat(CLAUDE_FORWARD_CONTEXT_MAX_CHARS), { now: 1_760_000_001_000 });
  put(dir, NEXT, '長い依頼の後ろの短い依頼', { now: 1_760_000_002_000 });
  const first = takeClaudeForwardsAsContext({ sessionId: NEXT, via: 'pre-tool-use', dir });
  assert.match(first.text, /短い依頼$/);
  assert.equal(first.text.length <= CLAUDE_FORWARD_CONTEXT_MAX_CHARS, true);
  first.done();
  assert.equal(takeClaudeForwardsAsContext({ sessionId: NEXT, via: 'pre-tool-use', dir }), null,
    '先頭の1通が収まらない時は、後ろの短い入力も運ばない（順番を入れ替えない）');
  assert.deepEqual(readClaudeForwardStatus(NEXT, { dir }), { pending: 2, unknown: 0 });
  const rest = claimClaudeForwards({ sessionId: NEXT, dir });
  assert.equal(rest.count, 2, '番の終わりの道は、長さに関わらず全部を運ぶ');
  assert.equal(rest.text.includes('あ'.repeat(CLAUDE_FORWARD_CONTEXT_MAX_CHARS)), true);
  assert.deepEqual(forwardLog(dir).map(row => [row.event, row.via, row.count, row.humans, row.notifications]), [['delivered', 'pre-tool-use', 1, 1, 0]]);
  assert.equal(JSON.stringify(forwardLog(dir)).includes('短い依頼'), false, '運んだ記録に本文は書かない');
}));

test('置き場: 番の終わりの道で 60,000 字を超える1通は、頭と全文の file の場所を運ぶ', () => withDir(dir => {
  const long = '長'.repeat(60_001);
  put(dir, NEXT, long);
  const claim = claimClaudeForwards({ sessionId: NEXT, dir });
  const full = /全 60001 字の全文: (.+)）$/.exec(claim.text)?.[1];
  assert.equal(claim.text.length < 5000, true);
  assert.equal(readFileSync(full, 'utf8'), long);
}));

test('置き場: さらに引き継がれた会話の置き場に残った入力は、今の続きの会話の置き場へ移せる', () => withDir(dir => {
  put(dir, NEXT, '残っていた依頼');
  assert.equal(moveClaudeForwards({ fromSessionId: NEXT, toSessionId: LAST, dir }), 1);
  assert.equal(hasPendingClaudeForwards(NEXT, dir), false);
  assert.match(claimClaudeForwards({ sessionId: LAST, dir }).text, /残っていた依頼$/);
  assert.equal(moveClaudeForwards({ fromSessionId: NEXT, toSessionId: NEXT, dir }), 0);
}));

test('置き場の片付け: 7日を過ぎた入力は届けずに消す。後継として指されていない空の置き場は、24 時間動きが無ければ消す', () => withDir(dir => {
  const now = Date.now();
  const age = (path, ms) => { const at = new Date(now - ms); utimesSync(path, at, at); };
  put(dir, NEXT, '古い依頼');
  put(dir, LAST, '新しい依頼');
  ensureClaudeForwardInbox(OLD, dir);
  const day = 24 * 60 * 60 * 1000;
  const nextInbox = claudeForwardInboxDir(NEXT, dir);
  for (const name of readdirSync(nextInbox)) age(join(nextInbox, name), 8 * day);
  age(nextInbox, 2 * day);
  age(claudeForwardInboxDir(OLD, dir), 2 * day);
  removeStaleClaudeForwards({ dir, now, keepSessionIds: new Set([OLD]) });
  assert.deepEqual(readdirSync(nextInbox), [], '古い入力は届けずに消す');
  // 入力を消した時に置き場のフォルダの時刻が進むので、空の置き場が消えるのは、その 24 時間後の片付け
  age(nextInbox, 2 * day);
  removeStaleClaudeForwards({ dir, now, keepSessionIds: new Set([OLD]) });
  assert.equal(existsSync(nextInbox), false, '指されていない空の置き場は、24 時間動きが無ければ消す');
  assert.equal(existsSync(claudeForwardInboxDir(OLD, dir)), true, '後継として指されている会話の置き場は、空でも残す');
  assert.equal(hasPendingClaudeForwards(LAST, dir), true, '新しい入力は残す');
  assert.deepEqual(forwardLog(dir).map(row => [row.event, row.session_id, row.count]), [['expired', NEXT, 1]]);
}));

test('待つ hook: 入力が届くまで待ち、届いたら受け取って終わる。期限・会話が居なくなった時は、受け取らずに終わる', () => withDir(async dir => {
  ensureClaudeForwardInbox(NEXT, dir);
  let ticks = 0;
  const delivered = await waitForClaudeForwards({ sessionId: NEXT, dir, pollMs: 1,
    sleep: async () => { if (++ticks === 3) put(dir, NEXT, '待っている間に届いた依頼'); } });
  assert.deepEqual([delivered.code, delivered.reason, delivered.count], [2, 'delivered', 1]);
  assert.match(delivered.text, /待っている間に届いた依頼$/);
  assert.equal(ticks, 3);

  let clock = 0;
  const deadline = await waitForClaudeForwards({ sessionId: NEXT, dir, maxWaitMs: 5000, now: () => clock, sleep: async () => { clock += 1000; } });
  assert.deepEqual([deadline.code, deadline.reason], [0, 'deadline']);
  put(dir, NEXT, '会話が居なくなる前から在った依頼');
  const first = await waitForClaudeForwards({ sessionId: NEXT, dir, isOrphaned: () => true, sleep: async () => {} });
  assert.equal(first.reason, 'delivered', '在る入力は、先に受け取る');
  const orphaned = await waitForClaudeForwards({ sessionId: NEXT, dir, isOrphaned: () => true, sleep: async () => {} });
  assert.deepEqual([orphaned.code, orphaned.reason], [0, 'orphaned']);
  assert.deepEqual(forwardLog(dir).map(row => [row.event, row.reason]),
    [['wait-end', 'delivered'], ['wait-end', 'deadline'], ['wait-end', 'delivered'], ['wait-end', 'orphaned']]);
}));

test('待つ hook: 同じ会話で新しい待つ hook が立ったら、前の hook は受け取らずに退く（待つのは1つだけ）', () => withDir(async dir => {
  ensureClaudeForwardInbox(NEXT, dir);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let firstTicks = 0;
  const first = waitForClaudeForwards({ sessionId: NEXT, dir, token: 'first', sleep: async () => { if (++firstTicks === 1) await gate; } });
  await new Promise(resolve => setImmediate(resolve));
  // 次の番の終わりの hook が立つ。入力はその後に届く
  let secondTicks = 0;
  const second = waitForClaudeForwards({ sessionId: NEXT, dir, token: 'second',
    sleep: async () => { if (++secondTicks === 1) { put(dir, NEXT, '新しい hook が受け取る依頼'); release(); await new Promise(resolve => setImmediate(resolve)); } } });
  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual([a.code, a.reason], [0, 'superseded']);
  assert.deepEqual([b.code, b.reason, b.count], [2, 'delivered', 1]);
  assert.deepEqual(readClaudeForwardStatus(NEXT, { dir }).pending, 0);
}));

test('待つ hook: 自分の会話がさらに引き継がれたら、残った入力を今の続きの会話へ移して終わる（旧い会話を起こさない）', () => withDir(async dir => {
  const projects = join(dir, 'claude', 'projects', '-work-app');
  mkdirSync(projects, { recursive: true });
  writeFileSync(join(projects, `${LAST}.jsonl`), '');
  writeFileSync(join(dir, `${NEXT}.json`), JSON.stringify({ schema: 'throughline.claude-auto-handoff.v2', handoff_id: 'h-next',
    source_session_id: NEXT, project_path: '/work/app', transcript_path: join(projects, `${NEXT}.jsonl`), state: 'sent',
    requested_at: 1_000, updated_at: 2_000, error_code: null, successor: { short_id: 'cccccccc', session_id: LAST } }));
  put(dir, NEXT, '引き継ぎの直前に届いた依頼');
  const result = await waitForClaudeForwards({ sessionId: NEXT, dir, sleep: async () => { throw new Error('must not wait'); } });
  assert.deepEqual([result.code, result.reason, result.count], [0, 'handed-off', 1]);
  assert.equal(hasPendingClaudeForwards(NEXT, dir), false);
  assert.match(claimClaudeForwards({ sessionId: LAST, dir }).text, /引き継ぎの直前に届いた依頼$/);
}));

test('旧い会話の側: 止めた入力を今の続きの会話の置き場へ置く。置けない時は、後継で打ち直す文を返す', () => withDir(dir => {
  const projects = join(dir, 'claude', 'projects', '-work-app');
  mkdirSync(projects, { recursive: true });
  const record = (id, fields) => writeFileSync(join(dir, `${id}.json`), JSON.stringify({ schema: 'throughline.claude-auto-handoff.v2',
    handoff_id: `h-${id.slice(0, 8)}`, source_session_id: id, project_path: '/work/app', transcript_path: join(projects, `${id}.jsonl`),
    requested_at: 1_000, updated_at: 2_000, error_code: null, state: 'sent', ...fields }));
  const submit = (id, prompt) => redirectClaudeHandedOffPrompt({ payload: { session_id: id, prompt }, now: 1_760_000_000_000, dir, env: {}, spawn: NO_CLAUDE });
  record(OLD, { successor: { short_id: 'bbbbbbbb', session_id: NEXT } });
  writeFileSync(join(projects, `${NEXT}.jsonl`), '');
  settled(join(projects, `${NEXT}.jsonl`));

  const human = submit(OLD, '旧い会話へ打った文');
  assert.equal(human.forwarded, true);
  assert.match(human.output.reason, /届いた入力は、後継の会話へ渡しました。後継は今、入力を待ち受けていません（止まっているか、この版より前に立った会話です）。後継を開いて何か入力した時に届きます: claude attach bbbbbbbb（一覧に無い時は claude --resume bbbbbbbb-0000-4000-8000-000000000042）$/);
  // 後継で待つ hook が生きている時は、後継が動いていると返す。hook の process が居なくなった印は、生きていると読まない
  registerClaudeForwardWaiter(NEXT, `${process.pid}-1-test`, dir);
  assert.match(submit(OLD, '動いている後継へ打った文').output.reason, /届いた入力は、後継の会話へ渡しました。後継は動いています。手すきならすぐ、作業中なら次の道具の前か番の終わりに届きます。後継のモデルが、運ばれた入力を利用者の依頼として扱わない事があります。答えは後継で確かめてください: claude attach bbbbbbbb/);
  registerClaudeForwardWaiter(NEXT, '999999999-1-gone', dir);
  assert.equal(claudeForwardWaiterAlive(NEXT, dir), false);
  // ここまでの2通のうち1通を受け取って、後ろの数え方を元に戻す
  settleClaudeForwards(claimClaudeForwards({ sessionId: NEXT, dir }));
  put(dir, NEXT, '数え直しの1通');
  assert.equal(submit(OLD, '<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n</task-notification>').forwarded, true);
  assert.deepEqual(publicClaudeAutoHandoff(JSON.parse(readFileSync(join(dir, `${OLD}.json`), 'utf8')), { dir }).forward_pending, 2);

  // 後継がさらに引き継がれている時は、その先の置き場へ置く
  record(NEXT, { state: 'unknown', successor: { short_id: 'cccccccc', session_id: null } });
  writeFileSync(join(projects, `${LAST}.jsonl`), '');
  settled(join(projects, `${LAST}.jsonl`));
  assert.equal(submit(OLD, '後継の先へ届く文').forwarded, true);
  assert.deepEqual(readClaudeForwardStatus(NEXT, { dir }).pending, 2);
  assert.match(claimClaudeForwards({ sessionId: LAST, dir }).text, /引き継ぎ前の会話（aaaaaaaa）.*\n後継の先へ届く文$/s);

  // ほかの会話から届いた文は、利用者の入力と分けて運ぶ
  assert.equal(submit(OLD, 'Another Claude session sent a message:\n確認をお願いします\n\nThis came from another Claude session').forwarded, true);
  const peer = claimClaudeForwards({ sessionId: LAST, dir });
  assert.match(peer.text, /（ほかの会話からの文 1 通）。.*\n--- ほかの会話からの文（[^）]*利用者の入力ではありません）---\nAnother Claude session sent a message:\n確認をお願いします/s);
  assert.deepEqual([peer.humans, peer.notifications], [1, 0]);
  assert.equal(claudeForwardCarriesHumanInput(peer.text), true, 'ほかの会話からの文も、届いた入力として記憶へ残す');

  // 空の入力と slash command は運ばない。その時は 0.16.31 と同じ文
  for (const prompt of ['', '/tl', '  /clear', '/compact 要点だけ']) {
    const kept = submit(OLD, prompt);
    assert.equal(kept.forwarded, false, prompt);
    assert.match(kept.output.reason, /続きは後継の会話で行ってください: claude attach cccccccc/);
  }
  assert.equal(hasPendingClaudeForwards(LAST, dir), false);
  assert.equal(submit(OLD, '/etc/hosts を見て').forwarded === false, true, '頭が / の文は、命令と見分けられないので運ばない');
  const redirects = readFileSync(join(dir, 'redirects.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(redirects.map(row => [row.kind, row.forwarded]), [['prompt', true], ['prompt', true], ['task-notification', true], ['prompt', true],
    ['prompt', true], ['prompt', false], ['prompt', false], ['prompt', false], ['prompt', false], ['prompt', false]]);
  assert.equal(readFileSync(join(dir, 'redirects.jsonl'), 'utf8').includes('旧い会話へ打った文'), false, '止めた記録に本文は書かない');
}));

test('後継の側: 継続の指示を受領した時に、置き場が出来る（番の終わりの待つ hook が待つ様になる）', () => withDir(dir => {
  writeFileSync(join(dir, `${OLD}.json`), JSON.stringify({ schema: 'throughline.claude-auto-handoff.v2', handoff_id: 'h-accept',
    source_session_id: OLD, project_path: '/work/app', transcript_path: null, state: 'launching', requested_at: 1_000, updated_at: 2_000,
    error_code: null, successor: null }));
  assert.equal(existsSync(claudeForwardInboxDir(NEXT, dir)), false);
  const accepted = acceptClaudeAutoContinuation({ predecessorId: OLD, successorSessionId: NEXT, prompt: 'Throughline自動継続 h-accept\n続けてください', dir });
  assert.equal(accepted.handoffId, 'h-accept');
  assert.equal(existsSync(claudeForwardInboxDir(NEXT, dir)), true);
}));

test('記憶: 運んだ利用者の入力を、後継の記録の中で利用者の発言として読む。完了通知だけを文脈で運んだ分は足さない', () => withDir(dir => {
  const human = `${CLAUDE_FORWARD_MARK}引き継ぎ前の会話（aaaaaaaa）へ届いた入力を、Throughlineがこの会話へ運びました（利用者の入力 1 通）。作業はこの会話が引き継いでいます。\n` +
    '--- 利用者の入力（2026-10-14 08:00 に届いた。利用者がこの会話へ打った入力として扱ってください）---\n運ばれた依頼';
  const note = `${CLAUDE_FORWARD_MARK}引き継ぎ前の会話（aaaaaaaa）へ届いた入力を、Throughlineがこの会話へ運びました（裏の作業の通知 1 通）。作業はこの会話が引き継いでいます。\n` +
    '--- 裏の作業の通知（2026-10-14 08:01 に届いた。引き継ぎ前の会話が裏で起こした作業の通知です。結果が要る時は、出力の file を読んで確かめてください）---\n<task-notification>\n<status>completed</status>\n</task-notification>';
  const wrapped = text => `<task-notification>\n<summary>Stop hook feedback</summary>\n</task-notification>\n<system-reminder>\nStop hook blocking error from command "throughline claude-forward-wait": ${text}\n</system-reminder>`;
  assert.equal(unwrapClaudeForwardedDelivery(wrapped(human)), human);
  assert.equal(unwrapClaudeForwardedDelivery('<task-notification>\n<summary>Stop hook feedback</summary>\n</task-notification>\n<system-reminder>\nほかの hook の文\n</system-reminder>'), null);
  assert.equal(unwrapClaudeForwardedDelivery(human), null, '包みの無い文は、そのまま読む');
  assert.equal(claudeForwardCarriesHumanInput(human), true);
  assert.equal(claudeForwardCarriesHumanInput(note), false);

  const transcript = join(dir, 't.jsonl');
  const user = (text, extra = {}) => ({ type: 'user', timestamp: '2026-10-14T00:00:00.000Z', ...extra, message: { role: 'user', content: text } });
  const assistant = text => ({ type: 'assistant', timestamp: '2026-10-14T00:00:01.000Z', message: { role: 'assistant', content: [{ type: 'text', text }] } });
  const context = text => ({ type: 'attachment', attachment: { type: 'hook_additional_context', content: [text], hookName: 'PreToolUse', hookEvent: 'PreToolUse' } });
  writeFileSync(transcript, jsonl([
    user('最初の依頼', { origin: { kind: 'human' } }),
    context(human),
    context(note),
    context('ほかの hook が足した文脈'),
    // 前の番から待っていた hook が、作業中に運んだ入力。Claude Code が通知の形で順番待ちへ入れる
    { type: 'attachment', attachment: { type: 'queued_command', prompt: wrapped(human.replace('運ばれた依頼', '作業中に運ばれた依頼')), origin: { kind: 'task-notification', producer: 'session-task' } } },
    { type: 'attachment', attachment: { type: 'queued_command', prompt: wrapped(note), origin: { kind: 'task-notification', producer: 'session-task' } } },
    // 道具の前の hook の出力そのもの（JSON）も hook_success で残る。運んだ文で始まらないので、足さない
    { type: 'attachment', attachment: { type: 'hook_success', hookEvent: 'PreToolUse', content: JSON.stringify({ hookSpecificOutput: { additionalContext: human } }) } },
    assistant('1つめの答え'),
    user(wrapped(human), { origin: { kind: 'task-notification', producer: 'session-task' } }),
    assistant('2つめの答え'),
    // 止まっていた後継を開いて入力した時: 入力の hook が stdout へ出した文脈は、入力の行の後ろに hook_success で残る
    user('後継を開いて打った依頼', { origin: { kind: 'human' } }),
    { type: 'attachment', attachment: { type: 'hook_success', hookEvent: 'UserPromptSubmit', content: `${human}\n`, stdout: `${human}\n` } },
    { type: 'attachment', attachment: { type: 'hook_success', hookEvent: 'UserPromptSubmit', content: `${note}\n` } },
    assistant('3つめの答え'),
  ]));
  const turns = readTranscript(transcript);
  assert.deepEqual(turns.map(turn => turn.role), ['user', 'assistant', 'user', 'assistant', 'user', 'assistant']);
  assert.equal(turns[0].content, `最初の依頼\n\n${MID_TURN_INPUT_MARK}\n${human}` +
    `\n\n${MID_TURN_INPUT_MARK}\n${human.replace('運ばれた依頼', '作業中に運ばれた依頼')}`);
  assert.equal(turns[2].content, human, '番の終わりの道で届いた行は、包みを外して運んだ文だけを残す');
  assert.equal(turns[4].content, `後継を開いて打った依頼\n\n${MID_TURN_INPUT_MARK}\n${human}`);
}));

// ---- 実際の CLI を temp HOME で動かす ----

function childEnv(home, extra = {}) {
  return { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_STATE_HOME: join(home, '.local', 'state'),
    LOCALAPPDATA: join(home, 'AppData', 'Local'), THROUGHLINE_NO_VSCODE: '1', CLAUDE_PROJECT_DIR: '', CLAUDE_CODE_ENTRYPOINT: 'cli',
    CLAUDE_PID: '', ...extra };
}
const cli = (home, args, input, extra = {}) =>
  spawnSync(process.execPath, [CLI, ...args], { cwd: REPO_ROOT, env: childEnv(home, extra), input, encoding: 'utf8', timeout: 60_000 });

test('公開CLI: claude-forward-wait は、置き場が無い会話と script から起動した会話ではすぐ終わり、入力が在れば stderr へ出して exit code 2 で終わる', () => withDir(home => {
  const dir = join(home, '.throughline', 'claude-auto-handoff');
  const stop = (sessionId, extra = {}, env = {}) => cli(home, ['claude-forward-wait'],
    JSON.stringify({ session_id: sessionId, hook_event_name: 'Stop', stop_hook_active: false, ...extra }), env);

  const none = stop(NEXT);
  assert.deepEqual([none.status, none.stdout, none.stderr], [0, '', ''], '置き場が無い会話');
  assert.equal(existsSync(join(home, '.throughline')), false, '置き場が無い会話では、何も作らない');

  put(dir, NEXT, '手すきの後継へ届く依頼');
  assert.deepEqual([stop(NEXT, {}, { CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' }).status, hasPendingClaudeForwards(NEXT, dir)], [0, true],
    'script から起動した会話では待たない。入力は置き場に残る');
  assert.deepEqual([stop(NEXT, { agent_id: 'agent-1' }).status, hasPendingClaudeForwards(NEXT, dir)], [0, true], 'subagent の中では待たない');

  const delivered = stop(NEXT);
  assert.equal(delivered.status, 2, delivered.stderr);
  assert.equal(delivered.stdout, '');
  assert.match(delivered.stderr, /^【Throughline 転送】引き継ぎ前の会話（aaaaaaaa）.*\n手すきの後継へ届く依頼$/s);
  assert.deepEqual(readClaudeForwardStatus(NEXT, { dir }), { pending: 0, unknown: 0 });
  assert.deepEqual(forwardLog(dir).map(row => [row.event, row.via ?? row.reason ?? null]),
    [['wait-start', null], ['wait-end', 'delivered'], ['delivered', 'stop']]);
  assert.equal(existsSync(join(home, '.throughline', 'throughline.db')), false, '待つ hook は DB を開かない');
}));

test('公開CLI: pre-tool-use は、後継の置き場で待っている入力を、道具を止めずに文脈として返す', () => withDir(home => {
  const dir = join(home, '.throughline', 'claude-auto-handoff');
  const tool = sessionId => cli(home, ['pre-tool-use'], JSON.stringify({ session_id: sessionId, hook_event_name: 'PreToolUse',
    tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: home }));
  ensureClaudeForwardInbox(NEXT, dir);
  assert.deepEqual([tool(NEXT).status, tool(NEXT).stdout], [0, ''], '置き場が空の時は、何も返さない');
  put(dir, NEXT, '作業中の後継へ届く依頼');
  const first = tool(NEXT);
  assert.equal(first.status, 0, first.stderr);
  const output = JSON.parse(first.stdout);
  assert.deepEqual(Object.keys(output), ['hookSpecificOutput']);
  assert.equal(output.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(output.hookSpecificOutput.permissionDecision, undefined, '道具は止めない');
  assert.match(output.hookSpecificOutput.additionalContext, /^【Throughline 転送】.*\n作業中の後継へ届く依頼$/s);
  assert.equal(tool(NEXT).stdout, '', '同じ入力を2回は届けない');
  assert.equal(existsSync(join(home, '.throughline', 'throughline.db')), false);
}));

// ---- 止まっている後継を、人の入力で起こして届ける (ADR 0064) ----

test('置き場: 起こす命令で渡す入力は受け取り済みとして置き、届いたら消し、届かなかったら置き場へ戻す', () => withDir(dir => {
  const held = holdClaudeForward({ successorSessionId: NEXT, sourceSessionId: OLD, handoffId: 'h-1', kind: 'prompt', text: '起こして渡す文', now: 1_000, dir });
  assert.deepEqual(readClaudeForwardStatus(NEXT, { dir, now: 2_000 }), { pending: 0, unknown: 0 });
  assert.equal(hasPendingClaudeForwards(NEXT, dir), false, '起きた後継の hook が、同じ文を文脈としてもう1回渡さない');
  assert.equal(held.release(), true);
  assert.match(claimClaudeForwards({ sessionId: NEXT, dir }).text, /\n起こして渡す文$/);
  const done = holdClaudeForward({ successorSessionId: NEXT, sourceSessionId: OLD, handoffId: 'h-1', kind: 'prompt', text: '届いた文', now: 1_000, dir });
  done.settle();
  assert.deepEqual(readdirSync(join(claudeForwardInboxDir(NEXT, dir), 'claimed')).filter(name => name.includes('-')).length, 1, '前の claim の残りだけ');
  assert.equal(holdClaudeForward({ successorSessionId: '../x', text: 'x', dir }), null);
}));

test('置き場: 起こす番は1つだけ。60 秒を過ぎた印は取り直せる。片付けは印を入力として数えない', () => withDir(dir => {
  const release = acquireClaudeWakeClaim(NEXT, { dir, now: Date.now() });
  assert.equal(typeof release, 'function');
  assert.equal(acquireClaudeWakeClaim(NEXT, { dir, now: Date.now() }), null, '起こしている間は、次の入力で起こさない');
  release();
  const again = acquireClaudeWakeClaim(NEXT, { dir, now: Date.now() });
  assert.equal(typeof again, 'function');
  const mark = join(claudeForwardInboxDir(NEXT, dir), 'waking');
  const past = new Date(Date.now() - 61_000); utimesSync(mark, past, past);
  assert.equal(typeof acquireClaudeWakeClaim(NEXT, { dir, now: Date.now() }), 'function', '期限を過ぎた印');
  utimesSync(mark, new Date(0), new Date(0));
  removeStaleClaudeForwards({ dir, now: Date.now(), keepSessionIds: new Set([NEXT]) });
  assert.equal(existsSync(join(dir, 'forward.jsonl')), false, '印は期限切れの入力として数えない');
  assert.equal(acquireClaudeWakeClaim('../x', { dir }), null);
}));

test('一覧の読み方: 裏の項目に pid も status も無く、state が done か stopped の時だけ止まっていると読む', () => {
  const read = (entries, extra = {}) => readClaudeSessionStopped(NEXT, { spawn: () => ({ status: 0, stdout: JSON.stringify(entries), ...extra }) });
  const bg = fields => ({ id: 'bbbbbbbb', kind: 'background', sessionId: NEXT, name: 'n', cwd: '/w', startedAt: 1, ...fields });
  assert.deepEqual(read([bg({ state: 'done' })]), { stopped: true, reason: 'stopped' }, '手すきで止めた・片付けられた');
  assert.deepEqual(read([bg({ state: 'stopped' })]), { stopped: true, reason: 'stopped' }, '作業の途中で止めた');
  assert.equal(read([bg({ state: 'done', pid: 10, status: 'idle' })]).reason, 'running', '手すきで動いている');
  assert.equal(read([bg({ state: 'working', pid: 10, status: 'busy' })]).reason, 'running', '作業中');
  assert.equal(read([bg({ state: 'done' }), { kind: 'interactive', sessionId: NEXT, pid: 11, status: 'idle', name: 'n' }]).reason, 'running', '端末で開いている・claude -p --resume が走っている');
  assert.equal(read([bg({ state: 'working' })]).reason, 'not_stopped', '立ち上げ中（pid がまだ無い）');
  assert.equal(read([bg({ state: 'failed' })]).reason, 'not_stopped');
  assert.equal(read([{ ...bg({ state: 'done' }), sessionId: LAST }]).reason, 'not_listed', 'claude rm で一覧から消した');
  assert.equal(read([{ kind: 'interactive', sessionId: NEXT, name: 'n' }]).reason, 'not_background');
  assert.equal(read([], { status: 1 }).reason, 'list_failed');
  assert.equal(read(null, { stdout: 'not json' }).reason, 'list_failed');
  assert.equal(readClaudeSessionStopped(NEXT, { spawn: NO_CLAUDE }).reason, 'list_failed');
});

test('旧い会話の側: 人が打った文で、後継が止まっていれば、後継を起こしてその文を最初の入力として渡す', () => withDir(dir => {
  const projects = join(dir, 'claude', 'projects', '-work-app');
  const project = join(dir, 'app');
  mkdirSync(projects, { recursive: true }); mkdirSync(project);
  writeFileSync(join(dir, `${OLD}.json`), JSON.stringify({ schema: 'throughline.claude-auto-handoff.v2', handoff_id: 'h-aaaaaaaa',
    source_session_id: OLD, project_path: project, transcript_path: join(projects, `${OLD}.jsonl`), requested_at: 1_000, updated_at: 2_000,
    error_code: null, state: 'sent', successor: { short_id: 'bbbbbbbb', session_id: NEXT } }));
  const transcript = join(projects, `${NEXT}.jsonl`);
  writeFileSync(transcript, ''); settled(transcript);
  const bg = fields => ({ id: 'bbbbbbbb', kind: 'background', sessionId: NEXT, name: 'n', cwd: project, startedAt: 1, ...fields });
  let listing = [bg({ state: 'done' })];
  let woke = { status: 0, stdout: 'backgrounded · bbbbbbbb · n\n  claude attach bbbbbbbb    open in this terminal\nnote: woke session bbbbbbbb with its saved options (--name, --model).\n' };
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push({ args, cwd: options.cwd, env: options.env });
    if (args[0] === 'agents') return { status: 0, stdout: JSON.stringify(listing) };
    if (args[0] === '--bg') return typeof woke === 'function' ? woke() : woke;
    return { status: 0, stdout: `${args[0]}ped` };
  };
  const env = { CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CODE_SESSION_ID: OLD, PATH: '/bin' };
  const submit = (prompt, extraEnv = {}) => redirectClaudeHandedOffPrompt({ payload: { session_id: OLD, prompt }, now: Date.now(), dir, env: { ...env, ...extraEnv }, spawn });
  const inbox = claudeForwardInboxDir(NEXT, dir);
  const pending = () => readClaudeForwardStatus(NEXT, { dir }).pending;
  const claimed = () => { try { return readdirSync(join(inbox, 'claimed')).length; } catch { return 0; } };
  const events = () => readFileSync(join(dir, 'forward.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const freeClaim = () => rmSync(join(inbox, 'waking'), { force: true });
  const open = `claude attach bbbbbbbb（一覧に無い時は claude --resume ${NEXT}）`;

  // 1) 止まっている後継: 起こして、文をそのまま渡す。option は付けず、文は -- の後。会話ごとの環境変数は渡さない
  const text = '-v を付けて、もう一度ビルドして\n2行目';
  const woken = submit(text);
  assert.deepEqual([woken.wake, woken.forwarded], ['woken', true]);
  assert.equal(woken.output.reason, 'この会話はThroughlineが新しい会話へ引き継ぎ済みです（引き継ぎID: h-aaaaaaaa）。' +
    `後継の会話が止まっていたので、Throughlineが起こして、この入力を後継の最初の入力として渡しました。後継は裏で作業を続けます: ${open}`);
  assert.deepEqual(calls.map(call => call.args), [['agents', '--json', '--all'], ['--bg', '--resume', NEXT, '--', text]]);
  assert.equal(calls[1].cwd, project);
  assert.deepEqual(Object.keys(calls[1].env).filter(key => key.startsWith('CLAUDE')), [], '旧い会話の環境変数を後継へ渡さない');
  assert.deepEqual([pending(), claimed()], [0, 0], '渡した文は置き場に残さない（起きた後継の hook が二重に渡さない）');
  assert.deepEqual(events().at(-1), { at: events().at(-1).at, event: 'woken', session_id: NEXT, source_session_id: OLD, chars: text.length });
  assert.equal(readFileSync(join(dir, 'forward.jsonl'), 'utf8').includes('ビルド'), false, '運んだ記録に本文は書かない');
  assert.equal(JSON.parse(readFileSync(join(dir, 'redirects.jsonl'), 'utf8').trim().split('\n').at(-1)).wake, 'woken');

  // 2) 起こした直後の次の入力: 番の印が残っているので起こさず、置き場へ置く
  calls.length = 0;
  const second = submit('続けてもう1つ');
  assert.deepEqual([second.wake, second.forwarded, pending()], ['skipped', true, 1]);
  assert.match(second.output.reason, /後継は、先に届いた入力で起きている所です。起きた後継が、次の道具の前か番の終わりに読みます。/);
  assert.deepEqual(calls, [], '一覧も読まない');
  freeClaim();

  // 3) 動いている後継（手すき・作業中・端末で開いている）: 起こさず、置き場へ置いて「動いています」と返す
  for (const entries of [[bg({ state: 'done', pid: 5, status: 'idle' })], [bg({ state: 'working', pid: 5, status: 'busy' })],
    [bg({ state: 'done' }), { kind: 'interactive', sessionId: NEXT, pid: 6, status: 'idle', name: 'n' }]]) {
    listing = entries; calls.length = 0;
    const result = submit('動いている後継へ');
    assert.deepEqual([result.wake, result.forwarded], ['skipped', true]);
    assert.match(result.output.reason, /後継は動いています。/);
    assert.deepEqual(calls.map(call => call.args[0]), ['agents'], '起こす命令は流さない');
    assert.equal(existsSync(join(inbox, 'waking')), false, '起こさなかった時は番を返す');
  }

  // 4) 止まっていると確かめられない（一覧に無い・立ち上げ中・一覧を読めない）: 起こさず、0.16.32 と同じ文
  for (const entries of [[], [bg({ state: 'working' })], 'unreadable']) {
    listing = entries; calls.length = 0;
    const result = submit('確かめられない後継へ');
    assert.deepEqual([result.wake, result.forwarded], ['skipped', true]);
    assert.match(result.output.reason, /後継は今、入力を待ち受けていません（止まっているか、この版より前に立った会話です）。/);
    assert.equal(calls.some(call => call.args[0] === '--bg'), false);
  }

  // 5) 写しが立った（確かめた後に後継が動き出した）: 写しを止めて一覧から消し、入力は置き場へ戻す
  listing = [bg({ state: 'done' })]; calls.length = 0;
  woke = { status: 0, stdout: 'backgrounded · 12345678\nnote: session bbbbbbbb is already running in the background, so this started a copy as 12345678.\n' };
  const before = pending();
  const copied = submit('写しが立つ入力');
  assert.deepEqual([copied.wake, copied.forwarded, pending()], ['queued', true, before + 1]);
  assert.deepEqual(calls.map(call => call.args), [['agents', '--json', '--all'], ['--bg', '--resume', NEXT, '--', '写しが立つ入力'], ['stop', '12345678'], ['rm', '12345678']]);
  assert.match(copied.output.reason, /届いた入力は、後継の会話へ渡しました。後継は動いています。/);
  assert.deepEqual([events().at(-1).event, events().at(-1).copy_short_id, events().at(-1).queued], ['wake-copy', '12345678', true]);

  // 6) 起こす命令が失敗した: 置き場へ戻す
  woke = { status: 1, stdout: '', stderr: 'Error: something went wrong\n' }; calls.length = 0;
  const failed = submit('失敗する入力');
  assert.deepEqual([failed.wake, failed.forwarded, pending()], ['queued', true, before + 2]);
  assert.match(failed.output.reason, /後継は今、入力を待ち受けていません/);

  // 7) 起きたか分からない（時間切れ）: 入れ直さない
  woke = () => ({ error: Object.assign(new Error('spawnSync claude ETIMEDOUT'), { code: 'ETIMEDOUT' }) });
  const unknown = submit('分からない入力');
  assert.deepEqual([unknown.wake, unknown.forwarded, pending(), claimed()], ['unknown', false, before + 2, 1]);
  assert.equal(unknown.output.reason, 'この会話はThroughlineが新しい会話へ引き継ぎ済みです（引き継ぎID: h-aaaaaaaa）。' +
    '後継の会話が止まっていたので起こそうとしましたが、起きて入力を受け取ったか確かめられませんでした。' +
    `二重に届かないよう、この入力は入れ直していません。後継を開いて確かめてください: ${open}`);
  assert.equal(events().at(-1).event, 'wake-unknown');
  freeClaim();

  // 8) 起こさない入力: 完了通知・ほかの会話からの文・長すぎる文・NUL を含む文・上書きで止めた時・書かれたばかりの transcript
  woke = { status: 0, stdout: 'backgrounded · bbbbbbbb · n\n' }; calls.length = 0;
  assert.equal(submit('<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n</task-notification>').wake, undefined);
  assert.equal(submit('Another Claude session sent a message:\n確認をお願いします').wake, undefined);
  assert.equal(submit('あ'.repeat(CLAUDE_WAKE_TEXT_MAX_CHARS + 1)).wake, 'skipped');
  assert.equal(submit('NUL\0入り').wake, 'skipped');
  assert.equal(submit('止めた時', { THROUGHLINE_AUTO_HANDOFF_WAKE: 'off' }).wake, 'skipped');
  writeFileSync(transcript, '{}\n');
  const fresh = submit('書かれたばかり');
  assert.match(fresh.output.reason, /後継は動いています。/);
  settled(transcript);
  assert.deepEqual(calls, [], 'どれも一覧を読まず、起こす命令も流さない');
  // Claude Desktop へ移した後継も起こさない
  const record = JSON.parse(readFileSync(join(dir, `${OLD}.json`), 'utf8'));
  writeFileSync(join(dir, `${OLD}.json`), JSON.stringify({ ...record, desktop: { wanted: true, state: 'opened' } }));
  assert.equal(submit('Desktop へ移した後継').wake, 'skipped');
  assert.deepEqual(calls, []);
  writeFileSync(join(dir, `${OLD}.json`), JSON.stringify(record));

  // 9) 後継がさらに引き継がれている時は、一番先の会話を起こす
  writeFileSync(join(dir, `${NEXT}.json`), JSON.stringify({ schema: 'throughline.claude-auto-handoff.v2', handoff_id: 'h-bbbbbbbb',
    source_session_id: NEXT, project_path: project, transcript_path: transcript, requested_at: 1_000, updated_at: 2_000,
    error_code: null, state: 'sent', successor: { short_id: 'cccccccc', session_id: LAST } }));
  writeFileSync(join(projects, `${LAST}.jsonl`), ''); settled(join(projects, `${LAST}.jsonl`));
  listing = [{ id: 'cccccccc', kind: 'background', sessionId: LAST, state: 'done', name: 'n', cwd: project, startedAt: 1 }];
  woke = { status: 0, stdout: 'backgrounded · cccccccc · n\nnote: woke session cccccccc with its saved options (--name).\n' };
  const chained = submit('一番先へ');
  assert.equal(chained.wake, 'woken');
  assert.deepEqual(calls.at(-1).args, ['--bg', '--resume', LAST, '--', '一番先へ']);
}));
