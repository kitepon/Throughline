/**
 * Read-only fork の印 (schema v13)。NULL の session_kind は main。
 * 正本: docs/architecture/fork-session-isolation.md
 */

/** @param {import('node:sqlite').DatabaseSync} db */
function hasSessionKind(db) {
  // read-only open は移行しないので、旧 DB には列が無い。その時は全行 main。
  return db.prepare('PRAGMA table_info(sessions)').all().some((c) => c.name === 'session_kind');
}

/**
 * 自動選択の WHERE に足す断片。列の無い DB では空。
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function mainSessionFilter(db) {
  return hasSessionKind(db) ? 'AND session_kind IS NULL' : '';
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} sessionId
 * @returns {{ kind: 'fork', forkId: string | null, parentSessionId: string | null } | null} main なら null
 */
export function readSessionKind(db, sessionId) {
  if (!hasSessionKind(db)) return null;
  const row = db
    .prepare('SELECT session_kind, fork_id, fork_parent_session_id FROM sessions WHERE session_id = ?')
    .get(sessionId);
  if (row?.session_kind !== 'fork') return null;
  return { kind: 'fork', forkId: row.fork_id ?? null, parentSessionId: row.fork_parent_session_id ?? null };
}

export function isForkSession(db, sessionId) {
  return readSessionKind(db, sessionId) !== null;
}

/**
 * Aiterm 0.70.6 が fork の席の process 環境へ渡す印。普通の席には無い。resume した fork も持ち続ける。
 * @param {Record<string, string | undefined>} env
 * @returns {{ forkId: string | null, parentSessionId: string | null } | null} fork でなければ null
 */
export function forkIdentityFromEnv(env) {
  if (env?.THROUGHLINE_SESSION_KIND !== 'fork') return null;
  return { forkId: env.THROUGHLINE_FORK_ID || null, parentSessionId: env.THROUGHLINE_PARENT_SESSION_ID || null };
}

/**
 * 起動元が権威をもって渡した fork の印を session 行へ残す。印は消さない (後の capture も fork のまま)。
 * main として本文を持つ行には付けない: 取り違えると main の記憶が自動の記憶から消える。
 * 各入口は本文を書く前に呼ぶので、初回の fork 行には本文が無い。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} sessionId
 * @param {{ forkId: string | null, parentSessionId: string | null }} identity
 * @returns {'marked' | 'main_records_exist' | 'session_missing'}
 */
export function markForkSession(db, sessionId, { forkId = null, parentSessionId = null } = {}) {
  const changed = db
    .prepare(
      `UPDATE sessions SET session_kind = 'fork', fork_id = ?, fork_parent_session_id = ?
       WHERE session_id = ?
         AND (session_kind = 'fork' OR NOT EXISTS (SELECT 1 FROM bodies WHERE session_id = ?))`,
    )
    .run(forkId, parentSessionId, sessionId, sessionId).changes;
  if (changed > 0) return 'marked';
  return db.prepare('SELECT 1 FROM sessions WHERE session_id = ?').get(sessionId) ? 'main_records_exist' : 'session_missing';
}

/**
 * 入口共通: 環境が fork を示す時だけ、行を確保して印を付ける。
 * @returns {null | 'marked' | 'main_records_exist' | 'session_missing'} fork でなければ null
 */
export function markForkSessionFromEnv(db, sessionId, projectPath, env, now = Date.now()) {
  const identity = forkIdentityFromEnv(env);
  if (!identity) return null;
  db.prepare(
    `INSERT OR IGNORE INTO sessions (session_id, project_path, status, created_at, updated_at)
     VALUES (?, ?, 'active', ?, ?)`,
  ).run(sessionId, projectPath, now, now);
  return markForkSession(db, sessionId, identity);
}
