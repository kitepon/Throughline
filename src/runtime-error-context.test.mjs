import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import childProcess, { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { testTempDir } from './test-temp-dir.mjs';
import { validateRuntimeErrorContext } from './runtime-error-context.mjs';
import { defaultRuntimeErrorStorePath, recordRuntimeErrorBestEffort, observeRuntimeError, readRuntimeErrorSnapshot, runtimeErrorFingerprint, setRuntimeErrorCollectionEnabled } from './runtime-error-store.mjs';
import { buildRuntimeErrorReport } from './runtime-error-report.mjs';

const BIN = fileURLToPath(new URL('../bin/throughline.mjs', import.meta.url));
const CODE = 'HOOK_CODEX_FAILED';
const BASE = 'Throughline Codex hook processing failed';
const context = { event: 'stop', stage: 'payload', effect: 'hook_exit_nonzero' };
function sandbox() {
  const root = testTempDir('throughline-report-context-');
  const env = { ...process.env, HOME: root, USERPROFILE: root, LOCALAPPDATA: root,
    XDG_CONFIG_HOME: join(root, 'config'), XDG_STATE_HOME: join(root, 'state'), CODEX_HOME: join(root, 'codex') };
  setRuntimeErrorCollectionEnabled(true, { env });
  const options = { env, version: '0.16.46' };
  const storePath = defaultRuntimeErrorStorePath(env);
  return { root, env, options, storePath, contextPath: `${storePath}.context.json` };
}
function occurrence(box, suppliedContext = context, now = '2026-10-25T09:00:00.000Z') {
  return observeRuntimeError({ code: CODE, now, ...(suppliedContext ? { context: suppliedContext } : {}) }, box.options);
}
function publicError(box) { return readRuntimeErrorSnapshot({ env: box.env }).runtime_errors[0]; }

test('latest context enriches only the existing public message, preserving aggregate identity and raw store', () => {
  const box = sandbox(); occurrence(box);
  const raw = JSON.parse(readFileSync(box.storePath)).records[0];
  const entry = publicError(box);
  assert.equal(raw.message_template, BASE);
  assert.equal(entry.fingerprint, runtimeErrorFingerprint(CODE));
  assert.equal(entry.occurrence_count, 1);
  assert.equal(entry.severity, 'high');
  assert.match(entry.message_template, /Latest occurrence only at 2026-10-25T09:00:00.000Z: operation=codex.stop; expected=parse_valid_hook_json; actual=input_rejected; effect=hook_exit_nonzero; user_impact=unknown; classification=diagnostic_only; prior_occurrences=uncharacterized\./);
  assert.ok(entry.message_template.length <= 1024);
  assert.deepEqual(Object.keys(entry).sort(), ['error_code','component','status','severity','fingerprint','message_template','occurrence_count','first_seen','last_seen','product_version','state_schema_version'].sort());
  if (process.platform !== 'win32') assert.equal(statSync(box.contextPath).mode & 0o777, 0o600);
});

test('legacy absence and later no-context occurrence do not copy earlier context into aggregate history', () => {
  const box = sandbox(); occurrence(box, null);
  assert.equal(publicError(box).message_template, BASE);
  occurrence(box, context, '2026-10-25T09:01:00.000Z');
  assert.match(publicError(box).message_template, /Latest occurrence only at 2026-10-25T09:01/);
  const prior = readFileSync(box.contextPath);
  occurrence(box, null, '2026-10-25T09:02:00.000Z');
  assert.equal(publicError(box).occurrence_count, 3);
  assert.equal(publicError(box).message_template, BASE);
  assert.deepEqual(readFileSync(box.contextPath), prior);
  rmSync(box.contextPath);
  assert.equal(publicError(box).message_template, BASE);
});

test('context binding rejects stale count, timestamps, fingerprint and version; malformed state is explicit', () => {
  const box = sandbox(); occurrence(box);
  const state = JSON.parse(readFileSync(box.contextPath));
  for (const [key, value] of Object.entries({ count: 2, first_seen: '2026-10-25T08:00:00.000Z', last_seen: '2026-10-25T09:01:00.000Z', product_version: '0.16.45', fingerprint: 'a'.repeat(64) })) {
    writeFileSync(box.contextPath, JSON.stringify({ ...state, binding: { ...state.binding, [key]: value } }));
    assert.equal(publicError(box).message_template, BASE, key);
  }
  writeFileSync(box.contextPath, JSON.stringify({ ...state, context: { ...context, payload: 'not-public' } }));
  assert.throws(() => publicError(box), /context invalid/);
});

test('context accepts fixed vocabulary only and invalid metadata does not mutate any aggregate', () => {
  const box = sandbox(); occurrence(box);
  const raw = readFileSync(box.storePath);
  for (const invalid of [ { ...context, event: '/private/path' }, { ...context, stage: 'secret' }, { ...context, effect: 'lost_memory' }, { ...context, prompt: 'secret' }, { ...context, stage: 'handoff_request' }, null ]) {
    assert.throws(() => observeRuntimeError({ code: CODE, context: invalid }, box.options), /context invalid/);
    assert.deepEqual(readFileSync(box.storePath), raw);
  }
  assert.throws(() => validateRuntimeErrorContext('HOOK_PROCESS_TURN_FAILED', context), /context invalid/);
  for (const effect of ['continue_requested', 'stop_requested', 'unknown']) {
    occurrence(box, { event: 'pre-compact', stage: 'handoff_request', effect });
    assert.match(publicError(box).message_template, new RegExp(`actual=handoff_request_failed; effect=${effect}; user_impact=unknown`));
  }
});

test('ordinary isolated Codex CLI failures reach snapshot and unchanged report carrier without payload leaks', () => {
  const box = sandbox();
  const sentinel = 'PRIVATE_PAYLOAD_SENTINEL_821';
  for (const event of ['stop', 'post-tool-use']) {
    const result = spawnSync(process.execPath, [BIN, 'codex-hook', event], {
      env: box.env, cwd: box.root, input: `{${sentinel}`, encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(result.status, 1, result.stderr);
    assert.doesNotMatch(result.stderr, /store_unavailable/);
    const snap = spawnSync(process.execPath, [BIN, 'runtime-errors', 'snapshot', '--json'], { env: box.env, encoding: 'utf8' });
    assert.equal(snap.status, 0, snap.stderr);
    const snapshot = JSON.parse(snap.stdout);
    const entry = snapshot.runtime_errors[0];
    assert.equal(entry.occurrence_count, event === 'stop' ? 1 : 2);
    assert.equal(entry.fingerprint, runtimeErrorFingerprint(CODE));
    assert.match(entry.message_template, new RegExp(`operation=codex.${event}; expected=parse_valid_hook_json; actual=input_rejected`));
    assert.doesNotMatch(JSON.stringify(snapshot), new RegExp(`${sentinel}|${box.root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    const report = buildRuntimeErrorReport({ snapshot, reportId: '00000000-0000-4000-8000-000000000001', nowMs: Date.now() });
    assert.equal(report.runtime_errors[0].message_template, entry.message_template);
    assert.equal(report.schema_version, '1.0');
    assert.equal('safe_context' in report.runtime_errors[0], false);
    assert.equal('diagnostic_context' in report.runtime_errors[0], false);
  }
  // On-disk private context also never stores the offending JSON or its error text.
  assert.doesNotMatch(readFileSync(box.contextPath, 'utf8'), new RegExp(sentinel));
});


test('context observer has a separate finite two-file deadline and never serializes rejected fields', (t) => {
  const calls = [];
  t.mock.method(childProcess, 'spawnSync', (...args) => { calls.push(args); return { status: 0 }; });
  assert.equal(recordRuntimeErrorBestEffort(CODE, { context }).status, 'recorded');
  assert.equal(calls[0][2].timeout, 10_000);
  assert.deepEqual(JSON.parse(calls[0][1].at(-1)), context);
  recordRuntimeErrorBestEffort(CODE);
  assert.equal(calls[1][2].timeout, 5_000);
  let diagnostic = '';
  assert.equal(recordRuntimeErrorBestEffort(CODE, { context: { ...context, secret: 'private' }, stderr: { write: (s) => { diagnostic += s; } } }).status, 'store_unavailable');
  assert.equal(calls.length, 2);
  assert.equal(diagnostic, '[throughline:runtime-errors] store_unavailable\n');
});
