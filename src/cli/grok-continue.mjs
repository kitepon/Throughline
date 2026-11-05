import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';

import { readHandoffContext, readSessionProjectPath } from './handoff-context.mjs';
import { shQuote } from '../os/shell.mjs';
import { appleScriptForTerminalExec, runTerminalScriptDetached } from '../os/macos-terminal.mjs';

export const GROK_CONTINUE_PREAMBLE = 'この発言は直前 Throughline 席の履歴を前提とする。';
export const GROK_CONTINUE_REQUEST = '直前の作業の自然な続きとして応答すること。';
export const GROK_CONTINUE_WAIT = 'この後ユーザーが指示を出す。何もせず待機すること。';

export function parseArgs(argv = []) {
  if (
    argv.length !== 2
    || argv[0] !== '--session'
    || typeof argv[1] !== 'string'
    || argv[1].length === 0
  ) {
    throw new TypeError('usage error');
  }
  return { sessionId: argv[1] };
}

export function buildGrokContinuePrompt(context) {
  if (typeof context !== 'string' || context.length === 0) {
    throw new TypeError('empty context');
  }
  return `${GROK_CONTINUE_PREAMBLE}\n\n${context}\n\n${GROK_CONTINUE_REQUEST}\n\n${GROK_CONTINUE_WAIT}`;
}

export function resolveGrokBin({
  home = homedir(),
  env = process.env,
  exists = existsSync,
} = {}) {
  const homeBin = join(home, '.grok', 'bin', 'grok');
  if (exists(homeBin)) return homeBin;
  for (const dir of String(env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, 'grok');
    if (exists(candidate)) return candidate;
  }
  return null;
}

export function buildGrokArgv(grokBin, sessionUuid, prompt) {
  return [grokBin, '--session-id', sessionUuid, prompt];
}

export function buildLaunchScript({ cwd, grokBin, sessionUuid, promptFile }) {
  return [
    '#!/bin/sh',
    'set -e',
    `artifact_dir=${shQuote(dirname(promptFile))}`,
    'cleanup() { rm -f -- "$artifact_dir/prompt.txt" "$artifact_dir/launch.sh"; rmdir -- "$artifact_dir"; }',
    'trap cleanup 0',
    `prompt=$(cat ${shQuote(promptFile)})`,
    'cleanup',
    'trap - 0',
    `cd ${shQuote(cwd)}`,
    `exec ${shQuote(grokBin)} --session-id ${shQuote(sessionUuid)} "$prompt"`,
    '',
  ].join('\n');
}

// macOS Terminal 起動の実体は os/macos-terminal.mjs (OS 境界)。
export const appleScriptForLaunch = appleScriptForTerminalExec;

export function buildContinuePlan({
  context,
  grokBin,
  cwd,
  sessionUuid,
}) {
  const prompt = buildGrokContinuePrompt(context);
  const grokArgv = buildGrokArgv(grokBin, sessionUuid, prompt);
  if (grokArgv.includes('--rules')) {
    throw new Error('grok-continue must not pass --rules');
  }
  return {
    prompt,
    grokArgv,
    cwd,
    sessionUuid,
    throughlineSessionId: `grok:${sessionUuid}`,
  };
}

export function writeLaunchArtifacts({
  cwd,
  grokBin,
  sessionUuid,
  prompt,
  tmp = tmpdir(),
}) {
  // A Terminal request may be accepted without ever running its script.
  for (const entry of readdirSync(tmp, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^tl-grok-continue-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(entry.name)) continue;
    try {
      const old = join(tmp, entry.name), stat = lstatSync(old);
      if (Date.now() - stat.mtimeMs <= 24 * 60 * 60 * 1000 ||
          (process.getuid && stat.uid !== process.getuid())) continue;
      const names = readdirSync(old).sort();
      if (names.join(',') !== 'launch.sh,prompt.txt' || names.some(name => !lstatSync(join(old, name)).isFile())) continue;
      const script = readFileSync(join(old, 'launch.sh'), 'utf8');
      if (script.startsWith('#!/bin/sh\nset -e\n') && script.includes(`--session-id '${entry.name.slice(17)}'`)) {
        rmSync(old, { recursive: true });
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(sessionUuid)) throw new Error('invalid_session_uuid');
  const dir = join(tmp, `tl-grok-continue-${sessionUuid}`);
  mkdirSync(dir, { mode: 0o700 });
  const promptFile = join(dir, 'prompt.txt');
  const launchFile = join(dir, 'launch.sh');
  try {
    writeFileSync(promptFile, prompt, { mode: 0o600, flag: 'wx' });
    writeFileSync(launchFile, buildLaunchScript({ cwd, grokBin, sessionUuid, promptFile }), { mode: 0o700, flag: 'wx' });
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  return { promptFile, launchFile };
}

export function defaultSpawnLaunch({ launchFile, spawnImpl }) {
  return spawnImpl === undefined
    ? runTerminalScriptDetached({ launchFile })
    : runTerminalScriptDetached({ launchFile, spawnImpl });
}

export function run(argv = [], {
  stdout = process.stdout,
  stderr = process.stderr,
  readContext = readHandoffContext,
  readProjectPath = readSessionProjectPath,
  resolveBin = resolveGrokBin,
  createSessionId = randomUUID,
  platform = process.platform,
  spawnLaunch = defaultSpawnLaunch,
} = {}) {
  let sessionId;
  try {
    ({ sessionId } = parseArgs(argv));
  } catch {
    stderr.write('Usage: throughline grok-continue --session <id>\n');
    return 2;
  }

  let context;
  try {
    context = readContext(sessionId);
  } catch {
    stderr.write('Throughline handoff context could not be read.\n');
    return 1;
  }
  if (!context) {
    stderr.write('Throughline handoff context is not available for that session.\n');
    return 1;
  }

  let cwd;
  try {
    cwd = readProjectPath(sessionId);
  } catch {
    stderr.write('Throughline session project path could not be read.\n');
    return 1;
  }
  if (!cwd) {
    stderr.write('Throughline session project path is not available for that session.\n');
    return 1;
  }
  if (!existsSync(cwd)) {
    stderr.write('Throughline session project path does not exist.\n');
    return 1;
  }

  const grokBin = resolveBin();
  if (!grokBin) {
    stderr.write('grok binary was not found.\n');
    return 1;
  }
  if (platform !== 'darwin') {
    stderr.write('throughline grok-continue requires macOS Terminal.\n');
    return 1;
  }

  const sessionUuid = createSessionId();
  const plan = buildContinuePlan({
    context,
    grokBin,
    cwd,
    sessionUuid,
  });
  const { launchFile } = writeLaunchArtifacts({
    cwd: plan.cwd,
    grokBin,
    sessionUuid: plan.sessionUuid,
    prompt: plan.prompt,
  });
  try {
    const child = spawnLaunch({ launchFile, grokArgv: plan.grokArgv, cwd: plan.cwd });
    child?.once?.('error', (error) => {
      rmSync(dirname(launchFile), { recursive: true, force: true });
      stderr.write(`Throughline Grok launch failed: ${error.message}\n`);
      process.exitCode = 1;
    });
  } catch (error) {
    rmSync(dirname(launchFile), { recursive: true, force: true });
    stderr.write(`Throughline Grok launch failed: ${error.message}\n`);
    return 1;
  }
  stdout.write(`${plan.throughlineSessionId}\n`);
  return 0;
}
