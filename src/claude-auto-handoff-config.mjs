import { readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { normalizeProjectPathForCompare, sameProjectPath } from './project-path.mjs';

// Claude の自動継続の設定。Codex の設定（codex-auto-handoff.json）とは別のファイルで、互いに影響しない。
export const CLAUDE_AUTO_HANDOFF_CONFIG_SCHEMA = 'throughline.claude-auto-handoff.v1';
export const claudeAutoHandoffConfigPath = () => join(homedir(), '.throughline', 'claude-auto-handoff.json');

export function readClaudeAutoHandoffConfig(path = claudeAutoHandoffConfigPath()) {
  let text;
  try { text = readFileSync(path, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return { schema: CLAUDE_AUTO_HANDOFF_CONFIG_SCHEMA, enabled: false, projects: [] };
    throw error;
  }
  const config = JSON.parse(text);
  if (config.schema !== CLAUDE_AUTO_HANDOFF_CONFIG_SCHEMA || typeof config.enabled !== 'boolean' ||
      !Array.isArray(config.projects) ||
      config.projects.some(p => typeof p !== 'string' || !isAbsolute(p))) throw new Error('auto_handoff_config_invalid');
  return config;
}

export function writeClaudeAutoHandoffConfig({ enabled, projects = [] }, path = claudeAutoHandoffConfigPath()) {
  if (typeof enabled !== 'boolean') throw new TypeError('auto_handoff_config_invalid');
  const config = { schema: CLAUDE_AUTO_HANDOFF_CONFIG_SCHEMA, enabled,
    projects: projects.map(normalizeProjectPathForCompare) };
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(config)}\n`, { mode: 0o600, flag: 'wx' });
  renameSync(temporary, path);
  return config;
}

export function claudeAutoHandoffEnabledFor(config, projectPath) {
  return config.enabled && (config.projects.length === 0 || config.projects.some(p => sameProjectPath(p, projectPath)));
}
