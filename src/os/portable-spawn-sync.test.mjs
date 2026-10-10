import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { portableInvocation, spawnPortable, spawnPortableSync } from './portable-spawn-sync.mjs';
import { createInterface } from 'node:readline';
import { once } from 'node:events';

test('spawnPortableSync: Windows cmd shim preserves argv boundaries and stdin', {
  skip: process.platform !== 'win32' ? 'Windows cmd shim contract' : undefined,
}, () => {
  const dir = mkdtempSync(join(tmpdir(), 'tl-portable-spawn-'));
  try {
    const child = join(dir, 'child.mjs');
    const command = join(dir, 'child.cmd');
    const powerShellShim = join(dir, 'child.ps1');
    writeFileSync(child, `
process.stdin.setEncoding('utf8');
let input = '';
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify({ args: process.argv.slice(2), input }));
});

`);
    writeFileSync(command, `@echo off\r\n${JSON.stringify(process.execPath)} ${JSON.stringify(child)} %*\r\n`);
    writeFileSync(powerShellShim, `& ${JSON.stringify(process.execPath)} ${JSON.stringify(child)} @args\nexit $LASTEXITCODE\n`);

    const result = spawnPortableSync(command, ['review prompt', 'a&b', '100%'], {
      encoding: 'utf8',
      input: 'stdin body',
    });

    assert.equal(result.status, 0, result.stderr || result.error?.message);
    assert.deepEqual(JSON.parse(result.stdout), {
      args: ['review prompt', 'a&b', '100%'],
      input: 'stdin body',
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


test('WindowsのPATHにあるnpm起動ファイルと標準入出力で往復できる', {
  skip: process.platform !== 'win32',
  timeout: 10_000,
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tl-npm-stream-'));
  let child;
  try {
    const script = join(dir, 'rpc.mjs');
    writeFileSync(script, `
import { createInterface } from 'node:readline';
createInterface({ input: process.stdin }).on('line', (line) => {
  process.stdout.write(JSON.stringify({ line, args: process.argv.slice(2) }) + '\\n');
});
`);
    // npmのPowerShell起動ファイルと同じ入力分岐で、EOF前の応答を確かめる。
    writeFileSync(join(dir, 'tl-rpc.ps1'), `
if ($MyInvocation.ExpectingInput) {
  $input | & ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} @args
} else {
  & ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} @args
}
exit $LASTEXITCODE
`);
    const env = { ...process.env };
    const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path');
    env[pathKey] = `${dir};${env[pathKey]}`;
    const args = ['空白 を含む', 'a&b', '100%'];
    const sync = spawnPortableSync('tl-rpc', args, { env, encoding: 'utf8', input: '同期\n' });
    assert.equal(sync.status, 0, sync.stderr || sync.error?.message);
    assert.deepEqual(JSON.parse(sync.stdout), { line: '同期', args });
    child = spawnPortable('tl-rpc', args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    const lines = createInterface({ input: child.stdout });
    for (const line of ['初期化', '次の要求']) {
      const response = once(lines, 'line');
      child.stdin.write(`${line}\n`);
      assert.deepEqual(JSON.parse((await response)[0]), { line, args });
    }
    const closed = once(child, 'close');
    child.stdin.end();
    assert.equal((await closed)[0], 0);
  } finally {
    child?.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('portableInvocation: 窓を隠す指定を既定で付ける。呼び出し側が false を渡した時だけ外す', () => {
  for (const platform of ['win32', 'linux', 'darwin']) {
    const [, , hidden] = portableInvocation('claude', ['agents', '--json', '--all'], { platform, env: { PATH: '' }, encoding: 'utf8' });
    assert.equal(hidden.windowsHide, true, platform);
    assert.equal(hidden.shell, false); assert.equal(hidden.encoding, 'utf8'); assert.equal('platform' in hidden, false);
    const [, , shown] = portableInvocation('claude', ['agents'], { platform, env: { PATH: '' }, windowsHide: false });
    assert.equal(shown.windowsHide, false, platform);
  }
});

test('portableInvocation: Windows の .ps1 shim は pwsh.exe 経由で、窓を隠して起こす', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tl-portable-hide-'));
  try {
    writeFileSync(join(dir, 'claude.ps1'), 'exit 0\n');
    const [command, args, options] = portableInvocation('claude', ['stop', 'abcd1234'], { platform: 'win32', env: { PATH: dir } });
    assert.equal(command, 'pwsh.exe');
    assert.ok(args.at(-1).includes(join(dir, 'claude.ps1')) && args.at(-1).includes("'stop' 'abcd1234'"));
    assert.equal(options.windowsHide, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
