/**
 * hook-failure-log.mjs — hook 失敗の理由ログ (~/.throughline/logs/hook-failures.log)
 *
 * runtime error store は外へ送れる形（定型 code と回数）だけを持つ (ADR 0025)。失敗した時の
 * 例外の文面はどこにも残らず、後から原因を追えなかった（2026-10-04、Mac と main-server の
 * 7〜8月の失敗）。このログは理由と失敗した位置（stack の先頭）を端末内にだけ残す。runtime error の収集・送信の設定とは
 * 独立で、外へは送らない。
 * 書き込み失敗は stderr に出す（黙って握りつぶさない）。
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const PACKAGE_VERSION = require('../package.json').version;

export const HOOK_FAILURE_MESSAGE_LIMIT = 1000;
export const HOOK_FAILURE_STACK_FRAMES = 6;
export const HOOK_FAILURE_STACK_FRAME_LIMIT = 300;

export function hookFailureLogPath({ home = homedir() } = {}) {
  return join(home, '.throughline', 'logs', 'hook-failures.log');
}

function stackFrames(error) {
  if (!(error instanceof Error) || typeof error.stack !== 'string') return [];
  return error.stack
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('at '))
    .slice(0, HOOK_FAILURE_STACK_FRAMES)
    .map((line) => line.slice(0, HOOK_FAILURE_STACK_FRAME_LIMIT));
}

/**
 * @param {string} code runtime error の定型 code（例: HOOK_PROCESS_TURN_FAILED）
 * @param {unknown} error 失敗の原因
 * @param {{ home?: string, now?: number, stderr?: { write: (s: string) => unknown } }} [options]
 */
export function logHookFailure(code, error, { home, now = Date.now(), stderr = process.stderr } = {}) {
  const message = error instanceof Error ? error.message : String(error);
  const entry = {
    ts: new Date(now).toISOString(),
    code,
    version: PACKAGE_VERSION,
    name: error instanceof Error ? error.name : typeof error,
    message: message.slice(0, HOOK_FAILURE_MESSAGE_LIMIT),
  };
  // 失敗した位置を残す。`database is locked` のような文面だけでは、DB を開く時か書く時か、
  // どの処理で落ちたかが分からない（2026-10-04、Windows の SessionStart と UserPromptSubmit の失敗）。
  const frames = stackFrames(error);
  if (frames.length > 0) entry.stack = frames;
  // SQLite の失敗は、文面が同じでも番号で原因が分かれる（`disk I/O error` は 1546 なら索引の切り詰め、
  // 522 なら読み取り）。node:sqlite が付ける拡張 code を残す。
  if (typeof error?.errcode === 'number') entry.errcode = error.errcode;
  // どの会話の失敗かを残す（errorが `hookContext` を持つ時）。回数と文面だけでは、失敗した会話を
  // 端末の他の記録から探すことになる。
  const context = error?.hookContext;
  if (typeof context?.session_id === 'string' && context.session_id) entry.session_id = context.session_id;
  if (typeof context?.transcript_path === 'string' && context.transcript_path) {
    entry.transcript_path = context.transcript_path;
  }
  // 不正な合図の形（errorが `hookIdentity` を持つ時）。文面が同じ失敗でも、どの値が不正だったかを残す。
  // 値は呼び出し側が ID・種類・「絶対 path かどうか」へ直してある。ここでは短い文字列だけを通す。
  const identity = error?.hookIdentity;
  if (identity && typeof identity === 'object') {
    const kept = Object.entries(identity).filter(([, value]) => typeof value === 'string' && value.length <= 80);
    if (kept.length > 0) entry.identity = Object.fromEntries(kept);
  }
  // 外部 CLI の失敗は、message が終了 code だけになる。理由（reason）と CLI の stderr の末尾も残す
  // （CLI は先頭に起動情報を出し、失敗の理由は末尾に出す）。
  if (typeof error?.reason === 'string' && error.reason) entry.reason = error.reason;
  if (typeof error?.stderr === 'string' && error.stderr) {
    entry.stderr = error.stderr.slice(-HOOK_FAILURE_MESSAGE_LIMIT);
  }
  const path = hookFailureLogPath(home === undefined ? {} : { home });
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(entry) + '\n', 'utf8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown';
    stderr.write(`[hook-failure-log] ${msg}\n`);
  }
}
