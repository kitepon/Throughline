/**
 * haiku-summarizer.mjs — L1 要約生成
 *
 * 基本方針 (モデル・比率の根拠は ADR 0015 の実測評価):
 *   - Claude primary の backend 順序: Codex CLI (既定 gpt-5.6-luna / effort low) → Claude Haiku
 *     → L2 全文を L1 に入れる（情報欠損ゼロ）。各段の失敗理由は結果に記録する。
 *   - Codex primary では、Codex CLI backend を使い、失敗時は Haiku / raw L2 へ
 *     fallback せず explicit error にする。
 *   - 要約の目標量は削減割合で決める（既定 1/5 = 0.2）。プロンプトへは割合から
 *     換算した「約N文字」で渡す（LLM の長さ制御は割合指定より文字数指定が安定）。
 *
 * 設定 (env):
 *   - THROUGHLINE_L1_MODEL:  Codex CLI 要約モデル (既定 'gpt-5.6-luna')
 *   - THROUGHLINE_L1_EFFORT: Codex CLI reasoning effort (既定 'low')
 *   - THROUGHLINE_L1_RATIO:  削減割合 (0 < r <= 1、既定 0.2 = 元の 1/5)。
 *     不正値は黙って既定に落とさず explicit error にする。
 *
 * Claude Haiku 経路:
 *   Claude Max 契約前提。`claude -p --model claude-haiku-4-5-20251001`
 *   を子プロセス起動する。Anthropic API キーは使わない（Claude Code CLI が
 *   Max 契約の認証を持っている前提）。
 *
 * 【Haiku 再帰暴走の根本対策: 隔離 cwd で spawn】
 *   素朴に `claude -p` を spawn すると subprocess が同じ .claude/settings.json を
 *   読んで Throughline の Stop hook を起動し、無限再帰になる。
 *
 *   これを物理的に不可能にするため、subprocess は Throughline の project-local
 *   設定が見つからない空ディレクトリ（~/.throughline/haiku-workdir/）を cwd に
 *   して起動する。Claude Code は cwd 起点で .claude/settings.json を探すので、
 *   project-local 設定はロードされない。global (~/.claude/settings.json) のみ
 *   適用されるが、そこに Throughline hook は置かれない運用前提。
 *
 *   複数プロジェクト・複数セッションで並列実行しても互いに干渉しない（各呼び出し
 *   は独立した subprocess、ロックなし）。
 *
 *   さらに三重防御として env var THROUGHLINE_IN_HAIKU_SUBPROCESS=1 も設定する。
 *   万一 global に Throughline hook が紛れ込んでも turn-processor 冒頭で exit する。
 *
 * 失敗時のポリシー:
 *   1. 2 回までリトライ
 *   2. それでも失敗したら L2 全文を L1 に入れる（情報欠損ゼロ）
 */

import { mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { spawnPortableSync } from './os/portable-spawn-sync.mjs';

const MODEL = 'claude-haiku-4-5-20251001';
// Codex CLI 要約の既定。gpt-5.6-luna@low@1/5 は 2026-07-17 の実測評価で選定
// (8 実ソース × effort {none,low,medium} × 2 反復、要点拾い率 low=93% で
//  medium と同点・none+4pt、レイテンシ median 12.4s。ADR 0015)。
const L1_DEFAULT_CODEX_MODEL = 'gpt-5.6-luna';
const L1_DEFAULT_CODEX_EFFORT = 'low';
const L1_DEFAULT_RATIO = 0.2; // 元テキストの 1/5
const MAX_RETRIES = 2;
const TIMEOUT_MS = 30_000;
const CODEX_CLI_TIMEOUT_MS = 60_000;
const RECURSION_GUARD_ENV = 'THROUGHLINE_IN_HAIKU_SUBPROCESS';
const CODEX_SUMMARIZER_GUARD_ENV = 'THROUGHLINE_IN_CODEX_SUMMARIZER';

// 隔離 cwd: Throughline project-local 設定が見つからない空ディレクトリ
const HAIKU_WORKDIR = join(homedir(), '.throughline', 'haiku-workdir');

function ensureWorkdir() {
  try {
    mkdirSync(HAIKU_WORKDIR, { recursive: true });
  } catch {
    // ignore
  }
}

/**
 * 削減割合を env から解決する。不正値は黙って既定へ落とさず explicit error
 * （フォールバック禁止原則。設定ミスは沈黙劣化ではなく即座に見えるべき）。
 */
export function resolveL1Ratio(env = process.env) {
  const raw = env.THROUGHLINE_L1_RATIO;
  if (raw === undefined || raw === '') return L1_DEFAULT_RATIO;
  const ratio = Number(raw);
  if (!Number.isFinite(ratio) || ratio <= 0 || ratio > 1) {
    throw new Error(
      `invalid THROUGHLINE_L1_RATIO: ${JSON.stringify(raw)} ` +
        '(expected a fraction in (0, 1], e.g. 0.2 = compress to 1/5)',
    );
  }
  return ratio;
}

function resolveL1CodexModel(env) {
  return env.THROUGHLINE_L1_MODEL || L1_DEFAULT_CODEX_MODEL;
}

function resolveL1CodexEffort(env) {
  return env.THROUGHLINE_L1_EFFORT || L1_DEFAULT_CODEX_EFFORT;
}

function buildPrompt(l2Text, ratio) {
  const targetChars = Math.max(20, Math.round(l2Text.length * ratio));
  return (
    `次の日本語テキストを約${targetChars}文字に要約してください。` +
    `固有名詞・数値・因果関係を優先して残し、枝葉は落としてください。` +
    `要約文だけを出力し、前置きや説明は不要です。`
  );
}

function buildCodexPrompt(l2Text, ratio) {
  return (
    `${buildPrompt(l2Text, ratio)}\n\n` +
    'Output contract:\n' +
    '- Return only the summary text.\n' +
    '- Do not include Markdown fences, JSON, labels, or commentary.\n\n' +
    'Text to summarize is provided on stdin.'
  );
}

function compactSubprocessStderr(stderr) {
  if (!stderr) return '';
  const compacted = String(stderr)
    .split('\n')
    .map((line) => (line.length > 600 ? `${line.slice(0, 600)} ...[line truncated]` : line))
    .join('\n');
  if (compacted.length <= 6_000) return compacted;
  return `${compacted.slice(0, 1_500)}\n...[stderr truncated]...\n${compacted.slice(-3_500)}`;
}

function summarizeWithHaiku(l2Text, prompt, env) {
  // child_process に渡す env: 親の env を継承しつつ再帰ガードをセット
  const childEnv = { ...env, [RECURSION_GUARD_ENV]: '1' };

  // 隔離 cwd を準備（project-local .claude/settings.json が見えない場所）
  ensureWorkdir();

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const result = spawnPortableSync('claude', ['-p', '--model', MODEL, prompt], {
        input: l2Text,
        encoding: 'utf8',
        timeout: TIMEOUT_MS,
        env: childEnv,
        cwd: HAIKU_WORKDIR, // ← これが再帰防止の本丸
      });

      if (result.status === 0 && result.stdout) {
        const summary = result.stdout.trim();
        if (summary) return { summary, fromFallback: false, source: 'haiku' };
      }
      // status != 0 や空出力は失敗とみなしてリトライ
    } catch {
      // spawn 失敗 (ENOENT 等) もリトライ
    }
  }

  // 全リトライ失敗 → L2 全文をそのまま L1 に（情報欠損ゼロ）
  return { summary: l2Text, fromFallback: true, source: 'raw_l2' };
}

function summarizeWithCodexCli(l2Text, { projectPath, env, ratio }) {
  if (!projectPath) {
    const err = new Error('Codex CLI summarizer requires projectPath');
    err.source = 'codex-cli';
    err.reason = 'missing_project_path';
    throw err;
  }

  if (env[CODEX_SUMMARIZER_GUARD_ENV] === '1') {
    const err = new Error('Codex CLI summarizer recursion guard');
    err.source = 'codex-cli';
    err.reason = 'recursion_guard';
    throw err;
  }

  const command = env.THROUGHLINE_CODEX_CLI_BIN ?? 'codex';
  const prompt = buildCodexPrompt(l2Text, ratio);
  const childEnv = { ...env, [CODEX_SUMMARIZER_GUARD_ENV]: '1' };
  // モデル・effort は明示指定する。--ignore-user-config は isolation のために
  // 必要だが、これにより ~/.codex/config.toml のモデル選択も読まれないため、
  // 明示しないと CLI 内蔵デフォルトで走ってしまう (ADR 0015 で実測確認)。
  const result = spawnPortableSync(
    command,
    [
      'exec',
      '--ephemeral',
      '--ignore-user-config',
      '--ignore-rules',
      '--skip-git-repo-check',
      '--sandbox',
      'read-only',
      '-m',
      resolveL1CodexModel(env),
      '-c',
      `model_reasoning_effort=${resolveL1CodexEffort(env)}`,
      '-C',
      projectPath,
      prompt,
    ],
    {
      input: l2Text,
      encoding: 'utf8',
      timeout: CODEX_CLI_TIMEOUT_MS,
      env: childEnv,
      cwd: projectPath,
    },
  );

  if (result.status !== 0) {
    const err = new Error(`Codex CLI summarizer failed: exit ${result.status ?? 'unknown'}`);
    err.source = 'codex-cli';
    err.reason = 'codex_cli_failed';
    err.exitCode = result.status;
    err.stderr = compactSubprocessStderr(result.stderr);
    throw err;
  }

  const summary = result.stdout?.trim();
  if (!summary) {
    const err = new Error('Codex CLI summarizer returned empty output');
    err.source = 'codex-cli';
    err.reason = 'empty_output';
    err.stderr = compactSubprocessStderr(result.stderr);
    throw err;
  }

  return { summary, fromFallback: false, source: 'codex-cli' };
}

/**
 * claude-primary 用: Codex CLI 要約を試み、失敗は throw せず理由付きで返す。
 * codex-primary の explicit error 契約 (summarizeWithCodexCli) はそのまま使い、
 * ここでは「次の backend へ進む」ための宣言済み fallback として理由を保存する。
 */
function tryCodexCliSummary(l2Text, { projectPath, env, ratio }) {
  try {
    const result = summarizeWithCodexCli(l2Text, { projectPath, env, ratio });
    return { summary: result.summary, reason: 'codex_cli_ok' };
  } catch (err) {
    return {
      summary: null,
      reason: err?.reason ? `codex_cli_${err.reason}` : 'codex_cli_failed',
    };
  }
}

/**
 * L2 本文を削減割合 (既定 1/5、THROUGHLINE_L1_RATIO で変更可) で要約する。
 * @param {string} l2Text ターンの会話本文（user+assistant を適当な形式で結合した文字列）
 * @param {{ projectPath?: string, env?: NodeJS.ProcessEnv, hostMode?: 'claude-primary' | 'codex-primary' | 'unknown' }} [options]
 * @returns {{ summary: string, fromFallback: boolean, source?: string, codexCliReason?: string }}
 */
export function summarizeToL1(
  l2Text,
  { projectPath = null, env = process.env, hostMode = 'unknown' } = {},
) {
  if (!l2Text || !l2Text.trim()) {
    return { summary: '(no content)', fromFallback: true, source: 'empty' };
  }

  const ratio = resolveL1Ratio(env);

  if (hostMode === 'codex-primary') {
    return summarizeWithCodexCli(l2Text, { projectPath, env, ratio });
  }

  if (hostMode !== 'claude-primary') {
    const err = new Error('summarizeToL1 requires hostMode claude-primary or codex-primary');
    err.source = 'unknown';
    err.reason = 'unknown_host_mode';
    throw err;
  }

  // 防御（念のため）: 自分自身が Haiku subprocess 内で呼ばれていたら再帰せず即フォールバック
  if (env[RECURSION_GUARD_ENV] === '1') {
    return { summary: l2Text, fromFallback: true, source: 'recursion_guard' };
  }

  const prompt = buildPrompt(l2Text, ratio);
  const codexCli = tryCodexCliSummary(l2Text, { projectPath, env, ratio });
  if (codexCli.summary) {
    return {
      summary: codexCli.summary,
      fromFallback: false,
      source: 'codex-cli',
      codexCliReason: codexCli.reason,
    };
  }

  const haiku = summarizeWithHaiku(l2Text, prompt, env);
  return {
    ...haiku,
    codexCliReason: codexCli.reason,
  };
}
