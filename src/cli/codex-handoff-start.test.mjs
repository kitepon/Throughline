import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _internal } from './codex-handoff-start.mjs';

const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

test('codex-handoff-start recognizes desktop as an explicit open host', () => {
  assert.equal(_internal.parseArgs(['--open-host', 'desktop']).openHost, 'desktop');
});

test('codex-handoff-start auto-selects Codex Desktop before inherited VS Code signals', () => {
  assert.equal(
    _internal.resolveOpenHost('auto', {
      CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'Codex Desktop',
      VSCODE_IPC_HOOK_CLI: '/tmp/stale-vscode.sock',
    }),
    'desktop',
  );
  assert.equal(
    _internal.resolveOpenHost('auto', { __CFBundleIdentifier: 'com.openai.codex' }),
    'desktop',
  );
});

test('codex-handoff-start does not mistake a stale VS Code PTY for Desktop without a Desktop signal', () => {
  assert.equal(
    _internal.resolveOpenHost('auto', {
      VSCODE_IPC_HOOK_CLI: '/tmp/stale-vscode.sock',
    }),
    'vscode',
  );
  assert.equal(
    _internal.resolveOpenHost('desktop', {
      VSCODE_IPC_HOOK_CLI: '/tmp/stale-vscode.sock',
    }),
    'desktop',
  );
});

test('codex-handoff-start keeps VS Code and CLI auto-open behavior', () => {
  assert.equal(
    _internal.resolveOpenHost('auto', { CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'codex_vscode' }),
    'vscode',
  );
  assert.equal(_internal.resolveOpenHost('auto', {}), 'cli');
});

test('codex-handoff-start builds the Codex Desktop local thread deep link', () => {
  assert.equal(
    _internal.buildCodexDesktopUrl('019f78e8-77ec-7d73-aee4-fb8e3869200a'),
    'codex://threads/019f78e8-77ec-7d73-aee4-fb8e3869200a',
  );
});

function makeTempHome() {
  return mkdtempSync(join(tmpdir(), 'tl-codex-handoff-start-home-'));
}

function makeTempProject() {
  return mkdtempSync(join(tmpdir(), 'tl-codex-handoff-start-project-'));
}

function makeFakeCodexAppServer(dir) {
  const script = join(dir, 'fake-codex-app-server.mjs');
  const log = join(dir, 'fake-codex-app-server.log');
  writeFileSync(
    script,
    `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const log = ${JSON.stringify(log)};
const rl = createInterface({ input: process.stdin });
function send(message) { process.stdout.write(JSON.stringify(message) + '\\n'); }
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  appendFileSync(log, JSON.stringify(msg) + '\\n');
  if (msg.method === 'initialized') return;
  if (msg.method === 'initialize') {
    send({ id: msg.id, result: { userAgent: 'fake-codex' } });
  } else if (msg.method === 'thread/start') {
    send({ id: msg.id, result: { thread: { id: '019e2000-0000-7000-8000-000000000001', turns: [] } } });
  } else if (msg.method === 'thread/inject_items') {
    send({ id: msg.id, result: { thread: { id: msg.params.threadId, turns: [] } } });
  } else if (msg.method === 'turn/start') {
    send({ id: msg.id, result: { turn: { id: 'turn-handoff' } } });
    send({ method: 'item/agentMessage/delta', params: { threadId: msg.params.threadId, turnId: 'turn-handoff', itemId: 'item-1', delta: 'OK' } });
    send({ method: 'turn/completed', params: { threadId: msg.params.threadId, turnId: 'turn-handoff' } });
  } else {
    send({ id: msg.id, error: { code: -32601, message: 'unknown method' } });
  }
});
`,
  );
  chmodSync(script, 0o755);
  return { script, log };
}

async function seedDb(home, project) {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    const mod = await import(`../db.mjs?codexHandoffStart=${Date.now()}-${Math.random()}`);
    const db = mod.getDb();
    db.prepare(
      `INSERT INTO sessions (session_id, project_path, status, created_at, updated_at)
       VALUES ('codex:thread-handoff-start', ?, 'active', 1, 2)`,
    ).run(project);
    db.prepare(
      `INSERT INTO skeletons
         (session_id, origin_session_id, turn_number, role, summary, created_at)
       VALUES ('codex:thread-handoff-start', 'codex:thread-handoff-start', 1, 'assistant',
               'older handoff start summary', 1000)`,
    ).run();
    db.prepare(
      `INSERT INTO bodies
         (session_id, origin_session_id, turn_number, role, text, token_count, created_at)
       VALUES ('codex:thread-handoff-start', 'codex:thread-handoff-start', 2, 'assistant',
               'latest handoff start body', 4, 2000)`,
    ).run();
    db.close();
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
  }
}

function runStart(home, project, args = [], input = undefined) {
  return spawnSync(
    process.execPath,
    [join(REPO_ROOT, 'bin/throughline.mjs'), 'codex-handoff-start', ...args],
    {
      cwd: project,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
      },
      encoding: 'utf8',
      input,
    },
  );
}

test('codex-handoff-start prints guided ready JSON for latest Codex session', async () => {
  const home = makeTempHome();
  const project = makeTempProject();
  try {
    await seedDb(home, project);
    const result = runStart(home, project, ['--json']);

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, 'ready');
    assert.equal(payload.reason, 'fresh_thread_handoff_start_ready');
    assert.equal(payload.sessionId, 'codex:thread-handoff-start');
    assert.equal(payload.mutatesCurrentThread, false);
    assert.equal(payload.startThreadManually, true);
    assert.equal(payload.openHost, 'auto');
    assert.equal(payload.requestedOpenHost, 'auto');
    assert.ok(['desktop', 'vscode', 'cli'].includes(payload.resolvedOpenHost));
    assert.equal(payload.memoStdin, false);
    assert.equal(payload.memoReplayNote, null);
    assert.equal(payload.handoffSmoke.status, 'ready');
    assert.match(payload.commands.structuralSmoke, /codex-handoff-smoke --session codex:thread-handoff-start/);
    assert.match(payload.commands.modelSmokeDryRun, /codex-handoff-model-smoke --session codex:thread-handoff-start/);
    assert.match(payload.commands.modelSmokeDryRun, /--dry-run --json/);
    assert.match(payload.commands.renderPrompt, /codex-resume --session codex:thread-handoff-start --format handoff/);
    assert.match(payload.commands.liveModelSmoke, /THROUGHLINE_EXPERIMENTAL_CODEX_HANDOFF_MODEL_SMOKE=1/);
    assert.equal(payload.prompt, undefined);
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('codex-handoff-start can print the exact fresh-thread prompt', async () => {
  const home = makeTempHome();
  const project = makeTempProject();
  try {
    await seedDb(home, project);
    const result = runStart(home, project, [
      '--session',
      'codex:thread-handoff-start',
      '--print-prompt',
    ]);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /throughline codex handoff start/);
    assert.match(result.stdout, /status:\s+ready/);
    assert.match(result.stdout, /open requested:\s+auto/);
    assert.match(result.stdout, /open resolved:\s+(desktop|vscode|cli)/);
    assert.match(result.stdout, /commands:/);
    assert.match(result.stdout, /## Throughline: New Codex Thread Handoff/);
    assert.match(result.stdout, /latest handoff start body/);
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('codex-handoff-start refuses when structural handoff smoke is not ready', async () => {
  const home = makeTempHome();
  const project = makeTempProject();
  try {
    await seedDb(home, project);
    const result = runStart(home, project, [
      '--session',
      'codex:thread-handoff-start',
      '--max-prompt-chars',
      '50',
      '--json',
    ]);

    assert.equal(result.status, 1);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, 'not-ready');
    assert.equal(payload.reason, 'handoff_smoke_not_ready');
    assert.equal(payload.handoffSmoke.status, 'not-ready');
    assert.match(payload.commands.renderPrompt, /codex-resume --session codex:thread-handoff-start/);
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('codex-handoff-start carries memo stdin into the printed prompt', async () => {
  const home = makeTempHome();
  const project = makeTempProject();
  try {
    await seedDb(home, project);
    const result = runStart(
      home,
      project,
      ['--session', 'codex:thread-handoff-start', '--memo-stdin', '--print-prompt'],
      '**Next move**: continue guided start',
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /In-flight Memo/);
    assert.match(result.stdout, /continue guided start/);
    assert.match(result.stdout, /--memo-stdin/);
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('codex-handoff-start propagates memo-stdin to replay commands in JSON guidance', async () => {
  const home = makeTempHome();
  const project = makeTempProject();
  try {
    await seedDb(home, project);
    const result = runStart(
      home,
      project,
      ['--session', 'codex:thread-handoff-start', '--memo-stdin', '--json'],
      '**Next move**: replay memo',
    );

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, 'ready');
    assert.equal(payload.memoStdin, true);
    assert.match(payload.memoReplayNote, /pipe the same memo/);
    assert.match(payload.commands.structuralSmoke, /--memo-stdin --json/);
    assert.match(payload.commands.modelSmokeDryRun, /--memo-stdin --dry-run --json/);
    assert.match(payload.commands.renderPrompt, /--memo-stdin/);
    assert.match(payload.commands.liveModelSmoke, /--memo-stdin --json/);
    assert.equal(payload.prompt, undefined);
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('codex-handoff-start execute creates a new app-server thread and can skip opening a host', async () => {
  const home = makeTempHome();
  const project = makeTempProject();
  try {
    await seedDb(home, project);
    const { script, log } = makeFakeCodexAppServer(project);
    const result = runStart(home, project, [
      '--session',
      'codex:thread-handoff-start',
      '--execute',
      '--open-host',
      'none',
      '--codex-app-server-bin',
      script,
      '--json',
    ]);

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, 'started');
    assert.equal(payload.reason, 'new_thread_handoff_started');
    assert.equal(payload.execute, true);
    assert.equal(payload.openHost, 'none');
    assert.equal(payload.requestedOpenHost, 'none');
    assert.equal(payload.resolvedOpenHost, 'none');
    assert.equal(payload.startThreadManually, false);
    assert.equal(payload.newThread.threadId, '019e2000-0000-7000-8000-000000000001');
    assert.equal(payload.newThread.delivery, 'developer-item');
    assert.equal(payload.runtime.command, script);
    assert.equal(payload.runtime.source, 'explicit');
    assert.deepEqual(payload.runtime.commandArgs, []);
    assert.equal(payload.newThread.injectSent, true);
    assert.equal(payload.newThread.turnStatus, 'not-started');
    assert.equal(payload.open.status, 'skipped');
    assert.equal(payload.open.host, 'none');
    assert.equal(payload.open.requestedHost, 'none');
    assert.equal(payload.open.resolvedHost, 'none');
    assert.equal(
      payload.open.desktopUrl,
      'codex://threads/019e2000-0000-7000-8000-000000000001',
    );
    assert.equal(payload.open.vscodeUrl, 'vscode://openai.chatgpt/local/019e2000-0000-7000-8000-000000000001');
    assert.match(payload.open.resumeCommand, /codex resume 019e2000-0000-7000-8000-000000000001/);

    const fakeLog = readFileSync(log, 'utf8');
    assert.match(fakeLog, /"method":"thread\/start"/);
    assert.match(fakeLog, /"sessionStartSource":"clear"/);
    assert.match(fakeLog, /"method":"thread\/inject_items"/);
    assert.doesNotMatch(fakeLog, /"method":"turn\/start"/);
    assert.match(fakeLog, /## Throughline: New Codex Thread Handoff/);
    assert.match(fakeLog, /latest handoff start body/);
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
