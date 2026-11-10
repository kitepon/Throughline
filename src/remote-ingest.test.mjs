import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { openDb, openReadOnlyDb } from './db.mjs';
import { ingestRemoteTranscript, readRemoteHandoffContext } from './remote-ingest.mjs';

const bin = fileURLToPath(new URL('../bin/throughline.mjs', import.meta.url));
const binding = { botId: 'bot-a', sessionName: 'bot-a', launchId: 'a'.repeat(32), claudeSessionId: 'claude-a' };
const line = (role, text, at, ending = '\n') => JSON.stringify({ type: role,
  message: { role, content: [{ type: 'text', text }] }, timestamp: new Date(at).toISOString() }) + ending;
const pair = (user = 'request', answer = 'final answer', at = 1_700_000_000_000, ending = '\n') =>
  [line('user', user, at, ending), line('assistant', answer, at + 1, ending)];
const input = (entries, offset = Buffer.byteLength(entries.join('')), bound = binding) => ({
  ...bound, entries, cursor: { claudeSessionId: bound.claudeSessionId, offset },
});
function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'tl-remote-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}
function dbPath(home) {
  const directory = join(home, '.throughline', 'remote-transcripts');
  return join(directory, readdirSync(directory).find(name => name.endsWith('.sqlite')));
}
function snapshot(home) {
  const db = openReadOnlyDb(dbPath(home));
  try {
    return {
      source: db.prepare('SELECT source, offset FROM remote_transcripts').all().map(row => ({
        source: Buffer.from(row.source).toString('utf8'), offset: row.offset,
      })),
      bodies: db.prepare('SELECT role, text, turn_number, created_at FROM bodies ORDER BY id').all().map(row => ({ ...row })),
      updated: db.prepare('SELECT updated_at FROM sessions').all().map(row => row.updated_at),
    };
  } finally { db.close(); }
}

test('UTF-8/CRLF replay, overlapping reconnect ranges and lost ACK preserve exact source and ordering', t => {
  const home = fixture(t);
  const first = pair('依頼🐈', '回答一', undefined, '\r\n');
  const second = pair('次の依頼', '回答二', 1_700_000_002_000);
  const all = [...first, ...second];
  const firstInput = input(first);
  const end = Buffer.byteLength(all.join(''));
  assert.deepEqual(ingestRemoteTranscript(firstInput, { home, now: 10 }), { ackedCursor: firstInput.cursor });
  assert.deepEqual(ingestRemoteTranscript(input(all), { home, now: 20 }).ackedCursor.offset, end);
  const saved = snapshot(home);
  assert.deepEqual(ingestRemoteTranscript(firstInput, { home, now: 30 }).ackedCursor.offset, end);
  assert.deepEqual(snapshot(home), saved);
  assert.equal(saved.source[0].source, all.join(''));
  assert.equal(saved.bodies.length, 4);
  assert.deepEqual(saved.bodies.map(body => body.text), ['依頼🐈', '回答一', '次の依頼', '回答二']);
  const gap = input(pair(), end + Buffer.byteLength(pair().join('')) + 1);
  assert.throws(() => ingestRemoteTranscript(gap, { home }), error =>
    error.code === 'E_REMOTE_GAP' && error.expectedCursor.offset === end);
  const altered = first[0].replace('依頼', '改竄');
  assert.throws(() => ingestRemoteTranscript(input([altered]), { home }), error =>
    error.code === 'E_REMOTE_CONFLICT' && error.expectedCursor.offset === end);
  assert.deepEqual(snapshot(home), saved);
  assert.equal(existsSync(join(home, '.throughline', 'throughline.db')), false);
  assert.equal(readdirSync(join(home, '.throughline', 'remote-transcripts')).some(name => name.startsWith('parse-')), false);
  if (process.platform !== 'win32') assert.equal(statSync(dbPath(home)).mode & 0o777, 0o600);
});

test('failed projection rolls back source, cursor and both body writes; retry recovers', t => {
  const home = fixture(t);
  const initial = pair();
  ingestRemoteTranscript(input(initial), { home });
  const before = snapshot(home);
  let db = openDb(dbPath(home));
  db.exec(`CREATE TRIGGER reject_answer BEFORE INSERT ON bodies
    WHEN NEW.role = 'assistant' BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END;`);
  db.close();
  const extra = pair('new question', 'new answer', 1_700_000_004_000);
  const request = input(extra, Buffer.byteLength([...initial, ...extra].join('')));
  assert.throws(() => ingestRemoteTranscript(request, { home }), /synthetic failure/);
  assert.deepEqual(snapshot(home), before);
  db = openDb(dbPath(home));
  db.exec('DROP TRIGGER reject_answer');
  db.close();
  assert.deepEqual(ingestRemoteTranscript(request, { home }).ackedCursor, request.cursor);
  assert.equal(snapshot(home).bodies.length, 4);
});

test('appending a transcript without timestamps preserves the first capture time of older pairs', t => {
  const home = fixture(t);
  const untimed = entries => entries.map(value => {
    const entry = JSON.parse(value);
    delete entry.timestamp;
    return JSON.stringify(entry) + '\n';
  });
  const first = untimed(pair('first', 'first answer'));
  const second = untimed(pair('second', 'second answer'));
  ingestRemoteTranscript(input(first), { home, now: 10 });
  ingestRemoteTranscript(input(second, Buffer.byteLength([...first, ...second].join(''))), { home, now: 20 });
  assert.deepEqual(snapshot(home).bodies.map(body => body.created_at), [10, 10, 20, 20]);
});

test('late final text and byte pages update one group across launches; Bot/session isolation and recent handoff', t => {
  const home = fixture(t);
  const first = pair('first request', 'working commentary');
  ingestRemoteTranscript(input(first), { home, now: 1 });
  const final = line('assistant', 'completed final', 1_700_000_000_002);
  const nextBinding = { ...binding, sessionName: 'bot-a-2nd', launchId: 'b'.repeat(32) };
  ingestRemoteTranscript(input([final], Buffer.byteLength([...first, final].join('')), nextBinding), { home, now: 2 });
  assert.deepEqual(snapshot(home).bodies.map(body => body.text), ['first request', 'completed final']);
  const next = { ...binding, claudeSessionId: 'claude-b' };
  ingestRemoteTranscript(input(pair('second request', 'second final', 1_700_000_002_000), undefined, next), { home, now: 3 });
  const otherBot = { ...binding, botId: 'bot-b', sessionName: 'bot-b' };
  ingestRemoteTranscript(input(pair('private other Bot', 'other Bot final'), undefined, otherBot), { home, now: 4 });
  const handoff = readRemoteHandoffContext('bot-a', { home });
  assert.match(handoff.context, /completed final/);
  assert.match(handoff.context, /second final/);
  assert.doesNotMatch(handoff.context, /working commentary|private other Bot|other Bot final/);
  assert.equal(handoff.sessions.length, 2);
  assert.ok(handoff.context.length <= 9500);
  assert.equal(readRemoteHandoffContext('bot-without-records', { home }), null);
});

test('invalid bytes, line boundaries, session mismatches and gaps cannot create acknowledged history', t => {
  const home = fixture(t);
  const valid = input(pair());
  const invalid = [null, { ...valid, launchId: 'bad' },
    { ...valid, cursor: { claudeSessionId: 'wrong', offset: valid.cursor.offset } },
    { ...valid, entries: ['{"type":"user"}'] }, { ...valid, entries: ['{}\n{}\n'] },
    { ...valid, entries: ['not json\n'] }, { ...valid, entries: ['null\n'] },
    { ...valid, entries: ['{"text":"\ud800"}\n'] },
    { ...valid, cursor: { claudeSessionId: binding.claudeSessionId, offset: -1 } },
    { ...valid, cursor: { claudeSessionId: binding.claudeSessionId, offset: 1 } }];
  for (const value of invalid) assert.throws(() => ingestRemoteTranscript(value, { home }), TypeError);
  assert.equal(existsSync(join(home, '.throughline')), false);
  const empty = input([]);
  assert.deepEqual(ingestRemoteTranscript(empty, { home }).ackedCursor, empty.cursor);
  assert.equal(readRemoteHandoffContext(binding.botId, { home }), null);
});

test('public commands survive process restart and expose compatible handoff/error JSON without touching local DB', t => {
  const home = fixture(t);
  const run = (args, request) => spawnSync(process.execPath, [bin, ...args], {
    env: { ...process.env, HOME: home, USERPROFILE: home },
    input: request === undefined ? undefined : JSON.stringify(request), encoding: 'utf8',
  });
  const empty = run(['remote-handoff-context', '--bot', 'bot-a', '--json']);
  assert.equal(empty.status, 0, empty.stderr);
  assert.equal(JSON.parse(empty.stdout).status, 'empty');
  assert.equal(existsSync(join(home, '.throughline')), false);
  const request = input(pair('portable 依頼', 'portable 回答'));
  for (let n = 0; n < 2; n++) {
    const result = run(['remote-ingest', '--json'], request);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { schema: 'throughline.remote_ingest.v1', status: 'ready', ackedCursor: request.cursor });
  }
  const result = run(['remote-handoff-context', '--bot', 'bot-a', '--json']);
  assert.equal(result.status, 0, result.stderr);
  const value = JSON.parse(result.stdout);
  assert.equal(value.schema, 'throughline.handoff_context.v1');
  assert.equal(value.status, 'ready');
  assert.match(value.context, /portable 回答/);
  const bad = run(['remote-ingest', '--json'], { ...request, entries: ['secret-raw-transcript\n'] });
  assert.equal(bad.status, 1);
  assert.equal(JSON.parse(bad.stderr).code, 'E_REMOTE_INPUT');
  assert.doesNotMatch(bad.stderr + bad.stdout, /secret-raw-transcript/);
  // fork は `--fork --json` と本文の fork 欄の対でだけ受ける。片方だけは E_REMOTE_INPUT。
  const forkBinding = { ...binding, claudeSessionId: 'claude-fork' };
  const forkRequest = { ...input(pair('fork 依頼', 'fork 回答'), undefined, forkBinding), sessionKind: 'fork', parentSessionId: 'seat-main', forkId: 'f-1' };
  assert.equal(JSON.parse(run(['remote-ingest', '--json'], forkRequest).stderr).code, 'E_REMOTE_INPUT');
  const { sessionKind: _k, parentSessionId: _p, forkId: _f, ...unlabelled } = forkRequest;
  assert.equal(JSON.parse(run(['remote-ingest', '--fork', '--json'], unlabelled).stderr).code, 'E_REMOTE_INPUT');
  const forked = run(['remote-ingest', '--fork', '--json'], forkRequest);
  assert.equal(forked.status, 0, forked.stderr);
  assert.doesNotMatch(JSON.parse(run(['remote-handoff-context', '--bot', 'bot-a', '--json']).stdout).context, /fork 回答/);
  assert.equal(existsSync(join(home, '.throughline', 'throughline.db')), false);
});
