import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, symlinkSync } from 'node:fs';
import { join, win32, posix } from 'node:path';
import { tmpdir } from 'node:os';
import { packageFiles, packagePathsOverlap, promoteWindowsPackage, updateWindowsPackage } from './windows-package-update.mjs';

function fixture() {
  const work = mkdtempSync(join(tmpdir(), 'tl-promotion-test-'));
  const source = join(work, 'stage'), target = join(work, 'live'), journal = join(work, 'recovery');
  const write = (root, rel, bytes) => { mkdirSync(join(root, rel, '..'), { recursive: true }); writeFileSync(join(root, rel), bytes); };
  for (const [root, version] of [[source, '1.2.4'], [target, '1.2.3']]) {
    write(root, 'package.json', JSON.stringify({ name: 'throughline', version, bin: { throughline: 'bin/throughline.mjs' } }));
    write(root, 'bin/throughline.mjs', version);
    write(root, 'node_modules/node-pty/conpty.node', 'unchanged mapped native addon');
  }
  return { work, source, target, journal, write };
}

test('promotion leaves identical mapped files untouched, updates dependencies and removes obsolete files', () => {
  const f = fixture();
  try {
    f.write(f.target, 'obsolete.mjs', 'old');
    f.write(f.source, 'node_modules/new/index.js', 'new dependency');
    const calls = [];
    const result = promoteWindowsPackage(f.source, f.target, f.journal, { replace(path, bytes) {
      calls.push(path); assert.equal(path.endsWith('conpty.node'), false, 'locked native file must never be written');
      mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, bytes);
    } });
    assert.equal(result.changed, 4);
    assert.equal(calls.at(-1), join(f.target, 'package.json'));
    assert.equal(existsSync(join(f.target, 'obsolete.mjs')), false);
    assert.equal(JSON.parse(readFileSync(join(f.journal, 'journal.json'))).phase, 'promoted');
    for (const rel of packageFiles(f.source)) assert.deepEqual(readFileSync(join(f.source, rel)), readFileSync(join(f.target, rel)));
  } finally { rmSync(f.work, { recursive: true, force: true }); }
});

test('a changed locked native addon fails explicitly and restores previous files/version', () => {
  const f = fixture();
  try {
    f.write(f.source, 'node_modules/node-pty/conpty.node', 'new incompatible addon');
    const before = packageFiles(f.target).map(rel => [rel, readFileSync(join(f.target, rel))]);
    assert.throws(() => promoteWindowsPackage(f.source, f.target, f.journal, { replace(path, bytes) {
      if (path.endsWith('.node')) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
      mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, bytes);
    } }), /EBUSY/);
    for (const [rel, bytes] of before) assert.deepEqual(readFileSync(join(f.target, rel)), bytes);
    assert.equal(JSON.parse(readFileSync(join(f.journal, 'journal.json'))).phase, 'rolled_back');
  } finally { rmSync(f.work, { recursive: true, force: true }); }
});

test('reject entrypoint drift and symlinks before any live file mutation', () => {
  const f = fixture();
  try {
    const pkg = JSON.parse(readFileSync(join(f.source, 'package.json'))); pkg.bin.throughline = 'elsewhere.mjs';
    f.write(f.source, 'package.json', JSON.stringify(pkg));
    assert.throws(() => promoteWindowsPackage(f.source, f.target, f.journal), /entrypoint_changed/);
    assert.equal(existsSync(f.journal), false);
    if (process.platform !== 'win32') {
      pkg.bin.throughline = 'bin/throughline.mjs'; f.write(f.source, 'package.json', JSON.stringify(pkg));
      symlinkSync(join(f.target, 'package.json'), join(f.source, 'escape'));
      assert.throws(() => promoteWindowsPackage(f.source, f.target, f.journal), /symlink_rejected/);
    }
  } finally { rmSync(f.work, { recursive: true, force: true }); }
});

test('a failed npm stage never modifies the live package and releases only its own lock', () => {
  const f = fixture();
  try {
    let argv; const messages = [];
    assert.throws(() => updateWindowsPackage({ target: f.target, version: '1.2.4', recoveryRoot: f.journal,
      stderr: { write: s => messages.push(s) }, npm: args => { argv = args; return { status: 1, stderr: 'registry unavailable' }; } }), /staged_package_install_failed/);
    assert.equal(argv.includes('throughline@1.2.4'), true);
    assert.equal(argv.includes('--prefix'), true);
    assert.equal(messages.join('').includes('staged_package_install_failed'), true);
    assert.equal(JSON.parse(readFileSync(join(f.target, 'package.json'))).version, '1.2.3');
    const lock = join(f.work, '.throughline-update-lock');
    assert.equal(existsSync(lock), false); mkdirSync(lock);
    assert.throws(() => updateWindowsPackage({ target: f.target }), /EEXIST/);
    assert.equal(existsSync(lock), true, 'another updater lock is never removed');
  } finally { rmSync(f.work, { recursive: true, force: true }); }
});


test('staged npm promotion verifies the pinned package, preserves live files and cleans its private prefix', () => {
  for (const invalid of [false, true]) {
    const f = fixture(); let prefix;
    try {
      const operation = () => updateWindowsPackage({ target: f.target, beforeVersion: '1.2.3', version: '1.2.4',
        recoveryRoot: f.journal, stderr: { write() {} }, npm(args) {
          prefix = args[args.indexOf('--prefix') + 1];
          assert.notEqual(prefix, f.target);
          cpSync(f.source, join(prefix, 'node_modules', 'throughline'), { recursive: true });
          if (invalid) f.write(join(prefix, 'node_modules', 'throughline'), 'package.json', JSON.stringify({ name: 'throughline', version: '99.0.0' }));
          return { status: 0 };
        } });
      if (invalid) assert.throws(operation, /staged_package_version_mismatch/);
      else assert.equal(operation().verified, 3);
      assert.equal(existsSync(prefix), false);
      assert.equal(JSON.parse(readFileSync(join(f.target, 'package.json'))).version, invalid ? '1.2.3' : '1.2.4');
    } finally { rmSync(f.work, { recursive: true, force: true }); }
  }
});


test('update path guard allows separate volumes and rejects either direction of real nesting', () => {
  for (const [source, target, overlap] of [
    ['D:\\Temp\\stage', 'C:\\npm\\throughline', false],
    ['C:\\stage', 'C:\\stage\\live', true],
    ['C:\\live\\stage', 'C:\\live', true],
    ['C:\\same', 'C:\\same', true],
    ['C:\\live\\..nested', 'C:\\live', true],
    ['C:\\stage', 'C:\\live', false],
  ]) assert.equal(packagePathsOverlap(source, target, win32), overlap);
  assert.equal(packagePathsOverlap('/tmp/stage', '/product/live', posix), false);
  assert.equal(packagePathsOverlap('/product/live/..nested', '/product/live', posix), true);
});
