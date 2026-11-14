import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const BIN = join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))), 'bin/throughline.mjs');

function throughline(args, home, cwd) {
  const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, '.config'),
    XDG_STATE_HOME: join(home, '.state'), LOCALAPPDATA: join(home, 'local'), THROUGHLINE_NO_VSCODE: '1',
    THROUGHLINE_SUPPRESS_VSCODE_NOTICES: '1' };
  delete env.THROUGHLINE_HOME;
  const result = spawnSync(process.execPath, [BIN, ...args], { env, cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

const json = (path) => JSON.parse(readFileSync(path, 'utf8'));

test('harness-entries lists exactly the native entries install writes (bellteam.harness-entries.v1)', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'tl-harness-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const project = join(root, 'project');
  mkdirSync(home);
  mkdirSync(project);
  throughline(['install'], home, project);
  const e1 = JSON.parse(throughline(['harness-entries', '--json'], home, project));
  assert.equal(e1.schema, 'bellteam.harness-entries.v1');
  assert.equal(e1.product, 'throughline');
  assert.deepEqual(e1.settings, { codex: { 'features.hooks': true } });
  assert.deepEqual(JSON.parse(throughline(['harness-entries', '--json', '--home', home], root, project)), e1);

  const files = {
    claude: json(join(home, '.claude', 'settings.json')).hooks,
    codex: json(join(home, '.codex', 'hooks.json')).hooks,
    cursor: json(join(home, '.cursor', 'hooks.json')).hooks,
  };
  for (const [harness, events] of Object.entries(files)) {
    for (const [event, items] of Object.entries(e1.hooks[harness])) {
      for (const item of items) assert.ok(events[event].some((written) => isDeepStrictEqual(written, item)), `${harness} ${event}`);
    }
    // Every item install wrote is identified by owns.commandIncludes, and nothing else is in these fresh files.
    for (const items of Object.values(events)) {
      for (const command of items.flatMap((item) => item.hooks ?? [item]).map((hook) => hook.command)) {
        assert.ok(e1.owns.commandIncludes.some((part) => command.includes(part)), command);
      }
    }
    assert.equal(Object.values(events).flat().length, Object.values(e1.hooks[harness]).flat().length, harness);
  }
  assert.deepEqual(json(join(home, '.grok', 'hooks', 'throughline.json')), e1.hooks.grok);
  assert.match(readFileSync(join(home, '.codex', 'config.toml'), 'utf8'), /^\[features\]\nhooks = true$/m);
});

test('install --own-files places only Throughline\'s own files and leaves every shared file alone (ADR 0074 step 3)', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'tl-own-files-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const project = join(root, 'project');
  mkdirSync(join(home, '.codex'), { recursive: true });
  mkdirSync(project);
  const config = '[features]\nhooks = false\ncodex_hooks = false\n';
  writeFileSync(join(home, '.codex', 'config.toml'), config);
  throughline(['install', '--own-files'], home, project);
  for (const name of ['tl.md', 'sc-detail.md']) assert.ok(existsSync(join(home, '.claude', 'commands', name)), name);
  assert.ok(existsSync(join(home, '.codex', 'skills', 'throughline', 'SKILL.md')));
  assert.equal(readFileSync(join(home, '.codex', 'config.toml'), 'utf8'), config);
  for (const shared of [['.claude', 'settings.json'], ['.codex', 'hooks.json'], ['.cursor', 'hooks.json'],
    ['.grok', 'hooks', 'throughline.json'], ['.cursor'], ['.grok']]) {
    assert.ok(!existsSync(join(home, ...shared)), shared.join('/'));
  }
  assert.ok(!existsSync(join(project, '.vscode')));
});
