import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

import { normalizeProjectPathForCompare, sameProjectPath } from '../project-path.mjs';
import { openReadOnlyDb } from '../db.mjs';
import {
  buildBudgetedResumeContext,
  buildRecentSessionsContext,
  INJECTION_BUDGET_CHARS,
} from '../resume-context.mjs';

export const HANDOFF_CONTEXT_SCHEMA = 'throughline.handoff_context.v1';
export const HANDOFF_SUPPLEMENT_SCHEMA = 'throughline.handoff_supplement.v1';

export function parseArgs(argv = []) {
  if (
    (argv[0] !== '--session' && argv[0] !== '--project') ||
    typeof argv[1] !== 'string' ||
    argv[1].length === 0 ||
    argv[2] !== '--json' ||
    argv.length % 2 === 0
  ) {
    throw new TypeError('usage error');
  }

  let supplementFile = null;
  let handoffDisclosure = 'visible';
  let projectSessions = 'latest';
  const seen = new Set();
  for (let index = 3; index < argv.length; index += 2) {
    const option = argv[index];
    const value = argv[index + 1];
    if (
      seen.has(option) ||
      typeof value !== 'string' ||
      value.length === 0
    ) {
      throw new TypeError('usage error');
    }
    seen.add(option);
    if (option === '--supplement-file') {
      supplementFile = value;
    } else if (option === '--disclosure' && ['visible', 'silent'].includes(value)) {
      handoffDisclosure = value;
    } else if (option === '--sessions' && ['latest', 'recent'].includes(value)) {
      projectSessions = value;
    } else {
      throw new TypeError('usage error');
    }
  }
  if (
    (argv[0] === '--project' && supplementFile) ||
    (argv[0] === '--session' && seen.has('--sessions')) ||
    (supplementFile && seen.has('--disclosure'))
  ) {
    throw new TypeError('usage error');
  }

  return {
    sessionId: argv[0] === '--session' ? argv[1] : null,
    projectPath: argv[0] === '--project' ? resolve(argv[1]) : null,
    supplementFile,
    handoffDisclosure,
    projectSessions,
  };
}

export function renderHandoffSupplement(value, projectPath) {
  if (
    value?.schema !== HANDOFF_SUPPLEMENT_SCHEMA ||
    !isAbsolute(value.projectPath) ||
    !sameProjectPath(value.projectPath, projectPath) ||
    (value.handoffDisclosure !== undefined &&
      !['visible', 'silent'].includes(value.handoffDisclosure)) ||
    !Array.isArray(value.sections) ||
    value.sections.length === 0
  ) {
    throw new TypeError('invalid handoff supplement');
  }

  const sections = value.sections.map((section) => {
    if (
      typeof section?.title !== 'string' || section.title.length === 0 ||
      typeof section?.content !== 'string' || section.content.length === 0
    ) {
      throw new TypeError('invalid handoff supplement section');
    }
    return `### ${section.title}\n${section.content}`;
  });
  return ['## このBotの長期記憶と関連知識', ...sections].join('\n\n');
}

export function readHandoffContext(sessionId, {
  dbPath = join(homedir(), '.throughline', 'throughline.db'),
  supplementFile = null,
  handoffDisclosure = 'visible',
} = {}) {
  if (!existsSync(dbPath)) return null;

  const db = openReadOnlyDb(dbPath);
  try {
    let supplementContext = null;
    let resolvedHandoffDisclosure = handoffDisclosure;
    if (supplementFile) {
      const row = db.prepare(
        'SELECT project_path FROM sessions WHERE session_id = ?',
      ).get(sessionId);
      if (!row?.project_path) return null;
      const supplement = JSON.parse(readFileSync(supplementFile, 'utf8'));
      supplementContext = renderHandoffSupplement(supplement, row.project_path);
      resolvedHandoffDisclosure = supplement.handoffDisclosure ?? handoffDisclosure;
    }

    const separator = supplementContext ? '\n\n' : '';
    const context = buildBudgetedResumeContext(db, {
      sessionId,
      isInheritance: true,
      handoffDisclosure: resolvedHandoffDisclosure,
      maxChars: INJECTION_BUDGET_CHARS - (supplementContext?.length ?? 0) - separator.length,
    })?.text ?? null;
    if (!context && !supplementContext) return null;

    const combined = supplementContext && context
      ? `${supplementContext}${separator}${context}`
      : supplementContext ?? context;
    if (combined.length > INJECTION_BUDGET_CHARS) {
      throw new RangeError('handoff context exceeds injection budget');
    }
    return combined;
  } finally {
    db.close();
  }
}

export function readLatestProjectHandoffContext(projectPath, {
  dbPath = join(homedir(), '.throughline', 'throughline.db'),
  handoffDisclosure = 'visible',
} = {}) {
  if (!existsSync(dbPath)) return null;

  const db = openReadOnlyDb(dbPath);
  try {
    const sessions = db.prepare(
      `SELECT session_id, project_path
       FROM sessions
       ORDER BY updated_at DESC`,
    ).all();
    for (const session of sessions) {
      if (!sameProjectPath(session.project_path, projectPath)) continue;
      const context = buildBudgetedResumeContext(db, {
        sessionId: session.session_id,
        isInheritance: true,
        handoffDisclosure,
      })?.text ?? null;
      if (context) return { sessionId: session.session_id, context };
    }
    return null;
  } finally {
    db.close();
  }
}

/**
 * 同じ project の直近の会話をまたいだ文脈 (`--project <path> --sessions recent`、ADR 0034)。
 * 現在の会話は readLatestProjectHandoffContext と同じ session を選ぶ。
 */
export function readRecentProjectHandoffContext(projectPath, {
  dbPath = join(homedir(), '.throughline', 'throughline.db'),
  handoffDisclosure = 'visible',
} = {}) {
  if (!existsSync(dbPath)) return null;

  const db = openReadOnlyDb(dbPath);
  try {
    const target = normalizeProjectPathForCompare(projectPath);
    const sameProject = new Map();
    const sessionIds = [];
    const sessions = db.prepare(
      `SELECT session_id, project_path
       FROM sessions
       ORDER BY updated_at DESC`,
    ).all();
    for (const session of sessions) {
      let same = sameProject.get(session.project_path);
      if (same === undefined) {
        same = normalizeProjectPathForCompare(session.project_path) === target;
        sameProject.set(session.project_path, same);
      }
      if (same) sessionIds.push(session.session_id);
    }
    const result = buildRecentSessionsContext(db, { sessionIds, handoffDisclosure });
    return result
      ? { sessionId: result.sessionId, context: result.text, sessions: result.sessions }
      : null;
  } finally {
    db.close();
  }
}

export function readSessionProjectPath(sessionId, {
  dbPath = join(homedir(), '.throughline', 'throughline.db'),
} = {}) {
  if (!existsSync(dbPath)) return null;

  const db = openReadOnlyDb(dbPath);
  try {
    const row = db.prepare(
      'SELECT project_path FROM sessions WHERE session_id = ?',
    ).get(sessionId);
    const projectPath = row?.project_path;
    return typeof projectPath === 'string' && projectPath.length > 0
      ? projectPath
      : null;
  } finally {
    db.close();
  }
}

export function run(argv = [], {
  stdout = process.stdout,
  stderr = process.stderr,
  readContext = readHandoffContext,
  readProjectContext = readLatestProjectHandoffContext,
  readRecentProjectContext = readRecentProjectHandoffContext,
} = {}) {
  let sessionId;
  let projectPath;
  let supplementFile;
  let handoffDisclosure;
  let projectSessions;
  try {
    ({ sessionId, projectPath, supplementFile, handoffDisclosure, projectSessions } = parseArgs(argv));
  } catch {
    stderr.write(
      'Usage: throughline handoff-context (--session <id> | --project <path>) --json [--disclosure visible|silent | --supplement-file <path>] [--sessions latest|recent]\n',
    );
    return 2;
  }

  // `sessions` は `--sessions recent` の時だけ足す。付けない時の出力は変えない。
  const recent = Boolean(projectPath) && projectSessions === 'recent';
  let result;
  try {
    if (recent) result = readRecentProjectContext(projectPath, { handoffDisclosure });
    else if (projectPath) result = readProjectContext(projectPath, { handoffDisclosure });
    else {
      result = {
        sessionId,
        context: readContext(sessionId, { supplementFile, handoffDisclosure }),
      };
    }
  } catch {
    stderr.write('Throughline handoff context could not be read.\n');
    return 1;
  }
  if (!result?.context && projectPath) {
    stdout.write(`${JSON.stringify({
      schema: HANDOFF_CONTEXT_SCHEMA,
      status: 'empty',
      sessionId: null,
      context: '',
      ...(recent ? { sessions: [] } : {}),
    })}\n`);
    return 0;
  }
  if (!result?.context) {
    stderr.write('Throughline handoff context is not available for that session.\n');
    return 1;
  }

  stdout.write(`${JSON.stringify({
    schema: HANDOFF_CONTEXT_SCHEMA,
    status: 'ready',
    sessionId: result.sessionId,
    context: result.context,
    ...(recent ? { sessions: result.sessions } : {}),
  })}\n`);
  return 0;
}
