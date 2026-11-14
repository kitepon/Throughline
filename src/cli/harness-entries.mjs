/** cli/harness-entries.mjs — `throughline harness-entries --json [--home <dir>]` (ADR 0074). */
import { isAbsolute } from 'node:path';
import { harnessEntries } from './install.mjs';

export function parseArgs(argv = []) {
  let json = false;
  let home;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--json' && !json) json = true;
    else if (argv[index] === '--home' && home === undefined && isAbsolute(argv[index + 1] ?? '')) home = argv[++index];
    else throw new TypeError('usage error');
  }
  if (!json) throw new TypeError('usage error');
  return { home };
}

export function run(argv = [], { stdout = process.stdout } = {}) {
  let options;
  try {
    options = parseArgs(argv);
  } catch {
    stdout.write(`${JSON.stringify({ schema: 'bellteam.harness-entries.v1', status: 'invalid_request',
      message: 'usage: throughline harness-entries --json [--home <absolute-dir>]' })}\n`);
    return 2;
  }
  stdout.write(`${JSON.stringify(harnessEntries(options.home ? { home: options.home } : {}))}\n`);
  return 0;
}
