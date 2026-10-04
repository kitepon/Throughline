/**
 * runtime-error-report.mjs — 製品所有のruntime error aggregateを、利用者が指定した受け口へ送る
 *
 * 既定では通信しない。`runtime-errors report-enable --credential-file <path>` で明示して
 * 有効にした端末だけが、credential fileに書かれた宛先へ送る。宛先はpackageに埋めない。
 * 送るのは `runtime-errors snapshot` の公開項目だけで、本文・path・生のエラーは持たない。
 *
 * wireは受け口のruntime-errors v1.0契約に従う:
 *   Authorization: BugHub-HMAC-SHA256 key_id=<key_id>, ts=<UNIX秒>, sig=<hex>
 *   sig = HMAC-SHA256(secret, ts + "\n" + SHA-256(送ったbody bytes)のhex)
 *   応答のsig = HMAC-SHA256(secret, report_id + "\n" + received_at)
 * secretは通信に載せない。200・accepted・report_id一致・応答sig一致がそろった時だけackする。
 */
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute } from 'node:path';
import {
  acknowledgeRuntimeErrors,
  defaultRuntimeErrorStorePath,
  isRuntimeErrorCollectionEnabled,
  readRuntimeErrorPrivateState,
  readRuntimeErrorSnapshot,
  withRuntimeErrorStoreLock,
  writeRuntimeErrorPrivateConfig,
  writeRuntimeErrorPrivateState,
} from './runtime-error-store.mjs';
import {
  RUNTIME_ERROR_REPORT_CONFIG_SCHEMA,
  RUNTIME_ERROR_REPORT_STATE_SCHEMA,
  defaultRuntimeErrorReportConfigPath,
  defaultRuntimeErrorReportStatePath,
  readRuntimeErrorReportConfig,
} from './runtime-error-report-trigger.mjs';
import { isWindows } from './os/windows-acl.mjs';

const require = createRequire(import.meta.url);
const PACKAGE_VERSION = require('../package.json').version;

export const RUNTIME_ERROR_REPORT_RESULT_SCHEMA = 'throughline.runtime_error_report.v1';
export const RUNTIME_ERROR_REPORT_STATUS_SCHEMA = 'throughline.runtime_error_report_status.v1';
export const RUNTIME_ERROR_REPORT_WIRE_VERSION = '1.0';
export const REPORT_INTERVAL_MS = 60 * 60 * 1000;
export const REPORT_REJECTED_BACKOFF_MS = 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 64 * 1024;

// 設定を直すまで通らない結果。1時間ごとに同じ拒否を受け続けないよう、間隔を空ける。
const LONG_BACKOFF_STATUSES = new Set(['credential_unavailable', 'rejected_credential', 'rejected_report']);
const RESULT_STATUSES = new Set([
  'sent', 'nothing_pending', 'collection_disabled', 'credential_unavailable', 'rejected_credential',
  'rejected_report', 'clock_skew', 'rate_limited', 'unreachable', 'unverified_response',
]);

export function setRuntimeErrorReportingEnabled(enabled, options = {}) {
  assertExactOptions(options, ['env', 'credentialFile', 'configPath', 'storePath', 'statePath']);
  if (typeof enabled !== 'boolean') throw new TypeError('enabled は boolean が必要です');
  const env = options.env ?? process.env;
  let credentialFile = null;
  if (enabled) {
    credentialFile = options.credentialFile;
    if (typeof credentialFile !== 'string' || !isAbsolute(credentialFile)) {
      throw new TypeError('credential file は絶対pathが必要です');
    }
  } else if (options.credentialFile !== undefined) {
    throw new TypeError('disable は credential file を受け付けません');
  }
  const config = {
    schema: RUNTIME_ERROR_REPORT_CONFIG_SCHEMA,
    reporting: { enabled, credential_file: credentialFile },
  };
  writeRuntimeErrorPrivateConfig(options.configPath || defaultRuntimeErrorReportConfigPath(env), config, env);
  // 設定を変えた直後は待たずに試せるよう、間隔の記録だけを戻す。最後の結果は残す。
  updateState(stateOptions(options, env), (state) => ({ ...state, next_attempt_at: null }));
  return { schema: RUNTIME_ERROR_REPORT_CONFIG_SCHEMA, reporting: { enabled } };
}

export function getRuntimeErrorReportStatus(options = {}) {
  assertExactOptions(options, ['env', 'configPath', 'storePath', 'statePath']);
  const env = options.env ?? process.env;
  const config = readRuntimeErrorReportConfig({ env, configPath: options.configPath });
  let state = emptyState();
  let stateStatus = 'ready';
  try {
    state = normalizeState(readRuntimeErrorPrivateState(
      options.statePath || defaultRuntimeErrorReportStatePath(env), env,
    ));
  } catch {
    stateStatus = 'unavailable';
  }
  return {
    schema: RUNTIME_ERROR_REPORT_STATUS_SCHEMA,
    reporting: config?.reporting.enabled === true ? 'enabled' : 'disabled',
    collection: isRuntimeErrorCollectionEnabled({ env }) ? 'enabled' : 'disabled',
    state: stateStatus,
    last_attempt_at: state.last_attempt_at,
    last_result: state.last_result,
    last_success_at: state.last_success_at,
    next_attempt_at: state.next_attempt_at,
  };
}

/**
 * 未受領の記録を1回送る。background=trueはhookから起きた子processで、間隔を守る。
 * background=falseは利用者が明示して回した送信で、間隔を待たない。
 */
export async function reportRuntimeErrors(options = {}) {
  assertExactOptions(options, ['env', 'background', 'now', 'fetch', 'configPath', 'storePath', 'statePath']);
  const env = options.env ?? process.env;
  const background = options.background === true;
  const nowMs = options.now === undefined ? Date.now() : new Date(options.now).getTime();
  if (!Number.isFinite(nowMs)) throw new TypeError('時刻が不正です');
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const storeOptions = { env, storePath: options.storePath };
  const lockOptions = stateOptions(options, env);

  const config = readRuntimeErrorReportConfig({ env, configPath: options.configPath });
  if (config?.reporting.enabled !== true) return result('reporting_disabled');

  // 同時に起きた子processのうち1つだけが進む。進むprocessが次の時刻を先に書く。
  const claimed = updateState(lockOptions, (state) => {
    const next = Date.parse(state.next_attempt_at);
    if (background && Number.isFinite(next) && nowMs < next) return null;
    return {
      ...state,
      last_attempt_at: new Date(nowMs).toISOString(),
      next_attempt_at: new Date(nowMs + REPORT_INTERVAL_MS).toISOString(),
    };
  });
  if (!claimed) return result('throttled');

  // 記録が無効な端末でも次の時刻は書く。書かないと、hookのたびに送信processが起きる。
  const outcome = isRuntimeErrorCollectionEnabled({ env })
    ? await sendPendingRecords({
      env, nowMs, fetchImpl, storeOptions,
      credentialFile: config.reporting.credential_file,
      lastReportedVersion: claimed.last_reported_version,
    })
    : result('collection_disabled');
  updateState(lockOptions, (state) => ({
    ...state,
    last_result: outcome.status,
    last_success_at: outcome.status === 'sent' ? new Date(nowMs).toISOString() : state.last_success_at,
    last_reported_version: outcome.status === 'sent' ? PACKAGE_VERSION : state.last_reported_version,
    next_attempt_at: new Date(nowMs + (LONG_BACKOFF_STATUSES.has(outcome.status)
      ? REPORT_REJECTED_BACKOFF_MS : REPORT_INTERVAL_MS)).toISOString(),
  }));
  return outcome;
}

async function sendPendingRecords({ env, nowMs, fetchImpl, storeOptions, credentialFile, lastReportedVersion }) {
  const acknowledged = readRuntimeErrorSnapshot({ ...storeOptions, limit: 1 }).cursor.acknowledged_through;
  const snapshot = readRuntimeErrorSnapshot({ ...storeOptions, afterCursor: acknowledged });
  // 未受領の記録が無くても、受け口へ最後に届いた版と今の版が違う時は、記録が空のreportを1回送る
  // （ADR 0030）。受け口は installed_version を端末の導入版として持つ。届いた後は、版が変わるまで送らない。
  if (snapshot.runtime_errors.length === 0 && snapshot.resolutions.length === 0 &&
    lastReportedVersion === PACKAGE_VERSION) {
    return result('nothing_pending', { acknowledged_through: acknowledged });
  }

  let credential;
  try {
    credential = readReportCredential(credentialFile, env);
  } catch {
    return result('credential_unavailable');
  }

  const reportId = randomUUID();
  const body = Buffer.from(JSON.stringify(buildRuntimeErrorReport({ snapshot, reportId, nowMs })), 'utf8');
  const ts = String(Math.floor(nowMs / 1000));
  const counts = { runtime_errors: snapshot.runtime_errors.length, resolutions: snapshot.resolutions.length, report_id: reportId };

  let response;
  let text;
  try {
    response = await fetchImpl(credential.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `BugHub-HMAC-SHA256 key_id=${credential.keyId}, ts=${ts}, sig=${signRuntimeErrorReport({ secret: credential.secret, ts, body })}`,
      },
      body,
      // 署名付きの本文を、設定した宛先以外へ運ばない。
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    text = await readBoundedText(response);
  } catch {
    return result('unreachable', counts);
  }

  if (response.status !== 200) return result(classifyRejection(response.status, text), counts);
  if (!isVerifiedAcceptance(text, { secret: credential.secret, reportId })) {
    return result('unverified_response', counts);
  }
  const ack = acknowledgeRuntimeErrors(snapshot.cursor.next, storeOptions);
  return result('sent', { ...counts, acknowledged_through: ack.acknowledgedThrough });
}

export function buildRuntimeErrorReport({ snapshot, reportId, nowMs }) {
  return {
    schema_version: RUNTIME_ERROR_REPORT_WIRE_VERSION,
    report_id: reportId,
    product_id: 'throughline',
    installed_version: PACKAGE_VERSION,
    observed_at: new Date(observedAtMs({ snapshot, nowMs })).toISOString(),
    runtime_errors: snapshot.runtime_errors,
    resolutions: snapshot.resolutions,
  };
}

/**
 * observed_at は、載せる記録のどの時刻（first_seen / last_seen / resolved_at）よりも前にしない。
 * 受け口は、観測より後の時刻を持つ記録が載った report を 422 で断る。storeの時刻はミリ秒まで
 * 持つので、秒へ切り捨てると、発生や解決と同じ1秒の中で送った report が断られる。
 * 送信を始めた後に書かれた記録や、時計が戻った端末の記録にも合わせる。
 * 署名の ts は同じ nowMs から作る（受け口は observed_at と ts が10分より離れた report を断る）。
 */
function observedAtMs({ snapshot, nowMs }) {
  let latest = nowMs;
  const include = (value) => {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed) && parsed > latest) latest = parsed;
  };
  for (const record of snapshot.runtime_errors) {
    include(record.first_seen);
    include(record.last_seen);
  }
  for (const resolution of snapshot.resolutions) include(resolution.resolved_at);
  return latest;
}

export function signRuntimeErrorReport({ secret, ts, body }) {
  const bodyHash = createHash('sha256').update(body).digest('hex');
  return createHmac('sha256', Buffer.from(secret, 'utf8')).update(`${ts}\n${bodyHash}`).digest('hex');
}

export function signRuntimeErrorReportResponse({ secret, reportId, receivedAt }) {
  return createHmac('sha256', Buffer.from(secret, 'utf8')).update(`${reportId}\n${receivedAt}`).digest('hex');
}

function isVerifiedAcceptance(text, { secret, reportId }) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  if (parsed.accepted !== true || parsed.report_id !== reportId) return false;
  if (typeof parsed.received_at !== 'string' || typeof parsed.sig !== 'string' || !/^[0-9a-f]{64}$/.test(parsed.sig)) return false;
  const expected = signRuntimeErrorReportResponse({ secret, reportId, receivedAt: parsed.received_at });
  return timingSafeEqual(Buffer.from(parsed.sig, 'hex'), Buffer.from(expected, 'hex'));
}

function classifyRejection(status, text) {
  let code = null;
  try {
    const parsed = JSON.parse(text);
    code = [parsed?.error, parsed?.code].find((value) => typeof value === 'string') ?? null;
  } catch {
    // 受け口以外の応答は本文を解釈しない。
  }
  if (code === 'timestamp_skew' || code === 'observed_at_skew') return 'clock_skew';
  if (status === 401 || status === 403) return 'rejected_credential';
  if (status === 409 || status === 413 || status === 422) return 'rejected_report';
  if (status === 429) return 'rate_limited';
  return 'unreachable';
}

async function readBoundedText(response) {
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_RESPONSE_BYTES) throw new Error('response too large');
  return buffer.toString('utf8');
}

function readReportCredential(path, env) {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('credential file unavailable');
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('credential file unsafe');
  if (!isWindows(env)) {
    // 受け口の持ち主が本人所有・group/otherに権限なしで置く。それ以外の形は読まない。
    if ((info.mode & 0o077) !== 0) throw new Error('credential file permissions unsafe');
    if (typeof process.getuid === 'function' && info.uid !== process.getuid()) throw new Error('credential file owner unsafe');
  }
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('credential file invalid');
  const keys = Object.keys(parsed);
  if (keys.length !== 3 || !['url', 'key_id', 'secret'].every((key) => keys.includes(key))) throw new Error('credential file invalid');
  const { url, key_id: keyId, secret } = parsed;
  if (typeof url !== 'string' || typeof keyId !== 'string' || typeof secret !== 'string') throw new Error('credential file invalid');
  const target = new URL(url);
  if (!['http:', 'https:'].includes(target.protocol) || target.username !== '' || target.password !== '') throw new Error('credential url invalid');
  // key_idはAuthorization headerの「, 」区切りへ入る。区切りと制御文字を含む値は使わない。
  if (!/^[\x21-\x2b\x2d-\x7e]{1,256}$/.test(keyId) || secret.length === 0) throw new Error('credential file invalid');
  return { url: target.href, keyId, secret };
}

function stateOptions(options, env) {
  return {
    env,
    storePath: options.storePath || defaultRuntimeErrorStorePath(env),
    statePath: options.statePath || defaultRuntimeErrorReportStatePath(env),
  };
}

// store lockの下でstateを読み、updateが返した値を書く。nullを返すと書かない。
function updateState({ env, storePath, statePath }, update) {
  return withRuntimeErrorStoreLock({ env, storePath }, (privateDirectory) => {
    let current;
    try {
      current = normalizeState(readRuntimeErrorPrivateState(statePath, env, privateDirectory));
    } catch {
      // 壊れたstateは間隔の記録でしかない。空から書き直す。
      current = emptyState();
    }
    const next = update(current);
    if (next === null) return null;
    const state = normalizeState(next);
    writeRuntimeErrorPrivateState(statePath, state, env, privateDirectory);
    return state;
  });
}

function emptyState() {
  return {
    schema: RUNTIME_ERROR_REPORT_STATE_SCHEMA,
    last_attempt_at: null,
    last_result: null,
    last_success_at: null,
    next_attempt_at: null,
    last_reported_version: null,
  };
}

function normalizeState(value) {
  const state = emptyState();
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
    value.schema !== RUNTIME_ERROR_REPORT_STATE_SCHEMA) return state;
  for (const key of ['last_attempt_at', 'last_success_at', 'next_attempt_at']) {
    if (isCanonicalTimestamp(value[key])) state[key] = value[key];
  }
  if (RESULT_STATUSES.has(value.last_result)) state.last_result = value.last_result;
  if (typeof value.last_reported_version === 'string' && /^[0-9A-Za-z.+-]{1,64}$/.test(value.last_reported_version)) {
    state.last_reported_version = value.last_reported_version;
  }
  return state;
}

function isCanonicalTimestamp(value) {
  if (typeof value !== 'string') return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

export const _internal = { classifyRejection, isVerifiedAcceptance, LONG_BACKOFF_STATUSES };

function result(status, fields = {}) {
  return { schema: RUNTIME_ERROR_REPORT_RESULT_SCHEMA, status, ...fields };
}

function assertExactOptions(options, allowed) {
  if (!options || typeof options !== 'object' || Array.isArray(options) ||
    Object.keys(options).some((key) => !allowed.includes(key))) {
    throw new TypeError('runtime error report API は未定義 option を受け付けません');
  }
}
