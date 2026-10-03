import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultRuntimeErrorConfigPath, defaultRuntimeErrorStorePath } from './runtime-error-store.mjs';
import { applyWindowsPrivateAcl } from './os/windows-acl-test-helper.mjs';

const BIN = fileURLToPath(new URL('../bin/throughline.mjs', import.meta.url));

function createEnabledEnvironment(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const env = {
    ...process.env,
    HOME: root,
    USERPROFILE: root,
    LOCALAPPDATA: root,
    XDG_CONFIG_HOME: join(root, 'config'),
    XDG_STATE_HOME: join(root, 'state'),
  };
  const configPath = defaultRuntimeErrorConfigPath(env);
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify({
    schema: 'throughline.runtime_error_config.v1',
    collection: { enabled: true },
  }));
  applyWindowsPrivateAcl(configPath);
  return { root, env };
}

test('top-level hook owners record one fixed aggregate per failure without replacing hook failure', () => {
  const { env } = createEnabledEnvironment('throughline-runtime-hook-');
  const cases = [
    ['session-start'],
    ['prompt-submit'],
    ['process-turn'],
    ['codex-hook', 'stop'],
  ];
  for (const args of cases) {
    const result = spawnSync(process.execPath, [BIN, ...args], {
      env,
      input: '{invalid-json',
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0, args.join(' '));
    assert.notEqual(result.stderr, '', args.join(' '));
    assert.doesNotMatch(result.stderr, /store_unavailable/);
  }

  const storePath = defaultRuntimeErrorStorePath(env);
  let store = JSON.parse(readFileSync(storePath, 'utf8'));
  assert.equal(store.records.length, 4);
  assert.deepEqual(store.records.map((record) => record.error_code).sort(), [
    'HOOK_CODEX_FAILED',
    'HOOK_PROCESS_TURN_FAILED',
    'HOOK_PROMPT_SUBMIT_FAILED',
    'HOOK_SESSION_START_FAILED',
  ]);
  assert.ok(store.records.every((record) => record.count === 1));

  spawnSync(process.execPath, [BIN, 'process-turn'], {
    env,
    input: '{invalid-json',
    encoding: 'utf8',
  });
  store = JSON.parse(readFileSync(storePath, 'utf8'));
  assert.equal(store.records.find((record) => record.error_code === 'HOOK_PROCESS_TURN_FAILED').count, 2);
});

function makeBin(dir, name, body) {
  const script = join(dir, `${name}.mjs`);
  writeFileSync(script, body);
  if (process.platform === 'win32') {
    const command = join(dir, `${name}.cmd`);
    writeFileSync(command, `@echo off\r\n${JSON.stringify(process.execPath)} ${JSON.stringify(script)} %*\r\n`);
    writeFileSync(join(dir, `${name}.ps1`), `& ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} @args\nexit $LASTEXITCODE\n`);
    return command;
  }
  const command = join(dir, name);
  writeFileSync(command, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`);
  chmodSync(command, 0o755);
  return command;
}

test('Codex StopでL1要約backendが失敗した時、取り込みは残り、別のcodeで1回数える', () => {
  const { root, env } = createEnabledEnvironment('throughline-runtime-hook-summarizer-');
  const threadId = '019dfaba-f87e-7f41-a144-d5ca7c6dd7f9';
  const project = join(root, 'project');
  const codexHome = join(root, 'codex');
  const rolloutDir = join(codexHome, 'sessions', '2026', '05', '06');
  mkdirSync(project, { recursive: true });
  mkdirSync(rolloutDir, { recursive: true });
  const at = '2026-05-06T00:41:00.000Z';
  const event = (type, payload = {}) => ({ timestamp: at, type: 'event_msg', payload: { type, ...payload } });
  const rows = [{ timestamp: at, type: 'session_meta',
    payload: { id: threadId, timestamp: at, cwd: project, source: 'vscode', cli_version: '0.128.0-alpha.1' } }];
  // L2 window（20 turn）を超えると、Stop は最古の turn を Codex CLI で要約する。
  for (let turn = 0; turn < 22; turn += 1) {
    rows.push(event('user_message', { message: `request ${turn}` }), event('task_started'),
      { timestamp: at, type: 'turn_context', payload: { model: 'gpt-5.5', cwd: project } },
      event('agent_message', { message: `answer ${turn}` }), event('task_complete'));
  }
  const rolloutPath = join(rolloutDir, `rollout-2026-05-06T09-40-50-${threadId}.jsonl`);
  writeFileSync(rolloutPath, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  const binDir = join(root, 'bin');
  mkdirSync(binDir, { recursive: true });
  const codex = makeBin(binDir, 'codex', "process.stderr.write('ERROR: usage limit reached\\n');\nprocess.exit(42);\n");

  const result = spawnSync(process.execPath, [BIN, 'codex-hook', 'stop'], {
    env: { ...env, CODEX_HOME: codexHome, THROUGHLINE_CODEX_CLI_BIN: codex },
    input: JSON.stringify({ session_id: threadId, transcript_path: rolloutPath, cwd: project }),
    encoding: 'utf8',
  });

  // hook は明示して失敗する（終了 code と stderr は変えない）。
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /\[codex-hook\] Codex CLI summarizer failed: exit 42/);

  const store = JSON.parse(readFileSync(defaultRuntimeErrorStorePath(env), 'utf8'));
  assert.deepEqual(store.records.map((record) => [record.error_code, record.component, record.severity, record.count]), [
    ['L1_SUMMARIZER_BACKEND_FAILED', 'codex_l1_summarizer', 'warn', 1],
  ]);

  // 取り込みは要約の前に commit 済み。
  const db = new DatabaseSync(join(root, '.throughline', 'throughline.db'));
  try {
    const { n } = db.prepare("SELECT COUNT(*) AS n FROM bodies WHERE session_id = ? AND role = 'assistant'")
      .get(`codex:${threadId}`);
    assert.equal(n, 22);
  } finally {
    db.close();
  }

  const [entry] = readFileSync(join(root, '.throughline', 'logs', 'hook-failures.log'), 'utf8')
    .trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(entry.code, 'L1_SUMMARIZER_BACKEND_FAILED');
  assert.equal(entry.reason, 'codex_cli_failed');
  assert.match(entry.stderr, /usage limit reached/);
});

test('store failure preserves product failure and emits only fixed storage diagnostic', () => {
  const { env } = createEnabledEnvironment('throughline-runtime-hook-store-fail-');
  const storePath = defaultRuntimeErrorStorePath(env);
  mkdirSync(dirname(storePath), { recursive: true });
  writeFileSync(storePath, '{broken');

  const result = spawnSync(process.execPath, [BIN, 'prompt-submit'], {
    env,
    input: '{invalid-json',
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /store_unavailable/);
  assert.match(result.stderr, /SyntaxError|JSON/);
  assert.doesNotMatch(result.stderr, /runtime error store schema invalid/);
});

test('FIFO config cannot block the original hook failure', { skip: process.platform === 'win32' }, () => {
  const { env } = createEnabledEnvironment('throughline-runtime-hook-fifo-');
  const config = defaultRuntimeErrorConfigPath(env);
  execFileSync('rm', ['-f', config]);
  execFileSync('mkfifo', [config]);
  const started = Date.now();
  const result = spawnSync(process.execPath, [BIN, 'prompt-submit'], {
    env,
    input: '{invalid-json',
    encoding: 'utf8',
    timeout: 2_000,
  });
  assert.notEqual(result.status, 0);
  assert(Date.now() - started < 1_500);
  assert.match(result.stderr, /SyntaxError|JSON/);
});
