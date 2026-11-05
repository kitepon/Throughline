/**
 * decision-log.mjs — 引き継ぎ判定ログ (~/.throughline/logs/inheritance-decision.log)
 *
 * 二相ハンドオフでは SessionStart (intent 登録) と UserPromptSubmit (consume + merge)
 * の両方が判定に関与するため、共有モジュールに切り出す。各エントリは `phase` field
 * ('session-start' | 'prompt-submit') で区別する。
 * このログは 2026-07-17 の幽霊バトン奪取 incident の一次証拠になった実績があり、
 * 事故調査の生命線。書き込み失敗は stderr に出す（黙って握りつぶさない）。
 */

import { appendBoundedLog } from './bounded-log.mjs';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

export function logDecision(entry) {
  const path = join(homedir(), '.throughline', 'logs', 'inheritance-decision.log');
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendBoundedLog(path, JSON.stringify(entry) + '\n');
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown';
    process.stderr.write(`[decision-log] ${msg}\n`);
  }
}
