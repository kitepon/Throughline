import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { appendBoundedLog, LOG_MAX_BYTES } from './bounded-log.mjs';
import { testTempDir } from './test-temp-dir.mjs';

test('normal appends retain exact JSONL and bound the current and previous generation', () => {
  const dir = testTempDir('tl-log-retention-'), path = join(dir, 'events.log');
  const line = JSON.stringify({ text: 'あ'.repeat(1000) }) + '\n';
  const count = Math.floor(LOG_MAX_BYTES / Buffer.byteLength(line));
  writeFileSync(path, line.repeat(count));
  appendBoundedLog(path, '{"new":true}\n');
  // Fill the small remainder to force the next append through rotation.
  appendBoundedLog(path, line);
  assert.ok(statSync(path).size <= LOG_MAX_BYTES);
  assert.ok(statSync(`${path}.1`).size <= LOG_MAX_BYTES);
  assert.equal(readFileSync(path, 'utf8'), line);
  assert.ok(readFileSync(`${path}.1`, 'utf8').endsWith('{"new":true}\n'));
});

test('a legacy oversized file is reclaimed on its next ordinary append', () => {
  const dir = testTempDir('tl-log-legacy-'), path = join(dir, 'events.log');
  writeFileSync(path, '{"old":true}\n'.repeat(LOG_MAX_BYTES / 4));
  appendBoundedLog(path, '{"latest":true}\n');
  assert.equal(readFileSync(path, 'utf8'), '{"latest":true}\n');
  assert.ok(statSync(`${path}.1`).size <= LOG_MAX_BYTES);
  for (const line of readFileSync(`${path}.1`, 'utf8').trim().split('\n')) assert.deepEqual(JSON.parse(line), { old: true });
  assert.deepEqual(readdirSync(dir).filter(name => name.endsWith('.tmp')), []);
});

test('concurrent processes preserve every new record across rotation', async () => {
  const dir = testTempDir('tl-log-concurrent-'), path = join(dir, 'events.log');
  writeFileSync(path, 'x'.repeat(LOG_MAX_BYTES - 1) + '\n');
  const module = new URL('./bounded-log.mjs', import.meta.url).href;
  await Promise.all(Array.from({ length: 4 }, (_, id) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e',
      `import {appendBoundedLog} from ${JSON.stringify(module)}; for(let n=0;n<50;n++) appendBoundedLog(${JSON.stringify(path)},JSON.stringify({id:${id},n})+'\\n');`], { stdio: 'pipe' });
    let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(stderr)));
  })));
  const entries = readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(entries.length, 200);
  assert.equal(new Set(entries.map(({ id, n }) => `${id}/${n}`)).size, 200);
});

test('rejects an oversized entry without altering the existing diagnostic', () => {
  const dir = testTempDir('tl-log-invalid-'), path = join(dir, 'events.log');
  writeFileSync(path, 'keep\n');
  assert.throws(() => appendBoundedLog(path, 'x'.repeat(LOG_MAX_BYTES + 1)), /entry_too_large/);
  assert.equal(readFileSync(path, 'utf8'), 'keep\n');
  assert.equal(existsSync(`${path}.1`), false);
});

test('does not overwrite a log symlink', { skip: process.platform === 'win32' }, () => {
  const dir = testTempDir('tl-log-link-'), path = join(dir, 'events.log'), other = join(dir, 'other');
  writeFileSync(other, 'keep'); symlinkSync(other, path);
  assert.throws(() => appendBoundedLog(path, 'new\n'), /regular_file_required/);
  assert.equal(readFileSync(other, 'utf8'), 'keep');
});
