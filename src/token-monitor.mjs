#!/usr/bin/env node
/**
 * token-monitor.mjs — マルチセッション対応トークンモニター
 *
 * 使い方:
 *   throughline monitor                  現在のプロジェクトの全 active セッション
 *   throughline monitor --all             全プロジェクト全セッション
 *   throughline monitor --session <id>    特定セッションのみ
 *
 * VS Code の分割ターミナルなどで常時起動しておく。
 *
 * 設計: docs/04_public_release_plan.md §4.5/4.6
 *   - 状態ファイルはセッション単位 (~/.throughline/state/<session_id>.json)
 *   - setInterval (1s) + mtime 差分検知で更新を捕捉
 *   - updatedAt 降順ソート、先頭行を ▶ でハイライト
 *   - stale は state 更新時刻 + live transcript / rollout mtime で判定
 *   - Claude は transcript JSONL の最新 assistant usage を直読
 *   - Codex は rollout JSONL の token_count / active-text estimate を直読
 *   - state.usage は live ファイルが読めない場合の最後の既知値としてだけ使う
 */

import { basename, dirname, join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { statSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { getStateDir, readAllSessionStates, snapshotStateMtimes, normalizeProjectPath, STALE_HIDE_MS } from './state-file.mjs';
import { buildCodexMonitorUsage } from './codex-usage.mjs';
import { listCodexThreadCandidates } from './codex-thread-index.mjs';
import { readLatestUsage } from './transcript-usage.mjs';
import { startSizeQuery } from './terminal-size.mjs';
import { CODEX_HOST, CODEX_SESSION_PREFIX, codexSessionIdToThreadId } from './hosts/identity.mjs';
import { dataRoot } from './storage-roots.mjs';

const REFRESH_MS = 1000;
// データ変化が無くても N ms ごとに再描画して「(24m ago)」表示を進める。
// 変化検知のほうが優先で、こちらはフォールバック的なタイマー。
const TIME_AGO_REFRESH_MS = 10_000;
let lastTimeAgoRefresh = Date.now();

// --- ANSI ---
const ANSI = {
  hideCursor: '\x1b[?25l',
  showCursor: '\x1b[?25h',
  clearLine: '\x1b[2K',
  // xterm.js は `\x1b[2J` (ED2) をビューポート消去としてしか実装しておらず、
  // 消えた内容はスクロールバックに残る（xterm.js issue #5019 の jerch コメント参照）。
  // VSCode task panel でフレーム更新が「積み上がる」ように見えるのはこれが原因。
  // `\x1b[3J` (ED3) を続けて送るとスクロールバックも消えて真の全クリアになる。
  clearScreen: '\x1b[2J\x1b[3J\x1b[H',
  clearBelow: '\x1b[0J',        // 現在位置から画面末尾までをクリア
  up: (n) => `\x1b[${n}A`,       // CUU: カーソルを N 行上へ (列は変えない)
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
};

function color(c, text) {
  return `${c}${text}${ANSI.reset}`;
}

// --- セル幅計算（ANSI / CJK / 絵文字対応、依存ゼロ） ---
//
// Node v22 には util.getStringWidth がないため、主要な East Asian Wide + 絵文字ブロックを
// 自前の範囲判定で 2 セルとして扱う。East Asian Ambiguous は 1 セル（アラビア・タイ等は
// 既存の char-count 実装と同じ扱いなので悪化しない）。
// ZWJ / VS16 は幅 0 として扱う（絵文字シーケンスの微ズレは許容）。
const ZERO_WIDTH_CODEPOINTS = new Set([0x200b, 0x200c, 0x200d, 0xfeff, 0xfe0e, 0xfe0f]);

/**
 * 単一コードポイントのセル幅を返す（0 / 1 / 2）
 * @param {number} cp
 */
function codePointWidth(cp) {
  if (cp < 0x20) return 0;                          // C0 制御
  if (cp >= 0x7f && cp < 0xa0) return 0;            // DEL / C1 制御
  if (ZERO_WIDTH_CODEPOINTS.has(cp)) return 0;
  // Combining marks (簡易: Combining Diacritical Marks 主要ブロック)
  if (cp >= 0x0300 && cp <= 0x036f) return 0;
  // Wide ranges
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||               // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0x303e) ||               // CJK Radicals / Kangxi
    (cp >= 0x3041 && cp <= 0x33ff) ||               // Hiragana/Katakana/Bopomofo/CJK Symbols
    (cp >= 0x3400 && cp <= 0x4dbf) ||               // CJK Ext A
    (cp >= 0x4e00 && cp <= 0x9fff) ||               // CJK Unified
    (cp >= 0xa000 && cp <= 0xa4cf) ||               // Yi
    (cp >= 0xac00 && cp <= 0xd7a3) ||               // Hangul Syllables
    (cp >= 0xf900 && cp <= 0xfaff) ||               // CJK Compat Ideographs
    (cp >= 0xfe30 && cp <= 0xfe4f) ||               // CJK Compat Forms
    (cp >= 0xff00 && cp <= 0xff60) ||               // Fullwidth
    (cp >= 0xffe0 && cp <= 0xffe6) ||               // Fullwidth signs
    (cp >= 0x1f300 && cp <= 0x1faff) ||             // 絵文字主要ブロック
    (cp >= 0x20000 && cp <= 0x3134f)                // CJK Ext B-G
  ) {
    return 2;
  }
  return 1;
}

/**
 * 文字列のセル幅合計（ANSI 剥ぎ取り済み前提ではない — 内部で剥ぐ）
 * @param {string} s
 */
function cellWidth(s) {
  if (typeof s !== 'string') return 0;
  const stripped = stripVTControlCharacters(s);
  let total = 0;
  for (const ch of stripped) {
    total += codePointWidth(ch.codePointAt(0));
  }
  return total;
}

/**
 * 行をセル幅で切り詰める。ANSI コードはそのまま通過させ（幅 0）、
 * 可視セル幅が maxCells に達したら残りを捨てて reset を付けて返す。
 * CJK 文字を跨ぐときは 1 セル余る場合があるので空白で埋める。
 * @param {string} line
 * @param {number} maxCells
 */
function truncateToCells(line, maxCells) {
  if (maxCells <= 0) return '';
  if (cellWidth(line) <= maxCells) return line;
  let out = '';
  let cells = 0;
  let i = 0;
  while (i < line.length) {
    const code = line.charCodeAt(i);
    // ANSI CSI: \x1b[ ... 終端 (0x40-0x7e)
    if (code === 0x1b && line.charCodeAt(i + 1) === 0x5b) {
      let j = i + 2;
      while (j < line.length) {
        const c = line.charCodeAt(j);
        if (c >= 0x40 && c <= 0x7e) { j++; break; }
        j++;
      }
      out += line.slice(i, j);
      i = j;
      continue;
    }
    // コードポイント単位で取得（サロゲートペア考慮）
    const cp = line.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    const w = codePointWidth(cp);
    if (cells + w > maxCells) {
      // CJK 1 セル余り
      if (cells < maxCells) out += ' ';
      break;
    }
    out += ch;
    cells += w;
    i += ch.length;
  }
  return out + ANSI.reset;
}

/**
 * 文字列の末尾を半角スペースでパディングして targetCells に揃える。
 * 既にはみ出している場合は truncateToCells で切り詰める。
 * @param {string} s
 * @param {number} targetCells
 */
function padCellsEnd(s, targetCells) {
  const width = cellWidth(s);
  if (width === targetCells) return s;
  if (width > targetCells) return truncateToCells(s, targetCells);
  return s + ' '.repeat(targetCells - width);
}

// --- CLI 引数 ---
/**
 * @param {string[]} argv
 * @returns {{all: boolean, session: string|null, diag: boolean}}
 * @throws {Error} --session に値が欠落している場合
 */
function parseArgs(argv) {
  const args = { all: false, session: null, diag: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--all') {
      args.all = true;
    } else if (argv[i] === '--diag') {
      args.diag = true;
    } else if (argv[i] === '--session') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error('--session requires a session id (or prefix) as next argument');
      }
      args.session = value;
      i++;
    }
  }
  return args;
}

// --- 表示 ---
function renderBar(ratio, width = 10) {
  // NaN は 0、+Infinity は 1（オーバーフロー = 満タン表示）、負値 / -Infinity は 0 にクランプ
  let safe;
  if (Number.isNaN(ratio)) safe = 0;
  else if (ratio === Infinity) safe = 1;
  else if (ratio === -Infinity) safe = 0;
  else safe = Math.max(0, Math.min(1, ratio));
  const filled = Math.round(safe * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

function formatNumber(n) {
  if (!Number.isFinite(n) || n < 0) return '0';
  // 999_950 以上は toFixed(1) で "1000.0k" になってしまうので M 表記に切り上げる
  if (n >= 999_500) return (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
  return String(Math.floor(n));
}

/**
 * ある時刻からの経過時間を短い人間可読形式で返す。
 * 「止まって見える」瞬間に、それがどれだけ前の値なのかを一目で示すために使う。
 * @param {number} ms - 経過ミリ秒
 */
export function formatTimeAgo(ms) {
  if (!Number.isFinite(ms) || ms < 0) return 'just now';
  const sec = Math.floor(ms / 1000);
  if (sec < 10) return 'just now';
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

/**
 * columns の変化を検知して全画面再描画すべきかを返す。
 * process.stdout.on('resize') イベントが VSCode 統合ターミナルで発火しないケースが
 * あるため、1 秒 tick から呼び出して polling で検知する。
 * @param {number} prevCols
 * @param {number} currCols
 */
export function shouldForceFullRedraw(prevCols, currCols) {
  return prevCols !== currCols && currCols > 0;
}

// OSC 18t (startSizeQuery) で取得した最新の「端末実測幅」。
// Windows ConPTY + VSCode task terminal では process.stdout.columns が起動時の値で
// 凍結するため、resize に追従するにはこの ANSI クエリ経路が必要。
// undefined = 未取得 / OSC 18t 非対応環境。その場合は process.stdout.columns にフォールバック。
let measuredCols = undefined;

/** テスト用: OSC 18t の測定値を手動でセット/リセット */
export function setMeasuredColumns(v) {
  measuredCols = v;
}

/**
 * 描画に使う列幅を解決する。
 *
 * 優先順:
 *   1. OSC 18t で測った実測値 (measuredCols) が 1 以上 → それ - 1
 *   2. stdout が TTY かつ `process.stdout.columns` が 1 以上 → それ - 1
 *   3. `process.env.COLUMNS` が 1 以上 → それ - 1
 *   4. それ以外 → 80 にフォールバック
 *
 * OSC 18t を最優先にする理由:
 *   Windows ConPTY + VSCode task terminal は panel resize が process.stdout.columns
 *   に届かず凍結する。毎フレーム `\x1b[18t` を端末に投げて `\x1b[8;rows;cols t` を
 *   stdin で受けると、真の現在幅が取れる (0.3.16 で導入、terminal-size.mjs 参照)。
 *
 *   非対応端末 (古い VSCode、パイプ出力) では measuredCols が undefined のままで
 *   自動的にフォールバック経路に倒れる。
 *
 * 歴史 (保管):
 *   0.3.6〜0.3.12 は `>= 40` 閾値で狭い columns を「狂った値」として 200 に倒す
 *   挙動だったが、30 cells の panel が実在するため 200 セルの行 →  物理 7 行 wrap →
 *   CUU under-count → 積み上がり、という連鎖バグの起点だった。0.3.13 で閾値を撤廃。
 */
export function resolveColumns() {
  if (typeof measuredCols === 'number' && measuredCols > 0) {
    return Math.max(1, measuredCols - 1);
  }
  if (process.stdout.isTTY) {
    const reported = typeof process.stdout.columns === 'number' ? process.stdout.columns : 0;
    if (reported > 0) return Math.max(1, reported - 1);
  }
  const fromEnv = Number(process.env.COLUMNS);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return Math.max(1, fromEnv - 1);
  return 80;
}

function formatLine({ state, usage, isActive, now = Date.now() }) {
  const project = basename(state.projectPath || '?');
  const shortId = formatShortSessionId(state);
  const host = state.host === CODEX_HOST ? 'Codex' : state.host === 'unknown' ? 'Unknown' : 'Claude';
  const tokens = usage?.tokens ?? 0;
  const max = usage?.contextWindowSize ?? 200_000;
  const ratio = max > 0 ? tokens / max : 0;

  const bar = renderBar(ratio);
  const barColor =
    ratio >= 0.9 ? ANSI.red :
    ratio >= 0.7 ? ANSI.yellow :
    ANSI.green;

  // 色覚配慮: 色だけでなく記号 / テキスト接頭辞でも重要度を示す
  //   90%超: !! + 強い文言 (赤)
  //   70%超: !  + 弱い文言 (黄)
  const warn =
    ratio >= 0.9 ? color(ANSI.red + ANSI.bold, '  !! /tl 強く推奨') :
    ratio >= 0.7 ? color(ANSI.yellow, '  !  そろそろ /tl') :
    '';

  const marker = isActive ? color(ANSI.bold + ANSI.cyan, '▶') : ' ';
  const projectCol = padCellsEnd(project, 18);
  const hostCol = color(ANSI.dim, padCellsEnd(host, 6));
  const idCol = color(ANSI.dim, shortId);
  const barCol = color(barColor, bar);
  const tokCol = `${formatNumber(tokens).padStart(6)} / ${formatNumber(max).padStart(6)}`;
  const estimateMark = usage?.estimated ? ' est' : '';
  const windowMark = usage?.contextWindowEstimated ? ' win?' : '';
  const modelCol = usage?.model
    ? color(ANSI.dim, `${usage.model}${estimateMark}${windowMark}`)
    : color(ANSI.dim, '(未取得)');
  // 最終更新からの経過: 表示が「止まって見える」とき、それが idle なのか障害なのかを
  // 即座に判別できるようにする。updatedAt は state.writeSessionState 時の Date.now()。
  // 位置は session id の直後（左寄せ固定幅）。狭いターミナルでもモデル名より先に
  // 切れない位置に置くのと、縦の視線移動で「どれが最新更新か」を把握しやすくするため。
  const agoText = typeof state.updatedAt === 'number'
    ? formatTimeAgo(now - state.updatedAt)
    : '';
  // 8 セル固定: "just now" が最長 (8 セル)、"99d ago" は 7 セル。括弧なしで OK
  const agoCol = color(ANSI.dim, padCellsEnd(agoText, 8));

  return `${marker} ${projectCol} ${hostCol} ${idCol} ${agoCol} ${barCol} ${tokCol}  ${modelCol}${warn}`;
}

function formatShortSessionId(state) {
  const sessionId = String(state?.sessionId ?? '');
  if (state?.host === CODEX_HOST && sessionId.startsWith(CODEX_SESSION_PREFIX)) {
    return (codexSessionIdToThreadId(sessionId) ?? '').slice(0, 8);
  }
  return sessionId.slice(0, 8);
}

function statFile(path) {
  if (!path || !existsSync(path)) return null;
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

function liveActivityMs(state) {
  const transcript = statFile(state.transcriptPath);
  const rollout = statFile(state.rolloutPath);
  return Math.max(
    Number(state.updatedAt) || 0,
    transcript?.mtimeMs ?? 0,
    rollout?.mtimeMs ?? 0,
  );
}

function withLiveActivity(state, now = Date.now()) {
  const updatedAt = liveActivityMs(state);
  return {
    ...state,
    updatedAt,
    stale: now - updatedAt > STALE_HIDE_MS,
  };
}

function resolveMonitorUsage(state) {
  if (state.host === CODEX_HOST && state.rolloutPath) {
    return buildCodexMonitorUsage(state.rolloutPath) ?? state.usage ?? null;
  }
  if (state.transcriptPath) {
    return readLatestUsage(state.transcriptPath) ?? state.usage ?? null;
  }
  return state.usage ?? null;
}

let lastCodexDiscoveryError = null;

function reportCodexDiscoveryError(err) {
  const msg = err instanceof Error ? err.message : 'unknown error';
  if (msg === lastCodexDiscoveryError) return;
  lastCodexDiscoveryError = msg;
  process.stderr.write(`[Throughline] codex discovery error: ${msg}\n`);
}

function codexDiscoveryOptions(args = {}, cwd = process.cwd()) {
  const allProjects = Boolean(args.all || args.session);
  return {
    projectPath: cwd,
    allProjects,
    limit: allProjects ? 100 : 30,
  };
}

function discoverCodexSessionStates(args = {}, cwd = process.cwd()) {
  let candidates;
  try {
    candidates = listCodexThreadCandidates(codexDiscoveryOptions(args, cwd));
  } catch (err) {
    reportCodexDiscoveryError(err);
    return [];
  }

  lastCodexDiscoveryError = null;
  return candidates.map((candidate) => ({
    sessionId: `${CODEX_SESSION_PREFIX}${candidate.id}`,
    host: CODEX_HOST,
    projectPath: normalizeProjectPath(candidate.cwd ?? cwd),
    transcriptPath: null,
    rolloutPath: candidate.rolloutPath,
    pid: null,
    updatedAt: codexCandidateUpdatedAt(candidate),
    discoveredFrom: 'codex-rollout-discovery',
  }));
}

function codexCandidateUpdatedAt(candidate) {
  const mtime = Number(candidate?.mtimeMs);
  if (Number.isFinite(mtime) && mtime > 0) return mtime;
  const parsed = Date.parse(candidate?.updatedAt ?? '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function mergeCodexDiscoveredStates(states, discovered) {
  const bySession = new Map();
  for (const state of states) bySession.set(state.sessionId, state);

  for (const state of discovered) {
    const existing = bySession.get(state.sessionId);
    if (!existing) {
      bySession.set(state.sessionId, state);
      continue;
    }

    bySession.set(state.sessionId, {
      ...existing,
      host: existing.host ?? state.host,
      projectPath: existing.projectPath || state.projectPath,
      rolloutPath: state.rolloutPath ?? existing.rolloutPath,
      updatedAt: Math.max(Number(existing.updatedAt) || 0, Number(state.updatedAt) || 0),
      discoveredFrom: state.discoveredFrom,
    });
  }

  return Array.from(bySession.values());
}

function readMonitorStates(args = {}, cwd = process.cwd()) {
  const states = readAllSessionStates();
  return mergeCodexDiscoveredStates(states, discoverCodexSessionStates(args, cwd));
}

// --- フィルタ ---
/**
 * セッション一覧に表示フィルタを適用する。
 * ルール:
 *   - stale (15 分無活動) は基本非表示。--all のときのみ stale も含める
 *   - --session が指定されればプレフィックス一致、ただし base (stale フィルタ通過済み) 上で絞る
 *   - --session 無し & --all 無しのときは cwd 一致のみ残す
 */
function filterStates(states, args, cwd) {
  const base = args.all ? states : states.filter((s) => !s.stale);
  if (args.session) {
    // startsWith が完全一致も含むので === は冗長
    return base.filter((s) => s.sessionId.startsWith(args.session));
  }
  if (args.all) return base;
  const normalizedCwd = normalizeProjectPath(cwd);
  return base.filter((s) => s.projectPath === normalizedCwd);
}

// --- メインループ ---
let lastRenderedLines = 0;
let lastRenderKey = '';

/**
 * 再描画要否の判定キー。state ファイル群の mtime と transcript / rollout JSONL の
 * size + mtime を
 * 1 本の文字列にまとめてハッシュキーとする。キーが前回と同じなら描画スキップ。
 *
 * 注: state-file の mtime は Stop hook のタイミングで更新されるが、
 * transcript / rollout は実行中に太る。その live file 変化も render key に含める。
 */
function computeRenderKey(args = {}, cwd = process.cwd()) {
  const parts = [];
  // state mtimes
  const mtimes = snapshotStateMtimes();
  const names = Array.from(mtimes.keys()).sort();
  for (const name of names) parts.push(`s:${name}:${mtimes.get(name)}`);
  // live transcript / rollout sizes（state ファイルを読まずに直接 stat、IO 最小化）
  try {
    const states = readMonitorStates(args, cwd);
    for (const st of states) {
      for (const [kind, path] of [['t', st.transcriptPath], ['r', st.rolloutPath]]) {
        if (!path || !existsSync(path)) continue;
        try {
          const stat = statSync(path);
          parts.push(`${kind}:${st.sessionId}:${stat.size}:${stat.mtimeMs}`);
        } catch {
          // stat 失敗は無視（次フレームで回復）
        }
      }
    }
  } catch {
    // readAllSessionStates 自体の失敗も 1 フレームで回復
  }
  return parts.join('|');
}

/**
 * 前回と比べてキーが変化していれば true。副作用として lastRenderKey を更新する。
 */
function needsRerender(args = {}, cwd = process.cwd()) {
  const key = computeRenderKey(args, cwd);
  if (key !== lastRenderKey) {
    lastRenderKey = key;
    return true;
  }
  return false;
}

/** テスト用リセット */
function resetRenderKeyCache() {
  lastRenderKey = '';
}

function renderFrame(args) {
  const now = Date.now();
  const states = readMonitorStates(args).map((state) => withLiveActivity(state, now));
  const filtered = filterStates(states, args, process.cwd()).sort(
    (a, b) => b.updatedAt - a.updatedAt,
  );

  const lines = [];
  if (filtered.length === 0) {
    if (args.session) {
      // --session 指定で未ヒットは「存在しない」と明示（一般の "待機中" と区別）
      lines.push(color(ANSI.yellow, `[Throughline] セッション "${args.session}" に一致する active セッションが見つかりません`));
      lines.push(color(ANSI.dim, '  (プレフィックス指定も可。--all で stale を含めて再検索)'));
    } else {
      lines.push(color(ANSI.dim, '[Throughline] 待機中 — アクティブなセッションがありません'));
      if (!args.all) {
        lines.push(color(ANSI.dim, `  (${normalizeProjectPath(process.cwd())} に state 無し。--all で全プロジェクト表示)`));
      }
    }
  } else {
    const header = color(
      ANSI.bold,
      `[Throughline] ${filtered.length} セッション${args.all ? ' (--all)' : ''}`,
    );
    lines.push(header);
    for (let i = 0; i < filtered.length; i++) {
      const state = filtered[i];
      const usage = resolveMonitorUsage(state);
      lines.push(formatLine({ state, usage, isActive: i === 0, now }));
    }
  }

  // ★ 折り返し対策: 各行を (columns - 1) セル幅に切り詰めて物理 1 行に収める。
  //   こうすれば ANSI.up(lines.length) と論理行数が物理行数と一致する。
  //   columns - 1 にしてるのはターミナル末尾列に書くと自動改行する端末があるため。
  //   truncateToCells は CJK / 絵文字を 2 セルとして正しく数える。
  const columns = resolveColumns();
  const clipped = lines.map((l) => truncateToCells(l, columns));

  // 再描画戦略:
  //   - TTY: 真の columns が分かるので CUU + clearBelow で部分再描画（省フリッカ）
  //   - 非 TTY (VSCode の type:process タスク等): columns を信用できないので 200 で
  //     truncate しているが、実ターミナル幅が 200 未満なら自動改行が起き、論理行数と
  //     物理行数がズレて CUU が誤作動する（「1 セッション」行が毎フレーム積み上がる
  //     バグを実機で確認）。非 TTY では画面全クリアで愚直に描き直す方が確実。
  //   どちらも差分検知 (needsRerender) を通過したフレームのみ書き込むので、
  //   フリッカ量はデータ変化頻度に比例するだけで爆発しない。
  if (process.stdout.isTTY) {
    if (lastRenderedLines > 0) {
      process.stdout.write(ANSI.up(lastRenderedLines) + '\r' + ANSI.clearBelow);
    }
  } else {
    process.stdout.write(ANSI.clearScreen);
  }

  process.stdout.write(clipped.join('\n') + '\n');
  lastRenderedLines = clipped.length;
}

// --- 起動 ---
let cursorRestored = false;
function restoreCursor() {
  if (cursorRestored) return;
  cursorRestored = true;
  try {
    process.stdout.write(ANSI.showCursor);
  } catch {
    // stdout がすでに閉じていても無視
  }
}

function safeRenderFrame(args) {
  try {
    renderFrame(args);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown error';
    process.stderr.write(`[Throughline] render error: ${msg}\n`);
    // 1 フレームの失敗で常駐を落とさない。次フレームで回復を試す
  }
}

/**
 * 環境診断モード。ユーザー環境で「モニターの描画が壊れる」と報告されたときに、
 * 実際の process.stdout / env / TERM の値をその場で可視化するための一発起動モード。
 *
 * 過去に「`type: process` だと非 TTY」「`type: shell` なら PTY」など推測で描画戦略を
 * 変えてきたが、PTY が張られるかどうかは VSCode のバージョンや Windows の ConPTY
 * 実装に依存し、推測は外れ続けた。このコマンドで実測値を 1 ページに出すことで、
 * 「この環境では何が起きているか」を断定できるようにする。
 *
 * 出力は ~/.throughline/last-diag.txt にも保存する。task terminal のようにスクロール
 * バックが分かりづらい環境でも後からファイルを読めば全情報を回収できる。
 */
function runDiagnostic() {
  const lines = [];
  const emit = (s) => {
    process.stdout.write(s);
    lines.push(s);
  };
  const out = (k, v) => emit(`${k.padEnd(28)}${v}\n`);

  emit('=== Throughline monitor diagnostic ===\n');
  emit(`timestamp: ${new Date().toISOString()}\n\n`);

  emit('[process.stdout]\n');
  out('  isTTY', String(Boolean(process.stdout.isTTY)));
  out('  columns', String(process.stdout.columns ?? '(undefined)'));
  out('  rows', String(process.stdout.rows ?? '(undefined)'));
  out('  hasColors()',
    typeof process.stdout.hasColors === 'function'
      ? String(process.stdout.hasColors())
      : '(n/a)',
  );
  emit('\n');

  emit('[process.stderr]\n');
  out('  isTTY', String(Boolean(process.stderr.isTTY)));
  emit('\n');

  emit('[env]\n');
  for (const key of ['TERM', 'TERM_PROGRAM', 'TERM_PROGRAM_VERSION', 'COLORTERM', 'COLUMNS', 'LINES', 'VSCODE_PID', 'VSCODE_IPC_HOOK_CLI', 'VSCODE_INJECTION', 'VSCODE_SHELL_INTEGRATION', 'WT_SESSION', 'ConEmuPID', 'OSTYPE', 'MSYSTEM']) {
    out(`  ${key}`, process.env[key] ?? '(unset)');
  }
  emit('\n');

  emit('[resolveColumns()]\n');
  out('  value', String(resolveColumns()));
  emit('\n');

  emit('[platform]\n');
  out('  process.platform', process.platform);
  out('  process.versions.node', process.versions.node);
  emit('\n');

  emit('=== end of diag ===\n');
  emit('\nこの出力を全文コピーするか、~/.throughline/last-diag.txt を開いて内容を共有してください。\n');
  emit('task terminal でスクロールして読めない場合は PowerShell で\n');
  emit('  cat ~/.throughline/last-diag.txt\n');
  emit('を実行すれば同じ内容が読めます。\n');

  // ログファイルに保存 (task terminal のようにスクロール不能な環境向け)
  try {
    const logPath = join(dataRoot(), 'last-diag.txt');
    mkdirSync(dirname(logPath), { recursive: true });
    writeFileSync(logPath, lines.join(''));
    emit(`\n[ログ保存] ${logPath}\n`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown';
    emit(`\n[ログ保存失敗] ${msg}\n`);
  }

  process.exit(0);
}

export function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'invalid args';
    process.stderr.write(`[Throughline] ${msg}\n`);
    process.exit(2);
  }

  if (args.diag) {
    runDiagnostic();
    return;
  }

  process.stdout.write(ANSI.hideCursor);
  process.stdout.write(color(ANSI.dim, `[Throughline] モニター起動 (state: ${getStateDir()}, Ctrl+C で終了)\n`));

  // OSC 18t で端末に直接「今の幅は？」を問い合わせる経路を立ち上げる。
  // Windows ConPTY + VSCode task terminal では process.stdout.columns が凍結するため、
  // これが無いと panel を広げても content が復活しない。
  // 応答が来るたびに measuredCols を更新 → 次フレームで resolveColumns がそれを使う。
  const sizeQuery = startSizeQuery({
    onSize: ({ cols }) => {
      const prev = resolveColumns();
      setMeasuredColumns(cols);
      const curr = resolveColumns();
      if (prev !== curr) {
        // 幅が変わると前フレームは別幅で wrap している可能性があり、CUU ベースの
        // 部分再描画では消し残る。全画面クリアで確実にリセットしてから描き直す。
        // greeting も消えるが、resize の瞬間だけの一時的コスト。
        process.stdout.write(ANSI.clearScreen);
        lastRenderedLines = 0;
        resetRenderKeyCache();
        safeRenderFrame(args);
      }
    },
    onInterrupt: () => process.kill(process.pid, 'SIGINT'),
  });

  safeRenderFrame(args);
  // 起動直後に 1 回クエリを飛ばして正しい初期幅を取る
  if (sizeQuery.supported) sizeQuery.query();

  // 1 秒 tick:
  //   - OSC 18t に対応している端末なら毎回クエリを投げて resize 追従
  //   - 対応していない端末では process.stdout.columns の変化を従来通り polling
  //   - 更新が無くてもデータ変化 (needsRerender) があれば再描画
  //   - 10 秒に 1 回は (Nm ago) 表示更新のために強制再描画
  let lastColumns = process.stdout.columns ?? 0;
  const timer = setInterval(() => {
    if (sizeQuery.supported) sizeQuery.query();

    const currCols = process.stdout.columns ?? 0;
    if (shouldForceFullRedraw(lastColumns, currCols)) {
      lastColumns = currCols;
      process.stdout.write(ANSI.clearScreen);
      lastRenderedLines = 0;
      resetRenderKeyCache();
      safeRenderFrame(args);
      return;
    }
    if (needsRerender(args)) safeRenderFrame(args);
    if (Date.now() - lastTimeAgoRefresh > TIME_AGO_REFRESH_MS) {
      lastTimeAgoRefresh = Date.now();
      safeRenderFrame(args);
    }
  }, REFRESH_MS);

  // resize イベント経路は残す: polling 前に通知が来ればより速く反応できる。
  // debounce 200ms でドラッグ中のジッタを吸収し、polling 側との二重再描画も防ぐ。
  let resizeTimer = null;
  const onResize = () => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      resizeTimer = null;
      // 既存描画が新しい幅では崩れている可能性があるため全画面クリアで描き直す
      lastColumns = process.stdout.columns ?? 0;
      process.stdout.write(ANSI.clearScreen);
      lastRenderedLines = 0;
      resetRenderKeyCache();
      safeRenderFrame(args);
    }, 200);
  };
  if (typeof process.stdout.on === 'function') {
    process.stdout.on('resize', onResize);
  }

  const shutdown = (code = 0) => {
    clearInterval(timer);
    if (resizeTimer) clearTimeout(resizeTimer);
    sizeQuery.stop(); // stdin raw mode を確実に解除 (残ると端末が壊れる)
    restoreCursor();
    process.stdout.write('\n' + color(ANSI.dim, '[Throughline] モニター終了\n'));
    process.exit(code);
  };
  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));

  // クラッシュ時もカーソルと raw mode を必ず戻す
  const cleanupOnCrash = () => {
    sizeQuery.stop();
    restoreCursor();
  };
  process.on('exit', cleanupOnCrash);
  process.on('uncaughtException', (err) => {
    cleanupOnCrash();
    const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
    process.stderr.write(`[Throughline] uncaught exception:\n${msg}\n`);
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    cleanupOnCrash();
    process.stderr.write(`[Throughline] unhandled rejection: ${String(reason)}\n`);
    process.exit(1);
  });
}

// --- テスト用エクスポート（本番コードからは参照しない） ---
export const _internal = {
  parseArgs,
  filterStates,
  cellWidth,
  truncateToCells,
  padCellsEnd,
  formatNumber,
  renderBar,
  formatLine,
  computeRenderKey,
  needsRerender,
  resetRenderKeyCache,
  formatTimeAgo,
  shouldForceFullRedraw,
  resolveColumns,
  setMeasuredColumns,
  liveActivityMs,
  withLiveActivity,
  resolveMonitorUsage,
  codexDiscoveryOptions,
  discoverCodexSessionStates,
  mergeCodexDiscoveredStates,
  readMonitorStates,
};

// --- エントリポイント自動起動 ---
// `node src/token-monitor.mjs` 直接起動（VSCode タスク .vscode/tasks.json が使うパターン）
// のとき main() を自動実行する。
// dispatcher 経由（`throughline monitor`）は bin/throughline.mjs が明示的に main() を呼ぶ。
// テスト import（`node --test src/token-monitor.test.mjs`）は argv[1] が `.test.mjs` で終わる。
// argv[1] が 'token-monitor.mjs' で終わって '.test.mjs' でないケースだけ auto-run する。
{
  const argv1 = (process.argv[1] || '').replace(/\\/g, '/');
  const isDirectEntry = argv1.endsWith('token-monitor.mjs') && !argv1.endsWith('.test.mjs');
  if (isDirectEntry) {
    main();
  }
}
