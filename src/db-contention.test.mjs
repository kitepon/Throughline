import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DB_MODULE_URL = pathToFileURL(fileURLToPath(new URL('./db.mjs', import.meta.url))).href;

function waitForLine(stream, expected) {
  return new Promise((resolve, reject) => {
    let output = '';
    const onData = (chunk) => {
      output += chunk;
      if (output.includes(expected)) {
        stream.off('data', onData);
        resolve();
      }
    };
    stream.on('data', onData);
    stream.once('error', reject);
  });
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stderr }));
  });
}

test('getDb configures a bounded SQLite busy timeout for concurrent hook processes', () => {
  const home = mkdtempSync(join(tmpdir(), 'throughline-db-timeout-'));
  try {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { getDb } from ${JSON.stringify(DB_MODULE_URL)};
      const db = getDb();
      process.stdout.write(String(db.prepare('PRAGMA busy_timeout').get().timeout));
      db.close();
    `], {
      env: { ...process.env, HOME: home, USERPROFILE: home },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '5000');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('getDb reuses an existing WAL database while another process owns the writer lock', async () => {
  const home = mkdtempSync(join(tmpdir(), 'throughline-db-contention-'));
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  const initialize = spawn(process.execPath, ['--input-type=module', '-e', `
    import { getDb } from ${JSON.stringify(DB_MODULE_URL)};
    getDb().close();
  `], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  assert.deepEqual(await waitForExit(initialize), { code: 0, stderr: '' });

  const holder = spawn(process.execPath, ['--input-type=module', '-e', `
    import { DatabaseSync } from 'node:sqlite';
    import { join } from 'node:path';
    const db = new DatabaseSync(join(process.env.HOME, '.throughline', 'throughline.db'));
    db.exec('CREATE TABLE IF NOT EXISTS contention_probe (value TEXT)');
    db.exec("BEGIN IMMEDIATE; INSERT INTO contention_probe VALUES ('held')");
    process.stdout.write('locked\\n');
    setTimeout(() => {
      db.exec('COMMIT');
      db.close();
    }, 500);
  `], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  await waitForLine(holder.stdout, 'locked\n');

  const contender = spawn(process.execPath, ['--input-type=module', '-e', `
    import { getDb } from ${JSON.stringify(DB_MODULE_URL)};
    const db = getDb();
    const mode = db.prepare('PRAGMA journal_mode').get().journal_mode;
    db.close();
    if (String(mode).toLowerCase() !== 'wal') process.exit(2);
  `], { env, stdio: ['ignore', 'ignore', 'pipe'] });

  const [holderResult, contenderResult] = await Promise.all([
    waitForExit(holder),
    waitForExit(contender),
  ]);
  try {
    assert.deepEqual(holderResult, { code: 0, stderr: '' });
    assert.deepEqual(contenderResult, { code: 0, stderr: '' });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('getDbは、新しいDBを複数のprocessが同時に開いても、全員が現行schemaで開ける', async () => {
  // WindowsのCursorの会話では同じhookが2本ほぼ同時に走る。初回はどのprocessも版0を読むので、lockの外で読んだ版から
  // 移行をやり直すと、先に進んだprocessが消した表へ触って落ちた（修理前は6本で半分ほどの確率）。
  const rounds = 6;
  const processes = 6;
  for (let round = 0; round < rounds; round += 1) {
    const home = mkdtempSync(join(tmpdir(), 'throughline-db-first-open-'));
    const env = { ...process.env, HOME: home, USERPROFILE: home };
    try {
      const results = await Promise.all(Array.from({ length: processes }, () => {
        const child = spawn(process.execPath, ['--input-type=module', '-e', `
          import { getDb, CURRENT_VERSION } from ${JSON.stringify(DB_MODULE_URL)};
          const db = getDb();
          const version = db.prepare('PRAGMA user_version').get().user_version;
          db.prepare('SELECT count(*) AS n FROM sessions').get();
          db.close();
          if (version !== CURRENT_VERSION) process.exit(2);
        `], { env, stdio: ['ignore', 'ignore', 'pipe'] });
        return waitForExit(child);
      }));
      assert.deepEqual(results, Array.from({ length: processes }, () => ({ code: 0, stderr: '' })));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }
});
