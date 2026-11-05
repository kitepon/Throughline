import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
    assert.equal(readdirSync(runtimeRoot).filter(name => name.startsWith('node-pty-')).length, 1);
    writeFileSync(join(source, 'index.cjs'), 'module.exports={sentinel:43};');
    const next = prepareWindowsTerminalRuntime(options);
    assert.notEqual(next, url);
    assert.equal(readFileSync(fileURLToPath(url), 'utf8'), 'module.exports={sentinel:42};');
    writeFileSync(fileURLToPath(next), 'tampered');
    assert.throws(() => prepareWindowsTerminalRuntime(options), /runtime_integrity_mismatch/);
  } finally { rmSync(work, { recursive: true, force: true }); }
});


test('ordinary prepare reclaims a dead owner runtime while preserving legacy copies', () => {
  const work = mkdtempSync(join(tmpdir(), 'tl-runtime-reclaim-'));
  try {
    const source = join(work, 'source'), runtimeRoot = join(work, 'runtimes'); mkdirSync(source);
    writeFileSync(join(source, 'package.json'), JSON.stringify({ name: 'node-pty', version: '1.1.0', main: 'index.cjs' }));
    writeFileSync(join(source, 'index.cjs'), 'module.exports=1;');
    const module = new URL('./windows-terminal-runtime.mjs', import.meta.url).href;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e',
      `import {prepareWindowsTerminalRuntime} from ${JSON.stringify(module)};console.log(prepareWindowsTerminalRuntime(${JSON.stringify({ source, runtimeRoot })}));`], { encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
    const old = fileURLToPath(child.stdout.trim());
    const legacy = join(runtimeRoot, `node-pty-${process.arch}-${'a'.repeat(64)}`); mkdirSync(legacy);
    writeFileSync(join(legacy, 'keep'), 'legacy may still be loaded');
    writeFileSync(join(source, 'index.cjs'), 'module.exports=2;');
    const next = prepareWindowsTerminalRuntime({ source, runtimeRoot });
    assert.equal(readdirSync(runtimeRoot).filter(name => name.startsWith('node-pty-')).length, 2);
    assert.equal(readdirSync(runtimeRoot).includes(old.split(/[\\/]/).at(-2)), false);
    assert.equal(readFileSync(join(legacy, 'keep'), 'utf8'), 'legacy may still be loaded');
    assert.equal(readFileSync(fileURLToPath(next), 'utf8'), 'module.exports=2;');
  } finally { rmSync(work, { recursive: true, force: true }); }
});
