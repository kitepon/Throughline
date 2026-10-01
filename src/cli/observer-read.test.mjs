import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import test from 'node:test';
import { OBSERVER_READ_SCHEMA } from '../observer-turn-feed.mjs';
import { parseArgs, run } from './observer-read.mjs';

const REPO_ROOT = join(fileURLToPath(new URL('../..', import.meta.url)));
const BIN_PATH = join(REPO_ROOT, 'bin/throughline.mjs');
const FIXED = { schema: OBSERVER_READ_SCHEMA, status: 'snapshot', turns: [], page: { complete: true, nextToken: null } };

function streams() {
  return { stdout: { text: '', write(value) { this.text += value; } }, stderr: { text: '', write(value) { this.text += value; } } };
}

test('observer-read parses each supported option once and delegates validation to read library', () => {
  assert.deepEqual(parseArgs(['--project', '/repo', '--after-cursor', 'after', '--through-cursor', 'through', '--page-token', 'page', '--limit', '100', '--json']), {
    projectPath: '/repo', afterCursor: 'after', throughCursor: 'through', pageToken: 'page', limit: 100, wire: 'v1', json: true,
  });
  assert.equal(parseArgs(['--project', '/repo', '--wire', 'v2', '--json']).wire, 'v2');
  const io = streams(); let input;
  assert.equal(run(['--project', '/repo', '--json'], { ...io, read(value) { input = value; return FIXED; } }), 0);
  assert.deepEqual(input, { projectPath: '/repo' });
  assert.deepEqual(JSON.parse(io.stdout.text), FIXED);
  assert.equal(io.stderr.text, '');
});

test('observer-read rejects duplicate, missing, positional, and invalid pagination arguments with fixed args error', () => {
  for (const argv of [
    ['--project', '/repo', '--project', '/repo', '--json'], ['--project', '/repo', '--json', '--json'],
    ['--project', '/repo', '--page-token', 'p', '--json'], ['--project', '/repo', '--limit', '0', '--json'],
    ['--project', '/repo', 'extra', '--json'], ['--json'],
  ]) {
    const io = streams();
    assert.equal(run(argv, { ...io }), 1);
    assert.equal(io.stdout.text, '');
    assert.deepEqual(JSON.parse(io.stderr.text), { schema: OBSERVER_READ_SCHEMA, status: 'error', code: 'E_OBSERVER_READ_ARGS', message: 'invalid observer-read arguments' });
  }
});

test('observer-read keeps known states successful and maps hard failures without leakage', () => {
  for (const status of ['snapshot', 'delta', 'thread_switched', 'host_switched', 'resync_required', 'projection_pending', 'ambiguous_parent']) {
    const io = streams();
    assert.equal(run(['--project', '/repo', '--json'], { ...io, read: () => ({ ...FIXED, status }) }), 0);
    assert.equal(JSON.parse(io.stdout.text).status, status);
    assert.equal(io.stderr.text, '');
  }
  for (const [error, code] of [
    [new TypeError('/private/cursor body'), 'E_OBSERVER_READ_INPUT'],
    [Object.assign(new Error('schema'), { code: 'E_AUDITOR_CONTEXT_SCHEMA' }), 'E_OBSERVER_READ_DB_SCHEMA'],
    [Object.assign(new Error('project'), { code: 'E_AUDITOR_CONTEXT_PROJECT' }), 'E_OBSERVER_READ_DB_PROJECT'],
    [Object.assign(new Error('io'), { code: 'E_AUDITOR_CONTEXT_QUERY' }), 'E_OBSERVER_READ_DB_IO'],
    [new Error('secret /private cursor'), 'E_OBSERVER_READ_INTERNAL'],
  ]) {
    const io = streams();
    assert.equal(run(['--project', '/repo', '--json'], { ...io, read: () => { throw error; } }), 1);
    assert.equal(io.stdout.text, '');
    assert.equal(JSON.parse(io.stderr.text).code, code);
    assert.doesNotMatch(io.stderr.text, /private|cursor|secret/i);
  }
});

test('observer-read bin dispatch and help advertise JSON-only command', () => {
  const help = spawnSync(process.execPath, [BIN_PATH, '--help'], { cwd: REPO_ROOT, encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /throughline observer-read --project <absolute-directory> \[--wire v2\] --json/);
});

test('observer-read bin dispatch returns an empty snapshot from an isolated environment', async () => {
  const root = await mkdtemp(join(tmpdir(), 'throughline-observer-read-'));
  const home = join(root, 'home');
  const state = join(root, 'state');
  const codexHome = join(root, 'codex');
  const project = join(root, 'project');
  try {
    await Promise.all([mkdir(home), mkdir(state), mkdir(codexHome), mkdir(project)]);
    const result = spawnSync(process.execPath, [BIN_PATH, 'observer-read', '--project', project, '--json'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: { ...process.env, HOME: home, USERPROFILE: home, XDG_STATE_HOME: state, CODEX_HOME: codexHome },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    const page = JSON.parse(result.stdout);
    assert.equal(page.schema, OBSERVER_READ_SCHEMA);
    assert.equal(page.status, 'snapshot');
    assert.deepEqual(page.turns, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('observer-read --wire v2 delegates the wire and reports hard failures with the v2 schema', () => {
  const io = streams(); let input;
  assert.equal(run(['--project', '/repo', '--wire', 'v2', '--json'], { ...io, read(value) { input = value; return FIXED; } }), 0);
  assert.deepEqual(input, { wire: 'v2', projectPath: '/repo' });
  const failed = streams();
  assert.equal(run(['--project', '/repo', '--wire', 'v2', '--json'], { ...failed, read() { throw new Error('boom /private/path'); } }), 1);
  assert.deepEqual(JSON.parse(failed.stderr.text), { schema: 'throughline.observer_read.v2', status: 'error', code: 'E_OBSERVER_READ_INTERNAL', message: 'observer read failed' });
  for (const argv of [['--project', '/repo', '--wire', 'v3', '--json'], ['--project', '/repo', '--wire', 'v2', '--wire', 'v2', '--json']]) {
    const bad = streams();
    assert.equal(run(argv, { ...bad }), 1);
    assert.equal(JSON.parse(bad.stderr.text).code, 'E_OBSERVER_READ_ARGS');
  }
});
