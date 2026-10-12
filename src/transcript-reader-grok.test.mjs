import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getLogicalTurnGroups, isGrokHostWrittenUserEntry, readTranscript } from './transcript-reader.mjs';

test('readTranscript accepts Grok chat_history.jsonl user/assistant rows', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tl-grok-transcript-'));
  const path = join(dir, 'chat_history.jsonl');
  writeFileSync(
    path,
    [
      JSON.stringify({ type: 'system', content: 'ignore' }),
      JSON.stringify({ type: 'user', content: [{ type: 'text', text: 'hello grok' }] }),
      JSON.stringify({ type: 'assistant', content: 'captured reply' }),
      JSON.stringify({ type: 'tool_result', content: 'not a turn' }),
    ].join('\n'),
  );
  try {
    const turns = readTranscript(path);
    assert.deepEqual(
      turns.map((t) => ({ role: t.role, content: t.content })),
      [
        { role: 'user', content: 'hello grok' },
        { role: 'assistant', content: 'captured reply' },
      ],
    );
    const groups = getLogicalTurnGroups(path);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].user.content, 'hello grok');
    assert.equal(groups[0].representative.content, 'captured reply');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function withGrokHistory(rows, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'tl-grok-transcript-'));
  const path = join(dir, 'chat_history.jsonl');
  writeFileSync(path, rows.map((row) => JSON.stringify(row)).join('\n'));
  try {
    return fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const grokUser = (text, extra = {}) => ({ type: 'user', content: [{ type: 'text', text }], ...extra });
const grokAssistant = (text) => ({ type: 'assistant', content: text, model_id: 'm' });

test('Grok が自分で書いた user 行（system_reminder・compaction_meta）は、ターンの始まりにも本文にもしない。番号は進める', () => {
  withGrokHistory([
    { type: 'system', content: 'system prompt' },
    grokUser('preamble'),
    grokUser('reminder before the prompt', { synthetic_reason: 'system_reminder' }),
    grokUser('request one', { prompt_index: 0 }),
    grokUser('reminder right after the prompt', { synthetic_reason: 'system_reminder' }),
    grokAssistant('working'),
    { type: 'tool_result', tool_call_id: 't', content: 'out' },
    grokUser('reminder in the middle of the turn', { synthetic_reason: 'system_reminder' }),
    grokAssistant('answer one'),
    grokUser('background task finished', { synthetic_reason: 'task_completed' }),
    grokAssistant('answer to the notification'),
  ], (path) => {
    assert.deepEqual(
      readTranscript(path).map((t) => [t.turn_number, t.role, t.content]),
      [
        [0, 'user', 'preamble'],
        [2, 'user', 'request one'],
        [4, 'assistant', 'working'],
        [6, 'assistant', 'answer one'],
        [7, 'user', 'background task finished'],
        [8, 'assistant', 'answer to the notification'],
      ],
    );
    const groups = getLogicalTurnGroups(path);
    assert.deepEqual(
      groups.map((g) => [g.user.content, g.user.start, g.fragments.map((f) => f.index), g.representative.index]),
      [
        ['request one', 'prompt', [4, 6], 6],
        ['background task finished', 'self', [8], 8],
      ],
    );
  });
});

test('Grok の自動圧縮で書き直された chat_history は、要約の行を飛ばして、残った user 行からのターンとして読む', () => {
  withGrokHistory([
    { type: 'system', content: 'system prompt' },
    grokUser('summary of the conversation so far', { synthetic_reason: 'compaction_meta' }),
    grokUser('line kept by the compaction'),
    grokUser('instructions to continue', { synthetic_reason: 'compaction_meta' }),
    grokUser('reminder', { synthetic_reason: 'system_reminder' }),
    grokAssistant('continuing'),
    grokAssistant('final answer'),
  ], (path) => {
    const groups = getLogicalTurnGroups(path);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].user.content, 'line kept by the compaction');
    assert.equal(groups[0].user.start, 'unknown');
    assert.deepEqual(groups[0].fragments.map((f) => f.index), [4, 5]);
  });
});

test('isGrokHostWrittenUserEntry は Grok の印だけを見る。Claude の行と、知らない印の行は対象にしない', () => {
  assert.equal(isGrokHostWrittenUserEntry(grokUser('x', { synthetic_reason: 'system_reminder' })), true);
  assert.equal(isGrokHostWrittenUserEntry(grokUser('x', { synthetic_reason: 'compaction_meta' })), true);
  assert.equal(isGrokHostWrittenUserEntry(grokUser('x', { synthetic_reason: 'task_completed' })), false);
  assert.equal(isGrokHostWrittenUserEntry(grokUser('x', { synthetic_reason: 'something_new' })), false);
  assert.equal(isGrokHostWrittenUserEntry(grokUser('x', { prompt_index: 3 })), false);
  assert.equal(isGrokHostWrittenUserEntry({ type: 'assistant', content: 'x', synthetic_reason: 'system_reminder' }), false);
  assert.equal(isGrokHostWrittenUserEntry({
    type: 'user', synthetic_reason: 'system_reminder', message: { role: 'user', content: [{ type: 'text', text: 'x' }] },
  }), false);
});
