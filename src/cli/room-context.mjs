import { ROOM_CONTEXT_SCHEMA, recordRoomTurn } from '../room-context.mjs';

export async function run(argv = [], { stdin = process.stdin, stdout = process.stdout, stderr = process.stderr, record = recordRoomTurn } = {}) {
  if (argv.length !== 1 || argv[0] !== '--json') return fail(stderr, 'E_ROOM_CONTEXT_ARGS');
  let input;
  try {
    let body = '';
    for await (const chunk of stdin) body += chunk;
    input = JSON.parse(body);
  } catch {
    return fail(stderr, 'E_ROOM_CONTEXT_INPUT');
  }
  try {
    stdout.write(`${JSON.stringify(record(input))}\n`);
    return 0;
  } catch (error) {
    return fail(stderr, error instanceof TypeError ? 'E_ROOM_CONTEXT_INPUT' : 'E_ROOM_CONTEXT_RECORD');
  }
}

function fail(stream, code) {
  stream.write(`${JSON.stringify({ schema: ROOM_CONTEXT_SCHEMA, status: 'error', code })}\n`);
  return 1;
}
