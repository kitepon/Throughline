import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import { dirname, join, posix, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';

import { spawnPortableSync } from '../os/portable-spawn-sync.mjs';

const require = createRequire(import.meta.url);
const PACKAGE_VERSION = require('../../package.json').version;
const PACKAGE_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const DEFAULT_CLI_PATH = join(PACKAGE_ROOT, 'bin', 'throughline.mjs');
const POST_INSTALL_PHASE = 'post-install';
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const WINDOWS_NPM_OPTIONS = ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command'];

export const SELF_UPDATE_SCHEMA = 'throughline.self_update.v1';
export const SELF_UPDATE_IDENTITY_SCHEMA = 'throughline.self_update_identity.v1';

export function buildSelfUpdateIdentity({
  version = PACKAGE_VERSION,
  cliPath = DEFAULT_CLI_PATH,
} = {}) {
  return {
    schema: SELF_UPDATE_IDENTITY_SCHEMA,
    version,
    cliPath,
  };
}

export function parseArgs(argv = []) {
  if (argv.length === 0) return { json: false };
  if (argv.length === 1 && argv[0] === '--json') return { json: true };
  throw new TypeError('usage error');
}

function commandResult(runner, command, args, env, platform) {
  return runner(command, args, {
    encoding: 'utf8',
    env,
    input: '',
    platform,
  });
}

function windowsCommandResult(runner, command, args, env, platform) {
  const quoted = [command, ...args]
    .map((value) => `'${value.replaceAll("'", "''")}'`)
    .join(' ');
  const script = `& ${quoted}; ` +
    'if ($null -eq $LASTEXITCODE) { exit 1 }; exit $LASTEXITCODE';
  return commandResult(
    runner,
    'pwsh.exe',
    [...WINDOWS_NPM_OPTIONS, script],
    env,
    platform,
  );
}

function npmResult(runner, args, env, platform) {
  if (platform === 'win32') return windowsCommandResult(runner, 'npm.cmd', args, env, platform);
  return commandResult(runner, 'npm', args, env, platform);
}

function publicIdentityResult(runner, env, platform) {
  const args = ['--self-update-identity'];
  if (platform === 'win32') {
    return windowsCommandResult(runner, 'throughline.cmd', args, env, platform);
  }
  return commandResult(runner, 'throughline', args, env, platform);
}

function succeeded(result) {
  return result?.status === 0 && !result.error;
}

function parseRegistryVersion(result) {
  if (!succeeded(result)) return null;
  try {
    let value = JSON.parse(result.stdout);
    if (Array.isArray(value) && value.length === 1) [value] = value;
    return typeof value === 'string' && VERSION_PATTERN.test(value) ? value : null;
  } catch {
    return null;
  }
}

function parseInstalledVersion(result) {
  if (!succeeded(result)) return null;
  const value = result.stdout?.trim();
  return typeof value === 'string' && VERSION_PATTERN.test(value) ? value : null;
}

export function resolveGlobalCliPath(result, platform = process.platform) {
  if (!succeeded(result) || typeof result.stdout !== 'string') return null;
  const lines = result.stdout.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  if (lines.length !== 1) return null;
  const path = platform === 'win32' ? win32 : posix;
  if (!path.isAbsolute(lines[0])) return null;
  return path.join(lines[0], 'throughline', 'bin', 'throughline.mjs');
}

export function validateSelfUpdateIdentity(value, {
  version,
  cliPath,
  platform = process.platform,
  canonicalizePath = realpathSync,
} = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const exact = ['cliPath', 'schema', 'version'];
  if (Object.keys(value).sort().join('\0') !== exact.sort().join('\0')) return false;
  if (value.schema !== SELF_UPDATE_IDENTITY_SCHEMA || value.version !== version ||
    typeof value.cliPath !== 'string') return false;
  const path = platform === 'win32' ? win32 : posix;
  if (!path.isAbsolute(value.cliPath) || !path.isAbsolute(cliPath ?? '')) return false;
  try {
    const actual = canonicalizePath(value.cliPath);
    const expected = canonicalizePath(cliPath);
    return platform === 'win32'
      ? win32.normalize(actual).toLowerCase() === win32.normalize(expected).toLowerCase()
      : actual === expected;
  } catch {
    return false;
  }
}

export function validateMigrationResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const exact = [
    'afterSchemaVersion',
    'beforeSchemaVersion',
    'schema',
    'status',
    'supportedSchemaVersion',
  ];
  if (Object.keys(value).sort().join('\0') !== exact.sort().join('\0')) return false;
  if (value.schema !== 'throughline.database_migration.v1') return false;
  if (!['migrated', 'already_current', 'not_applicable'].includes(value.status)) return false;
  if (!Number.isInteger(value.supportedSchemaVersion) || value.supportedSchemaVersion < 1) return false;
  if (value.status === 'not_applicable') {
    return value.beforeSchemaVersion === null && value.afterSchemaVersion === null;
  }
  if (!Number.isInteger(value.beforeSchemaVersion) || !Number.isInteger(value.afterSchemaVersion)) {
    return false;
  }
  if (value.afterSchemaVersion !== value.supportedSchemaVersion) return false;
  if (value.status === 'already_current') return value.beforeSchemaVersion === value.afterSchemaVersion;
  return value.beforeSchemaVersion < value.afterSchemaVersion;
}

export function validatePostUpdateDiagnostics(value, version) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (value.schema !== 'throughline.native_factory_diagnostics.v1' || value.version !== version) {
    return false;
  }
  if (value.overall?.status !== 'ready') return false;
  const database = value.databaseSchema;
  if (!['ready', 'not_applicable'].includes(database?.status)) return false;
  if (database.status === 'ready' &&
    database.databaseSchemaVersion !== database.supportedDatabaseSchemaVersion) return false;
  const hooks = value.hooks;
  if (hooks?.status !== 'ready' ||
    !['userPromptSubmit', 'postToolUse', 'stop'].every((event) => hooks.events?.[event] === 'ready')) {
    return false;
  }
  return ['capture', 'restore', 'handoff'].every((check) =>
    ['ready', 'not_applicable'].includes(value.readiness?.[check]?.status));
}

function parseJsonOutput(result, { requireSuccess = true } = {}) {
  if ((requireSuccess && !succeeded(result)) || typeof result?.stdout !== 'string') return null;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

export function validatePostInstallResult(value, { beforeVersion, afterVersion } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const exact = [
    'afterVersion',
    'beforeVersion',
    'diagnosticsStatus',
    'migrationStatus',
    'schema',
    'status',
  ];
  if (Object.keys(value).sort().join('\0') !== exact.sort().join('\0')) return false;
  const expectedStatus = beforeVersion === afterVersion ? 'already_current' : 'updated';
  return value.schema === SELF_UPDATE_SCHEMA &&
    value.status === expectedStatus &&
    value.beforeVersion === beforeVersion &&
    value.afterVersion === afterVersion &&
    ['migrated', 'already_current', 'not_applicable'].includes(value.migrationStatus) &&
    value.diagnosticsStatus === 'ready';
}

function validatePostInstallFailure(value, version) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const exact = ['schema', 'stage', 'status', 'version'];
  return Object.keys(value).sort().join('\0') === exact.sort().join('\0') &&
    value.schema === SELF_UPDATE_SCHEMA &&
    value.status === 'failed' &&
    typeof value.stage === 'string' && value.stage.length > 0 &&
    value.version === version;
}

function writeChildStderr(stderr, result) {
  if (typeof result?.stderr === 'string' && result.stderr.length > 0) stderr.write(result.stderr);
}

function emitFailure({ json, stdout, stderr, stage, version = PACKAGE_VERSION }, exitCode = 1) {
  if (json) {
    stdout.write(`${JSON.stringify({
      schema: SELF_UPDATE_SCHEMA,
      status: 'failed',
      stage,
      version,
    })}\n`);
  } else {
    stderr.write(`[throughline self-update] failed: ${stage}\n`);
  }
  return exitCode;
}

function emitCommandFailure(options, result, exitCode = 1) {
  writeChildStderr(options.stderr, result);
  return emitFailure(options, exitCode);
}

function emitSuccess({ json, stdout }, result) {
  if (json) stdout.write(`${JSON.stringify(result)}\n`);
  else {
    stdout.write(
      `Throughline ${result.beforeVersion} -> ${result.afterVersion}: ${result.status}; ` +
      `migration=${result.migrationStatus}; diagnostics=${result.diagnosticsStatus}\n`,
    );
  }
  return 0;
}

function finishUpdate({
  json,
  stdout,
  stderr,
  env,
  runner,
  packageVersion,
  nodePath,
  cliPath,
  platform,
}) {
  const beforeVersion = env.THROUGHLINE_SELF_UPDATE_BEFORE_VERSION;
  if (!VERSION_PATTERN.test(beforeVersion ?? '')) {
    return emitFailure({ json, stdout, stderr, stage: 'invalid_update_phase', version: packageVersion });
  }
  if (env.THROUGHLINE_SELF_UPDATE_EXPECTED_VERSION !== packageVersion) {
    return emitFailure({ json, stdout, stderr, stage: 'installed_version_mismatch', version: packageVersion });
  }

  const registry = npmResult(runner, ['view', 'throughline', 'version', '--json'], env, platform);
  const latestVersion = parseRegistryVersion(registry);
  if (latestVersion === null || latestVersion !== packageVersion) {
    return emitCommandFailure(
      { json, stdout, stderr, stage: 'version_verification_failed', version: packageVersion },
      registry,
    );
  }

  const install = commandResult(runner, nodePath, [cliPath, 'install'], env, platform);
  if (!succeeded(install)) {
    return emitCommandFailure(
      { json, stdout, stderr, stage: 'integration_install_failed', version: packageVersion },
      install,
    );
  }

  const migrationResult = commandResult(
    runner, nodePath, [cliPath, 'migrate', '--json'], env, platform,
  );
  const migration = parseJsonOutput(migrationResult);
  if (!validateMigrationResult(migration)) {
    return emitCommandFailure(
      { json, stdout, stderr, stage: 'database_migration_failed', version: packageVersion },
      migrationResult,
    );
  }

  const diagnosticsResult = commandResult(
    runner, nodePath, [cliPath, 'factory-diagnostics', '--json'], env, platform,
  );
  const diagnostics = parseJsonOutput(diagnosticsResult);
  if (!validatePostUpdateDiagnostics(diagnostics, packageVersion)) {
    return emitCommandFailure(
      { json, stdout, stderr, stage: 'post_update_diagnostics_failed', version: packageVersion },
      diagnosticsResult,
    );
  }

  const result = {
    schema: SELF_UPDATE_SCHEMA,
    status: beforeVersion === packageVersion ? 'already_current' : 'updated',
    beforeVersion,
    afterVersion: packageVersion,
    migrationStatus: migration.status,
    diagnosticsStatus: 'ready',
  };
  return emitSuccess({ json, stdout }, result);
}

export function run(argv = [], {
  stdout = process.stdout,
  stderr = process.stderr,
  env = process.env,
  runner = spawnPortableSync,
  packageVersion = PACKAGE_VERSION,
  nodePath = process.execPath,
  cliPath = DEFAULT_CLI_PATH,
  platform = process.platform,
  canonicalizePath = realpathSync,
} = {}) {
  let args;
  try {
    args = parseArgs(argv);
  } catch {
    return emitFailure({
      json: argv.includes('--json'), stdout, stderr, stage: 'invalid_request', version: packageVersion,
    }, 2);
  }

  if (env.THROUGHLINE_SELF_UPDATE_PHASE === POST_INSTALL_PHASE) {
    return finishUpdate({
      ...args, stdout, stderr, env, runner, packageVersion, nodePath, cliPath, platform,
    });
  }

  const update = npmResult(runner, ['install', '-g', 'throughline@latest'], env, platform);
  if (!succeeded(update)) {
    return emitFailure({ ...args, stdout, stderr, stage: 'package_update_failed', version: packageVersion });
  }

  const globalRootResult = npmResult(runner, ['root', '--global'], env, platform);
  const installedCliPath = resolveGlobalCliPath(globalRootResult, platform);
  if (installedCliPath === null) {
    return emitCommandFailure(
      { ...args, stdout, stderr, stage: 'global_cli_resolution_failed', version: packageVersion },
      globalRootResult,
    );
  }

  const installedVersionResult = commandResult(
    runner, nodePath, [installedCliPath, '--version'], env, platform,
  );
  const installedVersion = parseInstalledVersion(installedVersionResult);
  if (installedVersion === null) {
    return emitCommandFailure(
      { ...args, stdout, stderr, stage: 'installed_version_verification_failed', version: packageVersion },
      installedVersionResult,
    );
  }

  const identityResult = publicIdentityResult(runner, env, platform);
  const identity = parseJsonOutput(identityResult);
  if (!validateSelfUpdateIdentity(identity, {
    version: installedVersion,
    cliPath: installedCliPath,
    platform,
    canonicalizePath,
  })) {
    return emitCommandFailure(
      { ...args, stdout, stderr, stage: 'public_cli_mismatch', version: installedVersion },
      identityResult,
    );
  }

  const child = commandResult(runner, nodePath, [installedCliPath, 'self-update', '--json'], {
    ...env,
    THROUGHLINE_SELF_UPDATE_PHASE: POST_INSTALL_PHASE,
    THROUGHLINE_SELF_UPDATE_BEFORE_VERSION: packageVersion,
    THROUGHLINE_SELF_UPDATE_EXPECTED_VERSION: installedVersion,
  }, platform);
  writeChildStderr(stderr, child);
  const childPayload = parseJsonOutput(child, { requireSuccess: false });
  if (succeeded(child) && validatePostInstallResult(childPayload, {
    beforeVersion: packageVersion,
    afterVersion: installedVersion,
  })) {
    return emitSuccess(args.json ? { json: true, stdout } : { json: false, stdout }, childPayload);
  }
  if (!succeeded(child) && validatePostInstallFailure(childPayload, installedVersion)) {
    if (args.json) stdout.write(`${JSON.stringify(childPayload)}\n`);
    else stderr.write(`[throughline self-update] failed: ${childPayload.stage}\n`);
    return Number.isInteger(child.status) && child.status > 0 ? child.status : 1;
  }
  return emitFailure({
    ...args,
    stdout,
    stderr,
    stage: 'post_install_protocol_failed',
    version: installedVersion,
  });
}
