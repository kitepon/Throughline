/**
 * l1-backend-recovery.mjs — L1 要約の backend（Codex CLI）が失敗してから、復帰を確認できたかの記録 (ADR 0041)
 *
 * Codex Stop の要約は外部 CLI を呼ぶ。通信の断、利用上限、認証切れ、利用者の取り消しでも失敗する。
 * 会話の取り込みは済んでいて、要約は次の Stop がやり直すので、1回ごとの失敗は修理の対象として数えない。
 * 最初の失敗から期限（24時間）を過ぎても成功を確認できていない時だけ、runtime error として数える。
 *
 * 端末ごとに1つのファイル（~/.throughline/l1-backend-recovery.json）に、成功を確認できていない間の
 * 最初と最後の失敗の時刻だけを持つ。会話の内容も失敗の文面も書かない（文面は hook-failures.log に残る）。
 * 読み書きの失敗は stderr に出し、hook の結果を変えない。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const L1_BACKEND_RECOVERY_SCHEMA = 'throughline.l1_backend_recovery.v1';
export const L1_BACKEND_UNRECOVERED_MS = 24 * 60 * 60 * 1000;

export function l1BackendRecoveryPath({ home = homedir() } = {}) {
  return join(home, '.throughline', 'l1-backend-recovery.json');
}

function read(path) {
  try {
    const state = JSON.parse(readFileSync(path, 'utf8'));
    if (state?.schema !== L1_BACKEND_RECOVERY_SCHEMA || !Number.isFinite(state.first_failure_at)) return null;
    return state;
  } catch (error) {
    if (error.code !== 'ENOENT') process.stderr.write(`[l1-backend-recovery] ${error.message}\n`);
    return null;
  }
}

/**
 * backend の失敗を1回記す。最初の失敗から期限を過ぎていれば unrecovered を返す。
 * @returns {{ unrecovered: boolean, firstFailureAt: number|null }}
 */
export function noteL1BackendFailure({ home, now = Date.now() } = {}) {
  const path = l1BackendRecoveryPath({ home });
  try {
    const previous = read(path);
    const firstFailureAt = previous?.first_failure_at ?? now;
    const unrecovered = now - firstFailureAt >= L1_BACKEND_UNRECOVERED_MS;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify({ schema: L1_BACKEND_RECOVERY_SCHEMA, first_failure_at: firstFailureAt,
      last_failure_at: now, reported: Boolean(previous?.reported) || unrecovered })}\n`, { mode: 0o600 });
    renameSync(temporary, path);
    return { unrecovered, firstFailureAt };
  } catch (error) {
    process.stderr.write(`[l1-backend-recovery] ${error.message}\n`);
    return { unrecovered: false, firstFailureAt: null };
  }
}

/**
 * backend が要約を返した。失敗の記録があれば消す。期限を過ぎて runtime error に数えていた時は reported を返す。
 * 記録が無い時（ふだん）は、ファイルの有無を1回見るだけで終わる。
 * @returns {{ recovered: boolean, reported: boolean }}
 */
export function noteL1BackendSuccess({ home } = {}) {
  const path = l1BackendRecoveryPath({ home });
  if (!existsSync(path)) return { recovered: false, reported: false };
  try {
    const previous = read(path);
    rmSync(path, { force: true });
    return { recovered: true, reported: Boolean(previous?.reported) };
  } catch (error) {
    process.stderr.write(`[l1-backend-recovery] ${error.message}\n`);
    return { recovered: false, reported: false };
  }
}
