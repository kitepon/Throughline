import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';

import { defaultAuditorContextDbPath } from '../auditor-context.mjs';
import { buildFactoryDiagnostics } from '../factory-diagnostics.mjs';
import { findCodexThreadCandidate, defaultCodexHome } from '../codex-thread-index.mjs';
import { resolveCodexThreadIdentity } from '../codex-thread-identity.mjs';
import { CURRENT_VERSION, settleFirstRead } from '../db.mjs';
import { isEquivalentCodexHookCommand } from './install.mjs';
import { _internal as doctorInternal } from './doctor.mjs';

const require = createRequire(import.meta.url);
const PACKAGE_VERSION = require('../../package.json').version;
const REQUIRED_DATABASE_COLUMNS = {
  sessions: ['session_id', 'project_path', 'status', 'created_at', 'updated_at', 'merged_into'],
  skeletons: ['id', 'session_id', 'turn_number', 'role', 'summary', 'created_at', 'origin_session_id'],
  bodies: ['id', 'session_id', 'origin_session_id', 'turn_number', 'role', 'text', 'token_count', 'created_at'],
  details: ['id', 'session_id', 'turn_number', 'tool_name', 'input_text', 'output_text', 'token_count', 'created_at', 'origin_session_id', 'kind', 'source_id'],
  handoff_batons: ['project_path', 'session_id', 'created_at'],
  pending_handoffs: ['session_id', 'project_path', 'source', 'auto_predecessor_id', 'created_at'],
};
const REQUIRED_DATABASE_INDEXES = ['uq_skeletons_turn_v3', 'uq_details_source'];
const REQUIRED_INDEX_SHAPES = {
  uq_skeletons_turn_v3: {
    table: 'skeletons',
    columns: ['session_id', 'origin_session_id', 'turn_number', 'role'],
    partial: false,
  },
  uq_details_source: {
    table: 'details',
    columns: ['session_id', 'origin_session_id', 'source_id'],
    partial: true,
  },
};

export function parseArgs(argv = []) {
  if (argv.length !== 1 || argv[0] !== '--json') throw new TypeError('usage error');
  return { json: true };
}

export function inspectFactoryDatabase({
  dbPath = defaultAuditorContextDbPath(),
  threadId = null,
  projectPath = null,
} = {}) {
  if (!existsSync(dbPath)) {
    return databaseResult('not_applicable', null, false);
  }

  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    settleFirstRead(db);
    const schemaVersion = Number(db.prepare('PRAGMA user_version').get()?.user_version ?? 0);
    if (schemaVersion !== CURRENT_VERSION || !hasFactoryDatabaseShape(db)) {
      return databaseResult('not_ready', schemaVersion, false);
    }
    if (!threadId || typeof projectPath !== 'string' || projectPath.length === 0) {
      return databaseResult('ready', schemaVersion, false);
    }
    const sessionId = `codex:${threadId}`;
    const counts = db.prepare(
      `SELECT
        (SELECT COUNT(*) FROM skeletons WHERE session_id = :sessionId) AS l1,
        (SELECT COUNT(*) FROM bodies WHERE session_id = :sessionId) AS l2,
        (SELECT COUNT(*) FROM details WHERE session_id = :sessionId) AS l3
       WHERE EXISTS (
         SELECT 1 FROM sessions
         WHERE session_id = :sessionId AND lower(project_path) = lower(:projectPath)
       )`,
    ).get({ sessionId, projectPath });
    const handoffMemory = counts !== undefined &&
      Number(counts.l1 ?? 0) + Number(counts.l2 ?? 0) + Number(counts.l3 ?? 0) > 0;
    return databaseResult('ready', schemaVersion, handoffMemory);
  } catch {
    return databaseResult('unverified', null, false);
  } finally {
    db?.close();
  }
}

function databaseResult(status, schemaVersion, handoffMemory) {
  return {
    status,
    schemaVersion,
    supportedSchemaVersion: CURRENT_VERSION,
    handoffMemory,
  };
}

function hasFactoryDatabaseShape(db) {
  const tableInfo = {};
  for (const [table, requiredColumns] of Object.entries(REQUIRED_DATABASE_COLUMNS)) {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all();
    tableInfo[table] = new Map(rows.map((row) => [row.name, row]));
    const actual = new Set(tableInfo[table].keys());
    if (requiredColumns.some((column) => !actual.has(column))) return false;
  }
  if (tableInfo.sessions.get('session_id')?.pk !== 1 ||
    tableInfo.handoff_batons.get('project_path')?.pk !== 1) return false;
  for (const [table, columns] of Object.entries({
    sessions: ['project_path', 'status', 'created_at', 'updated_at'],
    handoff_batons: ['session_id', 'created_at'],
  })) {
    if (columns.some((column) => tableInfo[table].get(column)?.notnull !== 1)) return false;
  }

  for (const name of REQUIRED_DATABASE_INDEXES) {
    const expected = REQUIRED_INDEX_SHAPES[name];
    const index = db.prepare(`PRAGMA index_list(${expected.table})`).all()
      .find((row) => row.name === name);
    if (!index || index.unique !== 1 || Boolean(index.partial) !== expected.partial) return false;
    const columns = db.prepare(`PRAGMA index_info(${name})`).all().map((row) => row.name);
    if (columns.length !== expected.columns.length ||
      columns.some((column, indexPosition) => column !== expected.columns[indexPosition])) return false;
  }

  const bodiesUnique = db.prepare('PRAGMA index_list(bodies)').all().some((index) => {
    if (index.unique !== 1) return false;
    const columns = db.prepare(`PRAGMA index_info(${index.name})`).all().map((row) => row.name);
    return columns.join('\0') === ['session_id', 'origin_session_id', 'turn_number', 'role'].join('\0');
  });
  return bodiesUnique;
}

function eventStatus({ hooks, legacyHooks, featureEnabled, expectedCommand, timeout }) {
  if (hooks.length === 0) return featureEnabled ? 'not_ready' : 'not_applicable';
  if (!featureEnabled || legacyHooks.length > 0 || hooks.length !== 1) return 'not_ready';
  const hook = hooks[0];
  return hook.type === 'command' && isEquivalentCodexHookCommand(hook.command, expectedCommand) &&
    hook.timeout === timeout && hook.async === false ? 'ready' : 'not_ready';
}

export function inspectFactoryHooks({ codexHome = defaultCodexHome(), readHooks = doctorInternal.readCodexHookDiagnosis } = {}) {
  try {
    const diagnosis = readHooks(codexHome);
    if ((diagnosis.configExists && !diagnosis.configReadable) ||
      (diagnosis.hooksExists && !diagnosis.hooksReadable)) {
      return { status: 'unverified', reason: 'hook_configuration_unreadable', events: {} };
    }
    const events = {
      userPromptSubmit: eventStatus({
        hooks: diagnosis.managedPromptHooks,
        legacyHooks: diagnosis.legacyManagedPromptHooks,
        featureEnabled: diagnosis.featureEnabled,
        expectedCommand: diagnosis.expectedPromptCommand,
        timeout: 30,
      }),
      postToolUse: eventStatus({
        hooks: diagnosis.managedPostToolUseHooks,
        legacyHooks: diagnosis.legacyManagedPostToolUseHooks,
        featureEnabled: diagnosis.featureEnabled,
        expectedCommand: diagnosis.expectedPostToolUseCommand,
        timeout: 30,
      }),
      stop: eventStatus({
        hooks: diagnosis.managedStopHooks,
        legacyHooks: diagnosis.legacyManagedStopHooks,
        featureEnabled: diagnosis.featureEnabled,
        expectedCommand: diagnosis.expectedStopCommand,
        timeout: 300,
      }),
    };
    const values = Object.values(events);
    return {
      status: values.includes('not_ready')
        ? 'not_ready'
        : values.includes('unverified')
          ? 'unverified'
          : values.includes('ready')
            ? 'ready'
            : 'not_applicable',
      reason: 'hooks_inspected',
      events,
    };
  } catch {
    return { status: 'unverified', reason: 'hook_inspection_failed', events: {} };
  }
}

export function inspectFactoryThread({
  env = process.env,
  cwd = process.cwd(),
  codexHome = env.CODEX_HOME || defaultCodexHome(),
  resolveIdentity = resolveCodexThreadIdentity,
  findCandidate = findCodexThreadCandidate,
} = {}) {
  const identity = resolveIdentity({ codexThreadId: null }, env);
  if (!identity.codexThreadId) {
    return {
      status: 'not_applicable',
      reason: 'codex_thread_not_detected',
      rolloutAvailable: false,
      threadId: null,
    };
  }
  try {
    const candidate = findCandidate({
      threadId: identity.codexThreadId,
      codexHome,
      projectPath: cwd,
      requireProjectMatch: true,
    });
    return candidate
      ? { status: 'ready', reason: 'thread_and_rollout_detected', rolloutAvailable: true, threadId: identity.codexThreadId }
      : { status: 'not_ready', reason: 'rollout_not_found_for_project', rolloutAvailable: false, threadId: null };
  } catch {
    return { status: 'unverified', reason: 'rollout_inspection_failed', rolloutAvailable: false, threadId: identity.codexThreadId };
  }
}

export function collectFactoryDiagnostics({
  env = process.env,
  cwd = process.cwd(),
  version = PACKAGE_VERSION,
  inspectThread = inspectFactoryThread,
  inspectDatabase = inspectFactoryDatabase,
  inspectHooks = inspectFactoryHooks,
} = {}) {
  const thread = inspectThread({ env, cwd });
  const database = inspectDatabase({ threadId: thread.threadId ?? null, projectPath: cwd });
  const hooks = inspectHooks({ codexHome: env.CODEX_HOME || defaultCodexHome() });
  return buildFactoryDiagnostics({ version, database, hooks, thread });
}

export function run(argv = [], { stdout = process.stdout, ...dependencies } = {}) {
  try {
    parseArgs(argv);
  } catch {
    stdout.write(`${JSON.stringify({
      schema: 'throughline.native_factory_diagnostics.v1',
      version: PACKAGE_VERSION,
      overall: { status: 'unverified' },
      error: 'invalid_diagnostics_request',
    })}\n`);
    return 2;
  }
  try {
    stdout.write(`${JSON.stringify(collectFactoryDiagnostics(dependencies))}\n`);
    return 0;
  } catch {
    stdout.write(`${JSON.stringify({
      schema: 'throughline.native_factory_diagnostics.v1',
      version: PACKAGE_VERSION,
      overall: { status: 'unverified' },
      error: 'diagnostics_internal_error',
    })}\n`);
    return 1;
  }
}
