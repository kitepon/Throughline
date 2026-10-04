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
import {
  extractDetailBlocks,
  getLogicalTurnGroups,
  isJunkAssistantText,
  readLatestUserGroup,
  readRawEntries,
  sliceInFlightTurnEntries,
} from './transcript-reader.mjs';

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
 * @returns {{groups: number, insertedTurns: number, skippedExisting: number, lastTurnNumber: number|null, turnNumbers: number[]}}
 */
export function backfillBodies(db, { targetSessionId, originSessionId, transcriptPath, now }) {
  const groups = getLogicalTurnGroups(transcriptPath);
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

/**
 * 作業途中で止めたターンを bodies と details へ取り込む (ADR 0033)。
 *
 * hook で止めたターンでは Stop hook が走らない。止めた側（自動継続の worker）が、後継を立てる前に呼ぶ。
 * Codex の自動継続が、止めたターンを取り込んでから記憶を作るのと同じ。
 *
 *   - 完了したターンは最後の本文（代表断片）だけを残すが、止めたターンには結論の発言が無い。
 *     ここまでの発言を全部つないで assistant の本文にする。本文が1つも無ければ user の行だけを入れる。
 *   - turn_number は最後の本文断片の index（無ければ user 行の index）。backfillBodies は断片の index が
 *     bodies にある群を回収しないので、後継が前任を合流させる時に、代表断片の行が重ねて入らない。
 *   - details は最後の user 本文の行から transcript の末尾まで。止めた道具の呼び出しも入る。
 *     source_id の UNIQUE で、同じターンをもう一度取り込んでも増えない。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} opts
 * @param {string} opts.targetSessionId 書き込み先 session_id（合流済みなら合流先）
 * @param {string} opts.originSessionId transcript を持つ session_id
 * @param {string|null|undefined} opts.transcriptPath
 * @param {number} opts.now timestamp が無い時と details の created_at
 * @returns {{turnNumber: number, userAt: number, assistantAt: number|null, insertedBodies: boolean, details: number}|null}
 */
export function captureInFlightTurn(db, { targetSessionId, originSessionId, transcriptPath, now }) {
  const latest = readLatestUserGroup(transcriptPath);
  if (!latest) return null;
  const fragments = latest.fragments.filter((f) => !isJunkAssistantText(f.content));
  const candidates = [latest.user.turn_number, ...latest.fragments.map((f) => f.index)];
  const captured = db
    .prepare(
      `SELECT turn_number FROM bodies
       WHERE origin_session_id = ? AND turn_number IN (${candidates.map(() => '?').join(',')})
       ORDER BY turn_number DESC LIMIT 1`,
    )
    .get(originSessionId, ...candidates);
  const turnNumber = captured?.turn_number ?? fragments.at(-1)?.index ?? latest.user.turn_number;
  const userAt = latest.user.timestamp ?? now;
  const assistantAt = fragments.length > 0 ? (fragments.at(-1).timestamp ?? now) : null;
  const assistantText = fragments.map((f) => f.content.trim()).join('\n\n');
  const detailBlocks = extractDetailBlocks(sliceInFlightTurnEntries(readRawEntries(transcriptPath)));

  const insertBody = db.prepare(
    `INSERT OR IGNORE INTO bodies
       (session_id, origin_session_id, turn_number, role, text, token_count, created_at, turn_start)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertDetail = db.prepare(
    `INSERT OR IGNORE INTO details
       (session_id, origin_session_id, turn_number, tool_name, input_text, output_text,
        token_count, created_at, kind, source_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  db.exec('BEGIN');
  try {
    if (!captured) {
      insertBody.run(targetSessionId, originSessionId, turnNumber, 'user', latest.user.content,
        Math.round(latest.user.content.length / 4), userAt, latest.user.start);
      if (assistantText) {
        insertBody.run(targetSessionId, originSessionId, turnNumber, 'assistant', assistantText,
          Math.round(assistantText.length / 4), assistantAt, null);
      }
    }
    for (const d of detailBlocks) {
      insertDetail.run(targetSessionId, originSessionId, turnNumber, d.tool_name, d.input_text, d.output_text,
        Math.round(((d.input_text?.length ?? 0) + (d.output_text?.length ?? 0)) / 4), now, d.kind, d.source_id);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { turnNumber, userAt, assistantAt, insertedBodies: !captured, details: detailBlocks.length };
}
