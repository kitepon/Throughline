import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const BIN = join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))), 'bin/throughline.mjs');
const posix = process.platform !== 'win32';

function sandbox(t) {
  const root = mkdtempSync(join(tmpdir(), 'tl-storage-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  mkdirSync(home);
  const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_STATE_HOME: join(root, 'xdg-state'),
    XDG_CONFIG_HOME: join(root, 'xdg-config'), LOCALAPPDATA: join(root, 'local') };
  delete env.THROUGHLINE_HOME;
  return { root, home, env };
}

function cli(args, env) {
  const result = spawnSync(process.execPath, [BIN, 'storage', ...args], { env, encoding: 'utf8' });
  return { code: result.status, json: JSON.parse(result.stdout), stderr: result.stderr };
}

test('locate reports defaults and THROUGHLINE_HOME without creating anything', (t) => {
  const { root, home, env } = sandbox(t);
  const defaults = cli(['locate', '--json'], env);
  assert.equal(defaults.code, 0);
  assert.equal(defaults.json.schema, 'throughline.storage_locations.v1');
  assert.equal(defaults.json.source, 'default');
  assert.equal(defaults.json.roots.data, join(home, '.throughline'));
  if (posix) assert.equal(defaults.json.roots.appState, join(root, 'xdg-state', 'throughline'));

  const custom = cli(['locate', '--json'], { ...env, THROUGHLINE_HOME: 'tl' });
  assert.equal(custom.json.source, 'THROUGHLINE_HOME');
  assert.deepEqual(custom.json.roots, {
    data: join(home, 'tl'), appState: join(home, 'tl', 'app-state'), appConfig: join(home, 'tl', 'app-config'),
  });
  assert.equal(custom.json.database, join(home, 'tl', 'throughline.db'));
  assert.equal(existsSync(join(home, 'tl')), false);
  assert.equal(existsSync(join(home, '.throughline')), false);
});

test('export copies a default layout into a THROUGHLINE_HOME layout that locate then points at', (t) => {
  const { root, home, env } = sandbox(t);
  const data = join(home, '.throughline');
  mkdirSync(join(data, 'logs'), { recursive: true });
  mkdirSync(join(data, 'haiku-workdir'));
  writeFileSync(join(data, 'haiku-workdir', 'x'), 'derived');
  writeFileSync(join(data, 'logs', 'backfill.log'), 'line\n');
  writeFileSync(join(data, 'logs', '.log-retention.sqlite'), '');
  writeFileSync(join(data, '.state.123.tmp'), 'partial');
  const db = new DatabaseSync(join(data, 'throughline.db'));
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE t(v TEXT); INSERT INTO t VALUES ('kept');");
  const state = cli(['locate', '--json'], env).json.roots.appState;
  mkdirSync(join(state, 'completed-turn-receipts'), { recursive: true });
  writeFileSync(join(state, 'completed-turn-receipts', 'a.json'), '{"ok":true}', { mode: 0o600 });
  if (posix) chmodSync(join(state, 'completed-turn-receipts', 'a.json'), 0o600);
  writeFileSync(join(state, 'completed-turn-receipts', 'a.json.lock.sqlite'), '');

  const to = join(root, 'export');
  const result = cli(['export', '--to', to, '--json'], env);
  db.close();
  assert.equal(result.code, 0, JSON.stringify(result.json));
  assert.equal(result.json.status, 'complete');
  assert.equal(result.json.sqlite, 1);
  assert.equal(result.json.files, 2);

  const copy = new DatabaseSync(join(to, 'throughline.db'), { readOnly: true });
  assert.deepEqual(copy.prepare('SELECT v FROM t').all().map((row) => row.v), ['kept']);
  copy.close();
  assert.equal(readFileSync(join(to, 'logs', 'backfill.log'), 'utf8'), 'line\n');
  assert.equal(readFileSync(join(to, 'app-state', 'completed-turn-receipts', 'a.json'), 'utf8'), '{"ok":true}');
  if (posix) assert.equal(statSync(join(to, 'app-state', 'completed-turn-receipts', 'a.json')).mode & 0o777, 0o600);
  for (const absent of ['haiku-workdir', 'throughline.db-wal', '.state.123.tmp', 'logs/.log-retention.sqlite',
    'app-state/completed-turn-receipts/a.json.lock.sqlite']) {
    assert.equal(existsSync(join(to, absent)), false, absent);
  }

  const moved = cli(['locate', '--json'], { ...env, THROUGHLINE_HOME: to }).json;
  assert.equal(moved.database, join(to, 'throughline.db'));
  assert.equal(existsSync(join(moved.roots.appState, 'completed-turn-receipts', 'a.json')), true);
});

test('export refuses a non-empty target or one inside a source root, writing nothing', (t) => {
  const { root, home, env } = sandbox(t);
  mkdirSync(join(home, '.throughline'));
  const busy = join(root, 'busy');
  mkdirSync(busy);
  writeFileSync(join(busy, 'keep'), 'mine');
  const notEmpty = cli(['export', '--to', busy, '--json'], env);
  assert.equal(notEmpty.code, 1);
  assert.equal(notEmpty.json.code, 'storage_export_target_not_empty');
  assert.equal(readFileSync(join(busy, 'keep'), 'utf8'), 'mine');

  const nested = join(home, '.throughline', 'backup');
  const insideSource = cli(['export', '--to', nested, '--json'], env);
  assert.equal(insideSource.json.code, 'storage_export_target_inside_source');
  assert.equal(existsSync(nested), false);

  assert.equal(cli(['export', '--json'], env).code, 2);
});

test('THROUGHLINE_HOME moves the database and the app state stores', (t) => {
  const { home, env } = sandbox(t);
  const script = [
    "const db = await import('./src/db.mjs');",
    "const receipts = await import('./src/completed-turn-receipts.mjs');",
    "const errors = await import('./src/runtime-error-store.mjs');",
    "console.log(JSON.stringify([db.DB_PATH, receipts.defaultCompletedTurnReceiptStorePath('0'.repeat(64)),",
    "  errors.defaultRuntimeErrorStorePath(), errors.defaultRuntimeErrorConfigPath()]));",
  ].join('\n');
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: dirname(dirname(BIN)), env: { ...env, THROUGHLINE_HOME: join(home, 'tl') }, encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const tl = join(home, 'tl');
  assert.deepEqual(JSON.parse(result.stdout), [
    join(tl, 'throughline.db'),
    join(tl, 'app-state', 'completed-turn-receipts', `${'0'.repeat(64)}.json`),
    join(tl, 'app-state', 'runtime-errors.json'),
    join(tl, 'app-config', 'runtime-errors.config.json'),
  ]);
});
