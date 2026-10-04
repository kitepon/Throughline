/**
 * turn-backfill.mjs — transcript 全体走査による L2 回収の共通ルーチン
 *
 * 従来の「Stop ごとに最後の 1 ペアのみ保存」は、Stop の空振り・不発が bodies の
 * 永久穴になった（実測欠落率 Desktop 27% / VSCode 41%、docs/12 §6）。
 * 本ルーチンは transcript の全論理ターン群を走査し、未捕捉の完了ターンを回収する。
 * turn-processor（毎 Stop）と session-start（マージ直後の前任回収）が共用する。
 *
 * 設計は docs/12 Workstream B-1（refuter 修正 1/3/4/5 適用済み）:
 *   - 群レベル dedup: 群の**どの断片 index も** bodies に無い群だけ挿入する。
 *     部分捕捉済み群への再挿入は「同一 user 発話の重複ペア」を量産する
 *     （実測: 全 DB で 110 群が該当）ため、代表断片の差し替え回収はしない。
 *   - 代表断片 = 群内最後の非 junk 断片（getLogicalTurnGroups 側で選択済み）。
 *   - created_at は transcript エントリの timestamp。now を使うと一括回収行が
 *     同一ミリ秒に潰れ、created_at 順ソート（handoff-record の L2 窓・現在地アンカー）
 *     の会話順が tie で不定化するため。timestamp 欠損時のみ now。
 *   - INSERT は 1 トランザクション（fsync 1 回、turn-processor の details と同型）。
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { getLogicalTurnGroups } from './transcript-reader.mjs';

/**
 * バックフィル回収実績を ~/.throughline/logs/backfill.log に 1 行 JSON で記録する。
 * @param {object} entry
 */
export function logBackfill(entry) {
  const path = join(homedir(), '.throughline', 'logs', 'backfill.log');
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(entry) + '\n', 'utf8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown';
    process.stderr.write(`[backfill-log] ${msg}\n`);
  }
}

/**
 * Claude Code の project-dir munging から session transcript path を決定的に導出する。
 * macOS/Linux の Claude Code 規約を mirror する。Windows では呼び出し側が state file の
 * transcriptPath に fallback する。
 * @param {string} projectPath
 * @param {string} sessionId
 * @returns {string}
 */
export function deriveTranscriptPath(projectPath, sessionId) {
  const mungedProjectPath = `-${String(projectPath).replace(/[/.]/g, '-').replace(/^-+/, '')}`;
  return join(homedir(), '.claude', 'projects', mungedProjectPath, `${sessionId}.jsonl`);
}

/**
 * transcript の未捕捉完了ターンを bodies へ回収する。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} opts
 * @param {string} opts.targetSessionId 書き込み先 session_id（merge 済みなら合流先）
 * @param {string} opts.originSessionId transcript を所有する origin session_id
 * @param {string|null|undefined} opts.transcriptPath
 * @param {number} opts.now timestamp 欠損時の fallback epoch ms
 * @param {number|null} [opts.beforeUserTurnNumber] 指定した時は、user 行の番号がこれより前の群だけを回収する。
 *   作業途中のターンがある時点（自動圧縮の直後。ADR 0032）で呼ぶ時に、その群を除くために使う。
 *   途中の断片を代表として保存すると、群レベル dedup で最終回答が二度と入らない。
 * @returns {{groups: number, insertedTurns: number, skippedExisting: number, lastTurnNumber: number|null, turnNumbers: number[]}}
 */
export function backfillBodies(db, { targetSessionId, originSessionId, transcriptPath, now, beforeUserTurnNumber = null }) {
  const groups = getLogicalTurnGroups(transcriptPath).filter(
    (group) => beforeUserTurnNumber === null || group.user.turn_number < beforeUserTurnNumber,
  );
  if (groups.length === 0) {
    return { groups: 0, insertedTurns: 0, skippedExisting: 0, lastTurnNumber: null, turnNumbers: [] };
  }

  const existing = new Set(
    db
      .prepare('SELECT DISTINCT turn_number FROM bodies WHERE origin_session_id = ?')
      .all(originSessionId)
      .map((r) => r.turn_number),
  );

  const insertBody = db.prepare(
    `INSERT OR IGNORE INTO bodies
       (session_id, origin_session_id, turn_number, role, text, token_count, created_at, turn_start)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  let insertedTurns = 0;
  let skippedExisting = 0;

  db.exec('BEGIN');
  try {
    for (const g of groups) {
      // 群のいずれかの断片 index が既に bodies にある = 部分捕捉済み群。
      // 代表差し替えは重複ペアを生むので回収しない (refuter 修正1)。
      if (g.fragments.some((f) => existing.has(f.index))) {
        skippedExisting++;
        continue;
      }
      const turnNumber = g.representative.index;
      const assistantAt = g.representative.timestamp ?? now;
      const userAt = g.user.timestamp ?? assistantAt;

      insertBody.run(
        targetSessionId,
        originSessionId,
        turnNumber,
        'user',
        g.user.content,
        Math.round(g.user.content.length / 4),
        userAt,
        g.user.start,
      );
      insertBody.run(
        targetSessionId,
        originSessionId,
        turnNumber,
        'assistant',
        g.representative.content,
        Math.round(g.representative.content.length / 4),
        assistantAt,
        null,
      );
      insertedTurns++;
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return {
    groups: groups.length,
    insertedTurns,
    skippedExisting,
    lastTurnNumber: groups[groups.length - 1].representative.index,
    turnNumbers: groups.map((group) => group.representative.index),
  };
}
