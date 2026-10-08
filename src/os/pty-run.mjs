/**
 * os/pty-run.mjs — 端末を要求するコマンドを、端末の無い process から呼ぶ
 *
 * darwin: `script -q /dev/null <command> <args…>` が擬似端末を作る。
 * 他の OS は未対応で、null を返す（呼び出し元が見送る）。
 */
import { spawnSync } from 'node:child_process';

export function runWithPty(command, args, { platform = process.platform, spawnImpl = spawnSync, ...options } = {}) {
  if (platform !== 'darwin') return null;
  return spawnImpl('/usr/bin/script', ['-q', '/dev/null', command, ...args],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options });
}
