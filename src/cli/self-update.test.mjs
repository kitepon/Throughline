import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  SELF_UPDATE_IDENTITY_SCHEMA,
  SELF_UPDATE_SCHEMA,
  parseArgs,
  resolveGlobalCliPath,
  run,
  validateMigrationResult,
  validatePostInstallResult,
  validatePostUpdateDiagnostics,
  validateSelfUpdateIdentity,
} from './self-update.mjs';

function sink() {
  const values = [];
  return { values, write(value) { values.push(value); } };
}

function ok(stdout = '') {
  return { status: 0, stdout, stderr: '' };
}

function migration(status = 'already_current') {
  return {
    schema: 'throughline.database_migration.v1',
    status,
    beforeSchemaVersion: status === 'not_applicable' ? null : 9,
    afterSchemaVersion: status === 'not_applicable' ? null : 9,
    supportedSchemaVersion: 9,
  };
}

function readyDiagnostics(version = '0.10.5') {
  return {
    schema: 'throughline.native_factory_diagnostics.v1',
    version,
    overall: { status: 'ready' },
    databaseSchema: {
      status: 'ready',
      databaseSchemaVersion: 9,
      supportedDatabaseSchemaVersion: 9,
    },
    hooks: {
      status: 'ready',
      events: { userPromptSubmit: 'ready', postToolUse: 'ready', stop: 'ready' },
    },
    readiness: {
      capture: { status: 'not_applicable' },
      restore: { status: 'ready' },
      handoff: { status: 'not_applicable' },
    },
  };
}

function updateSuccess(beforeVersion = '0.10.4', afterVersion = '0.10.5') {
  return {
    schema: SELF_UPDATE_SCHEMA,
    status: beforeVersion === afterVersion ? 'already_current' : 'updated',
    beforeVersion,
    afterVersion,
    migrationStatus: 'already_current',
    diagnosticsStatus: 'ready',
  };
}

function updateIdentity(cliPath, version = '0.10.5') {
  return { schema: SELF_UPDATE_IDENTITY_SCHEMA, version, cliPath };
}

const fakeCanonicalizePath = (path) => path;

test('CLI identity handshake reports the executing package path and version', () => {
  const binPath = fileURLToPath(new URL('../../bin/throughline.mjs', import.meta.url));
  const packageVersion = JSON.parse(
    readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
  ).version;
  const result = spawnSync(process.execPath, [binPath, '--self-update-identity'], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(validateSelfUpdateIdentity(JSON.parse(result.stdout), {
    version: packageVersion,
    cliPath: binPath,
    canonicalizePath: realpathSync,
  }), true);
});

test('self-update delegates post-install work to the newly installed CLI', () => {
  const calls = [];
  const stdout = sink();
  const runner = (command, args, options) => {
    calls.push({ command, args, env: options.env });
    const key = [command, ...args].join(' ');
    if (key === 'npm install -g throughline@latest') return ok('installed');
    if (key === 'npm root --global') return ok('/global/lib/node_modules\n');
    if (key === '/node /global/lib/node_modules/throughline/bin/throughline.mjs --version') {
      return ok('0.10.5\n');
    }
    if (key === 'throughline --self-update-identity') {
      return ok(`${JSON.stringify(updateIdentity(
        '/global/lib/node_modules/throughline/bin/throughline.mjs',
      ))}\n`);
    }
    if (key === '/node /global/lib/node_modules/throughline/bin/throughline.mjs self-update --json') {
      return ok(`${JSON.stringify(updateSuccess())}\n`);
    }
    throw new Error(`unexpected command: ${key}`);
  };

  assert.equal(run(['--json'], {
    stdout,
    stderr: sink(),
    env: { PATH: '/fixture/bin' },
    runner,
    packageVersion: '0.10.4',
    platform: 'linux',
    nodePath: '/node',
    cliPath: '/old-throughline.mjs',
    canonicalizePath: fakeCanonicalizePath,
  }), 0);
  assert.deepEqual(calls.map(({ command, args }) => [command, ...args]), [
    ['npm', 'install', '-g', 'throughline@latest'],
    ['npm', 'root', '--global'],
    ['/node', '/global/lib/node_modules/throughline/bin/throughline.mjs', '--version'],
    ['throughline', '--self-update-identity'],
    ['/node', '/global/lib/node_modules/throughline/bin/throughline.mjs', 'self-update', '--json'],
  ]);
  assert.equal(calls[4].env.THROUGHLINE_SELF_UPDATE_PHASE, 'post-install');
  assert.equal(calls[4].env.THROUGHLINE_SELF_UPDATE_BEFORE_VERSION, '0.10.4');
  assert.equal(calls[4].env.THROUGHLINE_SELF_UPDATE_EXPECTED_VERSION, '0.10.5');
  assert.match(stdout.values.join(''), /"status":"updated"/u);
});

test('new CLI completes install, migration, and diagnostics in order', () => {
  const calls = [];
  const stdout = sink();
  const runner = (command, args) => {
    calls.push([command, ...args]);
    const key = [command, ...args].join(' ');
    if (key === 'npm view throughline version --json') return ok('"0.10.5"\n');
    if (key.endsWith(' install')) return ok();
    if (key.endsWith(' migrate --json')) return ok(`${JSON.stringify(migration())}\n`);
    if (key.endsWith(' factory-diagnostics --json')) {
      return ok(`${JSON.stringify(readyDiagnostics())}\n`);
    }
    throw new Error(`unexpected command: ${key}`);
  };

  assert.equal(run(['--json'], {
    stdout,
    stderr: sink(),
    env: {
      THROUGHLINE_SELF_UPDATE_PHASE: 'post-install',
      THROUGHLINE_SELF_UPDATE_BEFORE_VERSION: '0.10.4',
      THROUGHLINE_SELF_UPDATE_EXPECTED_VERSION: '0.10.5',
    },
    runner,
    packageVersion: '0.10.5',
    platform: 'linux',
    nodePath: '/node',
    cliPath: '/throughline.mjs',
  }), 0);
  assert.deepEqual(calls, [
    ['npm', 'view', 'throughline', 'version', '--json'],
    ['/node', '/throughline.mjs', 'install'],
    ['/node', '/throughline.mjs', 'migrate', '--json'],
    ['/node', '/throughline.mjs', 'factory-diagnostics', '--json'],
  ]);
  assert.deepEqual(JSON.parse(stdout.values.join('')), {
    schema: SELF_UPDATE_SCHEMA,
    status: 'updated',
    beforeVersion: '0.10.4',
    afterVersion: '0.10.5',
    migrationStatus: 'already_current',
    diagnosticsStatus: 'ready',
  });
});

test('自己更新はnpmの単一版を文字列と単一要素配列から読み取る', () => {
  for (const platform of ['darwin', 'linux', 'win32']) {
    for (const registryVersion of ['0.10.16', ['0.10.16']]) {
      const stdout = sink();
      const calls = [];
      const runner = (command, args) => {
        calls.push([command, ...args]);
        if (command === 'npm' || command === 'pwsh.exe') return ok(JSON.stringify(registryVersion));
        if (args.at(-1) === 'install') return ok();
        if (args.at(-2) === 'migrate') return ok(JSON.stringify(migration()));
        if (args.at(-2) === 'factory-diagnostics') return ok(JSON.stringify(readyDiagnostics('0.10.16')));
        throw new Error('想定外の更新工程');
      };
      assert.equal(run(['--json'], {
        stdout, stderr: sink(), runner, platform, packageVersion: '0.10.16',
        nodePath: '/node', cliPath: '/throughline.mjs',
        env: {
          THROUGHLINE_SELF_UPDATE_PHASE: 'post-install',
          THROUGHLINE_SELF_UPDATE_BEFORE_VERSION: '0.10.15',
          THROUGHLINE_SELF_UPDATE_EXPECTED_VERSION: '0.10.16',
        },
      }), 0, `${platform}: ${JSON.stringify(registryVersion)}`);
      assert.equal(calls.length, 4);
      assert.deepEqual(JSON.parse(stdout.values.join('')), updateSuccess('0.10.15', '0.10.16'));
    }
  }
});

test('自己更新は複数版・空配列・不正な版情報で後続工程を始めない', () => {
  for (const value of [[], ['0.10.16', '0.10.17'], [['0.10.16']], [null], [{ version: '0.10.16' }], ['invalid']]) {
    const stdout = sink();
    let calls = 0;
    assert.equal(run(['--json'], {
      stdout, stderr: sink(), packageVersion: '0.10.16', platform: 'darwin',
      runner: () => { calls += 1; return ok(JSON.stringify(value)); },
      env: {
        THROUGHLINE_SELF_UPDATE_PHASE: 'post-install',
        THROUGHLINE_SELF_UPDATE_BEFORE_VERSION: '0.10.15',
        THROUGHLINE_SELF_UPDATE_EXPECTED_VERSION: '0.10.16',
      },
    }), 1);
    assert.equal(calls, 1);
    assert.equal(JSON.parse(stdout.values.join('')).stage, 'version_verification_failed');
  }
});

test('self-update fails closed without reflecting command output', () => {
  const stdout = sink();
  const stderr = sink();
  assert.equal(run(['--json'], {
    stdout,
    stderr,
    runner: () => ({ status: 1, stdout: '', stderr: '/Users/private/token' }),
    packageVersion: '0.10.4',
  }), 1);
  assert.deepEqual(JSON.parse(stdout.values.join('')), {
    schema: SELF_UPDATE_SCHEMA,
    status: 'failed',
    stage: 'package_update_failed',
    version: '0.10.4',
  });
  assert.doesNotMatch(stdout.values.join('') + stderr.values.join(''), /private|token/u);
});

test('post-install refuses invalid migration and not-ready diagnostics', () => {
  const base = migration();
  assert.equal(validateMigrationResult(base), true);
  assert.equal(validateMigrationResult({ ...base, beforeSchemaVersion: 8 }), false);
  assert.equal(validatePostUpdateDiagnostics(readyDiagnostics(), '0.10.5'), true);
  for (const status of [undefined, 'unverified', 'not_ready']) {
    const diagnostics = readyDiagnostics();
    diagnostics.overall = status === undefined ? undefined : { status };
    assert.equal(validatePostUpdateDiagnostics(diagnostics, '0.10.5'), false);
  }
  assert.equal(validatePostUpdateDiagnostics({
    ...readyDiagnostics(),
    databaseSchema: { status: 'ready', databaseSchemaVersion: 8, supportedDatabaseSchemaVersion: 9 },
  }, '0.10.5'), false);
  assert.equal(validatePostUpdateDiagnostics({
    ...readyDiagnostics(),
    readiness: { ...readyDiagnostics().readiness, handoff: { status: 'unverified' } },
  }, '0.10.5'), false);
});

test('post-install success handshake rejects help text, missing fields, and version drift', () => {
  assert.equal(validatePostInstallResult(updateSuccess(), {
    beforeVersion: '0.10.4',
    afterVersion: '0.10.5',
  }), true);
  assert.equal(validatePostInstallResult('throughline v0.10.4\nUsage:', {
    beforeVersion: '0.10.4',
    afterVersion: '0.10.5',
  }), false);
  assert.equal(validatePostInstallResult({ ...updateSuccess(), diagnosticsStatus: undefined }, {
    beforeVersion: '0.10.4',
    afterVersion: '0.10.5',
  }), false);
  assert.equal(validatePostInstallResult({ ...updateSuccess(), afterVersion: '0.10.4' }, {
    beforeVersion: '0.10.4',
    afterVersion: '0.10.5',
  }), false);
});

test('old CLI help with exit 0 cannot satisfy the post-install protocol', () => {
  const stdout = sink();
  const runner = (command, args) => {
    const key = [command, ...args].join(' ');
    if (key === 'npm install -g throughline@latest') return ok();
    if (key === 'npm root --global') return ok('/global/lib/node_modules\n');
    if (key.endsWith(' --version')) return ok('0.10.5\n');
    if (key === 'throughline --self-update-identity') {
      return ok(`${JSON.stringify(updateIdentity(
        '/global/lib/node_modules/throughline/bin/throughline.mjs',
      ))}\n`);
    }
    if (key.endsWith(' self-update --json')) return ok('throughline v0.10.4\n\nUsage:\n');
    throw new Error(`unexpected command: ${key}`);
  };

  assert.equal(run(['--json'], {
    stdout,
    stderr: sink(),
    runner,
    packageVersion: '0.10.4',
    platform: 'linux',
    nodePath: '/node',
    canonicalizePath: fakeCanonicalizePath,
  }), 1);
  assert.deepEqual(JSON.parse(stdout.values.join('')), {
    schema: SELF_UPDATE_SCHEMA,
    status: 'failed',
    stage: 'post_install_protocol_failed',
    version: '0.10.5',
  });
  assert.doesNotMatch(stdout.values.join(''), /Usage/u);
});

test('post-install non-JSON failure preserves child stderr as the cause', () => {
  const stdout = sink();
  const stderr = sink();
  const runner = (command, args) => {
    const key = [command, ...args].join(' ');
    if (key === 'npm install -g throughline@latest') return ok();
    if (key === 'npm root --global') return ok('/global/lib/node_modules\n');
    if (key.endsWith(' --version')) return ok('0.10.5\n');
    if (key === 'throughline --self-update-identity') {
      return ok(`${JSON.stringify(updateIdentity(
        '/global/lib/node_modules/throughline/bin/throughline.mjs',
      ))}\n`);
    }
    if (key.endsWith(' self-update --json')) {
      return { status: 7, stdout: '', stderr: 'migration command failed\n' };
    }
    throw new Error(`unexpected command: ${key}`);
  };

  assert.equal(run(['--json'], {
    stdout,
    stderr,
    runner,
    packageVersion: '0.10.4',
    platform: 'linux',
    nodePath: '/node',
    canonicalizePath: fakeCanonicalizePath,
  }), 1);
  assert.match(stderr.values.join(''), /migration command failed/u);
  assert.equal(JSON.parse(stdout.values.join('')).stage, 'post_install_protocol_failed');
});

test('post-install structured failure preserves its stage and stderr', () => {
  const stdout = sink();
  const stderr = sink();
  const failure = {
    schema: SELF_UPDATE_SCHEMA,
    status: 'failed',
    stage: 'database_migration_failed',
    version: '0.10.5',
  };
  const runner = (command, args) => {
    const key = [command, ...args].join(' ');
    if (key === 'npm install -g throughline@latest') return ok();
    if (key === 'npm root --global') return ok('/global/lib/node_modules\n');
    if (key.endsWith(' --version')) return ok('0.10.5\n');
    if (key === 'throughline --self-update-identity') {
      return ok(`${JSON.stringify(updateIdentity(
        '/global/lib/node_modules/throughline/bin/throughline.mjs',
      ))}\n`);
    }
    if (key.endsWith(' self-update --json')) {
      return { status: 7, stdout: `${JSON.stringify(failure)}\n`, stderr: 'database is locked\n' };
    }
    throw new Error(`unexpected command: ${key}`);
  };

  assert.equal(run(['--json'], {
    stdout,
    stderr,
    runner,
    packageVersion: '0.10.4',
    platform: 'linux',
    nodePath: '/node',
    canonicalizePath: fakeCanonicalizePath,
  }), 7);
  assert.deepEqual(JSON.parse(stdout.values.join('')), failure);
  assert.match(stderr.values.join(''), /database is locked/u);
});

test('global CLI path is derived from the npm global root on Unix and Windows', () => {
  assert.equal(
    resolveGlobalCliPath(ok('/opt/npm/lib/node_modules\n'), 'linux'),
    '/opt/npm/lib/node_modules/throughline/bin/throughline.mjs',
  );
  assert.equal(
    resolveGlobalCliPath(ok('C:\\Users\\kite\\AppData\\Roaming\\npm\\node_modules\r\n'), 'win32'),
    'C:\\Users\\kite\\AppData\\Roaming\\npm\\node_modules\\throughline\\bin\\throughline.mjs',
  );
  assert.equal(resolveGlobalCliPath(ok('relative/node_modules\n'), 'linux'), null);
  assert.equal(resolveGlobalCliPath(ok('/one\n/two\n'), 'linux'), null);
});

test('public CLI identity must match both the installed version and target path', () => {
  assert.equal(validateSelfUpdateIdentity(updateIdentity('/prefix/bin/throughline.mjs'), {
    version: '0.10.5',
    cliPath: '/prefix/bin/throughline.mjs',
    platform: 'linux',
    canonicalizePath: fakeCanonicalizePath,
  }), true);
  assert.equal(validateSelfUpdateIdentity(updateIdentity('/prefix-a/bin/throughline.mjs'), {
    version: '0.10.5',
    cliPath: '/prefix-b/bin/throughline.mjs',
    platform: 'linux',
    canonicalizePath: fakeCanonicalizePath,
  }), false);
  assert.equal(validateSelfUpdateIdentity(updateIdentity('/prefix/bin/throughline.mjs', '0.10.4'), {
    version: '0.10.5',
    cliPath: '/prefix/bin/throughline.mjs',
    platform: 'linux',
    canonicalizePath: fakeCanonicalizePath,
  }), false);
});

test('Unix fails closed when PATH still resolves a different global prefix', () => {
  const stdout = sink();
  let childStarted = false;
  const runner = (command, args) => {
    const key = [command, ...args].join(' ');
    if (key === 'npm install -g throughline@latest') return ok();
    if (key === 'npm root --global') return ok('/prefix-b/lib/node_modules\n');
    if (key === '/node /prefix-b/lib/node_modules/throughline/bin/throughline.mjs --version') {
      return ok('0.10.5\n');
    }
    if (key === 'throughline --self-update-identity') {
      return ok(`${JSON.stringify(updateIdentity(
        '/prefix-a/lib/node_modules/throughline/bin/throughline.mjs',
      ))}\n`);
    }
    if (key.endsWith(' self-update --json')) childStarted = true;
    throw new Error(`unexpected command: ${key}`);
  };

  assert.equal(run(['--json'], {
    stdout,
    stderr: sink(),
    runner,
    packageVersion: '0.10.4',
    nodePath: '/node',
    platform: 'linux',
    canonicalizePath: fakeCanonicalizePath,
  }), 1);
  assert.equal(JSON.parse(stdout.values.join('')).stage, 'public_cli_mismatch');
  assert.equal(childStarted, false);
});

test('Windows self-update uses pwsh and the official npm.cmd entry', () => {
  const calls = [];
  const runner = (command, args, options) => {
    calls.push({ command, args, env: options.env });
    if (command === 'pwsh.exe') {
      if (args[4].includes("'npm.cmd' 'install' '-g' 'throughline@latest'")) return ok();
      if (args[4].includes("'npm.cmd' 'root' '--global'")) {
        return ok('C:\\Users\\kite\\AppData\\Roaming\\npm\\node_modules\r\n');
      }
      if (args[4].includes("'throughline.cmd' '--self-update-identity'")) {
        return ok(`${JSON.stringify(updateIdentity(
          'C:\\Users\\kite\\AppData\\Roaming\\npm\\node_modules\\throughline\\bin\\throughline.mjs',
        ))}\r\n`);
      }
    }
    if (command === 'C:\\Program Files\\nodejs\\node.exe' && args.at(-1) === '--version') {
      return ok('0.10.5\r\n');
    }
    if (command === 'C:\\Program Files\\nodejs\\node.exe' && args.at(-2) === 'self-update') {
      return ok(`${JSON.stringify(updateSuccess())}\r\n`);
    }
    throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
  };

  assert.equal(run(['--json'], {
    stdout: sink(),
    stderr: sink(),
    env: { Path: 'C:\\Program Files\\nodejs' },
    runner,
    packageVersion: '0.10.4',
    nodePath: 'C:\\Program Files\\nodejs\\node.exe',
    platform: 'win32',
    canonicalizePath: fakeCanonicalizePath,
  }), 0);
  assert.equal(calls.filter(({ command }) => command === 'pwsh.exe').length, 3);
  assert.equal(calls.filter(({ command, args }) =>
    command === 'pwsh.exe' && args[4].includes('npm.cmd')).length, 2);
  assert.equal(calls.filter(({ command, args }) =>
    command === 'pwsh.exe' && args[4].includes('throughline.cmd')).length, 1);
  assert.ok(calls.every(({ command }) => command !== 'powershell.exe' && command !== 'npm'));
  assert.deepEqual(calls.at(-1).args.slice(0, 2), [
    'C:\\Users\\kite\\AppData\\Roaming\\npm\\node_modules\\throughline\\bin\\throughline.mjs',
    'self-update',
  ]);
});

test('Windows fails closed when PATH still resolves a different global prefix', () => {
  const stdout = sink();
  let childStarted = false;
  const runner = (command, args) => {
    if (command === 'pwsh.exe') {
      if (args[4].includes("'npm.cmd' 'install' '-g' 'throughline@latest'")) return ok();
      if (args[4].includes("'npm.cmd' 'root' '--global'")) {
        return ok('C:\\prefix-b\\node_modules\r\n');
      }
      if (args[4].includes("'throughline.cmd' '--self-update-identity'")) {
        return ok(`${JSON.stringify(updateIdentity(
          'C:\\prefix-a\\node_modules\\throughline\\bin\\throughline.mjs',
        ))}\r\n`);
      }
    }
    if (command === 'C:\\node\\node.exe' && args.at(-1) === '--version') {
      return ok('0.10.5\r\n');
    }
    if (args.at(-2) === 'self-update') childStarted = true;
    throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
  };

  assert.equal(run(['--json'], {
    stdout,
    stderr: sink(),
    env: { Path: 'C:\\prefix-a;C:\\prefix-b' },
    runner,
    packageVersion: '0.10.4',
    nodePath: 'C:\\node\\node.exe',
    platform: 'win32',
    canonicalizePath: fakeCanonicalizePath,
  }), 1);
  assert.equal(JSON.parse(stdout.values.join('')).stage, 'public_cli_mismatch');
  assert.equal(childStarted, false);
});

test('Windows post-install registry check also uses pwsh with npm.cmd', () => {
  const calls = [];
  const runner = (command, args) => {
    calls.push([command, ...args]);
    if (command === 'pwsh.exe') return ok('"0.10.5"\r\n');
    const key = [command, ...args].join(' ');
    if (key.endsWith(' install')) return ok();
    if (key.endsWith(' migrate --json')) return ok(`${JSON.stringify(migration())}\n`);
    if (key.endsWith(' factory-diagnostics --json')) {
      return ok(`${JSON.stringify(readyDiagnostics())}\n`);
    }
    throw new Error(`unexpected command: ${key}`);
  };

  assert.equal(run(['--json'], {
    stdout: sink(),
    stderr: sink(),
    env: {
      THROUGHLINE_SELF_UPDATE_PHASE: 'post-install',
      THROUGHLINE_SELF_UPDATE_BEFORE_VERSION: '0.10.4',
      THROUGHLINE_SELF_UPDATE_EXPECTED_VERSION: '0.10.5',
    },
    runner,
    packageVersion: '0.10.5',
    nodePath: 'C:\\Program Files\\nodejs\\node.exe',
    cliPath: 'C:\\npm\\node_modules\\throughline\\bin\\throughline.mjs',
    platform: 'win32',
  }), 0);
  assert.equal(calls[0][0], 'pwsh.exe');
  assert.match(calls[0][5], /npm\.cmd/u);
  assert.ok(calls.every(([command]) => command !== 'powershell.exe'));
});

test('self-update accepts only the public default and JSON forms', () => {
  assert.deepEqual(parseArgs([]), { json: false });
  assert.deepEqual(parseArgs(['--json']), { json: true });
  assert.throws(() => parseArgs(['--force']), /usage error/u);
});
