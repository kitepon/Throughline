import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyTurnStart, publicTurnStart } from './turn-start.mjs';
import { getLogicalTurnGroups } from './transcript-reader.mjs';

const CURSOR_SELF = '<timestamp>Thursday, Oct 1, 2026, 2:55 PM (UTC)</timestamp>\n\n<user_query>Briefly inform the user about the task result and perform any follow-up actions (if needed).</user_query>';

function claudeUser(origin, text = 'hello') {
  return { type: 'user', ...(origin === undefined ? {} : { origin }), message: { role: 'user', content: [{ type: 'text', text }] } };
}

test('turn start: Claude origin.kind maps human, task notification, and auto continuation', () => {
  assert.equal(classifyTurnStart(claudeUser({ kind: 'human' }), 'hello'), 'prompt');
  assert.equal(classifyTurnStart(claudeUser({ kind: 'task-notification', producer: 'session-task' }), '<task-notification>'), 'self');
  assert.equal(classifyTurnStart(claudeUser({ kind: 'auto-continuation' }), ''), 'self');
  assert.equal(classifyTurnStart(claudeUser({ kind: 'something-new' }), 'x'), 'unknown');
  assert.equal(classifyTurnStart(claudeUser(undefined), 'x'), 'unknown', '印の無い古い transcript は推測しない');
});

test('turn start: Grok prompt_index and synthetic_reason', () => {
  assert.equal(classifyTurnStart({ type: 'user', content: '<user_query>x</user_query>', prompt_index: 0 }, 'x'), 'prompt');
  assert.equal(classifyTurnStart({ type: 'user', content: 'x', synthetic_reason: 'task_completed', prompt_index: 1 }, 'x'), 'self');
  assert.equal(classifyTurnStart({ type: 'user', content: 'x', synthetic_reason: 'system_reminder' }, 'x'), 'unknown');
  assert.equal(classifyTurnStart({ type: 'user', content: '<user_info>' }, '<user_info>'), 'unknown');
});

test('turn start: Cursor fixed self-start query only', () => {
  const cursor = (text) => ({ role: 'user', message: { content: [{ type: 'text', text }] } });
  assert.equal(classifyTurnStart(cursor(CURSOR_SELF), CURSOR_SELF), 'self');
  const prompt = '<timestamp>x</timestamp>\n<user_query>\nBriefly inform the user about the task result and perform any follow-up actions (if needed).\nThanks\n</user_query>';
  assert.equal(classifyTurnStart(cursor(prompt), prompt), 'prompt');
  assert.equal(classifyTurnStart(cursor('plain'), 'plain'), 'unknown');
});

test('turn start: public value maps legacy NULL to unknown', () => {
  assert.equal(publicTurnStart(null), 'unknown');
  assert.equal(publicTurnStart('self'), 'self');
  assert.equal(publicTurnStart('other'), 'unknown');
});

test('turn start: logical groups carry the start of the group user entry', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tl-turn-start-'));
  try {
    const path = join(dir, 't.jsonl');
    const assistant = (text) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
    writeFileSync(path, [
      claudeUser({ kind: 'human' }, 'please wait'),
      assistant('started'),
      claudeUser({ kind: 'task-notification' }, '<task-notification>\n<status>completed</status>\n</task-notification>'),
      assistant('finished'),
    ].map((row) => JSON.stringify(row)).join('\n'));
    assert.deepEqual(getLogicalTurnGroups(path).map((group) => group.user.start), ['prompt', 'self']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
