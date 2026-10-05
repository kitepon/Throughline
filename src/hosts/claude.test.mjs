import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeHostAdapter, readClaudeRelocatedCwd } from './claude.mjs';
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

function withTranscript(lines, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'tl-claude-host-'));
  const transcriptPath = join(dir, 'transcript.jsonl');
  try {
    writeFileSync(transcriptPath, lines.join('\n'), 'utf8');
    return fn(transcriptPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Claude Desktop 2.1.286 が書く行の形（Mac で実測）。順序は2通りある。
const relocatedLine = (cwd) => JSON.stringify({ type: 'relocated', sessionId: '04bf5ab3-4b29-4b35-9b85-02a48eec51a1', relocatedCwd: cwd });
const userLine = (text) => JSON.stringify({ type: 'user', message: { role: 'user', content: text } });

test('readClaudeRelocatedCwd: 移っていない会話と読めない transcript は null', () => {
  assert.equal(readClaudeRelocatedCwd(null), null);
  assert.equal(readClaudeRelocatedCwd(join(tmpdir(), 'tl-claude-host-missing', 'none.jsonl')), null);
  withTranscript([userLine('hello'), ''], (path) => assert.equal(readClaudeRelocatedCwd(path), null));
});

test('readClaudeRelocatedCwd: 最後に移った先を返す', () => {
  withTranscript([userLine('a'), relocatedLine('/Users/kite/first'), userLine('b'), relocatedLine('/Users/kite/tl-claude-probe'),
    JSON.stringify({ type: 'agent-name', agentName: 'x' }), ''], (path) => {
    assert.equal(readClaudeRelocatedCwd(path), '/Users/kite/tl-claude-probe');
  });
  withTranscript([relocatedLine('C:\\Users\\kite_\\proj')], (path) => {
    assert.equal(readClaudeRelocatedCwd(path), 'C:\\Users\\kite_\\proj');
  });
});

test('readClaudeRelocatedCwd: 道具の出力に同じ文字列があっても、行そのものの type だけを見る', () => {
  const quoted = JSON.stringify({ type: 'user', message: { role: 'user', content: [
    { type: 'tool_result', tool_use_id: 't1', content: relocatedLine('/quoted/in/output') }] } });
  withTranscript([relocatedLine('/Users/kite/real'), quoted, '{"type":"relocated","relocatedCwd":"/partial'], (path) => {
    assert.equal(readClaudeRelocatedCwd(path), '/Users/kite/real');
  });
  withTranscript([quoted, relocatedLine('relative/path'), JSON.stringify({ type: 'relocated' })], (path) => {
    assert.equal(readClaudeRelocatedCwd(path), null);
  });
});

test('Claude completion receipts follow the project the conversation moved to (Claude Desktop)', () => {
  const scratch = '/Users/kite/Library/Application Support/Claude/scratch-workspaces/a/b/scratch-2026-10-05-ac3fa8';
  withTranscript([userLine('a'), relocatedLine('/Users/kite/tl-claude-probe'), ''], (transcriptPath) => {
    assert.equal(claudeHostAdapter.completionProjectPath({
      cwd: '/Users/kite/tl-claude-probe/sub', env: { CLAUDE_PROJECT_DIR: scratch }, transcriptPath,
    }), '/Users/kite/tl-claude-probe');
  });
  withTranscript([userLine('a'), ''], (transcriptPath) => {
    assert.equal(claudeHostAdapter.completionProjectPath({ cwd: '/work/bot/sub', env: { CLAUDE_PROJECT_DIR: '/work/bot' }, transcriptPath }), '/work/bot');
  });
});
