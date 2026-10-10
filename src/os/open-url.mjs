/**
 * os/open-url.mjs — deep link / URL を OS 既定の handler で開く
 *
 * darwin: `open` / win32: `cmd /c start` / その他: `xdg-open`。
 * 呼び出し元は result.status !== 0 を explicit failure として扱う。
 */
import { spawnSync } from 'node:child_process';

export function openUrlWithOsHandler(url, {
  platform = process.platform,
  spawnImpl = spawnSync,
} = {}) {
  if (platform === 'darwin') return spawnImpl('open', [url], { encoding: 'utf8' });
  // cmd.exe 自身の窓は隠す（console を持たない worker から呼ぶと、窓が一瞬出る）。start が開く先の窓は、これでは隠れない。
  if (platform === 'win32') return spawnImpl('cmd.exe', ['/c', 'start', '', url], { encoding: 'utf8', windowsHide: true });
  return spawnImpl('xdg-open', [url], { encoding: 'utf8' });
}
