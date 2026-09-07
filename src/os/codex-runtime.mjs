import { spawnPortableSync } from './portable-spawn-sync.mjs';

function discoverWindowsDesktopCodex() {
  const result = spawnPortableSync('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `
$ErrorActionPreference = 'Stop'
$processes = @(Get-CimInstance Win32_Process)
$paths = @($processes | Where-Object { $_.Name -eq 'codex.exe' } | ForEach-Object {
  $child = $_
  $parent = $processes | Where-Object { $_.ProcessId -eq $child.ParentProcessId }
  if ($parent.ExecutablePath -match '[\\\\/]OpenAI\\.Codex_[^\\\\/]+[\\\\/]app[\\\\/]ChatGPT\\.exe$' -and $child.ExecutablePath) {
    $child.ExecutablePath
  }
})
ConvertTo-Json -InputObject $paths -Compress
`], { encoding: 'utf8', timeout: 15000 });
  if (result.error || result.status !== 0) {
    throw new Error(`Codex Desktopの実行ファイルを取得できません: ${result.error?.message ?? result.stderr.trim()}`);
  }
  return JSON.parse(result.stdout.trim());
}

export function resolveCodexRuntime({ host, override = null, platform = process.platform,
  discover = discoverWindowsDesktopCodex } = {}) {
  if (override) return { command: override, commandArgs: [], source: 'explicit' };
  const commandArgs = ['app-server', '--listen', 'stdio://'];
  if (platform !== 'win32' || host !== 'desktop') {
    return { command: 'codex', commandArgs, source: 'path' };
  }
  const candidates = [...new Set(discover())];
  if (candidates.length !== 1) {
    throw new Error(candidates.length === 0
      ? '稼働中のCodex Desktopの実行ファイルが見つかりません。アプリを起動してから再実行してください。'
      : '複数のCodex Desktop実行ファイルが稼働しています。使用するアプリだけを残して再実行してください。');
  }
  return { command: candidates[0], commandArgs, source: 'desktop-process' };
}
