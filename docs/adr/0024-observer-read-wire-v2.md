# ADR 0024: observer-read wire v2 は全文・実harness・ターンの始まり方を opt-in で返す

日付: 2026-10-01

## Context

BellTeam は各Botの完了ターンを `observer-wait` / `observer-read` で受け取り、Botが裏の作業の完了で
自分から始めたターンの報告もオーナーへ届けることにした（2026-10-01、髪長の 12:22 報告が届かなかった件）。
v1 の page には次の欠けがあった。

1. 本文は1本文1200字・1ページ4000字を古いターンから使い、末尾を残して切る。新しいターンほど欠け、
   空になることもある（髪長の 13:09 / 13:10 で実測）。
2. Grok と Cursor は Claude 互換の Stop receipt を共用するため、`host` が `claude` になる。
3. ターンが人・配送の入力で始まったか、host が自分から始めたかを返さない。
4. Claude Code の hook `cwd` は Bash の `cd` に追従する。下位ディレクトリで終わったターンの受領は
   その下位 project に入り、起動 project の feed に出ない。下位 project を読むと session の
   project と一致せず hard failure になる。

v1 は別製品 Observer が使う不変契約（ADR 0007）なので、形を変えずに足す必要がある。

## Decision

1. `observer-read` に `--wire <v1|v2>` を0回または1回だけ受け付ける。既定は `v1` で、v1 の page は
   一切変えない。
2. v2 の page は schema `throughline.observer_read.v2`。status、cursor、page token、pagination は v1 と同じ。
   hard failure の固定 code と message も同じで、schema だけ v2 にする。
3. v2 の `user` / `assistant` は切らない全文で、`truncated` は常に `false`。量は `--limit`（1..100）で抑える。
4. v2 の `host`（page と各turn）は実際の harness。receipt lane では target session ID の prefix
   （`grok:` / `cursor:` / なし）から求める。cursor は lane のままなので wire に依存しない。
5. v2 の各turnに `turn_start` を付ける。値は `prompt` / `self` / `unknown`。
   - 判定は Stop 時の capture で、host が transcript に書いた印だけを使う（`src/turn-start.mjs`）。
     Claude `origin.kind`: `human`→prompt、`task-notification`・`auto-continuation`→self。
     Grok: `synthetic_reason` なしで `prompt_index` あり→prompt、`task_completed`→self。
     Cursor: 印の欄が無いため、自分から始める時の固定 `<user_query>` だけを self、他の `<user_query>`→prompt。
     それ以外は unknown。
   - 判定は DB schema v11 で足した `bodies.turn_start`（user 行）に残す。旧行と v11 前の DB は unknown。
   - Codex は入力でしかターンを始めず、feed は user 発言のある rollout turn だけを載せるので prompt。
6. Claude の完了受領は、Claude Code が hook へ渡す `CLAUDE_PROJECT_DIR`（起動 project）に書く。
   無い時は従来どおり hook `cwd`。Codex・Grok・Cursor は hook `cwd` のまま（Grok と Cursor は
   transcript path も cwd から導く）。

## Consequences

- 既存 Observer は何も変えずに v1 を読み続けられる。BellTeam は v2 で報告全文と始まり方を受け取る。
- Claude で下位ディレクトリに移って終わったターンも、起動 project の feed に載る。下位 project の
  受領 store には以後書かれない（その store を読むと v1 でも project 不一致で失敗していた）。
- 同じ project で複数スレッドが交互に動くと `thread_switched` で移り先の全履歴を返すのは v1 と同じ。
  受け取る側は `source_sha256` で重複を落とす。
- DB schema は v11 になる。`factory-diagnostics` は `throughline.database.v11` を返す。
