#!/usr/bin/env node
/**
 * throughline install / uninstall
 *
 * デフォルト: ~/.claude/settings.json（グローバル、全プロジェクトに適用）
 * --project : .claude/settings.json（プロジェクトローカル）
 * --uninstall: hook を削除
 *
 * Claude-facing hook は従来通り PATH 解決型 (throughline <subcommand>) を使う。
 * Codex-facing hook は VSCode App Server の PATH 差分を避けるため、絶対 node + CLI
 * script path で登録する。
 * Grok-facing hook も Desktop の GUI PATH に throughline が無いため、同じ絶対
 * node + CLI script path で ~/.grok/hooks/throughline.json に書く。
 * Cursor-facing hook は ~/.cursor/hooks.json へ upsert する（工場 hook は残す）。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, copyFileSync, unlinkSync, rmSync, realpathSync } from 'node:fs';
import { join, dirname, resolve, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { ensureMonitorTaskFile, shouldRecommendGitignore } from '../vscode-task.mjs';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SLASH_COMMANDS_SRC = join(PACKAGE_ROOT, '.claude', 'commands');
const SC_SLASH_COMMAND_FILES = ['tl.md', 'sc-detail.md'];
const CODEX_SKILLS_SRC = join(PACKAGE_ROOT, 'codex', 'skills');
const CODEX_SKILL_NAMES = ['throughline'];
const CODEX_HOOKS_RELATIVE_PATH = ['.codex', 'hooks.json'];
const CODEX_CONFIG_RELATIVE_PATH = ['.codex', 'config.toml'];
const GROK_HOOKS_RELATIVE_PATH = ['.grok', 'hooks', 'throughline.json'];
const CURSOR_HOOKS_RELATIVE_PATH = ['.cursor', 'hooks.json'];

// Throughline が管理する hook コマンド一覧
// schema v4 以降: PostToolUse (capture-tool) は廃止。Stop 内で L2/L3 を一括処理する。
const SC_COMMANDS = [
  'throughline process-turn',
  'throughline session-start',
  'throughline prompt-submit',
  // 旧コマンド（アンインストール時に除去する）
  'throughline inject-context',
  'throughline capture-tool',
  'node src/detail-capture.mjs',
  'node src/classifier.mjs',
  'node src/turn-processor.mjs',
  'node src/context-injector.mjs',
];

const SC_HOOKS = {
  SessionStart: {
    hooks: [{ type: 'command', command: 'throughline session-start' }],
  },
  Stop: {
    hooks: [{ type: 'command', command: 'throughline process-turn', async: true }],
  },
  UserPromptSubmit: {
    hooks: [{ type: 'command', command: 'throughline prompt-submit' }],
  },
};

const CODEX_COMMANDS = [
  'throughline codex-hook stop',
  'throughline codex-hook user-prompt-submit',
  'throughline codex-hook post-tool-use',
];

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
    normalized.includes('throughline.mjs codex-hook post-tool-use')
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

const CODEX_HOOK_EVENTS = new Set(['stop', 'user-prompt-submit', 'post-tool-use']);

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

function createCodexHooks() {
  return {
    UserPromptSubmit: {
      hooks: [
        {
          type: 'command',
          command: buildCodexUserPromptSubmitHookCommand(),
          timeout: 30,
          async: false,
          statusMessage: null,
        },
      ],
    },
    PostToolUse: {
      hooks: [
        {
          type: 'command',
          command: buildCodexPostToolUseHookCommand(),
          timeout: 30,
          async: false,
          statusMessage: null,
        },
      ],
    },
    Stop: {
      hooks: [
        {
          type: 'command',
          command: buildCodexStopHookCommand(),
          timeout: 300,
          async: false,
          statusMessage: null,
        },
      ],
    },
  };
}

function resolveSettingsPath(args) {
  if (args.includes('--project')) {
    return join(process.cwd(), '.claude', 'settings.json');
  }
  return join(homedir(), '.claude', 'settings.json');
}

function resolveCommandsDir(args) {
  if (args.includes('--project')) {
    return join(process.cwd(), '.claude', 'commands');
  }
  return join(homedir(), '.claude', 'commands');
}

function resolveCodexHooksPath() {
  return join(homedir(), ...CODEX_HOOKS_RELATIVE_PATH);
}

function resolveCodexConfigPath() {
  return join(homedir(), ...CODEX_CONFIG_RELATIVE_PATH);
}

function resolveCodexSkillsDir() {
  return join(homedir(), '.codex', 'skills');
}

function resolveGrokHooksPath() {
  return join(homedir(), ...GROK_HOOKS_RELATIVE_PATH);
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

export function createGrokHooksFile(options = {}) {
  return {
    hooks: {
      SessionStart: [
        { hooks: [{ type: 'command', command: buildGrokHookCommand('session-start', options), timeout: 10 }] },
      ],
      UserPromptSubmit: [
        { hooks: [{ type: 'command', command: buildGrokHookCommand('prompt-submit', options), timeout: 30 }] },
      ],
      Stop: [
        {
          hooks: [{
            type: 'command',
            command: buildGrokHookCommand('process-turn', options),
            timeout: 300,
            async: true,
          }],
        },
      ],
    },
  };
}

function installGrokHooks() {
  const hooksPath = resolveGrokHooksPath();
  mkdirSync(dirname(hooksPath), { recursive: true });
  writeFileSync(hooksPath, `${JSON.stringify(createGrokHooksFile(), null, 2)}\n`);
  return { hooksPath };
}

function uninstallGrokHooks() {
  const hooksPath = resolveGrokHooksPath();
  if (!existsSync(hooksPath)) return { hooksPath, removed: 0 };
  unlinkSync(hooksPath);
  return { hooksPath, removed: 1 };
}

function resolveCursorHooksPath() {
  return join(homedir(), ...CURSOR_HOOKS_RELATIVE_PATH);
}

export function createCursorHookEntries(options = {}) {
  return {
    sessionStart: [
      { command: buildCursorHookCommand('session-start', options), timeout: 10 },
    ],
    beforeSubmitPrompt: [
      { command: buildCursorHookCommand('prompt-submit', options), timeout: 30 },
    ],
    stop: [
      { command: buildCursorHookCommand('process-turn', options), timeout: 300 },
    ],
  };
}

function readCursorHooksFile(hooksPath) {
  if (!existsSync(hooksPath)) return { version: 1, hooks: {} };
  const parsed = JSON.parse(readFileSync(hooksPath, 'utf8'));
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${hooksPath} は object である必要があります`);
  }
  if (parsed.hooks == null) parsed.hooks = {};
  if (typeof parsed.hooks !== 'object' || Array.isArray(parsed.hooks)) {
    throw new Error(`${hooksPath} の hooks は object である必要があります`);
  }
  return parsed;
}

function installCursorHooks() {
  const hooksPath = resolveCursorHooksPath();
  mkdirSync(dirname(hooksPath), { recursive: true });
  const current = readCursorHooksFile(hooksPath);
  current.version = 1;
  const wanted = createCursorHookEntries();
  for (const [event, entries] of Object.entries(wanted)) {
    const existing = Array.isArray(current.hooks[event]) ? current.hooks[event] : [];
    const kept = existing.filter((entry) => !isThroughlineCursorHookCommand(entry?.command));
    current.hooks[event] = [...kept, ...entries];
  }
  writeFileSync(hooksPath, `${JSON.stringify(current, null, 2)}\n`);
  return { hooksPath };
}

function uninstallCursorHooks() {
  const hooksPath = resolveCursorHooksPath();
  if (!existsSync(hooksPath)) return { hooksPath, removed: 0 };
  const current = readCursorHooksFile(hooksPath);
  let removed = 0;
  for (const [event, list] of Object.entries(current.hooks ?? {})) {
    if (!Array.isArray(list)) continue;
    const kept = list.filter((entry) => {
      if (isThroughlineCursorHookCommand(entry?.command)) {
        removed += 1;
        return false;
      }
      return true;
    });
    if (kept.length > 0) current.hooks[event] = kept;
    else delete current.hooks[event];
  }
  if (removed === 0) return { hooksPath, removed: 0 };
  writeFileSync(hooksPath, `${JSON.stringify(current, null, 2)}\n`);
  return { hooksPath, removed };
}

function installSlashCommands(commandsDir) {
  if (!existsSync(SLASH_COMMANDS_SRC)) {
    return { installed: [], skipped: 'source-missing' };
  }
  if (!existsSync(commandsDir)) mkdirSync(commandsDir, { recursive: true });
  const installed = [];
  for (const name of SC_SLASH_COMMAND_FILES) {
    const src = join(SLASH_COMMANDS_SRC, name);
    if (!existsSync(src)) continue;
    const dest = join(commandsDir, name);
    copyFileSync(src, dest);
    installed.push(name);
  }
  return { installed, skipped: null };
}

function uninstallSlashCommands(commandsDir) {
  const removed = [];
  if (!existsSync(commandsDir)) return removed;
  for (const name of SC_SLASH_COMMAND_FILES) {
    const dest = join(commandsDir, name);
    if (existsSync(dest)) {
      unlinkSync(dest);
      removed.push(name);
    }
  }
  return removed;
}

function copyDirectory(srcDir, destDir) {
  mkdirSync(destDir, { recursive: true });
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    const src = join(srcDir, entry.name);
    const dest = join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyDirectory(src, dest);
    } else if (entry.isFile()) {
      copyFileSync(src, dest);
    }
  }
}

function installCodexSkills(skillsDir) {
  if (!existsSync(CODEX_SKILLS_SRC)) {
    return { installed: [], skipped: 'source-missing' };
  }
  mkdirSync(skillsDir, { recursive: true });
  const installed = [];
  for (const name of CODEX_SKILL_NAMES) {
    const src = join(CODEX_SKILLS_SRC, name);
    if (!existsSync(src)) continue;
    const dest = join(skillsDir, name);
    rmSync(dest, { recursive: true, force: true });
    copyDirectory(src, dest);
    installed.push(name);
  }
  return { installed, skipped: null };
}

function uninstallCodexSkills(skillsDir) {
  const removed = [];
  for (const name of CODEX_SKILL_NAMES) {
    const dest = join(skillsDir, name);
    if (existsSync(dest)) {
      rmSync(dest, { recursive: true, force: true });
      removed.push(name);
    }
  }
  return removed;
}

/**
 * PATH 上で 'throughline' (Windows なら .cmd / .ps1 / .exe) が解決できるかを確認する。
 *
 * 解決できない場合 hook (`throughline session-start` 等) は command not found で
 * silent fail する。npm の global prefix bin が PATH に通っていない (Linux/WSL2 の
 * `~/.npm-global` 設定派が `.profile` だけに PATH を書いて `.bashrc` に書き忘れる
 * パターンなど) と、ユーザーは「入れたのに何も起きない」状態に陥る。
 *
 * 戻り値: 解決できた絶対パス、見つからなければ null。
 */
export function resolveThroughlineOnPath(env = process.env) {
  const pathEnv = env.PATH || env.Path || '';
  const dirs = pathEnv.split(delimiter).filter(Boolean);
  const exts = process.platform === 'win32'
    ? (env.PATHEXT || '.EXE;.CMD;.BAT').split(';').filter(Boolean)
    : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, `throughline${ext}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function emitPathWarning() {
  const lines = [
    '',
    '警告: PATH 上で `throughline` コマンドが解決できません。',
    '      hooks は PATH 経由で `throughline` を呼び出すため、このままでは静かに失敗します。',
    '',
    '対処:',
    '  1) npm の global prefix を確認:  npm prefix -g',
    '  2) その bin ディレクトリを PATH に追加',
    '',
  ];
  if (process.platform === 'win32') {
    lines.push('     Windows: 環境変数 PATH に %APPDATA%\\npm を追加');
  } else {
    lines.push('     bash:   ~/.bashrc に  export PATH="$(npm prefix -g)/bin:$PATH"  を追記');
    lines.push('     zsh:    ~/.zshrc に同じ行を追記');
  }
  lines.push('');
  lines.push('  3) シェルを開き直して `throughline doctor` で確認');
  lines.push('');
  process.stderr.write(lines.join('\n'));
}

function readSettings(settingsPath) {
  if (!existsSync(settingsPath)) return {};
  return JSON.parse(readFileSync(settingsPath, 'utf8'));
}

function writeSettings(settingsPath, obj) {
  const dir = dirname(settingsPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(obj, null, 2) + '\n');
}

function ensureCodexHooksFeature(configPath) {
  const existing = existsSync(configPath) ? readFileSync(configPath, 'utf8') : '';
  const lines = existing.split(/\r?\n/);
  const sectionStart = lines.findIndex((line) => line.trim() === '[features]');
  const ensureFeatureLine = (featureLines, name) => {
    const idx = featureLines.findIndex((line) => new RegExp(`^\\s*${name}\\s*=`).test(line));
    if (idx === -1) {
      featureLines.push(`${name} = true`);
    } else {
      featureLines[idx] = `${name} = true`;
    }
  };
  let updated;

  if (sectionStart === -1) {
    const prefix = existing.trimEnd();
    updated = `${prefix}${prefix ? '\n\n' : ''}[features]\ncodex_hooks = true\nhooks = true\n`;
  } else {
    let sectionEnd = lines.length;
    for (let i = sectionStart + 1; i < lines.length; i++) {
      if (/^\s*\[[^\]]+\]\s*$/.test(lines[i])) {
        sectionEnd = i;
        break;
      }
    }

    const featureLines = lines.slice(sectionStart + 1, sectionEnd);
    ensureFeatureLine(featureLines, 'codex_hooks');
    ensureFeatureLine(featureLines, 'hooks');
    lines.splice(sectionStart + 1, sectionEnd - sectionStart - 1, ...featureLines);
    updated = lines.join('\n').replace(/\n*$/, '\n');
  }

  const dir = dirname(configPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(configPath, updated);
}

function installCodexHooks() {
  const hooksPath = resolveCodexHooksPath();
  const configPath = resolveCodexConfigPath();
  const current = readSettings(hooksPath);
  const existingHooks = current.hooks ?? {};
  const codexHooks = createCodexHooks();

  for (const [key, entry] of Object.entries(codexHooks)) {
    const list = existingHooks[key] ?? [];
    const preserved = [];
    for (const group of list) {
      const hooks = (group.hooks ?? []).filter(h => !isThroughlineCodexHookCommand(h.command));
      if (hooks.length > 0) preserved.push({ ...group, hooks });
    }
    existingHooks[key] = [entry, ...preserved];
  }

  current.hooks = existingHooks;
  writeSettings(hooksPath, current);
  ensureCodexHooksFeature(configPath);

  return { hooksPath, configPath };
}

function uninstallCodexHooks() {
  const hooksPath = resolveCodexHooksPath();
  if (!existsSync(hooksPath)) {
    return { hooksPath, removed: 0 };
  }

  const current = readSettings(hooksPath);
  const existingHooks = current.hooks ?? {};
  let removed = 0;

  for (const [key, groups] of Object.entries(existingHooks)) {
    existingHooks[key] = groups
      .map((group) => {
        const hooks = (group.hooks ?? []).filter((hook) => {
          const shouldRemove =
            CODEX_COMMANDS.includes(hook.command) ||
            isThroughlineCodexHookCommand(hook.command);
          if (shouldRemove) removed++;
          return !shouldRemove;
        });
        return { ...group, hooks };
      })
      .filter((group) => group.hooks.length > 0);
    if (existingHooks[key].length === 0) delete existingHooks[key];
  }

  if (Object.keys(existingHooks).length === 0) {
    delete current.hooks;
  } else {
    current.hooks = existingHooks;
  }

  writeSettings(hooksPath, current);
  return { hooksPath, removed };
}

export async function run(args = []) {
  const uninstall = args.includes('--uninstall');
  const settingsPath = resolveSettingsPath(args);
  const commandsDir = resolveCommandsDir(args);
  const codexSkillsDir = resolveCodexSkillsDir();
  const current = readSettings(settingsPath);
  const existingHooks = current.hooks ?? {};
  const scSet = new Set(SC_COMMANDS);

  if (uninstall) {
    for (const [key, groups] of Object.entries(existingHooks)) {
      existingHooks[key] = groups.filter(group =>
        !(group.hooks ?? []).some(h => scSet.has(h.command))
      );
      if (existingHooks[key].length === 0) delete existingHooks[key];
    }

    if (Object.keys(existingHooks).length === 0) {
      delete current.hooks;
    } else {
      current.hooks = existingHooks;
    }

    writeSettings(settingsPath, current);
    const removedCommands = uninstallSlashCommands(commandsDir);
    const codex = args.includes('--project') ? null : uninstallCodexHooks();
    const grok = args.includes('--project') ? null : uninstallGrokHooks();
    const cursor = args.includes('--project') ? null : uninstallCursorHooks();
    const removedCodexSkills = args.includes('--project') ? [] : uninstallCodexSkills(codexSkillsDir);
    console.log('Throughline hooks を削除しました。');
    console.log(`  ${settingsPath}`);
    if (removedCommands.length > 0) {
      console.log(`  slash commands 削除: ${removedCommands.join(', ')} (${commandsDir})`);
    }
    if (codex?.removed > 0) {
      console.log(`  Codex hooks 削除: ${codex.removed} (${codex.hooksPath})`);
    }
    if (grok?.removed > 0) {
      console.log(`  Grok hooks 削除: ${grok.removed} (${grok.hooksPath})`);
    }
    if (cursor?.removed > 0) {
      console.log(`  Cursor hooks 削除: ${cursor.removed} (${cursor.hooksPath})`);
    }
    if (removedCodexSkills.length > 0) {
      console.log(`  Codex skills 削除: ${removedCodexSkills.join(', ')} (${codexSkillsDir})`);
    }
    return;
  }

  // インストール
  for (const [key, entry] of Object.entries(SC_HOOKS)) {
    const list = existingHooks[key] ?? [];
    const cmd = entry.hooks[0].command;
    const alreadyExists = list.some(group =>
      (group.hooks ?? []).some(h => h.command === cmd)
    );
    if (!alreadyExists) {
      existingHooks[key] = [entry, ...list];
    }
  }

  current.hooks = existingHooks;
  writeSettings(settingsPath, current);
  const { installed: installedCommands, skipped } = installSlashCommands(commandsDir);
  const codex = args.includes('--project') ? null : installCodexHooks();
  const grok = args.includes('--project') ? null : installGrokHooks();
  const cursor = args.includes('--project') ? null : installCursorHooks();
  const codexSkills = args.includes('--project') ? { installed: [], skipped: null } : installCodexSkills(codexSkillsDir);
  const monitorTask = ensureMonitorTaskFile({
    cwd: process.cwd(),
    env: { ...process.env, THROUGHLINE_SUPPRESS_VSCODE_NOTICES: '1' },
  });

  const scope = args.includes('--project') ? 'プロジェクトローカル' : 'グローバル（全プロジェクト）';
  console.log(`Throughline hooks をインストールしました [${scope}]`);
  console.log(`  ${settingsPath}`);
  if (codex) {
    console.log(`  ${codex.hooksPath}`);
    console.log(`  ${codex.configPath}`);
    if (codexSkills.installed.length > 0) {
      console.log(`  ${codexSkillsDir}`);
    }
  }
  if (grok) {
    console.log(`  ${grok.hooksPath}`);
  }
  if (cursor) {
    console.log(`  ${cursor.hooksPath}`);
  }
  console.log('');
  console.log('有効な hooks:');
  console.log('  SessionStart     → throughline session-start  (セッション記録・バトン消費・引き継ぎ注入)');
  console.log('  Stop             → throughline process-turn   (L1 要約 + L2 本文保存 + L3 詳細保存)');
  console.log('  UserPromptSubmit → throughline prompt-submit  (/tl & /clear バトン書き込み)');
  if (codex) {
    console.log(`  Codex UserPromptSubmit → ${buildCodexUserPromptSubmitHookCommand()} (capture / monitor state only; auto refresh disabled)`);
    console.log(`  Codex PostToolUse      → ${buildCodexPostToolUseHookCommand()} (capture / monitor state only; auto refresh disabled)`);
    console.log(`  Codex Stop             → ${buildCodexStopHookCommand()} (Codex rollout capture + L1 要約)`);
  }
  if (grok) {
    console.log('  Grok SessionStart / UserPromptSubmit / Stop → ~/.grok/hooks/throughline.json');
  }
  if (cursor) {
    console.log('  Cursor sessionStart / beforeSubmitPrompt / stop → ~/.cursor/hooks.json（工場hookは残す）');
  }
  console.log('');
  if (installedCommands.length > 0) {
    console.log(`slash commands を配置しました: ${installedCommands.map(n => '/' + n.replace(/\.md$/, '')).join(', ')}`);
    console.log(`  ${commandsDir}`);
    console.log('');
  } else if (skipped === 'source-missing') {
    console.log('注意: パッケージ内に slash commands のソースが見つからないためスキップしました。');
    console.log('');
  }
  if (codexSkills.installed.length > 0) {
    console.log(`Codex skills を配置しました: ${codexSkills.installed.map(n => '$' + n).join(', ')}`);
    console.log(`  ${codexSkillsDir}`);
    console.log('');
  } else if (codexSkills.skipped === 'source-missing') {
    console.log('注意: パッケージ内に Codex skills のソースが見つからないためスキップしました。');
    console.log('');
  }
  if (monitorTask.action === 'created' || monitorTask.action === 'merged' || monitorTask.action === 'repaired') {
    console.log(`VSCode monitor task を${monitorTask.action === 'repaired' ? '修復' : '配置'}しました:`);
    console.log(`  ${monitorTask.path}`);
    console.log('  既に VSCode でこのフォルダを開いている場合は Developer: Reload Window を 1 回実行してください。');
    if (shouldRecommendGitignore(process.cwd())) {
      console.log('  共有リポジトリでは .vscode/tasks.json を .gitignore に追加することを推奨します。');
    }
    console.log('');
  }
  console.log('  アンインストール: throughline uninstall');

  if (!resolveThroughlineOnPath()) {
    emitPathWarning();
  }
}
