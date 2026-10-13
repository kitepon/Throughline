import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  GROK_CONTINUE_PREAMBLE,
  GROK_CONTINUE_REQUEST,
  GROK_CONTINUE_WAIT,
  appleScriptForLaunch,
  buildContinuePlan,
  buildGrokArgv,
  buildGrokContinuePrompt,
  buildLaunchScript,
  parseArgs,
  resolveGrokBin,
  run,
} from './grok-continue.mjs';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const BIN_PATH = join(REPO_ROOT, 'bin/throughline.mjs');
const CONTEXT = '固有事実：琥珀の合言葉は 9f3c2a。';

function capture() {
  let out = '';
  let err = '';
  return {
    stdout: { write(chunk) { out += chunk; return true; } },
    stderr: { write(chunk) { err += chunk; return true; } },
    get out() { return out; },
    get err() { return err; },
  };
}

test('parseArgs accepts --session only', () => {
  assert.deepEqual(parseArgs(['--session', 'grok:abc']), { sessionId: 'grok:abc' });
  assert.throws(() => parseArgs(['--from', 'grok:abc']), /usage error/);
  assert.throws(() => parseArgs(['--session']), /usage error/);
  assert.throws(() => parseArgs([]), /usage error/);
});

test('first-user prompt is the locked text ending in wait', () => {
  const prompt = buildGrokContinuePrompt(CONTEXT);
  assert.equal(
    prompt,
    `${GROK_CONTINUE_PREAMBLE}\n\n${CONTEXT}\n\n${GROK_CONTINUE_REQUEST}\n\n${GROK_CONTINUE_WAIT}`,
  );
});

test('grok argv is interactive grok with session id and no --rules', () => {
  const argv = buildGrokArgv('/opt/grok/bin/grok', '11111111-1111-4111-8111-111111111111', CONTEXT);
  assert.deepEqual(argv, [
    '/opt/grok/bin/grok',
    '--session-id',
    '11111111-1111-4111-8111-111111111111',
    CONTEXT,
  ]);
  assert.equal(argv.includes('--rules'), false);
  assert.equal(argv.some((part) => String(part).includes('aiterm')), false);
});

test('launch script execs grok in the project cwd without --rules or aiterm', () => {
  const script = buildLaunchScript({
    cwd: '/work/Throughline',
    grokBin: '/Users/kite/.grok/bin/grok',
    sessionUuid: '11111111-1111-4111-8111-111111111111',
    promptFile: '/tmp/prompt.txt',
  });
  assert.match(script, /^#!/);
  assert.match(script, /cd '\/work\/Throughline'/);
  assert.match(script, /exec '\/Users\/kite\/\.grok\/bin\/grok' --session-id/);
  assert.equal(script.includes('--rules'), false);
  assert.equal(script.includes('aiterm'), false);
  assert.equal(script.includes('tmux'), false);
  assert.equal(script.includes('subagent'), false);
});

test('macOS launch uses Terminal via osascript, not aiterm', () => {
  const apple = appleScriptForLaunch('/tmp/tl-grok-continue/launch.sh');
  assert.match(apple, /tell application "Terminal"/);
  assert.match(apple, /do script "exec "/);
  assert.equal(apple.includes('aiterm'), false);
});

test('resolveGrokBin prefers ~/.grok/bin/grok', () => {
  const home = '/tmp/tl-home';
  const found = resolveGrokBin({
    home,
    env: { PATH: '/usr/bin' },
    exists: (path) => path === join(home, '.grok', 'bin', 'grok'),
  });
  assert.equal(found, join(home, '.grok', 'bin', 'grok'));
});

test('handoff-context failure does not spawn grok', () => {
  const io = capture();
  const spawned = [];
  const code = run(['--session', 'grok:missing'], {
    ...io,
    readContext: () => null,
    readProjectPath: () => '/work/dotagents',
    resolveBin: () => '/tmp/grok',
    spawnLaunch: (plan) => { spawned.push(plan); },
    platform: 'darwin',
  });
  assert.equal(code, 1);
  assert.equal(spawned.length, 0);
  assert.match(io.err, /not available/);
});

test('handoff-context throw does not spawn grok', () => {
  const io = capture();
  const spawned = [];
  const code = run(['--session', 'grok:broken'], {
    ...io,
    readContext: () => { throw new Error('db'); },
    readProjectPath: () => REPO_ROOT,
    resolveBin: () => '/tmp/grok',
    spawnLaunch: (plan) => { spawned.push(plan); },
    platform: 'darwin',
  });
  assert.equal(code, 1);
  assert.equal(spawned.length, 0);
});

test('missing grok binary does not spawn', () => {
  const io = capture();
  const spawned = [];
  const code = run(['--session', 'grok:ok'], {
    ...io,
    readContext: () => CONTEXT,
    readProjectPath: () => REPO_ROOT,
    resolveBin: () => null,
    spawnLaunch: (plan) => { spawned.push(plan); },
    platform: 'darwin',
  });
  assert.equal(code, 1);
  assert.equal(spawned.length, 0);
});

test('successful continue spawn uses source project cwd and waits', (t) => {
  const io = capture();
  const spawned = [];
  const uuid = '22222222-2222-4222-8222-222222222222';
  const code = run(['--session', 'grok:source'], {
    ...io,
    readContext: (id) => {
      assert.equal(id, 'grok:source');
      return CONTEXT;
    },
    readProjectPath: (id) => {
      assert.equal(id, 'grok:source');
      return REPO_ROOT;
    },
    resolveBin: () => '/tmp/fake-grok',
    createSessionId: () => uuid,
    spawnLaunch: (plan) => { spawned.push(plan); },
    platform: 'darwin',
  });
  assert.equal(code, 0);
  assert.equal(spawned.length, 1);
  assert.equal(io.out, `grok:${uuid}\n`);
  const { grokArgv, launchFile, cwd } = spawned[0];
  t.after(() => rmSync(dirname(launchFile), { recursive: true, force: true }));
  assert.equal(cwd, REPO_ROOT);
  assert.equal(grokArgv.includes('--rules'), false);
  assert.ok(grokArgv.at(-1).includes(CONTEXT));
  assert.ok(grokArgv.at(-1).startsWith(GROK_CONTINUE_PREAMBLE));
  assert.ok(grokArgv.at(-1).endsWith(GROK_CONTINUE_WAIT));
  assert.equal(grokArgv[0], '/tmp/fake-grok');
  assert.equal(grokArgv[1], '--session-id');
  assert.match(readFileSync(launchFile, 'utf8'), /cd '/);
  assert.match(appleScriptForLaunch(launchFile), /Terminal/);
});

test('missing source project path does not spawn', () => {
  const io = capture();
  const spawned = [];
  const code = run(['--session', 'grok:source'], {
    ...io,
    readContext: () => CONTEXT,
    readProjectPath: () => null,
    resolveBin: () => '/tmp/grok',
    spawnLaunch: (plan) => { spawned.push(plan); },
    platform: 'darwin',
  });
  assert.equal(code, 1);
  assert.equal(spawned.length, 0);
  assert.match(io.err, /project path is not available/);
});

test('absent source project directory does not spawn', () => {
  const io = capture();
  const spawned = [];
  const code = run(['--session', 'grok:source'], {
    ...io,
    readContext: () => CONTEXT,
    readProjectPath: () => '/no/such/throughline-parent-project',
    resolveBin: () => '/tmp/grok',
    spawnLaunch: (plan) => { spawned.push(plan); },
    platform: 'darwin',
  });
  assert.equal(code, 1);
  assert.equal(spawned.length, 0);
  assert.match(io.err, /does not exist/);
});

test('plan builder refuses --rules if a caller tries to add it', () => {
  const plan = buildContinuePlan({
    context: CONTEXT,
    grokBin: '/tmp/grok',
    cwd: '/work',
    sessionUuid: '33333333-3333-4333-8333-333333333333',
  });
  assert.equal(plan.grokArgv.includes('--rules'), false);
});

test('bin dispatches grok-continue and help names the command', () => {
  const bin = readFileSync(BIN_PATH, 'utf8');
  assert.match(bin, /case 'grok-continue':/);
  const help = spawnSync(process.execPath, [BIN_PATH, '--help'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /throughline grok-continue --session <id>/);
});

test('bin usage error is exit 2 without spawning a real grok', () => {
  const result = spawnSync(process.execPath, [BIN_PATH, 'grok-continue'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: join(tmpdir(), 'tl-grok-continue-missing-home'),
      USERPROFILE: join(tmpdir(), 'tl-grok-continue-missing-home'),
    },
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Usage: throughline grok-continue --session <id>/);
});
