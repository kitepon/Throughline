# ADR 0021: Treat Grok as a first-class Throughline host

Date: 2026-08-17

## Status

Accepted

## Context

Throughline v0.9.1 no-op'd Grok camelCase hook envelopes (GF04) because Grok was not a factory parent host. Wave 5 made Grok a peer parent. The 2026-08-16 factory ruling requires Throughline Grok capture / restore / handoff.

Grok stores turns in `~/.grok/sessions/<encodeURIComponent(cwd)>/<sessionId>/chat_history.jsonl`, not Claude JSONL.

## Decision

- Grokの予約環境変数（`GROK_HOOK_EVENT` / `GROK_SESSION_ID`）をhost境界とする。
- camelCase (`sessionId` / `hookEventName`) とsnake_case (`session_id` /
  `hook_event_name`) のどちらも既存hook契約へ正規化し、idへ`grok:`を付ける。
  Grok 1.0.13のように両方が同居してもCursorとして分類しない。
- Read L2 from Grok `chat_history.jsonl`. Do not invent a Claude-shaped transcript.
- Grok host ignores payload `transcriptPath`. Live Stop sends `updates.jsonl`, which has no user/assistant rows.
- Install product hooks at `~/.grok/hooks/throughline.json`. Do not write factory.json.
- Grok hook `command` is absolute `node` + `bin/throughline.mjs` + subcommand. Do not write bare `throughline`.
- Keep Claude and Codex adapters unchanged. Do not mix `grok:` rows into Claude predecessor search.
- Grok `/tl` / `/clear` / `/new` detection reads the inner `<user_query>`. If the hook `prompt` is empty, fall back to the last user row in `chat_history.jsonl`. Do not treat `source=new` as Claude `source=clear` auto-handoff.
- Grok UserPromptSubmit stdout is observe-only. Writing into `chat_history.jsonl` does not enter the live model prompt. Live conversation is `updates.jsonl`. Claude still uses stdout additionalContext.

## Consequences

- GF04 no-op is withdrawn.
- Restore/handoff for `grok:` sessions reuse existing DB + `handoff-context` after capture exists.
- Live Grok hook fire on each seat is a separate install+new-session acceptance.

## 現在地

Grok 1.0.4 バイナリの hook 出力型は `GateHookJson`（PreToolUse deny/updatedInput）と `StopHookJson`（block/additionalContext/stopReason）だけ。UserPromptSubmit / SessionStart / PostToolUse の stdout は observe。モデルへ文章を渡せる公式口は (1) PreToolUse deny の reason (2) Stop/SubagentStop の block reason / additionalContext / exit2 stderr。初回トークン前の prompt 注入口は無い。Stop 注入は初回返答のあと 2 周目に載る。`01a00cfe` の chat_history 書き込みは updates に乗らず実証済み。capture と handoff-context は生きている。

`/tl` 後の記憶再開は hook stdout や `chat_history.jsonl` 再注入では成立しない。後継経路は Throughline 所有の最小起動に固定する。実装・受入履歴は [plan_grok-successor-launch.md](../archive/plan_grok-successor-launch.md)。

- CLI: `throughline grok-continue --session <id>`。`<id>` は `grok:` 接頭辞付き Throughline session id。`--from` は採用しない。
- 内部で `handoff-context --session <id> --json` を読む。ready でなければ spawn しない。
- 初手 user 文は次の 4 段だけ。`{context}` は handoff-context の `context` 文字列。JSON envelope は載せない。末尾は待機。

  ```
  この発言は直前 Throughline 席の履歴を前提とする。

  {context}

  直前の作業の自然な続きとして応答すること。

  この後ユーザーが指示を出す。何もせず待機すること。
  ```

- 通常の`{context}`は引き継ぎの事実と保持ターン数を最初の応答で一度だけ案内し、後続応答では
  繰り返させない。project束縛済み補足が`handoffDisclosure: silent`を指定した時だけ案内しない。
  Throughline自身が旧版でassistantへ付けた固定宣言は後継へ渡す会話本文から除外し、ユーザーが
  同じ文を引用した内容は保持する。

- spawn の cwd は源セッションの `project_path`。呼び出し元 cwd は使わない。共有 `GROK_HOME` の対話 `grok`。位置引数 `[PROMPT]` を使う。`--rules` / `--system-prompt-override` / `--agent` / 単発 `-p` は使わない。aiterm は使わない。
- Claude / Codex の `/tl` 契約は変えない。Grok `/tl` 成功後の副作用起動だけが配線対象。
- 一覧の正は `~/.grok/sessions/<encodeURIComponent(cwd)>/<id>/`。Desktop Inactive 畳みは成功条件にしない。
- L2 が無い源（`merged_into` チェーンの空席など）では spawn しない。新しい chat で 1〜2 往復してから `/tl` する。

2026-08-17 実機受入: `grok:01a00ff1-3f97-70e2-ba76-5acd90561a84` の `/tl` が
`c01a2689-5b4f-4977-97ce-f73fcf317f94` を Dotagents 棚に立て、初手末尾は待機、
後継は待って止まった。v0.10.0 で公開。

## 追記（2026-10-12、ADR 0056）

Grok は自動圧縮で `chat_history.jsonl` を書き直す。位置だけで保存済みを決めると、圧縮をまたいだターンが落ちる。
Grok が自分で書く user 行（`compaction_meta`・`system_reminder`）の扱いと合わせて、ADR 0056 で直した。
