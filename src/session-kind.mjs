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
 * 起動元が権威をもって渡した fork の印を session 行へ残す。印は消さない (後の capture も fork のまま)。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} sessionId
 * @param {{ forkId: string, parentSessionId: string }} identity
 * @returns {boolean} 行があって書けたら true
 */
export function markForkSession(db, sessionId, { forkId, parentSessionId }) {
  if (typeof forkId !== 'string' || forkId.length === 0 || typeof parentSessionId !== 'string' || parentSessionId.length === 0) {
    throw new TypeError('fork identity requires forkId and parentSessionId');
  }
  return db
    .prepare(
      `UPDATE sessions SET session_kind = 'fork', fork_id = ?, fork_parent_session_id = ?
       WHERE session_id = ?`,
    )
    .run(forkId, parentSessionId, sessionId).changes > 0;
}
