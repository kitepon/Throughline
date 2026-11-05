// 試験が作る一時フォルダを、その試験 file の process が終わる時に消す。
// CI のランナーは使い捨てではないので、消さないと回ごとに OS の一時フォルダへ積もる
// （rabbit の /tmp に 3,026 個。2026-10-13 の計測）。
import { lstatSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const created = [];
const inspected = new Set();

process.on('exit', () => {
  for (const dir of created) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch (error) {
      // 開いたままの file が残る時（Windows）は消せない。試験の成否は変えない。
      process.stderr.write(`[test-temp-dir] cleanup failed: ${error.message}\n`);
    }
  }
});

export function testTempDir(prefix) {
  const tmp = tmpdir();
  if (!inspected.has(prefix)) {
    for (const entry of readdirSync(tmp, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
      const suffix = /^(\d+)-[A-Za-z0-9]{6}$/.exec(entry.name.slice(prefix.length));
      if (!suffix) continue;
      const path = join(tmp, entry.name);
      try {
        const stat = lstatSync(path);
        if (Date.now() - stat.mtimeMs <= 24 * 3600000 || (process.getuid && stat.uid !== process.getuid())) continue;
        try { process.kill(Number(suffix[1]), 0); }
        catch (error) { if (error.code === 'ESRCH') rmSync(path, { recursive: true, force: true }); }
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    inspected.add(prefix);
  }
  const dir = mkdtempSync(join(tmp, `${prefix}${process.pid}-`));
  created.push(dir);
  return dir;
}
