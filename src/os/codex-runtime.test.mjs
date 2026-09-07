import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveCodexRuntime } from './codex-runtime.mjs';

test('Windows Desktopは稼働中アプリのCodexを使う', () => {
  const runtime = resolveCodexRuntime({ platform: 'win32', host: 'desktop',
    discover: () => ['C:\\Codex\\codex.exe', 'C:\\Codex\\codex.exe'] });
  assert.equal(runtime.command, 'C:\\Codex\\codex.exe');
  assert.deepEqual(runtime.commandArgs, ['app-server', '--listen', 'stdio://']);
  assert.equal(runtime.source, 'desktop-process');
});

test('明示したapp-serverはDesktopの探索より優先する', () => {
  const runtime = resolveCodexRuntime({ platform: 'win32', host: 'desktop', override: 'fake.mjs',
    discover: () => { throw new Error('探索してはいけない'); } });
  assert.equal(runtime.command, 'fake.mjs');
  assert.deepEqual(runtime.commandArgs, []);
});

test('対象外のOSとhostは従来のCodexを使う', () => {
  for (const [platform, host] of [['darwin', 'desktop'], ['win32', 'cli'], ['win32', 'vscode']]) {
    assert.equal(resolveCodexRuntime({ platform, host }).command, 'codex');
  }
});

test('Desktopの実体がない場合や複数ある場合は古いCLIへ切り替えない', () => {
  for (const candidates of [[], ['C:\\one\\codex.exe', 'C:\\two\\codex.exe']]) {
    assert.throws(() => resolveCodexRuntime({ platform: 'win32', host: 'desktop',
      discover: () => candidates }), /Codex Desktop/);
  }
});
