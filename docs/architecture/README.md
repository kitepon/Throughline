# Throughline 機能図とsource対応

状態: 全体リファクタリングの初期調査。base `39ff812d46c0e84e8fc1418096c509551cf3928b`。図/コードの全体整合や責務整理は未完。

- [未読台帳](unread-ledger.md): baseのtracked全417file。source126/test99/documentation141/config-support51を機械分類した。fixtureや各設定の意味の分類は未調査で、51件に含まれる可能性を個別に確認する。
- [bytes/SHAと宣言候補](file-inventory.json): 宣言行の文字列索引は部分的な手掛かりで、実関数や全callerの網羅を保証しない。全fileのsemanticMappingCompleteはfalse。
- [今回読んだ入口の現行図](current-entrypoints.md): CLI dispatch、SessionStart、DB接続の読取範囲だけ。残help/schema/callee/caller/testを明記する。
- 既存設計の索引は[docs/00_overview.md](../00_overview.md)、記録/復元の既存図は[README](../../README.md#three-layer-memory-model)、Codex継続は[docs/05](../05_codex_first_roadmap.md)。有効な図を作り直さず、対応を確認して再利用する。

## 全体で埋める機能

導入/host登録、4host記録、DB/schema/競合、記憶/要約/再注入、Claude継続、Codex継続/trim、Grok/Cursor継続、usage/monitor、observer、外部文脈projection、診断/更新/エラー報告を調べる。これは調査順序であり、責務分割の確定案ではない。
各機能は実file/関数・状態/所有・caller・test/fixture/config/export・正常/失敗/停止/取消/不明/cleanupまで結ぶ。部分図の完成を全体完成へ補完しない。

## 保持する外部契約

CLI名/引数/JSON schema/exit/stdout/stderr、ClaudeとCodex/Grok/Cursorのhost別hook形、記憶/receipt/cursor/baton/後継と設定信用、保存/移行とreport/ackの意味を保つ。既読だけで保持済みとはせず、全callerと関連試験へ結ぶ。
observer新batch APIはこの候補の構造整理に含めない。実DB/稼働会話/他製品/OSを変更せず、公開・配布・本番反映は既条件に従う。

## 次工程

Sol Highで未読sourceを埋め、現在図を詳細化する。責務/接続/代替案の設計はAstra xhighの適用後、実装はSol、最終整合はAstraで行う。新しい整理の採否はまだ決めていない。
