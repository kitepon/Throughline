/**
 * hosts/codex.mjs — Codex host adapter
 *
 * Codex session (`codex:<thread_id>`) は Claude-facing hook (SessionStart /
 * UserPromptSubmit / Stop) を通らず、専用入口 `throughline codex-hook`
 * ([src/cli/codex-hook.mjs](../cli/codex-hook.mjs)) で capture される。
 * この adapter は共有コードが Codex session を Claude と取り違えないための
 * 識別と、Claude-facing hook に Codex session が流入した場合の既存挙動
 * (Claude と同じ経路で処理する) を明文化する。
 */
import { CODEX_HOST, isCodexSessionId } from './identity.mjs';

export const codexHostAdapter = Object.freeze({
  host: CODEX_HOST,
  matchesSessionId: isCodexSessionId,
  // Codex の Observer feed は rollout の task_complete から作るため、受領先は従来どおり cwd。
  completionProjectPath: ({ cwd }) => cwd,
  // 既存挙動: Claude Stop hook の flush barrier は grok 以外 (codex: 含む) に適用される。
  waitsForStopTranscriptFlush: true,
  deliverHandoffInjection({ text, stdout = process.stdout }) {
    stdout.write(text + '\n');
    return { delivered: true };
  },
  resolveCommandPrompt({ prompt }) {
    return prompt;
  },
  consumesHandoffAtSessionStart: false,
  afterBatonWrite() {
    return { launched: false };
  },
});
