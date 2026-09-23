import { CAVEAT_CONTEXT_SCHEMA, readCaveatContext } from '../caveat-context.mjs';

export function parseArgs(argv = []) {
  const out = { sessionId: null, projectRoot: null, host: undefined, transcriptPath: undefined, dbPath: undefined, json: false };
  const seen = new Set();
  for (let index = 0; index < argv.length; index++) {
    const option = argv[index];
    if (seen.has(option)) throw new TypeError('duplicate option');
    seen.add(option);
    if (option === '--json') { out.json = true; continue; }
    if (!['--session', '--project', '--host', '--transcript', '--db'].includes(option)) throw new TypeError('unknown option');
    const value = argv[++index];
    if (!value || value.startsWith('-')) throw new TypeError('missing option value');
    if (option === '--session') out.sessionId = value;
    if (option === '--project') out.projectRoot = value;
    if (option === '--host') out.host = value;
    if (option === '--transcript') out.transcriptPath = value;
    if (option === '--db') out.dbPath = value;
  }
  if (!out.json || !out.sessionId || !out.projectRoot || Boolean(out.host) !== Boolean(out.transcriptPath) ||
    (out.host && !['claude', 'codex'].includes(out.host))) throw new TypeError('missing required option');
  return out;
}

export function run(argv = [], { read = readCaveatContext, stdout = process.stdout, stderr = process.stderr } = {}) {
  let args;
  try { args = parseArgs(argv); } catch {
    writeJson(stderr, { schema: CAVEAT_CONTEXT_SCHEMA, status: 'error', code: 'E_CAVEAT_CONTEXT_ARGS' });
    return 1;
  }
  try {
    writeJson(stdout, read({ sessionId: args.sessionId, projectRoot: args.projectRoot,
      dbPath: args.dbPath, host: args.host, transcriptPath: args.transcriptPath }));
    return 0;
  } catch {
    writeJson(stderr, { schema: CAVEAT_CONTEXT_SCHEMA, status: 'error', code: 'E_CAVEAT_CONTEXT_READ' });
    return 1;
  }
}

function writeJson(stream, value) { stream.write(`${JSON.stringify(value)}\n`); }
