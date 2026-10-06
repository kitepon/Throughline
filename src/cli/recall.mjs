/**
 * `throughline recall` — 注入案内から辿る pull 用の DB 直参照 CLI (read-only)
 *
 * 注入（push）は「現在地 + 入るだけの L2」だけを運び、残りの記憶は本コマンドで
 * 必要な時だけ取得する（オーナー裁定 2026-07-18、ADR 0016）:
 *   - `recall --l2 --session <id> --before <ISO日時> --last <N>`
 *       境界（strict less-than, ms 比較）より古いターンを新しい側から N 件、
 *       L2 全文（注入と同じ行文法 + L3 参照 suffix）で出す。
 *   - `recall --l1 --session <id> --before <ISO日時> --skip <N>`
 *       境界から N 件（--l2 の担当分）を飛ばした先の全ターン一覧。
 *       L1 要約があれば要約、無ければ「未要約」と明示して detail 誘導を出す。
 *
 * 契約:
 *   - 範囲・境界・session は注入時に案内コマンドへ焼き込まれた値だけで決まる。
 *     recall 側で「現在の 20 ターン窓」を再計算しない（新セッションのターン追記で
 *     窓がスライドし、古い側が黙って欠落するため）。
 *   - DB は read-only で開く（create / migrate / write なし）。DB が無ければ
 *     explicit error で終了する。
 *   - 既定 session 解決は持たない。案内コマンドが常に `--session` を運ぶ。
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { settleFirstRead } from '../db.mjs';
import { formatTime } from '../handoff-record.mjs';
import { groupL3ByTurn, buildPartsSummary } from '../l3-summary.mjs';

export function defaultRecallDbPath() {
  return join(homedir(), '.throughline', 'throughline.db');
}

const USAGE =
  'usage: throughline recall (--l2 --last <N> | --l1 [--skip <N>] [--last <N>]) ' +
  '--session <id> --before <ISO8601> [--db <path>]';

export function parseRecallArgs(argv) {
  const opts = {
    mode: null,
    sessionId: null,
    beforeMs: null,
    last: null,
    skip: 0,
    dbPath: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--l2' || a === '--l1') {
      if (opts.mode) throw new Error('recall: --l2 と --l1 は同時に指定できません');
      opts.mode = a.slice(2);
    } else if (a === '--session') {
      opts.sessionId = argv[++i];
    } else if (a === '--before') {
      const raw = argv[++i];
      const ms = Date.parse(raw ?? '');
      if (!Number.isFinite(ms)) {
        throw new Error(`recall: --before の日時を解釈できません: ${raw}（ISO 8601 を指定）`);
      }
      opts.beforeMs = ms;
    } else if (a === '--last') {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 0) throw new Error('recall: --last は 0 以上の整数');
      opts.last = n;
    } else if (a === '--skip') {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 0) throw new Error('recall: --skip は 0 以上の整数');
      opts.skip = n;
    } else if (a === '--db') {
      opts.dbPath = argv[++i];
    } else {
      throw new Error(`recall: 未知の引数: ${a}\n${USAGE}`);
    }
  }
  if (!opts.mode) throw new Error(`recall: --l2 または --l1 を指定してください\n${USAGE}`);
  if (!opts.sessionId) throw new Error(`recall: --session は必須です\n${USAGE}`);
  if (opts.beforeMs == null) throw new Error(`recall: --before は必須です\n${USAGE}`);
  if (opts.mode === 'l2' && opts.last == null) {
    throw new Error(`recall: --l2 には --last <N> が必須です\n${USAGE}`);
  }
  return opts;
}

/**
 * 境界より古い側の distinct ターンを新しい順に列挙する。
 * 各要素: { originSessionId, turnNumber, turnKey, minCreatedAt }
 */
function listTurnsBefore(db, { sessionId, beforeMs }) {
  const rows = db
    .prepare(
      `SELECT origin_session_id, turn_number, MIN(created_at) AS min_ca, MAX(created_at) AS max_ca
       FROM bodies
       WHERE session_id = ? AND created_at < ?
       GROUP BY origin_session_id, turn_number
       ORDER BY min_ca DESC`,
    )
    .all(sessionId, beforeMs);
  return rows.map((r) => ({
    originSessionId: r.origin_session_id,
    turnNumber: r.turn_number,
    turnKey: `${r.origin_session_id}\x00${r.turn_number}`,
    minCreatedAt: r.min_ca,
    maxCreatedAt: r.max_ca,
  }));
}

function loadL3ForTurns(db, sessionId, turns) {
  if (turns.length === 0) return [];
  const placeholders = turns.map(() => '(?, ?, ?)').join(', ');
  const params = turns.flatMap((t) => [sessionId, t.originSessionId, Number(t.turnNumber)]);
  return db
    .prepare(
      `SELECT kind, tool_name, origin_session_id, turn_number, created_at
       FROM details
       WHERE (session_id, origin_session_id, turn_number) IN (VALUES ${placeholders})
       ORDER BY created_at ASC, id ASC`,
    )
    .all(...params)
    .map((r) => ({
      kind: r.kind,
      toolName: r.tool_name,
      originSessionId: r.origin_session_id,
      turnNumber: r.turn_number,
      createdAt: r.created_at,
    }));
}

/**
 * --l2: 境界より古いターンを新しい側から last 件、古い順の L2 全文で描画する。
 */
export function renderRecallL2(db, { sessionId, beforeMs, last }) {
  const turnsDesc = listTurnsBefore(db, { sessionId, beforeMs });
  const selected = turnsDesc.slice(0, last).reverse(); // 古い順に戻す
  const lines = [];

  if (selected.length === 0) {
    lines.push(`## Throughline recall (L2): 該当ターンなし（--before ${new Date(beforeMs).toISOString()} より古い L2 が DB にありません）`);
    return { text: lines.join('\n'), turnCount: 0 };
  }

  const range = `${formatTime(selected[0].minCreatedAt)}〜${formatTime(selected[selected.length - 1].maxCreatedAt)}`;
  lines.push(`## Throughline recall (L2): ${selected.length}ターン (${range}, 古い順)`);
  if (selected.length < last) {
    lines.push(`（--last ${last} のうち DB に存在するのは ${selected.length} ターンのみ）`);
  }
  lines.push('');

  const l3ByTurn = groupL3ByTurn(loadL3ForTurns(db, sessionId, selected));

  const bodyStmt = db.prepare(
    `SELECT role, text, created_at
     FROM bodies
     WHERE session_id = ? AND origin_session_id = ? AND turn_number = ? AND created_at < ?
     ORDER BY created_at ASC`,
  );
  for (const turn of selected) {
    const rows = bodyStmt
      .all(sessionId, turn.originSessionId, Number(turn.turnNumber), beforeMs)
      .filter((r) => r.text);
    for (let i = 0; i < rows.length; i += 1) {
      const r = rows[i];
      const isLast = i === rows.length - 1;
      const partCounts = isLast ? (l3ByTurn.get(turn.turnKey)?.partCounts ?? new Map()) : new Map();
      const suffix = buildPartsSummary(partCounts);
      lines.push(`[${formatTime(r.created_at)}] [${r.role}]: ${r.text}${suffix}`);
    }
  }
  return { text: lines.join('\n'), turnCount: selected.length };
}

/**
 * --l1: 境界から skip 件を飛ばした先の全ターン一覧（古い順）。
 * L1 要約があれば要約行、無ければ「未要約」と明示して detail 誘導を出す。
 */
export function renderRecallL1(db, { sessionId, beforeMs, skip, last = null }) {
  const turnsDesc = listTurnsBefore(db, { sessionId, beforeMs });
  let olderDesc = turnsDesc.slice(skip);
  if (last != null) olderDesc = olderDesc.slice(0, last);
  const selected = [...olderDesc].reverse(); // 古い順
  const lines = [];

  if (selected.length === 0) {
    lines.push('## Throughline recall (L1): 該当ターンなし');
    return { text: lines.join('\n'), turnCount: 0, summarizedCount: 0 };
  }

  const skelRows = db
    .prepare(
      `SELECT origin_session_id, turn_number, summary, created_at
       FROM skeletons
       WHERE session_id = ?
       ORDER BY created_at ASC`,
    )
    .all(sessionId);
  const skelByTurn = new Map();
  for (const r of skelRows) {
    const key = `${r.origin_session_id}\x00${r.turn_number}`;
    if (!skelByTurn.has(key)) skelByTurn.set(key, []);
    skelByTurn.get(key).push(r);
  }

  let summarizedCount = 0;
  const bodyLines = [];
  for (const turn of selected) {
    const time = formatTime(turn.minCreatedAt);
    const skels = skelByTurn.get(turn.turnKey);
    if (skels && skels.length > 0) {
      summarizedCount += 1;
      for (const s of skels) {
        if (!s.summary || s.summary === '(no content)') continue;
        const summary = s.summary.replace(/\n+/g, ' ').trim();
        bodyLines.push(`[${time}] ${summary}`);
      }
    } else {
      bodyLines.push(`[${time}] (未要約) 全文: throughline detail ${time}`);
    }
  }

  const range = `${formatTime(selected[0].minCreatedAt)}〜${formatTime(selected[selected.length - 1].minCreatedAt)}`;
  lines.push(
    `## Throughline recall (L1): 全${selected.length}ターン / 要約済み ${summarizedCount} (${range}, 古い順)`,
  );
  lines.push('各ターンの全文・ツール入出力: `throughline detail <時刻>` で取得可');
  lines.push('');
  lines.push(...bodyLines);
  return { text: lines.join('\n'), turnCount: selected.length, summarizedCount };
}

export function runRecall(db, opts) {
  if (opts.mode === 'l2') {
    return renderRecallL2(db, {
      sessionId: opts.sessionId,
      beforeMs: opts.beforeMs,
      last: opts.last,
    });
  }
  return renderRecallL1(db, {
    sessionId: opts.sessionId,
    beforeMs: opts.beforeMs,
    skip: opts.skip,
    last: opts.last,
  });
}

export function run(argv) {
  let opts;
  try {
    opts = parseRecallArgs(argv);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  const dbPath = opts.dbPath ?? defaultRecallDbPath();
  if (!existsSync(dbPath)) {
    process.stderr.write(`recall: DB がありません: ${dbPath}（recall は DB を作成しません）\n`);
    return 1;
  }

  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch (err) {
    process.stderr.write(
      `recall: DB を read-only で開けませんでした: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }

  try {
    settleFirstRead(db);
    const result = runRecall(db, opts);
    process.stdout.write(`${result.text}\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`recall: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  } finally {
    db.close();
  }
}
