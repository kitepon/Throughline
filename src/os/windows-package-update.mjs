import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, isAbsolute, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

/** No directory moves: a mapped native DLL may be read but cannot be renamed on Windows. */
export function packageFiles(root, prefix = '') {
  const files = [];
  if (lstatSync(root).isSymbolicLink()) throw new Error('update_symlink_rejected');
  for (const name of readdirSync(root).sort()) {
    const path = join(root, name), rel = join(prefix, name), stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error('update_symlink_rejected');
    if (stat.isDirectory()) files.push(...packageFiles(path, rel));
    else if (stat.isFile()) files.push(rel);
    else throw new Error('update_special_file_rejected');
  }
  return files;
}

function atomicWrite(path, bytes) {
  mkdirSync(dirname(path), { recursive: true });
  const pending = `${path}.${randomUUID()}.next`;
  try { writeFileSync(pending, bytes, { flag: 'wx' }); renameSync(pending, path); }
  finally { rmSync(pending, { force: true }); }
}

export function packagePathsOverlap(source, target, path = { relative, resolve, isAbsolute, sep }) {
  const inside = (root, candidate) => {
    const rel = path.relative(path.resolve(root), path.resolve(candidate));
    return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`));
  };
  return inside(source, target) || inside(target, source);
}

/** Roll back every completed file mutation. Keep the journal if rollback itself fails. */
export function promoteWindowsPackage(source, target, journal, { replace = atomicWrite } = {}) {
  if (packagePathsOverlap(source, target)) {
    throw new Error('update_overlapping_paths');
  }
  const old = JSON.parse(readFileSync(join(target, 'package.json')));
  const next = JSON.parse(readFileSync(join(source, 'package.json')));
  if (old.name !== 'throughline' || next.name !== 'throughline' || !isDeepStrictEqual(old.bin, next.bin)) {
    throw new Error('update_entrypoint_changed');
  }
  const incoming = packageFiles(source), existing = packageFiles(target), wanted = new Set(incoming);
  const plan = [...incoming.filter(rel => !existsSync(join(target, rel)) ||
    !readFileSync(join(target, rel)).equals(readFileSync(join(source, rel)))),
    ...existing.filter(rel => !wanted.has(rel))];
  // Product version only advances after every other file is in place.
  plan.sort((a, b) => Number(a === 'package.json') - Number(b === 'package.json'));
  mkdirSync(journal, { recursive: true, mode: 0o700 });
  const entries = plan.map(rel => ({ rel, existed: existsSync(join(target, rel)), incoming: wanted.has(rel) }));
  for (const entry of entries) if (entry.existed) {
    const saved = join(journal, 'before', entry.rel);
    mkdirSync(dirname(saved), { recursive: true }); copyFileSync(join(target, entry.rel), saved);
  }
  const state = { schema: 'throughline.package_update_journal.v1', target, beforeVersion: old.version,
    afterVersion: next.version, phase: 'prepared', entries };
  const save = () => atomicWrite(join(journal, 'journal.json'), `${JSON.stringify(state)}\n`);
  save();
  const changed = [];
  try {
    state.phase = 'promoting'; save();
    for (const entry of entries) {
      if (entry.incoming) replace(join(target, entry.rel), readFileSync(join(source, entry.rel)));
      else rmSync(join(target, entry.rel));
      changed.push(entry);
    }
    for (const rel of incoming) if (!readFileSync(join(target, rel)).equals(readFileSync(join(source, rel)))) {
      throw new Error('update_file_verification_failed');
    }
    state.phase = 'promoted'; save();
    return { changed: changed.length, verified: incoming.length };
  } catch (cause) {
    try {
      for (const entry of changed.reverse()) {
        if (entry.existed) atomicWrite(join(target, entry.rel), readFileSync(join(journal, 'before', entry.rel)));
        else rmSync(join(target, entry.rel));
      }
      state.phase = 'rolled_back'; save();
    } catch (rollback) {
      throw new AggregateError([cause, rollback], 'package_update_rollback_failed');
    }
    throw cause;
  }
}

/** npm still resolves, downloads, verifies and installs dependencies, in a private prefix. */
export function updateWindowsPackage({ target, version, beforeVersion, npm, recoveryRoot, stderr }) {
  const lock = join(dirname(target), '.throughline-update-lock');
  mkdirSync(lock); // Existing/stale owner is an explicit failure; never steal its lock.
  let scratch;
  const journal = join(recoveryRoot, randomUUID());
  let rollbackFailed = false;
  try {
    if (beforeVersion && JSON.parse(readFileSync(join(target, 'package.json'))).version !== beforeVersion) {
      throw new Error('installed_version_changed');
    }
    scratch = mkdtempSync(join(tmpdir(), 'throughline-update-'));
    writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, target, journal }));
    const result = npm(['install', '--global', '--prefix', scratch, `throughline@${version}`, '--no-audit', '--no-fund']);
    if (result.error || result.status !== 0) {
      throw new Error('staged_package_install_failed');
    }
    const source = join(scratch, 'node_modules', 'throughline');
    const pkg = JSON.parse(readFileSync(join(source, 'package.json')));
    if (pkg.name !== 'throughline' || pkg.version !== version) throw new Error('staged_package_version_mismatch');
    // npm optional failures must not silently remove the supported Windows terminal.
    for (const [name, expected] of Object.entries({ ...pkg.dependencies, ...pkg.optionalDependencies })) {
      const actual = JSON.parse(readFileSync(join(source, 'node_modules', name, 'package.json')));
      if (/^\d+\.\d+\.\d+$/.test(expected) && actual.version !== expected) {
        throw new Error('staged_dependency_version_mismatch');
      }
    }
    return promoteWindowsPackage(source, target, journal);
  } catch (error) {
    rollbackFailed = error.message === 'package_update_rollback_failed';
    stderr.write(`[throughline self-update] ${error.message}; recovery=${journal}\n`);
    throw error;
  } finally {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
    if (!rollbackFailed) rmSync(lock, { recursive: true });
  }
}
