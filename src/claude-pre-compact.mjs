#!/usr/bin/env node
/**
 * PreCompact hook — Claude Code の自動継続の第一段 (ADR 0032)
 *
 * stdin: { session_id, transcript_path, cwd, hook_event_name, trigger, custom_instructions }
 *
 * 自動圧縮（trigger=auto）で、自動継続が有効な project の時だけ、その会話に印を残す。
 * 記憶の注入は圧縮の後の SessionStart(source=compact) が行う。
 *
 * この hook は圧縮を止めない。Claude Code は PreCompact の exit code 2 と `decision: "block"` を
 * 「圧縮を止める」と解釈するので、stdout には何も書かず、失敗した時も exit code 1 で終わる。
 */

import { pathToFileURL } from 'node:url';
import { parseHookPayload } from './hosts/index.mjs';
import { recordClaudeCompactRequest } from './claude-auto-handoff.mjs';
import { logDecision } from './decision-log.mjs';
import { recordRuntimeErrorBestEffort } from './runtime-error-store.mjs';
import { logHookFailure } from './hook-failure-log.mjs';

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
  const result = recordClaudeCompactRequest({ payload, env: process.env, now });

  logDecision({
    ts: new Date(now).toISOString(),
    phase: 'pre-compact',
    session_id: result.sessionId,
    project_path: result.projectPath ?? null,
    trigger: payload.trigger ?? null,
    auto_continuation: result.status,
    skip_reason: result.reason ?? null,
  });

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
