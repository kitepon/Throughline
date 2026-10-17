#!/usr/bin/env node
/**
 * PreToolUse hook — Claude Code の自動継続の第二段 (ADR 0033)
 *
 * stdin: { session_id, transcript_path, cwd, permission_mode, effort, tool_name, tool_input, ... }
 *
 * `auto-handoff enable --host claude` が登録する。道具の呼び出しのたびに走るので、引き継ぎの記録が無い
 * 会話では、記録のファイルの有無だけを見て終わる（DB も他の module も読み込まない）。
 *
 * 記録がある会話では、その道具を実行させずにターンを止め、後継を立てる worker を起動する。
 * 後継の会話では、引き継ぎ前の会話へ届いた入力が置き場で待っていれば、文脈として渡す (ADR 0063)。道具は止めない。
 * この hook 自身が失敗した時は exit code 1 で終わる。道具は止まらず、作業は続く。
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// claude-auto-handoff.mjs と同じ置き場と形。速い道を保つために、ここでは import しない。
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export async function run() {
  let raw = '';
  await new Promise((resolve) => {
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      raw += chunk;
    });
    process.stdin.on('end', resolve);
  });

  const payload = JSON.parse(raw.replace(/^﻿/, ''));
  const sessionId = payload?.session_id;
  if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId) || payload.agent_id) process.exit(0);
  const dir = join(homedir(), '.throughline', 'claude-auto-handoff');
  const hasRecord = existsSync(join(dir, `${sessionId}.json`));
  // 引き継ぎ前の会話へ届いた入力の、この会話（後継）の置き場 (ADR 0063)。
  const hasInbox = existsSync(join(dir, 'inbox', sessionId));
  if (!hasRecord && !hasInbox) process.exit(0);

  if (hasRecord) {
    const { stopClaudeTurnForHandoff } = await import('./claude-auto-handoff.mjs');
    const { logDecision } = await import('./decision-log.mjs');
    const now = Date.now();
    const output = await stopClaudeTurnForHandoff({ payload, now });
    if (output) {
      logDecision({
        ts: new Date(now).toISOString(),
        phase: output.continue === false ? 'pre-tool-use-stop' : 'pre-tool-use-handoff-failed',
        session_id: sessionId,
        tool_name: payload.tool_name ?? null,
      });
      process.stdout.write(`${JSON.stringify(output)}\n`);
      process.exit(0);
    }
  }

  // 作業中の後継へ、置き場で待っている入力を、次の道具の前に文脈として渡す。道具は止めない。
  if (hasInbox) {
    const { takeClaudeForwardsAsContext } = await import('./claude-forward.mjs');
    const taken = takeClaudeForwardsAsContext({ sessionId, via: 'pre-tool-use' });
    if (taken) {
      const output = { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: taken.text } };
      await new Promise(resolve => process.stdout.write(`${JSON.stringify(output)}\n`, resolve));
      taken.done();
    }
  }
  process.exit(0);
}

async function reportFailure(err) {
  const { recordRuntimeErrorBestEffort } = await import('./runtime-error-store.mjs');
  const { logHookFailure } = await import('./hook-failure-log.mjs');
  recordRuntimeErrorBestEffort('HOOK_PRE_TOOL_USE_FAILED');
  logHookFailure('HOOK_PRE_TOOL_USE_FAILED', err);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch(async (err) => {
    await reportFailure(err);
    process.stderr.write(`[pre-tool-use] error: ${err.message}\n`);
    process.exit(1);
  });
}
