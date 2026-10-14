# ADR 0065: Claude Code の予定（cron）が起こしたターンを、新しいターンとして読む。受領は保存した番号で出す

- Status: Accepted
- Date: 2026-10-15

## Context

2026-10-14、BellTeam のコンテナ（Linux、Claude Code 2.1.299、この製品は 0.16.33）で、1つの Claude Code の会話の Stop の hook が
21:01:55 から 21:57:02 JST まで7回続けて失敗した（`HOOK_PROCESS_TURN_FAILED`、`completed pair was not captured before receipt publication`、
`publishCapturedClaudeCompletionReceipt`）。

### 1. 予定が起こしたターンの依頼の行は `isMeta: true`

会話が `CronCreate` で置いた予定が動くと、Claude Code は次の行を書く（本文は読んでいない。行の種類・印・長さだけ）。

```text
{"type":"system","subtype":"scheduled_task_fire","content":"Running scheduled task (…)","taskId":…,"cron":…,"prompt":…}
{"type":"user","isMeta":true,"promptId":…,"promptSource":"system","turnOrigin":"scheduled","scheduledTaskId":…,"scheduledFireId":…,
 "turnPosition":{"promptIndex":3,"turnIndex":4},"message":{"role":"user","content":"<予定へ書いた依頼の文>"}}
```

ADR 0060 は、`origin.kind` を持たない `isMeta: true` の user 行を host が書いた行（skill の本文、命令の注意書き）として、ターンの
始まりにも本文にもしない。予定の依頼の行もここへ入り、予定が起こしたターンの assistant の本文が、前のターン（すでに保存済み）の群へ足された。

### 2. 保存済みの群の代表が動くと、受領の番号が bodies に無い

`backfillBodies` は、断片のどれかが bodies にある群を保存済みとして飛ばす。受領（`publishCapturedClaudeCompletionReceipt`）へ渡す番号は、
飛ばした群でも群の代表（最後の断片）の番号だった。群へ断片が足されると代表は保存していない番号へ動き、受領を出す所で失敗する。
受領は全ターンを順に出すので、この群より後のターンの受領も、L1・L3 も、その会話の以後の Stop で毎回止まった。

### 影響（コンテナの1会話）

- 予定が起こしたターン（依頼と回答）が L2 に無い。
- 21:01〜21:57 の7ターンの L3（道具の入出力）が無い。L3 はその Stop のターンだけを取るので、後から入らない。L2 の本文は入っている。
- その7ターンの受領が出ていない。L1 の要約が進んでいない。

0.16.29（ADR 0060）から起きる。Linux・macOS の Claude Code の記録（rabbit・main-server・Mac）に予定の行は無く、同じ失敗も無い。

## Decision

1. `turnOrigin: "scheduled"` か `scheduledTaskId` を持つ Claude Code の user 行は、host が書いた meta の行にしない。ターンの始まりにし、
   始まり方は `self`（予定は会話が自分で置いた物）。行の番号の数え方は変えない（meta の行も数えていたので、保存済みの番号と食い違わない）。
2. 追記だけの host の `backfillBodies` は、飛ばした群の受領の番号に、bodies にある断片の番号（最後の物）を返す。Grok の書き直しの読み方
   （ADR 0056）が保存済みの番号を返すのと同じにする。

## Consequences

- 0.16.33 までで止まった会話は、この版の最初の Stop で、予定が起こしたターンが新しいターンとして入り、受領が出て、失敗が止まる
  （本物の記録の写しで確かめた。古い版は本物と同じ7回の失敗、この版は入れ替えた後の Stop が exit 0 で、抜けていた1ターンが入る）。
- 失われた L3（道具の入出力）は戻らない。
- 予定が起こしたターンは、L2・Observer の feed に `self` で出る。
- 群の代表が保存の後に動いても（別の理由で断片が足されても）、Stop は失敗しない。動いた後の代表の本文は、今までどおり保存しない。
