import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { loadWindowsTerminalRuntime } from './windows-terminal-runtime.mjs';
import { portableInvocation, spawnPortableSync } from './portable-spawn-sync.mjs';

/** Own a hidden terminal instead of a shared Claude daemon. Output is deliberately not logged. */
export async function startClaudeTerminal(args, { sessionId, cwd, env, platform = process.platform,
  loadPty = () => platform === 'win32' ? loadWindowsTerminalRuntime() : import('node-pty') } = {}) {
  const terminalEnv = Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith('CLAUDE_BG_')));
  const [command, argv] = portableInvocation('claude',
    ['--session-id', sessionId, ...args.filter(arg => arg !== '--bg')], { env: terminalEnv, platform });
  // A batch-only shim can leave an interactive command shell alive without ever
  // starting Claude. npm's paired .ps1 shim and native executables are supported.
  if (platform === 'win32' && ['.cmd', '.bat'].includes(extname(command).toLowerCase())) {
    throw new Error('handoff_terminal_batch_shim_unsupported');
  }
  const pty = await loadPty();
  const terminal = pty.spawn(command, argv, { cwd, env: terminalEnv, cols: 120, rows: 40, name: 'xterm-256color' });
  let exit = null;
  let resolveExit;
  const ended = new Promise(resolve => { resolveExit = resolve; });
  terminal.onData(data => {
    // Answer terminal capability queries without touching the user's screen or keyboard.
    if (data.includes('\x1b[6n')) terminal.write('\x1b[1;1R');
    if (data.includes('\x1b[c')) terminal.write('\x1b[?1;2c');
  });
  terminal.onExit(event => { exit = event; resolveExit(event); });
  return { pid: terminal.pid, get exit() { return exit; }, ended };
}

/** Read only the native registration belonging to this exact successor. */
export function readClaudeTerminalRemoteControl(sessionId, { env = process.env } = {}) {
  const directory = join(env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'sessions');
  let names;
  try { names = readdirSync(directory); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  for (const name of names) {
    if (!/^\d+\.json$/.test(name)) continue;
    let text;
    try { text = readFileSync(join(directory, name), 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    let metadata;
    try { metadata = JSON.parse(text); }
    catch { continue; } // A native process can still be writing its metadata.
    if (metadata.sessionId === sessionId && /^session_[A-Za-z0-9]+$/.test(metadata.bridgeSessionId ?? '')) {
      return `https://claude.ai/code/${metadata.bridgeSessionId}`;
    }
  }
  return null;
}

// Only paths enter the process command line. Environment values travel over stdin into WMI,
// never into a bootstrap file or the PowerShell command line.
const WMI_START = `
$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'
[Console]::InputEncoding=[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$j=[Console]::In.ReadToEnd() | ConvertFrom-Json
$startup=New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{
  ShowWindow=[uint16]0; CreateFlags=[uint32]16778248; EnvironmentVariables=[string[]]$j.environment
}
$result=Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
  CommandLine=[string]$j.commandLine; CurrentDirectory=[string]$j.cwd; ProcessStartupInformation=$startup
}
@{returnValue=$result.ReturnValue;pid=$result.ProcessId} | ConvertTo-Json -Compress
`;

/** Start outside the host's cancellation job, keeping the caller's user and environment. */
export function startWindowsClaudeWorker({ sessionId, cliPath, logPath, env = process.env,
  nodePath = process.execPath, spawn = spawnPortableSync }) {
  mkdirSync(dirname(logPath), { recursive: true, mode: 0o700 });
  const bootstrap = join(dirname(logPath), `${sessionId}.${randomUUID()}.worker.mjs`);
  const argv = [nodePath, cliPath, 'auto-handoff', 'worker', '--host', 'claude', '--operation', sessionId, '--json'];
  // No prompt, credentials, or environment are written into this short-lived file.
  const code = `import {openSync,writeSync,closeSync,unlinkSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
unlinkSync(fileURLToPath(import.meta.url));
const fd=openSync(${JSON.stringify(logPath)},'a',0o600);
const write=(chunk,encoding,callback)=>{writeSync(fd,chunk);if(typeof encoding==='function')encoding();else callback?.();return true;};
process.stdout.write=write;process.stderr.write=write;
process.on('exit',()=>closeSync(fd));
process.argv=${JSON.stringify(argv)};
await import(${JSON.stringify(pathToFileURL(cliPath).href)});
`;
  writeFileSync(bootstrap, code, { mode: 0o600, flag: 'wx' });
  const quote = value => `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
  const result = spawn('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(WMI_START, 'utf16le').toString('base64')], {
    env, encoding: 'utf8', timeout: 15_000, stdio: ['pipe', 'pipe', 'pipe'],
    input: JSON.stringify({ commandLine: `${quote(nodePath)} ${quote(bootstrap)}`, cwd: dirname(logPath),
      environment: Object.entries(env).filter(([, value]) => typeof value === 'string').map(([key, value]) => `${key}=${value}`) }),
  });
  if (result.error || result.status !== 0) {
    if (result.error?.code === 'ENOENT') {
      rmSync(bootstrap, { force: true });
      throw new Error('handoff_windows_worker_start_failed');
    }
    const error = new Error('handoff_windows_worker_start_unconfirmed');
    error.code = 'handoff_worker_start_unconfirmed';
    throw error;
  }
  let response;
  try { response = JSON.parse(result.stdout); }
  catch {
    const error = new Error('handoff_windows_worker_start_unconfirmed');
    error.code = 'handoff_worker_start_unconfirmed';
    throw error;
  }
  if (response.returnValue !== 0 || !Number.isInteger(response.pid) || response.pid <= 0) {
    rmSync(bootstrap, { force: true });
    throw new Error('handoff_windows_worker_start_failed');
  }
  return response.pid;
}
