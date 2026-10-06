# ADR 0038: 始まりを失った transcript の Claude Stop は、hook 処理の失敗に数えない

日付: 2026-10-07

## Context

2026-10-07 08:24:17 JST、BellTeam コンテナ（0.15.5）で、解決登録していた `HOOK_PROCESS_TURN_FAILED` が再発した
（7回目）。理由は `Claude Stop transcript completion was not visible before deadline`。

失敗した会話は、`/tmp/ag-fvIcWA/proj` で動いた Claude Code（2.1.292）の試験用の会話。1つ目のターンの Stop は
同じ会話の transcript を読んで 1 turn を保存している（08:23:59）。2つ目のターンの Stop が失敗した。

残っていた transcript は 10 行で、最初の行は 08:24:08.262 の assistant（thinking だけ）、次が 08:24:15.621 の
最後の応答だった。user の行は1つも無い。同じファイルの `turn_duration` は `messageCount: 29` と書いている。
transcript を置くフォルダ（`~/.claude/projects/-tmp-ag-fvIcWA-proj`）の作成時刻は 08:24:15.744 で、
会話の作業フォルダ（`/tmp/ag-fvIcWA/proj`）は 08:24:15.861 に消されている。

会話を起動した試験の道具は、回答が端末に出た直後に端末を閉じ、transcript のフォルダと作業フォルダを消す。
Claude Code は最後の応答の行（thinking と本文）をその後で書くので、フォルダごとファイルを作り直す。
Stop hook は応答の後に非同期で走り、応答だけのファイルを読んだ、と読める。

同じ道具は同じ朝に続けて動き、08:24〜08:33 の間に同じ文面の失敗が 12 回数えられた（7回目〜18回目）。
transcript が残っていたのは最初の1回だけで、残りの11回は後でファイルが消されている。11回とも、
その会話の最後の Stop で、1つ前の Stop は保存できている。

ファイルが残らなかった時は ADR 0029 の `transcript_absent` になり、失敗に数えない。今回はファイルが
作り直されていたので、ADR 0029 Decision 3（ファイルがあるのに完了が見えない時は失敗）に当たった。
どちらも「保存する元が、会話を起動した側に消された」で、違いは Claude Code が残りを書いた時刻だけ。

Throughline はターンを user の発言から数える（`readLatestLogicalTurnCompletions`）。user の発言が1つも無い
transcript からは、どのターンも作れない。Claude Code は会話の最初に必ず user の行を書くので、
assistant の発言があって user の発言が無い transcript は、始まりを失った物に限られる。

控えた transcript と同じ Stop の payload を、切り離した置き場で再生した。0.15.5 は同じ文面で失敗し、
`HOOK_PROCESS_TURN_FAILED` を1回数えた。

## Decision

1. flush barrier は、期限まで待っても完了が見えず、transcript に assistant の発言があって user の発言が
   1つも無い時、`transcript_head_lost` を返す。失敗にしない。
2. 確認は期限に達した時だけ行う。遅れて書かれる user の行は、今までどおり期限まで待つ。
3. user の発言が1つでも残っている時と、発言が1つも無いファイル（書き始め）は、今までどおり明示失敗して
   `HOOK_PROCESS_TURN_FAILED` を数える（ADR 0012 Decision 4、ADR 0029 Decision 3）。
4. `transcript_head_lost` の Stop は、ADR 0029 Decision 4 と同じ扱いにする。`backfill.log` に
   `{"hook":"stop",…,"skipped":"transcript_head_lost"}` を1行残し、終了 code 0 で終わる。
   DB・state file・完了受領・runtime error store には何も書かない。

## Consequences

- 始まりを消された会話の最後のターンは保存されない。保存する依頼がどこにも無いので、今までも保存できていない。
  変わるのは、失敗に数えるかどうかだけ。
- 見送った Stop は `backfill.log` の `skipped` で数えられる。
- transcript の途中だけが失われ、user の発言が残っている時は、今までどおり失敗に数える。
