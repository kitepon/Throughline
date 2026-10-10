import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { sameProjectPath } from '../project-path.mjs';

export const CODEX_NATIVE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class CodexHandoffError extends Error {
  constructor(code) { super(code); this.code = code; }
}

function decodeRows(path) {
  const text = readFileSync(path, 'utf8');
  const lines = text.split('\n');
  const rows = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    // JSONLの末尾は、hostが次の行を書き終えるまで観測対象にしない。
    if (i === lines.length - 1 && !text.endsWith('\n')) continue;
    try { rows.push(JSON.parse(lines[i])); }
    catch { throw new CodexHandoffError('handoff_rollout_invalid'); }
  }
  return rows;
}

export function toAppServerSandbox(policy) {
  if (!policy || typeof policy.type !== 'string') throw new CodexHandoffError('handoff_settings_unavailable');
  switch (policy.type) {
    case 'danger-full-access': return { type: 'dangerFullAccess' };
    case 'read-only': return { type: 'readOnly', networkAccess: policy.network_access ?? false };
    case 'workspace-write': return {
      type: 'workspaceWrite', writableRoots: policy.writable_roots ?? [],
      networkAccess: policy.network_access ?? false,
      excludeTmpdirEnvVar: policy.exclude_tmpdir_env_var ?? false,
      excludeSlashTmp: policy.exclude_slash_tmp ?? false,
    };
    case 'external-sandbox': return { type: 'externalSandbox', networkAccess: policy.network_access ?? 'restricted' };
    default: throw new CodexHandoffError('handoff_sandbox_unsupported');
  }
}

export function normalizeThreadSettings(native) {
  if (!native || typeof native.model !== 'string' || typeof native.cwd !== 'string' ||
      !native.permission_profile || native.approval_policy == null ||
      typeof native.model_provider_id !== 'string') {
    throw new CodexHandoffError('handoff_settings_unavailable');
  }
  return {
    model: native.model, modelProvider: native.model_provider_id,
    effort: native.reasoning_effort ?? null, approvalPolicy: native.approval_policy,
    approvalsReviewer: native.approvals_reviewer ?? 'user', cwd: native.cwd,
    permissionProfile: native.permission_profile, serviceTier: native.service_tier ?? null,
    collaborationMode: native.collaboration_mode ?? null,
    disabledPluginIds: native.disabled_plugin_ids ?? [],
    runtimeWorkspaceRoots: native.runtime_workspace_roots ?? [],
  };
}

export function settingsMatch(source, target) {
  const a = { ...source }, b = { ...target };
  delete a.sandboxPolicy; delete b.sandboxPolicy;
  // Codex 0.162 は、未指定の service tier を thread_settings_applied へ "default" と書く。未指定（null）と同じ枠。
  a.serviceTier ??= 'default'; b.serviceTier ??= 'default';
  const aCwd = a.cwd, bCwd = b.cwd;
  delete a.cwd; delete b.cwd;
  return sameProjectPath(aCwd, bCwd) && isDeepStrictEqual(a, b);
}

export function resolvePreparedSettings(source, prepared) {
  const expected = { ...source };
  const mode = source.collaborationMode;
  if (mode?.settings?.developer_instructions == null && prepared?.collaborationMode?.settings?.developer_instructions != null) {
    const sourceMode = { ...mode, settings: { ...mode.settings, developer_instructions: null } };
    const targetMode = { ...prepared.collaborationMode, settings: { ...prepared.collaborationMode.settings, developer_instructions: null } };
    if (!isDeepStrictEqual(sourceMode, targetMode)) throw new CodexHandoffError('handoff_prepared_settings_mismatch');
    // nullはCodexの標準モード指示の選択。公式設定APIが展開した本文を、表示前の比較値へ固定する。
    expected.collaborationMode = prepared.collaborationMode;
  }
  if (!settingsMatch(expected, prepared)) throw new CodexHandoffError('handoff_prepared_settings_mismatch');
  return expected;
}

export function threadStartSettings(settings) {
  const profile = settings.permissionProfile;
  let permissions;
  if (settings.sandboxPolicy) {
    const modes = { dangerFullAccess: 'danger-full-access', readOnly: 'read-only', workspaceWrite: 'workspace-write' };
    const sandbox = modes[settings.sandboxPolicy.type];
    if (!sandbox) throw new CodexHandoffError('handoff_sandbox_unsupported');
    permissions = { sandbox };
  } else if (profile.type === 'disabled') permissions = { sandbox: 'danger-full-access' };
  else throw new CodexHandoffError('handoff_settings_unavailable');
  return { cwd: settings.cwd, model: settings.model, modelProvider: settings.modelProvider,
    approvalPolicy: settings.approvalPolicy, approvalsReviewer: settings.approvalsReviewer,
    runtimeWorkspaceRoots: settings.runtimeWorkspaceRoots, serviceTier: settings.serviceTier,
    ...permissions, config: { model_reasoning_effort: settings.effort } };
}

export function readCodexHandoffState(path, { threadId = null, turnId = null, deliveryText = null } = {}) {
  const rows = decodeRows(path);
  let meta = null, rawSettings = null, preparedSettings = null, context = null, latestTurnId = null;
  let stoppedAt = null, stoppedReason = null, completedAt = null, turnStartAt = null;
  let correlatedTurnId = null, pendingUser = null, progress = false, turnOpen = false, hasTurnInput = false;
  const pendingCalls = new Map();
  const nativeSessions = new Set();
  let inheritedThroughlineMemory = false;
  // 受け取った記憶の本文（最初の1つ）。前任をさかのぼれないタスクを引き継ぐ時に、そのまま後継へ渡す。
  let inheritedThroughlineMemoryText = null;
  let completedTools = 0;
  // turnId を指定した時だけ、その turn より後に始まった turn を並べる。closed は止まった（turn_aborted）か完了したか、
  // activity はモデルの発言・道具の呼び出し・圧縮・完了のどれかがあったか。入力を受けただけで止まった turn は activity が false。
  const laterTurns = [];
  let sourceSeen = false, later = null;
  for (const row of rows) {
    const payload = row.payload;
    if (later && (row.type === 'compacted' || row.type === 'token_usage_record')) later.activity = true;
    // forkの先頭は子自身のmetadata。後続にコピーされた親のmetadataは識別へ使わない。
    if (row.type === 'session_meta') { meta ??= payload; continue; }
    if (row.type === 'turn_context' && (!turnId || payload.turn_id === turnId)) context = payload;
    if (row.type === 'event_msg' && payload?.type === 'thread_settings_applied') {
      rawSettings = payload.thread_settings;
      preparedSettings ??= normalizeThreadSettings(rawSettings);
    }
    if (row.type === 'event_msg' && payload?.type === 'task_started') {
      latestTurnId = payload.turn_id;
      turnOpen = true;
      if (turnId && latestTurnId === turnId) sourceSeen = true;
      else if (turnId && sourceSeen) { later = { turnId: latestTurnId, closed: false, activity: false }; laterTurns.push(later); }
      hasTurnInput = pendingUser != null;
      if (!turnId || latestTurnId === turnId) {
        turnStartAt = Date.parse(row.timestamp); pendingCalls.clear(); completedTools = 0;
        stoppedAt = null; stoppedReason = null; completedAt = null;
      }
      if (deliveryText && pendingUser === deliveryText) correlatedTurnId = latestTurnId;
      pendingUser = null;
    }
    if (row.type === 'event_msg' && payload?.type === 'turn_aborted' && payload.turn_id === (turnId ?? latestTurnId)) {
      stoppedAt = Date.parse(row.timestamp); stoppedReason = payload.reason;
    }
    if (row.type === 'event_msg' && ['turn_aborted', 'task_complete'].includes(payload?.type) && payload.turn_id === latestTurnId) turnOpen = false;
    if (later && row.type === 'event_msg' && payload?.turn_id === later.turnId) {
      if (payload.type === 'turn_aborted') later.closed = true;
      if (payload.type === 'task_complete') { later.closed = true; later.activity = true; }
    }
    if (later && row.type === 'event_msg' && payload?.type === 'agent_message') later.activity = true;
    if (later && row.type === 'response_item' && !(payload?.type === 'message' && payload.role !== 'assistant')) later.activity = true;
    if (row.type === 'event_msg' && payload?.type === 'task_complete' && payload.turn_id === (turnId ?? latestTurnId)) {
      completedAt = Date.parse(row.timestamp);
    }
    if (row.type === 'response_item') {
      if (payload?.type === 'message' && payload.role === 'developer') {
        const text = (payload.content ?? []).map(c => c.text ?? '').join('\n');
        if (/^## Throughline: (?:自動継続文脈|Active Work Context|New Codex Thread Handoff)/m.test(text)) {
          inheritedThroughlineMemory = true;
          inheritedThroughlineMemoryText ??= text;
        }
      }
      if (payload?.type === 'message' && payload.role === 'user') {
        const text = (payload.content ?? []).filter(c => typeof c.text === 'string').map(c => c.text).join('\n');
        const input = text.trim() && !text.startsWith('# AGENTS.md instructions') && !text.startsWith('<hook_prompt');
        if (input) {
          if (turnOpen) hasTurnInput = true;
          else pendingUser = text;
        }
        if (deliveryText && text === deliveryText) {
          if (turnOpen) correlatedTurnId = latestTurnId;
          else pendingUser = text;
        }
      }
      if ((!turnId || latestTurnId === turnId) && ['function_call', 'custom_tool_call'].includes(payload?.type)) {
        let input = null;
        try { input = JSON.parse(payload.arguments ?? payload.input ?? 'null'); } catch { /* 非JSONのtool入力はsession識別子を持たない。 */ }
        pendingCalls.set(payload.call_id, { name: payload.name, sessionId: input?.session_id });
      }
      if ((!turnId || latestTurnId === turnId) && ['function_call_output', 'custom_tool_call_output'].includes(payload?.type)) {
        const call = pendingCalls.get(payload.call_id);
        if (/(?:^|\.)(?:exec_command|write_stdin)$/.test(call?.name ?? '')) {
          const blocks = typeof payload.output === 'string' ? [{ text: payload.output }] : payload.output ?? [];
          for (const block of blocks) {
            let result;
            try { result = JSON.parse(block.text); } catch { continue; }
            // 公開tool結果の構造だけを読む。会話やコマンド出力からjobの状態を推測しない。
            if (!result || typeof result !== 'object' || typeof result.wall_time_seconds !== 'number' || !Object.hasOwn(result, 'output')) continue;
            if (result.session_id != null && result.exit_code == null) nativeSessions.add(result.session_id);
            if (result.exit_code != null) nativeSessions.delete(call.sessionId ?? result.session_id);
          }
        }
        if (pendingCalls.delete(payload.call_id)) completedTools++;
      }
      if (correlatedTurnId && correlatedTurnId === latestTurnId && payload?.type === 'message' && payload.role === 'assistant') progress = true;
    }
    if (row.type === 'event_msg' && payload?.type === 'user_message' && deliveryText && payload.message === deliveryText) {
      if (turnOpen) correlatedTurnId = latestTurnId;
      else pendingUser = payload.message;
    }
    if (row.type === 'event_msg' && payload?.type === 'user_message') {
      if (turnOpen) hasTurnInput = true;
      else pendingUser = payload.message;
    }
    if (row.type === 'event_msg' && payload?.type === 'agent_message' && correlatedTurnId && correlatedTurnId === latestTurnId) progress = true;
  }
  if (!meta || (threadId && meta.id !== threadId)) throw new CodexHandoffError('handoff_thread_mismatch');
  let settings = null;
  if (rawSettings) {
    settings = normalizeThreadSettings(rawSettings);
    if (context && turnId) {
      if (typeof context.model !== 'string' || context.approval_policy == null || typeof context.cwd !== 'string') {
        throw new CodexHandoffError('handoff_settings_unavailable');
      }
      settings = { ...settings, model: context.model, effort: context.effort ?? context.reasoning_effort ?? settings.effort,
        approvalPolicy: context.approval_policy, cwd: context.cwd,
        permissionProfile: context.permission_profile ?? settings.permissionProfile,
        approvalsReviewer: context.approvals_reviewer ?? settings.approvalsReviewer,
        runtimeWorkspaceRoots: context.workspace_roots ?? settings.runtimeWorkspaceRoots,
        disabledPluginIds: context.disabled_plugin_ids ?? settings.disabledPluginIds,
        sandboxPolicy: toAppServerSandbox(context.sandbox_policy) };
    }
  }
  return { meta, settings, rawSettings, preparedSettings, context, latestTurnId, turnStartAt, stoppedAt, stoppedReason,
    completedAt, correlatedTurnId, hasTurnInput, progress, completedTools, pendingCallCount: pendingCalls.size,
    pendingNativeSessionCount: nativeSessions.size, inheritedThroughlineMemory, inheritedThroughlineMemoryText, laterTurns,
    compactedRows: rows.filter(r => r.type === 'compacted').length };
}
