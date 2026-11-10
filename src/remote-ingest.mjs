import { createHash } from 'node:crypto';
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { openDb } from './db.mjs';
import { readRecentProjectHandoffContext } from './cli/handoff-context.mjs';
import { groupTranscriptTurns, parseTranscript } from './transcript-reader.mjs';
import { markForkSession } from './session-kind.mjs';
import { applyAndVerifyWindowsAcl, createWindowsPrivateFile, isWindows, verifyWindowsAcl } from './os/windows-acl.mjs';

export const REMOTE_INGEST_SCHEMA = 'throughline.remote_ingest.v1';

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function identifier(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 256) {
    throw new TypeError('E_REMOTE_INPUT');
  }
  return value;
}

function locations(botId, home) {
  const directory = join(home, '.throughline', 'remote-transcripts');
  const key = digest(identifier(botId));
  return { directory, dbPath: join(directory, `${key}.sqlite`), projectPath: join(directory, key) };
}

function privateStore({ directory, dbPath }) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!lstatSync(directory).isDirectory()) throw new Error('E_REMOTE_STORE');
  if (isWindows()) applyAndVerifyWindowsAcl(directory, true);
  else chmodSync(directory, 0o700);
  if (isWindows()) createWindowsPrivateFile(dbPath);
  else {
    try { closeSync(openSync(dbPath, 'wx', 0o600)); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  const info = lstatSync(dbPath);
  if (!info.isFile() || info.nlink !== 1) throw new Error('E_REMOTE_STORE');
  if (isWindows()) verifyWindowsAcl(dbPath, false);
  else {
    if (info.uid !== process.getuid()) throw new Error('E_REMOTE_STORE');
    chmodSync(dbPath, 0o600);
  }
}

function rangeError(code, claudeSessionId, offset) {
  return Object.assign(new Error(code), { code, expectedCursor: { claudeSessionId, offset } });
}

/** Only the bound native provider may supply completed-prefix lines (C7). */
export function ingestRemoteTranscript(input, { home = homedir(), now = Date.now(), fork: forkArg = false } = {}) {
  if (!input || typeof input !== 'object') throw new TypeError('E_REMOTE_INPUT');
  const { botId, sessionName, launchId, claudeSessionId, entries, cursor, sessionKind, parentSessionId, forkId } = input;
  [botId, sessionName, claudeSessionId].forEach(identifier);
  // fork は CLI の `--fork` と本文の sessionKind:'fork' + parentSessionId がそろう時だけ。片方だけは断る。
  if (forkArg ? sessionKind !== 'fork' || parentSessionId === undefined
    : sessionKind !== undefined || parentSessionId !== undefined || forkId !== undefined) throw new TypeError('E_REMOTE_INPUT');
  [parentSessionId, forkId].forEach((value) => value === undefined || identifier(value));
  const fork = forkArg ? { parentSessionId, forkId: forkId ?? null } : null;
  if (typeof launchId !== 'string' || !/^[a-f0-9]{32}$/i.test(launchId) ||
      cursor?.claudeSessionId !== claudeSessionId || !Number.isSafeInteger(cursor?.offset) ||
      cursor.offset < 0 || !Array.isArray(entries)) throw new TypeError('E_REMOTE_INPUT');
  for (const line of entries) {
    if (typeof line !== 'string' || !line.endsWith('\n') || line.slice(0, -1).includes('\n') ||
        Buffer.from(line).toString('utf8') !== line) throw new TypeError('E_REMOTE_INPUT');
    try {
      const entry = JSON.parse(line);
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error();
    } catch { throw new TypeError('E_REMOTE_INPUT'); }
  }
  const incoming = Buffer.from(entries.join(''), 'utf8');
  const start = cursor.offset - incoming.length;
  if (start < 0) throw new TypeError('E_REMOTE_INPUT');
  const paths = locations(botId, home);
  privateStore(paths);
  const db = openDb(paths.dbPath);
  let active = false;
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS remote_transcripts (
      claude_session_id TEXT PRIMARY KEY, session_name TEXT NOT NULL,
      launch_id TEXT NOT NULL, source BLOB NOT NULL, offset INTEGER NOT NULL
    )`);
    db.exec('BEGIN IMMEDIATE');
    active = true;
    const stored = db.prepare('SELECT source, offset FROM remote_transcripts WHERE claude_session_id = ?').get(claudeSessionId);
    const source = stored ? Buffer.from(stored.source) : Buffer.alloc(0);
    const offset = stored?.offset ?? 0;
    if (source.length !== offset) throw new Error('E_REMOTE_STORE');
    if (start > offset) throw rangeError('E_REMOTE_GAP', claudeSessionId, offset);
    const overlap = Math.min(incoming.length, offset - start);
    if (!incoming.subarray(0, overlap).equals(source.subarray(start, start + overlap))) {
      throw rangeError('E_REMOTE_CONFLICT', claudeSessionId, offset);
    }
    if (cursor.offset > offset) {
      const combined = Buffer.concat([source, incoming.subarray(overlap)]);
      const groups = groupTranscriptTurns(parseTranscript(combined.toString('utf8')));
      const sessionId = `remote-claude-${digest(JSON.stringify([botId, claudeSessionId]))}`;
      db.prepare(`INSERT INTO sessions (session_id, project_path, created_at, updated_at)
        VALUES (?, ?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET updated_at = excluded.updated_at`)
        .run(sessionId, paths.projectPath, now, now);
      if (fork) markForkSession(db, sessionId, fork);
      const insert = db.prepare(`INSERT INTO bodies
        (session_id, origin_session_id, turn_number, role, text, token_count, created_at, turn_start)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id, origin_session_id, turn_number, role) DO UPDATE SET
          text = excluded.text, token_count = excluded.token_count,
          created_at = COALESCE(?, bodies.created_at), turn_start = excluded.turn_start`);
      for (const group of groups) {
        // The user line is stable when a byte page or a late flush extends its answer.
        const assistantAt = group.representative.timestamp ?? now;
        insert.run(sessionId, sessionId, group.user.turn_number, 'user', group.user.content,
          Math.round(group.user.content.length / 4), group.user.timestamp ?? assistantAt, group.user.start, group.user.timestamp);
        insert.run(sessionId, sessionId, group.user.turn_number, 'assistant', group.representative.content,
          Math.round(group.representative.content.length / 4), assistantAt, null, group.representative.timestamp);
      }
      db.prepare(`INSERT INTO remote_transcripts (claude_session_id, session_name, launch_id, source, offset)
        VALUES (?, ?, ?, ?, ?) ON CONFLICT(claude_session_id) DO UPDATE SET
          session_name = excluded.session_name, launch_id = excluded.launch_id,
          source = excluded.source, offset = excluded.offset`)
        .run(claudeSessionId, sessionName, launchId, combined, cursor.offset);
    }
    db.exec('COMMIT');
    active = false;
    return { ackedCursor: { claudeSessionId, offset: Math.max(offset, cursor.offset) } };
  } finally {
    try { if (active) db.exec('ROLLBACK'); }
    finally {
      db.close();
    }
  }
}

export function readRemoteHandoffContext(botId, { home = homedir() } = {}) {
  const paths = locations(botId, home);
  if (!existsSync(paths.dbPath)) return null;
  return readRecentProjectHandoffContext(paths.projectPath, {
    dbPath: paths.dbPath, handoffDisclosure: 'silent',
  });
}
