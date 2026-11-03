/** Host hook command spelling and executable identity; no configuration writes. */
import { existsSync, realpathSync } from 'node:fs';
import { join, dirname, resolve, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function quoteCommandPath(p) {
  return /\s/.test(p) ? `"${p.replace(/"/g, '\\"')}"` : p;
}

function safeRealpath(p, realpath = realpathSync.native) {
  try {
    return realpath(p);
  } catch {
    return null;
  }
}

export function resolveCodexHookNodePath({
  env = process.env,
  execPath = process.execPath,
  platform = process.platform,
  exists = existsSync,
  realpath = realpathSync.native,
} = {}) {
  const execRealpath = safeRealpath(execPath, realpath);
  const pathEnv = env.PATH || env.Path || '';
  const dirs = pathEnv.split(delimiter).filter(Boolean);
  const names = platform === 'win32'
    ? ['node.exe', 'node.cmd', 'node.bat', 'node']
    : ['node'];

  for (const dir of dirs) {
    for (const name of names) {
      const candidate = join(dir, name);
      if (!exists(candidate)) continue;
      const candidateRealpath = safeRealpath(candidate, realpath);
      if (execRealpath && candidateRealpath && candidateRealpath === execRealpath) {
        return candidate;
      }
    }
  }

  return execPath;
}

export function buildCodexStopHookCommand({
  nodePath = resolveCodexHookNodePath(),
  cliScriptPath = join(PACKAGE_ROOT, 'bin', 'throughline.mjs'),
  platform = process.platform,
} = {}) {
  return buildCodexHookCommand('stop', { nodePath, cliScriptPath, platform });
}

export function buildCodexUserPromptSubmitHookCommand({
  nodePath = resolveCodexHookNodePath(),
  cliScriptPath = join(PACKAGE_ROOT, 'bin', 'throughline.mjs'),
  platform = process.platform,
} = {}) {
  return buildCodexHookCommand('user-prompt-submit', { nodePath, cliScriptPath, platform });
}

export function buildCodexPostToolUseHookCommand({
  nodePath = resolveCodexHookNodePath(),
  cliScriptPath = join(PACKAGE_ROOT, 'bin', 'throughline.mjs'),
  platform = process.platform,
} = {}) {
  return buildCodexHookCommand('post-tool-use', { nodePath, cliScriptPath, platform });
}

export function buildCodexPreCompactHookCommand({ nodePath = resolveCodexHookNodePath(),
  cliScriptPath = join(PACKAGE_ROOT, 'bin', 'throughline.mjs'), platform = process.platform } = {}) {
  return buildCodexHookCommand('pre-compact', { nodePath, cliScriptPath, platform });
}

function buildCodexHookCommand(event, { nodePath, cliScriptPath, platform }) {
  const prefix = platform === 'win32' ? '& ' : '';
  return `${prefix}${quoteCommandPath(nodePath)} ${quoteCommandPath(cliScriptPath)} codex-hook ${event}`;
}

export function isThroughlineCodexHookCommand(command) {
  if (typeof command !== 'string') return false;
  const normalized = command.replace(/["']/g, '');
  return (
    normalized === 'throughline codex-hook stop' ||
    normalized === 'throughline codex-hook user-prompt-submit' ||
    normalized === 'throughline codex-hook post-tool-use' ||
    normalized.includes('throughline codex-hook stop') ||
    normalized.includes('throughline codex-hook user-prompt-submit') ||
    normalized.includes('throughline codex-hook post-tool-use') ||
    normalized.includes('throughline.mjs codex-hook stop') ||
    normalized.includes('throughline.mjs codex-hook user-prompt-submit') ||
    normalized.includes('throughline.mjs codex-hook post-tool-use') ||
    normalized.includes('throughline codex-hook pre-compact') ||
    normalized.includes('throughline.mjs codex-hook pre-compact')
  );
}

export function isThroughlineCodexStopCommand(command) {
  if (typeof command !== 'string') return false;
  const normalized = command.replace(/["']/g, '');
  return (
    normalized === 'throughline codex-hook stop' ||
    normalized.includes('throughline codex-hook stop') ||
    normalized.includes('throughline.mjs codex-hook stop')
  );
}

export function isThroughlineCodexPostToolUseCommand(command) {
  if (typeof command !== 'string') return false;
  const normalized = command.replace(/["']/g, '');
  return (
    normalized === 'throughline codex-hook post-tool-use' ||
    normalized.includes('throughline codex-hook post-tool-use') ||
    normalized.includes('throughline.mjs codex-hook post-tool-use')
  );
}

const CODEX_HOOK_EVENTS = new Set(['stop', 'user-prompt-submit', 'post-tool-use', 'pre-compact']);

function tokenizeCommand(command) {
  const tokens = [];
  const pattern = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  let match;
  while ((match = pattern.exec(command)) !== null) {
    // quoteCommandPath は `"` だけを escape する。Windows path の `\` は温存する。
    if (match[1] !== undefined) tokens.push(match[1].replace(/\\"/g, '"'));
    else if (match[2] !== undefined) tokens.push(match[2]);
    else tokens.push(match[3]);
  }
  return tokens;
}

/**
 * 絶対パス型の Codex hook command を {nodePath, scriptPath, event} へ分解する。
 * 旧 PATH 解決型 (`throughline codex-hook stop`) など、この形でないものは null。
 */
export function parseCodexHookCommand(command) {
  if (typeof command !== 'string') return null;
  const tokens = tokenizeCommand(command.replace(/^&\s+/, ''));
  if (tokens.length !== 4) return null;
  const [nodePath, scriptPath, subcommand, event] = tokens;
  if (subcommand !== 'codex-hook' || !CODEX_HOOK_EVENTS.has(event)) return null;
  if (!scriptPath.endsWith('throughline.mjs')) return null;
  return { nodePath, scriptPath, event };
}

/**
 * 登録済み hook command が期待値と同じ実行体を指すかを判定する。
 *
 * node の表記は呼び出し元の PATH で変わる (`resolveCodexHookNodePath` は PATH 上に
 * 同一 node があればその表記を、無ければ `process.execPath` を返す)。launchd の
 * ような最小 PATH から診断すると `/opt/homebrew/bin/node` で登録された正規 hook が
 * `/opt/homebrew/Cellar/node/<ver>/bin/node` と文字列比較され、正しい登録が legacy
 * と誤判定される。実体 (realpath) の同一性で比較してこれを防ぐ。realpath を解決
 * できない場合は同一とみなさない。
 */
export function isEquivalentCodexHookCommand(actual, expected, { realpath = realpathSync.native } = {}) {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false;
  if (actual === expected) return true;
  const left = parseCodexHookCommand(actual);
  const right = parseCodexHookCommand(expected);
  if (!left || !right || left.event !== right.event) return false;
  return isSameExecutablePath(left.scriptPath, right.scriptPath, realpath) &&
    isSameExecutablePath(left.nodePath, right.nodePath, realpath);
}

function isSameExecutablePath(a, b, realpath) {
  if (a === b) return true;
  const left = safeRealpath(a, realpath);
  const right = safeRealpath(b, realpath);
  return left !== null && right !== null && left === right;
}


function buildNodeHookCommand(subcommand, {
  nodePath = resolveCodexHookNodePath(),
  cliScriptPath = join(PACKAGE_ROOT, 'bin', 'throughline.mjs'),
} = {}) {
  return `${quoteCommandPath(nodePath)} ${quoteCommandPath(cliScriptPath)} ${subcommand}`;
}

// Grok は Windows で hook command を PowerShell で実行する。引用符付き path の後ろに
// 引数を並べると ParserError になるため、Codex と同じく呼出し演算子 `& ` を付ける。
export function buildGrokHookCommand(subcommand, { platform = process.platform, ...options } = {}) {
  const prefix = platform === 'win32' ? '& ' : '';
  return `${prefix}${buildNodeHookCommand(subcommand, options)}`;
}

export function buildCursorHookCommand(subcommand, options = {}) {
  return buildNodeHookCommand(subcommand, options);
}

export function isThroughlineCursorHookCommand(command) {
  return typeof command === 'string'
    && command.includes('throughline.mjs')
    && /\b(session-start|prompt-submit|process-turn)\b/.test(command);
}
