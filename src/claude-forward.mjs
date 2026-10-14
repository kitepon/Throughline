/**
 * claude-forward.mjs — 引き継ぎ済みの Claude の会話へ届いた入力を、後継の会話へ届ける置き場 (ADR 0063)
 *
 * 旧い会話の UserPromptSubmit が、止めた入力を後継ごとの置き場へ1通1ファイルで置く。後継の hook
 * （Stop の待つ hook・UserPromptSubmit・PreToolUse）が受け取って、モデルへ渡す。
 *
 *   ~/.throughline/claude-auto-handoff/inbox/<後継の会話 ID>/<時刻>-<乱数>.json   届けるのを待つ入力
 *   ~/.throughline/claude-auto-handoff/inbox/<後継の会話 ID>/claimed/…            受け取った所が出力するまでの置き場
 *   ~/.throughline/claude-auto-handoff/inbox/<後継の会話 ID>/full/…               長すぎる入力の全文
 *   ~/.throughline/claude-auto-handoff/inbox/<後継の会話 ID>/waiter                今、待つ番の hook の印
 *   ~/.throughline/claude-auto-handoff/inbox/<後継の会話 ID>/waking                止まっている後継を起こしている所の印 (ADR 0064)
 *   ~/.throughline/claude-auto-handoff/forward.jsonl                              運んだ記録（本文は書かない）
 *
 * 届いたか分からない入力は入れ直さない。受け取る所は、ファイルを `claimed` へ改名してから出力し、出力した後で消す。
 * 道具の呼び出しのたびに走る hook からも読むので、ここは node の標準 module だけを読み込む。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

/** 運んだ文の頭に置く印。記憶を読む側（transcript-reader）が、この印で運んだ文を見分ける。 */
export const CLAUDE_FORWARD_MARK = '【Throughline 転送】';
const HUMAN_SECTION = '--- 利用者の入力';
const PEER_SECTION = '--- ほかの会話からの文';
const NOTIFICATION_SECTION = '--- 裏の作業の通知';
const KINDS = Object.freeze(['prompt', 'peer', 'task-notification']);
// Claude Code が、別の会話から届いた発言の頭に付ける文（hosts/claude.mjs の PEER_MESSAGE_PREFIX と同じ）。
const PEER_MESSAGE_PREFIX = 'Another Claude session sent a message:';

/**
 * 旧い会話へ届いた入力の種類。slash command（`/tl` など）は、その会話への命令で、後継へ運んでも命令にならないので
 * null を返す（運ばない。打った人には、後継で打ち直す文が返る）。
 * @returns {'prompt'|'peer'|'task-notification'|null}
 */
export function claudeForwardKind(prompt) {
  if (typeof prompt !== 'string' || !prompt.trim()) return null;
  if (/^\s*<task-notification>/.test(prompt)) return 'task-notification';
  if (prompt.startsWith(PEER_MESSAGE_PREFIX)) return 'peer';
  if (/^\s*\/[A-Za-z]/.test(prompt)) return null;
  return 'prompt';
}
/** 文脈として足す道（UserPromptSubmit・PreToolUse）で運ぶ上限。Claude Code は 10,000 字を超える文脈を頭だけに切り詰める。 */
export const CLAUDE_FORWARD_CONTEXT_MAX_CHARS = 9000;
/** Stop の道で、1通をそのまま運ぶ上限。超えた分は頭と、全文の file の場所を運ぶ。 */
const STOP_ITEM_MAX_CHARS = 60_000;
const STOP_ITEM_HEAD_CHARS = 4000;
const PENDING_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const EMPTY_INBOX_TTL_MS = 24 * 60 * 60 * 1000;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const ITEM_NAME = /^\d{13,}-[0-9a-f]{8}\.json$/;

const defaultDir = () => join(homedir(), '.throughline', 'claude-auto-handoff');

/** 後継の会話の置き場。会話 ID が置き場の名前に使えない形なら null。 */
export function claudeForwardInboxDir(sessionId, dir = defaultDir()) {
  return typeof sessionId === 'string' && SESSION_ID_PATTERN.test(sessionId) ? join(dir, 'inbox', sessionId) : null;
}

/** 置き場を作る。待つ hook は、このフォルダが在る会話でだけ待つ。 */
export function ensureClaudeForwardInbox(sessionId, dir = defaultDir()) {
  const inbox = claudeForwardInboxDir(sessionId, dir);
  if (!inbox) return false;
  try {
    mkdirSync(inbox, { recursive: true, mode: 0o700 });
    return true;
  } catch { return false; }
}

/** 運んだ記録。入力の本文は書かない。 */
export function logClaudeForward(entry, dir = defaultDir()) {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    appendFileSync(join(dir, 'forward.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n', { mode: 0o600 });
  } catch { /* 記録を書けなくても、運ぶ */ }
}

/**
 * 旧い会話が止めた入力を、後継の置き場へ置く。
 * @returns {boolean} 置けたか
 */
export function enqueueClaudeForward(input) {
  return writeClaudeForward(input) !== null;
}

/** 入力を1ファイルに書く。`claimed` が真なら、受け取り済みの置き場へ書く。書いたファイルの名前と場所を返す。 */
function writeClaudeForward({ successorSessionId, sourceSessionId, handoffId, kind, text, now = Date.now(), dir = defaultDir(), claimed = false }) {
  const inbox = claudeForwardInboxDir(successorSessionId, dir);
  if (!inbox || typeof text !== 'string' || !text.trim()) return null;
  try {
    const folder = claimed ? join(inbox, 'claimed') : inbox;
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    const name = `${String(now).padStart(13, '0')}-${randomUUID().slice(0, 8)}.json`;
    const path = join(folder, claimed ? `${name}.${process.pid}` : name);
    const temporary = join(folder, `${name}.tmp`);
    writeFileSync(temporary, JSON.stringify({ schema: 'throughline.claude-forward.v1', at: now,
      source_session_id: sourceSessionId ?? null, handoff_id: handoffId ?? null,
      kind: KINDS.includes(kind) ? kind : 'prompt', text }) + '\n', { mode: 0o600, flag: 'wx' });
    renameSync(temporary, path);
    return { inbox, name, path };
  } catch { return null; }
}

/**
 * 止まっている後継を起こす命令で直接渡す入力を、受け取り済み（`claimed`）として置く (ADR 0064)。置き場の入力として
 * 待たせると、起きた後継の hook が同じ文を文脈としてもう1回渡すため。起こす命令が終わったら、届いた時は `settle()`、
 * 届かなかったと確かめられた時は `release()`（置き場へ戻す）を呼ぶ。どちらも呼ばなければ、届いたか分からない入力として
 * `claimed` に残る（入れ直さない）。
 *
 * @returns {{settle: () => void, release: () => boolean}|null} 書けなかった時は null
 */
export function holdClaudeForward(input) {
  const written = writeClaudeForward({ ...input, claimed: true });
  if (!written) return null;
  return {
    settle: () => rmSync(written.path, { force: true }),
    release: () => {
      try { renameSync(written.path, join(written.inbox, written.name)); return true; }
      catch { return false; }
    },
  };
}

const WAKE_CLAIM_TTL_MS = 60_000;

/**
 * 止まっている後継を起こす番を取る (ADR 0064)。起こす命令を同時に2つ流すと、どちらも「起こした」と返るのに、
 * 後継へ届くのは1通だけになる（Claude Code 2.1.296 の実測）。番を取れなかった入力は、置き場で待たせる。
 * 起こせた後も印は消さず、60 秒の間は次の入力で起こさない（起きたばかりの後継は、一覧でまだ止まって見える事がある）。
 *
 * @returns {(() => void)|null} 番を返す関数。取れなかった時は null
 */
export function acquireClaudeWakeClaim(sessionId, { dir = defaultDir(), now = Date.now() } = {}) {
  const inbox = claudeForwardInboxDir(sessionId, dir);
  if (!inbox) return null;
  const path = join(inbox, 'waking');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(inbox, { recursive: true, mode: 0o700 });
      writeFileSync(path, `${process.pid}-${now}`, { mode: 0o600, flag: 'wx' });
      return () => rmSync(path, { force: true });
    } catch (error) {
      if (error.code !== 'EEXIST') return null;
      try {
        if (now - statSync(path).mtimeMs <= WAKE_CLAIM_TTL_MS) return null;
        rmSync(path, { force: true }); // 期限を過ぎた印
      } catch { /* 別の hook が消した */ }
    }
  }
  return null;
}

function pendingNames(inbox) {
  try { return readdirSync(inbox).filter(name => ITEM_NAME.test(name)).sort(); }
  catch { return []; }
}

/**
 * 待つ hook の名乗り。番の終わりのたびに新しい待つ hook が立つが、前の hook は Claude Code が止めない（会話が次の番へ
 * 進んでも残る）。新しい hook が自分の印を書き、前の hook は印が替わったのを見て退く。1つの会話で待つのは1つだけにする。
 */
export function registerClaudeForwardWaiter(sessionId, token, dir = defaultDir()) {
  const inbox = claudeForwardInboxDir(sessionId, dir);
  if (!inbox) return false;
  try {
    writeFileSync(join(inbox, 'waiter'), token, { mode: 0o600 });
    return true;
  } catch { return false; }
}

/** 今、その会話で待つ番の hook の印。読めなければ null。 */
export function currentClaudeForwardWaiter(sessionId, dir = defaultDir()) {
  const inbox = claudeForwardInboxDir(sessionId, dir);
  try { return inbox ? readFileSync(join(inbox, 'waiter'), 'utf8') : null; }
  catch { return null; }
}

/**
 * その会話で、待つ hook の process が生きているか。生きていれば、会話の process も生きている（待つ hook は、会話の
 * process が居なくなると退く）。生きていない時は、会話が止まっているか、待つ hook が登録される前に立った会話。
 */
export function claudeForwardWaiterAlive(sessionId, dir = defaultDir()) {
  const pid = Number(/^(\d+)-/.exec(currentClaudeForwardWaiter(sessionId, dir) ?? '')?.[1]);
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

/** 届けるのを待つ入力が在るか（フォルダを1回読むだけ）。 */
export function hasPendingClaudeForwards(sessionId, dir = defaultDir()) {
  const inbox = claudeForwardInboxDir(sessionId, dir);
  return Boolean(inbox) && pendingNames(inbox).length > 0;
}

function readItem(path) {
  try {
    const item = JSON.parse(readFileSync(path, 'utf8'));
    return item?.schema === 'throughline.claude-forward.v1' && typeof item.text === 'string' ? item : null;
  } catch { return null; }
}

const localStamp = at => {
  const d = new Date(at);
  const two = n => String(n).padStart(2, '0');
  return Number.isNaN(d.getTime()) ? '時刻不明'
    : `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
};

/** 後継へ渡す文。届いた順に、1つの文にまとめる。 */
export function formatClaudeForwards(items) {
  const humans = items.filter(item => item.kind === 'prompt').length;
  const peers = items.filter(item => item.kind === 'peer').length;
  const notes = items.length - humans - peers;
  const sources = [...new Set(items.map(item => String(item.source_session_id ?? '').slice(0, 8)).filter(Boolean))];
  const counts = [humans ? `利用者の入力 ${humans} 通` : null, peers ? `ほかの会話からの文 ${peers} 通` : null,
    notes ? `裏の作業の通知 ${notes} 通` : null].filter(Boolean).join('、');
  const handoffs = [...new Set(items.map(item => item.handoff_id).filter(id => typeof id === 'string' && id))];
  // 利用者の入力の見出しに「利用者がこの会話へ打った入力として扱ってください」と書く。出どころを述べるだけの形は、
  // 実機で、後継のモデルが従わない回が増えた（ADR 0063 の実測）。
  const lines = [`${CLAUDE_FORWARD_MARK}引き継ぎ前の会話${sources.length ? `（${sources.join('・')}）` : ''}へ届いた入力を、Throughlineがこの会話へ運びました（${counts}）。作業はこの会話が引き継いでいます。` +
    (handoffs.length ? `引き継ぎID: ${handoffs.join('、')}` : '')];
  for (const item of items) {
    lines.push(item.kind === 'task-notification'
      ? `${NOTIFICATION_SECTION}（${localStamp(item.at)} に届いた。引き継ぎ前の会話が裏で起こした作業の通知です。結果が要る時は、出力の file を読んで確かめてください）---`
      : item.kind === 'peer'
        ? `${PEER_SECTION}（${localStamp(item.at)} に届いた。ほかの Claude の会話が、引き継ぎ前の会話へ送った文です。利用者の入力ではありません）---`
        : `${HUMAN_SECTION}（${localStamp(item.at)} に届いた。利用者がこの会話へ打った入力として扱ってください）---`);
    lines.push(item.text);
  }
  return lines.join('\n');
}

/**
 * 置き場の入力を受け取る（`claimed` へ改名する）。受け取った分は、出力した後で `settleClaudeForwards` で消す。
 * maxChars を渡した時は、まとめた文がその字数に収まる分だけを、届いた順に受け取る。先頭の1通が収まらない時は
 * 何も受け取らない（Stop の道に残す）。maxChars が無い時（Stop の道）は全部を受け取り、長すぎる1通は頭と全文の
 * file の場所に替える。
 *
 * @returns {{text: string, count: number, humans: number, notifications: number, chars: number, paths: string[]}|null}
 */
export function claimClaudeForwards({ sessionId, dir = defaultDir(), maxChars = null }) {
  const inbox = claudeForwardInboxDir(sessionId, dir);
  if (!inbox) return null;
  const names = pendingNames(inbox);
  if (!names.length) return null;
  const claimedDir = join(inbox, 'claimed');
  const items = [];
  const paths = [];
  for (const name of names) {
    const item = readItem(join(inbox, name));
    if (!item) { rmSync(join(inbox, name), { force: true }); continue; } // 読めないファイルは運べない
    if (maxChars !== null && formatClaudeForwards([...items, item]).length > maxChars) break;
    const claimed = join(claimedDir, `${name}.${process.pid}`);
    try {
      mkdirSync(claimedDir, { recursive: true, mode: 0o700 });
      renameSync(join(inbox, name), claimed);
    } catch { continue; } // 別の hook が先に受け取った
    if (maxChars === null && item.text.length > STOP_ITEM_MAX_CHARS) {
      const full = join(inbox, 'full', `${name.slice(0, -'.json'.length)}.txt`);
      try {
        mkdirSync(join(inbox, 'full'), { recursive: true, mode: 0o700 });
        writeFileSync(full, item.text, { mode: 0o600 });
        item.text = `${item.text.slice(0, STOP_ITEM_HEAD_CHARS)}\n…（長いので頭だけを運びました。全 ${item.text.length} 字の全文: ${full}）`;
      } catch { item.text = `${item.text.slice(0, STOP_ITEM_MAX_CHARS)}\n…（長いので ${STOP_ITEM_MAX_CHARS} 字で切りました）`; }
    }
    items.push(item);
    paths.push(claimed);
  }
  if (!items.length) return null;
  const text = formatClaudeForwards(items);
  const notifications = items.filter(item => item.kind === 'task-notification').length;
  // humans は、利用者の入力と、ほかの会話からの文（どちらも届いた入力。記憶へ残す側）の数。
  return { text, count: items.length, humans: items.length - notifications, notifications, chars: text.length, paths };
}

/** 出力した入力を消す。 */
export function settleClaudeForwards(claim) {
  for (const path of claim?.paths ?? []) rmSync(path, { force: true });
}

/**
 * 文脈として足す道（UserPromptSubmit・PreToolUse）から呼ぶ。収まる分を受け取り、渡す文を返す。
 * 呼んだ側は、文を出力した後で `done()` を呼ぶ。
 *
 * @returns {{text: string, done: () => void}|null}
 */
export function takeClaudeForwardsAsContext({ sessionId, via, dir = defaultDir() }) {
  const claim = claimClaudeForwards({ sessionId, dir, maxChars: CLAUDE_FORWARD_CONTEXT_MAX_CHARS });
  if (!claim) return null;
  return { text: claim.text, done: () => {
    settleClaudeForwards(claim);
    logClaudeForward({ event: 'delivered', via, session_id: sessionId, count: claim.count, humans: claim.humans,
      notifications: claim.notifications, chars: claim.chars }, dir);
  } };
}

/** 置き場に残った入力を、別の会話（今の続きの会話）の置き場へ移す。移した数を返す。 */
export function moveClaudeForwards({ fromSessionId, toSessionId, dir = defaultDir() }) {
  const from = claudeForwardInboxDir(fromSessionId, dir);
  const to = claudeForwardInboxDir(toSessionId, dir);
  if (!from || !to || from === to) return 0;
  let moved = 0;
  for (const name of pendingNames(from)) {
    try {
      mkdirSync(to, { recursive: true, mode: 0o700 });
      renameSync(join(from, name), join(to, name));
      moved++;
    } catch { /* 別の hook が先に受け取った */ }
  }
  if (moved) logClaudeForward({ event: 'moved', session_id: fromSessionId, to_session_id: toSessionId, count: moved }, dir);
  return moved;
}

/** 置き場の数。pending は届けるのを待つ入力、unknown は受け取った後で届いたか分からなくなった入力（1分より前の物）。 */
export function readClaudeForwardStatus(sessionId, { dir = defaultDir(), now = Date.now() } = {}) {
  const inbox = claudeForwardInboxDir(sessionId, dir);
  if (!inbox || !existsSync(inbox)) return { pending: 0, unknown: 0 };
  let unknown = 0;
  try {
    for (const name of readdirSync(join(inbox, 'claimed'))) {
      try { if (now - statSync(join(inbox, 'claimed', name)).mtimeMs > 60_000) unknown++; } catch { /* 消えた */ }
    }
  } catch { /* claimed が無い */ }
  return { pending: pendingNames(inbox).length, unknown };
}

/**
 * 置き場の片付け。7日を過ぎた入力は届けずに消す。どの引き継ぎの記録からも後継として指されていない会話の置き場は、
 * 空で 24 時間動きが無ければ消す。
 * @param {Set<string>} keepSessionIds 後継として指されている会話の ID
 */
export function removeStaleClaudeForwards({ dir = defaultDir(), now = Date.now(), keepSessionIds = new Set() } = {}) {
  let sessions;
  try { sessions = readdirSync(join(dir, 'inbox')); }
  catch { return; }
  for (const sessionId of sessions) {
    const inbox = claudeForwardInboxDir(sessionId, dir);
    if (!inbox) continue;
    let dropped = 0;
    let left = 0;
    for (const sub of ['', 'claimed', 'full']) {
      let names;
      try { names = readdirSync(join(inbox, sub)); }
      catch { continue; }
      for (const name of names) {
        if (sub === '' && (name === 'claimed' || name === 'full' || name === 'waiter' || name === 'waking')) continue;
        const path = join(inbox, sub, name);
        try {
          if (now - statSync(path).mtimeMs > PENDING_TTL_MS) { rmSync(path, { force: true }); if (sub !== 'full') dropped++; }
          else left++;
        } catch { /* 別の hook が消した */ }
      }
    }
    if (dropped) logClaudeForward({ event: 'expired', session_id: sessionId, count: dropped }, dir);
    if (left || keepSessionIds.has(sessionId)) continue;
    try {
      if (now - statSync(inbox).mtimeMs > EMPTY_INBOX_TTL_MS) rmSync(inbox, { recursive: true, force: true });
    } catch { /* 消えた */ }
  }
}

/**
 * 記憶を読む側から呼ぶ。Stop の道で届いた行（Claude Code が通知の包みを付ける）から、運んだ文だけを取り出す。
 * 運んだ文でなければ null。
 */
export function unwrapClaudeForwardedDelivery(text) {
  if (typeof text !== 'string') return null;
  const start = text.indexOf(CLAUDE_FORWARD_MARK);
  if (start < 0 || !text.trimStart().startsWith('<task-notification>')) return null;
  const close = text.lastIndexOf('</system-reminder>');
  return (close > start ? text.slice(start, close) : text.slice(start)).trim();
}

/**
 * 運んだ文に、届いた入力（利用者の入力か、ほかの会話からの文）が入っているか。完了通知だけを運んだ文は、
 * 作業の途中の入力として記憶へ足さない（ADR 0060 と同じ分け方）。
 */
export function claudeForwardCarriesHumanInput(text) {
  return typeof text === 'string' && text.startsWith(CLAUDE_FORWARD_MARK) &&
    (text.includes(`\n${HUMAN_SECTION}`) || text.includes(`\n${PEER_SECTION}`));
}
