import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  defaultRuntimeErrorConfigPath,
  observeRuntimeError,
  readRuntimeErrorSnapshot,
  resolveRuntimeError,
  setRuntimeErrorCollectionEnabled,
} from './runtime-error-store.mjs';
import {
  REPORT_INTERVAL_MS,
  REPORT_REJECTED_BACKOFF_MS,
  _internal,
  getRuntimeErrorReportStatus,
  reportRuntimeErrors,
  setRuntimeErrorReportingEnabled,
  signRuntimeErrorReport,
  signRuntimeErrorReportResponse,
} from './runtime-error-report.mjs';
import {
  defaultRuntimeErrorReportConfigPath,
  defaultRuntimeErrorReportStatePath,
  triggerRuntimeErrorReportBestEffort,
} from './runtime-error-report-trigger.mjs';

const BIN = fileURLToPath(new URL('../bin/throughline.mjs', import.meta.url));
const SECRET = 'throughline-test-secret-0123456789';
const KEY_ID = 'test-host.throughline';
const NOW = Date.parse('2026-10-03T08:00:00.000Z');

function createEnvironment(prefix = 'throughline-report-') {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const env = {
    ...process.env,
    HOME: root,
    USERPROFILE: root,
    LOCALAPPDATA: root,
    XDG_CONFIG_HOME: join(root, 'config'),
    XDG_STATE_HOME: join(root, 'state'),
  };
  return { root, env };
}

function writeCredential(root, url, overrides = {}) {
  const path = join(root, 'credential.json');
  writeFileSync(path, JSON.stringify({ url, key_id: KEY_ID, secret: SECRET, ...overrides }), { mode: 0o600 });
  return path;
}

// 受け口の契約どおりに署名を確かめ、応答へ署名を付ける最小の受信側。
async function startReceiver(respond) {
  const requests = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks);
      const match = /^BugHub-HMAC-SHA256 key_id=(\S+), ts=(\d+), sig=([0-9a-f]{64})$/.exec(request.headers.authorization ?? '');
      const expected = match && createHmac('sha256', Buffer.from(SECRET, 'utf8'))
        .update(`${match[2]}\n${createHash('sha256').update(body).digest('hex')}`).digest('hex');
      const entry = {
        method: request.method,
        path: request.url,
        contentType: request.headers['content-type'],
        keyId: match?.[1] ?? null,
        ts: match?.[2] ?? null,
        signatureValid: Boolean(match) && match[3] === expected,
        raw: body.toString('utf8'),
        report: JSON.parse(body.toString('utf8')),
      };
      requests.push(entry);
      const reply = respond(entry);
      response.writeHead(reply.status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(reply.body));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    requests,
    url: `http://127.0.0.1:${server.address().port}/api/products/v1/runtime-errors`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function accept(entry, overrides = {}) {
  const receivedAt = '2026-10-03T08:00:01.000Z';
  return {
    status: 200,
    body: {
      accepted: true,
      report_id: entry.report.report_id,
      duplicate: false,
      received_at: receivedAt,
      sig: signRuntimeErrorReportResponse({ secret: SECRET, reportId: entry.report.report_id, receivedAt }),
      ...overrides,
    },
  };
}

test('runtime error report: signatures match the receiver contract test vectors', () => {
  const secret = 'bughub-test-secret-do-not-use-0123456789abcdef';
  const body = Buffer.from('{"schema_version":"1.0","report_id":"00000000-0000-4000-8000-000000000001","product_id":"caveat","installed_version":"0.19.13","observed_at":"2026-09-21T14:13:20.000Z","runtime_errors":[],"resolutions":[]}', 'utf8');
  assert.equal(body.length, 205);
  assert.equal(
    signRuntimeErrorReport({ secret, ts: '1790000000', body }),
    'e4ba0355c9d9058286a82d9622747eae264f780aa575e74859c40a6e529fa73a',
  );
  assert.equal(
    signRuntimeErrorReportResponse({
      secret,
      reportId: '00000000-0000-4000-8000-000000000001',
      receivedAt: '2026-09-21T14:13:21.000Z',
    }),
    'cc4ebb409cdd6a2be5f69f6acf8ebcd7f18acbe14b9ac82836797572f74a64bb',
  );
});

test('runtime error report: nothing is sent unless reporting was explicitly enabled', async () => {
  const { env } = createEnvironment();
  let calls = 0;
  const fetch = async () => { calls += 1; throw new Error('must not be called'); };
  setRuntimeErrorCollectionEnabled(true, { env });
  observeRuntimeError({ code: 'HOOK_CODEX_FAILED' }, { env });

  assert.equal((await reportRuntimeErrors({ env, fetch, now: NOW })).status, 'reporting_disabled');
  assert.equal(getRuntimeErrorReportStatus({ env }).reporting, 'disabled');
  assert.equal(existsSync(defaultRuntimeErrorReportConfigPath(env)), false);
  assert.equal(existsSync(defaultRuntimeErrorReportStatePath(env)), false);

  let spawned = 0;
  const trigger = triggerRuntimeErrorReportBestEffort({ env, now: NOW, spawn: () => { spawned += 1; return {}; } });
  assert.equal(trigger.status, 'reporting_disabled');
  assert.equal(spawned, 0);
  assert.equal(calls, 0);
});

test('runtime error report: sends only public snapshot fields, signs the exact bytes, and acks a verified acceptance', async () => {
  const { root, env } = createEnvironment();
  const receiver = await startReceiver((entry) => accept(entry));
  try {
    setRuntimeErrorCollectionEnabled(true, { env });
    observeRuntimeError({ code: 'HOOK_PROCESS_TURN_FAILED', now: '2026-10-03T07:00:00.000Z' }, { env });
    observeRuntimeError({ code: 'HOOK_PROCESS_TURN_FAILED', now: '2026-10-03T07:30:00.000Z' }, { env });
    const resolved = observeRuntimeError({ code: 'HOOK_CODEX_FAILED', now: '2026-10-03T07:10:00.000Z' }, { env });
    resolveRuntimeError(resolved.fingerprint, { env, now: '2026-10-03T07:40:00.000Z', reasonCode: 'recovered' });
    const enabled = setRuntimeErrorReportingEnabled(true, { env, credentialFile: writeCredential(root, receiver.url) });
    assert.deepEqual(enabled, { schema: 'throughline.runtime_error_report_config.v1', reporting: { enabled: true } });

    const result = await reportRuntimeErrors({ env, now: NOW });
    assert.equal(result.status, 'sent');
    assert.equal(result.runtime_errors, 1);
    assert.equal(result.resolutions, 1);
    assert.equal(receiver.requests.length, 1);

    const [request] = receiver.requests;
    assert.equal(request.method, 'POST');
    assert.equal(request.path, '/api/products/v1/runtime-errors');
    assert.equal(request.contentType, 'application/json');
    assert.equal(request.keyId, KEY_ID);
    assert.equal(request.signatureValid, true);
    assert.equal(request.ts, String(NOW / 1000));
    assert.doesNotMatch(request.raw, new RegExp(SECRET));
    assert.doesNotMatch(request.raw, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

    const { report } = request;
    assert.deepEqual(Object.keys(report), [
      'schema_version', 'report_id', 'product_id', 'installed_version', 'observed_at', 'runtime_errors', 'resolutions',
    ]);
    assert.equal(report.schema_version, '1.0');
    assert.equal(report.report_id, result.report_id);
    assert.equal(report.product_id, 'throughline');
    assert.match(report.installed_version, /^\d+\.\d+\.\d+$/);
    assert.equal(report.observed_at, '2026-10-03T08:00:00.000Z');
    assert.deepEqual(Object.keys(report.runtime_errors[0]).sort(), [
      'component', 'error_code', 'fingerprint', 'first_seen', 'last_seen', 'message_template',
      'occurrence_count', 'product_version', 'severity', 'state_schema_version', 'status',
    ]);
    assert.equal(report.runtime_errors[0].error_code, 'HOOK_PROCESS_TURN_FAILED');
    assert.equal(report.runtime_errors[0].component, 'claude_stop_hook');
    assert.equal(report.runtime_errors[0].occurrence_count, 2);
    assert.equal(report.runtime_errors[0].status, 'open');
    assert.deepEqual(report.resolutions, [
      { fingerprint: resolved.fingerprint, resolved_at: '2026-10-03T07:40:00.000Z', reason_code: 'recovered' },
    ]);

    const snapshot = readRuntimeErrorSnapshot({ env });
    assert.equal(snapshot.cursor.acknowledged_through, snapshot.cursor.high_watermark);
    assert.equal(snapshot.diagnostics.pending_count, 0);
    const status = getRuntimeErrorReportStatus({ env });
    assert.equal(status.reporting, 'enabled');
    assert.equal(status.last_result, 'sent');
    assert.equal(status.last_success_at, '2026-10-03T08:00:00.000Z');
    assert.equal(status.next_attempt_at, new Date(NOW + REPORT_INTERVAL_MS).toISOString());

    // 受領済みの記録だけなら通信しない。新しい発生は累計で送り直す。
    assert.equal((await reportRuntimeErrors({ env, now: NOW + 1000 })).status, 'nothing_pending');
    assert.equal(receiver.requests.length, 1);
    observeRuntimeError({ code: 'HOOK_PROCESS_TURN_FAILED', now: '2026-10-03T08:10:00.000Z' }, { env });
    assert.equal((await reportRuntimeErrors({ env, now: NOW + 2000 })).status, 'sent');
    assert.equal(receiver.requests.length, 2);
    assert.equal(receiver.requests[1].report.runtime_errors[0].occurrence_count, 3);
    assert.notEqual(receiver.requests[1].report.report_id, report.report_id);
  } finally {
    await receiver.close();
  }
});

test('runtime error report: only a signed acceptance of the same report counts as delivered', () => {
  const reportId = '11111111-2222-4333-8444-555555555555';
  const receivedAt = '2026-10-03T08:00:01.000Z';
  const sig = signRuntimeErrorReportResponse({ secret: SECRET, reportId, receivedAt });
  const good = { accepted: true, report_id: reportId, duplicate: false, received_at: receivedAt, sig };
  const verify = (body) => _internal.isVerifiedAcceptance(
    typeof body === 'string' ? body : JSON.stringify(body), { secret: SECRET, reportId },
  );
  assert.equal(verify(good), true);
  assert.equal(verify({ ...good, duplicate: true }), true);
  for (const [name, body] of [
    ['wrong signature', { ...good, sig: 'a'.repeat(64) }],
    ['signature of another secret', { ...good, sig: signRuntimeErrorReportResponse({ secret: 'other', reportId, receivedAt }) }],
    ['missing signature', { accepted: true, report_id: reportId, received_at: receivedAt }],
    ['non-hex signature', { ...good, sig: 'z'.repeat(64) }],
    ['different report id', { ...good, report_id: '00000000-0000-4000-8000-000000000001' }],
    ['received_at changed after signing', { ...good, received_at: '2026-10-03T08:00:02.000Z' }],
    ['not accepted', { ...good, accepted: false }],
    ['accepted as a string', { ...good, accepted: 'true' }],
    ['array', [good]],
    ['not json', 'ok'],
  ]) assert.equal(verify(body), false, name);
});

test('runtime error report: rejections are classified by cause and decide the next interval', () => {
  for (const [status, body, expected] of [
    [401, { error: 'unauthorized' }, 'rejected_credential'],
    [403, { error: 'credential_inactive' }, 'rejected_credential'],
    [403, { code: 'product_binding_mismatch' }, 'rejected_credential'],
    [401, { error: 'timestamp_skew' }, 'clock_skew'],
    [422, { code: 'observed_at_skew' }, 'clock_skew'],
    [422, { error: 'invalid_report' }, 'rejected_report'],
    [409, { error: 'report_id_conflict' }, 'rejected_report'],
    [413, { error: 'report_too_large' }, 'rejected_report'],
    [429, { error: 'rate_limited' }, 'rate_limited'],
    [500, { error: 'internal' }, 'unreachable'],
    [503, 'not json', 'unreachable'],
    [302, {}, 'unreachable'],
  ]) {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    assert.equal(_internal.classifyRejection(status, text), expected, `${status} ${text}`);
  }
  assert.deepEqual([..._internal.LONG_BACKOFF_STATUSES].sort(), [
    'credential_unavailable', 'rejected_credential', 'rejected_report',
  ]);
});

test('runtime error report: an unverified 200 and a rejection both leave records pending', async () => {
  const cases = [
    ['unverified 200', (entry) => accept(entry, { sig: 'a'.repeat(64) }), 'unverified_response', REPORT_INTERVAL_MS],
    ['rejected credential', () => ({ status: 401, body: { error: 'unauthorized' } }), 'rejected_credential', REPORT_REJECTED_BACKOFF_MS],
  ];
  for (const [name, respond, expected, backoff] of cases) {
    const { root, env } = createEnvironment();
    const receiver = await startReceiver(respond);
    try {
      setRuntimeErrorCollectionEnabled(true, { env });
      observeRuntimeError({ code: 'HOOK_SESSION_START_FAILED' }, { env });
      setRuntimeErrorReportingEnabled(true, { env, credentialFile: writeCredential(root, receiver.url) });
      const result = await reportRuntimeErrors({ env, now: NOW });
      assert.equal(result.status, expected, name);
      assert.equal(receiver.requests.length, 1, name);
      const snapshot = readRuntimeErrorSnapshot({ env });
      assert.equal(snapshot.cursor.acknowledged_through, 0, name);
      assert.equal(snapshot.diagnostics.pending_count, 1, name);
      const state = getRuntimeErrorReportStatus({ env });
      assert.equal(state.last_result, expected, name);
      assert.equal(state.last_success_at, null, name);
      assert.equal(state.next_attempt_at, new Date(NOW + backoff).toISOString(), name);
    } finally {
      await receiver.close();
    }
  }
});

test('runtime error report: an unreachable or redirecting receiver is not treated as delivered', async () => {
  const { root, env } = createEnvironment();
  setRuntimeErrorCollectionEnabled(true, { env });
  observeRuntimeError({ code: 'HOOK_CODEX_FAILED' }, { env });
  setRuntimeErrorReportingEnabled(true, { env, credentialFile: writeCredential(root, 'http://127.0.0.1:9/unused') });

  const options = [];
  const refused = await reportRuntimeErrors({
    env,
    now: NOW,
    fetch: async (url, init) => { options.push(init); throw new TypeError('fetch failed'); },
  });
  assert.equal(refused.status, 'unreachable');
  assert.equal(options[0].redirect, 'error');
  assert.equal(readRuntimeErrorSnapshot({ env }).cursor.acknowledged_through, 0);
});

test('runtime error report: background runs respect the interval, explicit runs do not', async () => {
  const { root, env } = createEnvironment();
  const receiver = await startReceiver((entry) => accept(entry));
  try {
    setRuntimeErrorCollectionEnabled(true, { env });
    observeRuntimeError({ code: 'HOOK_CODEX_FAILED' }, { env });
    setRuntimeErrorReportingEnabled(true, { env, credentialFile: writeCredential(root, receiver.url) });

    assert.equal((await reportRuntimeErrors({ env, now: NOW, background: true })).status, 'sent');
    observeRuntimeError({ code: 'HOOK_CODEX_FAILED' }, { env });
    assert.equal((await reportRuntimeErrors({ env, now: NOW + 60_000, background: true })).status, 'throttled');
    assert.equal(receiver.requests.length, 1);

    let spawned = [];
    const spawn = (...args) => { spawned.push(args); return { on() {}, unref() {} }; };
    assert.equal(triggerRuntimeErrorReportBestEffort({ env, now: NOW + 60_000, spawn }).status, 'throttled');
    assert.equal(spawned.length, 0);
    assert.equal(triggerRuntimeErrorReportBestEffort({ env, now: NOW + REPORT_INTERVAL_MS, spawn }).status, 'started');
    assert.equal(spawned.length, 1);
    assert.deepEqual(spawned[0][1].slice(1), ['runtime-errors', 'report', '--background', '--json']);
    assert.equal(spawned[0][2].detached, true);
    assert.equal(spawned[0][2].stdio, 'ignore');

    assert.equal((await reportRuntimeErrors({ env, now: NOW + REPORT_INTERVAL_MS, background: true })).status, 'sent');
    assert.equal((await reportRuntimeErrors({ env, now: NOW + REPORT_INTERVAL_MS + 1000 })).status, 'nothing_pending');
    assert.equal(receiver.requests.length, 2);

    // 設定をやり直した直後は、間隔を待たずに試せる。
    setRuntimeErrorReportingEnabled(true, { env, credentialFile: writeCredential(root, receiver.url) });
    assert.equal(triggerRuntimeErrorReportBestEffort({ env, now: NOW + REPORT_INTERVAL_MS + 2000, spawn }).status, 'started');

    // 記録だけを無効にした端末は、通信せずに次の時刻を書く。hookのたびにprocessを起こさない。
    const later = NOW + 5 * REPORT_INTERVAL_MS;
    setRuntimeErrorCollectionEnabled(false, { env });
    assert.equal((await reportRuntimeErrors({ env, now: later, background: true })).status, 'collection_disabled');
    assert.equal(getRuntimeErrorReportStatus({ env }).last_result, 'collection_disabled');
    assert.equal(triggerRuntimeErrorReportBestEffort({ env, now: later + 1000, spawn }).status, 'throttled');
    assert.equal(receiver.requests.length, 2);
    setRuntimeErrorCollectionEnabled(true, { env });

    setRuntimeErrorReportingEnabled(false, { env });
    assert.equal(triggerRuntimeErrorReportBestEffort({ env, now: NOW + 10 * REPORT_INTERVAL_MS, spawn }).status, 'reporting_disabled');
    assert.equal((await reportRuntimeErrors({ env, now: NOW + 10 * REPORT_INTERVAL_MS })).status, 'reporting_disabled');
  } finally {
    await receiver.close();
  }
});

test('runtime error report: an unsafe or malformed credential file is never used', { skip: process.platform === 'win32' }, async () => {
  const { root, env } = createEnvironment();
  let calls = 0;
  const fetch = async () => { calls += 1; throw new Error('must not be called'); };
  setRuntimeErrorCollectionEnabled(true, { env });
  observeRuntimeError({ code: 'HOOK_CODEX_FAILED' }, { env });

  const readable = writeCredential(root, 'http://127.0.0.1:9/unused');
  chmodSync(readable, 0o644);
  const link = join(root, 'credential-link.json');
  const target = join(root, 'credential-target.json');
  writeFileSync(target, JSON.stringify({ url: 'http://127.0.0.1:9/unused', key_id: KEY_ID, secret: SECRET }), { mode: 0o600 });
  symlinkSync(target, link);
  const malformed = [
    { url: 'file:///etc/passwd', key_id: KEY_ID, secret: SECRET },
    { url: 'http://user:pass@127.0.0.1:9/unused', key_id: KEY_ID, secret: SECRET },
    { url: 'http://127.0.0.1:9/unused', key_id: 'bad, sig=0', secret: SECRET },
    { url: 'http://127.0.0.1:9/unused', key_id: KEY_ID, secret: '' },
    { url: 'http://127.0.0.1:9/unused', key_id: KEY_ID, secret: SECRET, extra: true },
    { url: 'http://127.0.0.1:9/unused', credential: SECRET },
  ].map((value, index) => {
    const path = join(root, `credential-${index}.json`);
    writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
    return path;
  });

  for (const credentialFile of [readable, link, join(root, 'missing.json'), ...malformed]) {
    setRuntimeErrorReportingEnabled(true, { env, credentialFile });
    const result = await reportRuntimeErrors({ env, fetch, now: NOW });
    assert.equal(result.status, 'credential_unavailable', credentialFile);
    assert.equal(getRuntimeErrorReportStatus({ env }).next_attempt_at, new Date(NOW + REPORT_REJECTED_BACKOFF_MS).toISOString());
  }
  assert.equal(calls, 0);
  assert.throws(() => setRuntimeErrorReportingEnabled(true, { env, credentialFile: 'relative.json' }), TypeError);
  assert.throws(() => setRuntimeErrorReportingEnabled(true, { env }), TypeError);
});

test('runtime error report: CLI surface is strict, JSON-only, and never prints the receiver or credential', async () => {
  const { root, env } = createEnvironment();
  const receiver = await startReceiver((entry) => accept(entry));
  try {
    const credentialFile = writeCredential(root, receiver.url);
    // 受信側はこのprocessの中で動く。event loopを止めないよう、CLIは非同期で起こす。
    const cli = (...args) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [BIN, 'runtime-errors', ...args], { env });
      const output = { stdout: '', stderr: '' };
      child.stdout.on('data', (chunk) => { output.stdout += chunk; });
      child.stderr.on('data', (chunk) => { output.stderr += chunk; });
      child.on('error', reject);
      child.on('close', (status) => resolve({ status, ...output }));
    });

    for (const args of [
      ['report-enable', '--json'],
      ['report-enable', '--credential-file', '--json'],
      ['report-enable', '--credential-file', credentialFile],
      ['report', '--url', receiver.url, '--json'],
      ['report-disable', '--credential-file', credentialFile, '--json'],
      ['report-status', '--background', '--json'],
    ]) assert.equal((await cli(...args)).status, 2, args.join(' '));
    assert.equal((await cli('report-enable', '--credential-file', 'relative.json', '--json')).status, 1);

    assert.equal((await cli('report', '--json')).status, 3);
    assert.equal((await cli('enable', '--json')).status, 0);
    assert.equal((await cli('report', '--json')).status, 3);
    observeRuntimeError({ code: 'HOOK_CODEX_FAILED' }, { env });

    const outputs = [];
    for (const args of [
      ['report-enable', '--credential-file', credentialFile, '--json'],
      ['report-status', '--json'],
      ['report', '--json'],
      ['report-status', '--json'],
      ['report', '--json'],
    ]) outputs.push(await cli(...args));
    for (const output of outputs) {
      assert.equal(output.status, 0, output.stderr);
      assert.equal(output.stderr, '');
      assert.doesNotMatch(output.stdout, new RegExp(SECRET));
      assert.doesNotMatch(output.stdout, /127\.0\.0\.1/);
      assert.doesNotMatch(output.stdout, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
    assert.equal(JSON.parse(outputs[1].stdout).last_result, null);
    assert.equal(JSON.parse(outputs[2].stdout).status, 'sent');
    assert.equal(JSON.parse(outputs[3].stdout).last_result, 'sent');
    assert.equal(JSON.parse(outputs[4].stdout).status, 'nothing_pending');
    assert.equal(receiver.requests.length, 1);
    assert.equal(receiver.requests[0].signatureValid, true);

    // 送信設定は記録の設定と別のファイルに持つ。旧版が読む記録の設定は形を変えない。
    assert.deepEqual(
      JSON.parse(readFileSync(defaultRuntimeErrorConfigPath(env), 'utf8')),
      { schema: 'throughline.runtime_error_config.v1', collection: { enabled: true } },
    );
  } finally {
    await receiver.close();
  }
});

test('runtime error report: a hook entry starts a detached send for pending records', { skip: process.platform === 'win32' }, async () => {
  const { root, env } = createEnvironment();
  const receiver = await startReceiver((entry) => accept(entry));
  try {
    setRuntimeErrorCollectionEnabled(true, { env });
    observeRuntimeError({ code: 'HOOK_PROCESS_TURN_FAILED' }, { env });
    setRuntimeErrorReportingEnabled(true, { env, credentialFile: writeCredential(root, receiver.url) });

    const started = Date.now();
    const hook = spawnSync(process.execPath, [BIN, 'session-start'], { env, input: '{invalid-json', encoding: 'utf8' });
    assert.notEqual(hook.status, 0);

    while (receiver.requests.length === 0 && Date.now() - started < 30_000) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(receiver.requests.length, 1);
    assert.equal(receiver.requests[0].signatureValid, true);
    assert.ok(receiver.requests[0].report.runtime_errors.some((record) => record.error_code === 'HOOK_PROCESS_TURN_FAILED'));
    while (getRuntimeErrorReportStatus({ env }).last_result !== 'sent' && Date.now() - started < 30_000) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(getRuntimeErrorReportStatus({ env }).last_result, 'sent');

    // 間隔の内側では、次のhookは送信processを起こさない。
    spawnSync(process.execPath, [BIN, 'session-start'], { env, input: '{invalid-json', encoding: 'utf8' });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.equal(receiver.requests.length, 1);
  } finally {
    await receiver.close();
  }
});
