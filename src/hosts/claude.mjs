/**
 * hosts/claude.mjs — Claude host adapter
 *
 * Claude は Throughline の基準 host。hook payload は snake_case のまま届き、
 * 引き継ぎ注入は UserPromptSubmit hook の stdout でモデルへ渡る。
 */
import { CLAUDE_HOST, hostOfSessionId } from './identity.mjs';

// Claude Code の背景 task 通知は user 発言として transcript に入る。識別子・出力 path・
// 定型の注記と、入力待ち時に付く端末の生出力 (`Last output:` 以降) は記憶に要らない。
// 状態・要約・Monitor の event・subagent の result だけを残す。
const TASK_NOTIFICATION_NOISE_TAGS = ['task-id', 'tool-use-id', 'output-file', 'usage', 'note', 'task-type', 'diagnostics'];

export function compactClaudeTaskNotification(text) {
  if (typeof text !== 'string' || !text.trimStart().startsWith('<task-notification>')) return text;
  const close = text.indexOf('</task-notification>');
  if (close < 0) return text;
  let block = text.slice(0, close + '</task-notification>'.length);
  for (const tag of TASK_NOTIFICATION_NOISE_TAGS) {
    block = block.replace(new RegExp(`\\n?<${tag}>[\\s\\S]*?</${tag}>`, 'g'), '');
  }
  const tail = text.slice(close + '</task-notification>'.length);
  const lastOutput = tail.search(/^Last output:/m);
  const kept = (lastOutput < 0 ? tail : tail.slice(0, lastOutput)).trim();
  return kept ? `${block}\n${kept}` : block;
}

export const claudeHostAdapter = Object.freeze({
  host: CLAUDE_HOST,
  matchesSessionId: (sessionId) => hostOfSessionId(sessionId) === CLAUDE_HOST,
  // Claude Stop payload の last_assistant_message を transcript 可視化の
  // barrier に使う (ADR 0012)。
  waitsForStopTranscriptFlush: true,
  // Claude は UserPromptSubmit stdout がそのままモデル可視 context になる。
  deliverHandoffInjection({ text, stdout = process.stdout }) {
    stdout.write(text + '\n');
    return { delivered: true };
  },
  // Claude の prompt は裸の slash command がそのまま届く。
  resolveCommandPrompt({ prompt }) {
    return prompt;
  },
  consumesHandoffAtSessionStart: false,
  afterBatonWrite() {
    return { launched: false };
  },
});
