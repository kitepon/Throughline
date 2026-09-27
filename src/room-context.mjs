import { isAbsolute } from 'node:path';

import { getDb } from './db.mjs';

export const ROOM_CONTEXT_SCHEMA = 'throughline.room_context.v1';

export function recordRoomTurn({ projectPath, roomId, messageId, speaker, text, db = getDb() }) {
  if (typeof projectPath !== 'string' || !isAbsolute(projectPath) ||
      typeof roomId !== 'string' || !roomId ||
      typeof messageId !== 'string' || !messageId ||
      typeof speaker !== 'string' || !speaker ||
      typeof text !== 'string') throw new TypeError('ROOM_CONTEXT_INPUT_INVALID');

  db.exec('BEGIN IMMEDIATE');
  try {
    let current = db.prepare(`SELECT rowid, speaker, text FROM room_turns
      WHERE project_path = ? AND room_id = ? AND message_id = ?`)
      .get(projectPath, roomId, messageId);
    if (current && (current.speaker !== speaker || current.text !== text)) {
      throw new Error('ROOM_CONTEXT_MESSAGE_CONFLICT');
    }
    if (!current) {
      db.prepare(`INSERT INTO room_turns (project_path, room_id, message_id, speaker, text)
        VALUES (?, ?, ?, ?, ?)`).run(projectPath, roomId, messageId, speaker, text);
      current = db.prepare(`SELECT rowid FROM room_turns
        WHERE project_path = ? AND room_id = ? AND message_id = ?`)
        .get(projectPath, roomId, messageId);
    }
    const turns = db.prepare(`SELECT message_id AS messageId, speaker, text FROM room_turns
      WHERE project_path = ? AND room_id = ? AND rowid <= ?
      ORDER BY rowid DESC LIMIT 3`)
      .all(projectPath, roomId, current.rowid).reverse();
    db.exec('COMMIT');
    return { schema: ROOM_CONTEXT_SCHEMA, status: 'ready', roomId, turns };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
