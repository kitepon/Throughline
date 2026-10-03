import {
  acknowledgeRuntimeErrors,
  compactRuntimeErrors,
  getRuntimeErrorDiagnostics,
  readRuntimeErrorSnapshot,
  reopenRuntimeError,
  resolveRuntimeError,
  setRuntimeErrorCollectionEnabled,
} from '../runtime-error-store.mjs';
import {
  getRuntimeErrorReportStatus,
  reportRuntimeErrors,
  setRuntimeErrorReportingEnabled,
} from '../runtime-error-report.mjs';

const USAGE = 'usage: throughline runtime-errors <enable|disable|snapshot|diagnostics|ack|resolve|reopen|compact|report-enable|report-disable|report|report-status> [arguments] --json';
const COMMANDS = [
  'enable', 'disable', 'snapshot', 'diagnostics', 'ack', 'resolve', 'reopen', 'compact',
  'report-enable', 'report-disable', 'report', 'report-status',
];
const REPORT_COMMANDS = ['report-enable', 'report-disable', 'report', 'report-status'];

export function parseArgs(argv = []) {
  const command = argv[0];
  if (!COMMANDS.includes(command)) {
    throw new TypeError(USAGE);
  }
  const options = { command, json: false, afterCursor: 0, limit: 256, value: null };
  if (REPORT_COMMANDS.includes(command)) return parseReportArgs(command, argv.slice(1));
  for (let index = 1; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--json' && !options.json) {
      options.json = true;
    } else if (command === 'snapshot' && arg === '--after-cursor' && argv[index + 1]) {
      options.afterCursor = parseInteger(argv[++index], '--after-cursor');
    } else if (command === 'snapshot' && arg === '--limit' && argv[index + 1]) {
      options.limit = parseInteger(argv[++index], '--limit');
    } else if (['ack', 'resolve', 'reopen'].includes(command) && options.value === null && !arg.startsWith('-')) {
      options.value = arg;
    } else {
      throw new TypeError(USAGE);
    }
  }
  if (!options.json || (['ack', 'resolve', 'reopen'].includes(command) && options.value === null)) {
    throw new TypeError(USAGE);
  }
  return options;
}

function parseReportArgs(command, args) {
  const options = { command, json: false, credentialFile: null, background: false };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--json' && !options.json) {
      options.json = true;
    } else if (command === 'report-enable' && arg === '--credential-file' && options.credentialFile === null &&
      args[index + 1] && !args[index + 1].startsWith('-')) {
      options.credentialFile = args[++index];
    } else if (command === 'report' && arg === '--background' && !options.background) {
      options.background = true;
    } else {
      throw new TypeError(USAGE);
    }
  }
  if (!options.json || (command === 'report-enable' && options.credentialFile === null)) throw new TypeError(USAGE);
  return options;
}

// 送信の成否は終了codeへ写す。hookから起きたbackgroundの送信は、結果をstateへ残すだけにする。
function reportExitCode(result, background) {
  if (background || result.status === 'sent' || result.status === 'nothing_pending') return 0;
  return result.status === 'reporting_disabled' || result.status === 'collection_disabled' ? 3 : 1;
}

async function runReport(options, dependencies, env) {
  try {
    const result = await (dependencies.report ?? reportRuntimeErrors)({ env, background: options.background });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return reportExitCode(result, options.background);
  } catch {
    process.stderr.write('[runtime-errors] operation_failed\n');
    return 1;
  }
}

export function run(argv = [], dependencies = {}) {
  let options;
  try {
    options = parseArgs(argv);
  } catch {
    process.stderr.write(`[runtime-errors] ${USAGE}\n`);
    return 2;
  }
  if (options.command === 'report') return runReport(options, dependencies, dependencies.env ?? process.env);

  try {
    const env = dependencies.env ?? process.env;
    let result;
    if (options.command === 'enable' || options.command === 'disable') {
      result = (dependencies.configure ?? setRuntimeErrorCollectionEnabled)(
        options.command === 'enable',
        { env },
      );
    } else if (options.command === 'report-enable') {
      result = (dependencies.configureReporting ?? setRuntimeErrorReportingEnabled)(
        true,
        { env, credentialFile: options.credentialFile },
      );
    } else if (options.command === 'report-disable') {
      result = (dependencies.configureReporting ?? setRuntimeErrorReportingEnabled)(false, { env });
    } else if (options.command === 'report-status') {
      result = (dependencies.getReportStatus ?? getRuntimeErrorReportStatus)({ env });
    } else if (options.command === 'snapshot') {
      result = (dependencies.readSnapshot ?? readRuntimeErrorSnapshot)({
        env,
        afterCursor: options.afterCursor,
        limit: options.limit,
      });
    } else if (options.command === 'diagnostics') {
      result = (dependencies.getDiagnostics ?? getRuntimeErrorDiagnostics)({ env });
    } else if (options.command === 'ack') {
      result = (dependencies.acknowledge ?? acknowledgeRuntimeErrors)(
        parseInteger(options.value, 'cursor'),
        { env },
      );
    } else if (options.command === 'resolve') {
      result = (dependencies.resolve ?? resolveRuntimeError)(options.value, { env });
    } else if (options.command === 'reopen') {
      result = (dependencies.reopen ?? reopenRuntimeError)(options.value, { env });
    } else {
      result = (dependencies.compact ?? compactRuntimeErrors)({ env });
    }
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch {
    process.stderr.write('[runtime-errors] operation_failed\n');
    return 1;
  }
}

function parseInteger(value, name) {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new TypeError(`${name} invalid`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new TypeError(`${name} invalid`);
  return parsed;
}

export const _internal = { USAGE };
