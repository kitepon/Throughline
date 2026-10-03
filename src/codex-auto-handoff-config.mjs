import { readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { normalizeProjectPathForCompare, sameProjectPath } from './project-path.mjs';

export const AUTO_HANDOFF_CONFIG_SCHEMA = 'throughline.codex-auto-handoff.v1';
export const autoHandoffConfigPath = () => join(homedir(), '.throughline', 'codex-auto-handoff.json');

export function readAutoHandoffConfig(path = autoHandoffConfigPath()) {
  let text;
  try { text = readFileSync(path, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return { schema: AUTO_HANDOFF_CONFIG_SCHEMA, enabled: false, openHost: 'desktop', projects: [] };
    throw error;
  }
  const config = JSON.parse(text);
  if (config.schema !== AUTO_HANDOFF_CONFIG_SCHEMA || typeof config.enabled !== 'boolean' ||
      config.openHost !== 'desktop' || !Array.isArray(config.projects) ||
      config.projects.some(p => typeof p !== 'string' || !isAbsolute(p))) throw new Error('auto_handoff_config_invalid');
  return config;
}

export function writeAutoHandoffConfig({ enabled, openHost = 'desktop', projects = [] }, path = autoHandoffConfigPath()) {
  if (typeof enabled !== 'boolean' || openHost !== 'desktop') throw new TypeError('auto_handoff_config_invalid');
  const config = { schema: AUTO_HANDOFF_CONFIG_SCHEMA, enabled, openHost,
    projects: projects.map(normalizeProjectPathForCompare) };
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(config)}\n`, { mode: 0o600, flag: 'wx' });
  renameSync(temporary, path);
  return config;
}

export function autoHandoffEnabledFor(config, projectPath) {
  return config.enabled && (config.projects.length === 0 || config.projects.some(p => sameProjectPath(p, projectPath)));
}
