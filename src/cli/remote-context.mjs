import { HANDOFF_CONTEXT_SCHEMA } from './handoff-context.mjs';
import { ingestRemoteTranscript, readRemoteHandoffContext, REMOTE_INGEST_SCHEMA } from '../remote-ingest.mjs';

export async function run(command, argv, { stdin = process.stdin, stdout = process.stdout, stderr = process.stderr } = {}) {
  const ingest = command === 'remote-ingest';
  const schema = ingest ? REMOTE_INGEST_SCHEMA : HANDOFF_CONTEXT_SCHEMA;
  try {
    if (ingest) {
      if (argv.length !== 1 || argv[0] !== '--json') throw new TypeError('E_REMOTE_INPUT');
      let body = '';
      stdin.setEncoding('utf8');
      for await (const chunk of stdin) body += chunk;
      let input;
      try { input = JSON.parse(body); }
      catch { throw new TypeError('E_REMOTE_INPUT'); }
      const result = ingestRemoteTranscript(input);
      stdout.write(`${JSON.stringify({ schema, status: 'ready', ...result })}\n`);
    } else {
      if (argv.length !== 3 || argv[0] !== '--bot' || argv[2] !== '--json') throw new TypeError('E_REMOTE_INPUT');
      const result = readRemoteHandoffContext(argv[1]);
      stdout.write(`${JSON.stringify({ schema, status: result?.context ? 'ready' : 'empty',
        sessionId: result?.sessionId ?? null, context: result?.context ?? '', sessions: result?.sessions ?? [] })}\n`);
    }
    return 0;
  } catch (error) {
    const code = error instanceof TypeError ? 'E_REMOTE_INPUT'
      : ['E_REMOTE_GAP', 'E_REMOTE_CONFLICT'].includes(error.code) ? error.code : 'E_REMOTE_STORE';
    stderr.write(`${JSON.stringify({ schema, status: 'error', code,
      ...(error.expectedCursor ? { expectedCursor: error.expectedCursor } : {}) })}\n`);
    return 1;
  }
}
