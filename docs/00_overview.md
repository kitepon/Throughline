# Throughline Documentation Overview

Throughline の文書は、現行契約・履歴・証拠を分ける。通常作業で読むのはこのページの
「現行契約」だけであり、完了済み計画を無意識に読み込ませない。

## 現行契約

| 文書 | 役割 |
|---|---|
| [../README.md](../README.md) / [../README.ja.md](../README.ja.md) | 利用者向けの導入、設定、コマンド、状態、診断、復旧、更新 |
| [AGENTS.md](https://github.com/kitepon/Throughline/blob/main/AGENTS.md) | 全 host の作業者向けの製品正本 |
| [01_l1_l2_l3_redesign.md](01_l1_l2_l3_redesign.md) | L1/L2/L3 記憶レイヤーの設計 |
| [02_clear_auto_handoff_plan.md](02_clear_auto_handoff_plan.md) | `/clear` / `/tl` handoff の現行仕様 |
| [04_public_release_plan.md](04_public_release_plan.md) | 公開配布、明示的失敗、release gate |
| [05_codex_first_roadmap.md](05_codex_first_roadmap.md) | Codex primary / trim / Claude finalization の現行順序 |
| [06_codex_trim_rollback_fix_plan.md](06_codex_trim_rollback_fix_plan.md) | Codex rollback / inject incident 後の現行判断 |
| [08_codex_dual_support.md](08_codex_dual_support.md) | Claude primary を維持する Codex adapter 方針 |
| [09_rollback_context_trim_insight.md](09_rollback_context_trim_insight.md) | rollback を context delete primitive と見る設計 |
| [adr/](adr/) | 現行実装が依拠する不変の設計判断 |

特に現行 host 契約は [ADR 0021](adr/0021-grok-host-capture.md) と
[ADR 0022](adr/0022-cursor-host-capture.md)、二相 handoff と schema v9 は
[ADR 0014](adr/0014-two-phase-handoff-ghost-baton.md)、製品所有 migration は
[ADR 0018](adr/0018-product-owned-database-migration.md) を正とする。

## 固定参照の互換入口

次の短い文書は現行契約の正本ではない。旧pathを固定した計画・証拠・公開URLから、
archiveと現行正本へ案内するためだけに残す。

| 互換入口 | 現行正本 |
|---|---|
| [12_desktop_clear_handoff_plan.md](12_desktop_clear_handoff_plan.md) | [02_clear_auto_handoff_plan.md](02_clear_auto_handoff_plan.md) |
| [15_windows_ci_release_latency_plan.md](15_windows_ci_release_latency_plan.md) | [04_public_release_plan.md](04_public_release_plan.md) / [ADR 0020](adr/0020-windows-ci-release-latency.md) |
| [16_readonly_handoff_context_plan.md](16_readonly_handoff_context_plan.md) | [README.md](../README.md) / [公開JSON例](throughline-handoff-context.example.json) |
| [plan_grok-successor-launch.md](plan_grok-successor-launch.md) | [ADR 0021](adr/0021-grok-host-capture.md) / [README.md](../README.md) |

## 履歴

| 場所 | 役割 |
|---|---|
| [archive/](archive/) | 完了済み計画、置換済み設計、過去の実装・受入記録。通常は読まない |
| [audit-2026-05/](audit-2026-05/) | 2026-05 の監査・インシデント記録 |
| [adr/](adr/) | 判断時点の背景も保持する設計判断記録 |
| [../CHANGELOG.md](../CHANGELOG.md) | 公開版ごとの変更履歴 |

## 証拠

| 場所 | 役割 |
|---|---|
| [../rag/INDEX.md](../rag/INDEX.md) | 外部仕様・実機調査の索引 |
| [evidence/](https://github.com/kitepon/Throughline/tree/main/evidence) | host受入などの固定証拠 |
| [throughline-handoff-context.example.json](throughline-handoff-context.example.json) | 公開JSON契約の例 |

## 製品の所有境界

Throughline は単独で install、設定、状態保存、schema と migration、診断、復旧、更新、
release 判定まで完結する。状態の正本は `~/.throughline/` と製品コードであり、他製品は
公開CLI・JSON契約を介して連携する。dotagents は工場全体の配線と統合契約を管理するが、
Throughline の状態を直接書き換えず、製品の単独運用やrelease判断を制御しない。

## 文書の寿命

- 現行値・操作・判断は既存の現行文書へ統合し、同じ意味の現行文書を増やさない。
- 完了した計画、置換済み設計、当時の受入記録は `archive/` へ物理移動する。
- 履歴・証拠は削除せず、通常の必読経路から外す。
- source と文書が食い違う場合は source とfocused testで確認し、現行文書を同じ変更で直す。
- 新しい文書は、現行契約・履歴・証拠のどれかを決めてから置く。
- `npm run verify:docs` は全local link、top-level分類、archive索引、固定参照の互換stub、
  公開npm tarball内Markdownの相対link/image閉包を検査する。Markdown-only変更でも
  製品所有CIがこの入口を実行する。
