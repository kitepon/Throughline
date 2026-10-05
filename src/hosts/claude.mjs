/**
 * hosts/claude.mjs — Claude host adapter
 *
 * Claude は Throughline の基準 host。hook payload は snake_case のまま届き、
 * 引き継ぎ注入は UserPromptSubmit hook の stdout でモデルへ渡る。
 */
import { readFileSync } from 'node:fs';
import { isAbsolute, posix, win32 } from 'node:path';
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

// 別の会話から届いた発言（cross-session messaging、Throughline の自動継続の指示）には、Claude Code が
// 毎回同じ注意書きを後ろに付ける。記憶には送り主の行と本文だけを残す。
const PEER_MESSAGE_PREFIX = 'Another Claude session sent a message:';
const PEER_MESSAGE_NOTE = '\n\nThis came from another Claude session';
export function compactClaudePeerMessage(text) {
  if (typeof text !== 'string' || !text.startsWith(PEER_MESSAGE_PREFIX)) return text;
  const note = text.lastIndexOf(PEER_MESSAGE_NOTE);
  return note < 0 ? text : text.slice(0, note);
}

// Claude Desktop は「フォルダなし」で始めた会話を、後から実在の project へ移せる。移すと transcript に
// `{"type":"relocated","relocatedCwd":"<移った先>"}` の行が入り、transcript 自体も移った先の project の
// 置き場へ移る。hook へ渡る CLAUDE_PROJECT_DIR は、移る前の場所のまま残る（2.1.286 で実測）。
const RELOCATED_MARKER = '"relocated"';

/**
 * 会話が最後に移った先。移っていない会話、transcript が読めない時は null。
 * @param {string | null | undefined} transcriptPath
 * @returns {string | null}
 */
export function readClaudeRelocatedCwd(transcriptPath) {
  if (typeof transcriptPath !== 'string' || !transcriptPath) return null;
  let raw;
  try { raw = readFileSync(transcriptPath, 'utf8'); }
  catch { return null; }
  // 道具の出力が同じ文字列を含むことがある。行を JSON として読み、行そのものの type で確かめる。
  for (let end = raw.length; end > 0;) {
    const marker = raw.lastIndexOf(RELOCATED_MARKER, end - 1);
    if (marker < 0) return null;
    const lineStart = raw.lastIndexOf('\n', marker) + 1;
    const newline = raw.indexOf('\n', marker);
    const line = raw.slice(lineStart, newline < 0 ? raw.length : newline);
    try {
      const entry = JSON.parse(line);
      const moved = entry?.type === 'relocated' ? entry.relocatedCwd : null;
      if (typeof moved === 'string' && (posix.isAbsolute(moved) || win32.isAbsolute(moved))) return moved;
    } catch {
      // 書きかけの行。前の行を探す。
    }
    end = lineStart;
  }
  return null;
}

export const claudeHostAdapter = Object.freeze({
  host: CLAUDE_HOST,
  matchesSessionId: (sessionId) => hostOfSessionId(sessionId) === CLAUDE_HOST,
  // Claude Stop payload の last_assistant_message を transcript 可視化の
  // barrier に使う (ADR 0012)。
  waitsForStopTranscriptFlush: true,
  // 完了受領はセッションを起動した project に書く。hook payload の cwd は Bash の cd に
  // 追従するため、作業中に下位ディレクトリへ移ると起動 project の feed から漏れる。
  // Claude Code は hook の環境変数 CLAUDE_PROJECT_DIR に起動 project を渡す。
  // 会話が別の project へ移っている時は、移った先を使う（CLAUDE_PROJECT_DIR は移る前のまま）。
  completionProjectPath({ cwd, env, transcriptPath }) {
    const relocated = readClaudeRelocatedCwd(transcriptPath);
    if (relocated) return relocated;
    const projectDir = env?.CLAUDE_PROJECT_DIR;
    return typeof projectDir === 'string' && isAbsolute(projectDir) ? projectDir : cwd;
  },
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
