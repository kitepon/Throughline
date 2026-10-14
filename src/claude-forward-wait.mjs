#!/usr/bin/env node
/**
 * Stop hook（`asyncRewake: true`）— 引き継ぎ前の会話へ届いた入力を、手すきの後継へ届ける (ADR 0063)
 *
 * stdin: { session_id, hook_event_name: "Stop", stop_hook_active, ... }
 *
 * `auto-handoff enable --host claude` が登録する。番の終わりのたびに走るので、自分の置き場のフォルダが無い会話
 * （後継でない会話。ほとんどの会話）では、フォルダの有無だけを見て終わる。
 *
 * 置き場のフォルダが在る会話では、入力が届くまで待つ。届いたら stderr へ出して exit code 2 で終わる。Claude Code は、
 * `asyncRewake` の hook が exit code 2 で終わると、stderr の文を持たせて会話を起こす。
 *
 * script から起動した Claude（`claude -p`、Agent SDK）では待たない。待つと、呼び出し元の命令が返らない。
 *
 * 待っている hook は、会話が次の番へ進んでも Claude Code に止められない（実測）。次の番の終わりに立つ新しい hook が
 * 置き場に印を書き、前の hook はそれを見て退く。待っている間に次の番が始まって入力が届いた時は、前の hook が出した文を
 * Claude Code が順番待ちへ入れ、次の道具の合間に届ける（実測）。
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

// claude-forward.mjs と同じ置き場と形。速い道を保つために、ここでは import しない。
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
/** 登録する hook の timeout（秒）。install.mjs の値と合わせる。自分からは、その少し手前で終わる。 */
export const CLAUDE_FORWARD_WAIT_TIMEOUT_SECONDS = 86_400;
const POLL_MS = 1000;

/**
 * 待つ本体。試験から呼べる様に、終わり方を値で返す（process は終わらせない）。
 *
 * @returns {Promise<{code: 0|2, reason: string, text?: string, count?: number}>}
 */
export async function waitForClaudeForwards({
  sessionId,
  dir = join(homedir(), '.throughline', 'claude-auto-handoff'),
  maxWaitMs = (CLAUDE_FORWARD_WAIT_TIMEOUT_SECONDS - 300) * 1000,
  pollMs = POLL_MS,
  isOrphaned = () => process.platform !== 'win32' && process.ppid === 1,
  sleep = delay,
  now = () => Date.now(),
  token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
}) {
  const forward = await import('./claude-forward.mjs');
  const startedAt = now();
  // 前の番の終わりから待っている hook は、Claude Code が止めない。自分の印を書いて、前の hook を退かせる。
  const registered = forward.registerClaudeForwardWaiter(sessionId, token, dir);
  const end = (code, reason, extra = {}) => {
    forward.logClaudeForward({ event: 'wait-end', session_id: sessionId, reason,
      waited_s: Math.round((now() - startedAt) / 1000), ...(extra.count ? { count: extra.count } : {}) }, dir);
    return { code, reason, ...extra };
  };
  for (;;) {
    // 同じ会話で新しい待つ hook が立ったら、退く（待つのは1つだけ）。
    if (registered && forward.currentClaudeForwardWaiter(sessionId, dir) !== token) return end(0, 'superseded');
    // 自分の会話がさらに引き継がれて後継が立ったら、残った入力を今の続きの会話へ移して終わる。旧い会話は起こさない。
    if (existsSync(join(dir, `${sessionId}.json`))) {
      const { resolveClaudeAutoHandoffSuccessor } = await import('./claude-auto-handoff.mjs');
      let current = null;
      try {
        const resolved = resolveClaudeAutoHandoffSuccessor(sessionId, { dir });
        if (resolved.handed_off && resolved.current_session_id !== sessionId) current = resolved.current_session_id;
      } catch { /* 記録を読めない時は、自分の会話で受け取る */ }
      if (current) {
        const moved = forward.moveClaudeForwards({ fromSessionId: sessionId, toSessionId: current, dir });
        return end(0, 'handed-off', { count: moved });
      }
    }
    if (forward.hasPendingClaudeForwards(sessionId, dir)) {
      const claim = forward.claimClaudeForwards({ sessionId, dir });
      if (claim) {
        return { ...end(2, 'delivered', { count: claim.count }), text: claim.text, claim };
      }
    }
    if (isOrphaned()) return end(0, 'orphaned');
    if (now() - startedAt >= maxWaitMs) return end(0, 'deadline');
    await sleep(pollMs);
  }
}

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
  const dir = join(homedir(), '.throughline', 'claude-auto-handoff');
  if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId) || payload.agent_id ||
      !existsSync(join(dir, 'inbox', sessionId))) {
    process.exit(0);
  }
  const entrypoint = process.env.CLAUDE_CODE_ENTRYPOINT;
  if (typeof entrypoint === 'string' && entrypoint.startsWith('sdk-')) process.exit(0);

  const forward = await import('./claude-forward.mjs');
  const startedAt = Date.now();
  // 期限や `claude stop` で止められた時の跡（POSIX だけ。Windows は跡を残せずに止まる）。
  process.on('SIGTERM', () => {
    forward.logClaudeForward({ event: 'wait-end', session_id: sessionId, reason: 'sigterm',
      waited_s: Math.round((Date.now() - startedAt) / 1000) }, dir);
    process.exit(143);
  });
  forward.logClaudeForward({ event: 'wait-start', session_id: sessionId }, dir);
  // 会話の process が居なくなったら終わる。居ない会話へ出力すると、入力が届かないまま消える。
  const claudePid = Number(process.env.CLAUDE_PID);
  const claudeGone = () => {
    if (!Number.isSafeInteger(claudePid) || claudePid <= 0) return false;
    try { process.kill(claudePid, 0); return false; }
    catch (error) { return error.code === 'ESRCH'; }
  };
  const result = await waitForClaudeForwards({ sessionId, dir,
    isOrphaned: () => claudeGone() || (process.platform !== 'win32' && process.ppid === 1) });
  if (result.code !== 2) process.exit(0);
  // 出力を書き切ってから、受け取った入力を消して終わる。
  process.stderr.write(result.text, () => {
    forward.settleClaudeForwards(result.claim);
    forward.logClaudeForward({ event: 'delivered', via: 'stop', session_id: sessionId, count: result.claim.count,
      humans: result.claim.humans, notifications: result.claim.notifications, chars: result.claim.chars }, dir);
    process.exit(2);
  });
}

async function reportFailure(err) {
  const { recordRuntimeErrorBestEffort } = await import('./runtime-error-store.mjs');
  const { logHookFailure } = await import('./hook-failure-log.mjs');
  recordRuntimeErrorBestEffort('HOOK_CLAUDE_FORWARD_WAIT_FAILED');
  logHookFailure('HOOK_CLAUDE_FORWARD_WAIT_FAILED', err);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch(async (err) => {
    await reportFailure(err);
    process.stderr.write(`[claude-forward-wait] error: ${err.message}\n`);
    process.exit(1);
  });
}
