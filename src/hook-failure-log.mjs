/**
 * hook-failure-log.mjs — hook 失敗の理由ログ (~/.throughline/logs/hook-failures.log)
 *
 * runtime error store は外へ送れる形（定型 code と回数）だけを持つ (ADR 0025)。失敗した時の
 * 例外の文面はどこにも残らず、後から原因を追えなかった（2026-10-04、Mac と main-server の
 * 7〜8月の失敗）。このログは理由を端末内にだけ残す。runtime error の収集・送信の設定とは
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

export function hookFailureLogPath({ home = homedir() } = {}) {
  return join(home, '.throughline', 'logs', 'hook-failures.log');
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
  const path = hookFailureLogPath(home === undefined ? {} : { home });
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(entry) + '\n', 'utf8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown';
    stderr.write(`[hook-failure-log] ${msg}\n`);
  }
}
