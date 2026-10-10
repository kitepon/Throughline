import { mkdirSync, openSync, closeSync, writeFileSync, appendFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { withCodexReceiver, verifyCodexParent, submitCodexParentAnswer,
  platformDesktopFinder, readRuntimeProcesses } from 'aiterm-steer-delivery';
import { spawnPortable } from './os/portable-spawn-sync.mjs';
import { openUrlWithOsHandler } from './os/open-url.mjs';
import { sameProjectPath } from './project-path.mjs';
import { getDb, DB_PATH } from './db.mjs';
import { findCodexThreadCandidate } from './codex-thread-index.mjs';
import { captureCodexRolloutToDb } from './codex-capture.mjs';
import { readAutoHandoffConfig, autoHandoffEnabledFor } from './codex-auto-handoff-config.mjs';
import { getAutoHandoff, requestAutoHandoff, updateAutoHandoff, failAutoHandoff, listContinuedAutoHandoffs, findAutoHandoffForTarget,
  claimAutoHandoff, releaseAutoHandoff, freezeCodexMemory, continuationInput,
  findAutoHandoffForTurn, listDeliveredAutoHandoffsForSource, listUndeliveredAutoHandoffsForSource,
  HANDOFF_TERMINAL_STATES } from './codex-auto-handoff-store.mjs';
import { ensureAutoHandoffSummaries, renderAutoHandoffMemory } from './codex-auto-handoff-memory.mjs';
import { CODEX_NATIVE_ID_PATTERN, CodexHandoffError, readCodexHandoffState,
  settingsMatch, threadStartSettings } from './hosts/codex-handoff-state.mjs';
import { resolvePreparedSettings } from './hosts/codex-handoff-state.mjs';
import { composeAutoHandoffTitle, markHandedOffTitle, usableAutoHandoffTitle } from './auto-handoff-title.mjs';

const CLI_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../bin/throughline.mjs');
const stateRoot = () => join(homedir(), '.throughline', 'codex-auto-handoff');
export const autoHandoffDeliveryProfile = Object.freeze({
  id: 'throughline-auto-handoff', display_name: 'Throughline自動継続',
  setup_command: 'throughline auto-handoff enable', codex_steer_command: 'throughline auto-handoff enable',
  mcp_server: 'throughline', dispatch_tools: [], state_root: () => join(stateRoot(), 'delivery'),
  config_root: () => join(stateRoot(), 'delivery-config'),
  hooks: { codex: 'throughline-auto-handoff-codex-hook.mjs', claude: 'throughline-auto-handoff-claude-hook.mjs', cursor: 'throughline-auto-handoff-cursor-hook.mjs' },
  codex_client_name: 'throughline_auto_handoff', codex_hook_schema: 'throughline.auto-handoff.delivery.v1',
  backup_suffix: '.throughline-auto-handoff-backup',
});

const error = code => new CodexHandoffError(code);
const sourceState = (operation, options = {}) => readCodexHandoffState(operation.rollout_path,
  { threadId: operation.source_thread_id, turnId: operation.source_turn_id, ...options });

export function sourceBoundary(operation, state) {
  if (state.latestTurnId !== operation.source_turn_id) {
    // 引き継ぎの最中に旧タスクへ来た入力は、hookが止める。入力を受けただけで止まったturnは、元turnの境界を進めない。
    const later = state.laterTurns ?? [];
    if (!later.length || later.some(turn => turn.activity)) throw error('handoff_source_advanced');
    if (later.some(turn => !turn.closed)) return false;
  }
  if (state.pendingCallCount) throw error('handoff_source_operation_pending');
  if (state.pendingNativeSessionCount) throw error('handoff_native_session_pending');
  return Number.isFinite(state.stoppedAt) && state.stoppedAt >= operation.created_at;
}

export async function waitForHandoff(check, { timeoutMs = 120_000, intervalMs = 250,
  timeoutCode = 'handoff_observation_timeout' } = {}) {
  const deadline = Date.now() + timeoutMs;
  do {
    const result = await check();
    if (result) return result;
    await delay(intervalMs);
  } while (Date.now() < deadline);
  throw error(timeoutCode);
}

export async function launchAutoHandoffWorker(id, { resume = false } = {}) {
  mkdirSync(stateRoot(), { recursive: true, mode: 0o700 });
  const log = openSync(join(stateRoot(), `${id}.log`), 'a', 0o600);
  try {
    const child = spawnPortable(process.execPath, [CLI_PATH, 'auto-handoff', resume ? 'resume' : 'worker', '--operation', id, '--json'],
      { detached: true, stdio: ['ignore', log, log], windowsHide: true });
    await new Promise((resolveSpawn, reject) => { child.once('spawn', resolveSpawn); child.once('error', reject); });
    child.unref();
    return child.pid;
  } finally { closeSync(log); }
}

function liveSuccessors(db, threadId, options, seen) {
  const found = [];
  for (const operation of listDeliveredAutoHandoffsForSource(db, threadId)) {
    if (operation.handoff_id === options.exceptHandoffId || seen.has(operation.handoff_id)) continue;
    seen.add(operation.handoff_id);
    const deeper = liveSuccessors(db, operation.target_thread_id, options, seen);
    if (deeper.length) { found.push(...deeper); continue; }
    const thread = options.findThread({ threadId: operation.target_thread_id, codexHome: operation.codex_home,
      projectPath: operation.project_path, requireProjectMatch: true });
    if (thread) found.push({ operation, mtimeMs: thread.mtimeMs ?? 0 });
  }
  return found;
}

/**
 * 旧タスクの作業を今持っている後継の引き継ぎ。継続の指示が届いた引き継ぎをたどり、後継がさらに引き継いで
 * いればその先へ進む。後継のrolloutが無い枝（消した、アーカイブした）は数えない。無ければ null。
 * 0.16.1 までに同じ旧タスクから複数の後継が立っていた時は、最後に動いた後継を返す。
 */
export function findLiveAutoHandoffSuccessor(db, threadId,
  { exceptHandoffId = null, findThread = findCodexThreadCandidate } = {}) {
  return liveSuccessors(db, threadId, { exceptHandoffId, findThread }, new Set())
    .sort((a, b) => b.mtimeMs - a.mtimeMs)[0]?.operation ?? null;
}

function openSuccessor(operation) {
  const result = openUrlWithOsHandler(`codex://threads/${encodeURIComponent(operation.target_thread_id)}`);
  return !result.error && result.status === 0;
}

// Codex が内部の文脈へ付けるターンの ID（`codex-rs/core/src/session/mod.rs` の `next_internal_sub_id`）。
const INTERNAL_COMPACTION_TURN_ID_PATTERN = /^auto-compact-\d+$/;

/** ターンの外の自動圧縮を止めた記録。引き継ぎの行は増えないので、起きた事をここに残す。会話の本文は書かない。 */
function recordInternalCompactionStop(entry) {
  mkdirSync(stateRoot(), { recursive: true, mode: 0o700 });
  appendFileSync(join(stateRoot(), 'internal-compactions.jsonl'), JSON.stringify(entry) + '\n', { mode: 0o600 });
}

/** 引き継ぎ済みの旧タスクを止めた記録。引き継ぎの行は増えないので、起きた事をここに残す。会話の本文は書かない。 */
function recordAutoHandoffRedirect(entry) {
  mkdirSync(stateRoot(), { recursive: true, mode: 0o700 });
  appendFileSync(join(stateRoot(), 'redirects.jsonl'), JSON.stringify(entry) + '\n', { mode: 0o600 });
}

// workerを起動してから、workerが自分のprocessを記録へ名乗るまでの間。この間の引き継ぎは、進んでいる物として扱う。
const WORKER_START_GRACE_MS = 15_000;
// workerが1回の引き継ぎに掛ける時間の上限（各段の待ち時間の合計より長い）。process一覧を読めない時だけ使う。
const WORKER_RUN_LIMIT_MS = 10 * 60_000;

/** その引き継ぎのworkerが動いているか。名乗る前は、記録の更新時刻で見る。 */
function workerActive(operation, processes, now) {
  const identity = operation.worker_identity;
  if (!identity) return now - operation.updated_at < WORKER_START_GRACE_MS;
  let table;
  // process一覧を読めない時は、後継を2つにしない側へ倒す。記録が新しい間は、動いている物として扱う。
  try { table = processes(); } catch { return now - operation.updated_at < WORKER_RUN_LIMIT_MS; }
  return table.some(p => p.pid === identity.pid && p.started_identity === identity.started_identity);
}

/**
 * 配送の前に止まった引き継ぎを、同じ引き継ぎとしてやり直せるか。後継のタスクが出来ていて、まだ誰も使っておらず、
 * 止まった後の旧タスクに動きが無い時だけ。後継が出来る前に止まった物は残る物が無いので、新しい引き継ぎで足りる。
 */
function resumableAfterStop(operation, rolloutPath, readTarget) {
  if (operation.mutation_stage || !operation.target_thread_id) return false;
  try {
    const target = readTarget(operation);
    if (!target || target.latestTurnId) return false;
    const later = readCodexHandoffState(rolloutPath,
      { threadId: operation.source_thread_id, turnId: operation.source_turn_id }).laterTurns;
    return later.length > 0 && !later.some(turn => turn.activity);
  } catch { return false; }
}

/**
 * 同じ旧タスクの、継続の指示をまだ送っていない引き継ぎの扱い。workerが動いていれば「最中」、後継が出来たまま
 * 止まっていれば「やり直し」。どちらでもなければ null（新しい引き継ぎを作る）。
 */
function settleUndeliveredAutoHandoff(db, threadId, { rolloutPath, processes, readTarget, now }) {
  const undelivered = listUndeliveredAutoHandoffsForSource(db, threadId);
  let table = null;
  const running = () => (table ??= processes());
  const inFlight = undelivered.find(operation => !HANDOFF_TERMINAL_STATES.has(operation.state) && workerActive(operation, running, now));
  if (inFlight) return { kind: 'in_flight', operation: inFlight, seen: undelivered };
  const stopped = undelivered.find(operation => operation.state !== 'unknown' && resumableAfterStop(operation, rolloutPath, readTarget));
  if (stopped) return { kind: 'retry', operation: stopped, seen: undelivered };
  return { kind: null, seen: undelivered };
}

export async function requestCodexAutoHandoff({ payload, db = null,
  config = readAutoHandoffConfig(), launchWorker = launchAutoHandoffWorker,
  findThread = findCodexThreadCandidate, openThread = openSuccessor, recordRedirect = recordAutoHandoffRedirect,
  recordInternalCompaction = recordInternalCompactionStop,
  processes = readRuntimeProcesses, readTarget = targetState, now = Date.now() } = {}) {
  if (payload.trigger !== 'auto' || !autoHandoffEnabledFor(config, payload.cwd)) return { status: 'skipped' };
  const threadId = payload.session_id, turnId = payload.turn_id;
  const located = CODEX_NATIVE_ID_PATTERN.test(threadId ?? '') &&
    typeof payload.transcript_path === 'string' && isAbsolute(payload.transcript_path) && isAbsolute(payload.cwd ?? '');
  // Codex が自分で作った内部の文脈（ターンの ID が `auto-compact-N`）からの圧縮。利用者のターンではないので、
  // 引き継ぎの起点にできない。例外にせず圧縮だけを止める（文脈を残せば、次の利用者のターンの圧縮の合図で引き継げる）。
  if (located && INTERNAL_COMPACTION_TURN_ID_PATTERN.test(turnId ?? '')) {
    recordInternalCompaction({ at: new Date(now).toISOString(), thread_id: threadId, turn_id: turnId });
    return { status: 'ok', inserted: false, internalCompaction: true, continue: false,
      stopReason: 'Throughlineが、ターンの外の自動圧縮を止めました。文脈が上限に近づいたターンで、新しいタスクへ引き継ぎます。' };
  }
  if (!located || !CODEX_NATIVE_ID_PATTERN.test(turnId ?? '')) throw error('handoff_hook_identity_invalid');
  // JS実装のrealpathは、WindowsのCodex Desktopが起動したhookの中で `EISDIR: lstat 'C:'` で落ちる。OSのrealpathを使う。
  const rolloutPath = realpathSync.native(payload.transcript_path);
  const state = readCodexHandoffState(rolloutPath, { threadId, turnId });
  if (state.meta.originator !== 'Codex Desktop' || state.meta.source !== 'vscode') return { status: 'skipped', reason: 'handoff_host_unsupported' };
  if (!sameProjectPath(state.meta.cwd, payload.cwd) || state.latestTurnId !== turnId) throw error('handoff_hook_source_mismatch');
  const sessionPart = /[\\/]sessions[\\/]/.exec(rolloutPath);
  if (!sessionPart) throw error('handoff_codex_home_unavailable');
  const codexHome = rolloutPath.slice(0, sessionPart.index);
  const actualDb = db ?? getDb();
  // 引き継ぎ済みの旧タスクへ、新しい入力が来た。作業は後継が持っているので、後継を増やさずに止めて後継を示す。
  const sameTurn = findAutoHandoffForTurn(actualDb, threadId, turnId);
  const successor = sameTurn ? null : findLiveAutoHandoffSuccessor(actualDb, threadId, { findThread });
  if (successor) {
    const opened = openThread(successor);
    recordRedirect({ at: new Date().toISOString(), source_thread_id: threadId, source_turn_id: turnId,
      handoff_id: successor.handoff_id, target_thread_id: successor.target_thread_id, opened });
    return { status: 'ok', operationId: successor.handoff_id, inserted: false, redirected: true,
      targetThreadId: successor.target_thread_id, opened, continue: false,
      stopReason: `このタスクはThroughlineが新しいタスクへ引き継ぎ済みです（引き継ぎID: ${successor.handoff_id}）。` +
        `続きは後継のタスク「${autoHandoffTargetName(actualDb, successor)}」で行ってください: ` +
        `codex://threads/${successor.target_thread_id}` };
  }
  // 引き継ぎの最中（継続の指示を送る前）と、後継が出来たまま止まった旧タスクへ、新しい入力が来た。
  // 別の引き継ぎを作ると後継が2つになるので、進んでいる引き継ぎを返すか、同じ引き継ぎをやり直す。
  let settled = sameTurn ? { kind: null, seen: [] }
    : settleUndeliveredAutoHandoff(actualDb, threadId, { rolloutPath, processes, readTarget, now });
  let created = null;
  if (!settled.kind) {
    // 2つの入力がほぼ同時に来た時は、先に記録した方だけが引き継ぎを作る。確認と記録を1つのtransactionで行う。
    actualDb.exec('BEGIN IMMEDIATE');
    try {
      const seen = new Set(settled.seen.map(operation => operation.handoff_id));
      const raced = sameTurn ? null : listUndeliveredAutoHandoffsForSource(actualDb, threadId)
        .find(operation => !seen.has(operation.handoff_id) && !HANDOFF_TERMINAL_STATES.has(operation.state));
      if (raced) settled = { kind: 'in_flight', operation: raced };
      else created = requestAutoHandoff(actualDb, { threadId, turnId, projectPath: state.meta.cwd,
        rolloutPath, codexHome, openHost: config.openHost });
      actualDb.exec('COMMIT');
    } catch (cause) {
      actualDb.exec('ROLLBACK');
      throw cause;
    }
  }
  if (settled.kind) {
    const pending = settled.operation;
    if (settled.kind === 'retry') {
      try { await launchWorker(pending.handoff_id, { resume: pending.state === 'failed' }); }
      catch { throw error('handoff_worker_start_failed'); }
    }
    recordRedirect({ at: new Date().toISOString(), kind: settled.kind, source_thread_id: threadId, source_turn_id: turnId,
      handoff_id: pending.handoff_id, target_thread_id: pending.target_thread_id ?? null, opened: false });
    return { status: 'ok', operationId: pending.handoff_id, inserted: false, continue: false,
      ...(settled.kind === 'retry' ? { resumed: true } : { inFlight: true }),
      stopReason: settled.kind === 'retry'
        ? `Throughlineが、途中で止まった引き継ぎをやり直します（引き継ぎID: ${pending.handoff_id}）。後継のタスクが開いたら、続きはそちらで行ってください。`
        : `Throughlineが、このタスクを新しいタスクへ引き継いでいる最中です（引き継ぎID: ${pending.handoff_id}）。後継のタスクが開いたら、続きはそちらで行ってください。` };
  }
  const { operation, inserted } = created;
  if (inserted) {
    try { await launchWorker(operation.handoff_id); }
    catch {
      failAutoHandoff(actualDb, operation.handoff_id, 'handoff_worker_start_failed');
      throw error('handoff_worker_start_failed');
    }
  }
  return { status: 'ok', operationId: operation.handoff_id, inserted, continue: false,
    stopReason: `Throughlineが自動継続へ切り替えます。引き継ぎID: ${operation.handoff_id}` };
}

async function sourceNativeState(operation, runtime) {
  return withCodexReceiver(autoHandoffDeliveryProfile, { thread_id: operation.source_thread_id, codex_home: operation.codex_home },
    async request => {
      const read = await request('thread/read', { threadId: operation.source_thread_id, includeTurns: false });
      const thread = read.thread;
      if (thread?.id !== operation.source_thread_id || thread.parentThreadId || thread.canAcceptDirectInput === false ||
          thread.source?.subAgent) throw error('handoff_source_not_primary');
      if (!sameProjectPath(thread.cwd, operation.project_path)) throw error('handoff_source_project_mismatch');
      // 順番待ちに残っている入力は、まだ送られていない（Codex は、ターンを始めた時に順番待ちから消す）。
      // 止めた旧タスクでは順番待ちが動かないので、ここで断ると何度入力しても同じ理由で止まり続ける。
      // 断らずに進み、後継が作業を続けた後で後継の順番待ちへ運ぶ（carryAutoHandoffQueue）。
      const queue = await request('thread/queue/list', { threadId: operation.source_thread_id, limit: 1 });
      if (!Array.isArray(queue.data)) throw error('handoff_queue_shape_invalid');
      const children = await request('thread/list', { ancestorThreadId: operation.source_thread_id,
        sourceKinds: ['subAgent'], limit: 100, archived: false });
      if (!Array.isArray(children.data) || children.nextCursor) throw error('handoff_children_unavailable');
      for (const child of children.data) {
        const candidate = findCodexThreadCandidate({ threadId: child.id, codexHome: operation.codex_home, requireProjectMatch: false });
        if (!candidate) throw error('handoff_child_state_unavailable');
        const state = readCodexHandoffState(candidate.rolloutPath, { threadId: child.id });
        if (state.latestTurnId && !(state.completedAt >= state.turnStartAt || state.stoppedAt >= state.turnStartAt)) {
          throw error('handoff_native_child_pending');
        }
      }
      return { projectId: thread.projectId ?? null, title: thread.name ?? thread.preview ?? null };
    }, runtime);
}

/**
 * 後継タスクの名前。一覧で、どの project の何の作業の続きかを読めるようにする。概要は前任の題から取る。
 * 前任が名前の無い後継（題が継続の指示になっている）なら、引き継ぎをさかのぼって元のタスクの題を使う。
 */
export function autoHandoffTargetName(db, operation) {
  const titles = [];
  for (let current = operation, depth = 0; current && depth < 20; depth++) {
    titles.push(current.runtime?.title);
    current = current.previous_handoff_id ? getAutoHandoff(db, current.previous_handoff_id) : null;
  }
  return composeAutoHandoffTitle({ projectPath: operation.project_path, titles });
}

/** 後継タスクに名前を付ける。名前は表示だけに使うので、付けられなくても引き継ぎは止めない（理由は worker のログに残す）。 */
export async function nameAutoHandoffTarget(request, targetId, name) {
  try {
    await request('thread/name/set', { threadId: targetId, name });
    return true;
  } catch (cause) {
    process.stderr.write(`[auto-handoff] thread/name/set failed: ${cause?.delivery_code ?? cause?.code ?? 'unknown'}\n`);
    return false;
  }
}

/**
 * 引き継ぎが済んだ旧タスクの名前の頭へ、引き継ぎ済みの印を付ける。同じ名前の後継が一覧に並んでも、
 * 印の無い1本が今の続きだと分かるようにする。今の名前を読んでから付けるので、利用者が付け直した名前も残る。
 * 名前は表示だけに使うので、付けられなくても引き継ぎは止めない（理由は worker のログに残す）。
 * @param {{fallbackTitle?: string|null}} [options] 旧タスクに名前が無い時に使う名前（名前を付けない版が作った後継）
 * @returns {Promise<'marked'|'kept'|'failed'>} kept はもう印がある・名前にできる値が無い
 */
export async function markAutoHandoffSource(operation, runtime, { connect = withCodexReceiver, fallbackTitle = null } = {}) {
  try {
    return await connect(autoHandoffDeliveryProfile, { thread_id: operation.source_thread_id, codex_home: operation.codex_home },
      async request => {
        const read = await request('thread/read', { threadId: operation.source_thread_id, includeTurns: false });
        const name = markHandedOffTitle(read.thread?.name ?? read.thread?.preview ?? null, fallbackTitle);
        if (!name) return 'kept';
        await request('thread/name/set', { threadId: operation.source_thread_id, name });
        return 'marked';
      }, runtime);
  } catch (cause) {
    process.stderr.write(`[auto-handoff] source mark failed: ${cause?.delivery_code ?? cause?.code ?? 'unknown'}\n`);
    return 'failed';
  }
}

/**
 * 止めた時に旧タスクの順番待ちに残っていた入力（まだ送られていない）を、順番を保って後継の順番待ちへ運ぶ。
 * 後継へ入れてから旧タスクの順番待ちから消す。後継へ入れた結果が分からない入力は、二重に送らないために
 * 入れ直さず、旧タスクの順番待ちに残す。運べなくても引き継ぎは止めない（後継はもう作業を続けている）。
 * @returns {Promise<{moved: number, unknown: number, left: number}>} left は、断られて旧タスクに残った数
 */
export async function carryAutoHandoffQueue(db, operation, runtime, { connect = withCodexReceiver } = {}) {
  const sourceId = operation.source_thread_id; const targetId = operation.target_thread_id;
  const stored = getAutoHandoff(db, operation.handoff_id).runtime?.queueCarry ?? {};
  const carry = { moved: [...(stored.moved ?? [])], unknown: [...(stored.unknown ?? [])], left: 0 };
  // 前の worker が、後継へ入れる途中で終わった。入ったかどうかが分からない。
  if (stored.moving && !carry.moved.includes(stored.moving)) carry.unknown.push(stored.moving);
  const save = moving => updateAutoHandoff(db, operation.handoff_id, { runtime_json: {
    ...(getAutoHandoff(db, operation.handoff_id).runtime ?? {}), queueCarry: { moved: carry.moved, unknown: carry.unknown, moving } } });
  const summary = () => ({ moved: carry.moved.length, unknown: carry.unknown.length, left: carry.left });
  try {
    if (stored.moving) save(null);
    await connect(autoHandoffDeliveryProfile, { thread_id: sourceId, codex_home: operation.codex_home }, async request => {
      const items = [];
      for (let cursor = null, page = 0; page < 50; page++) {
        const listed = await request('thread/queue/list', { threadId: sourceId, cursor, limit: 100 });
        if (!Array.isArray(listed.data)) throw error('handoff_queue_shape_invalid');
        items.push(...listed.data);
        cursor = listed.nextCursor ?? null;
        if (!cursor) break;
      }
      for (const item of items) {
        if (carry.unknown.includes(item.id)) continue;
        if (!carry.moved.includes(item.id)) {
          save(item.id);
          try {
            await request('thread/queue/add', { threadId: targetId, input: item.input, clientUserMessageId: item.clientUserMessageId });
          } catch (cause) {
            // はっきり断られた入力は後継に入っていない。旧タスクに残す。それ以外は結果不明として扱う。
            if (cause?.delivery_code === 'CODEX_RECEIVER_REJECTED') { carry.left++; save(null); continue; }
            carry.unknown.push(item.id); save(null);
            throw cause;
          }
          carry.moved.push(item.id);
          save(null);
        }
        await request('thread/queue/delete', { threadId: sourceId, queuedSubmissionId: item.id });
      }
    }, runtime);
  } catch (cause) {
    process.stderr.write(`[auto-handoff] queue carry failed: ${cause?.delivery_code ?? cause?.code ?? 'unknown'}\n`);
  }
  if (carry.moved.length || carry.unknown.length || carry.left) {
    process.stderr.write(`[auto-handoff] queue carried: ${JSON.stringify(summary())}\n`);
  }
  return summary();
}

// 受け取った記憶をそのまま運ぶ上限。超えた分は切り、切った事を記録する（後継の記憶に出す）。
const INHERITED_MEMORY_MAX_CHARS = 120_000;

/** 前任をさかのぼれないタスクが最初に受け取っていた記憶を、引き継ぎの記録へ残す形にする。 */
export function untrackedInheritedMemory(text) {
  const source = typeof text === 'string' ? text : '';
  const chars = Array.from(source);
  return { text: chars.length > INHERITED_MEMORY_MAX_CHARS ? chars.slice(0, INHERITED_MEMORY_MAX_CHARS).join('') : source,
    chars: chars.length, truncated: chars.length > INHERITED_MEMORY_MAX_CHARS };
}

/** 旧タスクが、名前を付けない版の作った後継だった時の名前。その後継を作った引き継ぎから、後継の名前を作り直す。 */
export function autoHandoffSourceFallbackTitle(db, operation) {
  const creator = findAutoHandoffForTarget(db, operation.source_thread_id);
  return creator ? autoHandoffTargetName(db, creator) : null;
}

async function listArchivedThreadIds(request) {
  const ids = new Set();
  for (let cursor = null, page = 0; page < 200; page++) {
    const listed = await request('thread/list', { archived: true, limit: 100, cursor });
    for (const thread of listed.data ?? []) ids.add(thread.id);
    cursor = listed.nextCursor ?? null;
    if (!cursor) break;
  }
  return ids;
}

/**
 * 今までに済んだ引き継ぎへ、まとめて名前を付け直す（0.16.9 までの版が引き継いだ分）。古い引き継ぎから順に、
 * (1) 名前の無い後継（名前を付けない版が作った物。継続の指示が題として見える）へ、後継の名前を付ける。
 * (2) 生きている後継がある旧タスクの名前の頭へ、引き継ぎ済みの印を付ける。
 * アーカイブ済みのタスクは触らない（Codex が名前の変更を断る。一覧にも出ない）。後継が消されている旧タスクは、
 * 今の続きなので印を付けない。何度流しても同じ結果になる。dryRun は名前を書かず、付ける名前だけを返す。
 * @returns {Promise<{marked: number, named: number, kept: number, failed: number, skipped: number, changes: Array<{thread_id: string, name: string}>}>}
 */
export async function markAutoHandoffSources(db, { executable = platformDesktopFinder()(), connect = withCodexReceiver,
  findThread = findCodexThreadCandidate, dryRun = false } = {}) {
  const runtime = { executable, timeout_ms: 30_000 };
  const result = { marked: 0, named: 0, kept: 0, failed: 0, skipped: 0, changes: [] };
  const byHome = new Map();
  for (const operation of listContinuedAutoHandoffs(db)) {
    if (!byHome.has(operation.codex_home)) byHome.set(operation.codex_home, []);
    byHome.get(operation.codex_home).push(operation);
  }
  for (const [codexHome, operations] of byHome) {
    await connect(autoHandoffDeliveryProfile, { codex_home: codexHome }, async request => {
      const archived = await listArchivedThreadIds(request);
      // この回で読んだ名前と、付けた名前。後ろの引き継ぎは、前の引き継ぎで付けた名前から作る。
      const titles = new Map();
      const read = async threadId => {
        if (!titles.has(threadId)) {
          const thread = (await request('thread/read', { threadId, includeTurns: false })).thread;
          titles.set(threadId, { name: usableAutoHandoffTitle(thread?.name), preview: usableAutoHandoffTitle(thread?.preview) });
        }
        return titles.get(threadId);
      };
      const rename = async (threadId, name) => {
        if (!dryRun) await request('thread/name/set', { threadId, name });
        titles.set(threadId, { ...titles.get(threadId), name });
        result.changes.push({ thread_id: threadId, name });
      };
      const failed = cause => {
        result.failed++;
        process.stderr.write(`[auto-handoff] mark-sources failed: ${cause?.delivery_code ?? cause?.code ?? 'unknown'}\n`);
      };
      const marked = new Set();
      for (const operation of operations) {
        const { source_thread_id: sourceId, target_thread_id: targetId } = operation;
        let source = null;
        if (!archived.has(sourceId)) {
          try { source = await read(sourceId); } catch { /* 消された旧タスク。名前は読めない */ }
        }
        let target = null;
        if (!archived.has(targetId)) {
          try { target = await read(targetId); } catch { /* 消された後継。付ける相手が無い */ }
        }
        if (target && !target.name) {
          try {
            await rename(targetId, composeAutoHandoffTitle({ projectPath: operation.project_path,
              titles: [source?.name, source?.preview] }));
            result.named++;
          } catch (cause) { failed(cause); }
        }
        if (marked.has(sourceId)) continue;
        marked.add(sourceId);
        if (!source || !findLiveAutoHandoffSuccessor(db, sourceId, { findThread })) { result.skipped++; continue; }
        try {
          const name = markHandedOffTitle(source.name ?? source.preview);
          if (!name) { result.kept++; continue; }
          await rename(sourceId, name);
          result.marked++;
        } catch (cause) { failed(cause); }
      }
    }, runtime);
  }
  return result;
}

async function createTarget(db, operation, runtime) {
  const targetId = await withCodexReceiver(autoHandoffDeliveryProfile, { thread_id: operation.source_thread_id, codex_home: operation.codex_home },
    async request => {
      let targetId = operation.target_thread_id;
      if (targetId) {
        await request('thread/resume', { threadId: targetId, excludeTurns: true });
      } else {
        const start = await request('thread/start', { ...threadStartSettings(operation.settings),
          projectId: operation.runtime.projectId, sessionStartSource: 'clear', serviceName: 'throughline-auto-handoff' });
        targetId = start.thread?.id;
        if (!CODEX_NATIVE_ID_PATTERN.test(targetId ?? '') || !sameProjectPath(start.cwd, operation.project_path)) throw error('handoff_target_response_invalid');
        updateAutoHandoff(db, operation.handoff_id, { target_thread_id: targetId, mutation_stage: 'inject' });
      }
      // 最初のターンの前に付ける。付けないと、継続の指示がそのままタスクの題として見える。
      await nameAutoHandoffTarget(request, targetId, autoHandoffTargetName(db, operation));
      if (!operation.runtime.targetMemoryInjected) {
        const text = renderAutoHandoffMemory(db, operation);
        await request('thread/inject_items', { threadId: targetId, items: [{ type: 'message', role: 'developer',
          content: [{ type: 'input_text', text }] }] });
        updateAutoHandoff(db, operation.handoff_id, { runtime_json: { ...operation.runtime, targetMemoryInjected: true }, mutation_stage: null });
      }
      await request('thread/settings/update', { threadId: targetId, model: operation.settings.model,
        effort: operation.settings.effort, approvalPolicy: operation.settings.approvalPolicy,
        approvalsReviewer: operation.settings.approvalsReviewer,
        ...(operation.settings.sandboxPolicy ? { sandboxPolicy: operation.settings.sandboxPolicy } : {}),
        collaborationMode: operation.settings.collaborationMode, disabledPluginIds: operation.settings.disabledPluginIds });
      const current = getAutoHandoff(db, operation.handoff_id);
      const observed = targetState(current);
      if (!observed?.settings) throw error('handoff_prepared_settings_unavailable');
      // 作成processがwriterを持つ間に公式APIの確定値を保存する。Desktop表示後の変更を準備値へ採用しない。
      const expected = resolvePreparedSettings(operation.settings, observed.settings);
      updateAutoHandoff(db, operation.handoff_id, { runtime_json: { ...operation.runtime,
        targetMemoryInjected: true, targetPrepared: true, preparedSettings: expected }, mutation_stage: null });
      return targetId;
    }, runtime);
  return targetId;
}

function targetState(operation) {
  const candidate = findCodexThreadCandidate({ threadId: operation.target_thread_id, codexHome: operation.codex_home,
    projectPath: operation.project_path, requireProjectMatch: true });
  return candidate ? readCodexHandoffState(candidate.rolloutPath,
    { threadId: operation.target_thread_id, deliveryText: continuationInput(operation) }) : null;
}

function openTarget(operation) {
  const result = openUrlWithOsHandler(`codex://threads/${encodeURIComponent(operation.target_thread_id)}`);
  if (result.error || result.status !== 0) throw error('handoff_target_open_failed');
}

export function showAutoHandoffFailure(operation) {
  mkdirSync(stateRoot(), { recursive: true, mode: 0o700 });
  const file = join(stateRoot(), `${operation.handoff_id}.html`);
  // 表示する値は製品の識別子と固定codeだけ。会話・例外本文・tool結果はHTMLへ出さない。
  const escape = text => String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  writeFileSync(file, `<!doctype html><meta charset="utf-8"><title>Throughline 引き継ぎ失敗</title>
<style>body{font:18px system-ui;max-width:800px;margin:64px auto;padding:24px;color:#20252b;background:#f6f7f9}code{word-break:break-all}</style>
<h1>自動継続を完了できませんでした</h1><p>引き継ぎは下記の工程で止まっています。タスクと記録を確認してください。</p>
<p><a href="codex://threads/${escape(operation.source_thread_id)}">旧タスクを開く</a>${operation.target_thread_id ? ` / <a href="codex://threads/${escape(operation.target_thread_id)}">後継タスクを開く</a>` : ''}</p>
<p>理由: <code>${escape(operation.error_code)}</code></p><p>引き継ぎID: <code>${escape(operation.handoff_id)}</code></p>
${operation.error_code === 'handoff_summarizer_backend_failed' ? '<p>記憶の要約に使うCodex CLIが失敗しました。通信の断、利用上限、認証切れなどで起きます。会話の記録と入力は失われていません。Codex CLIが使える様になった後、旧タスクへ入力すると、引き継ぎをもう一度始めます。</p>' : ''}
<p>状態: ${escape(operation.state)} / 停止した工程: ${escape(operation.resume_state)}</p>
<p>確認: <code>throughline auto-handoff status --operation ${escape(operation.handoff_id)}</code></p>
<p>原因を解消した後の再開: <code>throughline auto-handoff resume --operation ${escape(operation.handoff_id)}</code></p>
<p>送信結果が不明な場合は観測だけを行い、指示を自動で再送しません。</p>`, { mode: 0o600 });
  const result = openUrlWithOsHandler(pathToFileURL(file).href);
  if (result.error || result.status !== 0) throw error('handoff_failure_display_failed');
}

export async function runAutoHandoffWorker(id, { db = getDb(), resume = false, dependencies = {} } = {}) {
  const deps = { processes: readRuntimeProcesses, readSource: sourceState,
    nativeState: sourceNativeState, capture: captureCodexRolloutToDb, summaries: ensureAutoHandoffSummaries,
    createTarget, readTarget: targetState, openTarget, verify: verifyCodexParent, markSource: markAutoHandoffSource,
    carryQueue: carryAutoHandoffQueue,
    submit: submitCodexParentAnswer, notify: showAutoHandoffFailure, wait: waitForHandoff,
    executable: () => platformDesktopFinder()(), liveSuccessor: findLiveAutoHandoffSuccessor, ...dependencies };
  let operation = getAutoHandoff(db, id);
  if (!operation) throw error('handoff_not_found');
  if (operation.state === 'continued') return operation;
  const processes = deps.processes();
  const process = processes.find(p => p.pid === globalThis.process.pid);
  if (!process) throw error('handoff_worker_identity_unavailable');
  const identity = { pid: process.pid, started_identity: process.started_identity };
  if (!claimAutoHandoff(db, id, identity, processes)) return getAutoHandoff(db, id);
  const update = fields => { operation = updateAutoHandoff(db, id, fields).operation; };
  try {
    if (['failed', 'unknown'].includes(operation.state)) {
      if (!resume) return operation;
      if (operation.state === 'unknown') {
        // 配送後の入力・開始を観測できた場合だけ結果不明を解消する。create/injectは再送しない。
        if (operation.mutation_stage !== 'submit' || !operation.target_thread_id) return operation;
        const observed = deps.readTarget(operation);
        if (!observed?.correlatedTurnId) return operation;
        update({ state: 'submitted', error_code: null, mutation_stage: null });
      } else update({ state: operation.resume_state, error_code: null, resume_state: null });
    } else if (operation.mutation_stage) {
      throw error('handoff_mutation_outcome_unknown');
    }
    const runtime = { executable: deps.executable(), timeout_ms: 30_000 };
    if (operation.state === 'requested') {
      const state = await deps.wait(() => {
        const state = deps.readSource(operation);
        return sourceBoundary(operation, state) ? state : null;
      }, { timeoutMs: 30_000, timeoutCode: 'handoff_source_stop_unconfirmed' });
      if (!state.settings) throw error('handoff_settings_unavailable');
      // 前任をさかのぼれない記憶を受け取ったタスク（手動の引き継ぎで始めたタスクなど）。断ると、止めたターンが
      // そのまま残り、次の入力も同じ理由で止まる。受け取った記憶をそのまま後継へ渡して引き継ぐ（ADR 0046）。
      const inheritedMemory = state.inheritedThroughlineMemory && !operation.previous_handoff_id
        ? untrackedInheritedMemory(state.inheritedThroughlineMemoryText) : null;
      if (operation.previous_handoff_id) {
        const previous = getAutoHandoff(db, operation.previous_handoff_id);
        const continuation = deps.readSource(operation, { deliveryText: continuationInput(previous) });
        if (continuation.correlatedTurnId === operation.source_turn_id && !continuation.progress && !continuation.completedTools) {
          throw error('handoff_memory_not_usable');
        }
      }
      const native = await deps.nativeState(operation, runtime);
      update({ state: 'source_stopped', settings_json: state.settings,
        runtime_json: { ...native, databasePath: DB_PATH, ...(inheritedMemory ? { inheritedMemory } : {}) } });
    }
    // 最中に来た入力のturnが止まり切るまでの間は、境界がまだ見えない。短く待ってから判定する。
    const confirmSourceBoundary = () => deps.wait(() => sourceBoundary(operation, deps.readSource(operation)) || null,
      { timeoutMs: 30_000, timeoutCode: 'handoff_source_stop_unconfirmed' });
    if (operation.state === 'source_stopped') {
      await confirmSourceBoundary();
      if (!operation.snapshot) {
        const captured = deps.capture(db, { threadId: operation.source_thread_id, codexHome: operation.codex_home,
          projectPath: operation.project_path });
        if (captured.status !== 'captured') throw error('handoff_memory_unavailable');
        const state = deps.readSource(operation);
        update({ snapshot_json: freezeCodexMemory(db, operation, operation.settings, state) });
      }
      try { deps.summaries(db, operation); }
      catch (cause) {
        // 古いturnの要約を作るbackend（Codex CLI）が使えない。通信の断・利用上限・認証切れでも起きる。
        // 汎用の理由にせず、固定の理由で止める。失敗の画面に、失われた物が無い事と再開の仕方を書く（ADR 0041）。
        if ((cause?.source === 'codex-cli' && ['codex_cli_failed', 'empty_output'].includes(cause.reason)) ||
            cause?.message === 'handoff_l1_unavailable') throw error('handoff_summarizer_backend_failed');
        throw cause;
      }
      update({ state: 'memory_ready' });
    }
    if (operation.state === 'memory_ready') {
      if (!operation.runtime.targetPrepared) {
        update({ mutation_stage: operation.target_thread_id ? 'inject' : 'create' });
        await deps.createTarget(db, operation, runtime);
        operation = getAutoHandoff(db, id);
      }
      if (!operation.runtime.preparedSettings) {
        const prepared = deps.readTarget(operation)?.preparedSettings;
        if (!prepared) throw error('handoff_prepared_settings_unavailable');
        update({ runtime_json: { ...operation.runtime, preparedSettings: resolvePreparedSettings(operation.settings, prepared) } });
      }
      deps.openTarget(operation);
      await deps.wait(() => {
        const target = deps.readTarget(operation);
        if (target?.latestTurnId) throw error('handoff_target_advanced');
        if (!target?.settings) return null;
        if (!settingsMatch(operation.runtime.preparedSettings, target.settings)) throw error('handoff_target_settings_mismatch');
        return target;
      }, { timeoutCode: 'handoff_target_not_loaded' });
      update({ state: 'target_ready' });
    }
    if (operation.state === 'target_ready') {
      await confirmSourceBoundary();
      await deps.nativeState(operation, runtime);
      const target = deps.readTarget(operation);
      if (target?.latestTurnId || !target?.settings || !settingsMatch(operation.runtime.preparedSettings, target.settings)) throw error('handoff_target_advanced');
      const parent = { thread_id: operation.target_thread_id, codex_home: operation.codex_home };
      await deps.verify(autoHandoffDeliveryProfile, parent, runtime);
      // 同じ旧タスクの別の引き継ぎが先に指示を送っていたら、後継を増やさない。確認と記録を1つのtransactionで行う。
      db.exec('BEGIN IMMEDIATE');
      try {
        if (deps.liveSuccessor(db, operation.source_thread_id, { exceptHandoffId: id })) throw error('handoff_source_already_continued');
        update({ mutation_stage: 'submit' });
        db.exec('COMMIT');
      } catch (cause) {
        db.exec('ROLLBACK');
        throw cause;
      }
      const receipt = await deps.submit(autoHandoffDeliveryProfile, parent, operation.delivery_id, continuationInput(operation), runtime);
      update({ state: 'submitted', queued_submission_id: receipt.queued_submission_id, mutation_stage: null });
    }
    if (operation.state === 'submitted') {
      const target = await deps.wait(() => {
        const target = deps.readTarget(operation);
        if (!target) return null;
        if (target.hasTurnInput && !target.correlatedTurnId) throw error('handoff_target_input_mismatch');
        if (target.correlatedTurnId && target.stoppedAt && !target.progress) throw error('handoff_target_stopped_before_progress');
        return target.correlatedTurnId && target.progress ? target : null;
      }, { timeoutMs: 180_000, timeoutCode: 'handoff_target_progress_unconfirmed' });
      update({ state: 'continued', started_turn_id: target.correlatedTurnId, resume_state: null, error_code: null });
      // 旧タスクの順番待ちに残った入力を後継へ運ぶ。後継の最初のターン（継続の指示）が始まった後なので、順番は変わらない。
      await deps.carryQueue(db, operation, runtime);
      // 後継が作業を続けたのを確かめてから付ける。途中で止まった引き継ぎの旧タスクには付けない。
      await deps.markSource(operation, runtime, { fallbackTitle: autoHandoffSourceFallbackTitle(db, operation) });
    }
    return operation;
  } catch (cause) {
    operation = getAutoHandoff(db, id);
    const knownRejected = cause.delivery_code === 'CODEX_RECEIVER_REJECTED';
    const unknown = !!operation.mutation_stage && !knownRejected;
    if (knownRejected) update({ mutation_stage: null });
    const code = typeof cause.code === 'string' ? cause.code : cause.delivery_code ?? 'handoff_worker_failed';
    const failed = failAutoHandoff(db, id, code, { unknown });
    if (failed.changed) deps.notify(failed.operation);
    return failed.operation;
  } finally { releaseAutoHandoff(db, id, identity); }
}
