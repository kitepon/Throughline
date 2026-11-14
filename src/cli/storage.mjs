/**
 * cli/storage.mjs — `storage locate` and `storage export` (ADR 0073).
 *
 * Hosts learn where Throughline keeps data and take consistent copies only through these commands.
 */
import {
  chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, writeSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { openReadOnlyDb } from '../db.mjs';
import { applyAndVerifyWindowsAcl, isWindows } from '../os/windows-acl.mjs';
import { storageLocations } from '../storage-roots.mjs';

export const STORAGE_EXPORT_SCHEMA = 'throughline.storage_export.v1';

const SQLITE_HEADER = 'SQLite format 3\0';
// Recreated on demand by Throughline, so a copy is never needed.
const LOCK_NAMES = new Set(['.log-retention.sqlite', '.lifecycle.sqlite']);
const DERIVED_DIRS = new Set(['haiku-workdir', 'terminal-runtimes']);
// On Windows defaults app state and app config share one directory; these names belong to app config.
const CONFIG_NAMES = new Set(['runtime-errors.config.json', 'runtime-errors.report.config.json']);

class StorageError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function skipped(name) {
  return LOCK_NAMES.has(name) || name.endsWith('.lock.sqlite') || /-(wal|shm|journal)$/u.test(name) ||
    (name.startsWith('.') && name.endsWith('.tmp'));
}

function inside(child, parent) {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

function exists(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function prepareTarget(to, roots) {
  if (roots.some((root) => inside(to, root))) {
    throw new StorageError('storage_export_target_inside_source', 'export target lies inside a Throughline root');
  }
  const info = exists(to);
  if (info && (!info.isDirectory() || info.isSymbolicLink() || readdirSync(to).length > 0)) {
    throw new StorageError('storage_export_target_not_empty', 'export target must be missing or an empty directory');
  }
  mkdirSync(to, { recursive: true, mode: 0o700 });
}

function copyFile(source, target, mode, counts) {
  let fd;
  try {
    fd = openSync(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if (error?.code === 'ENOENT') return; // removed during the export
    throw error;
  }
  try {
    const header = Buffer.alloc(16);
    const headerBytes = readSync(fd, header, 0, 16, 0);
    if (headerBytes === 16 && header.toString('latin1') === SQLITE_HEADER) {
      closeSync(fd);
      fd = undefined;
      const db = openReadOnlyDb(source);
      try {
        db.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`);
      } finally {
        db.close();
      }
      chmodSync(target, mode);
      counts.sqlite += 1;
      counts.bytes += lstatSync(target).size;
      return;
    }
    if (!fstatSync(fd).isFile()) return;
    const out = openSync(target, 'wx', mode);
    try {
      const buffer = Buffer.alloc(1024 * 1024);
      let position = 0;
      for (;;) {
        const read = readSync(fd, buffer, 0, buffer.length, position);
        if (read === 0) break;
        writeSync(out, buffer, 0, read);
        position += read;
      }
      counts.bytes += position;
    } finally {
      closeSync(out);
    }
    chmodSync(target, mode);
    counts.files += 1;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function copyTree(source, target, { privateWindows, sharedConfigTarget, top, privateTopDirs = null }, counts) {
  const info = exists(source);
  if (!info || !info.isDirectory()) return;
  mkdirSync(target, { recursive: true, mode: info.mode & 0o777 });
  chmodSync(target, info.mode & 0o777);
  if (privateWindows) applyAndVerifyWindowsAcl(target, true);
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    if (entry.isDirectory()) {
      if (top && DERIVED_DIRS.has(entry.name)) continue;
      const privateChild = privateWindows || (top && privateTopDirs?.has(entry.name));
      copyTree(from, join(target, entry.name),
        { privateWindows: privateChild, sharedConfigTarget: null, top: false, privateTopDirs: null }, counts);
    } else if (entry.isFile() && !skipped(entry.name)) {
      const destination = top && sharedConfigTarget && CONFIG_NAMES.has(entry.name)
        ? join(sharedConfigTarget, entry.name)
        : join(target, entry.name);
      const mode = (exists(from)?.mode ?? 0o600) & 0o777;
      copyFile(from, destination, mode, counts);
      // shortcut: one PowerShell per private file; batch into one script if Windows exports get large.
      if (privateWindows && exists(destination)) applyAndVerifyWindowsAcl(destination, false);
    }
  }
}

export function exportStorage(to, env = process.env) {
  const locations = storageLocations(env);
  const { data, appState, appConfig } = locations.roots;
  const target = resolve(to);
  prepareTarget(target, [data, appState, appConfig]);
  const counts = { files: 0, sqlite: 0, bytes: 0 };
  const windows = isWindows(env);
  // Under THROUGHLINE_HOME the private app dirs live inside the data root.
  copyTree(data, target, { privateWindows: false, sharedConfigTarget: null, top: true,
    privateTopDirs: windows ? new Set(['app-state', 'app-config']) : null }, counts);
  if (!inside(appState, data)) {
    const configTarget = join(target, 'app-config');
    const shared = appConfig === appState;
    if (shared) mkdirSync(configTarget, { recursive: true, mode: 0o700 });
    copyTree(appState, join(target, 'app-state'),
      { privateWindows: windows, sharedConfigTarget: shared ? configTarget : null, top: true }, counts);
  }
  if (!inside(appConfig, data) && appConfig !== appState) {
    copyTree(appConfig, join(target, 'app-config'),
      { privateWindows: windows, sharedConfigTarget: null, top: true }, counts);
  }
  return {
    schema: STORAGE_EXPORT_SCHEMA,
    status: 'complete',
    source: locations.source,
    from: locations.roots,
    to: target,
    ...counts,
  };
}

export function parseArgs(argv = []) {
  const [command, ...rest] = argv;
  if (command === 'locate' && rest.length === 1 && rest[0] === '--json') return { command };
  if (command === 'export') {
    let to = null;
    let json = false;
    for (let index = 0; index < rest.length; index += 1) {
      if (rest[index] === '--json' && !json) json = true;
      else if (rest[index] === '--to' && to === null && typeof rest[index + 1] === 'string' && rest[index + 1]) {
        to = rest[index + 1];
        index += 1;
      } else throw new TypeError('usage error');
    }
    if (json && to !== null) return { command, to };
  }
  throw new TypeError('usage error');
}

export function run(argv = [], { stdout = process.stdout, env = process.env } = {}) {
  let request;
  try {
    request = parseArgs(argv);
  } catch {
    stdout.write(`${JSON.stringify({ schema: STORAGE_EXPORT_SCHEMA, status: 'failed', code: 'invalid_request',
      message: 'usage: throughline storage locate --json | storage export --to <dir> --json' })}\n`);
    return 2;
  }
  if (request.command === 'locate') {
    stdout.write(`${JSON.stringify(storageLocations(env))}\n`);
    return 0;
  }
  try {
    stdout.write(`${JSON.stringify(exportStorage(request.to, env))}\n`);
    return 0;
  } catch (error) {
    stdout.write(`${JSON.stringify({
      schema: STORAGE_EXPORT_SCHEMA,
      status: 'failed',
      code: error instanceof StorageError ? error.code : 'storage_export_failed',
      message: String(error?.message ?? error).slice(0, 500),
    })}\n`);
    return 1;
  }
}
