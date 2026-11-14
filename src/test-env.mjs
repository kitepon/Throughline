export const DATA_ROOT_ENV = ['THROUGHLINE_HOME', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR'];

// Keep tests hermetic when they are run from inside a live Codex session.
// Individual tests that need these values set them explicitly in child env.
if (process.env.THROUGHLINE_TEST_ENV_ACTIVE !== '1') {
  delete process.env.THROUGHLINE_CODEX_THREAD_ID;
  delete process.env.CODEX_THREAD_ID;
  // Data roots: a seat's THROUGHLINE_HOME (or XDG/Codex/Claude dirs) would point tests that only swap HOME
  // at the live DB and config; a 2026-11-14 run wrote user_version 99 into a production DB this way.
  for (const key of DATA_ROOT_ENV) delete process.env[key];
  process.env.THROUGHLINE_TEST_ENV_ACTIVE = '1';
}

// node:sqlite emits an ExperimentalWarning on Node 22.  Several CLI tests
// intentionally assert their child process stderr contract, so suppress the
// runtime warning for test children without changing production stderr.
process.env.NODE_NO_WARNINGS = '1';

// Windows cannot execute the POSIX shebang used by the ephemeral fake Codex
// app-server fixtures.  Run their .mjs bodies with this test runner's Node
// executable, preserving the command arguments the production code sends.
import childProcess from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { basename, dirname, extname, join } from 'node:path';

const { spawn: nativeSpawn, spawnSync: nativeSpawnSync } = childProcess;

function normalizeNodeFixture(command, args = []) {
  if (process.platform !== 'win32' || typeof command !== 'string' || !Array.isArray(args)) {
    return [command, args];
  }
  if (command.endsWith('.mjs')) return [process.execPath, [command, ...args]];
  const extension = extname(command).toLowerCase();
  if (extension === '.cmd' || extension === '.bat') {
    const sibling = join(dirname(command), `${basename(command, extension)}.ps1`);
    if (existsSync(sibling)) {
      return ['pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', sibling, ...args]];
    }
  }
  if (extension === '.ps1') {
    return ['pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', command, ...args]];
  }
  try {
    const header = readFileSync(command, 'utf8').slice(0, 128);
    if (/^#!.*\bnode(?:\.exe)?\b/.test(header)) return [process.execPath, [command, ...args]];
    if (/^#!.*\b(?:ba)?sh\b/.test(header)) return ['bash', [command, ...args]];
  } catch {
    // Missing/non-file commands must retain their native spawn error contract.
  }
  return [command, args];
}

childProcess.spawn = function spawn(command, args, options) {
  const [normalizedCommand, normalizedArgs] = normalizeNodeFixture(command, args);
  return nativeSpawn(normalizedCommand, normalizedArgs, options);
};

childProcess.spawnSync = function spawnSync(command, args, options) {
  const [normalizedCommand, normalizedArgs] = normalizeNodeFixture(command, args);
  return nativeSpawnSync(normalizedCommand, normalizedArgs, {
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
};

syncBuiltinESMExports();

// CLI tests start nested Node processes which in turn launch the fixture
// executable.  Carry this test-only adapter into those children on Windows.
if (process.platform === 'win32') {
  const importOption = `--import=${import.meta.url}`;
  const current = process.env.NODE_OPTIONS?.trim() ?? '';
  if (!current.includes(importOption)) {
    process.env.NODE_OPTIONS = current ? `${current} ${importOption}` : importOption;
  }
}
