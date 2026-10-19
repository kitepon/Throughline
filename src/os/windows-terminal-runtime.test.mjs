import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { prepareWindowsTerminalRuntime } from './windows-terminal-runtime.mjs';

test('terminal runtime is an immutable verified copy independent of the mutable npm installation', async () => {
  const work = mkdtempSync(join(tmpdir(), 'tl-terminal-runtime-'));
  try {
    const source = join(work, 'source'), runtimeRoot = join(work, 'runtimes'); mkdirSync(source);
    writeFileSync(join(source, 'package.json'), JSON.stringify({ name: 'node-pty', version: '1.1.0', main: 'index.cjs' }));
    writeFileSync(join(source, 'index.cjs'), 'module.exports={sentinel:42};');
    const options = { source, runtimeRoot }, url = prepareWindowsTerminalRuntime(options);
    assert.equal(prepareWindowsTerminalRuntime(options), url);
    assert.equal((await import(url)).default.sentinel, 42);
    assert.equal(readdirSync(runtimeRoot).length, 1);
    writeFileSync(join(source, 'index.cjs'), 'module.exports={sentinel:43};');
    const next = prepareWindowsTerminalRuntime(options);
    assert.notEqual(next, url);
    assert.equal(readFileSync(fileURLToPath(url), 'utf8'), 'module.exports={sentinel:42};');
    writeFileSync(fileURLToPath(next), 'tampered');
    assert.throws(() => prepareWindowsTerminalRuntime(options), /runtime_integrity_mismatch/);
  } finally { rmSync(work, { recursive: true, force: true }); }
});
