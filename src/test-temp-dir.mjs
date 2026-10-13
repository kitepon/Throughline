// 試験が作る一時フォルダを、その試験 file の process が終わる時に消す。
// CI のランナーは使い捨てではないので、消さないと回ごとに OS の一時フォルダへ積もる
// （rabbit の /tmp に 3,026 個。2026-10-13 の計測）。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const created = [];

process.on('exit', () => {
  for (const dir of created) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      // 開いたままの file が残る時（Windows）は消せない。試験の成否は変えない。
    }
  }
});

export function testTempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}
