import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runWithPty } from './pty-run.mjs';

const decode = encoded => Buffer.from(encoded, 'base64').toString('utf16le');

test('runWithPty: macOS は script の擬似端末、Windows は新しい console の pwsh、ほかは未対応', () => {
  const calls = [];
  const spawnImpl = (command, args, options) => { calls.push({ command, args, options }); return { status: 0, stdout: 'ok', stderr: '' }; };
  const mac = runWithPty('claude', ['--desktop', '--resume', 'id'], { platform: 'darwin', spawnImpl, cwd: '/p' });
  assert.deepEqual([calls[0].command, calls[0].args], ['/usr/bin/script', ['-q', '/dev/null', 'claude', '--desktop', '--resume', 'id']]);
  assert.deepEqual([calls[0].options.cwd, calls[0].options.stdio], ['/p', ['ignore', 'pipe', 'pipe']]);
  assert.equal(mac.outputUnavailable, undefined);

  const win = runWithPty('claude', ['--desktop', '--resume', "it's"], { platform: 'win32', spawnImpl, cwd: 'C:\\p' });
  assert.equal(calls[1].command, 'pwsh.exe');
  assert.deepEqual(calls[1].args.slice(0, 4), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand']);
  const outer = decode(calls[1].args[4]);
  assert.match(outer, /^\$p = Start-Process -FilePath pwsh\.exe -ArgumentList @\('-NoProfile','-EncodedCommand','[A-Za-z0-9+/=]+'\) -WindowStyle Minimized -Wait -PassThru; exit \$p\.ExitCode$/);
  // fox の実測（2026-10-08）: 新しい console の中の終了 code は、断られた時 1、開けた時 0。
  assert.equal(decode(/'-EncodedCommand','([A-Za-z0-9+/=]+)'/.exec(outer)[1]), "& 'claude' '--desktop' '--resume' 'it''s'; exit $LASTEXITCODE");
  assert.deepEqual([calls[1].options.cwd, calls[1].options.windowsHide], ['C:\\p', true]);
  assert.deepEqual([win.status, win.outputUnavailable], [0, true], 'console へ出た文は読めないので、終了 code で成否を見る');

  assert.equal(runWithPty('claude', ['--desktop'], { platform: 'linux', spawnImpl }), null);
  assert.equal(calls.length, 2);
});
