/**
 * claude-auto-handoff.mjs — Claude Code の自動継続 (ADR 0033)
 *
 * 自動圧縮を置き換える。圧縮が走る前に旧い会話を止め、記憶を持った新しい会話で作業を続ける。
 * Codex の自動継続 (codex-auto-handoff.mjs) と同じ並びで、Claude Code の入口に合わせている。
 *
 *   1. PreCompact (trigger=auto) : 圧縮を止め（exit code 2）、/tl と同じ印（baton）と引き継ぎの記録を残す。
 *   2. PreToolUse                : 記録がある会話の次の道具を、実行させずに止める（deny + continue:false）。
 *                                  止めた時点の依頼・設定を記録へ写し、後継を立てる worker を起動する。
 *   3. worker                    : 止めたターンを DB へ取り込み（発言の全部と道具の入出力）、ここまでにしたことを
 *                                  記録へ写す。`claude --bg` を、継続の指示を最初の指示として付けて、同じ project に立てる。
 *   4. 後継の UserPromptSubmit   : その指示が baton を消費し、記憶を注入して、受領を残す。worker は受領を待つ。
 *                                  外から後継へ文を送らない。権限のバイパス中の会話は、外から届いた文を
 *                                  利用者の承認まで止めるため（0.15.3）。
 *
 * 旧い会話は止めるだけで、空にしない。手動の /compact と subagent の中の圧縮は対象にしない。
 * 状態は ~/.throughline/claude-auto-handoff/ のファイルに持つ（schema は変えない）。
 */

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, posix, resolve, win32 } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { readClaudeAutoHandoffConfig, claudeAutoHandoffEnabledFor } from './claude-auto-handoff-config.mjs';
import { CLAUDE_HOST, hostOfSessionId } from './hosts/identity.mjs';
import { claudeHostAdapter, readClaudeRelocatedCwd } from './hosts/claude.mjs';
import {
  isJunkAssistantText,
  normalizeTerminalText,
  readLatestUserGroup,
  readRawEntries,
  sliceInFlightTurnEntries,
} from './transcript-reader.mjs';
import { captureInFlightTurn } from './turn-backfill.mjs';
import { resolveMergeTarget } from './session-merger.mjs';
import { writeBaton } from './baton.mjs';
import { sameProjectPath } from './project-path.mjs';
import { spawnPortable, spawnPortableSync } from './os/portable-spawn-sync.mjs';

export const CLAUDE_AUTO_HANDOFF_SCHEMA = 'throughline.claude-auto-handoff.v2';
const CLI_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../bin/throughline.mjs');
// 終わった引き継ぎの記録と、取り残された受け口の控えを掃除する期限。
const STALE_RECORD_MS = 24 * 60 * 60 * 1000;
// session id を記録のファイル名に使う。Claude の id は UUID で、path の区切りを含む値は受け付けない。
const CLAUDE_SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
// `claude --bg` の出力（例: "backgrounded · a41a97ae · name"。指示なしで立てた時は "(idle — send a prompt to start)" が続く）。
// 後継の中から起動した時は ID に色の制御文字が付くので、外してから読む。
const BACKGROUNDED_PATTERN = /backgrounded\s+\S+\s+([0-9a-f]{8})\b/;
// 後継へ渡さない、会話ごとの環境変数。後継は自分の値を持つ。
const PER_SESSION_ENV = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_SSE_PORT', 'CLAUDE_PROJECT_DIR', 'CLAUDE_ENV_FILE'];

// requested と failed は、次の道具の hook が後継の立ち上げを始められる。
const RETRYABLE_STATES = new Set(['requested', 'failed']);
// 後継の最初の指示は、worker が後継の ID を記録へ写す前に届くことがある（launching）。
const ACCEPTABLE_STATES = new Set(['launching', 'launched', 'sent', 'unknown']);

export const claudeAutoHandoffDir = () => join(homedir(), '.throughline', 'claude-auto-handoff');
// 0.15.2 までが受け口の控えを置いた場所。期限の掃除だけを続ける。
const targetsDir = (dir) => join(dir, 'targets');
// 後継の最初の指示が残す受領。記録（worker が書き換える）とは別のファイルにして、書き込みが重ならないようにする。
const acceptancePath = (sessionId, dir) => join(dir, `${sessionId}.accepted`);

class ClaudeHandoffError extends Error {
  constructor(code) { super(code); this.code = code; }
}

function validSessionId(sessionId) {
  return typeof sessionId === 'string' && hostOfSessionId(sessionId) === CLAUDE_HOST &&
    CLAUDE_SESSION_ID_PATTERN.test(sessionId);
}

function recordPath(sessionId, dir) {
  if (!validSessionId(sessionId)) throw new ClaudeHandoffError('auto_handoff_session_id_invalid');
  return join(dir, `${sessionId}.json`);
}

function writeJsonPrivate(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: 'wx' });
  renameSync(temporary, path);
}

function readJson(path) {
  let text;
  try { text = readFileSync(path, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  return JSON.parse(text);
}

/** 旧い会話の session id から、引き継ぎの記録を読む。無ければ null。 */
export function readClaudeAutoHandoff(sessionId, dir = claudeAutoHandoffDir()) {
  const record = readJson(recordPath(sessionId, dir));
  if (record === null) return null;
  if (record.schema !== CLAUDE_AUTO_HANDOFF_SCHEMA || record.source_session_id !== sessionId) {
    throw new ClaudeHandoffError('auto_handoff_record_invalid');
  }
  return record;
}

function updateRecord(sessionId, fields, { dir, now = Date.now() }) {
  const record = readClaudeAutoHandoff(sessionId, dir);
  if (!record) throw new ClaudeHandoffError('handoff_not_found');
  const next = { ...record, ...fields, updated_at: now };
  writeJsonPrivate(recordPath(sessionId, dir), next);
  return next;
}

export function listClaudeAutoHandoffs({ dir = claudeAutoHandoffDir() } = {}) {
  let names;
  try { names = readdirSync(dir); }
  catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  return names.filter(name => name.endsWith('.json'))
    .map(name => readJson(join(dir, name)))
    .filter(record => record?.schema === CLAUDE_AUTO_HANDOFF_SCHEMA)
    .sort((a, b) => a.requested_at - b.requested_at);
}

/** 外へ見せる項目だけ。依頼の本文・発言・道具の対象と、受け口は含めない。 */
export function publicClaudeAutoHandoff(record) {
  const { handoff_id, source_session_id, project_path, state, error_code, requested_at, updated_at, successor } = record;
  return { handoff_id, source_session_id, project_path, state, error_code: error_code ?? null,
    successor_session_id: successor?.session_id ?? null, successor_short_id: successor?.short_id ?? null,
    // 止めたターンを DB へ取り込めたか。false の時、後継は `throughline detail` でそのターンの入出力を取れない。
    in_flight_captured: Boolean(record.in_flight?.turn),
    requested_at, updated_at };
}

function removeStale(dir, now) {
  for (const folder of [dir, targetsDir(dir)]) {
    let names;
    try { names = readdirSync(folder); }
    catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    for (const name of names) {
      if (!/\.(json|claim|log|accepted)$/.test(name)) continue;
      const path = join(folder, name);
      let modifiedAt;
      try { modifiedAt = statSync(path).mtimeMs; }
      catch (error) {
        if (error.code === 'ENOENT') continue; // 別の hook が同時に消した
        throw error;
      }
      if (now - modifiedAt > STALE_RECORD_MS) rmSync(path, { force: true });
    }
  }
}

/** script から起動した Claude（`claude -p`、Agent SDK）は、呼び出し元がその process の結果を待っている。止めない。 */
function unsupportedEntrypoint(env) {
  return typeof env.CLAUDE_CODE_ENTRYPOINT === 'string' && env.CLAUDE_CODE_ENTRYPOINT.startsWith('sdk-');
}

/**
 * 会話を起動した project の場所を、その OS の書き方にそろえる。
 *
 * Windows の Claude Code は hook を Git Bash で走らせ、CLAUDE_PROJECT_DIR を `C:/Users/…` の形で渡す。
 * hook の payload の cwd は `C:\Users\…` で、後継の最初の指示はこちらで印（baton）を探す。
 * 書き方が違うと、後継が印を見つけられず、記憶が入らない。
 */
function nativeProjectPath(projectPath, platform) {
  return (platform === 'win32' ? win32 : posix).resolve(projectPath);
}

/**
 * PreCompact hook の本体。自動圧縮で、その project が有効な時だけ、印と記録を残して圧縮を止める。
 *
 * @param {{
 *   payload: {session_id?: string, trigger?: string, cwd?: string, transcript_path?: string, agent_id?: string},
 *   openDb: () => import('node:sqlite').DatabaseSync,  印を書く時だけ開く
 *   env?: NodeJS.ProcessEnv, config?: {enabled: boolean, projects: string[]}, now?: number, dir?: string,
 * }} params
 * @returns {{status: 'requested'|'already_requested'|'skipped', block: boolean, reason?: string,
 *   sessionId: string, projectPath?: string, handoffId?: string}}
 */
export function requestClaudeAutoHandoff({
  payload,
  openDb,
  env = process.env,
  config = readClaudeAutoHandoffConfig(),
  now = Date.now(),
  dir = claudeAutoHandoffDir(),
  platform = process.platform,
}) {
  const sessionId = payload?.session_id;
  if (typeof sessionId !== 'string' || !sessionId) throw new Error('Missing session_id in PreCompact payload');
  // subagent の中の圧縮。payload の session_id は親の会話を指すので、親の記録には触らない。
  if (payload.agent_id) return { status: 'skipped', block: false, reason: 'subagent_compact', sessionId };
  const path = recordPath(sessionId, dir);
  const existing = readClaudeAutoHandoff(sessionId, dir);
  // 有効判定は会話を起動した project で行う。hook の cwd は Bash の cd に追従する。
  // 会話が別の project へ移っている時（Claude Desktop）は、移った先で行う。
  const projectPath = nativeProjectPath(
    claudeHostAdapter.completionProjectPath({
      cwd: payload.cwd ?? process.cwd(), env, transcriptPath: payload.transcript_path }), platform);

  if (payload.trigger !== 'auto') {
    // 人が /compact を選んだ。まだ止めていない記録は取り下げる。
    if (existing?.state === 'requested') rmSync(path, { force: true });
    return { status: 'skipped', block: false, reason: 'manual_compact', sessionId, projectPath };
  }
  // 引き継ぎが進んでいる会話は、設定が後から変わっても圧縮させない。
  if (existing) {
    return { status: 'already_requested', block: true, sessionId, projectPath, handoffId: existing.handoff_id };
  }
  if (!claudeAutoHandoffEnabledFor(config, projectPath)) {
    return { status: 'skipped', block: false, reason: 'auto_handoff_disabled', sessionId, projectPath };
  }
  if (unsupportedEntrypoint(env)) {
    return { status: 'skipped', block: false, reason: 'handoff_host_unsupported', sessionId, projectPath };
  }

  // /tl と同じ印。後継の最初の指示が、この会話を前任として合流させる。
  const db = openDb();
  // 会話が別の project へ移っている時（Claude Desktop）は、sessions の project も移った先にそろえる。
  // 合流は前任と後継の project が同じ時だけ行う。付け替えは Stop でも行うが、移った後に1回も Stop を
  // 通らないまま引き継ぐ会話があり、その時は後継へ記憶が入らなかった（0.15.2・0.15.3、macOS で実測）。
  if (readClaudeRelocatedCwd(payload.transcript_path)) {
    db.prepare('UPDATE sessions SET project_path = ? WHERE session_id = ? AND project_path <> ?')
      .run(projectPath, sessionId, projectPath);
  }
  writeBaton(db, { projectPath, sessionId, now });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  removeStale(dir, now);
  const handoffId = randomUUID();
  writeJsonPrivate(path, {
    schema: CLAUDE_AUTO_HANDOFF_SCHEMA,
    handoff_id: handoffId,
    source_session_id: sessionId,
    project_path: projectPath,
    transcript_path: payload.transcript_path ?? null,
    state: 'requested',
    requested_at: now,
    updated_at: now,
    settings: null,
    in_flight: null,
    successor: null,
    error_code: null,
    accepted_at: null,
  });
  return { status: 'requested', block: true, sessionId, projectPath, handoffId };
}

/** 止める時点で動いていたモデル。transcript の最後の assistant 行から読む（API error の合成行は除く）。 */
function readLatestModel(transcriptPath) {
  const entries = readRawEntries(transcriptPath);
  for (let index = entries.length - 1; index >= 0; index--) {
    const model = entries[index]?.type === 'assistant' ? entries[index].message?.model : null;
    if (typeof model === 'string' && model.startsWith('claude-')) return model;
  }
  return null;
}

const CONTINUATION_MARKER = /Throughline自動継続 ([0-9a-f-]{36})/;

// 後継へ渡す「このターンでここまでにしたこと」。1件の長さと件数を抑える。全文は取り込んだ details にある。
const STEP_TEXT_MAX_CHARS = 300;
const STEP_TARGET_MAX_CHARS = 160;
const STEPS_KEPT = 80;
const STOPPED_TOOLS_KEPT = 10;
// 道具の呼び出しを1行にする時に見せる入力。知らない道具は名前だけにする。
const TOOL_TARGET_KEYS = ['file_path', 'notebook_path', 'path', 'command', 'pattern', 'url', 'description', 'query', 'prompt', 'skill'];

function clipLine(text, maxChars) {
  const line = String(text).replace(/\s+/g, ' ').trim();
  return line.length <= maxChars ? line : `${line.slice(0, maxChars - 1)}…`;
}

const TOOL_PATH_KEYS = new Set(['file_path', 'notebook_path', 'path']);

/** 作業ディレクトリの中の場所は相対で書く（後継の記憶のヘッダに作業ディレクトリがある）。長い場所は末尾を残す。 */
function clipPath(value, projectPath) {
  let line = value.trim();
  if (projectPath && line.startsWith(projectPath) && /^[\\/]/.test(line.slice(projectPath.length))) {
    line = line.slice(projectPath.length + 1);
  }
  return line.length <= STEP_TARGET_MAX_CHARS ? line : `…${line.slice(-(STEP_TARGET_MAX_CHARS - 1))}`;
}

function toolTarget(input, projectPath) {
  if (!input || typeof input !== 'object') return '';
  for (const key of TOOL_TARGET_KEYS) {
    if (typeof input[key] !== 'string' || !input[key].trim()) continue;
    return TOOL_PATH_KEYS.has(key) ? clipPath(input[key], projectPath) : clipLine(input[key], STEP_TARGET_MAX_CHARS);
  }
  return '';
}

/**
 * 止めたターンで、止めるまでにした発言と道具の呼び出し（古い順）と、止めた道具。
 *
 * 圧縮を止めた後の応答が呼んだ道具は、どれも実行されていない（同じ応答に並んだ道具は全部止める）。
 * hook が並んで走るので、記録に残る止めた道具の id は、応答の中の最初の道具とは限らない。
 * 同じ応答（message.id）の道具を、まとめて「止めた道具」にする。
 */
function readInFlightSteps(transcriptPath, stoppedToolUseId, projectPath) {
  const steps = [];
  const toolById = new Map();
  for (const entry of sliceInFlightTurnEntries(readRawEntries(transcriptPath)).slice(1)) {
    const blocks = entry?.message?.content;
    if (!Array.isArray(blocks)) continue;
    if (entry.type === 'assistant') {
      const at = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN;
      for (const block of blocks) {
        if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim() && !isJunkAssistantText(block.text)) {
          steps.push({ kind: 'text', content: clipLine(block.text, STEP_TEXT_MAX_CHARS), timestamp: Number.isNaN(at) ? null : at });
        } else if (block?.type === 'tool_use' && typeof block.id === 'string') {
          const step = { kind: 'tool', id: block.id, response: entry.message.id ?? null, name: block.name ?? 'unknown',
            target: toolTarget(block.input, projectPath), failed: false };
          steps.push(step);
          toolById.set(block.id, step);
        }
      }
    } else if (entry.type === 'user') {
      for (const block of blocks) {
        if (block?.type === 'tool_result' && block.is_error === true && toolById.has(block.tool_use_id)) {
          toolById.get(block.tool_use_id).failed = true;
        }
      }
    }
  }
  const stopped = toolById.get(stoppedToolUseId);
  const firstStopped = stopped
    ? steps.findIndex(step => step.kind === 'tool' &&
        (step.id === stopped.id || (stopped.response !== null && step.response === stopped.response)))
    : -1;
  const done = firstStopped < 0 ? steps : steps.slice(0, firstStopped);
  const stoppedTools = firstStopped < 0 ? [] : steps.slice(firstStopped).filter(step => step.kind === 'tool');
  const earlier = done.slice(0, Math.max(0, done.length - STEPS_KEPT));
  const tools = {};
  for (const step of earlier) if (step.kind === 'tool') tools[step.name] = (tools[step.name] ?? 0) + 1;
  return {
    steps: done.slice(earlier.length).map(step => step.kind === 'text'
      ? { kind: 'text', content: step.content, timestamp: step.timestamp }
      : { kind: 'tool', name: step.name, target: step.target, failed: step.failed }),
    earlier_steps: earlier.length > 0 ? { texts: earlier.filter(step => step.kind === 'text').length, tools } : null,
    stopped_tools: stoppedTools.slice(0, STOPPED_TOOLS_KEPT).map(step => ({ name: step.name, target: step.target })),
    stopped_tools_total: stoppedTools.length,
  };
}

/**
 * 止めた時点の作業途中のターン。後継の会話が止められた時は、最後の user 発言が前の引き継ぎの
 * 継続の指示になっている。その時は、前の引き継ぎが運んだ元の依頼を引き続き運ぶ。
 * turn は、このターンを DB へ取り込んだ時の場所（worker が取り込みの後に入れる）。
 */
function snapshotInFlight(record, dir) {
  const latest = readLatestUserGroup(record.transcript_path);
  if (!latest) return null;
  const lastFragment = latest.fragments.filter(fragment => !isJunkAssistantText(fragment.content)).at(-1) ?? null;
  const previousHandoffId = CONTINUATION_MARKER.exec(latest.user.content)?.[1];
  const carried = previousHandoffId
    ? listClaudeAutoHandoffs({ dir }).find(other => other.handoff_id === previousHandoffId)?.in_flight?.user
    : null;
  return {
    user: carried ?? { content: latest.user.content, timestamp: latest.user.timestamp },
    last_fragment: lastFragment ? { content: lastFragment.content, timestamp: lastFragment.timestamp } : null,
    ...readInFlightSteps(record.transcript_path, record.stopped_tool_use_id, record.project_path),
    turn: null,
  };
}

/**
 * 止めたターンを DB へ取り込む (Codex の自動継続が、記憶を作る前に止めたターンを取り込むのと同じ)。
 * 後継が前任を合流させる前に済ませる。取り込めなくても引き継ぎは止めない。依頼と、ここまでにしたことは
 * 記録から後継へ渡る。取り込めなかった理由は worker のログに残り、記録の turn が null のままになる。
 */
function captureStoppedTurn(record, openDb) {
  try {
    const db = openDb();
    const { target, origin } = resolveMergeTarget(db, record.source_session_id);
    const captured = captureInFlightTurn(db, { targetSessionId: target, originSessionId: origin,
      transcriptPath: record.transcript_path, now: Date.now() });
    return captured && { origin_session_id: origin, turn_number: captured.turnNumber, user_at: captured.userAt,
      assistant_at: captured.assistantAt, details: captured.details };
  } catch (error) {
    process.stderr.write(`[auto-handoff] in-flight turn capture failed: ${error instanceof Error ? error.message : 'unknown'}\n`);
    return null;
  }
}

/** 止めた道具の呼び出しが transcript に書かれるまで待つ。その前の発言が出そろった印になる。 */
async function waitForStoppedToolUse(record, { timeoutMs, pollMs }) {
  if (!record.transcript_path || !record.stopped_tool_use_id) return;
  const written = () => readRawEntries(record.transcript_path).some(entry => entry?.type === 'assistant' &&
    Array.isArray(entry.message?.content) &&
    entry.message.content.some(block => block?.type === 'tool_use' && block.id === record.stopped_tool_use_id));
  for (const deadline = Date.now() + timeoutMs; !written() && Date.now() < deadline;) await delay(pollMs);
}

export async function launchClaudeAutoHandoffWorker(sessionId, { dir = claudeAutoHandoffDir() } = {}) {
  if (!validSessionId(sessionId)) throw new ClaudeHandoffError('auto_handoff_session_id_invalid');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const log = openSync(join(dir, `${sessionId}.log`), 'a', 0o600);
  try {
    const child = spawnPortable(process.execPath,
      [CLI_PATH, 'auto-handoff', 'worker', '--host', 'claude', '--operation', sessionId, '--json'],
      { detached: true, stdio: ['ignore', log, log], windowsHide: true });
    await new Promise((resolveSpawn, reject) => { child.once('spawn', resolveSpawn); child.once('error', reject); });
    child.unref();
    return child.pid;
  } finally { closeSync(log); }
}

function stopOutput(record) {
  const reason = record.successor?.short_id
    ? `この会話はThroughlineが新しい会話へ引き継ぎ済みです（引き継ぎID: ${record.handoff_id}）。続きは後継の会話で行ってください: claude attach ${record.successor.short_id}`
    : `Throughlineが、自動圧縮の代わりに新しい会話へ引き継ぎます（引き継ぎID: ${record.handoff_id}）。後継の会話は \`claude agents\` の一覧に出ます。`;
  return {
    continue: false,
    stopReason: reason,
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
  };
}

/**
 * PreToolUse hook の本体。引き継ぎの記録がある会話の道具を、実行させずに止める。
 * 最初に止めた hook だけが、止めた時点の依頼と設定を記録へ写し、後継を立てる worker を起動する。
 * 記録が無い会話と、subagent の中の道具には何もしない（null）。
 *
 * @returns {Promise<object|null>} Claude Code へ返す hook 出力
 */
export async function stopClaudeTurnForHandoff({
  payload,
  now = Date.now(),
  dir = claudeAutoHandoffDir(),
  launchWorker = launchClaudeAutoHandoffWorker,
}) {
  const sessionId = payload?.session_id;
  if (!validSessionId(sessionId) || payload.agent_id) return null;
  let record = readClaudeAutoHandoff(sessionId, dir);
  if (!record) return null;
  if (RETRYABLE_STATES.has(record.state)) {
    // 同じ応答に並んだ道具の hook は同時に走る。立ち上げは1回だけ。
    const claim = join(dir, `${sessionId}.claim`);
    if (record.state === 'failed') rmSync(claim, { force: true });
    let claimed = true;
    try { closeSync(openSync(claim, 'wx', 0o600)); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      claimed = false;
    }
    if (claimed) {
      // 依頼とモデルは worker が transcript から読む。hook の時点では、直前の発言がまだ書かれていないことがある。
      record = updateRecord(sessionId, {
        state: 'stopped',
        error_code: null,
        stopped_tool_use_id: typeof payload.tool_use_id === 'string' ? payload.tool_use_id : null,
        transcript_path: payload.transcript_path ?? record.transcript_path ?? null,
        settings: {
          model: null,
          effort: typeof payload.effort?.level === 'string' ? payload.effort.level : null,
          permission_mode: typeof payload.permission_mode === 'string' ? payload.permission_mode : null,
        },
      }, { dir, now });
      try { await launchWorker(sessionId, { dir }); }
      catch {
        record = updateRecord(sessionId, { state: 'failed', error_code: 'handoff_worker_start_failed' }, { dir });
      }
    }
  }
  return stopOutput(record);
}

/**
 * Stop hook から呼ぶ。圧縮を止めた後、道具を呼ばずにターンが終わった時は、続ける作業が無い。
 * 記録を取り下げる。印（baton）は残るので、次に開いた新しい会話が記憶を引き継ぐ。
 */
export function completeClaudeTurnWithoutHandoff({ sessionId, dir = claudeAutoHandoffDir() }) {
  if (!validSessionId(sessionId)) return false;
  const record = readClaudeAutoHandoff(sessionId, dir);
  if (record?.state !== 'requested') return false;
  rmSync(recordPath(sessionId, dir), { force: true });
  return true;
}

/** 後継へ送る継続の指示。引き継ぎIDを含め、後継の最初の指示がこの配送のものかを照合できるようにする。 */
export function claudeContinuationInput(record) {
  // この文は後継の最初の指示（利用者の発言）として届く。止めた道具をやり直さずに「済んだ」と書いて
  // 先へ進む後継が出たので（Haiku 4.5、macOS で実測）、実行されていない道具から始めることを明記する。
  return `Throughline自動継続 ${record.handoff_id}\n` +
    '注入された記憶と元のユーザー依頼に従い、未完了の作業をそのまま継続してください。' +
    '記憶の「実行されなかった道具」は、まだ実行されていません。最初にそれを実際に呼び出してから、先へ進んでください。' +
    '「ここまでにしたこと」に載っている完了済みの操作は、重複実行しないでください。';
}

/**
 * 最初の UserPromptSubmit（baton の合流）から呼ぶ。前任がこの後継へ自動で引き継いだ会話なら、
 * 止めた時点の依頼を返す。届いた指示がこの引き継ぎの配送なら、受領を記録する。
 *
 * @returns {{handoffId: string, projectPath: string, inFlight: object|null, transcriptPath: string|null}|null}
 */
export function acceptClaudeAutoContinuation({ predecessorId, successorSessionId, prompt = null,
  dir = claudeAutoHandoffDir(), now = Date.now() }) {
  if (!validSessionId(predecessorId) || typeof successorSessionId !== 'string') return null;
  const record = readClaudeAutoHandoff(predecessorId, dir);
  if (!record || !ACCEPTABLE_STATES.has(record.state)) return null;
  const carriesInstruction = typeof prompt === 'string' && prompt.includes(`Throughline自動継続 ${record.handoff_id}`);
  // 後継の ID が記録に入っていれば ID で、まだなら指示が運ぶ引き継ぎ ID で、後継と認める。
  const isSuccessor = record.successor?.short_id
    ? successorSessionId.startsWith(record.successor.short_id)
    : carriesInstruction;
  if (!isSuccessor) return null;
  if (carriesInstruction && !record.accepted_at && !existsSync(acceptancePath(predecessorId, dir))) {
    writeJsonPrivate(acceptancePath(predecessorId, dir),
      { handoff_id: record.handoff_id, successor_session_id: successorSessionId, accepted_at: now });
  }
  return { handoffId: record.handoff_id, projectPath: record.project_path, inFlight: record.in_flight ?? null,
    transcriptPath: record.transcript_path ?? null };
}

function readAcceptance(sessionId, handoffId, dir) {
  const acceptance = readJson(acceptancePath(sessionId, dir));
  return acceptance?.handoff_id === handoffId && typeof acceptance.accepted_at === 'number' ? acceptance : null;
}

function successorArgs(record) {
  const args = ['--bg', '--name', `tl-${basename(record.project_path)}-${record.handoff_id.slice(0, 8)}`];
  const { model, effort, permission_mode: permissionMode } = record.settings ?? {};
  if (model) args.push('--model', model);
  if (effort) args.push('--effort', effort);
  if (permissionMode) args.push('--permission-mode', permissionMode);
  // 後継は旧い会話の続きなので、同じ作業ツリーを編集する。別の worktree へ移さない。
  args.push('--settings', JSON.stringify({ worktree: { bgIsolation: 'none' } }));
  // 継続の指示は、起動時の最初の指示として渡す。立てた後で外から送ると、権限のバイパス中の後継は
  // その文を利用者の承認まで止める（Claude Code の cross-session messaging の決まり）。
  args.push(claudeContinuationInput(record));
  return args;
}

function successorEnv(env) {
  const next = { ...env };
  for (const key of PER_SESSION_ENV) delete next[key];
  return next;
}

/**
 * 継続の指示を付けて後継を立て、後継の最初の指示が受領を残すのを待つ。失敗は固定の理由を記録して止まる。
 * 受領を確かめられない時も、後継を立て直さない（同じ指示を持った会話を2つ作らない）。
 */
export async function runClaudeAutoHandoffWorker(sessionId, {
  dir = claudeAutoHandoffDir(),
  env = process.env,
  spawn = spawnPortableSync,
  openDb = null,
  transcriptTimeoutMs = 5_000,
  acceptTimeoutMs = 60_000,
  pollMs = 200,
} = {}) {
  let record = readClaudeAutoHandoff(sessionId, dir);
  if (!record) throw new ClaudeHandoffError('handoff_not_found');
  if (record.state !== 'stopped') return record;
  const update = fields => { record = updateRecord(sessionId, fields, { dir }); return record; };
  const fail = code => update({ state: 'failed', error_code: code });

  // 止めた時点の依頼・ここまでにしたこと・その時のモデルを写し、止めたターンを DB へ取り込む。
  // 後継の最初の指示が、これを現在地として受け取る。前の引き継ぎの受領が残っていれば消す。
  rmSync(acceptancePath(sessionId, dir), { force: true });
  await waitForStoppedToolUse(record, { timeoutMs: transcriptTimeoutMs, pollMs });
  const inFlight = record.transcript_path ? snapshotInFlight(record, dir) : null;
  if (inFlight && openDb) inFlight.turn = captureStoppedTurn(record, openDb);
  update({
    state: 'launching',
    settings: { ...record.settings, model: record.transcript_path ? readLatestModel(record.transcript_path) : null },
    in_flight: inFlight,
  });
  const launched = spawn('claude', successorArgs(record), {
    cwd: record.project_path, env: successorEnv(env), encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (launched.error) {
    return fail(launched.error.code === 'ENOENT' ? 'handoff_claude_cli_unavailable' : 'handoff_successor_launch_failed');
  }
  const shortId = BACKGROUNDED_PATTERN.exec(normalizeTerminalText(`${launched.stdout ?? ''}`))?.[1];
  if (launched.status !== 0 || !shortId) {
    // 理由を端末内の worker のログに残す（指示や記憶は含まれない、起動コマンドの出力だけ）。
    process.stderr.write(`[auto-handoff] claude --bg exit=${launched.status} stdout=${JSON.stringify(`${launched.stdout ?? ''}`.slice(0, 500))} ` +
      `stderr=${JSON.stringify(`${launched.stderr ?? ''}`.slice(0, 500))}\n`);
    return fail('handoff_successor_launch_failed');
  }
  update({ state: 'launched', successor: { short_id: shortId, session_id: null } });

  // 指示は起動時に渡してある。後継の最初の UserPromptSubmit が受領を残すのを待つ。
  for (const deadline = Date.now() + acceptTimeoutMs; Date.now() < deadline;) {
    const acceptance = readAcceptance(sessionId, record.handoff_id, dir);
    if (acceptance) {
      rmSync(acceptancePath(sessionId, dir), { force: true });
      return update({ state: 'sent', error_code: null, accepted_at: acceptance.accepted_at,
        successor: { short_id: shortId, session_id: acceptance.successor_session_id } });
    }
    await delay(pollMs);
  }
  return update({ state: 'unknown', error_code: 'handoff_delivery_unconfirmed' });
}
