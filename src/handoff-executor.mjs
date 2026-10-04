/**
 * handoff-executor.mjs — 最初の UserPromptSubmit で実行する引き継ぎ本体
 *
 * 二相ハンドオフ (ADR 0014) の第二相。SessionStart が登録した pending intent を
 * 消費し、baton path 優先 → auto path の順で前任を merge して、予算内の
 * resume context を組み立てて返す。呼び出し元 (prompt-submit) が stdout へ書く。
 *
 * 幽霊セッション (transcript を生成しない SessionStart) はプロンプトを発火しない
 * ため、この経路に到達できない。= バトンも auto 前任も実体のあるセッションだけが
 * 受け取れる。
 */

import { existsSync } from 'node:fs';
import { consumeBaton } from './baton.mjs';
import { consumePendingHandoff } from './pending-handoff.mjs';
import { mergeSpecificPredecessor, resolveMergeTarget } from './session-merger.mjs';
import { backfillBodies, deriveTranscriptPath, logBackfill } from './turn-backfill.mjs';
import { buildBudgetedResumeContext, buildAutoContinuationContext } from './resume-context.mjs';
import { acceptClaudeAutoContinuation } from './claude-auto-handoff.mjs';
import { readAllSessionStates } from './state-file.mjs';

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ sessionId: string, projectPath: string, now?: number, prompt?: string|null }} params
 *   prompt は届いた指示の本文。前任が自動継続で引き継いだ会話の時に、配送の受領を照合する (ADR 0033)。
 * @returns {{
 *   attempted: boolean,            // pending 行が存在した (= newborn の初回プロンプト)
 *   triggeredPath: 'baton' | 'auto' | null,
 *   baton: object | null,          // consumeBaton の生返り値 (ログ用)
 *   pendingCreatedAt: number | null,
 *   mergeResult: object,           // mergeSpecificPredecessor の返り値 or skip
 *   injectionText: string | null,  // 予算内注入テキスト (merge 成立時のみ)
 *   injectionStats: object | null, // dropped counts 等 (ログ用)
 * }}
 */
export function executeFirstPromptHandoff(db, { sessionId, projectPath, now = Date.now(), prompt = null }) {
  const pending = consumePendingHandoff(db, { sessionId });
  if (!pending) {
    return {
      attempted: false,
      triggeredPath: null,
      baton: null,
      pendingCreatedAt: null,
      mergeResult: { merged: false, skipReason: 'not_newborn' },
      injectionText: null,
      injectionStats: null,
    };
  }

  // baton 適格性はセッション誕生時刻 (pending.createdAt) 基準。
  // 誕生後に書かれたバトンは future_baton として残置される (本来の後継のもの)。
  const baton = consumeBaton(db, { projectPath, now, bornAt: pending.createdAt });

  let triggeredPath = null;
  let mergeResult = { merged: false, skipReason: 'no_trigger' };

  if (baton.sessionId) {
    triggeredPath = 'baton';
    const { target: predecessorId } = resolveMergeTarget(db, baton.sessionId);
    mergeResult = mergeSpecificPredecessor(db, {
      newSessionId: sessionId,
      predecessorId,
      now,
    });
  } else if (pending.autoPredecessorId) {
    triggeredPath = 'auto';
    const { target: predecessorId } = resolveMergeTarget(db, pending.autoPredecessorId);
    mergeResult = mergeSpecificPredecessor(db, {
      newSessionId: sessionId,
      predecessorId,
      now,
    });
  }

  let injectionText = null;
  let injectionStats = null;

  if (mergeResult.merged) {
    const predecessorId = mergeResult.predecessorId;
    // /clear 直前ターンの取りこぼしを注入前に回収する。前任の transcript path は
    // project path から決定的に導出する — state ファイルは Stop 不発の前任
    // (まさに回収したい事例) では存在しないため補助。
    const derivedTranscriptPath = deriveTranscriptPath(projectPath, predecessorId);
    const stateTranscriptPath = readAllSessionStates().find(
      (state) => state.sessionId === predecessorId,
    )?.transcriptPath;
    // 前任が自動継続でこの会話へ引き継いだなら、止めた時点の依頼を現在地に載せる (ADR 0033)。
    // 止めたターンは Stop を通っていないので、state ファイルが無いことがある。hook が記録した
    // transcript の場所を、回収元の候補に足す。
    const autoContinuation = triggeredPath === 'baton'
      ? acceptClaudeAutoContinuation({ predecessorId: baton.sessionId, successorSessionId: sessionId, prompt, now })
      : null;
    const predecessorTranscriptPath = [derivedTranscriptPath, stateTranscriptPath, autoContinuation?.transcriptPath]
      .find((candidate) => candidate && existsSync(candidate)) ?? null;

    if (predecessorTranscriptPath) {
      try {
        const backfill = backfillBodies(db, {
          targetSessionId: sessionId,
          originSessionId: predecessorId,
          transcriptPath: predecessorTranscriptPath,
          now,
        });
        logBackfill({
          ts: new Date(now).toISOString(),
          hook: 'prompt-submit',
          session_id: sessionId,
          target: sessionId,
          origin: predecessorId,
          transcript_path: predecessorTranscriptPath,
          groups: backfill.groups,
          inserted_turns: backfill.insertedTurns,
          skipped_existing: backfill.skippedExisting,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[prompt-submit:backfill] ${message}\n`);
        logBackfill({
          ts: new Date(now).toISOString(),
          hook: 'prompt-submit',
          session_id: sessionId,
          target: sessionId,
          origin: predecessorId,
          transcript_path: predecessorTranscriptPath,
          error: message,
        });
      }
    } else {
      logBackfill({
        ts: new Date(now).toISOString(),
        hook: 'prompt-submit',
        session_id: sessionId,
        target: sessionId,
        origin: predecessorId,
        transcript_path: null,
        skip_reason: 'no_transcript_path',
      });
    }

    const budgeted = autoContinuation
      ? buildAutoContinuationContext(db, {
        sessionId,
        inFlight: autoContinuation.inFlight,
        projectPath: autoContinuation.projectPath,
      })
      : buildBudgetedResumeContext(db, {
        sessionId,
        isInheritance: true,
      });
    if (budgeted) {
      injectionText = budgeted.text;
      injectionStats = {
        total_chars: budgeted.totalChars,
        injected_l2_turns: budgeted.injectedL2Turns,
        remaining_l2_turns: budgeted.remainingL2Turns,
        older_turns: budgeted.olderTurns,
        older_summarized: budgeted.olderSummarized,
        truncated_newest_l2: budgeted.truncatedNewestL2,
        ...(autoContinuation ? { auto_handoff_id: autoContinuation.handoffId } : {}),
      };
    }
  }

  return {
    attempted: true,
    triggeredPath,
    baton,
    pendingCreatedAt: pending.createdAt,
    mergeResult,
    injectionText,
    injectionStats,
  };
}
