import { readObserverTurnPage, OBSERVER_READ_SCHEMA, OBSERVER_READ_SCHEMA_V2, OBSERVER_READ_WIRES } from '../observer-turn-feed.mjs';

const ERRORS = Object.freeze({
  args: { schema: OBSERVER_READ_SCHEMA, status: 'error', code: 'E_OBSERVER_READ_ARGS', message: 'invalid observer-read arguments' },
  input: { schema: OBSERVER_READ_SCHEMA, status: 'error', code: 'E_OBSERVER_READ_INPUT', message: 'observer read input is invalid' },
  schema: { schema: OBSERVER_READ_SCHEMA, status: 'error', code: 'E_OBSERVER_READ_DB_SCHEMA', message: 'observer read database schema is unsupported' },
  project: { schema: OBSERVER_READ_SCHEMA, status: 'error', code: 'E_OBSERVER_READ_DB_PROJECT', message: 'observer read database project does not match' },
  io: { schema: OBSERVER_READ_SCHEMA, status: 'error', code: 'E_OBSERVER_READ_DB_IO', message: 'observer read database could not be read' },
  internal: { schema: OBSERVER_READ_SCHEMA, status: 'error', code: 'E_OBSERVER_READ_INTERNAL', message: 'observer read failed' },
});

export function parseArgs(argv = []) {
  const out = { projectPath: null, afterCursor: undefined, throughCursor: undefined, pageToken: undefined, limit: undefined, wire: 'v1', json: false };
  const seen = new Set();
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--json') {
      if (seen.has(arg)) throw new TypeError('duplicate option');
      seen.add(arg); out.json = true; continue;
    }
    if (!['--project', '--after-cursor', '--through-cursor', '--page-token', '--limit', '--wire'].includes(arg) || seen.has(arg)) {
      throw new TypeError('invalid option');
    }
    const value = argv[++index];
    if (!value || value.startsWith('-')) throw new TypeError('missing option value');
    seen.add(arg);
    if (arg === '--project') out.projectPath = value;
    else if (arg === '--after-cursor') out.afterCursor = value;
    else if (arg === '--through-cursor') out.throughCursor = value;
    else if (arg === '--page-token') out.pageToken = value;
    else if (arg === '--wire') out.wire = parseWire(value);
    else out.limit = parseLimit(value);
  }
  if (!out.json || !out.projectPath || (out.pageToken !== undefined && (out.afterCursor === undefined || out.throughCursor === undefined))) {
    throw new TypeError('missing required option');
  }
  return out;
}

export function run(argv = [], { read = readObserverTurnPage, stdout = process.stdout, stderr = process.stderr } = {}) {
  let args;
  try { args = parseArgs(argv); } catch { writeJson(stderr, ERRORS.args); return 1; }
  try {
    const result = read({
      ...(args.wire === 'v1' ? {} : { wire: args.wire }),
      projectPath: args.projectPath,
      ...(args.afterCursor === undefined ? {} : { afterCursor: args.afterCursor }),
      ...(args.throughCursor === undefined ? {} : { throughCursor: args.throughCursor }),
      ...(args.pageToken === undefined ? {} : { pageToken: args.pageToken }),
      ...(args.limit === undefined ? {} : { limit: args.limit }),
    });
    writeJson(stdout, result);
    return 0;
  } catch (error) {
    const mapped = mapError(error);
    writeJson(stderr, args.wire === 'v2' ? { ...mapped, schema: OBSERVER_READ_SCHEMA_V2 } : mapped);
    return 1;
  }
}

function parseWire(value) {
  if (!OBSERVER_READ_WIRES.includes(value)) throw new TypeError('invalid wire');
  return value;
}

function parseLimit(value) {
  if (!/^\d+$/.test(value)) throw new TypeError('invalid limit');
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new TypeError('invalid limit');
  return limit;
}

function mapError(error) {
  if (error?.code === 'E_AUDITOR_CONTEXT_SCHEMA') return ERRORS.schema;
  if (error?.code === 'E_AUDITOR_CONTEXT_PROJECT') return ERRORS.project;
  if (['E_AUDITOR_CONTEXT_DB_OPEN', 'E_AUDITOR_CONTEXT_QUERY'].includes(error?.code)) return ERRORS.io;
  if (error instanceof TypeError) return ERRORS.input;
  return ERRORS.internal;
}

function writeJson(stream, value) { stream.write(`${JSON.stringify(value)}\n`); }
