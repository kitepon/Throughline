# ADR 0032: Claude Code の自動継続は、自動圧縮の直後に同じ会話へ記憶を注入する

日付: 2026-10-04

## Context

Codex Desktop の自動継続（0.11.0）は、自動圧縮の前に旧タスクを止め、記憶を注入した新しいタスクで
作業を続ける。オーナーの指示（2026-10-04）で、同じことを Claude Code でも行う。

Claude Code 2.1.289 で、Codex と同じ方式が取れるかを公式の hook 仕様と実機で確かめた。

| 必要な操作 | Codex Desktop | Claude Code 2.1.289 |
|---|---|---|
| 圧縮の前に作業を止める | `PreCompact` が `continue: false` を返す | `PreCompact` の `continue` は捨てられる。できるのは圧縮を止めること（exit code 2、`decision: "block"`）だけで、止めると会話は圧縮されないまま続き、文脈上限に達した後は元の error で失敗する |
| 新しい会話を作って記憶を入れる | app-server の `thread/start` と `thread/inject_items` | 公開された入口が無い |
| 新しい会話へ指示を送って始めさせる | 公式 queue への配送 | `claude-cli://` は入力欄へ下書きを入れるだけで送信しない。`claude --bg` は別の background session を作り、編集の前に git worktree へ移る。元の画面の会話は入れ替わらない |

一方、Claude Code は自動圧縮の後、同じ会話で作業をそのまま続ける。圧縮の直後に
`SessionStart`（`source: "compact"`）の hook を走らせ、その出力を圧縮後の文脈へ足すと公式文書に書かれている。

実機の結果（Linux、`claude -p`、Haiku 4.5、`CLAUDE_CODE_AUTO_COMPACT_WINDOW=100000`）:

- `PreCompact` は `trigger: "auto"` で届く。payload は `session_id`・`transcript_path`・`cwd`・`trigger`・`custom_instructions`。
- 圧縮の後、同じ `session_id` の `SessionStart(source=compact)` が届く。stdout は `<system-reminder>` として
  モデルへ届き、モデルは追加の入力なしで作業を続けた。9,099 字の出力は file 化されずにそのまま届いた。
- transcript は圧縮より前の行を残したまま、`system`（`subtype: "compact_boundary"`、`compactMetadata.trigger`）と、
  要約を本文に持つ `user` 行（`isCompactSummary: true`）を足す。圧縮境界の行は `SessionStart` hook が
  走った時刻より後の時刻を持つ。
- 1回目の圧縮の前に `PreCompact` が5秒の間隔で2回届いたことがある。
- 依頼を送った直後（最初の応答の前）に自動圧縮が起きることがある。その回では、`SessionStart(source=compact)` の
  時点で、送った依頼の行は transcript に書かれていた。行の `promptId` は hook payload の `prompt_id` と同じ値。

あわせて、既存の不具合が見つかった。`readTranscript` は要約の `user` 行を人の発言として数えていた。
圧縮をまたいだ1ターンは「元の依頼 + 途中の発言」と「要約 + 圧縮後の発言」に割れ、要約が user 発言として
bodies に入り、圧縮より前の tool 入出力は L3 に入らなかった。3回圧縮した実機のターンは4ターンとして保存された。

## Decision

Claude では会話を切り替えず、host が続ける同じ会話へ記憶を渡す。

1. **印**: `PreCompact` hook（`throughline pre-compact`、matcher 無し）が、`trigger: "auto"` で自動継続が有効な
   project の時だけ、`~/.throughline/claude-auto-handoff/<session_id>.json` に印を残す。手動の `/compact` と
   無効の時は、同じ会話の古い印を消す。subagent の中の圧縮（payload に `agent_id`）は印に触らない。
   hook は圧縮を止めない。stdout へ何も書かず、失敗しても exit code 2 を返さない。
2. **注入**: `SessionStart(source=compact)` が印を取り出して消し、次を stdout へ書く（上限 9,500 字、ADR 0014）。
   - ヘッダ: 自動圧縮が起きたこと、下記が圧縮前の原文であること、作業の途中なので入力を待たずに続けること、
     完了済みの操作を繰り返さないこと。宣言文は求めない。
   - 現在地: 作業途中のターンの user 依頼（4,000 字まで）と、圧縮直前の assistant 発言（1,500 字まで）。
     transcript から読む。上限を超える時は先頭 3/4 と末尾 1/4 を残し、間を抜いた字数を書く。
   - 案内と L2: `/clear` の引き継ぎ（ADR 0016）と同じ。完了済みのターンを新しい順に、丸ごと入る分だけ。
3. **作業途中のターンは保存しない**: 注入の前に完了済みのターンを bodies へ回収するが、最後の user 発言の群は除く。
   途中の発言を代表として保存すると、群レベルの重複除去で最終回答が入らなくなる。保存は今までどおり Stop で行う。
   transcript は hook より遅れて書かれることがある。hook payload の `prompt_id` と、最後の user 行の `promptId` が
   両方あって食い違う時は、今の依頼がまだ書かれていない。その時は最後の群を現在地に載せず、回収もせず、
   現在地には「記録からまだ読めない」とだけ書く。
4. **trigger は `PreCompact` の payload だけから決める**: `SessionStart` の時点の transcript から推測しない
   （圧縮境界の行は hook より後に書かれる）。手動の `/compact` は対象にしない（Codex と同じ）。
5. **要約行**: `isCompactSummary: true` の行は、ターンの始まりにも本文にもしない。`turn_number`（transcript 内の
   本文行の通し番号）は詰めず、要約行の分も進める。詰めると、要約行を数えていた頃に保存した行と番号が食い違う。
   L3 の範囲も要約行で切らず、元の依頼から取る。
6. **有効化**: 既定は無効。`throughline auto-handoff enable --host claude [--project <path>]` が
   `~/.throughline/claude-auto-handoff.json` を書く。`--host` を省いた時は今までどおり Codex。
   Codex の設定とは別のファイルで、互いに影響しない。有効判定は会話を起動した project（`CLAUDE_PROJECT_DIR`）で行う。
   `resume`・`detail`・`worker` と `--operation` は Claude では使えない（引き継ぎ操作の記録を持たない）。
7. **hook の登録**: `throughline install` が Claude の `PreCompact` hook を登録する。`enable` は登録が無ければ足す。
   無効の時、hook は判定を記録して抜ける。
8. **失敗**: `PreCompact` の失敗は `HOOK_PRE_COMPACT_FAILED`（severity `warn`。圧縮と作業は続く）、
   注入の失敗は既存の `HOOK_SESSION_START_FAILED`。どちらも理由を `hook-failures.log` に残す。
   判定は `inheritance-decision.log` に `phase: "pre-compact"` と `phase: "compact-continuation"` で残す。

## Consequences

- Claude Code の圧縮は走る。Codex のように圧縮の本文生成を省けない。圧縮後の文脈は、host の要約と
  Throughline の記録の両方を持つ。食い違う時は記録を正とするよう、ヘッダで指示する。
- schema は変えない（v12 のまま）。新しい会話も、配送も、常駐 process も作らない。`aiterm-steer-delivery` は使わない。
- Claude の `/clear` と `/tl` の引き継ぎ（ADR 0014・0016）は変えない。`SessionStart(source=compact)` の
  pending intent の登録も今までどおり行う。
- 作業途中のターンの tool 入出力は、Stop まで `throughline detail` で取れない。
- 圧縮をまたいだターンは、元の依頼と最終回答の1ターンとして保存される。Observer feed にも1ターンで出て、
  `turn_start` は元の依頼のものになる。今までは要約行のターンとして `unknown` で出ていた。
- 修正より前に保存した行はそのまま残る。同じ断片を持つ群は入れ直さない。
- `throughline install`（`self-update` を含む）は `~/.claude/settings.json` に `PreCompact` を1件足す。

## 確認した範囲

- Linux の Claude Code 2.1.289（`claude -p` と対話画面）、Haiku 4.5。自動圧縮2回をまたいで作業が完了し、
  圧縮のたびに注入が届き、圧縮されたターンが1ターンとして保存された。
- macOS・Windows、VS Code 拡張・Desktop、subagent の中の圧縮は確かめていない。
