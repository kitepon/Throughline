import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claudeHostAdapter } from './claude.mjs';
import { codexHostAdapter } from './codex.mjs';
import { cursorHostAdapter } from './cursor.mjs';
import { grokHostAdapter } from './grok.mjs';

test('Claude completion receipts follow the launched project, not the cd-tracking hook cwd', () => {
  const root = process.platform === 'win32' ? 'C:\\work\\bot' : '/work/bot';
  const sub = process.platform === 'win32' ? 'C:\\work\\bot\\repos\\tool' : '/work/bot/repos/tool';
  assert.equal(claudeHostAdapter.completionProjectPath({ cwd: sub, env: { CLAUDE_PROJECT_DIR: root } }), root);
  assert.equal(claudeHostAdapter.completionProjectPath({ cwd: sub, env: {} }), sub, 'CLAUDE_PROJECT_DIR を渡さない Claude では従来どおり');
  assert.equal(claudeHostAdapter.completionProjectPath({ cwd: sub, env: { CLAUDE_PROJECT_DIR: 'relative' } }), sub);
});

test('Codex, Grok, and Cursor completion receipts keep the hook cwd', () => {
  for (const adapter of [codexHostAdapter, grokHostAdapter, cursorHostAdapter]) {
    assert.equal(adapter.completionProjectPath({ cwd: '/work/bot', env: { CLAUDE_PROJECT_DIR: '/elsewhere' } }), '/work/bot');
  }
});
