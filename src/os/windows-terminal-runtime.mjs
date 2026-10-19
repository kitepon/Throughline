import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { packageFiles } from './windows-package-update.mjs';

const require = createRequire(import.meta.url);
function digest(root, files) {
  const hash = createHash('sha256');
  for (const file of files) hash.update(file.replaceAll('\\', '/')).update('\0').update(readFileSync(join(root, file)));
  return hash.digest('hex');
}

/** An immutable, content-addressed copy: no future npm update touches a live terminal's addon. */
export function prepareWindowsTerminalRuntime({ source = dirname(require.resolve('node-pty/package.json')),
  runtimeRoot = join(homedir(), '.throughline', 'terminal-runtimes') } = {}) {
  const files = packageFiles(source), key = digest(source, files);
  mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 });
  const target = join(runtimeRoot, `node-pty-${process.arch}-${key}`);
  if (!existsSync(target)) {
    const pending = join(runtimeRoot, `.preparing-${randomUUID()}`);
    try {
      cpSync(source, pending, { recursive: true, dereference: false, errorOnExist: true });
      if (digest(pending, packageFiles(pending)) !== key) throw new Error('terminal_runtime_copy_mismatch');
      try { renameSync(pending, target); }
      catch (error) { if (!existsSync(target)) throw error; }
    } finally { rmSync(pending, { recursive: true, force: true }); }
  }
  if (digest(target, packageFiles(target)) !== key) throw new Error('terminal_runtime_integrity_mismatch');
  const pkg = JSON.parse(readFileSync(join(target, 'package.json')));
  // node-pty's sole node-addon-api dependency is build-time only; no global module lookup is needed.
  return pathToFileURL(join(target, pkg.main)).href;
}

export function loadWindowsTerminalRuntime() {
  return import(prepareWindowsTerminalRuntime());
}
