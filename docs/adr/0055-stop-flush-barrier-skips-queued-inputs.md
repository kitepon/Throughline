# ADR 0055: Stop の直後に待っていた入力が2通以上届いた時、flush barrier は本文の無い group を飛ばして完了した turn を探す

- Status: Accepted
- Date: 2026-10-12

## Context

ADR 0026 は、Stop の直後に次の user 行（queue から届いた入力）が書かれた時、1つ前の group を完了した turn として
採用する。「2つ以上前の group は見ない」と決めていた（Decision 5）。

2026-10-12 に BellTeam コンテナ（Linux、0.16.5）で、Claude Code の会話の Stop が
`Claude Stop transcript completion was not visible before deadline` で1回失敗した。transcript の並びは次のとおり
（本文は読んでいない。行の種類・時刻・長さだけ）。

```text
10:22:59.869  queue-operation enqueue
10:23:30.015  queue-operation enqueue
10:23:32.062  assistant の最終行（end_turn）
10:23:32.147  stop_hook_summary
10:23:32.172  queue-operation dequeue（2件、同じ時刻）
10:23:32.216  user 行（待っていた入力の1通目）
10:23:32.217  user 行（待っていた入力の2通目）
10:23:34.215  HOOK_PROCESS_TURN_FAILED（Stop から 2.0 秒後）
10:23:39.699  次の turn の assistant 行
```

turn の間に入力が2通たまり、turn が終わった時に2通が続けて user 行になった。latest group は2通目、1つ前の group は
1通目で、どちらにも assistant 本文が無い。完了した turn は2つ前の group にあるので、marker は一致しない。

失敗した turn の L2 と完了受領は、19 秒後の次の Stop（10:23:53.167）の backfill が書いた（`groups` 88 → 90、
`inserted_turns` 2）。保存の欠けは無い。害は、受領が次の Stop まで遅れる事と、失敗が1回数えられる事。

最新の 0.16.25 でも同じ（合成した transcript で、待っていた入力が1通なら採用、2通と3通は失敗）。

## Decision

1. 1つ前の group を探す時、assistant 断片が1つも無い group（続けて届いた入力）は飛ばす。assistant 断片を持つ
   一番近い group を「1つ前」として扱う。
2. 採用の条件は ADR 0026 のまま。latest group に assistant 断片が無い、その group の非 junk assistant 本文が marker と
   一致する、その turn が bodies に未捕捉、の全部を満たす時だけ採用する。
3. assistant 断片を持つ group は飛ばさない。その group より前は見ない。ADR 0026 の Decision 5 は
   「assistant 断片を持つ group を、2つ以上は遡らない」と読み替える。
4. 根拠は ADR 0026 と同じで、transcript が追記だけである事。後ろに user 行が見えている group は、行が出そろっている。

## Consequences

- 待っていた入力が何通あっても、完了した turn の L2・完了受領・L3 が同じ Stop で書かれる。
- 途中で止められて本文を1つも書かなかった turn（user 行だけの group）も、同じ扱いで飛ばす。その手前の turn が
  今回の marker と同文で、まだ捕捉されていない時だけ採用される。捕捉済みなら、今までどおり待って deadline で失敗する。
- この待ちを使うのは Claude Code の Stop だけ。Grok と Cursor は使わない（`waitsForStopTranscriptFlush: false`）。
  Codex の Stop は別の入口（rollout からの取り込み）で処理する。

## 確かめた事・確かめていない事

- 確かめた: 単体試験（2通・3通・捕捉済み・次の turn が本文を書き始めた後・本文を持つ group が無い）。
  本物の hook の命令（`process-turn`）へ、合成した transcript を通した（切り離した HOME）。
- 確かめていない: 本物の Claude Code が、待っていた入力を2通続けて書く場面での、この版の動き。狙って起こすには、
  動いている turn の間に入力を2通ためる必要がある。次に起きた時は、失敗が記録されない事で分かる。

## 追記（2026-10-14、ADR 0060）

Context の「保存の欠けは無い」は、完了した turn の事だった。続けて届いた入力の1通目は、assistant 断片の無い group として
保存されていなかった（コンテナの本物の transcript で 5 回）。ADR 0060 で、同じ `turnPosition.promptIndex` で続けて届いた
user 行を1つの依頼にまとめる様にした。assistant 断片の無い group を飛ばす作りは、そのまま残している。
