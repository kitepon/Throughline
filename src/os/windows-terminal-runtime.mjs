import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { packageFiles } from './windows-package-update.mjs';

const require = createRequire(import.meta.url);
function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

function directory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (!lstatSync(path).isDirectory()) throw new Error('terminal_runtime_directory_required');
}

function reclaimUnusedRuntimes(root, current) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const target = join(root, entry.name);
    const pending = /^\.preparing-(\d+)-[0-9a-f-]{36}$/.exec(entry.name);
    if (pending) {
      if (!alive(Number(pending[1])) && Date.now() - statSync(target).mtimeMs > 24 * 3600000) {
        rmSync(target, { recursive: true });
      }
      continue;
    }
    if (!/^node-pty-[a-z0-9]+-[0-9a-f]{64}$/.test(entry.name)) continue;
    const dir = join(root, '.leases', entry.name), marker = join(dir, 'managed');
    if (!existsSync(marker) || !lstatSync(dir).isDirectory() || !lstatSync(marker).isFile()) continue;
    let used = false;
    for (const name of readdirSync(dir)) {
      if (name === 'managed') continue;
      if (!/^\d+$/.test(name) || alive(Number(name))) { used = true; continue; }
      rmSync(join(dir, name), { force: true });
    }
    if (!used && entry.name !== current) {
      rmSync(target, { recursive: true });
      rmSync(dir, { recursive: true });
    }
  }
}
function digest(root, files) {
  const hash = createHash('sha256');
  for (const file of files) hash.update(file.replaceAll('\\', '/')).update('\0').update(readFileSync(join(root, file)));
  return hash.digest('hex');
}

/** An immutable, content-addressed copy: no future npm update touches a live terminal's addon. */
export function prepareWindowsTerminalRuntime({ source = dirname(require.resolve('node-pty/package.json')),
  runtimeRoot = join(homedir(), '.throughline', 'terminal-runtimes') } = {}) {
  const files = packageFiles(source), key = digest(source, files);
  directory(runtimeRoot);
  const lockPath = join(runtimeRoot, '.lifecycle.sqlite');
  try {
    if (!lstatSync(lockPath).isFile()) throw new Error('terminal_runtime_lock_file_required');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const lock = new DatabaseSync(lockPath);
  try {
    lock.exec('PRAGMA busy_timeout = 15000; BEGIN IMMEDIATE');
    directory(join(runtimeRoot, '.leases'));
    const name = `node-pty-${process.arch}-${key}`, target = join(runtimeRoot, name);
    const leaseDir = join(runtimeRoot, '.leases', name);
    if (!existsSync(target)) {
      const pending = join(runtimeRoot, `.preparing-${process.pid}-${randomUUID()}`);
      try {
        cpSync(source, pending, { recursive: true, dereference: false, errorOnExist: true });
        if (digest(pending, packageFiles(pending)) !== key) throw new Error('terminal_runtime_copy_mismatch');
        renameSync(pending, target);
        directory(leaseDir);
        writeFileSync(join(leaseDir, 'managed'), '', { mode: 0o600 });
      } finally { rmSync(pending, { recursive: true, force: true }); }
    }
    if (digest(target, packageFiles(target)) !== key) throw new Error('terminal_runtime_integrity_mismatch');
    if (existsSync(join(leaseDir, 'managed'))) {
      const lease = join(leaseDir, String(process.pid));
      writeFileSync(lease, '', { mode: 0o600 });
    }
    reclaimUnusedRuntimes(runtimeRoot, name);
    const pkg = JSON.parse(readFileSync(join(target, 'package.json')));
    // node-pty's sole node-addon-api dependency is build-time only; no global module lookup is needed.
    return pathToFileURL(join(target, pkg.main)).href;
  } finally { lock.close(); }
}

export function loadWindowsTerminalRuntime() {
  return import(prepareWindowsTerminalRuntime());
}
