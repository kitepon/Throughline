import { setImmediate as yieldTurn } from 'node:timers/promises';
import {
  checkObserverProjects, OBSERVER_CHECK_RESULT_SCHEMA, OBSERVER_CHECK_MAX_INPUT_BYTES,
  observerCheckError, assertObserverCheckActive,
} from '../observer-check.mjs';
import { installCancellation, OBSERVER_PARENT_WATCH_INTERVAL_MS } from '../observer-cancellation.mjs';

export function parseArgs(argv = []) {
  if (argv.length !== 1 || argv[0] !== '--json') throw observerCheckError('E_OBSERVER_CHECK_ARGS');
}

export async function run(argv = [], {
  check = checkObserverProjects, stdin = process.stdin, stdout = process.stdout, stderr = process.stderr,
  processRef = process, setIntervalFn = setInterval, clearIntervalFn = clearInterval,
  parentWatchIntervalMs = OBSERVER_PARENT_WATCH_INTERVAL_MS,
} = {}) {
  let cleanup = () => {};
  try {
    parseArgs(argv);
    const controller = new AbortController();
    cleanup = installCancellation({ controller, processRef, setIntervalFn, clearIntervalFn, parentWatchIntervalMs });
    const request = await readInput(stdin, controller.signal);
    const result = await check(request, { signal: controller.signal });
    await yieldTurn(); assertObserverCheckActive(controller.signal);
    await writeJson(stdout, result);
    return 0;
  } catch (error) {
    const code = ['E_OBSERVER_CHECK_ARGS', 'E_OBSERVER_CHECK_CANCELLED'].includes(error?.code)
      ? error.code : 'E_OBSERVER_CHECK_INTERNAL';
    try { await writeJson(stderr, { schema: OBSERVER_CHECK_RESULT_SCHEMA, status: 'error', code }); }
    catch { /* A closed error pipe cannot carry diagnostics; retain failure exit. */ }
    return 1;
  } finally { cleanup(); }
}

function readInput(stream, signal) {
  return new Promise((resolve, reject) => {
    const chunks = []; let bytes = 0;
    const cleanup = () => {
      stream.removeListener('data', onData); stream.removeListener('end', onEnd);
      stream.removeListener('error', onError); stream.removeListener('close', onClose);
      signal.removeEventListener('abort', onAbort);
    };
    const fail = (code) => { cleanup(); chunks.length = 0; stream.destroy(); reject(observerCheckError(code)); };
    const onData = (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > OBSERVER_CHECK_MAX_INPUT_BYTES) return fail('E_OBSERVER_CHECK_ARGS');
      chunks.push(buffer);
    };
    const onEnd = () => {
      cleanup();
      try { resolve(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))); }
      catch { reject(observerCheckError('E_OBSERVER_CHECK_ARGS')); }
    };
    const onError = () => fail('E_OBSERVER_CHECK_ARGS');
    const onClose = () => fail('E_OBSERVER_CHECK_ARGS');
    const onAbort = () => fail('E_OBSERVER_CHECK_CANCELLED');
    if (signal.aborted) return onAbort();
    if (stream.readableEnded || stream.destroyed) return onClose();
    stream.on('data', onData); stream.once('end', onEnd); stream.once('error', onError); stream.once('close', onClose);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function writeJson(stream, value) {
  return new Promise((resolve, reject) => {
    if (stream.destroyed || stream.writableEnded) return reject(new Error('observer check output closed'));
    const cleanup = () => { stream.removeListener('error', onError); stream.removeListener('close', onClose); };
    const onError = (error) => { cleanup(); reject(error); };
    const onClose = () => onError(new Error('observer check output closed'));
    stream.once('error', onError); stream.once('close', onClose);
    try {
      stream.write(`${JSON.stringify(value)}\n`, (error) => {
        if (error) { setImmediate(cleanup); reject(error); }
        else { cleanup(); resolve(); }
      });
    }
    catch (error) { onError(error); }
  });
}
