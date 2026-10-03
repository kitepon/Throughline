# ADR 0028: Codex Stop の L1 要約 backend の失敗は、hook 処理の失敗と別の code で数える

日付: 2026-10-04

## Context

Codex Stop hook は、rollout を DB へ取り込んで commit した後、bodies が L2 window（20 turn）を超えていれば、
最古の未要約 turn を Codex CLI（`codex exec`）で L1 に要約する。codex-primary の要約は Codex CLI 一本で、
CLI の失敗は explicit error にする（ADR 0015 Decision 4）。

この error は hook の一番外の catch まで届き、`HOOK_CODEX_FAILED`（`Throughline Codex hook processing failed`、
severity `high`）として runtime error store に数えられていた。

Mac の runtime error store には `HOOK_CODEX_FAILED` が 1151 回あった（2026-07-13 〜 2026-08-07、最後の版は 0.9.0）。
最後の1回は 2026-08-07T06:23:58.298Z で、その Codex スレッドは同じ秒に次の turn が
`You've hit your usage limit` で終わっている。当時の stderr はどこにも残っていない。

0.9.0 と 0.12.5 の両方で、次を再現した。20 turn を超えるスレッドに Stop を送り、Codex CLI が非0で終わると、
取り込みは成功したまま hook が `Codex CLI summarizer failed: exit N`（reason `codex_cli_failed`）で失敗し、
`HOOK_CODEX_FAILED` が1回増える。UserPromptSubmit と PostToolUse は要約をしないので失敗しない。

`HOOK_CODEX_FAILED` という code からは、取り込みが壊れたのか、外部 CLI が使えなかっただけなのかを区別できない。
後者は Codex 側の利用上限・認証切れ・model の失敗で起き、Throughline の修理では直らない。

## Decision

1. Codex hook の失敗のうち、L1 要約 backend の失敗だけを `L1_SUMMARIZER_BACKEND_FAILED` として数える。
   component は `codex_l1_summarizer`、template は `Throughline L1 summarizer backend (Codex CLI) failed`、
   severity は `warn`。
2. 対象は `source` が `codex-cli` で、`reason` が `codex_cli_failed`（非0終了・timeout・起動失敗）か
   `empty_output` の error だけ。`missing_project_path` と `recursion_guard` は製品側の誤りなので、
   `HOOK_CODEX_FAILED` のままにする。要約以外の失敗も `HOOK_CODEX_FAILED` のまま。
3. hook の終了 code（1）と stderr（`[codex-hook] Codex CLI summarizer failed: exit N`）は変えない。
   ADR 0015 の explicit error 契約と、失敗を隠さない原則はそのまま。変えるのは数える code だけ。
4. `hook-failures.log`（ADR 0027）に、error が持つ `reason` と、外部 CLI の `stderr` の末尾（1000字まで）を足す。
   `Codex CLI summarizer failed: exit 1` だけでは、利用上限なのか認証切れなのかが分からないため。
   このログは端末内にだけ残し、外へは送らない。runtime error store には今までどおり定型 code と回数だけを入れる。
5. severity を `warn` にする理由: 会話の取り込みは commit 済みで、記憶は失われていない。要約は次の Stop が
   同じ turn からやり直す。L1 が無い間、recall は L2 の本文を返す（ADR 0016）。
   BugHub が受ける severity は `fatal`・`high`・`warn`・`info` の4つで、他の値は report 全体が 422 になる
   （2026-10-04、BugHub の `PRODUCT_REPORTING.md` と `factory-report-v1.schema.json` をBugHubの担当が確認）。

## Consequences

- 外部 CLI が使えない端末は、BugHub で「L1 summarizer backend failed」（warn、日次のまとめ）として見える。
  「Codex hook processing failed」（high、即時通知）は、取り込みや hook 処理そのものの失敗だけになる。
- fingerprint は code ごとに決まるので、新しい code は BugHub で新しい issue になる。過去の `HOOK_CODEX_FAILED` の
  回数は移らない。
- runtime error store は、知らない code を持つ記録を schema invalid として拒否する。この版で
  `L1_SUMMARIZER_BACKEND_FAILED` を記録した端末を 0.12.5 以前へ戻すと、store を読めなくなる。
- Claude Stop は対象外。claude-primary の要約は Codex CLI → Haiku → raw L2 の宣言済み fallback で、
  backend の失敗では throw しない。

## 確認できていないこと

- Mac の 1151 回がすべてこの形だったことを示す記録は無い。確認できたのは、同じ code を同じ版で再現できたことと、
  最後の1回が利用上限に当たった時刻と一致することだけ。外した仮説は、製品の試験からの漏れ、rollout の大きさ、
  入力の形、同時実行、スレッド全体の順次再生。
- 要約が失敗し続ける端末では、Codex の Stop hook が毎回 exit 1 になる。Codex 側の表示への影響は調べていない。
