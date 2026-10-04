/**
 * transcript-reader.mjs
 * Claude Code のトランスクリプト JSONL を解析するモジュール。
 *
 * 実際のフォーマット（確認済み）:
 *   {type: "user",      message: {role: "user",      content: [{type:"text", text:"..."}]}, ...}
 *   {type: "assistant", message: {role: "assistant", content: [{type:"text", text:"..."}, {type:"thinking", ...}]}, ...}
 *   他に queue-operation, attachment, file-history-snapshot 等があるが無視する
 */

import { readFileSync, existsSync } from 'fs';
import { DETAIL_KIND } from './constants.mjs';
import { compactClaudePeerMessage, compactClaudeTaskNotification } from './hosts/claude.mjs';
import { classifyTurnStart } from './turn-start.mjs';

function entryKind(entry) {
  if (typeof entry?.type === 'string' && entry.type.length > 0) return entry.type;
  if (typeof entry?.role === 'string' && entry.role.length > 0) return entry.role;
  return undefined;
}

/**
 * content 配列からテキスト部分だけを結合する。
 * thinking ブロックは除外。
 * @param {unknown} content
 * @returns {string}
 */
/**
 * Claude Code が圧縮の直後に書く要約行か。type は user だが、人の発言ではない
 * （`isCompactSummary: true`。ADR 0032）。ターンの始まりにも本文にもしない。
 * @param {object} entry
 */
export function isCompactSummaryEntry(entry) {
  return entry?.isCompactSummary === true;
}

function extractText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('');
  }
  return String(content ?? '');
}

/**
 * トランスクリプト JSONL ファイルを読んで全ターンを返す。
 * @param {string} transcriptPath
 * @returns {Array<{role: string, content: string, turn_number: number, timestamp: number|null, start?: 'prompt'|'self'|'unknown'}>}
 */
export function readTranscript(transcriptPath) {
  if (!transcriptPath || !existsSync(transcriptPath)) return [];

  // existsSync で早期 return 済み。ここでの read 失敗は権限エラー等の本物の異常なので throw させる (§0 ルール)
  const raw = readFileSync(transcriptPath, 'utf8');

  const turns = [];
  // turn_number は transcript 内の本文行の通し番号。圧縮の要約行は返さないが番号は進める。
  // 番号を詰めると、要約行を数えていた頃に保存した bodies の turn_number と食い違う。
  let position = 0;
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }

    // user / assistant エントリのみ対象。Claude は type、Cursor jsonl は role。
    const kind = entryKind(entry);
    if (kind !== 'user' && kind !== 'assistant') continue;

    // subagent の sidechain エントリは主会話ではないので除外。現行 CC は主 transcript に
    // 書かない（400 transcript 実測ゼロ件）が、将来変更への安価な防御 (docs/12 B-1)
    if (entry.isSidechain === true) continue;

    const msg = entry.message;
    const grokContent = entry.content;
    const role = msg?.role ?? kind;
    const rawContent = msg?.content ?? grokContent;
    if (!role || rawContent == null) continue;

    const extracted = extractText(rawContent);
    // user 発言には端末の生出力 (貼り付け・Claude の task 通知) や、別の会話から届いた発言の
    // 定型の注意書きが入る。記憶には制御文字と定型文を落とした本文だけを残す。
    const text = role === 'user'
      ? normalizeTerminalText(compactClaudePeerMessage(compactClaudeTaskNotification(extracted)))
      : extracted;
    if (!text) continue;

    const turnNumber = position++;
    // 圧縮の要約は host が書いた行。ターンは圧縮をまたいで続くので、ここで区切らない。
    if (isCompactSummaryEntry(entry)) continue;

    const ts = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN;
    // grok chat_history.jsonl は Claude の message 包みを持たず type/content 直置き。
    turns.push({
      role,
      content: text,
      turn_number: turnNumber,
      timestamp: Number.isNaN(ts) ? null : ts,
      ...(role === 'user'
        ? {
            start: classifyTurnStart(entry, extracted),
            // Claude Code が user 行に付ける prompt の id。hook payload の prompt_id と同じ値。
            prompt_id: typeof entry.promptId === 'string' ? entry.promptId : null,
          }
        : {}),
    });
  }

  return turns;
}

/**
 * assistant テキスト断片が API 通知（junk）かを判定する。
 * junk が論理ターン群の最終断片になると、通知を本文として保存し実回答を捨てる
 * ことになるため、代表選択から除外する (docs/12 B-1 refuter 修正3)。
 * パターンは実測で bodies に混入した通知に限定し、prefix 固定で偽陽性を避ける。
 * @param {string} text
 */
export function isJunkAssistantText(text) {
  if (typeof text !== 'string') return false;
  return (
    text.startsWith("You've hit your session limit") ||
    text.startsWith("You've reached your") ||
    text.startsWith('API Error')
  );
}

/**
 * transcript を論理ターン群に分解する。
 *
 * 論理ターン群 = user テキストエントリ 1 件 + それに続く assistant テキスト断片群。
 * 途中割り込み（plan 拒否・AskUserQuestion 応答等）は tool_result 内に埋まり
 * readTranscript には不可視のため、1 群が複数 Stop・複数断片を含むのは日常パターン。
 *
 * representative = 群内最後の非 junk 断片。この index が bodies の turn_number になる
 * （user 行・assistant 行とも同じ turn_number で保存する現行規約と同じ）。
 * 全断片が junk の群、断片ゼロの群（assistant 本文が transcript に無い B-2 ケース）は
 * 返さない。
 *
 * @param {string} transcriptPath
 * @returns {Array<{
 *   user: {content: string, timestamp: number|null, turn_number: number, start: 'prompt'|'self'|'unknown'},
 *   fragments: Array<{index: number, content: string, timestamp: number|null}>,
 *   representative: {index: number, content: string, timestamp: number|null},
 * }>}
 */
export function getLogicalTurnGroups(transcriptPath) {
  const turns = readTranscript(transcriptPath);
  const raw = [];
  let current = null;
  for (const t of turns) {
    if (t.role === 'user') {
      if (current) raw.push(current);
      current = { user: t, fragments: [] };
    } else if (t.role === 'assistant' && current) {
      current.fragments.push({ index: t.turn_number, content: t.content, timestamp: t.timestamp });
    }
  }
  if (current) raw.push(current);

  const groups = [];
  for (const g of raw) {
    if (g.fragments.length === 0) continue;
    let representative = null;
    for (let i = g.fragments.length - 1; i >= 0; i--) {
      if (!isJunkAssistantText(g.fragments[i].content)) {
        representative = g.fragments[i];
        break;
      }
    }
    if (!representative) continue; // 全断片 junk
    groups.push({ user: g.user, fragments: g.fragments, representative });
  }
  return groups;
}

/**
 * 最後の user 発言と、それに続く assistant 本文の断片を返す。
 *
 * getLogicalTurnGroups は完了したターンの回収用で、本文の断片が無い群を返さない。
 * こちらは作業途中のターン（Stop 前。本文がまだ無いこともある）を読むために使う。
 *
 * @param {string} transcriptPath
 * @returns {{
 *   user: {content: string, timestamp: number|null, turn_number: number, start: 'prompt'|'self'|'unknown', prompt_id: string|null},
 *   fragments: Array<{index: number, content: string, timestamp: number|null}>,
 * }|null}
 */
export function readLatestUserGroup(transcriptPath) {
  const turns = readTranscript(transcriptPath);
  let userIndex = -1;
  for (let index = turns.length - 1; index >= 0; index--) {
    if (turns[index].role === 'user') {
      userIndex = index;
      break;
    }
  }
  if (userIndex < 0) return null;
  const { content, timestamp, turn_number, start, prompt_id } = turns[userIndex];
  return {
    user: { content, timestamp, turn_number, start, prompt_id },
    fragments: turns
      .slice(userIndex + 1)
      .filter((turn) => turn.role === 'assistant')
      .map((turn) => ({ index: turn.turn_number, content: turn.content, timestamp: turn.timestamp })),
  };
}

/**
 * latest user group と、その1つ前のgroupが、どのassistant本文まで永続化されたかを返す。
 *
 * transcriptは追記だけなので、後ろにuser行が見えているgroupは行が出そろっている。
 * Stopの直後に次のuser行（queueから届いた入力）が書かれた時、完了したturnは
 * latestではなく1つ前のgroupになる。fragmentTurnNumbers はgroup内の全assistant断片のindex。
 *
 * @param {string} transcriptPath
 * @returns {{
 *   latest: {userTurnNumber: number, assistantTurnNumber: number|null, assistantContent: string|null, fragmentTurnNumbers: number[]},
 *   previous: {userTurnNumber: number, assistantTurnNumber: number|null, assistantContent: string|null, fragmentTurnNumbers: number[]}|null,
 * }|null}
 */
export function readLatestLogicalTurnCompletions(transcriptPath) {
  const turns = readTranscript(transcriptPath);
  const userIndexes = [];
  for (let index = turns.length - 1; index >= 0 && userIndexes.length < 2; index--) {
    if (turns[index].role === 'user') userIndexes.push(index);
  }
  if (userIndexes.length === 0) return null;

  const describe = (start, end) => {
    let representative = null;
    const fragmentTurnNumbers = [];
    for (let index = start + 1; index < end; index++) {
      const turn = turns[index];
      if (turn.role !== 'assistant') continue;
      fragmentTurnNumbers.push(turn.turn_number);
      if (!isJunkAssistantText(turn.content)) representative = turn;
    }
    return {
      userTurnNumber: turns[start].turn_number,
      assistantTurnNumber: representative?.turn_number ?? null,
      assistantContent: representative?.content ?? null,
      fragmentTurnNumbers,
    };
  };
  return {
    latest: describe(userIndexes[0], turns.length),
    previous: userIndexes.length === 2 ? describe(userIndexes[1], userIndexes[0]) : null,
  };
}

/**
 * 端末出力の制御を除いて、画面に残る文字列にする。
 * - ESC 系列: OSC (window title 等。Windows ConPTY が出す)、DCS/SOS/PM/APC、
 *   CSI (色・cursor 移動・private mode)、その他の 2 byte 以上の ESC 系列。
 * - 改行: CRLF は LF にし、行内の CR は上書き表示として最後の区間だけを残す。
 * @param {string} s
 */
export function normalizeTerminalText(s) {
  if (typeof s !== 'string') return s;
  /* eslint-disable no-control-regex */
  const stripped = s
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b[PX^_][^\x1b]*\x1b\\/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[ -/]*[0-~]/g, '');
  /* eslint-enable no-control-regex */
  return stripped
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => {
      if (!line.includes('\r')) return line;
      const segments = line.split('\r').filter((segment) => segment.length > 0);
      return segments.length ? segments[segments.length - 1] : '';
    })
    .join('\n');
}

/**
 * tool_result の content フィールドを単一テキストに正規化する。
 * 実際のフォーマット:
 *   - string: そのまま
 *   - Array<{type:"text", text:string} | {type:"image", ...}>: text を結合、
 *     image は `[image]` プレースホルダ
 * @param {unknown} content
 * @returns {string}
 */
export function normalizeToolResultContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (b && b.type === 'text' && typeof b.text === 'string') return b.text;
        if (b && b.type === 'image') return '[image]';
        return '';
      })
      .join('');
  }
  return '';
}

/**
 * transcript JSONL を 1 行ずつ解析して、生エントリ配列を返す。
 * 未知 type や parse 失敗は skip（§0 ルール: 上位で扱う）。
 *
 * @param {string} transcriptPath
 * @returns {Array<object>}
 */
export function readRawEntries(transcriptPath) {
  if (!transcriptPath || !existsSync(transcriptPath)) return [];
  const raw = readFileSync(transcriptPath, 'utf8');
  const entries = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed));
    } catch {
      // 末尾 partial-write は JSONL 仕様上の許容
      continue;
    }
  }
  return entries;
}

/**
 * 現在の「論理ターン」を構成するエントリ範囲を切り出す。
 * 定義: 最後の assistant text ブロック (= Stop 時点の Claude 最終応答) を含むターン
 *       = 1 つ前の user text エントリの次から、最後の assistant エントリまで。
 *
 * 論理ターンの構造:
 *   user(text)                 ← このターンの開始
 *   assistant(thinking + tool_use)
 *   user(tool_result)
 *   assistant(text)            ← このターンの終わり
 *
 * 間にある attachment / system エントリも同範囲に含める。
 *
 * @param {Array<object>} entries readRawEntries の結果
 * @returns {Array<object>} 論理ターンに属するエントリのスライス
 */
export function sliceCurrentTurnEntries(entries) {
  if (!entries.length) return [];

  // 最後の assistant text ブロックを含むエントリを探す
  let lastAssistantTextIdx = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (entryKind(e) !== 'assistant') continue;
    const blocks = e.message?.content;
    if (!Array.isArray(blocks)) continue;
    if (blocks.some((b) => b && b.type === 'text' && typeof b.text === 'string' && b.text.length > 0)) {
      lastAssistantTextIdx = i;
      break;
    }
  }
  if (lastAssistantTextIdx < 0) return [];

  // そこから遡って、最後の user text ブロックを含むエントリを探す
  let userTextIdx = -1;
  for (let i = lastAssistantTextIdx - 1; i >= 0; i--) {
    const e = entries[i];
    if (entryKind(e) !== 'user') continue;
    // 圧縮の要約行はターンの始まりではない。圧縮より前の tool 入出力も同じターンに含める。
    if (isCompactSummaryEntry(e)) continue;
    const blocks = e.message?.content;
    if (Array.isArray(blocks)) {
      if (blocks.some((b) => b && b.type === 'text' && typeof b.text === 'string' && b.text.length > 0)) {
        userTextIdx = i;
        break;
      }
    } else if (typeof blocks === 'string' && blocks.length > 0) {
      userTextIdx = i;
      break;
    }
  }
  if (userTextIdx < 0) return [];

  return entries.slice(userTextIdx, lastAssistantTextIdx + 1);
}

/**
 * 作業途中で止めたターンのエントリ範囲 (ADR 0033)。最後の user 本文の行から、transcript の末尾まで。
 *
 * sliceCurrentTurnEntries は最後の assistant 本文で切るので、その後に呼んだ道具が入らない。
 * hook で止めたターンは、止めた道具の呼び出しと結果が末尾に並ぶ。それも同じターンとして返す。
 *
 * @param {Array<object>} entries readRawEntries の結果
 * @returns {Array<object>}
 */
export function sliceInFlightTurnEntries(entries) {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (entryKind(e) !== 'user' || isCompactSummaryEntry(e)) continue;
    const blocks = e.message?.content;
    const hasText = Array.isArray(blocks)
      ? blocks.some((b) => b && b.type === 'text' && typeof b.text === 'string' && b.text.length > 0)
      : typeof blocks === 'string' && blocks.length > 0;
    if (hasText) return entries.slice(i);
  }
  return [];
}

/**
 * 論理ターン内の全エントリから L3 (details) 用の生レコードを抽出する。
 *
 * 返す各レコード:
 *   {
 *     kind: 'tool_input' | 'tool_output' | 'system',
 *     tool_name: string,       // 表示用。system は 'SystemReminder' 等
 *     source_id: string,       // 冪等再処理キー (tool_use.id / tool_use_id / uuid)
 *     input_text: string | null,
 *     output_text: string | null,
 *   }
 *
 * 分類ルール:
 *   - assistant の tool_use ブロック → tool_input (name, input を JSON 化して input_text に)
 *   - user の tool_result ブロック → tool_output (content を output_text に、ANSI 剥離)
 *   - assistant の thinking ブロック → thinking (b.thinking を output_text に)
 *   - assistant/user の text ブロック → 扱わない（L2 bodies 側の責務）
 *   - attachment entry (hook_success) → system (hookName + content を出力に)
 *   - system entry (stop_hook_summary) → skip（hook タイミング情報で意味なし）
 *   - image ブロック → placeholder で kind='image'
 *
 * @param {Array<object>} turnEntries sliceCurrentTurnEntries の結果
 * @returns {Array<{kind: string, tool_name: string, source_id: string, input_text: string|null, output_text: string|null}>}
 */
export function extractDetailBlocks(turnEntries) {
  const out = [];
  // tool_use の name を後で tool_result にも添付するためのマップ
  const toolNameById = new Map();

  for (const e of turnEntries) {
    if (entryKind(e) === 'assistant') {
      const blocks = e.message?.content;
      if (!Array.isArray(blocks)) continue;
      for (let i = 0; i < blocks.length; i++) {
        const b = blocks[i];
        if (!b || !b.type) continue;
        if (b.type === 'tool_use' && typeof b.id === 'string') {
          toolNameById.set(b.id, b.name ?? 'unknown');
          out.push({
            kind: DETAIL_KIND.TOOL_INPUT,
            tool_name: b.name ?? 'unknown',
            source_id: b.id,
            input_text: JSON.stringify(b.input ?? null),
            output_text: null,
          });
        } else if (b.type === 'thinking' && typeof b.thinking === 'string') {
          // 固有 id が無いため entry uuid + block index で冪等キーを合成
          const sourceId = e.uuid ? `${e.uuid}:thinking:${i}` : null;
          out.push({
            kind: DETAIL_KIND.THINKING,
            tool_name: 'thinking',
            source_id: sourceId,
            input_text: null,
            output_text: b.thinking,
          });
        } else if (b.type === 'image') {
          out.push({
            kind: DETAIL_KIND.IMAGE,
            tool_name: 'image',
            source_id: null,
            input_text: null,
            output_text: '[image]',
          });
        }
        // text は扱わない
      }
    } else if (entryKind(e) === 'user') {
      const blocks = e.message?.content;
      if (!Array.isArray(blocks)) continue;
      for (const b of blocks) {
        if (!b || !b.type) continue;
        if (b.type === 'tool_result') {
          const toolUseId = b.tool_use_id ?? null;
          const toolName = toolUseId && toolNameById.has(toolUseId)
            ? toolNameById.get(toolUseId)
            : 'unknown';
          const rawOutput = normalizeToolResultContent(b.content);
          out.push({
            kind: DETAIL_KIND.TOOL_OUTPUT,
            tool_name: toolName,
            source_id: toolUseId ? `${toolUseId}:result` : null,
            input_text: null,
            output_text: normalizeTerminalText(rawOutput),
          });
        } else if (b.type === 'image') {
          out.push({
            kind: DETAIL_KIND.IMAGE,
            tool_name: 'image',
            source_id: null,
            input_text: null,
            output_text: '[image]',
          });
        }
        // text は扱わない
      }
    } else if (e.type === 'attachment') {
      // attachment は Claude Code が会話に差し込むコンテキスト全般を表す汎用エンベロープ。
      // 既知の種別（実機観測）:
      //   hook_success, async_hook_response, hook_additional_context,
      //   deferred_tools_delta, mcp_instructions_delta, skill_listing,
      //   nested_memory, todo_reminder, command_permissions
      // すべて L3 kind=system として捕捉する。ペイロードのフィールド名は種別ごとに
      // 異なるため、共通のテキストフィールドを優先度順に試す。
      const a = e.attachment;
      if (!a || !a.type) continue;

      const output =
        (typeof a.content === 'string' && a.content) ||
        (Array.isArray(a.content) && a.content.join('\n')) ||
        (typeof a.stdout === 'string' && a.stdout) ||
        (Array.isArray(a.addedBlocks) && a.addedBlocks.join('\n')) ||
        (Array.isArray(a.addedLines) && a.addedLines.join('\n')) ||
        // 既知フィールドがすべて空ならメタ情報を JSON で残す（情報ロスを避ける §0）
        JSON.stringify(a);

      // 種別名 + hook イベント名で tool_name を一意化
      const toolName = a.hookEvent ? `${a.type}:${a.hookEvent}` : a.type;

      out.push({
        kind: DETAIL_KIND.SYSTEM,
        tool_name: toolName,
        source_id: e.uuid ?? null,
        input_text: a.command ?? a.path ?? null,
        output_text: normalizeTerminalText(String(output)),
      });
    }
    // type === 'system' (stop_hook_summary) や queue-operation / file-history-snapshot は skip
  }

  return out;
}

/**
 * 最後のターン（最後の user または assistant メッセージ）を返す。
 * @param {string} transcriptPath
 * @returns {{role: string, content: string, turn_number: number} | null}
 */
export function getLastTurn(transcriptPath) {
  const turns = readTranscript(transcriptPath);
  return turns.length > 0 ? turns[turns.length - 1] : null;
}

/**
 * 最後の assistant ターンだけを返す。
 * @param {string} transcriptPath
 * @returns {{role: string, content: string, turn_number: number} | null}
 */
export function getLastAssistantTurn(transcriptPath) {
  const turns = readTranscript(transcriptPath);
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].role === 'assistant') return turns[i];
  }
  return null;
}

/**
 * 最後の assistant ターンと、それに対応する直前の user ターンをペアで返す。
 * Stop フックで L2 (bodies) に 1 往復分を保存するために使う。
 *
 * user メッセージには tool_result のような合成メッセージも混じるが、
 * readTranscript() は text ブロックだけを抽出しているので、text が
 * 空の user メッセージは自動的に除外されている（= tool_result のみの行は弾かれる）。
 *
 * @param {string} transcriptPath
 * @returns {{
 *   user: {role: string, content: string, turn_number: number} | null,
 *   assistant: {role: string, content: string, turn_number: number} | null
 * }}
 */
export function getLastTurnPair(transcriptPath) {
  const turns = readTranscript(transcriptPath);
  let assistantIdx = -1;
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].role === 'assistant') {
      assistantIdx = i;
      break;
    }
  }
  if (assistantIdx < 0) return { user: null, assistant: null };

  // assistant の直前の user ターンを探す
  let userTurn = null;
  for (let i = assistantIdx - 1; i >= 0; i--) {
    if (turns[i].role === 'user') {
      userTurn = turns[i];
      break;
    }
  }

  return { user: userTurn, assistant: turns[assistantIdx] };
}
