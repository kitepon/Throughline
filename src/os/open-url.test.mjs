import test from 'node:test';
import assert from 'node:assert/strict';
import { openUrlWithOsHandler } from './open-url.mjs';

test('openUrlWithOsHandler: OS ごとの命令で開き、Windows では cmd.exe の窓を隠す', () => {
  const calls = [];
  const spawnImpl = (command, args, options) => { calls.push({ command, args, options }); return { status: 0 }; };
  openUrlWithOsHandler('codex://threads/abc', { platform: 'win32', spawnImpl });
  openUrlWithOsHandler('codex://threads/abc', { platform: 'darwin', spawnImpl });
  openUrlWithOsHandler('codex://threads/abc', { platform: 'linux', spawnImpl });
  assert.deepEqual(calls[0], { command: 'cmd.exe', args: ['/c', 'start', '', 'codex://threads/abc'], options: { encoding: 'utf8', windowsHide: true } });
  assert.deepEqual([calls[1].command, calls[1].args], ['open', ['codex://threads/abc']]);
  assert.deepEqual([calls[2].command, calls[2].args], ['xdg-open', ['codex://threads/abc']]);
});
