/**
 * storage-roots.mjs — the one place that decides where Throughline persists (ADR 0073).
 *
 * THROUGHLINE_HOME, when set, is the single root on every OS. Unset keeps the original defaults.
 */
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { windowsLocalAppData, xdgConfigHome, xdgStateHome } from './os/app-dirs.mjs';
import { isWindows } from './os/windows-acl.mjs';

export const THROUGHLINE_HOME_ENV = 'THROUGHLINE_HOME';

function custom(env) {
  const value = env[THROUGHLINE_HOME_ENV];
  return typeof value === 'string' && value.trim() ? value : null;
}

/** Data root: DB, logs, session state, handoff state. */
export function dataRoot({ env = process.env, home = homedir() } = {}) {
  const value = custom(env);
  return value ? resolve(home, value) : join(home, '.throughline');
}

/** App state: completed-turn receipts and runtime errors. */
export function appStateRoot(env = process.env) {
  if (custom(env)) return join(dataRoot({ env }), 'app-state');
  return join(isWindows(env) ? windowsLocalAppData(env) : xdgStateHome(env), 'throughline');
}

/** App config: runtime error reporting settings. */
export function appConfigRoot(env = process.env) {
  if (custom(env)) return join(dataRoot({ env }), 'app-config');
  return join(isWindows(env) ? windowsLocalAppData(env) : xdgConfigHome(env), 'throughline');
}

export function storageLocations(env = process.env) {
  const data = dataRoot({ env });
  return {
    schema: 'throughline.storage_locations.v1',
    source: custom(env) ? THROUGHLINE_HOME_ENV : 'default',
    roots: { data, appState: appStateRoot(env), appConfig: appConfigRoot(env) },
    database: join(data, 'throughline.db'),
  };
}
