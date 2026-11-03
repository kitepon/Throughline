/** Read-only Codex hook/config observation shared by doctor and factory diagnostics. */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildCodexPostToolUseHookCommand,
  buildCodexStopHookCommand,
  buildCodexUserPromptSubmitHookCommand,
  isEquivalentCodexHookCommand,
  isThroughlineCodexHookCommand,
  isThroughlineCodexPostToolUseCommand,
  isThroughlineCodexStopCommand,
} from './hook-commands.mjs';

function parseCodexTrustedHookState(configText) {
  const trustedKeys = new Set();
  let currentKey = null;
  let currentTrusted = false;

  function flush() {
    if (currentKey && currentTrusted) for (const key of currentKey) trustedKeys.add(key);
  }

  for (const line of configText.split(/\r?\n/)) {
    // Codexは、`\` を含むkey（Windowsのpath）をTOMLのliteral string（'…'）で書く。basic string（"…"）の時は `\\` を戻す。
    const section = line.match(/^\s*\[hooks\.state\.(?:"((?:[^"\\]|\\.)+)"|'([^']+)')\]\s*$/);
    if (section) {
      flush();
      currentKey = section[2] != null ? [section[2]] : [section[1], section[1].replace(/\\(["\\])/g, '$1')];
      currentTrusted = false;
      continue;
    }
    if (!currentKey) continue;
    if (/^\s*\[/.test(line)) {
      flush();
      currentKey = null;
      currentTrusted = false;
      continue;
    }
    if (/^\s*trusted_hash\s*=\s*"sha256:[^"]+"\s*$/.test(line)) {
      currentTrusted = true;
    }
  }
  flush();
  return trustedKeys;
}

function listHooksWithTrust(parsed, eventName, eventKey, hooksPath, trustedStateKeys) {
  const groups = parsed.hooks?.[eventName] ?? [];
  return groups.flatMap((group, groupIndex) =>
    (group.hooks ?? []).map((hook, hookIndex) => {
      const trustKey = `${hooksPath}:${eventKey}:${groupIndex}:${hookIndex}`;
      return {
        ...hook,
        throughlineDoctorTrustKey: trustKey,
        throughlineDoctorTrusted: trustedStateKeys.has(trustKey),
      };
    }),
  );
}

function summarizeHookTrust(hooks, { hooksFeatureEnabled, codexHooksFeatureEnabled } = {}) {
  if (hooks.length === 0) {
    return {
      status: 'no managed hooks',
      trustedCount: 0,
      totalCount: 0,
    };
  }
  const trustedCount = hooks.filter(h => h.throughlineDoctorTrusted).length;
  if (trustedCount === hooks.length) {
    return {
      status: 'trusted',
      trustedCount,
      totalCount: hooks.length,
    };
  }
  if (hooksFeatureEnabled) {
    return {
      status: `${trustedCount}/${hooks.length} trusted - accept hooks in Codex menu`,
      trustedCount,
      totalCount: hooks.length,
    };
  }
  if (codexHooksFeatureEnabled) {
    return {
      status: 'not recorded (legacy codex_hooks)',
      trustedCount,
      totalCount: hooks.length,
    };
  }
  return {
    status: 'not trusted',
    trustedCount,
    totalCount: hooks.length,
  };
}

export function readCodexHookDiagnosis(codexHome) {
  const hooksPath = join(codexHome, 'hooks.json');
  const configPath = join(codexHome, 'config.toml');
  const expectedStopCommand = buildCodexStopHookCommand();
  const expectedPromptCommand = buildCodexUserPromptSubmitHookCommand();
  const expectedPostToolUseCommand = buildCodexPostToolUseHookCommand();
  const out = {
    hooksPath,
    configPath,
    expectedStopCommand,
    expectedPromptCommand,
    expectedPostToolUseCommand,
    hooksReadable: false,
    hooksExists: existsSync(hooksPath),
    configExists: existsSync(configPath),
    configReadable: false,
    featureEnabled: false,
    codexHooksFeatureEnabled: false,
    hooksFeatureEnabled: false,
    trustedStateKeys: new Set(),
    managedHookTrust: {
      status: 'no managed hooks',
      trustedCount: 0,
      totalCount: 0,
    },
    managedPromptHooks: [],
    legacyManagedPromptHooks: [],
    managedPostToolUseHooks: [],
    legacyManagedPostToolUseHooks: [],
    managedStopHooks: [],
    legacyManagedStopHooks: [],
  };

  if (existsSync(configPath)) {
    try {
      const config = readFileSync(configPath, 'utf8');
      out.configReadable = true;
      out.codexHooksFeatureEnabled = /^\s*codex_hooks\s*=\s*true\s*$/m.test(config);
      out.hooksFeatureEnabled = /^\s*hooks\s*=\s*true\s*$/m.test(config);
      out.featureEnabled = out.codexHooksFeatureEnabled || out.hooksFeatureEnabled;
      out.trustedStateKeys = parseCodexTrustedHookState(config);
    } catch {
      out.featureEnabled = false;
    }
  }

  if (!out.hooksExists) return out;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(hooksPath, 'utf8'));
  } catch {
    return out;
  }

  out.hooksReadable = true;
  const promptHooks = listHooksWithTrust(
    parsed,
    'UserPromptSubmit',
    'user_prompt_submit',
    hooksPath,
    out.trustedStateKeys,
  );
  const postToolUseHooks = listHooksWithTrust(
    parsed,
    'PostToolUse',
    'post_tool_use',
    hooksPath,
    out.trustedStateKeys,
  );
  const stopHooks = listHooksWithTrust(parsed, 'Stop', 'stop', hooksPath, out.trustedStateKeys);
  out.managedPromptHooks = promptHooks.filter(h => isThroughlineCodexHookCommand(h.command));
  out.legacyManagedPromptHooks = out.managedPromptHooks.filter(
    h => !isEquivalentCodexHookCommand(h.command, expectedPromptCommand),
  );
  out.managedPostToolUseHooks = postToolUseHooks.filter(h => isThroughlineCodexPostToolUseCommand(h.command));
  out.legacyManagedPostToolUseHooks = out.managedPostToolUseHooks.filter(
    h => !isEquivalentCodexHookCommand(h.command, expectedPostToolUseCommand),
  );
  out.managedStopHooks = stopHooks.filter(h => isThroughlineCodexStopCommand(h.command));
  out.legacyManagedStopHooks = out.managedStopHooks.filter(
    h => !isEquivalentCodexHookCommand(h.command, expectedStopCommand),
  );
  out.managedHookTrust = summarizeHookTrust(
    [
      ...out.managedPromptHooks,
      ...out.managedPostToolUseHooks,
      ...out.managedStopHooks,
    ],
    out,
  );
  return out;
}
