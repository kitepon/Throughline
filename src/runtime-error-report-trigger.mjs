/**
 * runtime-error-report-trigger.mjs — hook入口から送信processを起こす軽い判定
 *
 * hookの終了を待たせないため、ここでは小さなファイル2つを読むだけにする。
 * ACL検証・store lock・通信は、切り離した子process（`runtime-errors report --background`）が行う。
 * 送信設定が無い端末（既定）では、configの1回のlstatで抜ける。
 */
import childProcess from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isWindows } from './os/windows-acl.mjs';
import { windowsLocalAppData, xdgConfigHome, xdgStateHome } from './os/app-dirs.mjs';

export const RUNTIME_ERROR_REPORT_CONFIG_SCHEMA = 'throughline.runtime_error_report_config.v1';
export const RUNTIME_ERROR_REPORT_STATE_SCHEMA = 'throughline.runtime_error_report_state.v1';

const BIN = fileURLToPath(new URL('../bin/throughline.mjs', import.meta.url));

export function defaultRuntimeErrorReportConfigPath(env = process.env) {
  const base = isWindows(env) ? windowsLocalAppData(env) : xdgConfigHome(env);
  return join(base, 'throughline', 'runtime-errors.report.config.json');
}

export function defaultRuntimeErrorReportStatePath(env = process.env) {
  const base = isWindows(env) ? windowsLocalAppData(env) : xdgStateHome(env);
  return join(base, 'throughline', 'runtime-errors.report.state.json');
}

export function isCanonicalRuntimeErrorReportConfig(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== 2 || !keys.includes('schema') || !keys.includes('reporting')) return false;
  if (value.schema !== RUNTIME_ERROR_REPORT_CONFIG_SCHEMA) return false;
  const reporting = value.reporting;
  if (reporting === null || typeof reporting !== 'object' || Array.isArray(reporting)) return false;
  const reportingKeys = Object.keys(reporting);
  if (reportingKeys.length !== 2 || !reportingKeys.includes('enabled') || !reportingKeys.includes('credential_file')) return false;
  if (typeof reporting.enabled !== 'boolean') return false;
  return reporting.credential_file === null || typeof reporting.credential_file === 'string';
}

export function readRuntimeErrorReportConfig({ env = process.env, configPath } = {}) {
  try {
    const path = configPath || defaultRuntimeErrorReportConfigPath(env);
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink()) return null;
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return isCanonicalRuntimeErrorReportConfig(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * hook入口から呼ぶ。例外を外へ出さず、hookの結果を変えない。
 * 次に試してよい時刻（state）を過ぎている時だけ、切り離した子processを1つ起こす。
 * 同時に複数起きた場合の排他は、子processがstore lockの下で行う。
 */
export function triggerRuntimeErrorReportBestEffort({
  env = process.env,
  now = Date.now(),
  spawn = childProcess.spawn,
} = {}) {
  try {
    const config = readRuntimeErrorReportConfig({ env });
    if (config?.reporting.enabled !== true) return { status: 'reporting_disabled' };
    if (!attemptIsDue(defaultRuntimeErrorReportStatePath(env), now)) return { status: 'throttled' };
    const child = spawn(process.execPath, [BIN, 'runtime-errors', 'report', '--background', '--json'], {
      cwd: dirname(BIN),
      env,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.on?.('error', () => {});
    child.unref?.();
    return { status: 'started' };
  } catch {
    return { status: 'trigger_failed' };
  }
}

function attemptIsDue(statePath, now) {
  let state;
  try {
    state = JSON.parse(readFileSync(statePath, 'utf8'));
  } catch (error) {
    // stateが無い端末は、まだ一度も試していない。読めないstateは子processが検証して直す。
    return error?.code === 'ENOENT' || error instanceof SyntaxError;
  }
  const next = Date.parse(state?.next_attempt_at);
  return !Number.isFinite(next) || now >= next;
}
