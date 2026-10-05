#!/usr/bin/env node
/**
 * sc-detail — /sc-detail スラッシュコマンドの実行本体
 *
 * 使い方:
 *   node src/sc-detail.mjs <時刻>
 *   node src/sc-detail.mjs <開始時刻>-<終了時刻>
 *   node src/sc-detail.mjs <日付>T<時刻>
 *
 * 時刻フォーマット: HH:MM:SS または HH:MM（秒省略可）。日付は YYYY-MM-DD。
 * 日付を省いた時は、今日から1日ずつ遡り、その時刻のターンがある最も新しい日を対象にする
 * （注入文の [HH:MM:SS] は過去の時刻で、前日以前のことがある）。
 * 複数ターンが同一時刻にヒットする場合は全部返す。
 *
 * 出力: 指定時刻のターン（または範囲内の全ターン）の L2 (bodies) + L3 (details)
 *       を人間可読なテキストで stdout に出力する。
 *
 * 注意:
 *   - 現在の作業ディレクトリ（cwd）のプロジェクトに属するターンのみを対象にする
 *   - session_id は merge chain 解決後の合流先（target）を使う
 *   - 複数セッションの ID を跨いで時刻で検索するので、project_path でフィルタ必須
 */

import { getDb } from './db.mjs';
import { DETAIL_KIND, DETAIL_KIND_VALUES } from './constants.mjs';

function parseTimeArg(arg) {
  const m = String(arg || '')
    .trim()
    .match(/^(?:(\d{4})-(\d{2})-(\d{2})[T ])?(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const [, year, month, day, hh, mm, ss] = m;
  return {
    // null = 日付指定なし（今日から遡って探す）
    date: year != null ? { year: Number(year), month: Number(month), day: Number(day) } : null,
    hours: Number(hh),
    minutes: Number(mm),
    seconds: ss != null ? Number(ss) : null, // null = 秒指定なし（その分内すべて）
  };
}

/**
 * 時刻の指定を解釈する。範囲は `<開始>-<終了>`。終了の日付を省くと開始と同じ日になる。
 * @returns {{ from: object, to: object } | null}
 */
export function parseDetailArg(arg) {
  const s = String(arg || '').trim();
  const single = parseTimeArg(s);
  if (single) return { from: single, to: single };
  // 日付にも `-` があるので、時刻の直後の `-` で開始と終了を分ける
  const m = s.match(/^(.*?\d:\d{2}(?::\d{2})?)\s*-\s*(.+)$/);
  if (!m) return null;
  const from = parseTimeArg(m[1]);
  const to = parseTimeArg(m[2]);
  if (!from || !to) return null;
  return { from, to: to.date ? to : { ...to, date: from.date } };
}

/**
 * 時刻の指定を、日付 base（年月日だけを使う）の上のタイムスタンプ範囲（ms）にする。
 * 秒が null の場合は、開始は 00 秒、終了は 59 秒までを含める。
 */
export function detailRangeOn(spec, base) {
  const at = (t, endOfUnit) => {
    const date = t.date ?? { year: base.getFullYear(), month: base.getMonth() + 1, day: base.getDate() };
    const seconds = t.seconds != null ? t.seconds : endOfUnit ? 59 : 0;
    return new Date(
      date.year, date.month - 1, date.day, t.hours, t.minutes, seconds, endOfUnit ? 999 : 0,
    ).getTime();
  };
  return { start: at(spec.from, false), end: at(spec.to, true) };
}

function formatDate(unixMs) {
  const d = new Date(unixMs);
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mo}-${day}`;
}

function formatTime(unixMs) {
  const d = new Date(unixMs);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

/**
 * コアロジック。bin/throughline.mjs などから直接呼び出せるよう、
 * process.argv ではなく引数配列を受け取る。
 * @param {string[]} args
 */
export function run(args) {
  const arg = args[0];
  if (!arg) {
    process.stderr.write(
      '使い方: throughline detail <HH:MM:SS>\n' +
        '       throughline detail <HH:MM:SS>-<HH:MM:SS>\n' +
        '       throughline detail <YYYY-MM-DD>T<HH:MM:SS>\n' +
        '日付を省くと、今日から遡って、その時刻のターンがある最も新しい日を探します。\n',
    );
    process.exit(1);
  }

  const spec = parseDetailArg(arg);
  if (!spec) {
    process.stderr.write(`[sc-detail] 時刻フォーマットが無効: ${arg}\n`);
    process.exit(1);
  }

  const db = getDb();
  const projectPath = process.cwd();

  // 指定時刻範囲内のターンを bodies から取得（project_path でフィルタ）
  // bodies と sessions を JOIN して同プロジェクトに絞る
  const bodyStmt = db.prepare(
    `SELECT b.session_id, b.origin_session_id, b.turn_number, b.role, b.text, b.created_at
     FROM bodies b
     JOIN sessions s ON s.session_id = b.session_id
     WHERE lower(s.project_path) = lower(?)
       AND b.created_at BETWEEN ? AND ?
     ORDER BY b.created_at ASC, b.role ASC`,
  );

  let bodyRows = [];
  if (spec.from.date) {
    const range = detailRangeOn(spec, new Date());
    bodyRows = bodyStmt.all(projectPath, range.start, range.end);
  } else {
    // 日付の指定が無い時は、今日から1日ずつ遡り、最初にターンが見つかった日を対象にする。
    // この project の最古の本文より前までは探さない。
    const oldest = db
      .prepare(
        `SELECT MIN(b.created_at) AS oldest
         FROM bodies b
         JOIN sessions s ON s.session_id = b.session_id
         WHERE lower(s.project_path) = lower(?)`,
      )
      .get(projectPath)?.oldest;
    const today = new Date();
    for (let back = 0; oldest != null; back += 1) {
      const day = new Date(today.getFullYear(), today.getMonth(), today.getDate() - back);
      const range = detailRangeOn(spec, day);
      if (range.end < oldest) break;
      bodyRows = bodyStmt.all(projectPath, range.start, range.end);
      if (bodyRows.length > 0) break;
    }
  }

  if (bodyRows.length === 0) {
    process.stdout.write(
      `## Throughline /sc-detail\n\n指定時刻 ${arg} に該当するターンが見つかりませんでした。\n`,
    );
    process.exit(0);
  }
  // 今日以外の日のターンを返す時は、どの日のターンかを明示する
  const foundDate = formatDate(bodyRows[0].created_at);
  const dateNote = !spec.from.date && foundDate !== formatDate(Date.now()) ? `（${foundDate}）` : '';

  // ターン単位でグルーピング（同じ session_id + origin + turn_number）
  const turnKeys = new Set();
  for (const r of bodyRows) {
    turnKeys.add(`${r.session_id}\x00${r.origin_session_id}\x00${r.turn_number}`);
  }

  const lines = [];
  lines.push('## Throughline /sc-detail');
  lines.push(`指定時刻: ${arg}${dateNote}  対象ターン数: ${turnKeys.size}`);
  lines.push('');

  // L2 を時刻順に出力
  lines.push('### L2 (会話本文)');
  for (const r of bodyRows) {
    lines.push(`[${formatTime(r.created_at)}] [${r.role}]: ${r.text}`);
    lines.push('');
  }

  // 対応する L3 を details から 1 クエリで取得（N+1 回避のため row-value IN）
  const turnTuples = [...turnKeys].map((k) => k.split('\x00'));
  const placeholders = turnTuples.map(() => '(?, ?, ?)').join(', ');
  const params = turnTuples.flatMap(([sid, origin, turn]) => [sid, origin, Number(turn)]);
  const detailRows = db
    .prepare(
      `SELECT id, turn_number, kind, tool_name, input_text, output_text, created_at
       FROM details
       WHERE (session_id, origin_session_id, turn_number) IN (VALUES ${placeholders})
       ORDER BY id ASC`,
    )
    .all(...params);

  if (detailRows.length > 0) {
    // 単一 pass で kind ごとに振り分け
    const toolRows = [];
    const systemRows = [];
    const imageRows = [];
    const legacyRows = [];
    for (const d of detailRows) {
      if (d.kind === DETAIL_KIND.TOOL_INPUT || d.kind === DETAIL_KIND.TOOL_OUTPUT) toolRows.push(d);
      else if (d.kind === DETAIL_KIND.SYSTEM) systemRows.push(d);
      else if (d.kind === DETAIL_KIND.IMAGE) imageRows.push(d);
      else if (!DETAIL_KIND_VALUES.has(d.kind)) legacyRows.push(d);
    }

    if (toolRows.length > 0) {
      lines.push('### L3 (ツール入出力)');
      for (const d of toolRows) {
        const marker = d.kind === DETAIL_KIND.TOOL_INPUT ? 'IN ' : 'OUT';
        lines.push(`[${formatTime(d.created_at)}] ${marker} ${d.tool_name}`);
        if (d.input_text) {
          lines.push(`  IN:  ${d.input_text.replace(/\n/g, '\n       ')}`);
        }
        if (d.output_text) {
          lines.push(`  OUT: ${d.output_text.replace(/\n/g, '\n       ')}`);
        }
        lines.push('');
      }
    }

    if (systemRows.length > 0) {
      lines.push('### L3 (システムメッセージ / hook 出力)');
      for (const d of systemRows) {
        lines.push(`[${formatTime(d.created_at)}] ${d.tool_name}`);
        if (d.input_text) lines.push(`  CMD: ${d.input_text}`);
        if (d.output_text) lines.push(`  OUT: ${d.output_text.replace(/\n/g, '\n       ')}`);
        lines.push('');
      }
    }

    if (imageRows.length > 0) {
      lines.push('### L3 (画像)');
      for (const d of imageRows) {
        lines.push(`[${formatTime(d.created_at)}] ${d.output_text ?? '[image]'}`);
      }
      lines.push('');
    }

    if (legacyRows.length > 0) {
      lines.push('### L3 (legacy)');
      for (const d of legacyRows) {
        lines.push(`[${formatTime(d.created_at)}] ${d.tool_name}`);
        if (d.input_text) lines.push(`  IN:  ${d.input_text.replace(/\n/g, '\n       ')}`);
        if (d.output_text) lines.push(`  OUT: ${d.output_text.replace(/\n/g, '\n       ')}`);
        lines.push('');
      }
    }
  } else {
    lines.push('### L3');
    lines.push('（該当ターンに L3 レコード無し）');
  }

  process.stdout.write(lines.join('\n') + '\n');
  process.exit(0);
}
