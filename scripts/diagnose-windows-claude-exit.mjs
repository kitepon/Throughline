// Temporary diagnostic branch only: artificial CLI and delayed ConPTY output readiness.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { createRequire } from 'node:module';
import workerThreads from 'node:worker_threads';
import { startClaudeTerminal } from '../src/os/claude-terminal.mjs';

if (process.argv[2] === '--child') {
  const home = process.argv[3], delayMs = Number(process.argv[4]);
  const start = performance.now(), events = [];
  const record = (event, data = {}) => events.push({ ms: +(performance.now()-start).toFixed(1), event, ...data });
  const OriginalWorker = workerThreads.Worker;
  workerThreads.Worker = class extends OriginalWorker {
    constructor(file, options) {
      const preload = `data:text/javascript,${encodeURIComponent(`await new Promise(r=>setTimeout(r,${delayMs}));`)}`;
      super(file, { ...options, execArgv: ['--import', preload] });
      record('conout-worker-created');
      this.on('message', message => record('conout-worker-message', { message }));
      this.on('error', error => record('conout-worker-error', { message: error.message }));
    }
  };
  const marker = join(home, 'fake-exit.txt');
  const bin = join(home, 'fake-bin'); mkdirSync(bin);
  writeFileSync(join(bin, 'claude.ps1'), `[IO.File]::WriteAllText('${marker.replaceAll("'", "''")}',[DateTimeOffset]::Now.ToString('o')); exit 1\r\n`);
  const env = { ...process.env, HOME: home, USERPROFILE: home, LOCALAPPDATA: join(home, 'local'), XDG_CONFIG_HOME: join(home, 'config'), XDG_STATE_HOME: join(home, 'state') };
  const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') ?? 'PATH';
  env[pathKey] = `${bin}${delimiter}${env[pathKey] ?? ''}`;
  let ptyTerminal;
  const require = createRequire(import.meta.url);
  const terminal = await startClaudeTerminal([], { sessionId: '11111111-1111-4111-8111-111111111111', cwd: home, env,
    loadPty: async () => ({ spawn(...args) {
      ptyTerminal = require('node-pty').spawn(...args);
      record('pty-spawn', { pid: ptyTerminal.pid });
      const agent = ptyTerminal._agent;
      const exited = agent._$onProcessExit.bind(agent);
      agent._$onProcessExit = code => { record('native-process-exit', { code }); exited(code); };
      agent.outSocket.on('ready_datapipe', () => record('ready-datapipe'));
      agent.outSocket.on('close', () => record('output-close'));
      agent.outSocket.on('error', error => record('output-error', { message: error.message }));
      ptyTerminal.onExit(event => record('pty-exit', event));
      return ptyTerminal;
    } }) });
  terminal.ended.then(event => record('product-ended', event));
  await new Promise(resolve => setTimeout(resolve, 6500));
  const fakeExit = existsSync(marker) ? readFileSync(marker, 'utf8') : null;
  const result = { delayMs, fakeExit, exit: terminal.exit, events };
  console.log(JSON.stringify(result));
  // This process owns only the artificial terminal; no real CLI is resolved.
  if (!fakeExit) ptyTerminal.kill();
  await ptyTerminal._agent._conoutSocketWorker._worker.terminate();
  process.exit(fakeExit ? 0 : 1);
} else {
  assert.equal(process.platform, 'win32');
  for (const delayMs of [0, 2500]) {
    const home = mkdtempSync(join(tmpdir(), 'tl-exit-diagnosis-'));
    try {
      const child = spawn(process.execPath, [import.meta.filename, '--child', home, String(delayMs)], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      let stdout = '', stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      const watchdog = setTimeout(() => child.kill(), 15000);
      const result = await new Promise((resolve,reject) => { child.on('error',reject);child.on('close',(code,signal)=>resolve({code,signal})); });
      clearTimeout(watchdog);
      console.log(JSON.stringify({ delayMs, ...result, stdout, stderr }));
      assert.equal(result.code, 0, stderr);
      const observation = JSON.parse(stdout.trim());
      assert.ok(observation.fakeExit);
    } finally { rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  }
}
