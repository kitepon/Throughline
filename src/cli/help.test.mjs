import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const BIN_PATH = join(REPO_ROOT, 'bin/throughline.mjs');
const CODEX_HELP_COMMANDS = [
  'throughline codex-capture',
  'throughline codex-hook user-prompt-submit',
  'throughline codex-hook post-tool-use',
  'throughline codex-hook stop',
  'throughline codex-summarize',
  'throughline codex-resume',
  'throughline codex-handoff-smoke',
  'throughline codex-handoff-model-smoke',
  'throughline codex-handoff-start',
  'throughline codex-visibility-smoke',
  'throughline codex-rollback-model-visible-smoke',
  'throughline codex-restore-smoke',
  'throughline codex-restore-source-audit',
  'throughline codex-host-primitive-audit',
  'throughline codex-vscode-restore-smoke',
  'throughline codex-vscode-rollback-smoke',
  'throughline codex-threads',
];

function runThroughline(args = []) {
  return spawnSync(process.execPath, [BIN_PATH, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
}

function dispatchCommand(command) {
  return command.replace(/^throughline\s+/, '').split(/\s+/)[0];
}

test('CLI help exposes guided Codex handoff and guarded execute semantics', () => {
  const result = runThroughline(['--help']);

  assert.equal(result.status, 0, result.stderr);
  for (const command of CODEX_HELP_COMMANDS) {
    assert.match(result.stdout, new RegExp(command.replaceAll('-', '\\-')));
  }
  assert.match(result.stdout, /Fresh-thread Codex handoff start plan/);
  assert.match(result.stdout, /Use --execute to/);
  assert.match(result.stdout, /--open-host auto\|desktop\|vscode\|cli\|none/);
  assert.match(result.stdout, /throughline trim --execute/);
  assert.match(result.stdout, /throughline handoff-context \(--session <id> \| --project <path>\) --json/);
  assert.match(result.stdout, /--disclosure silent/);
  assert.match(result.stdout, /throughline latest-session --project <absolute-path> --json/);
  assert.match(result.stdout, /without\s+changing database ownership/);
  assert.match(result.stdout, /injectable DB memory/);
  assert.match(result.stdout, /matching/);
  assert.match(result.stdout, /rollout\/app-server turns/);
  assert.match(result.stdout, /--inspect-risky-rollout/);
  assert.match(result.stdout, /risk-evidence inspection/);
  assert.match(result.stdout, /automatic refresh is disabled/);
  assert.doesNotMatch(result.stdout, /at 75%/);
  assert.match(result.stdout, /throughline runtime-errors enable --json/);
  assert.match(result.stdout, /throughline self-update \[--json\]/);
  assert.match(readFileSync(BIN_PATH, 'utf8'), /case 'self-update':/);
});

test('CLI help Codex commands are dispatchable', () => {
  const bin = readFileSync(BIN_PATH, 'utf8');

  for (const command of CODEX_HELP_COMMANDS) {
    const subcommand = dispatchCommand(command);
    assert.match(bin, new RegExp(`case '${subcommand}':`), `${command} is missing dispatch`);
  }
});

test('CLI help exposes the dispatchable read-only handoff context boundary', () => {
  const bin = readFileSync(BIN_PATH, 'utf8');
  assert.match(bin, /case 'handoff-context':/);
  assert.match(bin, /case 'latest-session':/);
});
