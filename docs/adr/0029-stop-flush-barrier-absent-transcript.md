# ADR 0029: transcript のファイルが無い Claude Stop は、hook 処理の失敗に数えない

日付: 2026-10-04

## Context

ADR 0012 の flush barrier は、Stop payload の `last_assistant_message` が transcript に見えるまで最大2秒待ち、
見えなければ `HOOK_PROCESS_TURN_FAILED`（`Throughline Claude Stop hook processing failed`、severity `high`）で
明示失敗する。

2026-10-04、BellTeam コンテナ（0.12.6）で、前日に解決登録した `HOOK_PROCESS_TURN_FAILED` が再発した。
00:36:19.037Z と 00:36:24.188Z の2回で、理由はどちらも
`Claude Stop transcript completion was not visible before deadline`。

失敗した会話は `/tmp` で 00:35:39Z から 00:36:24Z まで動いた Claude Code（2.1.289）の1会話。
SessionStart と UserPromptSubmit の hook は `transcript_path` を受け取っているが、その path に
ファイルは無い。`~/.claude/history.jsonl` にもこの会話の入力は残っていない。
前日までに同じ内容の会話が5回 `/tmp` で動いていて、その時は transcript が残り、Stop は同じ実行で保存している。

同じ端末で、Claude Code を `-p --input-format stream-json --no-session-persistence` で1 turn 動かして再現した。
Stop payload には `transcript_path` と `last_assistant_message` が渡るが、ファイルは最後まで作られず、
Stop は応答の 2.08 秒後に同じ文面で失敗した。payload に、保存しない起動であることを示す項目は無い。
`--no-session-persistence` を外した同じ会話は、同じ Stop で 1 turn を保存した。

Throughline が保存する本文の正本は transcript だけ（ADR 0012 Decision 2）。transcript が作られない会話には、
保存する元が無い。これは host を起動した側の指定で、Throughline の修理では直らない。
`HOOK_PROCESS_TURN_FAILED` の回数からは、保存できたはずの会話を落としたのか、保存する元が無かったのかを
区別できない。

## Decision

1. flush barrier は、期限まで待っても完了が見えず、かつ `transcript_path` のファイルが存在しない時、
   `transcript_absent` を返す。失敗にしない。
2. 存在の確認は期限に達した時だけ行う。遅れて書かれる transcript は、今までどおり期限まで待つ。
3. ファイルが存在するのに完了が見えない時は、今までどおり明示失敗して `HOOK_PROCESS_TURN_FAILED` を数える
   （ADR 0012 Decision 4）。`transcript_path` が payload に無い時も、ファイルが無いことを確かめられないので
   失敗のままにする。
4. `transcript_absent` の Stop は、`~/.throughline/logs/backfill.log` に
   `{"hook":"stop","session_id":…,"transcript_path":…,"skipped":"transcript_absent"}` を1行残し、
   終了 code 0 で終わる。DB・state file・完了受領には何も書かない。runtime error store にも数えない。
5. hook が失敗した時の `hook-failures.log`（ADR 0027）に、Stop の `session_id` と `transcript_path` を足す。
   今回は理由の文面だけが残り、どの会話の Stop かを他の記録から探すことになった。
   このログは端末内にだけ置き、外へは送らない。

## Consequences

- transcript を残さない起動（`--no-session-persistence`）の会話は、Throughline の記憶に入らない。
  見送った Stop は `backfill.log` で数えられる。
- その会話の Stop hook は、今までと同じく期限（2秒）まで待ってから終わる。
- host が transcript の置き場を変え、hook に渡す path にファイルが無くなった場合も、失敗としては数えなくなる。
  その時は `backfill.log` に `transcript_absent` が並び、`inserted_turns` が出なくなる。
- 期限の後に初めてファイルが作られる会話は、その Stop では保存されない。同じ会話の次の Stop が、
  未捕捉の turn をまとめて保存する（backfill）。最後の turn で起きた時は保存されない。
- `HOOK_PROCESS_TURN_FAILED` の fingerprint は変わらない。過去の回数は移さない。

## 確認できていないこと

- 2026-10-04 の2回の会話を、誰がどの引数で起動したかは特定できていない。確かめたのは、その会話の
  transcript がディスクに無いことと、`--no-session-persistence` で起動した会話が同じ文面で失敗すること。
  transcript が後から消された可能性は、記録からは否定できない。
- `--no-session-persistence` 以外に、path は渡るがファイルが作られない起動の仕方があるかは調べていない。
- 実測は Linux の Claude Code 2.1.289 だけ。macOS と Windows では確かめていない。
