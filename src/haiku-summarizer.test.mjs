import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { summarizeToL1, resolveL1Ratio } from './haiku-summarizer.mjs';

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

function envWithPrependedPath(dir) {
  const env = { ...process.env };
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
  env[pathKey] = `${dir}${delimiter}${env[pathKey] ?? ''}`;
  return env;
}

test('summarizeToL1: returns empty fallback for blank input', () => {
  const result = summarizeToL1('', {
    projectPath: '/repo',
    env: { ...process.env },
  });

  assert.equal(result.summary, '(no content)');
  assert.equal(result.fromFallback, true);
  assert.equal(result.source, 'empty');
});

test('summarizeToL1: recursion guard returns raw L2 without spawning sidecar or haiku', () => {
  const result = summarizeToL1('raw turn text', {
    hostMode: 'claude-primary',
    projectPath: '/repo',
    env: {
      ...process.env,
      THROUGHLINE_IN_HAIKU_SUBPROCESS: '1',
    },
  });

  assert.equal(result.summary, 'raw turn text');
  assert.equal(result.fromFallback, true);
  assert.equal(result.source, 'recursion_guard');
});

test('summarizeToL1: Codex CLI failure falls back to Haiku path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tl-l1-haiku-'));
  try {
    makeBin(
      dir,
      'claude',
      `for await (const _chunk of process.stdin) {}
process.stdout.write('haiku summary\\n');
`,
    );
    const codex = makeBin(
      dir,
      'codex',
      `process.stderr.write('codex unavailable\\n');
process.exit(9);
`,
    );

    const result = summarizeToL1('long enough turn text', {
      hostMode: 'claude-primary',
      projectPath: '/repo',
      env: {
        ...envWithPrependedPath(dir),
        THROUGHLINE_CODEX_CLI_BIN: codex,
      },
    });

    assert.equal(result.summary, 'haiku summary');
    assert.equal(result.fromFallback, false);
    assert.equal(result.source, 'haiku');
    assert.equal(result.codexCliReason, 'codex_cli_codex_cli_failed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('summarizeToL1: THROUGHLINE_L1_MODEL / THROUGHLINE_L1_EFFORT override codex defaults', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tl-l1-model-override-'));
  try {
    const argsFile = join(dir, 'codex-args.txt');
    const codex = makeBin(
      dir,
      'codex',
      `import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(argsFile)}, process.argv.slice(2).join('\\n') + '\\n');
for await (const _chunk of process.stdin) {}
process.stdout.write('override summary\\n');
`,
    );

    const result = summarizeToL1('long enough turn text', {
      hostMode: 'codex-primary',
      projectPath: dir,
      env: {
        ...process.env,
        THROUGHLINE_CODEX_CLI_BIN: codex,
        THROUGHLINE_L1_MODEL: 'gpt-5.6-terra',
        THROUGHLINE_L1_EFFORT: 'medium',
      },
    });

    assert.equal(result.summary, 'override summary');
    const argv = readFileSync(argsFile, 'utf8').trim().split('\n');
    assert.equal(argv[argv.indexOf('-m') + 1], 'gpt-5.6-terra');
    assert.ok(argv.includes('model_reasoning_effort=medium'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('summarizeToL1: THROUGHLINE_L1_RATIO changes the target chars in the prompt', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tl-l1-ratio-'));
  try {
    const argsFile = join(dir, 'codex-args.txt');
    const codex = makeBin(
      dir,
      'codex',
      `import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(argsFile)}, process.argv.slice(2).join('\\n') + '\\n');
for await (const _chunk of process.stdin) {}
process.stdout.write('ratio summary\\n');
`,
    );

    const text = 'a'.repeat(1000);
    summarizeToL1(text, {
      hostMode: 'codex-primary',
      projectPath: dir,
      env: {
        ...process.env,
        THROUGHLINE_CODEX_CLI_BIN: codex,
        THROUGHLINE_L1_RATIO: '0.1',
      },
    });

    const argsText = readFileSync(argsFile, 'utf8');
    assert.match(argsText, /約100文字に要約/, 'ratio 0.1 of 1000 chars = 100 target chars');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveL1Ratio: default 0.2, and invalid values are explicit errors (no silent default)', () => {
  assert.equal(resolveL1Ratio({}), 0.2);
  assert.equal(resolveL1Ratio({ THROUGHLINE_L1_RATIO: '0.1' }), 0.1);
  for (const bad of ['abc', '0', '-0.2', '1.5', 'NaN']) {
    assert.throws(
      () => resolveL1Ratio({ THROUGHLINE_L1_RATIO: bad }),
      /invalid THROUGHLINE_L1_RATIO/,
      `must reject ${bad}`,
    );
  }
});

test('summarizeToL1: unknown host mode is an explicit error', () => {
  assert.throws(
    () =>
      summarizeToL1('long enough turn text', {
        projectPath: '/repo',
        env: { ...process.env },
      }),
    /requires hostMode/,
  );
});

test('summarizeToL1: codex-primary uses Codex CLI backend', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tl-l1-codex-'));
  try {
    const argsFile = join(dir, 'args.txt');
    const stdinFile = join(dir, 'stdin.txt');
    const codex = makeBin(
      dir,
      'codex',
      `import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(argsFile)}, process.argv.slice(2).join('\\n') + '\\n');
let input = '';
for await (const chunk of process.stdin) input += chunk;
writeFileSync(${JSON.stringify(stdinFile)}, input);
process.stdout.write('codex summary\\n');
`,
    );

    const result = summarizeToL1('long enough turn text', {
      hostMode: 'codex-primary',
      projectPath: dir,
      env: {
        ...process.env,
        THROUGHLINE_CODEX_CLI_BIN: codex,
      },
    });

    assert.equal(result.summary, 'codex summary');
    assert.equal(result.fromFallback, false);
    assert.equal(result.source, 'codex-cli');
    const argsText = readFileSync(argsFile, 'utf8').trim();
    const argv = argsText.split('\n');
    assert.deepEqual(argv.slice(0, 12), [
      'exec',
      '--ephemeral',
      '--ignore-user-config',
      '--ignore-rules',
      '--skip-git-repo-check',
      '--sandbox',
      'read-only',
      '-m',
      'gpt-5.6-luna',
      '-c',
      'model_reasoning_effort=low',
      '-C',
    ]);
    assert.equal(argv[12], dir);
    assert.match(argsText, /Output contract/);
    assert.equal(readFileSync(stdinFile, 'utf8'), 'long enough turn text');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('summarizeToL1: codex-primary failure is not hidden by fallback', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tl-l1-codex-fail-'));
  try {
    const codex = makeBin(
      dir,
      'codex',
      `process.stderr.write('codex failed\\n');
process.exit(42);
`,
    );
    makeBin(
      dir,
      'claude',
      `process.stdout.write('should not run\\n');
`,
    );

    assert.throws(
      () =>
        summarizeToL1('long enough turn text', {
          hostMode: 'codex-primary',
          projectPath: dir,
          env: {
            ...envWithPrependedPath(dir),
            THROUGHLINE_CODEX_CLI_BIN: codex,
          },
        }),
      (err) => {
        assert.equal(err.source, 'codex-cli');
        assert.equal(err.reason, 'codex_cli_failed');
        assert.equal(err.exitCode, 42);
        assert.match(err.stderr, /codex failed/);
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
