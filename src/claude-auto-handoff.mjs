/**
 * claude-auto-handoff.mjs — Claude Code の自動継続 (ADR 0032)
 *
 * Codex の自動継続は、自動圧縮の前に旧タスクを止めて新しいタスクへ記憶を渡す。Claude Code は
 * hook から作業を止められず、新しい会話へ指示を送る公開 API も無い。自動圧縮の後は host が
 * 同じ会話で作業を続け、SessionStart(source=compact) の hook 出力を圧縮後の文脈へ足す。
 * そこで Claude では、会話を切り替えずに次の 2 段で記憶を渡す。
 *
 *   1. PreCompact      : trigger=auto の時だけ、その会話に「自動圧縮が始まった」印を残す。
 *                        圧縮は止めない（止めると文脈上限の error になる）。
 *   2. SessionStart    : source=compact で印があれば、完了済みのターンを回収し、
 *      (source=compact)  作業途中のターンと直近の会話の原文を stdout へ書く。
 *
 * 手動の /compact は対象にしない（Codex と同じ）。印は PreCompact の payload だけから作り、
 * SessionStart の時点の transcript から trigger を推測しない（圧縮境界の行は hook より後に書かれる）。
 */

import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readClaudeAutoHandoffConfig, claudeAutoHandoffEnabledFor } from './claude-auto-handoff-config.mjs';
import { CLAUDE_HOST, hostOfSessionId } from './hosts/identity.mjs';
import { claudeHostAdapter } from './hosts/claude.mjs';
import { readLatestUserGroup } from './transcript-reader.mjs';
import { backfillBodies, logBackfill } from './turn-backfill.mjs';
import { resolveMergeTarget } from './session-merger.mjs';
import { buildCompactContinuationContext } from './resume-context.mjs';

export const CLAUDE_COMPACT_REQUEST_SCHEMA = 'throughline.claude-auto-handoff.request.v1';
// 印は圧縮の完了で消える。圧縮が失敗して残った印は、次の PreCompact の時にこの期限で掃除する。
const STALE_REQUEST_MS = 24 * 60 * 60 * 1000;
// session id を印のファイル名に使う。Claude の id は UUID で、path の区切りを含む値は受け付けない。
const CLAUDE_SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export const claudeCompactRequestDir = () => join(homedir(), '.throughline', 'claude-auto-handoff');

function requestPath(sessionId, dir) {
  if (hostOfSessionId(sessionId) !== CLAUDE_HOST || !CLAUDE_SESSION_ID_PATTERN.test(sessionId)) {
    throw new Error('auto_handoff_session_id_invalid');
  }
  return join(dir, `${sessionId}.json`);
}

function removeStaleRequests(dir, now) {
  let names;
  try { names = readdirSync(dir); }
  catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const path = join(dir, name);
    let modifiedAt;
    try { modifiedAt = statSync(path).mtimeMs; }
    catch (error) {
      if (error.code === 'ENOENT') continue; // 別の hook が同時に消した
      throw error;
    }
    if (now - modifiedAt > STALE_REQUEST_MS) rmSync(path, { force: true });
  }
}

/**
 * PreCompact hook の本体。自動圧縮で、その project が有効な時だけ印を残す。
 * 手動と無効の時は、同じ会話の古い印を消して何もしない。subagent の中の圧縮は、
 * 親の会話の印に触らない（payload の session_id は親の会話を指す）。
 *
 * @param {{
 *   payload: {session_id?: string, trigger?: string, cwd?: string, transcript_path?: string},
 *   env?: NodeJS.ProcessEnv,
 *   config?: {enabled: boolean, projects: string[]},
 *   now?: number,
 *   dir?: string,
 * }} params
 * @returns {{status: 'requested'|'skipped', reason?: string, sessionId: string, projectPath?: string}}
 */
export function recordClaudeCompactRequest({
  payload,
  env = process.env,
  config = readClaudeAutoHandoffConfig(),
  now = Date.now(),
  dir = claudeCompactRequestDir(),
}) {
  const sessionId = payload?.session_id;
  if (typeof sessionId !== 'string' || !sessionId) throw new Error('Missing session_id in PreCompact payload');
  if (payload.agent_id) return { status: 'skipped', reason: 'subagent_compact', sessionId };
  const path = requestPath(sessionId, dir);
  // 有効判定は会話を起動した project で行う。hook の cwd は Bash の cd に追従する。
  const projectPath = claudeHostAdapter.completionProjectPath({ cwd: payload.cwd ?? process.cwd(), env });

  const reason = payload.trigger !== 'auto'
    ? 'manual_compact'
    : claudeAutoHandoffEnabledFor(config, projectPath) ? null : 'auto_handoff_disabled';
  if (reason) {
    rmSync(path, { force: true });
    return { status: 'skipped', reason, sessionId, projectPath };
  }

  mkdirSync(dir, { recursive: true, mode: 0o700 });
  removeStaleRequests(dir, now);
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({
    schema: CLAUDE_COMPACT_REQUEST_SCHEMA,
    session_id: sessionId,
    trigger: 'auto',
    project_path: projectPath,
    transcript_path: payload.transcript_path ?? null,
    requested_at: now,
  })}\n`, { mode: 0o600, flag: 'wx' });
  renameSync(temporary, path);
  return { status: 'requested', sessionId, projectPath };
}

/**
 * SessionStart(source=compact) から呼ぶ。その会話の印を取り出して消す。無ければ null。
 * @returns {{session_id: string, trigger: 'auto', project_path: string, transcript_path: string|null, requested_at: number}|null}
 */
export function consumeClaudeCompactRequest({ sessionId, dir = claudeCompactRequestDir() }) {
  if (hostOfSessionId(sessionId) !== CLAUDE_HOST || !CLAUDE_SESSION_ID_PATTERN.test(sessionId)) return null;
  const path = requestPath(sessionId, dir);
  let text;
  try { text = readFileSync(path, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  rmSync(path, { force: true });
  const request = JSON.parse(text);
  if (request.schema !== CLAUDE_COMPACT_REQUEST_SCHEMA || request.session_id !== sessionId ||
      request.trigger !== 'auto') throw new Error('auto_handoff_request_invalid');
  return request;
}

export function listClaudeCompactRequests({ dir = claudeCompactRequestDir() } = {}) {
  let names;
  try { names = readdirSync(dir); }
  catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  return names.filter(name => name.endsWith('.json')).map(name => {
    const { session_id, project_path, requested_at } = JSON.parse(readFileSync(join(dir, name), 'utf8'));
    return { session_id, project_path, requested_at };
  }).sort((a, b) => a.requested_at - b.requested_at);
}

/**
 * 自動圧縮の直後に注入するテキストを作る。
 *
 * 作業途中のターン（最後の user 発言の群）は Stop の前なので、回収の対象から外して transcript から読む。
 * それより前の完了済みターンは、Stop が空振りした分もここで bodies へ回収してから並べる。
 *
 * transcript は hook より遅れて書かれることがある。hook payload の `prompt_id` と、最後の user 行の
 * `promptId` が両方あって食い違う時は、今の依頼がまだ書かれていない。その時は最後の群を
 * 作業途中として見せず、回収もしない（どちらのターンか確定できない群を、完了として保存しない）。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ sessionId: string, transcriptPath: string|null|undefined, promptId?: string|null, now?: number }} params
 * @returns {{
 *   text: string,
 *   stats: {total_chars: number, injected_l2_turns: number, remaining_l2_turns: number, older_turns: number,
 *     in_flight_user: boolean, in_flight_unreadable: boolean, in_flight_fragments: number, backfilled_turns: number},
 * } | null}
 */
export function buildClaudeCompactContinuation(db, { sessionId, transcriptPath, promptId = null, now = Date.now() }) {
  const { target, origin } = resolveMergeTarget(db, sessionId);
  const latest = readLatestUserGroup(transcriptPath);
  const inFlightUnreadable = Boolean(promptId && latest?.user.prompt_id && latest.user.prompt_id !== promptId);
  const inFlight = inFlightUnreadable ? null : latest;

  const backfill = backfillBodies(db, {
    targetSessionId: target,
    originSessionId: origin,
    transcriptPath,
    now,
    beforeUserTurnNumber: latest ? latest.user.turn_number : null,
  });
  logBackfill({
    ts: new Date(now).toISOString(),
    hook: 'session-start-compact',
    session_id: sessionId,
    target,
    origin,
    transcript_path: transcriptPath ?? null,
    groups: backfill.groups,
    inserted_turns: backfill.insertedTurns,
    skipped_existing: backfill.skippedExisting,
  });

  const context = buildCompactContinuationContext(db, { sessionId: target, inFlight, inFlightUnreadable });
  if (!context) return null;
  return {
    text: context.text,
    stats: {
      total_chars: context.totalChars,
      injected_l2_turns: context.injectedL2Turns,
      remaining_l2_turns: context.remainingL2Turns,
      older_turns: context.olderTurns,
      in_flight_user: Boolean(inFlight),
      in_flight_unreadable: inFlightUnreadable,
      in_flight_fragments: inFlight?.fragments.length ?? 0,
      backfilled_turns: backfill.insertedTurns,
    },
  };
}
