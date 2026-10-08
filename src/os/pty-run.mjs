/**
 * os/pty-run.mjs — 端末を要求するコマンドを、端末の無い process から呼ぶ
 *
 * darwin: `script -q /dev/null <command> <args…>` が擬似端末を作る。出力を読める。
 * win32 : PowerShell の `Start-Process -Wait -PassThru` で、新しい console（最小化）の中の pwsh にコマンドを実行させ、
 *         その終了 code を受け取る。出力はその console に出るので読めない（`outputUnavailable: true`）。
 *         `cmd /c start /wait` は、中のコマンドが失敗しても 0 を返した（Windows で実測）ので使わない。
 * 他の OS は未対応で、null を返す（呼び出し元が見送る）。
 */
import { spawnSync } from 'node:child_process';

const psQuote = value => `'${String(value).replaceAll("'", "''")}'`;
const psEncoded = script => Buffer.from(script, 'utf16le').toString('base64');

export function runWithPty(command, args, { platform = process.platform, spawnImpl = spawnSync, ...options } = {}) {
  if (platform === 'darwin') {
    return spawnImpl('/usr/bin/script', ['-q', '/dev/null', command, ...args],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options });
  }
  if (platform === 'win32') {
    const inner = `& ${[command, ...args].map(psQuote).join(' ')}; exit $LASTEXITCODE`;
    const outer = `$p = Start-Process -FilePath pwsh.exe -ArgumentList @('-NoProfile','-EncodedCommand',${psQuote(psEncoded(inner))}) ` +
      '-WindowStyle Minimized -Wait -PassThru; exit $p.ExitCode';
    const result = spawnImpl('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', psEncoded(outer)],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, ...options });
    return { ...result, outputUnavailable: true };
  }
  return null;
}
