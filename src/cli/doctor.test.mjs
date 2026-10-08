import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { _internal } from './doctor.mjs';

const {
  parseArgs,
  formatAgo,
  formatBytes,
  findLatestJsonlInSameDir,
  isPidAlive,
  readCodexHookDiagnosis,
  readVsCodeMonitorTaskDiagnosis,
  runCodexDiagnosis,
  runTrimDiagnosis,
  buildCodexContextRefreshDiagnosis,
  readCodexHostPrimitiveDiagnosis,
  describeCodexHookRegistration,
  printCodexHookDetails,
} = _internal;

test('Codex hook diagnosis requires reinstall for legacy timeoutSec key', () => {
  const legacy = { type: 'command', command: 'canonical', timeoutSec: 300, async: false };
  assert.equal(
    describeCodexHookRegistration([legacy], [], 300),
    'legacy timeout key needs reinstall',
  );
  assert.equal(
    describeCodexHookRegistration([{ type: 'command', command: 'canonical', timeout: 300, async: false }], [], 300),
    'registered',
  );
});

test('Codex hook diagnosis prints timeout and exposes ignored legacy key', () => {
  const lines = [];
  const originalLog = console.log;
  console.log = (line) => lines.push(line);
  try {
    printCodexHookDetails({
      command: 'canonical',
      timeout: 300,
      timeoutSec: 30,
      async: false,
      throughlineDoctorTrusted: true,
    });
  } finally {
    console.log = originalLog;
  }
  const output = lines.join('\n');
  assert.match(output, /timeout:\s+300/);
  assert.match(output, /legacy timeoutSec:\s+30 \(ignored by Codex; reinstall required\)/);
});

// ─── parseArgs ──────────────────────────────────────────────────────

test('parseArgs: 引数なしは session null', () => {
  assert.deepEqual(parseArgs([]), { session: null, trim: false, host: 'unknown', codex: false });
});

test('parseArgs: --session <prefix>', () => {
  assert.deepEqual(parseArgs(['--session', 'abc']), {
    session: 'abc',
    trim: false,
    host: 'unknown',
    codex: false,
  });
});

test('parseArgs: --session の値欠落は throw', () => {
  assert.throws(() => parseArgs(['--session']), /session id prefix/);
});

test('parseArgs: --session の次が別フラグなら throw', () => {
  assert.throws(() => parseArgs(['--session', '--other']), /session id prefix/);
});

test('parseArgs: --trim --host <host>', () => {
  assert.deepEqual(parseArgs(['--trim', '--host', 'claude']), {
    session: null,
    trim: true,
    host: 'claude',
    codex: false,
  });
});

test('parseArgs: --host は known host のみ', () => {
  assert.throws(() => parseArgs(['--trim', '--host', 'robot']), /claude, codex, or unknown/);
});

test('runTrimDiagnosis: codex reports missing current thread identity', () => {
  const output = captureStdout(() =>
    runTrimDiagnosis('codex', {}, { auditRunner: blockedHostPrimitiveAudit }),
  );

  assert.match(output, /current Codex thread:\s+not detected/);
  assert.match(output, /host primitive audit:\s+host-primitive-audit-blocked/);
  assert.match(output, /current-thread non-resurrection:\s+no/);
  assert.match(output, /repair contract:\s+blocked-missing-current-thread-non-resurrection-guarantee/);
  assert.match(output, /throughline trim --dry-run --host codex --codex-thread-id <id>/);
  assert.match(output, /throughline trim --preflight --host codex --codex-thread-id <id>/);
  assert.match(output, /throughline trim --execute --host codex/);
  assert.match(output, /fresh-thread continuation path:/);
  assert.match(output, /status:\s+fresh-thread-handoff-available/);
  assert.match(output, /safety scope:\s+fresh_thread_handoff_no_current_thread_mutation/);
  assert.match(output, /throughline codex-handoff-start --session codex:<thread-id>/);
  assert.match(output, /throughline codex-handoff-smoke --session codex:<thread-id>/);
  assert.match(output, /throughline codex-handoff-model-smoke --session codex:<thread-id> --dry-run --json/);
  assert.match(output, /throughline codex-resume --session codex:<thread-id> --format handoff/);
  assert.match(output, /start a new Codex thread with that handoff context only if desired/);
});

test('runTrimDiagnosis: codex reports env current thread identity', () => {
  const output = captureStdout(() =>
    runTrimDiagnosis(
      'codex',
      {
        THROUGHLINE_CODEX_THREAD_ID: '019dfaba-f87e-7f41-a144-d5ca7c6dd7f9',
      },
      { auditRunner: blockedHostPrimitiveAudit },
    ),
  );

  assert.match(
    output,
    /current Codex thread:\s+019dfaba-f87e-7f41-a144-d5ca7c6dd7f9 \(env:THROUGHLINE_CODEX_THREAD_ID\)/,
  );
  assert.match(output, /throughline trim --dry-run --host codex/);
  assert.match(output, /throughline trim --preflight --host codex/);
  assert.match(output, /host primitive audit:\s+host-primitive-audit-blocked/);
  assert.match(output, /repair contract:\s+blocked-missing-current-thread-non-resurrection-guarantee/);
  assert.match(output, /throughline trim --execute --host codex/);
  assert.match(
    output,
    /throughline codex-resume --session codex:019dfaba-f87e-7f41-a144-d5ca7c6dd7f9 --format handoff/,
  );
  assert.match(
    output,
    /throughline codex-handoff-start --session codex:019dfaba-f87e-7f41-a144-d5ca7c6dd7f9/,
  );
  assert.match(
    output,
    /throughline codex-handoff-smoke --session codex:019dfaba-f87e-7f41-a144-d5ca7c6dd7f9/,
  );
  assert.match(
    output,
    /throughline codex-handoff-model-smoke --session codex:019dfaba-f87e-7f41-a144-d5ca7c6dd7f9 --dry-run --json/,
  );
  assert.doesNotMatch(output, /--codex-thread-id <id>/);
});

test('parseArgs: --codex', () => {
  assert.deepEqual(parseArgs(['--codex']), {
    session: null,
    trim: false,
    host: 'unknown',
    codex: true,
  });
});

test('runCodexDiagnosis: reports env thread and captured DB session', () => {
  const codexHome = mkdtempSync(join(tmpdir(), 'tl-doctor-codex-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'tl-doctor-codex-project-'));
  try {
    const output = captureStdout(() =>
      runCodexDiagnosis({
        cwd,
        env: {
          CODEX_HOME: codexHome,
          CODEX_THREAD_ID: '019dfaba-f87e-7f41-a144-d5ca7c6dd7f9',
        },
        db: {
          prepare(sql) {
            return {
              get(projectPath) {
                assert.equal(projectPath, cwd);
                if (sql.includes('COUNT(*)')) return { count: 1 };
                return { session_id: 'codex:019dfaba-f87e-7f41-a144-d5ca7c6dd7f9', updated_at: 1000 };
              },
            };
          },
        },
        auditRunner: blockedHostPrimitiveAudit,
      }),
    );

    assert.match(output, /\[Codex primary\]/);
    assert.match(output, /Codex hooks feature:\s+not enabled/);
    assert.match(output, /Codex UserPrompt hook:\s+not registered/);
    assert.match(output, /Codex PostTool hook:\s+not registered/);
    assert.match(output, /Codex Stop hook:\s+not registered/);
    assert.match(output, /VSCode monitor task:\s+not registered/);
    assert.match(output, /created by the next VSCode hook event/);
    assert.match(output, /current Codex thread:\s+019dfaba-f87e-7f41-a144-d5ca7c6dd7f9 \(env:CODEX_THREAD_ID\)/);
    assert.match(output, /captured DB sessions:\s+1/);
    assert.match(output, /latest DB session:\s+codex:019dfaba-f87e-7f41-a144-d5ca7c6dd7f9/);
    assert.match(output, /context refresh:\s+not ready/);
    assert.match(output, /host primitive audit:\s+host-primitive-audit-blocked/);
    assert.match(output, /current-thread non-resurrection:\s+no/);
    assert.match(output, /repair contract:\s+blocked-missing-current-thread-non-resurrection-guarantee/);
    assert.match(output, /throughline codex-capture --codex-thread-id 019dfaba-f87e-7f41-a144-d5ca7c6dd7f9/);
    assert.match(output, /throughline codex-handoff-start --session codex:019dfaba-f87e-7f41-a144-d5ca7c6dd7f9/);
    assert.match(output, /throughline codex-handoff-smoke --session codex:019dfaba-f87e-7f41-a144-d5ca7c6dd7f9/);
    assert.match(output, /throughline codex-handoff-model-smoke --session codex:019dfaba-f87e-7f41-a144-d5ca7c6dd7f9 --dry-run --json/);
    assert.match(output, /throughline codex-resume --session codex:019dfaba-f87e-7f41-a144-d5ca7c6dd7f9 --format handoff/);
    assert.match(output, /throughline codex-resume --session codex:019dfaba-f87e-7f41-a144-d5ca7c6dd7f9/);
    assertInOrder(output, [
      'throughline codex-capture --codex-thread-id 019dfaba-f87e-7f41-a144-d5ca7c6dd7f9',
      'throughline codex-handoff-start --session codex:019dfaba-f87e-7f41-a144-d5ca7c6dd7f9',
      'throughline codex-handoff-smoke --session codex:019dfaba-f87e-7f41-a144-d5ca7c6dd7f9',
      'throughline codex-handoff-model-smoke --session codex:019dfaba-f87e-7f41-a144-d5ca7c6dd7f9 --dry-run --json',
      'throughline codex-resume --session codex:019dfaba-f87e-7f41-a144-d5ca7c6dd7f9 --format handoff',
      'throughline codex-resume --session codex:019dfaba-f87e-7f41-a144-d5ca7c6dd7f9',
    ]);
    assert.match(output, /THROUGHLINE_EXPERIMENTAL_CODEX_HANDOFF_MODEL_SMOKE=1 throughline codex-handoff-model-smoke --session codex:019dfaba-f87e-7f41-a144-d5ca7c6dd7f9/);
    assert.match(output, /throughline codex-host-primitive-audit/);
  } finally {
    rmSync(codexHome, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('runCodexDiagnosis: prints optional fresh-thread handoff status when DB memory is ready', () => {
  const db = makeMemoryDb();
  const codexHome = mkdtempSync(join(tmpdir(), 'tl-doctor-codex-home-'));
  try {
    seedCodexMemory(db);
    const output = captureStdout(() =>
      runCodexDiagnosis({
        cwd: '/repo',
        env: {
          CODEX_HOME: codexHome,
          CODEX_THREAD_ID: '019dfaba-f87e-7f41-a144-d5ca7c6dd7f9',
        },
        db,
        auditRunner: blockedHostPrimitiveAudit,
      }),
    );

    assert.match(output, /context refresh:\s+ready/);
    assert.match(output, /new-thread handoff:\s+ready/);
    assert.match(output, /safe continuation:\s+fresh-thread-handoff-available/);
    assert.match(output, /throughline codex-handoff-start --session codex:019dfaba-f87e-7f41-a144-d5ca7c6dd7f9/);
  } finally {
    db.close();
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test('readCodexHostPrimitiveDiagnosis reports audit failure explicitly', () => {
  const diagnosis = readCodexHostPrimitiveDiagnosis({
    auditRunner() {
      throw new Error('schema unavailable');
    },
  });

  assert.deepEqual(diagnosis, {
    status: 'unavailable',
    reason: 'schema unavailable',
    hasCurrentThreadRemediationPrimitive: false,
    hasCurrentThreadNonResurrectionPrimitive: false,
    repairContractStatus: 'unavailable',
    methodCount: null,
  });
});

test('readVsCodeMonitorTaskDiagnosis: reports registered folderOpen monitor and reload note', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'tl-doctor-codex-project-'));
  try {
    mkdirSync(join(cwd, '.vscode'), { recursive: true });
    writeFileSync(
      join(cwd, '.vscode', 'tasks.json'),
      JSON.stringify(
        {
          version: '2.0.0',
          tasks: [
            {
              label: 'Throughline Monitor',
              type: 'shell',
              command: process.execPath,
              args: ['throughline', 'monitor'],
              runOptions: { runOn: 'folderOpen' },
            },
          ],
        },
        null,
        2,
      ) + '\n',
    );

    const diagnosis = readVsCodeMonitorTaskDiagnosis(cwd);
    assert.equal(diagnosis.status, 'registered');
    assert.equal(diagnosis.path, join(cwd, '.vscode', 'tasks.json'));
    assert.equal(diagnosis.runOn, 'folderOpen');
    assert.match(diagnosis.note, /Developer: Reload Window/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('buildCodexContextRefreshDiagnosis reports original /tl memory contract', () => {
  const db = makeMemoryDb();
  const codexHome = mkdtempSync(join(tmpdir(), 'tl-doctor-codex-home-'));
  try {
    seedCodexMemory(db);
    const diagnosis = buildCodexContextRefreshDiagnosis({
      db,
      cwd: '/repo',
      codexHome,
      identity: {
        codexThreadId: '019dfaba-f87e-7f41-a144-d5ca7c6dd7f9',
        codexThreadIdSource: 'env:CODEX_THREAD_ID',
      },
    });

    assert.equal(diagnosis.status, 'ready');
    assert.equal(diagnosis.injectMemorySource, 'throughline-db');
    assert.equal(diagnosis.memoryContract, 'older L1 + latest 20 L2 full bodies + L3 references only');
    assert.equal(diagnosis.l1Summaries, 1);
    assert.equal(diagnosis.recentBodies, '2 rows (latest 20 turns)');
    assert.equal(diagnosis.l3References, 1);
    assert.equal(diagnosis.handoffSmoke.status, 'ready');
    assert.equal(diagnosis.handoffSmoke.reason, 'fresh_thread_handoff_prompt_ready');
    assert.equal(diagnosis.safeContinuationStatus, 'fresh-thread-handoff-available');
    assert.ok(diagnosis.handoffSmoke.promptChars > 0);
    assert.ok(diagnosis.handoffSmoke.estimatedTokens > 0);
  } finally {
    db.close();
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test('buildCodexContextRefreshDiagnosis keeps ready label when restore safety is diagnostic-only', () => {
  const db = makeMemoryDb();
  const codexHome = mkdtempSync(join(tmpdir(), 'tl-doctor-codex-home-'));
  const threadId = '019dfaba-f87e-7f41-a144-d5ca7c6dd7f9';
  try {
    seedCodexMemory(db);
    writeCodexRollout(codexHome, {
      project: '/repo',
      threadId,
      turnCount: 22,
      restoreRisk: true,
    });
    const diagnosis = buildCodexContextRefreshDiagnosis({
      db,
      cwd: '/repo',
      codexHome,
      identity: {
        codexThreadId: threadId,
        codexThreadIdSource: 'env:CODEX_THREAD_ID',
      },
    });

    assert.equal(diagnosis.status, 'ready');
    assert.equal(diagnosis.blockedReason, null);
    assert.equal(diagnosis.injectMemorySource, 'throughline-db');
  } finally {
    db.close();
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test('readCodexHookDiagnosis detects Codex prompt and Stop hooks', () => {
  const codexHome = mkdtempSync(join(tmpdir(), 'tl-doctor-codex-home-'));
  try {
    mkdirSync(join(codexHome), { recursive: true });
    writeFileSync(
      join(codexHome, 'hooks.json'),
      JSON.stringify(
        {
          hooks: {
            UserPromptSubmit: [
              {
                hooks: [
                  {
                    type: 'command',
                    command: '/usr/bin/node /pkg/bin/throughline.mjs codex-hook user-prompt-submit',
                    timeout: 30,
                    async: false,
                  },
                ],
              },
            ],
            PostToolUse: [
              {
                hooks: [
                  {
                    type: 'command',
                    command: '/usr/bin/node /pkg/bin/throughline.mjs codex-hook post-tool-use',
                    timeout: 30,
                    async: false,
                  },
                ],
              },
            ],
            Stop: [
              {
                hooks: [
                  {
                    type: 'command',
                    command: 'throughline codex-hook stop',
                    timeout: 300,
                    async: true,
                  },
                ],
              },
            ],
          },
        },
        null,
        2,
      ) + '\n',
    );
    const hooksPath = join(codexHome, 'hooks.json');
    writeFileSync(
      join(codexHome, 'config.toml'),
      [
        '[features]',
        'codex_hooks = true',
        'hooks = true',
        '',
        `[hooks.state."${hooksPath}:user_prompt_submit:0:0"]`,
        'trusted_hash = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"',
        '',
        `[hooks.state."${hooksPath}:post_tool_use:0:0"]`,
        'trusted_hash = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"',
        '',
        `[hooks.state."${hooksPath}:stop:0:0"]`,
        'trusted_hash = "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"',
        '',
      ].join('\n'),
    );

    const diagnosis = readCodexHookDiagnosis(codexHome);
    assert.equal(diagnosis.featureEnabled, true);
    assert.equal(diagnosis.codexHooksFeatureEnabled, true);
    assert.equal(diagnosis.hooksFeatureEnabled, true);
    assert.equal(diagnosis.managedHookTrust.status, 'trusted');
    assert.equal(diagnosis.managedHookTrust.trustedCount, 3);
    assert.equal(diagnosis.managedHookTrust.totalCount, 3);
    assert.equal(diagnosis.managedPromptHooks.length, 1);
    assert.equal(diagnosis.managedPromptHooks[0].throughlineDoctorTrusted, true);
    assert.equal(diagnosis.legacyManagedPromptHooks.length, 1);
    assert.equal(diagnosis.managedPostToolUseHooks.length, 1);
    assert.equal(diagnosis.managedPostToolUseHooks[0].throughlineDoctorTrusted, true);
    assert.equal(diagnosis.legacyManagedPostToolUseHooks.length, 1);
    assert.equal(diagnosis.managedStopHooks.length, 1);
    assert.equal(diagnosis.managedStopHooks[0].throughlineDoctorTrusted, true);
    assert.equal(diagnosis.legacyManagedStopHooks.length, 1);
  } finally {
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test('readCodexHookDiagnosis: Windowsのpathのkey（TOMLのliteral string・escapeしたbasic string）の承認を読む', () => {
  const codexHome = mkdtempSync(join(tmpdir(), 'throughline-doctor-codex-trust-'));
  try {
    const hook = (name, timeout) => [{ hooks: [{ type: 'command', command: `/usr/bin/node /pkg/bin/throughline.mjs codex-hook ${name}`, timeout, async: false }] }];
    writeFileSync(join(codexHome, 'hooks.json'), JSON.stringify({ hooks: {
      UserPromptSubmit: hook('user-prompt-submit', 30), PostToolUse: hook('post-tool-use', 30), Stop: hook('stop', 300) } }) + '\n');
    // foxの実測（2026-10-08）: Codex 0.160 は `[hooks.state.'C:\Users\…\hooks.json:stop:0:0']` と書く。
    const hooksPath = join(codexHome, 'hooks.json');
    const hash = 'trusted_hash = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"';
    writeFileSync(join(codexHome, 'config.toml'), ['[features]', 'hooks = true', '',
      `[hooks.state.'${hooksPath}:user_prompt_submit:0:0']`, hash, '',
      `[hooks.state.${JSON.stringify(`${hooksPath}:post_tool_use:0:0`)}]`, hash, '',
      `[hooks.state.'${hooksPath}:stop:0:0']`, 'enabled = true', ''].join('\n'));
    const diagnosis = readCodexHookDiagnosis(codexHome);
    assert.equal(diagnosis.managedPromptHooks[0].throughlineDoctorTrusted, true);
    assert.equal(diagnosis.managedPostToolUseHooks[0].throughlineDoctorTrusted, true);
    // trusted_hash の無い項目は、承認済みに数えない。
    assert.equal(diagnosis.managedStopHooks[0].throughlineDoctorTrusted, false);
    assert.equal(diagnosis.managedHookTrust.trustedCount, 2);
  } finally {
    rmSync(codexHome, { recursive: true, force: true });
  }
});

// ─── formatAgo ──────────────────────────────────────────────────────

test('formatAgo: 60 秒未満は秒表示', () => {
  assert.equal(formatAgo(30_000), '30s ago');
});

function captureStdout(fn) {
  const originalWrite = process.stdout.write.bind(process.stdout);
  let output = '';
  process.stdout.write = (chunk) => {
    output += String(chunk);
    return true;
  };
  try {
    fn();
  } finally {
    process.stdout.write = originalWrite;
  }
  return output;
}

function assertInOrder(text, expected) {
  let cursor = -1;
  for (const needle of expected) {
    const index = text.indexOf(needle, cursor + 1);
    assert.notEqual(index, -1, `missing expected output: ${needle}`);
    assert.ok(index > cursor, `expected "${needle}" after previous output`);
    cursor = index;
  }
}

function blockedHostPrimitiveAudit() {
  return {
    status: 'host-primitive-audit-blocked',
    reason: 'no_current_thread_restore_non_resurrection_primitive',
    methodCount: 89,
    facts: {
      hasCurrentThreadRemediationPrimitive: false,
      hasCurrentThreadNonResurrectionPrimitive: false,
    },
    repairContract: {
      status: 'blocked-missing-current-thread-non-resurrection-guarantee',
    },
  };
}

function writeCodexRollout(codexHome, { project, threadId, turnCount, restoreRisk = false }) {
  const dir = join(codexHome, 'sessions', '2026', '05', '06');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `rollout-2026-05-06T09-40-50-${threadId}.jsonl`);
  const rows = [
    {
      timestamp: '2026-05-06T00:40:50.000Z',
      type: 'session_meta',
      payload: {
        id: threadId,
        timestamp: '2026-05-06T00:40:50.000Z',
        cwd: project,
        source: 'vscode',
      },
    },
  ];

  for (let turn = 1; turn <= turnCount; turn++) {
    rows.push({
      timestamp: `2026-05-06T00:41:${String(turn).padStart(2, '0')}.000Z`,
      type: 'event_msg',
      payload: {
        type: 'user_message',
        message: `codex user turn ${turn}`,
      },
    });
    rows.push({
      timestamp: `2026-05-06T00:41:${String(turn).padStart(2, '0')}.100Z`,
      type: 'event_msg',
      payload: { type: 'task_started' },
    });
    rows.push({
      timestamp: `2026-05-06T00:41:${String(turn).padStart(2, '0')}.200Z`,
      type: 'event_msg',
      payload: {
        type: 'agent_message',
        message: `codex assistant turn ${turn}`,
      },
    });
    rows.push({
      timestamp: `2026-05-06T00:41:${String(turn).padStart(2, '0')}.300Z`,
      type: 'event_msg',
      payload: { type: 'task_complete' },
    });
  }

  if (restoreRisk) {
    const riskyText = `codex user turn ${turnCount}`;
    rows.push({
      timestamp: '2026-05-06T00:42:00.000Z',
      type: 'compacted',
      payload: {
        message: '',
        replacement_history: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: riskyText }],
          },
        ],
      },
    });
    rows.push({
      timestamp: '2026-05-06T00:42:00.100Z',
      type: 'event_msg',
      payload: { type: 'context_compacted' },
    });
    rows.push({
      timestamp: '2026-05-06T00:42:00.200Z',
      type: 'event_msg',
      payload: { type: 'thread_rolled_back', num_turns: 1 },
    });
  }

  writeFileSync(path, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  return path;
}

function makeMemoryDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE sessions (
      session_id TEXT PRIMARY KEY,
      project_path TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      merged_into TEXT
    );
    CREATE TABLE skeletons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      origin_session_id TEXT,
      turn_number INTEGER NOT NULL,
      role TEXT NOT NULL,
      summary TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE bodies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      origin_session_id TEXT NOT NULL,
      turn_number INTEGER NOT NULL,
      role TEXT NOT NULL,
      text TEXT NOT NULL,
      token_count INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE details (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      origin_session_id TEXT,
      turn_number INTEGER,
      tool_name TEXT NOT NULL,
      input_text TEXT,
      output_text TEXT,
      token_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      kind TEXT,
      source_id TEXT
    );
  `);
  return db;
}

function seedCodexMemory(db) {
  db.prepare(
    `INSERT INTO sessions (session_id, project_path, status, created_at, updated_at)
     VALUES ('codex:019dfaba-f87e-7f41-a144-d5ca7c6dd7f9', '/repo', 'active', 1, 2)`,
  ).run();
  db.prepare(
    `INSERT INTO skeletons
       (session_id, origin_session_id, turn_number, role, summary, created_at)
     VALUES ('codex:019dfaba-f87e-7f41-a144-d5ca7c6dd7f9',
             'codex:019dfaba-f87e-7f41-a144-d5ca7c6dd7f9',
             1, 'assistant', 'older L1 summary', 1000)`,
  ).run();
  for (const [role, text, createdAt] of [
    ['user', 'recent user L2', 2000],
    ['assistant', 'recent assistant L2', 2100],
  ]) {
    db.prepare(
      `INSERT INTO bodies
         (session_id, origin_session_id, turn_number, role, text, token_count, created_at)
       VALUES ('codex:019dfaba-f87e-7f41-a144-d5ca7c6dd7f9',
               'codex:019dfaba-f87e-7f41-a144-d5ca7c6dd7f9',
               2, ?, ?, 1, ?)`,
    ).run(role, text, createdAt);
  }
  db.prepare(
    `INSERT INTO details
       (session_id, origin_session_id, turn_number, tool_name, input_text, output_text,
        token_count, created_at, kind, source_id)
     VALUES ('codex:019dfaba-f87e-7f41-a144-d5ca7c6dd7f9',
             'codex:019dfaba-f87e-7f41-a144-d5ca7c6dd7f9',
             2, 'exec_command', 'input', 'large output', 10, 2200, 'tool_output', 'detail-1')`,
  ).run();
}

test('formatAgo: 60 分未満は分表示', () => {
  assert.equal(formatAgo(5 * 60_000), '5m ago');
});

test('formatAgo: 24 時間未満は時表示', () => {
  assert.equal(formatAgo(3 * 60 * 60_000), '3h ago');
});

test('formatAgo: 24 時間以上は日表示', () => {
  assert.equal(formatAgo(2 * 24 * 60 * 60_000), '2d ago');
});

test('formatAgo: 無効値', () => {
  assert.equal(formatAgo(NaN), '?');
  assert.equal(formatAgo(-1), '?');
});

// ─── formatBytes ────────────────────────────────────────────────────

test('formatBytes: KB/MB/GB の切り替え', () => {
  assert.equal(formatBytes(999), '999 B');
  assert.equal(formatBytes(1_500), '1.5 kB');
  assert.equal(formatBytes(1_500_000), '1.50 MB');
  assert.equal(formatBytes(2_000_000_000), '2.00 GB');
});

test('formatBytes: 無効値', () => {
  assert.equal(formatBytes(NaN), '?');
  assert.equal(formatBytes(-1), '?');
});

// ─── findLatestJsonlInSameDir ──────────────────────────────────────

test('findLatestJsonlInSameDir: 同じディレクトリ内の最新 JSONL を返す', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tl-doctor-'));
  try {
    const older = join(dir, 'a.jsonl');
    const newer = join(dir, 'b.jsonl');
    writeFileSync(older, 'x');
    // mtime を強制的に差をつけるため書き込み間隔を開けたいが、連続 write だと同 ms 。
    // ここでは newer の内容を後に書いて、後書きが newer の mtime を十分大きくする。
    const now = Date.now();
    writeFileSync(newer, 'y');
    // older の mtime を古く設定
    utimesSync(older, new Date(now - 10000), new Date(now - 10000));
    utimesSync(newer, new Date(now), new Date(now));
    const result = findLatestJsonlInSameDir(older);
    assert.ok(result);
    assert.equal(result.path, newer);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('findLatestJsonlInSameDir: 存在しないパスは null', () => {
  assert.equal(findLatestJsonlInSameDir('/does/not/exist/x.jsonl'), null);
});

// ─── isPidAlive ─────────────────────────────────────────────────────

test('isPidAlive: 自身の PID は alive', () => {
  assert.equal(isPidAlive(process.pid), true);
});

test('isPidAlive: 不正な値は false', () => {
  assert.equal(isPidAlive(0), false);
  assert.equal(isPidAlive(-1), false);
  assert.equal(isPidAlive(null), false);
  assert.equal(isPidAlive(undefined), false);
});

test('isPidAlive: 存在しない PID は false', () => {
  // 巨大な PID はほぼ確実に未使用
  assert.equal(isPidAlive(2_147_483_646), false);
});
