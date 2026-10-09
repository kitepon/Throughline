import { isAbsolute, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { withCodexReceiver, platformDesktopFinder, realCodexHome } from 'aiterm-steer-delivery';
import { getDb, openReadOnlyDb, DB_PATH, CURRENT_VERSION } from '../db.mjs';
import { listAutoHandoffs, getAutoHandoff } from '../codex-auto-handoff-store.mjs';
import { renderFrozenDetail } from '../codex-auto-handoff-memory.mjs';
import { readAutoHandoffConfig, writeAutoHandoffConfig } from '../codex-auto-handoff-config.mjs';
import { autoHandoffDeliveryProfile, runAutoHandoffWorker, markAutoHandoffSources } from '../codex-auto-handoff.mjs';
import { installCodexAutoHandoffHook, installClaudeAutoHandoffHooks, removeClaudeAutoHandoffHooks,
  claudeAutoHandoffHooksRegistered } from './install.mjs';
import { sameProjectPath } from '../project-path.mjs';
import { readClaudeAutoHandoffConfig, writeClaudeAutoHandoffConfig } from '../claude-auto-handoff-config.mjs';
import { listClaudeAutoHandoffs, publicClaudeAutoHandoff, runClaudeAutoHandoffWorker, runClaudeDesktopOpen } from '../claude-auto-handoff.mjs';

// Claude の自動継続 (ADR 0033)。引き継ぎの記録は旧い会話の session id で持つ。結果が不明な配送は
// 再送しないので、resume は持たない。記憶の取得は通常の recall / detail を使うので、detail も持たない。
const CLAUDE_ACTIONS = ['enable', 'disable', 'status', 'worker', 'desktop-open'];

export function parseAutoHandoffArgs(args) {
  const out = { action: args[0] ?? 'status', host: 'codex', operation: null, project: null, origin: null, turn: null, database: null, json: false };
  if (!['enable', 'disable', 'status', 'resume', 'detail', 'worker', 'desktop-open', 'mark-sources'].includes(out.action)) throw Error('auto_handoff_action_invalid');
  const allowed = ['host', ...{ enable: ['project'], disable: [], status: ['project', 'operation'],
    resume: ['operation'], worker: ['operation'], 'desktop-open': ['operation'], 'mark-sources': [], detail: ['operation', 'origin', 'turn', 'database'] }[out.action]];
  const seen = new Set();
  for (let i = 1; i < args.length; i++) {
    if (seen.has(args[i])) throw Error('auto_handoff_argument_invalid');
    seen.add(args[i]);
    if (args[i] === '--json') { out.json = true; continue; }
    const key = { '--host': 'host', '--operation': 'operation', '--project': 'project', '--origin': 'origin', '--turn': 'turn', '--database': 'database' }[args[i]];
    if (!key || !allowed.includes(key) || !args[i + 1] || args[i + 1].startsWith('--')) throw Error('auto_handoff_argument_invalid');
    out[key] = args[++i];
  }
  if (!['codex', 'claude'].includes(out.host)) throw Error('auto_handoff_host_invalid');
  if (out.host === 'claude' ? !CLAUDE_ACTIONS.includes(out.action) : out.action === 'desktop-open') throw Error('auto_handoff_action_unsupported');
  if (out.project && !isAbsolute(out.project)) out.project = resolve(out.project);
  if (out.project && out.operation) throw Error('auto_handoff_argument_invalid');
  if (['worker', 'resume', 'detail', 'desktop-open'].includes(out.action) && !out.operation) throw Error('auto_handoff_operation_required');
  if (out.action === 'detail') {
    out.turn = Number(out.turn);
    if (!out.origin || !Number.isSafeInteger(out.turn) || out.turn < 1) throw Error('auto_handoff_detail_identity_required');
    if (out.database && !isAbsolute(out.database)) throw Error('auto_handoff_database_invalid');
  } else if (out.origin || out.turn || out.database) throw Error('auto_handoff_argument_invalid');
  return out;
}

export async function enableAutoHandoff({ project = null, codexHome = realCodexHome(),
  register = installCodexAutoHandoffHook, connect = withCodexReceiver, executable = platformDesktopFinder()() } = {}) {
  const registration = register(codexHome);
  const cwds = [project ?? process.cwd()];
  const hookKeys = await connect(autoHandoffDeliveryProfile, { codex_home: codexHome }, async request => {
    const hooks = await request('hooks/list', { cwds });
    const owned = hooks.data.flatMap(entry => entry.hooks)
      .filter(hook => sameProjectPath(hook.sourcePath, registration.hooksPath) && hook.command === registration.command && hook.eventName === 'preCompact');
    if (owned.length !== cwds.length) throw Error('auto_handoff_hook_unavailable');
    await request('config/batchWrite', { filePath: registration.configPath,
      edits: owned.flatMap(hook => [
        { keyPath: `hooks.state.${JSON.stringify(hook.key)}.trusted_hash`, value: hook.currentHash, mergeStrategy: 'replace' },
        { keyPath: `hooks.state.${JSON.stringify(hook.key)}.enabled`, value: true, mergeStrategy: 'replace' },
      ]) });
    const verified = await request('hooks/list', { cwds });
    const own = verified.data.flatMap(entry => entry.hooks).filter(hook => owned.some(h => h.key === hook.key));
    if (own.length !== owned.length || own.some(hook => !hook.enabled || hook.trustStatus !== 'trusted')) throw Error('auto_handoff_hook_not_ready');
    return owned.map(hook => hook.key);
  }, { executable, timeout_ms: 30_000 });
  const current = readAutoHandoffConfig();
  const projects = project ? [...new Set([...(current.enabled ? current.projects : []), project])] : [];
  const config = writeAutoHandoffConfig({ enabled: true, projects });
  return { status: 'enabled', config, hookKeys, host: 'desktop' };
}

export function enableClaudeAutoHandoff({ project = null, register = installClaudeAutoHandoffHooks } = {}) {
  const registration = register();
  const current = readClaudeAutoHandoffConfig();
  const projects = project ? [...new Set([...(current.enabled ? current.projects : []), project])] : [];
  const config = writeClaudeAutoHandoffConfig({ enabled: true, projects });
  return { status: 'enabled', config, hooks: { ...registration, registered: true }, host: 'claude' };
}

async function runClaude(parsed) {
  if (parsed.action === 'enable') return enableClaudeAutoHandoff({ project: parsed.project });
  if (parsed.action === 'disable') {
    const config = writeClaudeAutoHandoffConfig({ ...readClaudeAutoHandoffConfig(), enabled: false });
    // PreToolUse は道具の呼び出しのたびに走る。使わない間は置いたままにしない。
    removeClaudeAutoHandoffHooks();
    return { status: 'disabled', host: 'claude', config };
  }
  if (parsed.action === 'worker') return publicClaudeAutoHandoff(await runClaudeAutoHandoffWorker(parsed.operation, { openDb: getDb }));
  if (parsed.action === 'desktop-open') return publicClaudeAutoHandoff(await runClaudeDesktopOpen(parsed.operation));
  const handoffs = listClaudeAutoHandoffs()
    .filter(record => !parsed.project || sameProjectPath(record.project_path, parsed.project))
    .filter(record => !parsed.operation || record.handoff_id === parsed.operation || record.source_session_id === parsed.operation)
    .map(publicClaudeAutoHandoff);
  return { host: 'claude', config: readClaudeAutoHandoffConfig(),
    hooks: { registered: claudeAutoHandoffHooksRegistered() }, handoffs };
}

export function publicOperation(operation) {
  if (!operation) return null;
  const { handoff_id, source_thread_id, source_turn_id, target_thread_id, delivery_id,
    queued_submission_id, started_turn_id, state, previous_handoff_id, resume_state, error_code,
    mutation_stage, created_at, updated_at } = operation;
  return { handoff_id, source_thread_id, source_turn_id, target_thread_id, delivery_id,
    queued_submission_id, started_turn_id, state, previous_handoff_id, resume_state, error_code,
    mutation_stage, created_at, updated_at };
}

export async function run(args = []) {
  try {
    const parsed = parseAutoHandoffArgs(args);
    let result;
    if (parsed.host === 'claude') {
      result = await runClaude(parsed);
      if (parsed.json) process.stdout.write(JSON.stringify(result) + '\n');
      else if (parsed.action === 'status') {
        process.stdout.write(`自動継続: ${result.config.enabled ? '有効' : '無効'}（Claude Code）\n`);
        process.stdout.write(`hook（PreCompact・PreToolUse）: ${result.hooks.registered ? '登録済み' : '未登録'}\n`);
        for (const item of result.handoffs) process.stdout.write(`${item.handoff_id}  ${item.state}  ${item.error_code ?? ''}\n`);
      } else process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      return result.state === 'failed' || result.state === 'unknown' ? 1 : 0;
    }
    if (parsed.action === 'enable') result = await enableAutoHandoff({ project: parsed.project });
    else if (parsed.action === 'disable') result = { status: 'disabled', config: writeAutoHandoffConfig({ ...readAutoHandoffConfig(), enabled: false }) };
    else if (parsed.action === 'detail') {
      const db = parsed.database ? openReadOnlyDb(parsed.database) : openReadOnlyDb();
      let text;
      try { text = renderFrozenDetail(db, { operationId: parsed.operation, originSessionId: parsed.origin, turnNumber: parsed.turn }); }
      finally { db.close(); }
      process.stdout.write(parsed.json ? JSON.stringify({ status: 'ok', text }) + '\n' : text + '\n');
      return 0;
    } else if (parsed.action === 'mark-sources') {
      // 印を付けない版（0.16.9 まで）が引き継いだ旧タスクへ、引き継ぎ済みの印を付け直す。何度流しても同じ結果になる。
      const db = getDb();
      result = { status: 'ok', ...await markAutoHandoffSources(db) };
    } else if (parsed.action === 'worker') {
      result = publicOperation(await runAutoHandoffWorker(parsed.operation));
    } else if (parsed.action === 'resume') {
      result = publicOperation(await runAutoHandoffWorker(parsed.operation, { resume: true }));
    } else {
      const db = existsSync(DB_PATH) ? openReadOnlyDb() : null;
      try {
        if (db && db.prepare('PRAGMA user_version').get().user_version !== CURRENT_VERSION) throw Error('auto_handoff_schema_mismatch');
        result = { config: readAutoHandoffConfig(), operations: parsed.operation
          ? db ? [publicOperation(getAutoHandoff(db, parsed.operation))].filter(Boolean) : []
          : db ? listAutoHandoffs(db, { projectPath: parsed.project }).map(publicOperation) : [],
          databaseStatus: db ? 'current' : 'not_applicable' };
      } finally { db?.close(); }
    }
    if (parsed.json) process.stdout.write(JSON.stringify(result) + '\n');
    else if (parsed.action === 'status') {
      process.stdout.write(`自動継続: ${result.config.enabled ? '有効' : '無効'}（Codex Desktop）\n`);
      for (const item of result.operations) process.stdout.write(`${item.handoff_id}  ${item.state}  ${item.error_code ?? ''}\n`);
    } else process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return result.state === 'failed' || result.state === 'unknown' ? 1 : 0;
  } catch (error) {
    const code = typeof error.code === 'string' ? error.code : error.delivery_code ?? error.message;
    if (args.includes('--json')) process.stdout.write(JSON.stringify({ status: 'failed', code }) + '\n');
    else process.stderr.write(`Throughline自動継続: ${code}\n`);
    return 1;
  }
}
