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
import { getAutoHandoff, requestAutoHandoff, updateAutoHandoff, failAutoHandoff,
  claimAutoHandoff, releaseAutoHandoff, freezeCodexMemory, continuationInput,
  findAutoHandoffForTurn, listDeliveredAutoHandoffsForSource, listUndeliveredAutoHandoffsForSource,
  HANDOFF_TERMINAL_STATES } from './codex-auto-handoff-store.mjs';
import { ensureAutoHandoffSummaries, renderAutoHandoffMemory } from './codex-auto-handoff-memory.mjs';
import { CODEX_NATIVE_ID_PATTERN, CodexHandoffError, readCodexHandoffState,
  settingsMatch, threadStartSettings } from './hosts/codex-handoff-state.mjs';
import { resolvePreparedSettings } from './hosts/codex-handoff-state.mjs';
import { composeAutoHandoffTitle } from './auto-handoff-title.mjs';

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
  processes = readRuntimeProcesses, readTarget = targetState, now = Date.now() } = {}) {
  if (payload.trigger !== 'auto' || !autoHandoffEnabledFor(config, payload.cwd)) return { status: 'skipped' };
  const threadId = payload.session_id, turnId = payload.turn_id;
  if (!CODEX_NATIVE_ID_PATTERN.test(threadId ?? '') || !CODEX_NATIVE_ID_PATTERN.test(turnId ?? '') ||
      typeof payload.transcript_path !== 'string' || !isAbsolute(payload.transcript_path) || !isAbsolute(payload.cwd ?? '')) {
    throw error('handoff_hook_identity_invalid');
  }
  const rolloutPath = realpathSync(payload.transcript_path);
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
      const queue = await request('thread/queue/list', { threadId: operation.source_thread_id, limit: 1 });
      if (!Array.isArray(queue.data)) throw error('handoff_queue_shape_invalid');
      if (queue.data.length) throw error('handoff_source_input_pending');
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
    createTarget, readTarget: targetState, openTarget, verify: verifyCodexParent,
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
      if (state.inheritedThroughlineMemory && !operation.previous_handoff_id) throw error('handoff_memory_lineage_untracked');
      if (operation.previous_handoff_id) {
        const previous = getAutoHandoff(db, operation.previous_handoff_id);
        const continuation = deps.readSource(operation, { deliveryText: continuationInput(previous) });
        if (continuation.correlatedTurnId === operation.source_turn_id && !continuation.progress && !continuation.completedTools) {
          throw error('handoff_memory_not_usable');
        }
      }
      const native = await deps.nativeState(operation, runtime);
      update({ state: 'source_stopped', settings_json: state.settings, runtime_json: { ...native, databasePath: DB_PATH } });
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
      deps.summaries(db, operation);
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
