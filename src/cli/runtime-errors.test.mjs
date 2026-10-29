import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { testTempDir } from '../test-temp-dir.mjs';
import { fileURLToPath } from 'node:url';
import { observeRuntimeError, readRuntimeErrorSnapshot } from '../runtime-error-store.mjs';

import { parseArgs, run } from './runtime-errors.mjs';

test('runtime-errors CLI: strict command surface accepts no raw payload options', () => {
  assert.equal(parseArgs(['enable', '--json']).command, 'enable');
  assert.equal(parseArgs(['disable', '--json']).command, 'disable');
  assert.deepEqual(parseArgs(['snapshot', '--after-cursor', '2', '--limit', '3', '--json']), {
    command: 'snapshot', json: true, afterCursor: 2, limit: 3, value: null,
  });
  assert.equal(parseArgs(['reopen', 'a'.repeat(64), '--json']).command, 'reopen');
  assert.equal(parseArgs(['resolve', 'a'.repeat(64), '--expected-cursor', '0', '--json']).expectedCursor, 0);
  for (const args of [
    ['snapshot', '--stderr', 'secret', '--json'],
    ['snapshot', '--path', '/Users/private', '--json'],
    ['resolve', 'abc', '--context', 'secret', '--json'],
    ['resolve', 'abc', '--expected-cursor', '-1', '--json'],
    ['resolve', 'abc', '--expected-cursor', '1', '--expected-cursor', '2', '--json'],
    ['reopen', 'abc', '--expected-cursor', '1', '--json'],
    ['diagnostics'],
  ]) assert.throws(() => parseArgs(args));
});

test('runtime-errors CLI: internal failure is fixed and does not reflect exceptions or paths', () => {
  const writes = { stdout: '', stderr: '' };
  const originalOut = process.stdout.write;
  const originalErr = process.stderr.write;
  process.stdout.write = (chunk) => { writes.stdout += chunk; return true; };
  process.stderr.write = (chunk) => { writes.stderr += chunk; return true; };
  try {
    const exitCode = run(['snapshot', '--json'], {
      readSnapshot() { throw new Error('secret /Users/private stack'); },
    });
    assert.equal(exitCode, 1);
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
  }
  assert.equal(writes.stdout, '');
  assert.equal(writes.stderr, '[runtime-errors] operation_failed\n');
});

test('runtime-errors CLI: snapshot and diagnostics are JSON-only and contain no state path', () => {
  const root = testTempDir('throughline-runtime-cli-');
  const env = {
    ...process.env,
    HOME: root,
    USERPROFILE: root,
    LOCALAPPDATA: root,
    XDG_CONFIG_HOME: join(root, 'config'),
    XDG_STATE_HOME: join(root, 'state'),
  };
  const bin = new URL('../../bin/throughline.mjs', import.meta.url);
  const enabled = spawnSync(process.execPath, [fileURLToPath(bin), 'runtime-errors', 'enable', '--json'], {
    env,
    encoding: 'utf8',
  });
  assert.equal(enabled.status, 0, enabled.stderr);
  assert.deepEqual(JSON.parse(enabled.stdout), {
    schema: 'throughline.runtime_error_config.v1',
    collection: { enabled: true },
  });
  for (const args of [
    ['runtime-errors', 'snapshot', '--json'],
    ['runtime-errors', 'diagnostics', '--json'],
  ]) {
    const result = spawnSync(process.execPath, [fileURLToPath(bin), ...args], { env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const json = JSON.parse(result.stdout);
    assert.equal(typeof json.schema, 'string');
    assert.doesNotMatch(result.stdout, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  const first = observeRuntimeError({ code: 'HOOK_PROCESS_TURN_FAILED' }, { env });
  const oldCursor = readRuntimeErrorSnapshot({ env }).cursor.high_watermark;
  observeRuntimeError({ code: 'HOOK_PROCESS_TURN_FAILED' }, { env });
  const resolve = cursor => spawnSync(process.execPath, [fileURLToPath(bin), 'runtime-errors', 'resolve', first.fingerprint,
    '--expected-cursor', String(cursor), '--json'], { env, encoding: 'utf8' });
  assert.equal(resolve(oldCursor).status, 1);
  const current = readRuntimeErrorSnapshot({ env });
  assert.equal(current.runtime_errors[0].occurrence_count, 2);
  const result = resolve(current.cursor.high_watermark);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, 'resolved');
  assert.equal(readRuntimeErrorSnapshot({ env }).resolutions.length, 1);
});
