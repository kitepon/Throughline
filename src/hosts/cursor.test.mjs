import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import {
  deriveCursorTranscriptPath,
  encodeCursorProjectDir,
  isCursorEnvelope,
  normalizeHookPayload,
  parseHookPayload,
} from './index.mjs';

test('parseHookPayload accepts one leading BOM and preserves BOM inside prompt text', () => {
  const raw = JSON.stringify({
    conversation_id: 'cursor-bom',
    hook_event_name: 'beforeSubmitPrompt',
    workspace_roots: ['/project'],
    prompt: 'keep \uFEFF in text',
  });
  const expected = parseHookPayload(raw);
  assert.deepEqual(parseHookPayload('\uFEFF' + raw), expected);
  assert.equal(expected.session_id, 'cursor:cursor-bom');
  assert.equal(expected.prompt, 'keep \uFEFF in text');
  assert.throws(() => parseHookPayload('\uFEFF\uFEFF' + raw), SyntaxError);
  assert.throws(() => parseHookPayload('\uFEFF{"conversation_id":'), SyntaxError);
});

test('isCursorEnvelope detects Cursor events and cursor_version', () => {
  assert.equal(
    isCursorEnvelope({
      hook_event_name: 'sessionStart',
      session_id: '7face712-ef58-40d7-b71e-b71091dfee5c',
      workspace_roots: ['/Users/kite/Developer/dotagents'],
    }),
    true,
  );
  assert.equal(
    isCursorEnvelope({
      cursor_version: '1.7.2',
      conversation_id: '7face712-ef58-40d7-b71e-b71091dfee5c',
    }),
    true,
  );
  assert.equal(
    isCursorEnvelope({
      session_id: 'claude-session',
      hook_event_name: 'SessionStart',
    }),
    false,
  );
  assert.equal(
    isCursorEnvelope({
      sessionId: '01a00aa2-dead-beef',
      hookEventName: 'session_start',
    }),
    false,
  );
});

test('normalizeHookPayload prefixes cursor: and derives agent-transcripts path', () => {
  const home = '/tmp/tl-home';
  const cwd = '/Users/kite/Developer/dotagents';
  const payload = normalizeHookPayload(
    {
      conversation_id: '7face712-ef58-40d7-b71e-b71091dfee5c',
      hook_event_name: 'beforeSubmitPrompt',
      workspace_roots: [cwd],
      prompt: '/tl',
      cursor_version: '1.7.2',
    },
    { home },
  );
  assert.equal(payload.session_id, 'cursor:7face712-ef58-40d7-b71e-b71091dfee5c');
  assert.equal(payload.cwd, cwd);
  assert.equal(payload.prompt, '/tl');
  assert.equal(
    payload.transcript_path,
    join(
      home,
      '.cursor',
      'projects',
      'Users-kite-Developer-dotagents',
      'agent-transcripts',
      '7face712-ef58-40d7-b71e-b71091dfee5c',
      '7face712-ef58-40d7-b71e-b71091dfee5c.jsonl',
    ),
  );
  assert.equal(
    deriveCursorTranscriptPath(cwd, 'cursor:7face712-ef58-40d7-b71e-b71091dfee5c', { home }),
    payload.transcript_path,
  );
});

test('normalizeHookPayload strips bc- prefix and keeps payload transcript_path', () => {
  const home = '/tmp/tl-home';
  const given = '/tmp/given.jsonl';
  const payload = normalizeHookPayload(
    {
      conversation_id: 'bc-7face712-ef58-40d7-b71e-b71091dfee5c',
      hook_event_name: 'stop',
      cwd: '/Users/kite/Developer/dotagents',
      transcript_path: given,
      status: 'completed',
    },
    { home },
  );
  assert.equal(payload.session_id, 'cursor:7face712-ef58-40d7-b71e-b71091dfee5c');
  assert.equal(payload.transcript_path, given);
});

test('encodeCursorProjectDir matches ~/.cursor/projects slug', () => {
  assert.equal(
    encodeCursorProjectDir('/Users/kite/Developer/dotagents'),
    'Users-kite-Developer-dotagents',
  );
  assert.equal(
    encodeCursorProjectDir(String.raw`C:\Users\kite_\Developer\dotagents`),
    'C-Users-kite-Developer-dotagents',
  );
  assert.equal(
    encodeCursorProjectDir(String.raw`C:\Users\kite_\.cache\aiterm-branch-test\steer-test`),
    'C-Users-kite-cache-aiterm-branch-test-steer-test',
  );
  assert.equal(encodeCursorProjectDir('/work/part_with.dot space/'), 'work-part-with-dot-space');
});
