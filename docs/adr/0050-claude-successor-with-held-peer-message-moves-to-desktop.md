# ADR 0050: ほかの会話から届いた文を保留している後継も、ターンが終わっていれば Claude Desktop へ移す

日付: 2026-10-11

## Context

Claude Desktop の画面から始まった会話の後継は、ターンを終えた時に Desktop へ移す（ADR 0043）。移す process は、
`claude agents --json --all` でその後継が手すき（`status: idle`）になるのを待ち、`claude stop` で止めて、
`claude --desktop --resume` で開く。手すきにならない時は止めずに戻り、次の Stop でやり直す。

2026-10-11、Windows の実機（Claude Code 2.1.296）で、10/10 23:43 に立った後継が、ターンを終えた後も裏の会話のまま残った。
記録を読んで分かった事は次のとおり。

- 後継の transcript は、`stop_reason: end_turn` の assistant の行と `stop_hook_summary` で終わっていた。結果の無い道具の呼び出しは無い。
- それでも `claude agents` は、その後継を `status: waiting`・`waitingFor: permission prompt` と返していた。
- 理由は、会話から会話への文（`SendMessage`）の保留だった。Claude Code は、送り手と受け手で権限の設定が違う時、届いた文を
  利用者が承認するまで保留する。transcript には `system` の行（`Held peer message … not delivered to Claude (1 held)`）が1行入る。
  保留が1通でもある間、その会話は、作業中もターンの後も `waiting / permission prompt` を返す。
- 送り手は利用者の別の会話で、Throughline が送った文ではない。
- 同じ作業の1つ前の後継も同じだった。保留が入ってから解けるまでの2時間42分、移せなかった（Desktop へ移ったのは、後継が立ってから3時間34分後）。

Windows と macOS の試験用の会話で、同じ状態を作って確かめた（Windows は権限の組み合わせ2通り、macOS は1通り）。

- 保留を持つ会話は、`claude stop` で止められる。止めた後、`claude -p --resume` と `claude --desktop --resume` で続けられる。
- 止めると、保留の文は会話へ届かないまま消える。transcript には、知らせの行の中に文の冒頭だけが残る。
- 道具の許可を本当に待っている会話（ターンの途中）も、同じ `waiting / permission prompt` を返す。この時、transcript の最後は
  道具を呼んだ assistant の行（`stop_reason: tool_use`）で、結果の行が無い。

裏の会話の保留を承認する画面へ行く道は、端末の `claude attach` とリモートコントロールだけで、Claude Desktop には出ない。
オーナーの裁定（Approval Box K-3LPKZE、2026-10-11）は「保留があっても、ターンが終わっていれば Desktop へ移す。
保留中の文は消える」。

## Decision

1. 移す process は、後継が `waiting` を返す時、その後継の transcript の末尾を読む。次の全部が当たる時、手すきと同じに扱う。
   - `claude agents` の `state` が `working` でない。
   - 最後の `user`・`assistant` の行が assistant で、`stop_reason` が `end_turn` か `stop_sequence`。道具の呼び出しを含まない。
   - その行の後に、取り出されても消されてもいない順番待ちの指示（`queue-operation` の `enqueue`）が無い。
   - 次に見た時（3秒後）も、transcript の大きさが同じ。
2. transcript の場所は、後継の Stop の hook が受け取った `transcript_path` を、引き継ぎの記録の `successor.transcript_path` に残して使う。
   公開の表示（`auto-handoff status`）には出さない。
3. transcript から読むのは、行の種類・`stop_reason`・発言の部品の種類・順番待ちの操作の種類だけ。本文は読まない。
4. 当たらない時（ターンの途中の許可待ち、次のターンが動いている、transcript を読めない、記録に場所が無い）は、今までどおり止めずに戻る。
5. `busy` の後継は、今までどおり待つ。

## Consequences

- ほかの会話から文が届いて保留されている後継も、ターンを終えれば Desktop に出る。
- その時に保留されている文は、承認も拒否もされずに消える。受け手の会話には届かない。送り手の会話へ知らせが行くかは確かめていない。
- 保留を持つ会話は、作業中も `waiting` を返す。指示が届いてから、その行が transcript に書かれるまでの間に2回続けて読むと、
  始まったばかりのターンを止める恐れが残る。2回の間隔は3秒で、Claude Code は指示の行をすぐ書くので、起きる窓は狭い。
- ターンの後も裏で動く処理（裏の shell、裏の subagent）を持つ会話は、止める時にその処理も止まる。手すき（`idle`）の後継を
  止める時と同じで、ここは変えていない。
- `stop_reason` を transcript に書かない版の Claude Code では、この判定は当たらない。今までどおり、保留が解けるまで待つ。
- 0.16.19 までの版が残した記録には transcript の場所が無い。その後継は、次の Stop で場所が入ってから移る。
- Linux は Desktop へ移す処理が無いので、対象外。Codex・Grok・Cursor は、会話から会話への文の保留が無いので、変更なし。
