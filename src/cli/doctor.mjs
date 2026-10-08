/**
 * throughline doctor — 環境チェック + セッション診断
 *
 * 通常: throughline doctor
 *   - Node.js バージョン >= 22.5
 *   - node:sqlite が使えるか
 *   - ~/.throughline/throughline.db が書き込み可能か
 *   - ~/.claude/settings.json に Throughline hook が登録されているか
 *
 * セッション診断: throughline doctor --session <id-prefix>
 *   - 特定セッションの state ファイルと transcript JSONL の整合性をチェック
 *   - 「モニターが止まって見える」ときの真因切り分け用
 *     (本当にアイドルか、state の transcriptPath が古い JSONL を指しているか)
 */

import { existsSync, accessSync, readFileSync, constants, readdirSync, statSync } from 'node:fs';
import { CODEX_HOST } from '../hosts/identity.mjs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';
import { getStateDir } from '../state-file.mjs';
import { readLatestUsage } from '../transcript-usage.mjs';
import { buildCodexRolloutTrimSource } from '../codex-rollout-memory.mjs';
import { runCodexHostPrimitiveAudit } from '../codex-host-primitive-audit.mjs';
import { buildCodexHandoffSmoke } from '../codex-handoff-smoke.mjs';
import { buildHandoffRecord } from '../handoff-record.mjs';
import { DEFAULT_TRIM_KEEP_RECENT, buildTrimPlan, describeTrimHost } from '../trim-model.mjs';
import { resolveCodexThreadIdentity } from '../codex-thread-identity.mjs';
import { defaultCodexHome, listCodexThreadCandidates } from '../codex-thread-index.mjs';
import { getDb } from '../db.mjs';
import { detectJsoncFeatures, findMonitorTaskIndex, isMonitorTaskBroken } from '../vscode-task.mjs';
import {
  buildCodexPostToolUseHookCommand,
  buildCodexStopHookCommand,
  buildCodexUserPromptSubmitHookCommand,
  isEquivalentCodexHookCommand,
  isThroughlineCodexHookCommand,
  isThroughlineCodexPostToolUseCommand,
  isThroughlineCodexStopCommand,
} from './install.mjs';

const GREEN = '\x1b[32m✓\x1b[0m';
const RED = '\x1b[31m✗\x1b[0m';
const YELLOW = '\x1b[33m!\x1b[0m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';

async function check(label, fn) {
  try {
    const result = await fn();
    if (result === false) {
      console.log(`${YELLOW} ${label}`);
    } else {
      console.log(`${GREEN} ${label}${result ? ': ' + result : ''}`);
    }
    return true;
  } catch (err) {
    console.log(`${RED} ${label}: ${err.message}`);
    return false;
  }
}

function parseArgs(argv) {
  const args = { session: null, trim: false, host: 'unknown', codex: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--session') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error('--session requires a session id prefix');
      }
      args.session = value;
      i++;
    } else if (argv[i] === '--trim') {
      args.trim = true;
    } else if (argv[i] === '--codex') {
      args.codex = true;
    } else if (argv[i] === '--host') {
      const value = argv[i + 1];
      if (!['claude', 'codex', 'unknown'].includes(value)) {
        throw new Error('--host must be claude, codex, or unknown');
      }
      args.host = value;
      i++;
    }
  }
  return args;
}

function formatAgo(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '?';
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

function formatTs(ms) {
  if (!Number.isFinite(ms)) return '?';
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function formatBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '?';
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(2) + ' GB';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + ' MB';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + ' kB';
  return `${n} B`;
}

/**
 * transcript JSONL を末尾から走査して最後の assistant エントリの timestamp を返す。
 * JSONL は append-only だが巨大化しうるので、末尾 256 KB だけ読んで逆順走査する。
 * @param {string} transcriptPath
 * @returns {{ ts: number | null, usage: object | null }}
 */
function tailLatestAssistantTs(transcriptPath) {
  try {
    const stat = statSync(transcriptPath);
    // シンプル化: 現状の全ファイル read で十分（モニターも全 read している）。
    // 巨大 JSONL 対策は readLatestUsage 側の将来最適化に任せる。
    const raw = readFileSync(transcriptPath, 'utf8');
    const lines = raw.split('\n');
    let latestTs = null;
    for (let i = lines.length - 1; i >= 0; i--) {
      const trimmed = lines[i].trim();
      if (!trimmed) continue;
      let entry;
      try {
        entry = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (entry.type !== 'assistant') continue;
      const ts = entry.timestamp ?? entry.ts ?? null;
      if (ts) {
        latestTs = typeof ts === 'string' ? Date.parse(ts) : ts;
        break;
      }
    }
    return { ts: latestTs, fileMtime: stat.mtimeMs, size: stat.size };
  } catch (err) {
    throw new Error(`transcript read failed: ${err.message}`);
  }
}

/**
 * 同じプロジェクトディレクトリ内の最新 JSONL を返す（transcript 差し替え検出用）。
 * state の transcriptPath と比較して、指し先が「最新」でなければズレている可能性。
 */
function findLatestJsonlInSameDir(transcriptPath) {
  try {
    const dir = dirname(transcriptPath);
    if (!existsSync(dir)) return null;
    const files = readdirSync(dir).filter((n) => n.endsWith('.jsonl'));
    if (files.length === 0) return null;
    let best = null;
    for (const name of files) {
      const full = join(dir, name);
      try {
        const mt = statSync(full).mtimeMs;
        if (!best || mt > best.mtimeMs) best = { path: full, mtimeMs: mt };
      } catch {
        /* skip */
      }
    }
    return best;
  } catch {
    return null;
  }
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM'; // 他ユーザー所有プロセスは生きている扱い
  }
}

function runSessionDiagnosis(prefix) {
  const stateDir = getStateDir();
  if (!existsSync(stateDir)) {
    console.log(`${RED} state ディレクトリが存在しません: ${stateDir}`);
    console.log(`${DIM}  → Throughline が一度も動作していない可能性。throughline install してから Claude Code を起動してください。${RESET}`);
    return;
  }
  const entries = readdirSync(stateDir)
    .filter((n) => n.endsWith('.json'))
    .filter((n) => n.startsWith(prefix) || n.replace(/\.json$/, '').startsWith(prefix));
  if (entries.length === 0) {
    console.log(`${RED} prefix "${prefix}" に一致する state ファイルが見つかりません`);
    console.log(`${DIM}  → ~/.throughline/state/ を ls して session_id を確認してください。${RESET}`);
    return;
  }
  if (entries.length > 1) {
    console.log(`${YELLOW} 複数のセッションが prefix に一致しました:`);
    for (const name of entries) console.log(`  - ${name}`);
    console.log(`${DIM}  → もう少し長い prefix を指定してください。${RESET}`);
    return;
  }

  const name = entries[0];
  const stateFile = join(stateDir, name);
  const sessionId = name.replace(/\.json$/, '');
  console.log(`${BOLD}[Session ${sessionId}]${RESET}\n`);

  let state;
  try {
    state = JSON.parse(readFileSync(stateFile, 'utf8'));
  } catch (err) {
    console.log(`${RED} state ファイル読み込み失敗: ${err.message}`);
    return;
  }

  const now = Date.now();
  console.log(`  state file:       ${stateFile}`);
  console.log(`    updatedAt:      ${formatTs(state.updatedAt)} (${formatAgo(now - (state.updatedAt ?? 0))})`);
  console.log(`    projectPath:    ${state.projectPath ?? '(未設定)'}`);
  console.log(`    transcriptPath: ${state.transcriptPath ?? '(未設定)'}`);
  if (state.pid) {
    const alive = isPidAlive(state.pid);
    console.log(`    pid:            ${state.pid} (${alive ? 'alive' : 'dead'})`);
  }
  if (state.usage) {
    const u = state.usage;
    const pct = u.contextWindowSize ? Math.round((u.tokens / u.contextWindowSize) * 100) : 0;
    console.log(`    usage (snapshot): ${u.tokens?.toLocaleString()} tokens (${pct}% of ${u.contextWindowSize?.toLocaleString()})`);
    console.log(`                      model: ${u.model ?? '?'}`);
  } else {
    console.log(`    usage (snapshot): ${DIM}(未記録 — 旧バージョンで書かれた state、または Stop が 1 度も走っていない)${RESET}`);
  }
  console.log('');

  if (!state.transcriptPath) {
    console.log(`${YELLOW} transcriptPath が state に含まれていません — 診断不能`);
    return;
  }

  if (!existsSync(state.transcriptPath)) {
    console.log(`  transcript:       ${RED}存在しない${RESET}`);
    console.log(`${DIM}  → state の transcriptPath が古い or /clear で消えた可能性。新しい発話で state が再生成されます。${RESET}`);
    return;
  }

  let tail;
  try {
    tail = tailLatestAssistantTs(state.transcriptPath);
  } catch (err) {
    console.log(`  transcript:       ${RED}${err.message}${RESET}`);
    return;
  }
  console.log(`  transcript:`);
  console.log(`    size:           ${formatBytes(tail.size)}`);
  console.log(`    mtime:          ${formatTs(tail.fileMtime)} (${formatAgo(now - tail.fileMtime)})`);
  if (tail.ts) {
    console.log(`    latest assistant entry: ${formatTs(tail.ts)} (${formatAgo(now - tail.ts)})`);
  } else {
    console.log(`    latest assistant entry: ${DIM}(未検出 — usage 付きの assistant エントリがまだ無い)${RESET}`);
  }

  const live = readLatestUsage(state.transcriptPath);
  if (live) {
    const pct = live.contextWindowSize ? Math.round((live.tokens / live.contextWindowSize) * 100) : 0;
    console.log(`    usage (live):   ${live.tokens?.toLocaleString()} tokens (${pct}% of ${live.contextWindowSize?.toLocaleString()})`);
  }
  console.log('');

  // diagnosis
  console.log(`  diagnosis:`);
  const latestInDir = findLatestJsonlInSameDir(state.transcriptPath);
  if (latestInDir && latestInDir.path !== state.transcriptPath && latestInDir.mtimeMs > tail.fileMtime) {
    console.log(`    ${RED}state points to old JSONL${RESET}`);
    console.log(`      state:  ${state.transcriptPath} (${formatAgo(now - tail.fileMtime)})`);
    console.log(`      newer:  ${latestInDir.path} (${formatAgo(now - latestInDir.mtimeMs)})`);
    console.log(`${DIM}    → 次の発話で state が自動修復されます。それでも直らない場合は state ファイルを削除してください。${RESET}`);
  } else {
    console.log(`    ${GREEN}state and transcript are consistent${RESET}`);
  }
  const idleMs = now - tail.fileMtime;
  if (idleMs > 10 * 60 * 1000) {
    console.log(`    ${YELLOW}no transcript activity in ${formatAgo(idleMs)} — session likely idle${RESET}`);
    console.log(`${DIM}    → Claude Code でこのセッションが動いていれば transcript は必ず太ります。太っていないなら本当にアイドル。${RESET}`);
  }
  if (state.usage && live && state.usage.tokens !== live.tokens) {
    console.log(`    ${YELLOW}state.usage snapshot (${state.usage.tokens}) != live transcript (${live.tokens})${RESET}`);
    console.log(`${DIM}    → Stop が一度走った後に更に assistant エントリが追記された状態。次の Stop で揃います。${RESET}`);
  }
}

function runTrimDiagnosis(
  host,
  env = process.env,
  { auditRunner = runCodexHostPrimitiveAudit } = {},
) {
  const info = describeTrimHost(host);
  const codexIdentity =
    info.host === CODEX_HOST ? resolveCodexThreadIdentity({ codexThreadId: null }, env) : null;
  const hostPrimitiveDiagnosis =
    info.host === CODEX_HOST ? readCodexHostPrimitiveDiagnosis({ env, auditRunner }) : null;
  console.log(`${BOLD}[Trim]${RESET}\n`);
  console.log(`  host:                  ${info.host}`);
  console.log(`  default keep-recent:   ${DEFAULT_TRIM_KEEP_RECENT}`);
  console.log(`  automatic rollback:    ${info.automaticRollback ? 'yes' : 'no'}`);
  console.log(`  automatic inject:      ${info.automaticInject ? 'yes' : 'no'}`);
  console.log(`  boundary status:       ${info.status}`);
  console.log(`  boundary reason:       ${info.reason}`);
  if (codexIdentity) {
    const identityText = codexIdentity.codexThreadId
      ? `${codexIdentity.codexThreadId} (${codexIdentity.codexThreadIdSource})`
      : 'not detected';
    console.log(`  current Codex thread:  ${identityText}`);
  }
  if (hostPrimitiveDiagnosis) {
    console.log(`  host primitive audit:  ${hostPrimitiveDiagnosis.status}`);
    console.log(`  host primitive reason: ${hostPrimitiveDiagnosis.reason}`);
    console.log(
      `  current-thread non-resurrection: ${
        hostPrimitiveDiagnosis.hasCurrentThreadNonResurrectionPrimitive ? 'yes' : 'no'
      }`,
    );
    console.log(`  repair contract:       ${hostPrimitiveDiagnosis.repairContractStatus}`);
  }
  console.log('');
  console.log('  dry-run command:');
  if (info.host === CODEX_HOST && !codexIdentity?.codexThreadId) {
    console.log('    throughline trim --dry-run --host codex --codex-thread-id <id>');
    console.log('    throughline trim --preflight --host codex --codex-thread-id <id>');
  } else if (info.host === CODEX_HOST) {
    console.log('    throughline trim --dry-run --host codex');
    console.log('    throughline trim --preflight --host codex');
  } else {
    console.log(`    throughline trim --dry-run --host ${info.host}`);
  }
  if (info.host === CODEX_HOST) {
    console.log('    throughline trim --execute --host codex');
  }
  if (info.host === CODEX_HOST) {
    const sessionId = codexIdentity?.codexThreadId
      ? `codex:${codexIdentity.codexThreadId}`
      : 'codex:<thread-id>';
    console.log('');
    console.log('  fresh-thread continuation path:');
    console.log('    status: fresh-thread-handoff-available');
    console.log('    reason: optional_fresh_thread_continuation');
    console.log('    safety scope: fresh_thread_handoff_no_current_thread_mutation');
    console.log(`    guided: throughline codex-handoff-start --session ${sessionId}`);
    console.log(`    smoke:  throughline codex-handoff-smoke --session ${sessionId}`);
    console.log(`    model smoke dry-run: throughline codex-handoff-model-smoke --session ${sessionId} --dry-run --json`);
    console.log(`    memory: throughline codex-resume --session ${sessionId} --format handoff`);
    console.log('    then: start a new Codex thread with that handoff context only if desired');
  }
  console.log('');
  console.log('  manual procedure:');
  for (const step of info.manualProcedure) {
    console.log(`    - ${step}`);
  }
}

function findLatestCapturedCodexSession(db, projectPath) {
  try {
    return (
      db
        .prepare(
          `SELECT session_id, updated_at
           FROM sessions
           WHERE lower(project_path) = lower(?)
             AND session_id LIKE 'codex:%'
           ORDER BY updated_at DESC
           LIMIT 1`,
        )
        .get(projectPath) ?? null
    );
  } catch {
    return null;
  }
}

function countCapturedCodexSessions(db, projectPath) {
  try {
    return db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM sessions
         WHERE lower(project_path) = lower(?)
           AND session_id LIKE 'codex:%'`,
      )
      .get(projectPath).count;
  } catch {
    return 0;
  }
}

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

function hasLegacyCodexHookTimeout(hook) {
  return Object.hasOwn(hook, 'timeoutSec');
}

function describeCodexHookRegistration(hooks, legacyCommandHooks, expectedTimeout) {
  if (hooks.length === 0) return 'not registered';
  if (legacyCommandHooks.length > 0) return 'legacy command needs reinstall';
  if (hooks.some(hasLegacyCodexHookTimeout)) return 'legacy timeout key needs reinstall';
  if (hooks.length !== 1) return 'configuration needs reinstall';
  const hook = hooks[0];
  return hook.type === 'command' && hook.timeout === expectedTimeout && hook.async === false
    ? 'registered'
    : 'configuration needs reinstall';
}

function printCodexHookDetails(hook) {
  console.log(`    command:             ${hook.command}`);
  console.log(`    async:               ${hook.async === false ? 'false' : String(hook.async)}`);
  console.log(`    timeout:             ${hook.timeout ?? '(default: 600)'}`);
  if (hasLegacyCodexHookTimeout(hook)) {
    console.log(`    legacy timeoutSec:   ${hook.timeoutSec} (ignored by Codex; reinstall required)`);
  }
  console.log(`    trusted:             ${hook.throughlineDoctorTrusted ? 'yes' : 'no'}`);
}

function readCodexHookDiagnosis(codexHome) {
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

function runCodexDiagnosis({
  env = process.env,
  cwd = process.cwd(),
  db = getDb(),
  auditRunner = runCodexHostPrimitiveAudit,
} = {}) {
  const codexHome = env.CODEX_HOME || defaultCodexHome();
  const identity = resolveCodexThreadIdentity({ codexThreadId: null }, env);
  const hookDiagnosis = readCodexHookDiagnosis(codexHome);
  const hostPrimitiveDiagnosis = readCodexHostPrimitiveDiagnosis({ env, auditRunner });
  const monitorTaskDiagnosis = readVsCodeMonitorTaskDiagnosis(cwd);
  const candidates = listCodexThreadCandidates({
    codexHome,
    projectPath: cwd,
    limit: 3,
  });
  const latestCaptured = findLatestCapturedCodexSession(db, cwd);
  const capturedCount = countCapturedCodexSessions(db, cwd);
  const refreshDiagnosis = buildCodexContextRefreshDiagnosis({
    db,
    cwd,
    codexHome,
    identity,
  });

  console.log(`${BOLD}[Codex primary]${RESET}\n`);
  console.log(`  project:               ${cwd}`);
  console.log(`  CODEX_HOME:            ${codexHome}`);
  console.log(`  Codex hooks feature:   ${hookDiagnosis.featureEnabled ? 'enabled' : 'not enabled'}`);
  console.log(`  Codex hook trust:      ${hookDiagnosis.managedHookTrust.status}`);
  console.log(`  Codex UserPrompt hook: ${describeCodexHookRegistration(
    hookDiagnosis.managedPromptHooks,
    hookDiagnosis.legacyManagedPromptHooks,
    30,
  )}`);
  if (hookDiagnosis.managedPromptHooks.length > 0) {
    printCodexHookDetails(hookDiagnosis.managedPromptHooks[0]);
  }
  console.log(`  Codex PostTool hook:   ${describeCodexHookRegistration(
    hookDiagnosis.managedPostToolUseHooks,
    hookDiagnosis.legacyManagedPostToolUseHooks,
    30,
  )}`);
  if (hookDiagnosis.managedPostToolUseHooks.length > 0) {
    printCodexHookDetails(hookDiagnosis.managedPostToolUseHooks[0]);
  }
  console.log(`  Codex Stop hook:       ${describeCodexHookRegistration(
    hookDiagnosis.managedStopHooks,
    hookDiagnosis.legacyManagedStopHooks,
    300,
  )}`);
  if (hookDiagnosis.managedStopHooks.length > 0) {
    printCodexHookDetails(hookDiagnosis.managedStopHooks[0]);
  }
  console.log(`  VSCode monitor task:   ${monitorTaskDiagnosis.status}`);
  if (monitorTaskDiagnosis.path) {
    console.log(`    path:                ${monitorTaskDiagnosis.path}`);
  }
  if (monitorTaskDiagnosis.runOn) {
    console.log(`    runOn:               ${monitorTaskDiagnosis.runOn}`);
  }
  if (monitorTaskDiagnosis.note) {
    console.log(`    note:                ${monitorTaskDiagnosis.note}`);
  }
  console.log(
    `  current Codex thread:  ${
      identity.codexThreadId
        ? `${identity.codexThreadId} (${identity.codexThreadIdSource})`
        : 'not detected'
    }`,
  );
  console.log(`  rollout candidates:    ${candidates.length}`);
  if (candidates.length > 0) {
    const latest = candidates[0];
    console.log(`  latest rollout:        ${latest.id}`);
    console.log(`    updatedAt:           ${latest.updatedAt}`);
    console.log(`    path:                ${latest.rolloutPath}`);
  }
  console.log(`  captured DB sessions:  ${capturedCount}`);
  if (latestCaptured) {
    console.log(`  latest DB session:     ${latestCaptured.session_id}`);
    console.log(`    updatedAt:           ${formatTs(latestCaptured.updated_at)}`);
  }
  if (refreshDiagnosis) {
    console.log(`  context refresh:       ${refreshDiagnosis.status}`);
    if (refreshDiagnosis.blockedReason) {
      console.log(`    blocked reason:      ${refreshDiagnosis.blockedReason}`);
    }
    console.log(`    rollback source:     ${refreshDiagnosis.rollbackSource}`);
    console.log(`    inject memory source: ${refreshDiagnosis.injectMemorySource}`);
    console.log(`    memory contract:     ${refreshDiagnosis.memoryContract}`);
    console.log(`    L1 summaries:        ${refreshDiagnosis.l1Summaries}`);
    console.log(`    recent L2 bodies:    ${refreshDiagnosis.recentBodies}`);
    console.log(`    L3 references only:  ${refreshDiagnosis.l3References} (bodies not injected)`);
    if (refreshDiagnosis.handoffSmoke) {
      console.log(`    new-thread handoff:  ${refreshDiagnosis.handoffSmoke.status}`);
      if (refreshDiagnosis.safeContinuationStatus) {
        console.log(`      safe continuation: ${refreshDiagnosis.safeContinuationStatus}`);
      }
      console.log(`      prompt chars:      ${refreshDiagnosis.handoffSmoke.promptChars}`);
      console.log(`      estimated tokens:  ${refreshDiagnosis.handoffSmoke.estimatedTokens}`);
    }
    if (refreshDiagnosis.estimate) {
      console.log(`    estimated reduction: ${refreshDiagnosis.estimate}`);
    }
  }
  console.log(`  host primitive audit:  ${hostPrimitiveDiagnosis.status}`);
  console.log(`    reason:              ${hostPrimitiveDiagnosis.reason}`);
  console.log(
    `    current-thread non-resurrection: ${
      hostPrimitiveDiagnosis.hasCurrentThreadNonResurrectionPrimitive ? 'yes' : 'no'
    }`,
  );
  console.log(`    repair contract:     ${hostPrimitiveDiagnosis.repairContractStatus}`);
  console.log('');
  console.log('  next commands:');
  if (identity.codexThreadId) {
    console.log(`    throughline codex-capture --codex-thread-id ${identity.codexThreadId}`);
    console.log(`    throughline codex-handoff-start --session codex:${identity.codexThreadId}`);
    console.log(`    throughline codex-handoff-smoke --session codex:${identity.codexThreadId}`);
    console.log(`    throughline codex-handoff-model-smoke --session codex:${identity.codexThreadId} --dry-run --json`);
    console.log(`    throughline codex-resume --session codex:${identity.codexThreadId} --format handoff`);
    console.log(`    throughline codex-resume --session codex:${identity.codexThreadId}`);
    console.log(`    THROUGHLINE_EXPERIMENTAL_CODEX_HANDOFF_MODEL_SMOKE=1 throughline codex-handoff-model-smoke --session codex:${identity.codexThreadId}`);
  } else {
    console.log('    throughline codex-threads --limit 5');
    console.log('    throughline codex-capture --codex-thread-id <id>');
    console.log('    throughline codex-handoff-start --session codex:<id>');
    console.log('    throughline codex-handoff-smoke --session codex:<id>');
    console.log('    throughline codex-handoff-model-smoke --session codex:<id> --dry-run --json');
    console.log('    throughline codex-resume --session codex:<id> --format handoff');
    console.log('    throughline codex-resume --session codex:<id>');
    console.log('    THROUGHLINE_EXPERIMENTAL_CODEX_HANDOFF_MODEL_SMOKE=1 throughline codex-handoff-model-smoke --session codex:<id>');
  }
  console.log('    throughline doctor --trim --host codex');
  console.log('    throughline codex-host-primitive-audit');
}

function readCodexHostPrimitiveDiagnosis({
  env = process.env,
  auditRunner = runCodexHostPrimitiveAudit,
} = {}) {
  const command = env.THROUGHLINE_CODEX_APP_SERVER_BIN ?? 'codex';
  try {
    const audit = auditRunner({ command });
    return {
      status: audit.status ?? 'unknown',
      reason: audit.reason ?? 'unknown',
      hasCurrentThreadRemediationPrimitive: Boolean(
        audit.facts?.hasCurrentThreadRemediationPrimitive,
      ),
      hasCurrentThreadNonResurrectionPrimitive: Boolean(
        audit.facts?.hasCurrentThreadNonResurrectionPrimitive ??
          audit.facts?.hasCurrentThreadRemediationPrimitive,
      ),
      repairContractStatus: audit.repairContract?.status ?? 'unknown',
      methodCount: audit.methodCount ?? null,
    };
  } catch (err) {
    return {
      status: 'unavailable',
      reason: err instanceof Error ? err.message : String(err),
      hasCurrentThreadRemediationPrimitive: false,
      hasCurrentThreadNonResurrectionPrimitive: false,
      repairContractStatus: 'unavailable',
      methodCount: null,
    };
  }
}

function readVsCodeMonitorTaskDiagnosis(cwd) {
  const tasksPath = join(cwd, '.vscode', 'tasks.json');
  if (!existsSync(tasksPath)) {
    return {
      status: 'not registered',
      path: tasksPath,
      note: 'created by the next VSCode hook event; if the folder is already open, reload VSCode once after creation',
    };
  }

  let text;
  try {
    text = readFileSync(tasksPath, 'utf8');
  } catch (err) {
    return {
      status: 'unreadable',
      path: tasksPath,
      note: err instanceof Error ? err.message : 'read failed',
    };
  }

  if (detectJsoncFeatures(text)) {
    return {
      status: 'jsonc not inspected',
      path: tasksPath,
      note: 'Throughline will not auto-edit JSONC tasks; add or verify the monitor task manually',
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      status: 'parse error',
      path: tasksPath,
      note: 'tasks.json is not valid JSON; Throughline will not auto-edit it',
    };
  }

  const index = findMonitorTaskIndex(parsed);
  if (index < 0) {
    return {
      status: 'not registered',
      path: tasksPath,
      note: 'created by the next VSCode hook event; if the folder is already open, reload VSCode once after creation',
    };
  }

  const task = parsed.tasks[index];
  if (isMonitorTaskBroken(task)) {
    return {
      status: 'registered but broken',
      path: tasksPath,
      runOn: task?.runOptions?.runOn ?? '(missing)',
      note: 'existing task points at a missing absolute path; the next VSCode hook event should repair it',
    };
  }

  return {
    status: 'registered',
    path: tasksPath,
    runOn: task?.runOptions?.runOn ?? '(missing)',
    note: 'if it was created after this folder was already open, run Developer: Reload Window once or start the Throughline Monitor task manually',
  };
}

function buildCodexContextRefreshDiagnosis({ db, cwd, codexHome, identity }) {
  if (!identity.codexThreadId) return null;

  let trimSource = null;
  try {
    trimSource = buildCodexRolloutTrimSource({
      threadId: identity.codexThreadId,
      codexHome,
      projectPath: cwd,
      sourceReason:
        identity.codexThreadIdSource && identity.codexThreadIdSource.startsWith('env:')
          ? 'env_codex_thread_rollout'
          : 'explicit_codex_thread_rollout',
    });
  } catch {
    trimSource = null;
  }

  let plan;
  try {
    plan = buildTrimPlan(db, {
      projectPath: cwd,
      host: 'codex',
      trimAll: true,
      codexThreadId: identity.codexThreadId,
      codexThreadIdSource: identity.codexThreadIdSource,
      trimSource,
    });
  } catch {
    return {
      status: 'unavailable',
      rollbackSource: trimSource?.source ?? 'unknown',
      injectMemorySource: 'unknown',
      memoryContract: 'unavailable',
      l1Summaries: 'unknown',
      recentBodies: 'unknown',
      l3References: 'unknown',
      estimate: null,
    };
  }

  const stats = plan.memoryPreview?.stats ?? {};
  const hasDbMemory =
    stats.source === 'throughline-db' &&
    ((stats.l1Summaries ?? 0) > 0 || (stats.recentBodies ?? 0) > 0 || (stats.l3References ?? 0) > 0);
  let handoffSmoke = null;
  if (hasDbMemory) {
    try {
      const record = buildHandoffRecord(db, {
        sessionId: `codex:${identity.codexThreadId}`,
        isInheritance: false,
      });
      if (record) {
        const smoke = buildCodexHandoffSmoke(record);
        handoffSmoke = {
          status: smoke.status,
          reason: smoke.reason,
          promptChars: smoke.promptChars,
          estimatedTokens: smoke.estimatedTokens,
        };
      }
    } catch {
      handoffSmoke = {
        status: 'unavailable',
        reason: 'handoff_smoke_failed',
        promptChars: 'unknown',
        estimatedTokens: 'unknown',
      };
    }
  }
  const estimate = plan.trim?.contextReductionEstimate;
  return {
    status: hasDbMemory ? 'ready' : 'not ready',
    blockedReason: null,
    rollbackSource: plan.trim?.source ?? 'unknown',
    injectMemorySource: stats.source ?? 'unknown',
    memoryContract: hasDbMemory
      ? 'older L1 + latest 20 L2 full bodies + L3 references only'
      : 'Throughline DB memory required; rollout preview is not injected',
    l1Summaries: stats.l1Summaries ?? 0,
    recentBodies:
      typeof stats.recentBodies === 'number'
        ? `${stats.recentBodies} rows (latest ${stats.recentTurnLimit ?? DEFAULT_TRIM_KEEP_RECENT} turns)`
        : 'unknown',
    l3References: stats.l3References ?? 0,
    handoffSmoke,
    safeContinuationStatus:
      handoffSmoke?.status === 'ready'
        ? 'fresh-thread-handoff-available'
        : handoffSmoke
          ? 'handoff-not-ready'
          : null,
    estimate: estimate
      ? `${estimate.netEstimatedTokens} tokens (${estimate.reductionPct}%, ${estimate.method})`
      : null,
  };
}

export async function run(argv = []) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`[throughline doctor] ${err.message}\n`);
    process.exit(2);
  }

  if (args.session) {
    runSessionDiagnosis(args.session);
    return;
  }

  if (args.trim) {
    runTrimDiagnosis(args.host);
    return;
  }

  if (args.codex) {
    runCodexDiagnosis();
    return;
  }

  console.log('throughline doctor\n');

  // Node.js バージョン
  await check('Node.js >= 22.5', () => {
    const [major, minor] = process.versions.node.split('.').map(Number);
    if (major < 22 || (major === 22 && minor < 5)) {
      throw new Error(`Node.js ${process.versions.node} — 22.5 以上が必要`);
    }
    return process.versions.node;
  });

  // node:sqlite
  await check('node:sqlite が使えるか', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    new DatabaseSync(':memory:').close();
    return 'ok';
  });

  // DB ディレクトリ
  const dbDir = join(homedir(), '.throughline');
  const dbPath = join(dbDir, 'throughline.db');
  await check('~/.throughline/ ディレクトリ', () => {
    if (!existsSync(dbDir)) throw new Error('ディレクトリが存在しない（初回実行前）');
    accessSync(dbDir, constants.W_OK);
    return dbDir;
  });

  // DB ファイル
  await check('throughline.db', () => {
    if (!existsSync(dbPath)) return false; // 未作成（初回前）
    accessSync(dbPath, constants.W_OK);
    return dbPath;
  });

  // hook 登録確認（グローバルまたはプロジェクトローカル）
  const globalSettings = join(homedir(), '.claude', 'settings.json');
  const localSettings = join(process.cwd(), '.claude', 'settings.json');
  await check('Throughline hook が登録されているか', () => {
    function hasHook(filePath) {
      if (!existsSync(filePath)) return false;
      const settings = JSON.parse(readFileSync(filePath, 'utf8'));
      return Object.values(settings.hooks ?? {}).flat().some(group =>
        (group.hooks ?? []).some(h => h.command?.includes('throughline'))
      );
    }
    if (hasHook(globalSettings)) return 'グローバル (~/.claude/settings.json)';
    if (hasHook(localSettings)) return 'プロジェクトローカル (.claude/settings.json)';
    throw new Error('登録なし — throughline install を実行してください');
  });

  // PATH 上に throughline があるか
  await check('throughline コマンドが PATH で見つかるか', () => {
    try {
      const which = process.platform === 'win32' ? 'where throughline' : 'which throughline';
      const result = execSync(which, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
      return result.split(/\r?\n/)[0];
    } catch {
      throw new Error('見つからない — npm install -g throughline を実行してください');
    }
  });

  console.log('');
  console.log(`${DIM}ヒント: 特定セッションが止まって見えるときは ${RESET}throughline doctor --session <id-prefix>${DIM} で診断できます。${RESET}`);
  console.log(`${DIM}ヒント: trim の host 境界を見るには ${RESET}throughline doctor --trim --host claude${DIM} を使います。${RESET}`);
  console.log(`${DIM}ヒント: Codex primary の入口を見るには ${RESET}throughline doctor --codex${DIM} を使います。${RESET}`);
}

// テスト用エクスポート
export const _internal = {
  parseArgs,
  formatAgo,
  formatBytes,
  runSessionDiagnosis,
  runTrimDiagnosis,
  runCodexDiagnosis,
  buildCodexContextRefreshDiagnosis,
  readCodexHostPrimitiveDiagnosis,
  readCodexHookDiagnosis,
  describeCodexHookRegistration,
  printCodexHookDetails,
  readVsCodeMonitorTaskDiagnosis,
  isPidAlive,
  findLatestJsonlInSameDir,
};
