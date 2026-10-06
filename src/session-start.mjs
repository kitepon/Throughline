#!/usr/bin/env node
/**
 * SessionStart hook — セッション登録 + 引き継ぎ intent 登録（二相ハンドオフの第一相）
 *
 * stdin: { session_id, source, cwd, transcript_path, hook_event_name }
 *
 * 【二相ハンドオフ】 ADR 0014 / docs/02_clear_auto_handoff_plan.md
 *
 *   Claude Code は同一 project_path に対し短時間 (実測 315–488ms) に複数の
 *   SessionStart を発火させることがあり、一部は transcript を一度も生成しない
 *   幽霊セッションになる。SessionStart 時点では実体と幽霊を判別できない
 *   （transcript は本物でも hook より数百 ms 遅れて作られる）ため、
 *   この hook では merge も注入も行わない:
 *
 *   1. sessions テーブルに新セッションを INSERT OR IGNORE
 *   2. auto path (source='clear' かつ env THROUGHLINE_DISABLE_AUTO_HANDOFF != '1')
 *      なら前任candidateをこの時点で解決して凍結（transcript 実在フィルタ付き —
 *      幽霊 twin を前任に選ばない）
 *   3. registerPendingHandoff で intent を登録
 *   4. 判定を ~/.throughline/logs/inheritance-decision.log に記録 (phase='session-start')
 *
 *   バトンの消費・merge・注入は最初の UserPromptSubmit (= 実体の証明) で行う。
 *   幽霊はプロンプトを発火しないため記憶を奪えない。
 *
 * 【自動継続の後継】 ADR 0033
 *
 *   後継は、継続の指示を最初の指示として付けて起動される。SessionStart では何もしない。
 *   記憶の注入と受領は、その指示の UserPromptSubmit（上の二相ハンドオフの第二相）が行う。
 */

import { getDb } from './db.mjs';
import { registerPendingHandoff } from './pending-handoff.mjs';
import { deriveTranscriptPath } from './turn-backfill.mjs';
import { readAllSessionStates } from './state-file.mjs';
import { ensureMonitorTaskFile } from './vscode-task.mjs';
import { logDecision } from './decision-log.mjs';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { recordRuntimeErrorBestEffort } from './runtime-error-store.mjs';
import { logHookFailure } from './hook-failure-log.mjs';
import { CLAUDE_HOST, hostAdapterForSessionId, hostOfSessionId, NON_CLAUDE_SESSION_PREFIXES, parseHookPayload } from './hosts/index.mjs';
import { executeFirstPromptHandoff } from './handoff-executor.mjs';

const ENV_DISABLE_AUTO_HANDOFF = 'THROUGHLINE_DISABLE_AUTO_HANDOFF';

function isAutoHandoffDisabled(env) {
  return env[ENV_DISABLE_AUTO_HANDOFF] === '1';
}

/**
 * 同 project_path の最新 Claude unmerged session から、transcript が実在する
 * 最初の candidate を返す (auto path 用 predecessor)。
 *
 * transcript 実在フィルタの理由 (ADR 0014): /clear の二重 SessionStart では
 * 幽霊 twin も sessions 行を持ち、updated_at が最新になるため、フィルタ無しだと
 * 幽霊を前任に選んで実前任を取りこぼす (2026-05 の auto path incident 群)。
 * 実前任は /clear 前に活動していた実体なので transcript を必ず持つ。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} projectPath
 * @param {string} currentSessionId
 * @returns {{ session_id: string } | null}
 */
function findLatestClaudePredecessor(db, projectPath, currentSessionId) {
  // Claude 以外の host session (prefix 付き) を前任候補から除外する。
  // prefix の正本は hosts/identity.mjs。
  const nonClaudeExclusion = NON_CLAUDE_SESSION_PREFIXES
    .map(() => 'AND session_id NOT LIKE ?')
    .join('\n         ');
  const candidates = db
    .prepare(
      `SELECT session_id FROM sessions
       WHERE lower(project_path) = lower(?)
         AND merged_into IS NULL
         AND session_id != ?
         ${nonClaudeExclusion}
       ORDER BY updated_at DESC
       LIMIT 5`,
    )
    .all(
      projectPath,
      currentSessionId,
      ...NON_CLAUDE_SESSION_PREFIXES.map((prefix) => `${prefix}%`),
    );

  if (candidates.length === 0) return null;

  const states = readAllSessionStates();
  for (const row of candidates) {
    const derived = deriveTranscriptPath(projectPath, row.session_id);
    if (existsSync(derived)) return row;
    const stateTranscriptPath = states.find(
      (state) => state.sessionId === row.session_id,
    )?.transcriptPath;
    if (stateTranscriptPath && existsSync(stateTranscriptPath)) return row;
  }
  return null;
}

export async function run() {
  let raw = '';
  await new Promise((resolve) => {
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      raw += chunk;
    });
    process.stdin.on('end', resolve);
  });

  const payload = parseHookPayload(raw, { env: process.env });
  const { session_id, cwd, source, transcript_path } = payload;

  if (!session_id) throw new Error('Missing session_id in SessionStart payload');

  const projectPath = cwd ?? process.cwd();
  const db = getDb();
  const now = Date.now();

  // 0. VSCode 用 tasks.json 自動プロビジョニング (冪等)
  try {
    ensureMonitorTaskFile({ cwd: projectPath, env: process.env });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown';
    process.stderr.write(`[vscode-task] ${msg}\n`);
  }

  // 1. sessions テーブルに INSERT OR IGNORE
  db.prepare(
    `INSERT OR IGNORE INTO sessions (session_id, project_path, status, created_at, updated_at)
     VALUES (?, ?, 'active', ?, ?)`,
  ).run(session_id, projectPath, now, now);

  // 2. auto path intent: source='clear' なら前任をこの時点で解決して凍結する。
  //    初回プロンプトまでの間に他ウィンドウが動いても「/clear が意味した前任」がずれない。
  const autoDisabled = isAutoHandoffDisabled(process.env);
  let autoPredecessorId = null;
  let intentNote = null;
  if (source === 'clear' && autoDisabled) {
    intentNote = 'auto_handoff_disabled';
  } else if (source === 'clear') {
    const predRow = findLatestClaudePredecessor(db, projectPath, session_id);
    if (predRow?.session_id) {
      autoPredecessorId = predRow.session_id;
    } else {
      intentNote = 'no_predecessor';
    }
  }

  // 3. pending intent 登録。merge / 注入はしない (最初の UserPromptSubmit で実行)。
  registerPendingHandoff(db, {
    sessionId: session_id,
    projectPath,
    source: source ?? null,
    autoPredecessorId,
    now,
  });

  logDecision({
    ts: new Date(now).toISOString(),
    phase: 'session-start',
    source: source ?? null,
    session_id,
    project_path: projectPath,
    transcript_path: transcript_path ?? null,
    auto_handoff_disabled: autoDisabled,
    auto_predecessor_id: autoPredecessorId,
    intent_note: intentNote,
    pending_registered: true,
  });

  // Cursor は beforeSubmitPrompt が additional_context を持たない。
  // 新規 composer 会話の sessionStart が公式の注入口なので、ここで第二相を実行する。
  // Claude の幽霊 SessionStart 問題はこの host では sessionStart = 会話作成のため適用しない。
  // クラウド / background agent は baton を奪わない。
  const hostAdapter = hostAdapterForSessionId(session_id);
  if (hostAdapter.consumesHandoffAtSessionStart === true && payload.is_background_agent !== true) {
    const handoff = executeFirstPromptHandoff(db, {
      sessionId: session_id,
      projectPath,
      now,
    });
    if (handoff.attempted && handoff.injectionText) {
      const delivery = hostAdapter.deliverHandoffInjection({
        payload,
        text: handoff.injectionText,
      });
      if (!delivery.delivered) {
        process.stderr.write(`[session-start] ${delivery.reason}\n`);
      }
    }
  }

  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => {
    recordRuntimeErrorBestEffort('HOOK_SESSION_START_FAILED');
    logHookFailure('HOOK_SESSION_START_FAILED', err);
    process.stderr.write(`[session-start] error: ${err.message}\n`);
    process.exit(1);
  });
}
