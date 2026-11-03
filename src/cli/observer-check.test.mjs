import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable, PassThrough, Writable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './observer-check.mjs';
import { OBSERVER_CHECK_REQUEST_SCHEMA as schema, OBSERVER_CHECK_RESULT_SCHEMA as outputSchema } from '../observer-check.mjs';
import { installCancellation } from '../observer-cancellation.mjs';
import { _internal as waitInternal } from './observer-wait.mjs';

const BIN = fileURLToPath(new URL('../../bin/throughline.mjs', import.meta.url));
function output() {
  const state = { text: '', writes: 0 };
  state.stream = new Writable({ write(chunk, encoding, done) { state.text += chunk; state.writes++; done(); } });
  return state;
}
function processFixture() {
  const processRef = new EventEmitter(); processRef.ppid = 42; processRef.kill = () => {};
  let cleared = 0; let parentCheck;
  return { processRef, setIntervalFn(fn) { parentCheck = fn; return { unref() {} }; }, clearIntervalFn() { cleared++; },
    assertClean() { assert.equal(cleared, 1); for (const event of ['SIGINT','SIGTERM','disconnect']) assert.equal(processRef.listenerCount(event), 0); },
    checkParent() { parentCheck(); },
  };
}
const request = { schema, projects: [{ id: 'one', projectPath: '/project', after: null }] };
const complete = { schema: outputSchema, status: 'complete', results: [{ id: 'one', status: 'changed', token: 'tloc1.fixture' }] };

async function call(input, overrides = {}, argv = ['--json']) {
  const stdout = output(); const stderr = output(); const fixture = processFixture();
  const stdin = Readable.from(Array.isArray(input) ? input : [Buffer.from(input)]);
  const code = await run(argv, { stdin, stdout: stdout.stream, stderr: stderr.stream, check: async () => complete, ...fixture, ...overrides });
  return { code, stdout, stderr, stdin, fixture };
}

test('check CLI validates argv and bounded UTF8 JSON before source work and returns fixed errors', async () => {
  let calls = 0;
  for (const bytes of ['{broken', '', Buffer.from([0xff]), ' '.repeat(1024*1024+1)]) {
    const r = await call(Array.isArray(bytes) ? bytes : [Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)], { check: async () => { calls++; return complete; } });
    assert.equal(r.code, 1); assert.equal(r.stdout.text, '');
    assert.deepEqual(JSON.parse(r.stderr.text), { schema: outputSchema, status: 'error', code: 'E_OBSERVER_CHECK_ARGS' });
    assert.equal(r.stdin.listenerCount('data'), 0); assert.equal(r.stdin.listenerCount('end'), 0); r.fixture.assertClean();
  }
  assert.equal(calls, 0);
  for (const argv of [[], ['--json','--json'], ['--project','/p','--json'], ['--json','extra']]) {
    const r = await call(JSON.stringify(request), {}, argv); assert.equal(r.code, 1); assert.equal(JSON.parse(r.stderr.text).code, 'E_OBSERVER_CHECK_ARGS');
  }
});

test('check CLI decodes split UTF8, waits for EOF and emits complete JSON in one write', async () => {
  const value = JSON.stringify({ ...request, projects: [{ ...request.projects[0], id: '日本語' }] });
  const buffer = Buffer.from(value); const r = await call(Array.from(buffer, b => Buffer.from([b])), {
    check: async (parsed) => { assert.equal(parsed.projects[0].id, '日本語'); return complete; },
  });
  assert.equal(r.code, 0); assert.equal(r.stderr.text, ''); assert.equal(r.stdout.writes, 1); assert.equal(r.stdout.text, JSON.stringify(complete)+'\n'); r.fixture.assertClean();
});

test('check CLI cancellation while stdin remains open and just before output emits no result', async () => {
  for (const event of ['SIGINT','SIGTERM','disconnect','parent']) {
    const fixture = processFixture(); const stdin = new PassThrough(); const stdout = output(); const stderr = output();
    const pending = run(['--json'], { stdin, stdout: stdout.stream, stderr: stderr.stream, ...fixture });
    stdin.write('{');
    if (event === 'parent') { fixture.processRef.ppid = 43; fixture.checkParent(); }
    else fixture.processRef.emit(event);
    assert.equal(await pending, 1); assert.equal(stdout.text, ''); assert.equal(JSON.parse(stderr.text).code, 'E_OBSERVER_CHECK_CANCELLED'); assert.equal(stdin.destroyed, true); fixture.assertClean();
  }
  const fixture = processFixture(); const r = await call(JSON.stringify(request), { ...fixture,
    check: async () => { setImmediate(() => fixture.processRef.emit('SIGTERM')); return complete; },
  });
  assert.equal(r.code, 1); assert.equal(r.stdout.text, ''); assert.equal(JSON.parse(r.stderr.text).code, 'E_OBSERVER_CHECK_CANCELLED'); fixture.assertClean();
  assert.equal(waitInternal.installCancellation, installCancellation);
});

test('check CLI maps internal and output-pipe failures without exposing raw errors', async () => {
  const internal = await call(JSON.stringify(request), { check: async () => { throw new Error('secret /private/path'); } });
  assert.equal(internal.code, 1); assert.equal(internal.stdout.text, ''); assert.equal(JSON.parse(internal.stderr.text).code, 'E_OBSERVER_CHECK_INTERNAL');
  const broken = new Writable({ write(chunk, encoding, done) { done(new Error('private EPIPE')); } });
  const r = await call(JSON.stringify(request), { stdout: broken });
  assert.equal(r.code, 1); assert.equal(JSON.parse(r.stderr.text).code, 'E_OBSERVER_CHECK_INTERNAL'); assert.doesNotMatch(r.stderr.text, /private|EPIPE/);
  const closed = new Writable({ write(chunk, encoding, done) { done(); } }); closed.destroy();
  const both = await call(JSON.stringify(request), { stdout: closed, stderr: closed }); assert.equal(both.code, 1);
});

test('check bin/help execute an empty-source snapshot in a hermetic fixture', () => {
  const root = mkdtempSync(join(tmpdir(), 'tl-check-cli-'));
  try {
    const project = join(root, 'project'); mkdirSync(project); const env = { ...process.env, HOME: root, USERPROFILE: root, CODEX_HOME: join(root, 'codex'), XDG_STATE_HOME: join(root, 'state'), LOCALAPPDATA: join(root, 'state') };
    const input = JSON.stringify({ schema, projects: [{ id: 'one', projectPath: project, after: null }] });
    const r = spawnSync(process.execPath, [BIN, 'observer-check', '--json'], { input, encoding: 'utf8', env, timeout: 5000 });
    assert.equal(r.status, 0, r.stderr); assert.equal(r.stderr, ''); assert.equal(JSON.parse(r.stdout).results[0].status, 'changed');
    assert.equal(existsSync(join(root, '.throughline')), false);
    assert.equal(existsSync(join(root, 'state')), false);
    const help = spawnSync(process.execPath, [BIN, '--help'], { encoding: 'utf8', env }); assert.match(help.stdout, /throughline observer-check --json/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('check bin cancels an open stdin without a fake complete response', async () => {
  for (const startupDelay of [0, 350]) {
    const root = mkdtempSync(join(tmpdir(), 'tl-check-open-'));
    // Observe actual input readiness; process startup is not bounded by a fixed sleep.
    const preload = `
      process.stdin.on('newListener', function observe(event) {
        if (event !== 'data') return;
        process.stdin.removeListener('newListener', observe);
        setImmediate(() => process.send({ ready: true, handlers: process.listenerCount('SIGTERM') }));
      });
      await new Promise(resolve => setTimeout(resolve, ${startupDelay}));
    `;
    const child = spawn(process.execPath, ['--import', 'data:text/javascript,'+encodeURIComponent(preload), BIN, 'observer-check', '--json'], {
      env: { ...process.env, HOME: root, USERPROFILE: root, CODEX_HOME: join(root, 'codex'), XDG_STATE_HOME: join(root, 'state'), LOCALAPPDATA: join(root, 'state') },
      stdio: ['pipe','pipe','pipe','ipc'],
    });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', c => { stdout += c; }); child.stderr.on('data', c => { stderr += c; });
    let spawnError;
    child.once('error', error => { spawnError = error; });
    const result = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal, error: spawnError })));
    const ready = new Promise(resolve => child.once('message', resolve));
    const deadline = setTimeout(() => child.kill('SIGKILL'), 5000);
    try {
      child.stdin.write('{');
      const observed = await Promise.race([ready, result.then(exit => { throw new Error(`CLI closed before input readiness: ${JSON.stringify(exit)} ${stderr}`); })]);
      assert.equal(observed.ready, true); assert.ok(observed.handlers > 0);
      child.kill('SIGTERM');
      const exit = await result;
      assert.equal(exit.error, undefined); assert.equal(stdout, '');
      if (process.platform !== 'win32') { assert.equal(exit.code, 1); assert.equal(exit.signal, null); assert.equal(JSON.parse(stderr).code, 'E_OBSERVER_CHECK_CANCELLED'); }
      else assert.notEqual(exit.code, 0);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await result; clearTimeout(deadline); rmSync(root, { recursive: true, force: true });
    }
  }
});

test('check CLI does not process a syntactically complete request before EOF', async () => {
  const fixture = processFixture(); const stdin = new PassThrough(); const stdout = output(); const stderr = output(); let calls = 0;
  const pending = run(['--json'], { stdin, stdout: stdout.stream, stderr: stderr.stream, ...fixture, check: async () => { calls++; return complete; } });
  stdin.write(JSON.stringify(request)); await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 0); assert.equal(stdout.text, ''); stdin.end();
  assert.equal(await pending, 0); assert.equal(calls, 1); fixture.assertClean();
});

test('actual CLI serializer keeps maximum escaped ids and token bounds far below the runner cap', async () => {
  for (const status of ['changed','unchanged','resync_required','error']) {
    const results = Array.from({ length: 256 }, (_, i) => ({
      id: '\u0001'.repeat(125)+String(i).padStart(3,'0'), status,
      token: ['changed','unchanged'].includes(status) ? 'tloc1.'+'A'.repeat(506) : null,
      ...(status === 'error' ? { code: 'E_OBSERVER_CHECK_SOURCE' } : {}),
    }));
    const value = { schema: outputSchema, status: 'complete', results };
    const inputValue = { schema, projects: results.map(({ id }) => ({ id, projectPath: '/project', after: null })) };
    const r = await call(JSON.stringify(inputValue), { check: async () => value });
    assert.equal(r.code, 0); assert.equal(r.stderr.text, ''); assert.equal(r.stdout.writes, 1);
    assert.deepEqual(JSON.parse(r.stdout.text), value);
    assert.ok(Buffer.byteLength(r.stdout.text) < 16*1024*1024);
    assert.equal(Buffer.byteLength(results[0].id), 128);
    if (results[0].token) assert.equal(Buffer.byteLength(results[0].token), 512);
  }
});

test('check CLI accepts exactly one MiB of encoded input', async () => {
  const json = JSON.stringify(request);
  const r = await call(json+' '.repeat(1024*1024-Buffer.byteLength(json)));
  assert.equal(r.code, 0); assert.equal(r.stderr.text, '');
});
