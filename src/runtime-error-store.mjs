import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import childProcess from 'node:child_process';
import { arch as hostArch, platform as hostPlatform } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { applyAndVerifyWindowsAcl, isWindows, verifyWindowsAcl } from './os/windows-acl.mjs';
import { windowsLocalAppData, xdgConfigHome, xdgStateHome } from './os/app-dirs.mjs';

const require = createRequire(import.meta.url);
const PACKAGE_VERSION = require('../package.json').version;

export const RUNTIME_ERROR_STORE_SCHEMA = 'throughline.runtime_errors.v1';
export const RUNTIME_ERROR_CONFIG_SCHEMA = 'throughline.runtime_error_config.v1';
export const RUNTIME_ERROR_STATE_SCHEMA_VERSION = '1.0';
export const RUNTIME_ERROR_DIAGNOSTIC = '[throughline:runtime-errors] store_unavailable\n';
const DEFAULT_SNAPSHOT_LIMIT = 256;
const BEST_EFFORT_TIMEOUT_MS = 750;
const WINDOWS_BEST_EFFORT_TIMEOUT_MS = 5_000;
const RESOLUTION_REASONS = new Set(['manual', 'recovered']);
const PRIVATE_DIRECTORY_CAPABILITY = Symbol('throughline.private-directory');

const DEFINITIONS = Object.freeze({
  HOOK_SESSION_START_FAILED: Object.freeze({
    component: 'claude_session_start_hook',
    severity: 'high',
    template: 'Throughline Claude SessionStart hook processing failed',
  }),
  HOOK_PROMPT_SUBMIT_FAILED: Object.freeze({
    component: 'claude_prompt_submit_hook',
    severity: 'high',
    template: 'Throughline Claude UserPromptSubmit hook processing failed',
  }),
  HOOK_PROCESS_TURN_FAILED: Object.freeze({
    component: 'claude_stop_hook',
    severity: 'high',
    template: 'Throughline Claude Stop hook processing failed',
  }),
  HOOK_CODEX_FAILED: Object.freeze({
    component: 'codex_hook',
    severity: 'high',
    template: 'Throughline Codex hook processing failed',
  }),
});

export function defaultRuntimeErrorConfigPath(env = process.env) {
  if (isWindows(env)) {
    return join(windowsLocalAppData(env), 'throughline', 'runtime-errors.config.json');
  }
  return join(xdgConfigHome(env), 'throughline', 'runtime-errors.config.json');
}

export function defaultRuntimeErrorStorePath(env = process.env) {
  if (isWindows(env)) {
    return join(windowsLocalAppData(env), 'throughline', 'runtime-errors.json');
  }
  return join(xdgStateHome(env), 'throughline', 'runtime-errors.json');
}

export function isRuntimeErrorCollectionEnabled({ env = process.env, configPath } = {}) {
  try {
    const path = configPath || defaultRuntimeErrorConfigPath(env);
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink()) return false;
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return isCanonicalRuntimeErrorConfig(parsed) && parsed.collection.enabled === true;
  } catch {
    return false;
  }
}

export function setRuntimeErrorCollectionEnabled(enabled, options = {}) {
  assertExactOptions(options, ['env', 'configPath']);
  if (typeof enabled !== 'boolean') throw new TypeError('enabled は boolean が必要です');
  const env = options.env ?? process.env;
  const path = options.configPath || defaultRuntimeErrorConfigPath(env);
  const directory = dirname(path);
  ensurePrivateStoreDirectory(directory, env);
  const temporary = join(directory, `.runtime-errors-config.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  const config = {
    schema: RUNTIME_ERROR_CONFIG_SCHEMA,
    collection: { enabled },
  };
  try {
    writeFileSync(temporary, `${JSON.stringify(config)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    if (isWindows(env)) {
      applyAndVerifyWindowsAcl(temporary, false);
      assertPrivateStoreFileShape(lstatSync(temporary));
    } else {
      chmodSync(temporary, 0o600);
      assertPrivateStoreFile(lstatSync(temporary), env, temporary);
    }
    renameSync(temporary, path);
    if (isWindows(env)) assertPrivateStoreFileShape(lstatSync(path));
    else assertPrivateStoreFile(lstatSync(path), env, path);
    return config;
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function observeRuntimeError(input, options = {}) {
  assertExactInput(input, ['code', 'now']);
  assertExactOptions(options, ['env', 'configPath', 'storePath', 'version', 'platform', 'arch']);
  const definition = DEFINITIONS[input.code];
  if (!definition) throw new TypeError('未登録の runtime error code です');
  if (!collectionEnabled(options)) return { status: 'disabled' };

  return withStoreLock(options, (privateDirectory) => {
    const now = normalizeTimestamp(input.now);
    const version = normalizeVersion(options.version ?? PACKAGE_VERSION);
    const fingerprint = createHash('sha256')
      .update(['throughline', definition.component, input.code, definition.template].join('\0'))
      .digest('hex');
    const store = readStore(options, { privateDirectory });
    const existing = store.records.find((record) => record.fingerprint === fingerprint);
    const sequence = nextSequence(store);
    if (existing) {
      existing.product_version = version;
      existing.os = normalizePlatform(options.platform ?? hostPlatform());
      existing.arch = normalizeArch(options.arch ?? hostArch());
      existing.count += 1;
      existing.last_seen = now;
      existing.status = 'open';
      existing.resolved_at = null;
      existing.reason_code = null;
      existing.sequence = sequence;
    } else {
      store.records.push({
        product: 'throughline', product_version: version, component: definition.component,
        error_code: input.code, message_template: definition.template, severity: definition.severity,
        fingerprint, count: 1, first_seen: now, last_seen: now,
        state_schema_version: RUNTIME_ERROR_STATE_SCHEMA_VERSION,
        os: normalizePlatform(options.platform ?? hostPlatform()), arch: normalizeArch(options.arch ?? hostArch()),
        status: 'open', resolved_at: null, reason_code: null, sequence,
      });
    }
    writeStore(store, options, privateDirectory);
    return { status: 'recorded', fingerprint, sequence };
  });
}

export function resolveRuntimeError(fingerprint, options = {}) {
  assertExactOptions(options, ['env', 'configPath', 'storePath', 'now', 'reasonCode']);
  assertFingerprint(fingerprint);
  if (!collectionEnabled(options)) return { status: 'disabled' };
  return withStoreLock(options, (privateDirectory) => {
    const store = readStore(options, { privateDirectory });
    const record = store.records.find((candidate) => candidate.fingerprint === fingerprint);
    if (!record) return { status: 'not_found' };
    if (record.status === 'resolved') return { status: 'resolved', sequence: record.sequence };
    const reasonCode = options.reasonCode ?? 'manual';
    if (!RESOLUTION_REASONS.has(reasonCode)) throw new TypeError('reasonCode が未登録です');
    record.status = 'resolved';
    record.resolved_at = normalizeTimestamp(options.now);
    record.reason_code = reasonCode;
    record.sequence = nextSequence(store);
    writeStore(store, options, privateDirectory);
    return { status: 'resolved', sequence: record.sequence };
  });
}

export function reopenRuntimeError(fingerprint, options = {}) {
  assertExactOptions(options, ['env', 'configPath', 'storePath']);
  assertFingerprint(fingerprint);
  if (!collectionEnabled(options)) return { status: 'disabled' };
  return withStoreLock(options, (privateDirectory) => {
    const store = readStore(options, { privateDirectory });
    const record = store.records.find((candidate) => candidate.fingerprint === fingerprint);
    if (!record) return { status: 'not_found' };
    if (record.status === 'open') return { status: 'open', sequence: record.sequence };
    record.status = 'open';
    record.resolved_at = null;
    record.reason_code = null;
    record.sequence = nextSequence(store);
    writeStore(store, options, privateDirectory);
    return { status: 'open', sequence: record.sequence };
  });
}

export function acknowledgeRuntimeErrors(cursor, options = {}) {
  if (!Number.isSafeInteger(cursor) || cursor < 0) throw new TypeError('cursor は非負の整数が必要です');
  if (!collectionEnabled(options)) return { status: 'disabled', acknowledgedThrough: 0 };
  return withStoreLock(options, (privateDirectory) => {
    const store = readStore(options, { privateDirectory });
    const highWatermark = store.next_sequence - 1;
    if (cursor > highWatermark) throw new RangeError('cursor がstore high watermarkを超えています');
    store.acknowledged_through = Math.max(store.acknowledged_through, cursor);
    writeStore(store, options, privateDirectory);
    return { status: 'acknowledged', acknowledgedThrough: store.acknowledged_through };
  });
}

export function compactRuntimeErrors({
  env = process.env,
  configPath,
  storePath,
  now,
  retentionMs = 30 * 24 * 60 * 60 * 1000,
} = {}) {
  if (!Number.isSafeInteger(retentionMs) || retentionMs < 0) {
    throw new TypeError('retentionMs は非負の整数が必要です');
  }
  const options = { env, configPath, storePath };
  if (!collectionEnabled(options)) return { status: 'disabled', removed: 0 };
  return withStoreLock(options, (privateDirectory) => {
    const store = readStore(options, { privateDirectory });
    const cutoff = Date.parse(normalizeTimestamp(now)) - retentionMs;
    const before = store.records.length;
    store.records = store.records.filter((record) => {
      const acknowledged = record.sequence <= store.acknowledged_through;
      const expired = Date.parse(record.last_seen) <= cutoff;
      return !(acknowledged && record.status === 'resolved' && expired);
    });
    writeStore(store, options, privateDirectory);
    return { status: 'compacted', removed: before - store.records.length };
  });
}

export function readRuntimeErrorSnapshot({
  env = process.env,
  configPath,
  storePath,
  afterCursor = 0,
  limit = DEFAULT_SNAPSHOT_LIMIT,
} = {}) {
  if (!Number.isSafeInteger(afterCursor) || afterCursor < 0) {
    throw new TypeError('afterCursor は非負の整数が必要です');
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > DEFAULT_SNAPSHOT_LIMIT) {
    throw new TypeError(`limit は 1..${DEFAULT_SNAPSHOT_LIMIT} が必要です`);
  }
  const options = { env, configPath, storePath };
  const enabled = collectionEnabled(options);
  const store = enabled ? readStore(options, { missingIsEmpty: true }) : emptyStore();
  const candidates = store.records
    .filter((record) => record.sequence > afterCursor)
    .sort((left, right) => left.sequence - right.sequence);
  const selected = candidates.slice(0, limit);
  return {
    schema: RUNTIME_ERROR_STORE_SCHEMA,
    product: 'throughline',
    version: PACKAGE_VERSION,
    state_schema_version: RUNTIME_ERROR_STATE_SCHEMA_VERSION,
    cursor: {
      high_watermark: store.next_sequence - 1,
      acknowledged_through: store.acknowledged_through,
      next: selected.at(-1)?.sequence ?? afterCursor,
    },
    runtime_errors: selected.filter((record) => record.status === 'open').map(toPublicRuntimeError),
    resolutions: selected.filter((record) => record.status === 'resolved').map((record) => ({
      fingerprint: record.fingerprint,
      resolved_at: record.resolved_at,
      reason_code: record.reason_code,
    })),
    diagnostics: {
      collection: enabled ? 'enabled' : 'disabled',
      status: enabled ? 'ready' : 'not_applicable',
      total_count: store.records.length,
      pending_count: store.records.filter((record) => record.sequence > store.acknowledged_through).length,
      truncated: candidates.length > selected.length,
    },
  };
}

export function getRuntimeErrorDiagnostics(options = {}) {
  const enabled = collectionEnabled(options);
  if (!enabled) return diagnosticProjection('disabled', 'not_applicable', emptyStore());
  try {
    return diagnosticProjection('enabled', 'ready', readStore(options, { missingIsEmpty: true }));
  } catch {
    return diagnosticProjection('enabled', 'unavailable', emptyStore());
  }
}

export function recordRuntimeErrorBestEffort(code, options = {}) {
  const { stderr = process.stderr, ...storeOptions } = options;
  try {
    const child = childProcess.spawnSync(process.execPath, [fileURLToPath(new URL('./runtime-error-observer.mjs', import.meta.url)), code], {
      env: storeOptions.env ?? process.env,
      encoding: 'utf8',
      stdio: 'ignore',
      timeout: isWindows(storeOptions.env) ? WINDOWS_BEST_EFFORT_TIMEOUT_MS : BEST_EFFORT_TIMEOUT_MS,
      windowsHide: true,
    });
    if (child.status === 0) return { status: 'recorded' };
    if (child.status === 3) return { status: 'disabled' };
    throw new Error('runtime error observer failed');
  } catch {
    stderr.write(RUNTIME_ERROR_DIAGNOSTIC);
    return { status: 'store_unavailable' };
  }
}

function collectionEnabled(options) {
  return isRuntimeErrorCollectionEnabled({
    env: options.env,
    configPath: options.configPath,
  });
}

function emptyStore() {
  return {
    schema: RUNTIME_ERROR_STORE_SCHEMA,
    next_sequence: 1,
    acknowledged_through: 0,
    records: [],
  };
}

function readStore(options, { missingIsEmpty = true, privateDirectory } = {}) {
  const path = options.storePath || defaultRuntimeErrorStorePath(options.env);
  let parsed;
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('runtime error store path unsafe');
    assertPrivateDirectoryCapability(privateDirectory, dirname(path), options.env);
    assertPrivateStoreFile(info, options.env, path);
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    if (missingIsEmpty && error?.code === 'ENOENT') return emptyStore();
    throw error;
  }
  validateStore(parsed);
  return parsed;
}

function writeStore(store, options, privateDirectory) {
  validateStore(store);
  const path = options.storePath || defaultRuntimeErrorStorePath(options.env);
  const directory = dirname(path);
  assertPrivateDirectoryCapability(privateDirectory, directory, options.env);
  const temporary = join(directory, `.runtime-errors.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    writeFileSync(temporary, `${JSON.stringify(store)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    if (!isWindows(options.env)) {
      chmodSync(temporary, 0o600);
    } else {
      // The apply script performs an exact read-back verification. Repeating
      // the same PowerShell verification here only consumes the bounded hook
      // observer deadline without protecting a new state transition.
      applyAndVerifyWindowsAcl(temporary, false);
      assertPrivateStoreFileShape(lstatSync(temporary));
    }
    // ACL/mode is complete before replacement, so an ACL failure leaves the
    // previous final store intact. Rename preserves the prepared file ACL.
    renameSync(temporary, path);
    if (!isWindows(options.env)) assertPrivateStoreFile(lstatSync(path), options.env, path);
    else assertPrivateStoreFileShape(lstatSync(path));
  } finally {
    rmSync(temporary, { force: true });
  }
}

function withStoreLock(options, operation) {
  const storePath = options.storePath || defaultRuntimeErrorStorePath(options.env);
  const directory = dirname(storePath);
  ensurePrivateStoreDirectory(directory, options.env);
  const lockPath = `${storePath}.lock.sqlite`;
  let created = false;
  try {
    writeFileSync(lockPath, '', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    created = true;
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  if (created) {
    if (isWindows(options.env)) applyAndVerifyWindowsAcl(lockPath, false);
    else chmodSync(lockPath, 0o600);
  }
  if (created && isWindows(options.env)) assertPrivateStoreFileShape(lstatSync(lockPath));
  else assertPrivateStoreFile(lstatSync(lockPath), options.env, lockPath);
  const database = new DatabaseSync(lockPath);
  let active = false;
  try {
    database.exec('PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL');
    database.exec('BEGIN IMMEDIATE');
    active = true;
    const result = operation(privateDirectoryCapability(directory, options.env));
    database.exec('COMMIT');
    active = false;
    return result;
  } finally {
    if (active) { try { database.exec('ROLLBACK'); } catch {} }
    database.close();
  }
}

function ensurePrivateStoreDirectory(directory, env = process.env) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const info = lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('runtime error store directory unsafe');
  if (isWindows(env)) {
    applyAndVerifyWindowsAcl(directory, true);
    assertPrivateStoreDirectoryShape(lstatSync(directory));
  } else {
    chmodSync(directory, 0o700);
    assertPrivateStoreDirectory(directory, env);
  }
}

function privateDirectoryCapability(directory, env) {
  return Object.freeze({
    directory,
    windows: isWindows(env),
    [PRIVATE_DIRECTORY_CAPABILITY]: true,
  });
}

function assertPrivateDirectoryCapability(capability, directory, env) {
  if (!capability || capability[PRIVATE_DIRECTORY_CAPABILITY] !== true ||
    capability.directory !== directory || capability.windows !== isWindows(env)) {
    // Read-only callers do not hold a mutation capability and still perform
    // the complete ACL/mode verification immediately before reading.
    assertPrivateStoreDirectory(directory, env);
    return;
  }
  assertPrivateStoreDirectoryShape(lstatSync(directory));
}

function assertPrivateStoreDirectoryShape(info) {
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error('runtime error store directory unsafe');
  }
}

function assertPrivateStoreFileShape(info) {
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error('runtime error store path unsafe');
  }
}

function isCanonicalRuntimeErrorConfig(value) {
  if (!isPlainObject(value) || !exactKeys(value, ['schema', 'collection']) ||
    value.schema !== RUNTIME_ERROR_CONFIG_SCHEMA) return false;
  if (!isPlainObject(value.collection) || !exactKeys(value.collection, ['enabled']) || typeof value.collection.enabled !== 'boolean') return false;
  return true;
}

function isPlainObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function exactKeys(value, allowed, optional = false) {
  const keys = Object.keys(value);
  if (keys.some((key) => !allowed.includes(key))) return false;
  return optional ? keys.includes('enabled') : allowed.every((key) => keys.includes(key));
}

function validateStore(store) {
  if (!store || typeof store !== 'object' || Array.isArray(store) ||
    !exactKeys(store, ['schema', 'next_sequence', 'acknowledged_through', 'records']) ||
    store.schema !== RUNTIME_ERROR_STORE_SCHEMA ||
    !Number.isSafeInteger(store.next_sequence) || store.next_sequence < 1 ||
    !Number.isSafeInteger(store.acknowledged_through) || store.acknowledged_through < 0 ||
    store.acknowledged_through >= store.next_sequence ||
    !Array.isArray(store.records)) {
    throw new Error('runtime error store schema invalid');
  }
  const fingerprints = new Set();
  const sequences = new Set();
  for (const record of store.records) {
    validateRecord(record, store.next_sequence);
    if (fingerprints.has(record.fingerprint) || sequences.has(record.sequence)) {
      throw new Error('runtime error record uniqueness invalid');
    }
    fingerprints.add(record.fingerprint);
    sequences.add(record.sequence);
  }
}

function validateRecord(record, nextSequenceValue) {
  const keys = [
    'product', 'product_version', 'component', 'error_code', 'message_template', 'severity',
    'fingerprint', 'count', 'first_seen', 'last_seen', 'state_schema_version', 'os', 'arch',
    'status', 'resolved_at', 'reason_code', 'sequence',
  ];
  if (!record || typeof record !== 'object' || Array.isArray(record) ||
    Object.keys(record).length !== keys.length || keys.some((key) => !(key in record))) {
    throw new Error('runtime error record schema invalid');
  }
  assertFingerprint(record.fingerprint);
  const definition = DEFINITIONS[record.error_code];
  const expectedFingerprint = definition && createHash('sha256')
    .update(['throughline', definition.component, record.error_code, definition.template].join('\0'))
    .digest('hex');
  if (record.product !== 'throughline' || !DEFINITIONS[record.error_code] ||
    DEFINITIONS[record.error_code].component !== record.component ||
    DEFINITIONS[record.error_code].template !== record.message_template ||
    DEFINITIONS[record.error_code].severity !== record.severity ||
    !Number.isSafeInteger(record.count) || record.count < 1 ||
    !Number.isSafeInteger(record.sequence) || record.sequence < 1 || record.sequence >= nextSequenceValue ||
    !['open', 'resolved'].includes(record.status) ||
    record.state_schema_version !== RUNTIME_ERROR_STATE_SCHEMA_VERSION ||
    record.fingerprint !== expectedFingerprint ||
    (record.status === 'open' && (record.resolved_at !== null || record.reason_code !== null)) ||
    (record.status === 'resolved' && (!isCanonicalTimestamp(record.resolved_at) || !RESOLUTION_REASONS.has(record.reason_code)))) {
    throw new Error('runtime error record value invalid');
  }
  if (Date.parse(normalizeTimestamp(record.first_seen)) > Date.parse(normalizeTimestamp(record.last_seen))) {
    throw new Error('runtime error record timestamp invalid');
  }
  normalizeVersion(record.product_version);
  normalizePlatform(record.os);
  normalizeArch(record.arch);
}

function nextSequence(store) {
  const current = store.next_sequence;
  store.next_sequence += 1;
  return current;
}

function toPublicRuntimeError(record) {
  return {
    error_code: record.error_code,
    component: record.component,
    status: record.status,
    severity: record.severity,
    fingerprint: record.fingerprint,
    message_template: record.message_template,
    occurrence_count: record.count,
    first_seen: record.first_seen,
    last_seen: record.last_seen,
    product_version: record.product_version,
    state_schema_version: record.state_schema_version,
  };
}

function diagnosticProjection(collection, status, store) {
  return {
    schema: 'throughline.runtime_error_diagnostics.v1',
    collection,
    status,
    total_count: store.records.length,
    open_count: store.records.filter((record) => record.status === 'open').length,
    pending_count: store.records.filter((record) => record.sequence > store.acknowledged_through).length,
    high_watermark: store.next_sequence - 1,
    acknowledged_through: store.acknowledged_through,
  };
}

function isCanonicalTimestamp(value) {
  if (typeof value !== 'string') return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function assertPrivateStoreDirectory(directory, env = process.env) {
  const info = lstatSync(directory);
  assertPrivateStoreDirectoryShape(info);
  if (isWindows(env)) verifyWindowsAcl(directory, true);
  else assertPosixOwnerMode(info, 0o700);
}

function assertPrivateStoreFile(info, env = process.env, path) {
  assertPrivateStoreFileShape(info);
  if (isWindows(env)) verifyWindowsAcl(path, false);
  else assertPosixOwnerMode(info, 0o600);
}

function assertPosixOwnerMode(info, expectedMode) {
  if ((info.mode & 0o777) !== expectedMode) throw new Error('runtime error store permissions unsafe');
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) throw new Error('runtime error store owner unsafe');
}

function assertExactInput(input, allowed) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
    Object.keys(input).some((key) => !allowed.includes(key))) {
    throw new TypeError('runtime error API は固定 code と時刻だけを受け付けます');
  }
}

function assertExactOptions(options, allowed) {
  if (!options || typeof options !== 'object' || Array.isArray(options) ||
    Object.keys(options).some((key) => !allowed.includes(key))) {
    throw new TypeError('runtime error API は未定義 option を受け付けません');
  }
}

function assertFingerprint(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new TypeError('fingerprint が不正です');
  }
}

function normalizeTimestamp(value) {
  const date = value === undefined ? new Date() : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError('時刻が不正です');
  return date.toISOString();
}

function normalizeVersion(value) {
  if (typeof value !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value)) {
    throw new TypeError('version が不正です');
  }
  return value;
}

function normalizePlatform(value) {
  if (!['darwin', 'linux', 'windows', 'win32'].includes(value)) throw new TypeError('OS が不正です');
  return value === 'win32' ? 'windows' : value;
}

function normalizeArch(value) {
  if (!['x64', 'arm64', 'arm', 'ia32'].includes(value)) throw new TypeError('arch が不正です');
  return value;
}

export const _internal = {
  DEFINITIONS,
  emptyStore,
  validateStore,
  writeStore,
};
