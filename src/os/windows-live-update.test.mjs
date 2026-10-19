import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { cpSync, copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
function waitLine(child, pattern) {
  return new Promise((resolve, reject) => {
    let output = '', errors = '';
    const timer = setTimeout(() => done(new Error('terminal fixture timeout: ' + output + errors)), 8000);
    const data = b => { output += b; if (pattern.test(output)) done(); };
    const stderr = b => { errors += b; };
    const exit = code => done(new Error('terminal fixture exit: ' + code + ': ' + errors));
    function done(error) { clearTimeout(timer); child.stdout.off('data', data); child.stderr.off('data', stderr); child.off('exit', exit); error ? reject(error) : resolve(); }
    child.stdout.on('data', data); child.stderr.on('data', stderr); child.once('exit', exit);
  });
}
import { promoteWindowsPackage } from './windows-package-update.mjs';
import { prepareWindowsTerminalRuntime } from './windows-terminal-runtime.mjs';

const require = createRequire(import.meta.url);
test('Windows real ConPTY: mapped old addon survives promotion and the new runtime stays outside npm',
  { skip: process.platform !== 'win32', timeout: 30000 }, async () => {
    const work = mkdtempSync(join(tmpdir(), 'tl-live-update-'));
    const target = join(work, 'live'), source = join(work, 'staged'), journal = join(work, 'recovery');
    const children = [];
    try {
      for (const root of [target, source]) {
        mkdirSync(join(root, 'node_modules'), { recursive: true });
        cpSync(dirname(require.resolve('node-pty/package.json')), join(root, 'node_modules', 'node-pty'), { recursive: true });
        writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'throughline', version: root === target ? '1.0.0' : '1.0.1', bin: { throughline: 'cli.mjs' } }));
        writeFileSync(join(root, 'cli.mjs'), root === target ? 'old' : 'new');
      }
      const original = join(target, 'node_modules', 'node-pty');
      const runtime = prepareWindowsTerminalRuntime({ source: original, runtimeRoot: join(work, 'runtimes') });
      assert.equal(runtime.includes('/live/'), false);
      const worker = `import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {spawn}=require(process.argv[1]);
const p=spawn(process.execPath,['-e',"process.stdin.on('data',()=>process.stdout.write('alive-marker'));process.stdout.write('child-ready-marker')"],{env:process.env,cols:80,rows:24});
p.onData(d=>{if(d.includes('child-ready-marker'))process.stdout.write('ready\\n');if(d.includes('alive-marker'))process.stdout.write('alive\\n')});
p.onExit(()=>process.exit(0));
setTimeout(()=>process.exit(2),20000);
process.stdin.setEncoding('utf8');process.stdin.on('data',d=>{if(d.includes('quit')){p.kill();process.exit(0);}else p.write('ping\\r')});
`;
      for (const entry of [original, fileURLToPath(runtime)]) {
        const env = { ...process.env }; delete env.NODE_OPTIONS; delete env.NODE_TEST_CONTEXT;
        const child = spawn(process.execPath, ['--input-type=module', '-e', worker, entry], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env });
        children.push(child);
        await waitLine(child, /ready/);
      }
      const native = join(original, 'prebuilds', `win32-${process.arch}`, 'conpty.node');
      assert.throws(() => copyFileSync(join(source, 'node_modules', 'node-pty', 'prebuilds', `win32-${process.arch}`, 'conpty.node'), native), 'control: Windows really denies overwriting the loaded addon');
      const bytes = readFileSync(native);
      promoteWindowsPackage(source, target, journal);
      assert.deepEqual(readFileSync(native), bytes);
      assert.equal(JSON.parse(readFileSync(join(target, 'package.json'))).version, '1.0.1');
      for (const child of children) {
        const alive = waitLine(child, /alive/); child.stdin.write('ping\n');
        await alive;
        assert.equal(child.exitCode, null);
      }
    } finally {
      for (const child of children) {
        if (child.exitCode === null) { const ended = once(child, 'exit'); const timer = setTimeout(() => child.kill(), 3000); child.stdin.write('quit\n'); await ended; clearTimeout(timer); }
      }
      rmSync(work, { recursive: true, force: true });
    }
  });
