/**
 * os/shell.mjs — shell / AppleScript 文字列 quoting の唯一の正本
 *
 * grok-continue と codex-handoff-start がそれぞれ同じ POSIX single-quote
 * escape を別実装していたため集約する。
 */

/** POSIX shell single-quote escape */
export function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/** AppleScript の string literal escape */
export function appleString(value) {
  return `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

export function nodeCliCommand(nodePath, scriptPath, args, platform = process.platform) {
  const quote = platform === 'win32' ? value => `'${String(value).replaceAll("'", "''")}'` : shQuote;
  return (platform === 'win32' ? '& ' : '') + [nodePath, scriptPath, ...args].map(quote).join(' ');
}
