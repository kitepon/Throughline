# Codex fork rolloutのmetadata

出典: macOSのCodex Desktop同梱runtime `0.159.2`、実際の`thread/list`と子agent rollout、Throughlineのfocused test。
取得日: 2026-10-03。確度: 実機で再現済み。別runtimeでの同じ並びは未検証。

## 観測

自動継続が`handoff_thread_mismatch`で失敗した親タスクについて、公開APIの
`thread/list`から18件の子agentを取得した。2件の子rolloutは先頭に子自身の
`session_meta`を持ち、次に親の`session_meta`と親の会話履歴を持っていた。
その後には子自身の`task_started`と`turn_aborted`が保存されていた。

先頭の`payload.id`は子thread ID、`payload.session_id`は親session IDだった。
親のコピーでは`payload.id`も親thread IDになる。最後のmetadataで識別すると、
子のファイルを親のファイルと誤判定する。

```text
session_meta: id=子、session_id=親、parent_thread_id=親
session_meta: id=親、session_id=親
親のtask_started・会話履歴
子のtask_started
子のturn_aborted
```

## 修理と検証

`readCodexHandoffState`は先頭のmetadataを保持する。最新turnの終了イベントを
読む処理は維持し、指定thread IDが先頭metadataと異なる場合は拒否する。
同じ並びの最小fixtureで修理前の失敗と修理後の成功を確認した。
実際に失敗した2件の子rolloutでも、子自身のIDと最新turnの中断を確認できた。

現行契約は[Codex自動継続の設計](../../docs/05_codex_first_roadmap.md#記憶と作業途中の情報)、
回帰試験は[src/codex-auto-handoff.test.mjs](../../src/codex-auto-handoff.test.mjs)に置く。
