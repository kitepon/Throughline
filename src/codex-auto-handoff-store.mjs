import { randomUUID } from 'node:crypto';

const JSON_FIELDS = ['settings_json', 'snapshot_json', 'runtime_json', 'worker_identity_json'];
const MUTABLE_FIELDS = new Set([
  'state', 'settings_json', 'snapshot_json', 'runtime_json', 'target_thread_id',
  'queued_submission_id', 'started_turn_id', 'mutation_stage', 'worker_identity_json', 'resume_state', 'error_code',
]);
export const HANDOFF_TERMINAL_STATES = new Set(['continued', 'failed', 'unknown']);

function decode(row) {
  if (!row) return null;
  const result = { ...row };
  for (const field of JSON_FIELDS) result[field.slice(0, -5)] = row[field] == null ? null : JSON.parse(row[field]);
  return result;
}

export function getAutoHandoff(db, id) {
  return decode(db.prepare('SELECT * FROM codex_handoffs WHERE handoff_id = ?').get(id));
}

export function findAutoHandoffForTarget(db, threadId) {
  return decode(db.prepare('SELECT * FROM codex_handoffs WHERE target_thread_id = ?').get(threadId));
}

export function findAutoHandoffForTurn(db, threadId, turnId) {
  return decode(db.prepare('SELECT * FROM codex_handoffs WHERE source_thread_id = ? AND source_turn_id = ?')
    .get(threadId, turnId));
}

/**
 * 継続の指示が後継へ届いた、または届いたかもしれない引き継ぎ（新しい順）。後継が作業を持っているので、
 * 同じ旧タスクから別の後継を立てない。配送の前に失敗した引き継ぎは入れない。
 */
export function listDeliveredAutoHandoffsForSource(db, threadId) {
  return db.prepare(`SELECT * FROM codex_handoffs WHERE source_thread_id = ? AND target_thread_id IS NOT NULL
    AND (queued_submission_id IS NOT NULL OR state IN ('submitted', 'continued') OR mutation_stage = 'submit')
    ORDER BY created_at DESC`).all(threadId).map(decode);
}

export function listAutoHandoffs(db, { projectPath = null, limit = 20 } = {}) {
  const rows = projectPath == null
    ? db.prepare('SELECT * FROM codex_handoffs ORDER BY created_at DESC LIMIT ?').all(limit)
    : db.prepare('SELECT * FROM codex_handoffs WHERE project_path = ? ORDER BY created_at DESC LIMIT ?').all(projectPath, limit);
  return rows.map(decode);
}

export function requestAutoHandoff(db, input) {
  const now = input.now ?? Date.now();
  const id = input.id ?? randomUUID();
  const previous = findAutoHandoffForTarget(db, input.threadId);
  const inserted = db.prepare(`INSERT INTO codex_handoffs
    (handoff_id, source_thread_id, source_turn_id, source_session_id, project_path,
     rollout_path, codex_home, open_host, previous_handoff_id, delivery_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_thread_id, source_turn_id) DO NOTHING`)
    .run(id, input.threadId, input.turnId, `codex:${input.threadId}`, input.projectPath,
      input.rolloutPath, input.codexHome, input.openHost, previous?.handoff_id ?? null,
      input.deliveryId ?? randomUUID(), now, now).changes === 1;
  const row = db.prepare('SELECT * FROM codex_handoffs WHERE source_thread_id = ? AND source_turn_id = ?')
    .get(input.threadId, input.turnId);
  return { operation: decode(row), inserted };
}

export function updateAutoHandoff(db, id, fields, { expectedState = null, now = Date.now() } = {}) {
  if (Object.hasOwn(fields, 'snapshot_json')) {
    const existing = db.prepare('SELECT snapshot_json FROM codex_handoffs WHERE handoff_id = ?').get(id)?.snapshot_json;
    if (existing != null && existing !== JSON.stringify(fields.snapshot_json)) throw new Error('handoff_snapshot_immutable');
  }
  const entries = Object.entries(fields).map(([key, value]) => {
    if (!MUTABLE_FIELDS.has(key)) throw new TypeError(`引き継ぎの更新fieldが不正です: ${key}`);
    return [key, JSON_FIELDS.includes(key) && value != null ? JSON.stringify(value) : value];
  });
  const columns = [...entries.map(([key]) => `${key} = ?`), 'updated_at = ?'];
  const values = [...entries.map(([, value]) => value), now, id];
  const condition = expectedState == null ? '' : ' AND state = ?';
  if (expectedState != null) values.push(expectedState);
  const changed = db.prepare(`UPDATE codex_handoffs SET ${columns.join(', ')} WHERE handoff_id = ?${condition}`)
    .run(...values).changes;
  return { changed: changed === 1, operation: getAutoHandoff(db, id) };
}

export function failAutoHandoff(db, id, code, { unknown = false } = {}) {
  const state = unknown ? 'unknown' : 'failed';
  const changed = db.prepare(`UPDATE codex_handoffs SET resume_state = state, state = ?, error_code = ?,
    worker_identity_json = NULL, updated_at = ?
    WHERE handoff_id = ? AND state NOT IN ('failed', 'unknown', 'continued')`)
    .run(state, code, Date.now(), id).changes;
  return { changed: changed === 1, operation: getAutoHandoff(db, id) };
}

export function claimAutoHandoff(db, id, identity, processes) {
  const operation = getAutoHandoff(db, id);
  if (!operation) throw new Error('handoff_not_found');
  const previous = operation.worker_identity;
  if (previous && processes.some(p => p.pid === previous.pid && p.started_identity === previous.started_identity)) {
    return false;
  }
  const previousJson = operation.worker_identity_json;
  return db.prepare(`UPDATE codex_handoffs SET worker_identity_json = ?, updated_at = ?
    WHERE handoff_id = ? AND worker_identity_json IS ?`)
    .run(JSON.stringify(identity), Date.now(), id, previousJson).changes === 1;
}

export function releaseAutoHandoff(db, id, identity) {
  db.prepare('UPDATE codex_handoffs SET worker_identity_json = NULL WHERE handoff_id = ? AND worker_identity_json = ?')
    .run(id, JSON.stringify(identity));
}

export function freezeCodexMemory(db, operation, settings, source) {
  const session = db.prepare('SELECT session_id, project_path FROM sessions WHERE session_id = ?')
    .get(operation.source_session_id);
  if (!session || session.project_path !== operation.project_path) throw new Error('handoff_memory_source_mismatch');
  const load = table => db.prepare(`SELECT * FROM ${table} WHERE session_id = ? ORDER BY created_at, id`)
    .all(operation.source_session_id);
  const bodies = load('bodies'), skeletons = load('skeletons'), details = load('details');
  return {
    version: 1, session: { ...session }, settings,
    sourceTurnId: operation.source_turn_id,
    sourceTurnNumber: Math.max(0, ...bodies.map(row => row.turn_number), ...details.map(row => row.turn_number ?? 0)),
    stoppedAt: source.stoppedAt,
    bodies, skeletons, details,
  };
}

export function loadFrozenLineage(db, operation) {
  const lineage = [];
  let current = operation;
  const seen = new Set();
  while (current) {
    if (seen.has(current.handoff_id)) throw new Error('handoff_lineage_invalid');
    seen.add(current.handoff_id);
    if (!current.snapshot || current.snapshot.version !== 1) throw new Error('handoff_snapshot_unavailable');
    if (current.project_path !== operation.project_path) throw new Error('handoff_lineage_project_mismatch');
    lineage.push({ operation: current, snapshot: current.snapshot });
    current = current.previous_handoff_id ? getAutoHandoff(db, current.previous_handoff_id) : null;
    if (lineage.at(-1).operation.previous_handoff_id && !current) throw new Error('handoff_lineage_missing');
  }
  return lineage.reverse();
}

export function continuationInput(operation) {
  return `Throughline自動継続 ${operation.handoff_id} / ${operation.delivery_id}\n` +
    '注入された記憶と元のユーザー依頼に従い、未完了の作業をそのまま継続してください。' +
    '直前の実行結果を確認し、完了済みの操作を重複実行しないでください。';
}
