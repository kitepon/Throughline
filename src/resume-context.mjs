/**
 * resume-context.mjs — 引継ぎ注入テキストを組み立てる共有モジュール
 *
 * 呼び出し元:
 *   - handoff-executor.mjs（最初のUserPromptSubmitでauto path / baton path共通注入）
 *   - handoff-executor.mjs（前任が自動継続で引き継いだ会話の、最初のUserPromptSubmit。ADR 0033）
 *
 * 設計 (docs/02_clear_auto_handoff_plan.md):
 *   - 予算付き注入: ヘッダ + 現在地アンカー + pull案内を固定部とし、残りへ
 *     直近L2ターン全文を新しい順にターン原子で詰める。L1は直接注入しない。
 *   - 「現在地」アンカーは直前の user / assistant turn をヘッダ直下に再掲して
 *     最初の注意を最新ターンに固定する。L2 末尾アンカーは補強として残す。
 *     （L2 が長くなると末尾アンカーだけでは前半の古いターンに注意が固着し、
 *      話の流れを取り違える事例があった）
 *   - L3は本文を注入せず、`throughline detail HH:MM:SS`でpullする
 *   - L2 全文があれば最後の assistant turn 自体に「次に何をしようとしていたか」が
 *     含まれるため、memo / thinking / 末尾の再開指示は注入しない
 *   - 各行頭に [HH:MM:SS] 時刻プレフィックス（L2 は body の created_at、
 *     L1 は元ターンの body 時刻が取れればそれ、なければ skeleton 時刻）
 *   - 現セッションのターンは注入しない（Claude Code 本体のコンテキストに既にあるため）
 *   - フレーミング: 「報告してください」のメタ命令は出さない。直前の対話の
 *     自然な続きとして応答させる
 */

import { buildHandoffRecord } from './handoff-record.mjs';
import { groupL3ByTurn, buildPartsSummary } from './l3-summary.mjs';

const RESUME_HEADER_TEMPLATE = (turnCount, handoffDisclosure) =>
  `## Throughline: 直前スレッドの継続応答用コンテキスト（${turnCount} ターン分の文脈を保持）\n` +
  (handoffDisclosure === 'visible'
    ? `\n` +
      `**この引き継ぎ直後の最初の応答だけ、冒頭で以下を 1 行宣言してください**:\n` +
      `> 「Throughline で前のセッションから ${turnCount} ターン分の記憶を引き継いだ状態で続けます」\n` +
      `**2 回目以降の応答では、この宣言を繰り返さないでください。**\n`
    : '') +
  `\n` +
  `**読み方 (重要):**\n` +
  `- 下記「現在地」「L1」「L2」は **あなた自身が直前にユーザーと交わした会話** です ` +
  `(画面が /clear されただけで、同じスレッドが継続しています)。\n` +
  `- ユーザーの次のメッセージは新規依頼ではなく、上記スレッドの **続き** です。\n` +
  `- 「続きよろしく」「OK」「次は？」のような短いメッセージは、**「現在地」の「直前のアシスタント」` +
  `が示した次の一手をそのまま実行** してください。\n` +
  `- **短文/相槌の判定**: 50 字以下、または「はい」「うん」「了解」「OK」「やって」「進めて」「続き」` +
  `「次」のような相槌/同意/促し語だけで構成されているメッセージは、新しい依頼ではなく ` +
  `**直前のアシスタントの提案に対する GO サイン** として扱ってください。\n` +
  `- 短文を受けたら **やってはいけないこと**: 「何の話ですか?」と聞き返す / 改めて選択肢を提示しなおす / ` +
  `直前のアシスタントが示した次の一手を無視して別の作業を始める。\n` +
  `- **古い番号リストの再実行禁止**: 過去ターンで提示した番号付き選択肢 (例: 1/2/3) を最新ユーザーが ` +
  `「2 をやれ」のように参照した場合、その項目が既に直前アシスタントターンで実装/実行済みなら、` +
  `再実行ではなく **結果確認・次の一手** として応答してください ` +
  `(最新アシスタント発話の指示が、過去ターンのリストへの参照より上位)。\n` +
  `- 「何のことですか？」「初めまして」「何を確認したいですか?」と返すのは適切ではありません ` +
  `(新規会話ではない)。\n` +
  '- **各ターンの詳細**: **`Bash` ツールで `throughline detail HH:MM:SS` を実行** ' +
  `(該当ターンの本文＋詳細を stdout に返します)`;

const NORMAL_HEADER = '## Throughline: セッション記憶';

const DEFAULT_ANCHOR_TITLE = '### 現在地 (直前のやりとり)';

// 自動継続で立てた新しい会話へ注入する時のヘッダ (ADR 0033)。/clear の引き継ぎと違い、
// 前の会話は作業の途中で止めてあり、次のユーザー入力は来ない。宣言はさせず、そのまま続けさせる。
const AUTO_CONTINUATION_HEADER = (projectPath) =>
  `## Throughline: 自動継続の文脈\n` +
  (projectPath ? `作業ディレクトリ: ${projectPath}\n` : '') +
  `\n` +
  `**読み方 (重要):**\n` +
  `- 前の会話は文脈の上限に近づいたため、Throughline が自動圧縮の前に止めて、この新しい会話へ引き継ぎました。` +
  `下記は、前の会話で **あなた自身とユーザーが交わした会話の原文** です。\n` +
  `- 「現在地」のターンは **作業の途中で止めたもの** です。ユーザーの追加入力を待たず、未完了の作業をそのまま続けてください。\n` +
  `- 「ここまでにしたこと」と「直前の対話」に載っている操作は **完了しています**。繰り返さないでください。` +
  `未実行なのは「実行されなかった道具」だけです。そこから続けてください。\n` +
  `- 直前の実行結果が分からない時は、作業ツリーや詳細を確かめてから続けてください。\n` +
  '- **各ターンの詳細**（止めたターンを含む）: **`Bash` ツールで `throughline detail HH:MM:SS` を実行** ' +
  `(該当ターンの本文＋道具の入出力を stdout に返します)`;

const AUTO_CONTINUATION_ANCHOR_TITLE = '### 現在地 (作業の途中で止めたターン)';
// 止めたターンは現在地にだけ載せ、L2 の一覧からは外す（同じ依頼を二度載せない）。
// /clear のアンカー (600 字) より厚く取る。3つの上限を足しても、ヘッダと案内を合わせて予算に収まる。
const IN_FLIGHT_USER_MAX_CHARS = 3_500;
const IN_FLIGHT_ASSISTANT_MAX_CHARS = 1_500;
// 止めたターンでここまでにしたこと（発言と道具の呼び出し）。新しい側から、入るだけ載せる。
const IN_FLIGHT_STEPS_MAX_CHARS = 2_400;

// v0.10.12以前にThroughline自身がassistantへ付与させていた宣言行。
// 製品由来のメタ情報だけを引き継ぎ材料から除き、会話本文への模倣連鎖を止める。
// userが同じ文を引用した場合は会話内容なので保持する。
const LEGACY_HANDOFF_DISCLOSURE =
  /^「Throughline で前のセッションから \d+ ターン分の記憶を引き継いだ状態で続けます」[ \t]*(?:\r?\n[ \t]*)*/u;

function textForHandoff(row) {
  if (row.role !== 'assistant') return row.text;
  return row.text.replace(LEGACY_HANDOFF_DISCLOSURE, '');
}

// 現在地アンカーは最新 user / assistant 本文を再掲する。長すぎると注入全体が膨らむので
// この文字数で打ち切り、全文は L2 セクション側を参照させる。
const ANCHOR_MAX_CHARS = 600;

function truncateForAnchor(text) {
  const normalized = text.replace(/\n+/g, ' ').trim();
  if (normalized.length <= ANCHOR_MAX_CHARS) return normalized;
  return normalized.slice(0, ANCHOR_MAX_CHARS) + ' …';
}

/**
 * recentBodies (古い順) から「直前のやりとり」アンカー用に
 * 最新の user / assistant 行をそれぞれ 1 件ずつ拾う。
 */
function pickLatestExchange(recentBodies) {
  let latestUser = null;
  let latestAssistant = null;
  for (let i = recentBodies.length - 1; i >= 0; i -= 1) {
    const r = recentBodies[i];
    if (!r.text) continue;
    if (r.role === 'assistant' && !latestAssistant) {
      latestAssistant = r;
    } else if (r.role === 'user' && !latestUser) {
      latestUser = r;
    }
    if (latestUser && latestAssistant) break;
  }
  return { latestUser, latestAssistant };
}

/**
 * 注入セクションを構造化して組み立てる（内部共通）。
 * buildResumeContext (無制限) と buildBudgetedResumeContext (予算付き) が共有する。
 *
 * @returns {{
 *   header: string,
 *   anchorLines: string[],
 *   l1Lines: string[],
 *   l2Lines: { text: string, time: string }[],
 * } | null}
 */
function buildResumeSections(
  db,
  { sessionId, isInheritance, excludeOriginId = null, handoffDisclosure = 'visible' },
) {
  if (!['visible', 'silent'].includes(handoffDisclosure)) {
    throw new TypeError('invalid handoff disclosure');
  }
  const record = buildHandoffRecord(db, {
    sessionId,
    isInheritance,
    excludeOriginId,
  });
  if (!record) return null;

  const turnCount = record.stats.preservedContextRows;
  const header = isInheritance
    ? RESUME_HEADER_TEMPLATE(turnCount, handoffDisclosure)
    : NORMAL_HEADER;
  const recentBodies = record.memory.recentBodies.map((row) => ({
    ...row,
    text: textForHandoff(row),
  }));

  const l3ByTurn = groupL3ByTurn(record.references.l3);

  // 現在地アンカー: 引き継ぎ時のみ、最新 user / assistant turn をヘッダ直下に再掲する。
  // L2 末尾アンカーだけだと、長い L2 で注意が前半に固着して話の流れを取り違える事例があった。
  const anchorLines = [];
  if (isInheritance && recentBodies.length > 0) {
    const { latestUser, latestAssistant } = pickLatestExchange(recentBodies);
    if (latestUser) {
      anchorLines.push(
        `**最新ユーザー指示** [${latestUser.time}]: ${truncateForAnchor(latestUser.text)}`,
      );
    }
    if (latestAssistant) {
      anchorLines.push(
        `**直前のアシスタント** [${latestAssistant.time}]: ${truncateForAnchor(latestAssistant.text)}`,
      );
    }
  }

  const l1Lines = [];
  for (const r of record.memory.l1Summaries) {
    if (!r.summary || r.summary === '(no content)') continue;
    const summary = r.summary.replace(/\n+/g, ' ').trim();
    const key = `${r.originSessionId}\x00${r.turnNumber}`;

    // body 時刻が引けた行だけ詳細呼び出しを案内する。引けない場合は
    // `[skeleton 時刻]` のままだと throughline detail が解決しないので suffix を出さない。
    const displayTime = r.bodyTime ?? r.time;
    const partCounts = l3ByTurn.get(key)?.partCounts ?? new Map();
    const suffix = r.bodyTime != null
      ? buildPartsSummary(partCounts, { includeBody: true })
      : '';

    l1Lines.push(`[${displayTime}] ${summary}${suffix}`);
  }

  // ターン内の最終 role 行 (通常 user→assistant 順なら assistant) にだけ suffix を出す。
  // L3 (思考 / ツール / hook 出力 / 画像) は turn_number 単位でしか紐付いていないので
  // 同じターンの user 行と assistant 行の両方に貼ると同じ内容が二度出て紛らわしい。
  const l2Lines = [];
  const lastIdxPerTurn = new Map();
  for (let i = 0; i < recentBodies.length; i += 1) {
    const r = recentBodies[i];
    if (!r.text) continue;
    const key = `${r.originSessionId}\x00${r.turnNumber}`;
    lastIdxPerTurn.set(key, i);
  }
  for (let i = 0; i < recentBodies.length; i += 1) {
    const r = recentBodies[i];
    if (!r.text) continue;
    const key = `${r.originSessionId}\x00${r.turnNumber}`;
    const isLastOfTurn = lastIdxPerTurn.get(key) === i;
    const partCounts = isLastOfTurn ? (l3ByTurn.get(key)?.partCounts ?? new Map()) : new Map();
    const suffix = buildPartsSummary(partCounts);
    l2Lines.push({
      text: `[${r.time}] [${r.role}]: ${r.text}${suffix}`,
      time: r.time,
      role: r.role,
      turnKey: key,
      createdAt: r.createdAt,
    });
  }

  return { header, anchorTitle: DEFAULT_ANCHOR_TITLE, anchorLines, l1Lines, l2Lines };
}

function joinSections({ header, anchorTitle, anchorLines, l1Lines, l2Lines }, { l1Note = null, l2Note = null } = {}) {
  const lines = [header];
  if (anchorLines.length > 0) {
    lines.push('');
    lines.push(anchorTitle);
    lines.push(...anchorLines);
  }
  if (l1Lines.length > 0 || l1Note) {
    lines.push('');
    lines.push('### それ以前の要約 (L1)');
    if (l1Note) lines.push(l1Note);
    lines.push(...l1Lines);
  }
  if (l2Lines.length > 0 || l2Note) {
    lines.push('');
    lines.push('### 直前の対話 (L2 / active work thread, 古い順)');
    if (l2Note) lines.push(l2Note);
    lines.push(...l2Lines.map((l) => l.text));
  }
  return lines.join('\n');
}

/**
 * L1 + L2 注入テキストを組み立てる（サイズ無制限）。L3 は本文ではなく
 * 各 L1 / L2 行末尾の inline hint として付与する。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{
 *   sessionId: string,
 *   isInheritance: boolean,
 *   excludeOriginId?: string | null,
 *   inflightMemo?: string | null,
 * }} params
 * @returns {string | null}
 */
export function buildResumeContext(
  db,
  {
    sessionId,
    isInheritance,
    excludeOriginId = null,
    inflightMemo: _ignoredMemo = null,
    handoffDisclosure = 'visible',
  },
) {
  const sections = buildResumeSections(db, {
    sessionId,
    isInheritance,
    excludeOriginId,
    handoffDisclosure,
  });
  if (!sections) return null;
  return joinSections(sections);
}

/**
 * hook stdout 注入の予算上限（文字数）。
 *
 * 実測 (2026-07-17, Claude Code 2.1.211 / ADR 0014):
 *   SessionStart / UserPromptSubmit の hook stdout は約 10,000 字を超えると
 *   file 化され、モデル可視は `<persisted-output>`（ファイルパス + 先頭 2KB preview）
 *   だけに劣化する。9,501 字は inline 通過、15,286 字は file 化を確認。
 *   全 transcript 実測では >10k の注入 12 件が 12 件とも劣化していた
 *   (v2.1.195 / 2026-06-28 以降)。安全側マージンとして 9,500 に設定。
 */
export const INJECTION_BUDGET_CHARS = 9_500;

// 案内セクション（### さらに前の記憶）の予約分。ヘッダ・アンカーと同格の固定部として
// 予算計算の最初に差し引き、どれだけ逼迫しても落とさない（無条件表示）。
// 実文言はテンプレート固定 + 動的値（件数・時刻範囲・session id・ISO 境界）なので
// この上限内に収まる（session id ~42 字 + ISO 24 字 + 本文 2 行で最大 ~520 字を実測見積もり）。
const GUIDANCE_RESERVE = 600;
// 最新 L2 ターンが単体で予算を超える場合に、切り詰めてでも入れる最小の残余
const MIN_TRUNCATED_L2_CHARS = 400;

/**
 * 20 ターン窓の外側（それより古い側）のターン統計。
 * 案内セクションの `recall --l1` 行（全 M ターン / 要約済み K / 時刻範囲）に使う。
 */
function loadOlderTurnStats(db, { sessionId, excludeOriginId, windowKeys }) {
  const hasExclude = Boolean(excludeOriginId);
  const turnQuery = hasExclude
    ? `SELECT origin_session_id, turn_number, MIN(created_at) AS min_ca
       FROM bodies
       WHERE session_id = ? AND origin_session_id != ?
       GROUP BY origin_session_id, turn_number`
    : `SELECT origin_session_id, turn_number, MIN(created_at) AS min_ca
       FROM bodies
       WHERE session_id = ?
       GROUP BY origin_session_id, turn_number`;
  const allTurns = hasExclude
    ? db.prepare(turnQuery).all(sessionId, excludeOriginId)
    : db.prepare(turnQuery).all(sessionId);

  const older = allTurns.filter(
    (r) => !windowKeys.has(`${r.origin_session_id}\x00${r.turn_number}`),
  );
  if (older.length === 0) {
    return { total: 0, summarized: 0, minMs: null, maxMs: null };
  }

  const skelQuery = hasExclude
    ? `SELECT DISTINCT origin_session_id, turn_number FROM skeletons
       WHERE session_id = ? AND origin_session_id != ?`
    : `SELECT DISTINCT origin_session_id, turn_number FROM skeletons
       WHERE session_id = ?`;
  const skelKeys = new Set(
    (hasExclude
      ? db.prepare(skelQuery).all(sessionId, excludeOriginId)
      : db.prepare(skelQuery).all(sessionId)
    ).map((r) => `${r.origin_session_id}\x00${r.turn_number}`),
  );

  let minMs = Infinity;
  let maxMs = -Infinity;
  let summarized = 0;
  for (const r of older) {
    if (r.min_ca < minMs) minMs = r.min_ca;
    if (r.min_ca > maxMs) maxMs = r.min_ca;
    if (skelKeys.has(`${r.origin_session_id}\x00${r.turn_number}`)) summarized += 1;
  }
  return { total: older.length, summarized, minMs, maxMs };
}

function formatClock(unixMs) {
  const d = new Date(unixMs);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

/**
 * 案内セクション（無条件表示）。表示用の HH:MM:SS と機械用の境界（ISO 8601 ms / 件数 /
 * session id）を分離し、機械用は全部コマンド引数へ焼き込む。recall 側は再計算しない。
 */
function buildGuidanceLines({ sessionId, boundaryMs, remainingTurns, remainingRange, older }) {
  const lines = ['### さらに前の記憶（必要な時だけ取得）'];
  const boundaryIso = boundaryMs != null ? new Date(boundaryMs).toISOString() : null;

  if (remainingTurns > 0) {
    lines.push(
      `- これより前の続き${remainingTurns}ターン (${remainingRange}) の会話全文: ` +
        `\`throughline recall --l2 --session ${sessionId} --before ${boundaryIso} --last ${remainingTurns}\` を実行`,
    );
  } else {
    lines.push('- これより前の続き: なし（直近の会話は全て上の L2 セクションに注入済み）');
  }

  if (older.total > 0) {
    const range = `${formatClock(older.minMs)}〜${formatClock(older.maxMs)}`;
    lines.push(
      `- それ以前の全${older.total}ターン（要約済み ${older.summarized} / 未要約 ${older.total - older.summarized}）の一覧 (${range}): ` +
        `\`throughline recall --l1 --session ${sessionId} --before ${boundaryIso} --skip ${remainingTurns}\` を実行` +
        '（気になるターンは `throughline detail <時刻>` で全文・ツール入出力まで掘れる）',
    );
  } else {
    lines.push('- それ以前のターン: なし');
  }
  return lines;
}

/**
 * 予算付き注入テキスト。構成 (オーナー裁定 2026-07-18):
 *   1. ヘッダ + 現在地アンカー（常に全文）
 *   2. 案内セクション（無条件表示。予約 GUIDANCE_RESERVE を先に差し引く）
 *   3. L2 本文: 新しい順に**丸ごと入るターンだけ**詰めて古い順に出力
 *      （ターン単位の原子。固定 N で予算を遊ばせず、断片も詰めない。
 *       ターン境界の自然な端数は許容）
 *   L1 は注入しない（窓の残りは recall --l2、それより古い側は recall --l1 が担う）。
 *   最新ターンが単体で予算を超える場合だけ、切り詰めてでも入れる
 *   （現在地の文脈をアンカー 600 字より厚く確保するため）。
 *
 * @returns {{
 *   text: string,
 *   totalChars: number,
 *   injectedL2Turns: number,
 *   remainingL2Turns: number,
 *   olderTurns: number,
 *   olderSummarized: number,
 *   truncatedNewestL2: boolean,
 * } | null}
 */
export function buildBudgetedResumeContext(
  db,
  {
    sessionId,
    isInheritance,
    excludeOriginId = null,
    maxChars = INJECTION_BUDGET_CHARS,
    handoffDisclosure = 'visible',
  },
) {
  const sections = buildResumeSections(db, {
    sessionId,
    isInheritance,
    excludeOriginId,
    handoffDisclosure,
  });
  if (!sections) return null;
  return renderBudgetedSections(db, sections, { sessionId, excludeOriginId, maxChars });
}

/** 組み立て済みのセクションを、予算内の注入テキストにする（/clear の引き継ぎと自動圧縮後の継続が共有）。 */
function renderBudgetedSections(db, sections, { sessionId, excludeOriginId, maxChars }) {
  const lineCost = (s) => s.length + 1; // join('\n') 分

  // L2 行をターン単位のグループにまとめる（元の古い順を保つ）
  const turns = [];
  const turnIndex = new Map();
  for (const line of sections.l2Lines) {
    let group = turnIndex.get(line.turnKey);
    if (!group) {
      group = { turnKey: line.turnKey, lines: [], minCreatedAt: Infinity, maxCreatedAt: -Infinity };
      turnIndex.set(line.turnKey, group);
      turns.push(group);
    }
    group.lines.push(line);
    if (line.createdAt < group.minCreatedAt) group.minCreatedAt = line.createdAt;
    if (line.createdAt > group.maxCreatedAt) group.maxCreatedAt = line.createdAt;
  }

  // 固定部 (ヘッダ + アンカー + セクション見出し + 案内予約) のコスト
  const fixedCost =
    lineCost(sections.header) +
    (sections.anchorLines.length > 0
      ? lineCost('') + lineCost(sections.anchorTitle) +
        sections.anchorLines.reduce((a, l) => a + lineCost(l), 0)
      : 0) +
    lineCost('') + lineCost('### 直前の対話 (L2 / active work thread, 古い順)');

  let remaining = maxChars - fixedCost - GUIDANCE_RESERVE;

  // L2: 新しい順にターンを丸ごと採用して古い順で出力
  const keptTurns = [];
  let truncatedNewestL2 = false;
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const turn = turns[i];
    const cost = turn.lines.reduce((a, l) => a + lineCost(l.text), 0);
    if (remaining - cost >= 0) {
      keptTurns.unshift(turn);
      remaining -= cost;
      continue;
    }
    // 最新ターンが単体で入らない場合だけ、最新行を切り詰めて確保する
    if (keptTurns.length === 0 && remaining >= MIN_TRUNCATED_L2_CHARS) {
      const newestLine = turn.lines[turn.lines.length - 1];
      const marker = ` …(予算超過で切詰め; 全文: throughline detail ${newestLine.time})`;
      const keep = remaining - marker.length - 1;
      keptTurns.unshift({
        ...turn,
        lines: [{ ...newestLine, text: newestLine.text.slice(0, keep) + marker }],
      });
      remaining = 0;
      truncatedNewestL2 = true;
    }
    break; // ターン原子: 入らないターンが出たらそこで打ち切り (歯抜けを作らない)
  }

  const injectedL2Turns = keptTurns.length;
  const remainingL2Turns = turns.length - injectedL2Turns;

  // pull 境界: 実際に注入できた最古ターンの min(created_at)。strict less-than で
  // 「それより古い側」が recall --l2 の担当になる。1 ターンも入らなかった場合は
  // 最新ターンの max(created_at)+1 を境界にして窓全体を pull 側に渡す。
  let boundaryMs = null;
  if (injectedL2Turns > 0) {
    boundaryMs = keptTurns[0].minCreatedAt;
  } else if (turns.length > 0) {
    boundaryMs = turns[turns.length - 1].maxCreatedAt + 1;
  }

  let remainingRange = null;
  if (remainingL2Turns > 0) {
    const remainingTurnsList = turns.slice(0, remainingL2Turns);
    remainingRange = `${formatClock(remainingTurnsList[0].minCreatedAt)}〜${formatClock(remainingTurnsList[remainingTurnsList.length - 1].maxCreatedAt)}`;
  }

  const older = loadOlderTurnStats(db, {
    sessionId,
    excludeOriginId,
    // 現在地にだけ載せたターン（自動継続の止めたターン）は、窓の外の古いターンに数えない。
    windowKeys: new Set([...turns.map((t) => t.turnKey), ...(sections.anchorTurnKeys ?? [])]),
  });

  const guidanceLines = buildGuidanceLines({
    sessionId,
    boundaryMs,
    remainingTurns: remainingL2Turns,
    remainingRange,
    older,
  });

  const lines = [sections.header];
  if (sections.anchorLines.length > 0) {
    lines.push('');
    lines.push(sections.anchorTitle);
    lines.push(...sections.anchorLines);
  }
  lines.push('');
  lines.push(...guidanceLines);
  if (keptTurns.length > 0) {
    lines.push('');
    lines.push('### 直前の対話 (L2 / active work thread, 古い順)');
    for (const turn of keptTurns) {
      lines.push(...turn.lines.map((l) => l.text));
    }
  }
  const text = lines.join('\n');

  return {
    text,
    totalChars: text.length,
    injectedL2Turns,
    remainingL2Turns,
    olderTurns: older.total,
    olderSummarized: older.summarized,
    truncatedNewestL2,
  };
}

// 長い依頼は、指示が先頭にも末尾にも書かれる。先頭 3/4 と末尾 1/4 を残し、間を抜いたことを明示する。
function truncateInFlight(text, maxChars) {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;
  const head = Math.ceil(maxChars * 0.75);
  const tail = maxChars - head;
  return `${trimmed.slice(0, head)} …(長いため中略 ${trimmed.length - maxChars} 字)… ${trimmed.slice(-tail)}`;
}

/**
 * 止めたターンでここまでにしたことを、現在地の行にする。
 * 新しい側から予算に入るだけ載せ、載せなかった古い側は件数だけを1行にまとめる。
 * @returns {{lines: string[], shownTexts: Set<string>}}
 */
function renderInFlightSteps(inFlight, detailClock) {
  const steps = [...(inFlight.steps ?? [])];
  const earlier = inFlight.earlier_steps ?? null;
  // 一覧の最後が止める直前の発言で、1行に詰めると元の文と変わる（改行がある・長い）時は、
  // 一覧から外して、下の「止める直前のあなたの発言」に全文で載せる。
  const last = steps.at(-1);
  const lastFragment = inFlight.last_fragment;
  if (last?.kind === 'text' && lastFragment && last.timestamp === lastFragment.timestamp &&
      last.content !== lastFragment.content.trim()) {
    steps.pop();
  }
  if (steps.length === 0 && !earlier) return { lines: [], shownTexts: new Set() };

  const rendered = steps.map((step) =>
    step.kind === 'text'
      ? `- 発言: ${step.content}`
      : `- 道具: ${step.name}${step.target ? ` ${step.target}` : ''}${step.failed ? ' → 失敗' : ''}`,
  );
  let budget = IN_FLIGHT_STEPS_MAX_CHARS;
  let first = rendered.length;
  while (first > 0 && budget - (rendered[first - 1].length + 1) >= 0) {
    first -= 1;
    budget -= rendered[first].length + 1;
  }
  const omitted = steps.slice(0, first);
  const omittedTexts = (earlier?.texts ?? 0) + omitted.filter((step) => step.kind === 'text').length;
  const omittedTools =
    Object.values(earlier?.tools ?? {}).reduce((sum, count) => sum + count, 0) +
    omitted.filter((step) => step.kind === 'tool').length;

  const lines = [
    `**このターンでここまでにしたこと**（古い順。どれも完了済み` +
      (detailClock ? `。道具の入出力の全文: \`throughline detail ${detailClock}\`` : '') +
      `）:`,
  ];
  if (omittedTexts + omittedTools > 0) {
    lines.push(`- （これより前に、発言 ${omittedTexts} 件・道具 ${omittedTools} 回）`);
  }
  lines.push(...rendered.slice(first));
  return {
    lines,
    shownTexts: new Set(steps.slice(first).filter((step) => step.kind === 'text').map((step) => step.content)),
  };
}

/**
 * 自動継続で立てた新しい会話へ注入するテキスト (ADR 0033)。
 *
 * 構成は /clear の引き継ぎと同じ予算付き（ヘッダ + 現在地 + 案内 + 入るだけの L2）。違いは現在地で、
 * DB の最新ターンではなく、止めた時点に記録した作業途中のターンを載せる。依頼、ここまでにしたこと
 * （発言と道具の呼び出し）、止める直前の発言、実行されなかった道具の順。止めたターンは L2 の一覧から外す。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{
 *   sessionId: string,  合流を終えた後継の session id
 *   inFlight: {
 *     user: {content: string, timestamp: number|null},
 *     last_fragment: {content: string, timestamp: number|null} | null,
 *     steps?: Array<{kind: 'text', content: string, timestamp: number|null} | {kind: 'tool', name: string, target: string, failed: boolean}>,
 *     earlier_steps?: {texts: number, tools: Record<string, number>} | null,
 *     stopped_tools?: Array<{name: string, target: string}>,
 *     stopped_tools_total?: number,
 *     turn?: {origin_session_id: string, turn_number: number, user_at: number, assistant_at: number|null} | null,
 *   } | null,
 *   projectPath?: string | null,  前の会話の作業ディレクトリ。依頼の中の相対的な場所の基準として渡す
 *   maxChars?: number,
 * }} params
 */
export function buildAutoContinuationContext(
  db,
  { sessionId, inFlight, projectPath = null, maxChars = INJECTION_BUDGET_CHARS },
) {
  const stored = buildResumeSections(db, { sessionId, isInheritance: true, handoffDisclosure: 'silent' });
  const stamp = (timestamp) => (timestamp == null ? '' : ` [${formatClock(timestamp)}]`);
  const anchorLines = [];
  const turn = inFlight?.turn ?? null;
  const turnKey = turn ? `${turn.origin_session_id}\x00${turn.turn_number}` : null;
  if (inFlight) {
    anchorLines.push(
      `**作業中のユーザー依頼**${stamp(inFlight.user.timestamp)}: ` +
        truncateInFlight(inFlight.user.content, IN_FLIGHT_USER_MAX_CHARS),
    );
    const steps = renderInFlightSteps(inFlight, turn ? formatClock(turn.assistant_at ?? turn.user_at) : null);
    anchorLines.push(...steps.lines);
    // 一覧に同じ文がそのまま載っている時は、重ねて載せない。改行のある発言や長い発言は、ここに全文を載せる。
    if (inFlight.last_fragment && !steps.shownTexts.has(inFlight.last_fragment.content.trim())) {
      anchorLines.push(
        `**止める直前のあなたの発言**${stamp(inFlight.last_fragment.timestamp)}: ` +
          truncateInFlight(inFlight.last_fragment.content, IN_FLIGHT_ASSISTANT_MAX_CHARS),
      );
    }
    const stoppedTools = inFlight.stopped_tools ?? [];
    if (stoppedTools.length > 0) {
      const more = (inFlight.stopped_tools_total ?? stoppedTools.length) - stoppedTools.length;
      anchorLines.push(
        `**止める直前に呼ぼうとして、実行されなかった道具**: ` +
          stoppedTools.map((tool) => `${tool.name}${tool.target ? ` ${tool.target}` : ''}`).join('、') +
          (more > 0 ? `（ほか ${more} 件）` : ''),
      );
    }
  }
  if (!stored && anchorLines.length === 0) return null;

  return renderBudgetedSections(
    db,
    {
      header: AUTO_CONTINUATION_HEADER(projectPath),
      anchorTitle: AUTO_CONTINUATION_ANCHOR_TITLE,
      anchorLines,
      anchorTurnKeys: turnKey ? [turnKey] : [],
      l1Lines: [],
      // 止めたターンは現在地に載せた。L2 の一覧には、それより前のターンだけを載せる。
      l2Lines: (stored?.l2Lines ?? []).filter((line) => line.turnKey !== turnKey),
    },
    { sessionId, excludeOriginId: null, maxChars },
  );
}
