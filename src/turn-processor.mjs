#!/usr/bin/env node
/**
 * Stop hook — L1 要約生成 + L2 本文保存 + turn_number 確定
 *
 * stdin: { session_id, transcript_path }
 * 処理:
 *   0. 【再帰ガード】環境変数 THROUGHLINE_IN_HAIKU_SUBPROCESS=1 が立っていたら即 exit
 *      （Haiku 要約用の claude -p subprocess 内で自分自身の Stop hook として起動された場合）
 *   1. resolveMergeTarget で「実書き込み先 (target) / origin」を解決
 *      （input session が別セッションに合流済みなら合流先に書く）
 *   2. transcript 全体を論理ターン群で走査し、未捕捉の完了ターンを bodies へ
 *      一括回収する (turn-backfill.mjs、docs/12 B-1)。回収実績は backfill.log に記録
 *   3. （旧: 最後の 1 ペアのみ保存 — Stop 空振りで永久穴が生じたため全走査化）
 *   4. 【遅延要約】target 配下の bodies ターン数 (distinct origin×turn) が
 *      WINDOW (=20) を超えていたら、最古の未要約ターンを 1 件だけ
 *      Haiku 4.5 で要約 → skeletons (L1) に INSERT。
 *      20 ターン以内で作業が終わるケースでは Haiku コスト 0。
 *      /clear 跨ぎでも同様に、合流後のターン総数が 20 超えた時点から逐次発火。
 *      失敗時は L2 全文をそのまま L1 に入れる（情報欠損ゼロ）
 *   5. turn_number=NULL の details レコードを確定 (L3)
 *
 * schema v4 以降で動作。judgments テーブルは廃止済み。
 */

// ★★★ 再帰暴走ガード ★★★
// haiku-summarizer が spawn する claude -p は独立した Claude Code セッションで、
// 同じ .claude/settings.json を読んで自分の Stop hook を起動する。放置すると
// turn-processor → claude -p → turn-processor → claude -p → ... の無限再帰で
// 大量の node プロセスが生まれ API 500 を引き起こす。
// haiku-summarizer が spawn 時に env.THROUGHLINE_IN_HAIKU_SUBPROCESS=1 を設定するので
// ここで即検出して exit する。env は child_process.spawn で継承される。

import { getDb } from './db.mjs';
import {
  readRawEntries,
  readLatestLogicalTurnCompletions,
  sliceCurrentTurnEntries,
  extractDetailBlocks,
} from './transcript-reader.mjs';
import { backfillBodies, logBackfill } from './turn-backfill.mjs';
import { resolveMergeTarget } from './session-merger.mjs';
import { writeSessionState } from './state-file.mjs';
import { summarizeToL1 } from './haiku-summarizer.mjs';
import { ensureMonitorTaskFile } from './vscode-task.mjs';
import { readLatestUsage } from './transcript-usage.mjs';
import { pathToFileURL } from 'node:url';
import { recordRuntimeErrorBestEffort } from './runtime-error-store.mjs';
import { writeCompletedTurnReceipt } from './completed-turn-receipts.mjs';
import { hostAdapterForSessionId, normalizeHookPayload } from './hosts/index.mjs';

/** 直近 N ターンは bodies を生で残し、それより古いものだけ L1 要約する。 */
export const L2_WINDOW = 20;
export const CLAUDE_STOP_TRANSCRIPT_FLUSH_TIMEOUT_MS = 2_000;
export const CLAUDE_STOP_TRANSCRIPT_FLUSH_INTERVAL_MS = 25;

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

/**
 * Claude Stop payloadのassistant identityがtranscriptへ永続化されるまで待つ。
 * markerは本文ソースにせず、transcript可視化のbarrierにだけ使う。
 *
 * 完了したturnは通常latest user groupにある。Stopの直後に次のuser行（queueから届いた入力）が
 * 書かれると、latestは次のturnになり、完了したturnは1つ前のgroupへ移る。この時だけ、
 * 1つ前のgroupを採用する（ADR 0026）。条件は次の全て:
 * - latest groupにassistant断片がまだ無い（次のturnは本文を書いていない）
 * - 1つ前のgroupの本文がmarkerと一致する
 * - そのturnがまだDBに捕捉されていない（捕捉済みの同文answerは、今回のStopの完了ではない）
 */
export async function waitForClaudeStopTranscriptFlush({
  transcriptPath,
  lastAssistantMessage,
  timeoutMs = CLAUDE_STOP_TRANSCRIPT_FLUSH_TIMEOUT_MS,
  intervalMs = CLAUDE_STOP_TRANSCRIPT_FLUSH_INTERVAL_MS,
  readCompletion,
  readCompletions = readLatestLogicalTurnCompletions,
  isTurnCaptured = () => true,
  now = Date.now,
  wait = delay,
}) {
  if (typeof lastAssistantMessage !== 'string' || lastAssistantMessage.length === 0) {
    return { status: 'marker_unavailable' };
  }
  const read = readCompletion
    ? () => ({ latest: readCompletion(transcriptPath), previous: null })
    : () => readCompletions(transcriptPath);
  const ready = (completion) => ({
    status: 'ready',
    userTurnNumber: completion.userTurnNumber,
    assistantTurnNumber: completion.assistantTurnNumber,
  });
  const deadline = now() + timeoutMs;
  for (;;) {
    const { latest, previous } = read() ?? { latest: null, previous: null };
    if (latest?.assistantContent === lastAssistantMessage) return ready(latest);
    if (previous?.assistantContent === lastAssistantMessage &&
      latest?.fragmentTurnNumbers?.length === 0 &&
      !isTurnCaptured(previous.fragmentTurnNumbers)) {
      return ready(previous);
    }
    const remaining = deadline - now();
    if (remaining <= 0) {
      throw new Error('Claude Stop transcript completion was not visible before deadline');
    }
    await wait(Math.min(intervalMs, remaining));
  }
}

/**
 * originのtranscript上のturn（assistant断片のindex群）が、既にbodiesへ捕捉されているかを返す。
 * backfillBodies の「部分捕捉済み群」と同じ判定。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} origin
 * @param {number[]} fragmentTurnNumbers
 */
export function isLogicalTurnCaptured(db, origin, fragmentTurnNumbers) {
  const find = db.prepare('SELECT 1 FROM bodies WHERE origin_session_id = ? AND turn_number = ? LIMIT 1');
  return fragmentTurnNumbers.some((turnNumber) => find.get(origin, turnNumber) !== undefined);
}

/**
 * target 配下の distinct (origin_session_id, turn_number) ターン数を返す。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} target
 */
export function countDistinctBodyTurns(db, target) {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS c FROM (
         SELECT DISTINCT origin_session_id, turn_number
         FROM bodies
         WHERE session_id = ?
       )`,
    )
    .get(target);
  return row?.c ?? 0;
}

/**
 * bodies に存在し skeletons に未登録の最古ターンを 1 件返す。
 * 遅延要約のターゲット選択に使う。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} target
 * @returns {{ origin_session_id: string, turn_number: number, created_at: number } | null}
 */
export function pickOldestUnsummarizedTurn(db, target) {
  const row = db
    .prepare(
      `SELECT b.origin_session_id, b.turn_number, MIN(b.created_at) AS created_at
       FROM bodies b
       WHERE b.session_id = ?
         AND NOT EXISTS (
           SELECT 1 FROM skeletons s
           WHERE s.session_id = b.session_id
             AND s.origin_session_id = b.origin_session_id
             AND s.turn_number = b.turn_number
         )
       GROUP BY b.origin_session_id, b.turn_number
       ORDER BY created_at ASC
       LIMIT 1`,
    )
    .get(target);
  return row ?? null;
}

/**
 * L2 commit 済みの completed pair だけを Claude receipt store へ publish する。
 * L1/L3 より前に呼び、receipt の失敗は呼び出し元へそのまま伝える。
 */
export function publishCapturedClaudeCompletionReceipt(db, {
  target,
  origin,
  turnNumber,
  projectPath,
  receiptOptions,
}) {
  const completedPair = db.prepare(
    `SELECT role, text, created_at FROM bodies
     WHERE session_id = ? AND origin_session_id = ? AND turn_number = ? AND role IN ('user', 'assistant')`,
  ).all(target, origin, turnNumber);
  const completedUser = completedPair.find((row) => row.role === 'user');
  const completedAssistant = completedPair.find((row) => row.role === 'assistant');
  if (!completedUser || !completedAssistant) {
    throw new Error('completed pair was not captured before receipt publication');
  }
  return writeCompletedTurnReceipt({
    projectPath,
    targetSessionId: target,
    originSessionId: origin,
    userBody: completedUser.text,
    assistantBody: completedAssistant.text,
    completedAt: completedAssistant.created_at,
  }, receiptOptions);
}

/**
 * user と assistant のペアを結合して L2 要約用テキストを作る。
 * @param {{content: string} | null} userTurn
 * @param {{content: string} | null} assistantTurn
 * @returns {string}
 */
function buildL2ForSummary(userTurn, assistantTurn) {
  const parts = [];
  if (userTurn?.content) parts.push(`[user]: ${userTurn.content}`);
  if (assistantTurn?.content) parts.push(`[assistant]: ${assistantTurn.content}`);
  return parts.join('\n\n');
}

export async function run() {
  if (process.env.THROUGHLINE_IN_HAIKU_SUBPROCESS === '1') {
    process.exit(0);
  }

  let raw = '';
  await new Promise((resolve) => {
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      raw += chunk;
    });
    process.stdin.on('end', resolve);
  });

  const payload = normalizeHookPayload(JSON.parse(raw || '{}'), { env: process.env });
  const { session_id, transcript_path, cwd, last_assistant_message } = payload;
  if (!session_id) throw new Error('Missing session_id in Stop payload');

  // VSCode で開かれたプロジェクトに .vscode/tasks.json を自動プロビジョニングする。
  // 2 回目以降は冪等性チェックで即 return するので毎ターン走っても安全。
  // 失敗しても主処理は継続させるため try/catch でラップ。
  try {
    ensureMonitorTaskFile({ cwd, env: process.env });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown';
    process.stderr.write(`[vscode-task] ${msg}\n`);
  }

  const db = getDb();
  // merge target 解決: 入力 session が既に合流済みなら target = 合流先
  const { target, origin } = resolveMergeTarget(db, session_id);

  if (hostAdapterForSessionId(session_id).waitsForStopTranscriptFlush) {
    await waitForClaudeStopTranscriptFlush({
      transcriptPath: transcript_path,
      lastAssistantMessage: last_assistant_message,
      isTurnCaptured: (fragmentTurnNumbers) => isLogicalTurnCaptured(db, origin, fragmentTurnNumbers),
    });
  }

  // Stop hook 時点で state ファイルを更新 → token-monitor の「アクティブ行」判定が
  // アシスタント応答終了時刻まで追従する
  writeSessionState({
    sessionId: session_id,
    projectPath: cwd ?? process.cwd(),
    transcriptPath: transcript_path ?? null,
    pid: process.ppid,
  });

  const now = Date.now();

  // target の sessions 行を upsert
  const existing = db
    .prepare('SELECT session_id FROM sessions WHERE session_id = ?')
    .get(target);
  if (!existing) {
    db.prepare(
      `INSERT INTO sessions (session_id, project_path, status, created_at, updated_at)
       VALUES (?, ?, 'active', ?, ?)`,
    ).run(target, cwd ?? process.cwd(), now, now);
  } else {
    db.prepare('UPDATE sessions SET updated_at = ? WHERE session_id = ?').run(now, target);
  }

  // L2 = transcript 全体を論理ターン群で走査し、未捕捉の完了ターンを一括回収する。
  // 従来の「最後の 1 ペアのみ保存」は Stop の空振り・不発が永久穴になった (docs/12 B-1)。
  // user / assistant は「1 往復 = 1 ターン」として同じ turn_number（= 代表 assistant
  // 断片の index）でペアリングされ、bodies と skeletons が同じ turn_number で突合できる。
  const backfill = backfillBodies(db, {
    targetSessionId: target,
    originSessionId: origin,
    transcriptPath: transcript_path,
    now,
  });
  logBackfill({
    ts: new Date(now).toISOString(),
    hook: 'stop',
    session_id,
    target,
    origin,
    transcript_path: transcript_path ?? null,
    groups: backfill.groups,
    inserted_turns: backfill.insertedTurns,
    skipped_existing: backfill.skippedExisting,
  });
  if (backfill.lastTurnNumber === null) {
    // /clear 直後などでトランスクリプトに完了ターンが無い場合は何もしない
    process.exit(0);
  }

  const turnNumber = backfill.lastTurnNumber;

  // Claude Stop hook が completion boundary であることを受け、L2 の user/assistant
  // pair が DB に commit 済みであることを確認してから全logical turnのreceiptを時系列publishする。
  // 過去のStopでDBだけ回収済みだったpairもreceipt storeの冪等性で穴埋めする。
  // receipt failure は Stop hook の failure として上位へ伝播させる。L1/L3/usage は
  // receipt 後の派生処理なので、そこで失敗しても completed pair を取り消さない。
  const completionProjectPath = hostAdapterForSessionId(session_id).completionProjectPath({
    cwd: cwd ?? process.cwd(),
    env: process.env,
  });
  for (const completedTurnNumber of backfill.turnNumbers) {
    publishCapturedClaudeCompletionReceipt(db, {
      target,
      origin,
      turnNumber: completedTurnNumber,
      projectPath: completionProjectPath,
    });
  }

  // L1 = 遅延要約。target 配下の bodies ターン数 (distinct origin×turn) が
  // WINDOW を超えていたら、最古の未要約ターンを 1 件だけ要約する。
  // 20 ターン以内で終わる作業では Haiku コストゼロ。
  if (countDistinctBodyTurns(db, target) > L2_WINDOW) {
    const oldest = pickOldestUnsummarizedTurn(db, target);
    if (oldest) {
      const rows = db
        .prepare(
          `SELECT role, text FROM bodies
           WHERE session_id = ? AND origin_session_id = ? AND turn_number = ?`,
        )
        .all(target, oldest.origin_session_id, oldest.turn_number);
      const userRow = rows.find((r) => r.role === 'user');
      const asstRow = rows.find((r) => r.role === 'assistant');
      const l2ForSummary = buildL2ForSummary(
        userRow ? { content: userRow.text } : null,
        asstRow ? { content: asstRow.text } : null,
      );
      const { summary } = summarizeToL1(l2ForSummary, {
        projectPath: cwd ?? process.cwd(),
        hostMode: 'claude-primary',
      });

      db.prepare(
        `INSERT OR IGNORE INTO skeletons
           (session_id, origin_session_id, turn_number, role, summary, created_at)
         VALUES (?, ?, ?, 'assistant', ?, ?)`,
      ).run(
        target,
        oldest.origin_session_id,
        oldest.turn_number,
        summary,
        oldest.created_at,
      );
    }
  }

  // L3 = transcript から tool_use / tool_result / attachment (hook) を抽出して details に INSERT
  // extractDetailBlocks はこの論理ターンの範囲のみをスキャンする。再実行時は
  // source_id ベースの UNIQUE 制約で冪等性を確保（INSERT OR IGNORE）。
  const allEntries = transcript_path ? readRawEntries(transcript_path) : [];
  const turnEntries = sliceCurrentTurnEntries(allEntries);
  const detailBlocks = extractDetailBlocks(turnEntries);

  if (detailBlocks.length > 0) {
    const insertDetail = db.prepare(
      `INSERT OR IGNORE INTO details
         (session_id, origin_session_id, turn_number, tool_name, input_text, output_text,
          token_count, created_at, kind, source_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    // 数百行の INSERT を 1 トランザクションにまとめて fsync コストを 1 回に抑える
    db.exec('BEGIN');
    try {
      for (const d of detailBlocks) {
        const tokenCount = Math.round(
          ((d.input_text?.length ?? 0) + (d.output_text?.length ?? 0)) / 4,
        );
        insertDetail.run(
          target,
          origin,
          turnNumber,
          d.tool_name,
          d.input_text,
          d.output_text,
          tokenCount,
          now,
          d.kind,
          d.source_id,
        );
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  // monitor の fallback 用に、Stop 完了時点で確定している usage を state ファイルにも
  // 保存する。通常表示はライブ transcript を優先し、読めない時だけ snapshot を使う。
  // 取得失敗は致命ではないので try/catch で握る（stderr には出す）。
  try {
    const usage = transcript_path ? readLatestUsage(transcript_path) : null;
    if (usage) {
      writeSessionState({
        sessionId: session_id,
        projectPath: cwd ?? process.cwd(),
        transcriptPath: transcript_path ?? null,
        pid: process.ppid,
        usage,
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown';
    process.stderr.write(`[turn-processor] usage snapshot failed: ${msg}\n`);
  }

  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => {
    recordRuntimeErrorBestEffort('HOOK_PROCESS_TURN_FAILED');
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[turn-processor] error: ${msg}\n`);
    process.exit(1);
  });
}
