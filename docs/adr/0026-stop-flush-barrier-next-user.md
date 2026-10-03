# ADR 0026: Stop 直後に次の user 行が届いた時、flush barrier は1つ前の turn を採用する

日付: 2026-10-03

## Context

ADR 0012 の flush barrier は、Stop payload の `last_assistant_message` が latest user group の本文と
一致するまで最大2秒待ち、一致しなければ `HOOK_PROCESS_TURN_FAILED` で明示失敗する。
「過去の同文 answer を今回の完了と取り違えない」ために、latest user group だけを見る（Decision 3）。

BellTeam コンテナで runtime error の収集を有効にした日（2026-10-03）に、この失敗が2回記録された。
transcript の時刻は次の並びだった（2回とも同じ形）。

```text
08:10:58.677  assistant の最終行（end_turn）
08:10:58.756  Stop
08:10:58.823  次の user 行（queue から届いた入力。Stop の 67ms 後）
08:11:00.787  HOOK_PROCESS_TURN_FAILED（Stop から 2.0 秒後）
```

turn が終わった瞬間に、待っていた入力が次の turn として届く。hook が transcript を最初に読む時には、
latest user group は次の turn になっていて、assistant 本文はまだ無い。完了した turn は1つ前の group へ
移っているので、marker は2秒待っても一致しない。もう1回は Stop の 40ms 後に user 行が届いていた。

失敗した turn の L2 と完了受領は、次の Stop の backfill が書く（1 turn 遅れる）。その turn の L3
（tool の入出力）は、次の Stop が latest turn の分しか取らないので保存されない。

## Decision

1. latest user group が marker と一致しない時、次の全てを満たせば、1つ前の group を完了した turn として採用する。
   - latest group に assistant 断片が1つも無い。
   - 1つ前の group の非 junk assistant 本文が marker と一致する。
   - その turn が bodies に未捕捉（group 内のどの断片 index も `origin_session_id` の下に無い）。
2. 根拠は transcript が追記だけであること。後ろに user 行が見えている group は、行が出そろっている。
   待つ必要が無いので、最初の読取で採用する。
3. 捕捉済みの turn は採用しない。前の turn が今回と同文で終わっていて、今回の最終行がまだ見えない時は、
   前の turn は自分の Stop で捕捉済みなので、ADR 0012 のとおり待つ。
4. latest group が assistant 本文を書き始めていたら採用しない。進行中の turn を backfill が完了扱いで
   捕捉しないためで、この時は従来どおり deadline で明示失敗し、次の Stop が回収する。
5. 2つ以上前の group は見ない。
6. DB を確かめられない呼び出し（`isTurnCaptured` を渡さない）は、1つ前の group を採用しない。
7. ADR 0012 の Decision 1・2・4・5・6 は変えない。Decision 3 は、上の条件を満たす1つ前の group だけを例外にする。

## Consequences

- queue の入力が turn の終わりに重なっても、その turn の L2・完了受領・L3 が同じ Stop で書かれる。2秒の待ちも無くなる。
- 前の turn が未捕捉で、今回と同文で終わり、今回の最終行がまだ見えない、が重なると、前の turn を先に書いて
  今回の turn は次の Stop で回収される。書かれる本文は transcript の完了した pair だけなので、誤った本文は入らない。
- hook は barrier の前に DB を開く。捕捉済みかの確認は、1つ前の group が一致した時だけ行う。
- barrier が1つ前の group を採用した後、backfill は transcript を読み直す。その数 ms の間に次の turn が
  assistant 本文を書くと、backfill は進行中の group も捕捉する。実測では次の turn の最初の本文まで秒単位で、
  hook は 0.1 秒ほどで終わる。backfill の範囲を barrier の turn までに限る変更は入れていない。
- 試験の子プロセスは、設定と state の置き場も一時 HOME へ向ける（`src/hook-entrypoints.test.mjs` の `childEnv`）。
  親の `XDG_CONFIG_HOME`・`XDG_STATE_HOME`・`LOCALAPPDATA` を引き継いでいたため、収集を有効にした端末で
  hook の試験が落ちると、本物の runtime error store に1回記録されていた（2026-10-03 10:26:11 UTC、BellTeam コンテナ）。

## 未解決（別件）

L1 の要約が走る Stop では、L3 の抽出が transcript を読み直すまでに数秒かかる。その間に次の turn が本文を
書くと、L3 が次の turn の行から取られる可能性がある。コードを読んだ見立てで、再現は確かめていない。
