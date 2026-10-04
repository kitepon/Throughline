#!/usr/bin/env node
/**
 * PreCompact hook — Claude Code の自動継続の第一段 (ADR 0033)
 *
 * stdin: { session_id, transcript_path, cwd, hook_event_name, trigger, custom_instructions }
 *
 * 自動圧縮（trigger=auto）で、自動継続が有効な project の時だけ、/tl と同じ印と引き継ぎの記録を残し、
 * 圧縮を止める。Claude Code は PreCompact の exit code 2 を「圧縮を止める」と解釈する。
 * 止めた後の会話は圧縮されないまま続き、次の道具の hook（PreToolUse）が作業を止める。
 *
 * 手動の /compact、無効な project、subagent の中の圧縮では、何も止めずに exit code 0 で終わる。
 * この hook 自身が失敗した時は exit code 1 で終わり、圧縮は止めない。
 */

import { pathToFileURL } from 'node:url';
import { parseHookPayload } from './hosts/index.mjs';
import { requestClaudeAutoHandoff } from './claude-auto-handoff.mjs';
import { getDb } from './db.mjs';
import { logDecision } from './decision-log.mjs';
import { recordRuntimeErrorBestEffort } from './runtime-error-store.mjs';
import { logHookFailure } from './hook-failure-log.mjs';

export const PRE_COMPACT_BLOCK_EXIT_CODE = 2;

export async function run() {
  let raw = '';
  await new Promise((resolve) => {
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      raw += chunk;
    });
    process.stdin.on('end', resolve);
  });

  const payload = parseHookPayload(raw, { env: process.env });
  const now = Date.now();
  const result = requestClaudeAutoHandoff({
    payload,
    env: process.env,
    now,
    openDb: getDb,
  });

  logDecision({
    ts: new Date(now).toISOString(),
    phase: 'pre-compact',
    session_id: result.sessionId,
    project_path: result.projectPath ?? null,
    trigger: payload.trigger ?? null,
    auto_continuation: result.status,
    handoff_id: result.handoffId ?? null,
    skip_reason: result.reason ?? null,
  });

  if (result.block) {
    process.stderr.write(`Throughlineが自動圧縮を止めました。新しい会話へ引き継ぎます（引き継ぎID: ${result.handoffId}）。\n`);
    process.exit(PRE_COMPACT_BLOCK_EXIT_CODE);
  }
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => {
    recordRuntimeErrorBestEffort('HOOK_PRE_COMPACT_FAILED');
    logHookFailure('HOOK_PRE_COMPACT_FAILED', err);
    process.stderr.write(`[pre-compact] error: ${err.message}\n`);
    process.exit(1);
  });
}
