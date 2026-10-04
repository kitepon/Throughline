import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  HOOK_FAILURE_MESSAGE_LIMIT,
  HOOK_FAILURE_STACK_FRAMES,
  HOOK_FAILURE_STACK_FRAME_LIMIT,
  hookFailureLogPath,
  logHookFailure,
} from './hook-failure-log.mjs';

test('logHookFailureは、失敗の理由を1行のJSONで追記する', () => {
  const home = mkdtempSync(join(tmpdir(), 'tl-hook-failure-log-'));
  try {
    logHookFailure('HOOK_PROCESS_TURN_FAILED', new TypeError('first reason'), { home, now: Date.UTC(2026, 9, 4, 0, 0, 0, 5) });
    logHookFailure('HOOK_CODEX_FAILED', 'thrown string', { home, now: Date.UTC(2026, 9, 4, 0, 0, 1) });
    const lines = readFileSync(hookFailureLogPath({ home }), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(lines.length, 2);
    const { stack, ...first } = lines[0];
    assert.deepEqual({ ...first, version: 'x' }, {
      ts: '2026-10-04T00:00:00.005Z', code: 'HOOK_PROCESS_TURN_FAILED', version: 'x', name: 'TypeError', message: 'first reason',
    });
    // Errorは失敗した位置を持つ。文字列を投げた時はstackが無いので、項目ごと残さない。
    assert.equal(Array.isArray(stack) && stack.length > 0, true);
    assert.deepEqual({ ...lines[1], version: 'x' }, {
      ts: '2026-10-04T00:00:01.000Z', code: 'HOOK_CODEX_FAILED', version: 'x', name: 'string', message: 'thrown string',
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('logHookFailureは、外部CLIの失敗の理由とstderrの末尾を残す', () => {
  const home = mkdtempSync(join(tmpdir(), 'tl-hook-failure-log-'));
  try {
    const err = new Error('Codex CLI summarizer failed: exit 1');
    err.reason = 'codex_cli_failed';
    err.stderr = `${'banner '.repeat(300)}ERROR: usage limit`;
    logHookFailure('L1_SUMMARIZER_BACKEND_FAILED', err, { home });
    const [entry] = readFileSync(hookFailureLogPath({ home }), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(entry.code, 'L1_SUMMARIZER_BACKEND_FAILED');
    assert.equal(entry.message, 'Codex CLI summarizer failed: exit 1');
    assert.equal(entry.reason, 'codex_cli_failed');
    assert.equal(entry.stderr.length, HOOK_FAILURE_MESSAGE_LIMIT);
    assert.match(entry.stderr, /ERROR: usage limit$/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('logHookFailureは、どの会話の失敗かを残す', () => {
  const home = mkdtempSync(join(tmpdir(), 'tl-hook-failure-log-'));
  try {
    const withContext = new Error('with context');
    withContext.hookContext = { session_id: 'session-a', transcript_path: '/claude/projects/-tmp/session-a.jsonl' };
    logHookFailure('HOOK_PROCESS_TURN_FAILED', withContext, { home });
    // 文字列でない値と空文字は残さない（payloadを読む前の失敗では、手がかりがまだ無い）。
    const withoutContext = new Error('without context');
    withoutContext.hookContext = { session_id: '', transcript_path: undefined };
    logHookFailure('HOOK_PROCESS_TURN_FAILED', withoutContext, { home });
    const [first, second] = readFileSync(hookFailureLogPath({ home }), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(first.session_id, 'session-a');
    assert.equal(first.transcript_path, '/claude/projects/-tmp/session-a.jsonl');
    assert.equal('session_id' in second, false);
    assert.equal('transcript_path' in second, false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('logHookFailureは、失敗した位置をstackの先頭から残す', () => {
  const home = mkdtempSync(join(tmpdir(), 'tl-hook-failure-log-'));
  try {
    const err = new Error('database is locked');
    err.stack = [
      'Error: database is locked',
      '    at getDb (file:///throughline/src/db.mjs:455:5)',
      `    at ${'x'.repeat(HOOK_FAILURE_STACK_FRAME_LIMIT + 40)}`,
      ...Array.from({ length: HOOK_FAILURE_STACK_FRAMES + 3 }, (_, index) => `    at frame${index} (file:///throughline/src/a.mjs:${index}:1)`),
    ].join('\n');
    logHookFailure('HOOK_SESSION_START_FAILED', err, { home });
    const noFrames = new Error('no frames');
    noFrames.stack = 'Error: no frames';
    logHookFailure('HOOK_SESSION_START_FAILED', noFrames, { home });
    const [entry, second] = readFileSync(hookFailureLogPath({ home }), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(entry.stack.length, HOOK_FAILURE_STACK_FRAMES);
    assert.equal(entry.stack[0], 'at getDb (file:///throughline/src/db.mjs:455:5)');
    assert.equal(entry.stack[1].length, HOOK_FAILURE_STACK_FRAME_LIMIT);
    assert.equal(entry.stack[2], 'at frame0 (file:///throughline/src/a.mjs:0:1)');
    assert.equal('stack' in second, false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('logHookFailureは、長い文面を上限で切る', () => {
  const home = mkdtempSync(join(tmpdir(), 'tl-hook-failure-log-'));
  try {
    logHookFailure('HOOK_PROMPT_SUBMIT_FAILED', new Error('x'.repeat(HOOK_FAILURE_MESSAGE_LIMIT + 50)), { home });
    const [entry] = readFileSync(hookFailureLogPath({ home }), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(entry.message.length, HOOK_FAILURE_MESSAGE_LIMIT);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('logHookFailureは、書けない時にstderrへ理由を出し、例外を投げない', () => {
  const home = mkdtempSync(join(tmpdir(), 'tl-hook-failure-log-'));
  try {
    // `.throughline` をfileにして、logs directoryを作れなくする。
    writeFileSync(join(home, '.throughline'), 'not a directory', 'utf8');
    const written = [];
    logHookFailure('HOOK_SESSION_START_FAILED', new Error('reason'), { home, stderr: { write: (s) => written.push(s) } });
    assert.equal(written.length, 1);
    assert.match(written[0], /^\[hook-failure-log\] /);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
