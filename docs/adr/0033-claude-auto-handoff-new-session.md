# ADR 0033: Claude Code の自動継続は、自動圧縮を止めて新しい会話へ引き継ぐ

日付: 2026-10-05

## Context

ADR 0032（0.13.0）は、Claude Code の自動圧縮を通し、圧縮の直後に同じ会話へ記憶を注入した。
オーナーはこの方式を却下した（2026-10-04）。Throughline は自動圧縮を置き換えるもので、
自動圧縮が走った時点で負けである。Codex の自動継続（圧縮の前に止めて、新しいタスクへ引き継ぐ）と
同じ並びを、Claude Code でも実現する。

Codex 版の各段に当たるものを、Claude Code 2.1.289 の公式文書と実機で1段ずつ確かめた。

| Codex 版の段 | Claude Code で当たるもの | 確認 |
|---|---|---|
| 圧縮の前に旧タスクを止める | `PreCompact` の exit code 2 で圧縮を止める。`PreToolUse` が `permissionDecision: "deny"` と `continue: false` を返すと、その道具は実行されずにターンが止まる | 実機 |
| 新しいタスクを作る | `claude --bg`。指示を付けずに起動すると、指示を待つ会話が立つ（`idle — send a prompt to start`） | 実機 |
| 記憶を入れる | 最初の指示の `UserPromptSubmit` hook の出力。`/tl` の印（baton）の引き継ぎと同じ | 実機 |
| 「続けて」を送る | 会話ごとの受け口（inbox socket）。配送ライブラリ `aiterm-steer-delivery` 0.1.13 の `sendClaudeInbox` | 実機 |

`PreCompact` の `continue` は捨てられるので、圧縮を止める hook と作業を止める hook は別になる。
`PreToolUse` が `continue: false` だけを返すと、その道具は実行されてから止まる。`deny` を一緒に返すと実行されない。

Claude Desktop の新しい会話は、画面を開いただけでは process が起動しない（最初の指示が送られた時に起動する）。
`claude://code/new` の `q` は入力欄への事前入力で、送信しない。受け口が無いので、Desktop の下書きへは配送できない
（配送ライブラリの持ち主も確認）。後継は Throughline が起動する会話にする（オーナーの判断、2026-10-04）。

## Decision

1. **圧縮を止める**: `PreCompact` hook（`throughline pre-compact`、matcher 無し）が、`trigger: "auto"` で自動継続が
   有効な project の時だけ、`/tl` と同じ印（baton）と引き継ぎの記録を残し、exit code 2 で圧縮を止める。
   手動の `/compact`、無効な project、subagent の中の圧縮（payload に `agent_id`）、script から起動した会話
   （`CLAUDE_CODE_ENTRYPOINT` が `sdk-` で始まる）では止めない。
2. **旧い会話を止める**: `PreToolUse` hook（`throughline pre-tool-use`、全ての道具）が、記録のある会話の次の道具を、
   実行させずに止める。旧い会話は止めるだけで、空にしない。同じ応答に並んだ道具も全て止め、後継の立ち上げは1回だけ行う。
   記録が無い会話では、記録のファイルの有無だけを見て終わる。subagent の中の道具は止めない。
3. **新しい会話を立てる**: 切り離した worker が、止めた時点の依頼・モデル・推論強度・権限を記録へ写し、
   同じ project で `claude --bg` を指示なしで起動する。起動時に `--model`・`--effort`・`--permission-mode` を渡し、
   `--settings '{"worktree":{"bgIsolation":"none"}}'` で同じ作業ツリーを編集させる。
   依頼と直前の発言は、止めた道具の呼び出しが transcript に書かれるのを待ってから読む（hook の時点では直前の発言が
   まだ書かれていないことがある）。
4. **継続の指示を1通送る**: 後継の `SessionStart` hook が、同じ project に立ち上げ中の引き継ぎがある時だけ、
   自分の受け口（`CLAUDE_CODE_MESSAGING_SOCKET` と token）を控える。worker はそれを読んで消し、
   `sendClaudeInbox` で継続の指示を1通送る。配送は公開 API だけを使い、Throughline の中に送信の実装を持たない。
   届いた時の `UserPromptSubmit` が baton を消費して前任を合流させ、記憶を注入する。
   注入は ADR 0016 と同じ予算（9,500 字）で、ヘッダに作業ディレクトリ、現在地に止めた時点の依頼（4,000 字まで）と
   直前の発言（1,500 字まで）、続けて案内と直近の L2 を載せる。宣言文は求めない。
5. **受領**: 継続の指示は引き継ぎ ID を含む。後継の最初の指示がその ID を含む時だけ、受領を記録する。
   `sendClaudeInbox` の結果が `accepted` なら `sent`、`not_sent` なら `failed`、`unknown` なら `unknown` にする。
   結果が不明な時は再送しない。後継が作業を進めたことまでは確かめない（オーナーの判断: 不要）。
6. **連続の引き継ぎ**: 後継も同じ hook で止まり、次の後継へ引き継ぐ。後継の最後の user 発言は前の引き継ぎの
   継続の指示なので、現在地には前の引き継ぎが運んだ元の依頼を引き続き載せる。
7. **道具を呼ばずに終わったターン**: 圧縮を止めた後、モデルが道具を呼ばずにターンを終えたら、Stop hook が記録を取り下げる。
   印は残るので、1時間以内に開いた新しい会話が記憶を引き継ぐ。
8. **引き継ぎ済みの会話**: 後継を立てた会話は、その後も圧縮と道具を止め、後継を案内する。同じ会話から2つ目の後継は立てない。
   立ち上げに失敗した記録（`failed`）は、次の道具でもう一度立ち上げる。
9. **有効化**: 既定は無効。`throughline auto-handoff enable --host claude [--project <path>]` が設定を書き、
   `PreCompact` と `PreToolUse` の hook を登録する。`disable` が2つの hook を外す。`install` は登録しない
   （`PreToolUse` は道具の呼び出しのたびに走るので、使わない端末に置かない）。有効な端末の `install` は2つの hook を保ち、
   無効な端末の `install` は 0.13.0 が置いた `PreCompact` を外す。
10. **状態**: `~/.throughline/claude-auto-handoff/` のファイルに持つ。schema は変えない（v12）。記録は旧い会話の
    session id を鍵にし、24時間を過ぎたものは次の引き継ぎの時に掃除する。token は記録に残さない。
11. **失敗**: hook 自身の失敗では圧縮も道具も止めない（exit code 1）。`HOOK_PRE_COMPACT_FAILED`・`HOOK_PRE_TOOL_USE_FAILED`
    （どちらも `warn`）を記録する。worker の失敗は記録の `error_code` に固定の理由で残す。
12. ADR 0032 の決定のうち、圧縮の要約行（`isCompactSummary`）の扱い（決定5）は有効。同じ会話への注入（決定1〜4、6〜8）は
    この ADR で置き換える。

## Consequences

- 有効な project では、Claude Code の自動圧縮は走らない。旧い会話は、止めた道具の hook の文を出して止まる。
- 続きは裏の会話（agent view）で動く。`claude agents` の一覧と `claude attach <id>` で見られる。Claude Desktop の画面には
  出ず、後継のターンが終わって入力待ちになった後に Desktop で開ける。
- `PreToolUse` hook は、有効な端末の全ての Claude の会話で、道具の呼び出しのたびに1回走る。
- 止めたターンは Stop hook を通らない。本文は後継の最初の指示の時に回収するが、返事の本文が1つも無いまま止めた
  ターンは bodies に入らず、依頼は現在地だけに載る。止めたターンの tool 入出力は L3 に入らない。
- 圧縮が「文脈上限の error から回復するため」に起きた時は、止めると元の error でその要求が失敗する（公式文書）。
  この場合の後継の立ち上げは、次の道具の呼び出しまで起きない。
- 別の会話から届いた発言（`Another Claude session sent a message:`）は、Claude Code が後ろに付ける定型の注意書きを
  落として保存する。
- 依存の `aiterm-steer-delivery` を 0.1.9 から 0.1.13 に上げる。Codex の配送の入口は変わらない。

## 確認した範囲

- Linux の Claude Code 2.1.289。対話画面の会話から始めて、後継へ3回連続で引き継ぎ、最後の後継が作業を完了した。
  4つの会話のどれにも圧縮の記録は無く、止めた道具は実行されていなかった。
- macOS・Windows、Claude Desktop から始まる会話、subagent が動いている最中の引き継ぎは確かめていない。
