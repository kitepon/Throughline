import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename, delimiter, dirname, extname, isAbsolute, join } from 'node:path';

function windowsPath(env) {
  return Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1] ?? '';
}

function pairedPowerShellShim(command) {
  const extension = extname(command).toLowerCase();
  if (extension !== '.cmd' && extension !== '.bat') return null;
  const sibling = join(dirname(command), `${basename(command, extension)}.ps1`);
  return existsSync(sibling) ? sibling : null;
}

function resolveWindowsCommand(command, env) {
  const extension = extname(command).toLowerCase();
  if (isAbsolute(command) || command.includes('\\') || command.includes('/')) {
    return pairedPowerShellShim(command) ?? command;
  }
  for (const directory of windowsPath(env).split(delimiter).filter(Boolean)) {
    for (const suffix of ['.exe', '.ps1', '.cmd', '.bat', '']) {
      const candidate = join(directory, `${command}${suffix}`);
      if (!existsSync(candidate)) continue;
      return pairedPowerShellShim(candidate) ?? candidate;
    }
  }
  return command;
}

export function portableInvocation(command, args, options = {}) {
  const platform = options.platform ?? process.platform;
  const spawnOptions = { ...options };
  delete spawnOptions.platform;
  spawnOptions.shell = false;
  // Windows では、console を持たない process（切り離した worker など）が console の子を起こすと、新しい console が作られ、
  // 既定のターミナル（Windows Terminal）の窓が一瞬出る。出力は pipe で受けるので、窓は要らない。
  // 窓が要る呼び出し（端末が要る命令）は os/pty-run.mjs が別に持つ。ほかの OS では無視される。
  spawnOptions.windowsHide ??= true;

  if (platform !== 'win32') return [command, args, spawnOptions];

  const env = spawnOptions.env ?? process.env;
  const resolved = resolveWindowsCommand(command, env);
  const extension = extname(resolved).toLowerCase();
  if (['.js', '.cjs', '.mjs'].includes(extension)) {
    return [process.execPath, [resolved, ...args], spawnOptions];
  }
  if (extension === '.ps1') {
    const invocation = [resolved, ...args]
      .map(value => `'${value.replaceAll("'", "''")}'`).join(' ');
    return ['pwsh.exe', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      '[Console]::InputEncoding = [Console]::OutputEncoding = $OutputEncoding = ' +
        '[System.Text.UTF8Encoding]::new($false); ' +
        `& ${invocation}; exit $LASTEXITCODE`,
    ], spawnOptions];
  }
  return [resolved, args, spawnOptions];
}

export function spawnPortableSync(command, args, options = {}) {
  return spawnSync(...portableInvocation(command, args, options));
}

export function spawnPortable(command, args, options = {}) {
  return spawn(...portableInvocation(command, args, options));
}
