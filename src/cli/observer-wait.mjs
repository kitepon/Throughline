import { statSync } from 'node:fs';
import { installCancellation, OBSERVER_PARENT_WATCH_INTERVAL_MS } from '../observer-cancellation.mjs';
import { isAbsolute } from 'node:path';
import {
  OBSERVER_WAIT_SCHEMA,
  DEFAULT_OBSERVER_WAIT_TIMEOUT_SECONDS,
  waitForObserverTurnChange,
} from '../observer-turn-wait.mjs';

const ERRORS = Object.freeze({
  args: { schema: OBSERVER_WAIT_SCHEMA, status: 'error', code: 'E_OBSERVER_WAIT_ARGS', message: 'invalid observer-wait arguments' },
  input: { schema: OBSERVER_WAIT_SCHEMA, status: 'error', code: 'E_OBSERVER_WAIT_INPUT', message: 'observer wait input is invalid' },
  cancelled: { schema: OBSERVER_WAIT_SCHEMA, status: 'error', code: 'E_OBSERVER_WAIT_CANCELLED', message: 'observer wait was cancelled' },
  internal: { schema: OBSERVER_WAIT_SCHEMA, status: 'error', code: 'E_OBSERVER_WAIT_INTERNAL', message: 'observer wait failed' },
});
const PARENT_WATCH_INTERVAL_MS = OBSERVER_PARENT_WATCH_INTERVAL_MS;

export function parseArgs(argv = []) {
  const out = { projectPath: null, afterCursor: null, timeoutSeconds: DEFAULT_OBSERVER_WAIT_TIMEOUT_SECONDS, json: false };
  const seen = new Set();
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--json') {
      if (seen.has(arg)) throw new TypeError('duplicate option');
      seen.add(arg); out.json = true; continue;
    }
    if (!['--project', '--after-cursor', '--timeout-seconds'].includes(arg) || seen.has(arg)) {
      throw new TypeError('invalid option');
    }
    const value = argv[++index];
    if (!value || value.startsWith('-')) throw new TypeError('missing option value');
    seen.add(arg);
    if (arg === '--project') out.projectPath = value;
    else if (arg === '--after-cursor') out.afterCursor = value;
    else out.timeoutSeconds = parseTimeout(value);
  }
  if (!out.json || !out.projectPath || !out.afterCursor) throw new TypeError('missing required option');
  return out;
}

export async function run(argv = [], {
  wait = waitForObserverTurnChange,
  validateProject = assertProjectDirectory,
  stdout = process.stdout,
  stderr = process.stderr,
  processRef = process,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  parentWatchIntervalMs = PARENT_WATCH_INTERVAL_MS,
} = {}) {
  let args;
  try { args = parseArgs(argv); } catch { writeJson(stderr, ERRORS.args); return 1; }

  try { validateProject(args.projectPath); } catch { writeJson(stderr, ERRORS.input); return 1; }

  const controller = new AbortController();
  const cleanup = installCancellation({ controller, processRef, setIntervalFn, clearIntervalFn, parentWatchIntervalMs });
  try {
    const result = await wait({
      projectPath: args.projectPath,
      afterCursor: args.afterCursor,
      timeoutSeconds: args.timeoutSeconds,
      signal: controller.signal,
    });
    writeJson(stdout, result);
    return 0;
  } catch (error) {
    writeJson(stderr, mapError(error));
    return 1;
  } finally {
    cleanup();
  }
}

function parseTimeout(value) {
  if (!/^\d+$/.test(value)) throw new TypeError('invalid timeout');
  const timeout = Number(value);
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 3600) throw new TypeError('invalid timeout');
  return timeout;
}

function assertProjectDirectory(projectPath) {
  if (!isAbsolute(projectPath) || !statSync(projectPath).isDirectory()) {
    throw new TypeError('project must be an absolute existing directory');
  }
}


function mapError(error) {
  if (error?.code === 'E_OBSERVER_WAIT_CANCELLED') return ERRORS.cancelled;
  return ERRORS.internal;
}

function writeJson(stream, value) { stream.write(`${JSON.stringify(value)}\n`); }

export const _internal = { assertProjectDirectory, installCancellation, PARENT_WATCH_INTERVAL_MS };
