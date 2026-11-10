import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { openReadOnlyDb } from '../db.mjs';
import { mainSessionFilter } from '../session-kind.mjs';
import { sameProjectPath } from '../project-path.mjs';

export const LATEST_SESSION_SCHEMA = 'throughline.latest_session.v1';

export function parseArgs(argv = []) {
  if (
    argv.length !== 3 ||
    argv[0] !== '--project' ||
    typeof argv[1] !== 'string' ||
    argv[1].length === 0 ||
    argv[2] !== '--json'
  ) {
    throw new TypeError('usage error');
  }
  return { projectPath: resolve(argv[1]) };
}

export function findLatestSession(projectPath, {
  dbPath = join(homedir(), '.throughline', 'throughline.db'),
} = {}) {
  if (!existsSync(dbPath)) return null;

  const db = openReadOnlyDb(dbPath);
  try {
    const rows = db.prepare(
      `SELECT session_id, project_path, updated_at
       FROM sessions
       WHERE 1 = 1 ${mainSessionFilter(db)}
       ORDER BY updated_at DESC`,
    ).all();
    return rows.find((row) => sameProjectPath(row.project_path, projectPath)) ?? null;
  } finally {
    db.close();
  }
}

export function run(argv = [], {
  stdout = process.stdout,
  stderr = process.stderr,
  lookup = findLatestSession,
} = {}) {
  let projectPath;
  try {
    ({ projectPath } = parseArgs(argv));
  } catch {
    stderr.write('Usage: throughline latest-session --project <absolute-path> --json\n');
    return 2;
  }

  let session;
  try {
    session = lookup(projectPath);
  } catch {
    stderr.write('Throughline latest session could not be read.\n');
    return 1;
  }

  stdout.write(`${JSON.stringify({
    schema: LATEST_SESSION_SCHEMA,
    status: session ? 'ready' : 'empty',
    projectPath,
    sessionId: session?.session_id ?? null,
    updatedAt: session?.updated_at ?? null,
  })}\n`);
  return 0;
}
