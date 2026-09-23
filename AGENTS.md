# AGENTS.md

このファイルは AI エージェント（Claude Code、Codex、Grok、Cursor など）がこのリポジトリで作業する際のガイダンスです。

## プロジェクト概要

**Throughline** は Claude Code の hooks プラグインで、会話ターンを 3 層 (L1/L2/L3) に分解して SQLite に保存し、`/clear` 後も記憶を復元します。加えてマルチセッション対応のトークンモニター CLI も同梱しています。

Throughline は単独で install、設定、状態保存とschema migration、診断、復旧、更新、
release判定まで完結する。dotagentsは工場への配線と統合契約を担当するが、Throughlineの
状態や製品寿命を所有・制御しない。runtime-error collectionはThroughline自身の
`runtime-errors enable|disable --json`と製品所有configが管理し、工場側は公開JSON契約だけを使う。

版番号の正本は `package.json`、公開版はnpm、schemaの正本は `src/db.mjs` の `CURRENT_VERSION` とする。Claude Code、Codex、Grok、Cursorをfirst-class hostとして扱う。現行host契約はREADMEとADR 0021／0022／0023、release gateはdocs/04_public_release_plan.mdを正とする。版ごとの変更・公開commit・CI・npm・tag・smoke履歴はCHANGELOG.mdとdocs/archive/, evidence/に置き、この常時読込正本へ複製しない。

**設計の核** (v0.4.0 以降 + ADR 0014 二相化、docs/02_clear_auto_handoff_plan.md)

- `/clear` 後も SQLite はそのまま残る。前任セッションの全レコードを新 session_id に張り替える（記憶張り替え方式）
- **二相ハンドオフ (ADR 0014)**: Claude Code は同一 project に短時間で複数の SessionStart を発火させることがあり、一部は transcript を生成しない**幽霊セッション**になる。SessionStart 時点では実体と幽霊を判別できない（本物の transcript も hook より数百 ms 遅れて作られる）ため、**SessionStart は `pending_handoffs` への intent 登録のみ**を行い、**merge + 注入は最初の UserPromptSubmit（= 実体の証明。幽霊はプロンプトを発火しない）で実行**する。2026-07-17 に幽霊がバトンを先取りして実セッションが記憶ゼロで始まる incident が同日 2 回発生した（実測・機序は [ADR 0014](docs/adr/0014-two-phase-handoff-ghost-baton.md)）
- **引き継ぎ発火条件は 2 経路 (baton path 優先)**:
  1. **baton path**: 旧セッションで `/tl` を実行すると UserPromptSubmit hook が `handoff_batons` テーブルに**そのセッションの** session_id を書き込み、次の新規セッションが初回プロンプト時に消費して merge。適格性は**セッション誕生時刻基準**で `0 ≤ (誕生 − baton書込) ≤ TTL 1h`。負 age（誕生後に書かれた baton）は消さずに残す＝走行中セッションが横取りしない。`source` 値関係なく発火する確定指名方法
  2. **auto path**: baton が無く SessionStart で `source='clear'` を受け取ったとき、env `THROUGHLINE_DISABLE_AUTO_HANDOFF` が `'1'` でなければ `findLatestClaudePredecessor`（**transcript 実在フィルタ付き** — 幽霊 twin を前任に選ばない）で前任を SessionStart 時点で解決・凍結し、初回プロンプト時に merge + 注入。組み込み `/clear` は実測したどのクライアントでも UserPromptSubmit に届かない。VS Code は `source='clear'` を送るため auto path、Desktop は送らないため `/tl` を先に使う（経緯と実測は [archive docs/12](docs/archive/12_desktop_clear_handoff_plan.md)、upstream: [anthropics/claude-code#76704](https://github.com/anthropics/claude-code/issues/76704)）
  3. baton 消費が auto 判定より先発なので両者は構造上同時成立しない
- **注入内容 (ADR 0016, 2026-07-18〜)**: push は「現在地」だけ — ヘッダ + 現在地アンカー + 案内セクション（無条件表示）+ **L2 を新しい順に丸ごと入るターンだけ全文**（ターン原子・固定 N なし）。**L1 は注入しない**。窓 (20 ターン) の残りは `throughline recall --l2`、それより古い全ターンは `recall --l1`（要約 or 未要約明示）、一点掘りは `throughline detail <時刻>` の pull 三段構成。範囲・境界 (ISO ms strict less-than)・件数・session は全部注入時に案内コマンドへ焼き込み、recall 側は窓を再計算しない。memo / thinking は注入しない
- **注入予算 (ADR 0014)**: hook stdout は約 10k 字超で `<persisted-output>`（path + 先頭 2KB preview）に file 化されモデル可視が劣化する（実測 9,501 字 inline / 15,286 字 file 化。10k 判定は per context string で multi-hook なら突破可能と実測済みだが構造的想定外として不採用 — ADR 0016）。注入は `buildBudgetedResumeContext`（上限 9,500 字）で行う
- **thinking の L3 保存**: assistant の extended thinking ブロックは `details` テーブルに `kind='thinking'` で全ターン保存される。`throughline detail <時刻>` で取り出せるが、注入には含めない
- 各レコードは `origin_session_id` を保持するため、複数回の引き継ぎでも記憶がチェーン状に蓄積する（ホップ制限なし）
- `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` は **使わない**（自動コンパクト依存の設計は放棄済み）
- **フォールバック / 逃げ道のコードを書かない** — [docs/04_public_release_plan.md §0](docs/04_public_release_plan.md) 参照。silent try/catch、`exit(0)` でのエラー隠蔽は禁止

---

## 必読ドキュメント

作業を始める前に以下を読むこと。**憶測で設計を推測しない。ソースと設計書が根拠。**

| ドキュメント | 内容 |
|---|---|
| [docs/00_overview.md](docs/00_overview.md) | docs/ の全体地図。連番正典、ADR、監査、archive、RAG の入口 |
| [docs/01_l1_l2_l3_redesign.md](docs/01_l1_l2_l3_redesign.md) | **L1/L2/L3 記憶レイヤーの設計仕様**。ブロック分類ルール、Haiku 呼び出し方針、実装順序、進捗表。schema v4 基盤 + v5 L3 分類拡張まで。以後の v6/v7 追加は本文書とは独立 |
| [docs/02_clear_auto_handoff_plan.md](docs/02_clear_auto_handoff_plan.md) | handoffの現行契約。VS Codeのauto path (`source='clear'`) + 明示baton path (`/tl`) の2経路、Desktop制約、env `THROUGHLINE_DISABLE_AUTO_HANDOFF` |
| [docs/04_public_release_plan.md](docs/04_public_release_plan.md) | 現行の単独運用入口、明示的失敗、release gate、host配線契約 |
| [docs/05_codex_first_roadmap.md](docs/05_codex_first_roadmap.md) | **次フェーズの実装順 / TODO**。Codex primary 実用化、Codex Rewind 互換、Claude 側 finalization の順で進める |
| [docs/06_codex_trim_rollback_fix_plan.md](docs/06_codex_trim_rollback_fix_plan.md) | Codex rollback / inject incident の調査・修正履歴。controlled user marker の rollback 後 model-visible reproduction は、fresh app-server verify と VS Code reload/reconnect 後 verify の両方で未再現。ただし live token_count 削減が同一 thread で持続しない実測を受け、Codex hooks からの automatic current-thread refresh は無効化し、`$throughline` は app-server 新スレッド handoff に戻す。明示 `trim --execute --host codex` は診断用 current-thread rollback / inject として残す |
| [docs/08_codex_dual_support.md](docs/08_codex_dual_support.md) | Claude / Codex 両対応の architecture brief。Claude path を置き換えず、Codex support を adapter / projection として追加する方針 |
| [docs/09_rollback_context_trim_insight.md](docs/09_rollback_context_trim_insight.md) | rollback を model-visible context の delete primitive と見る設計メモ。次フェーズでは Codex Rewind 互換の根拠として扱う |
| [rag/INDEX.md](rag/INDEX.md) | Throughline 設計判断の根拠となる third-party spec 知識ベース。Claude Code hooks reference、Anthropic Messages API、`/clear`/`/compact` 挙動、openclaude の `initialUserMessage` source 抜粋を蓄積。各 finding は実機検証結果と対で更新 |
| [README.md](README.md) | ユーザー向け説明（Quick Start、3 層モデル、CLI、schema v9、VSCode 自動起動、monitor 診断、中断地点からの再開、トラブルシュート） |
| [docs/archive/](docs/archive/) | 完了済み計画と置換済み設計の履歴。通常は読まず、過去の判断・受入証拠が必要な場合だけ参照 |

DB記憶を別プロセスへ渡す作業は [README.md](README.md) の `handoff-context` 契約と [docs/adr/0018-product-owned-database-migration.md](docs/adr/0018-product-owned-database-migration.md)、Grok host / `/tl` 後継は [docs/adr/0021-grok-host-capture.md](docs/adr/0021-grok-host-capture.md)、Cursor host は [docs/adr/0022-cursor-host-capture.md](docs/adr/0022-cursor-host-capture.md) も読む。

---

## 実装済みファイルの役割

ソースの現状は **常にコードを見て確認する**。以下は索引のみ。

### コア

| ファイル | 役割 |
|---|---|
| [src/db.mjs](src/db.mjs) | SQLite 接続、schema v1 → v9 migration。`node:sqlite` 組み込み、依存ゼロ |
| [src/auditor-context.mjs](src/auditor-context.mjs) | Spotter 専用の read-only auditor projection。指定 session / project の completed L2 user/assistant pair だけを、最新 pair の origin / turn / SHA-256 freshness と schema v9 で検査し、bounded JSON context を返す。DB 作成・migration・書き込みはしない。Spotter 側の opt-in と送信判断は Throughline の責務外 |
| [src/observer-turn-feed.mjs](src/observer-turn-feed.mjs) | Observer向けのcompleted-only Claude receipt／Codex `task_complete` projection、opaque cursor、fixed-through pagination。DB/WALを公開せず、host ambiguityとcursor不整合はfail closedにする |
| [src/transcript-reader.mjs](src/transcript-reader.mjs) | transcript JSONL パーサー |
| [src/transcript-usage.mjs](src/transcript-usage.mjs) | 最新 assistant の `message.usage` から実測トークン数を抽出、1M context 検出 |
| [src/codex-capture.mjs](src/codex-capture.mjs) | Codex rollout JSONL の active turns を Throughline DB の `bodies` に保存する capture adapter。`thread_rolled_back` 適用後の active thread だけを `codex:<thread_id>` session として再構成する |
| [src/codex-rollout-memory.mjs](src/codex-rollout-memory.mjs) | Codex rollout JSONL から active turns / restore-safety diagnostics / trim source を構築する。trim source では現在進行中の in-flight turn と latest rollback 後の未完了 assistant continuation を rollback 候補から除外する。実 rollback 直前に app-server `thread/read` / `thread/resume` が同じ turn count を返し、rollout count と差がある場合は app-server 側の差分で rollback 数を補正する |
| [src/codex-usage.mjs](src/codex-usage.mjs) | Codex rollout の `event_msg` / `token_count` verified shape から monitor 用 usage sample を抽出する。open turn 中は `input_tokens + output_tokens` を live footprint として返し、`task_complete` 後は verified `input_tokens` のみに戻す。`token_count` が無い rollout では active rollout text の `chars / 4` estimate を `estimated: true` として返す |
| [src/codex-auto-refresh.mjs](src/codex-auto-refresh.mjs) | Codex automatic refresh helper。current-thread rollback / inject の判定と backoff ロジックは残すが、helper 自体も default disabled で、現行 Codex hooks はこの helper を呼ばず、常に `codex_auto_refresh_disabled` で quiet にする。明示 `trim --execute --host codex` は診断用 current-thread path として残す |
| [src/codex-handoff.mjs](src/codex-handoff.mjs) | `HandoffRecord` から Codex-facing `throughline_handoff` v1 JSON block と Codex developer-message 用 active-work context を生成。`source='throughline'` / `trust='local'` / `kind='throughline_handoff'` を固定 |
| [src/codex-sidecar.mjs](src/codex-sidecar.mjs) | `codex-sidecar diagnostics` / dry-run wrapper。`disabled` / `unavailable` / `configured` / `operational` / `work-capable` の status enum を持つ。diagnostics wrapper は exit 0 の時だけ `configured` とする |
| [src/token-estimator.mjs](src/token-estimator.mjs) | 補助的なトークン数推定 (length/4) |
| [src/turn-backfill.mjs](src/turn-backfill.mjs) | 共通バックフィルルーチン: 群レベル dedup・junk 代表除外・timestamp `created_at`・`deriveTranscriptPath` |

### host 境界 `src/hosts/`（ベンダー依存の唯一の置き場）

共有コード (hook 入口・monitor・state-file・predecessor 検索) はベンダー分岐を直接書かず、必ずここを参照する。新 host 追加は identity.mjs に prefix、`hosts/<host>.mjs` に adapter を足す。

| ファイル | 役割 |
|---|---|
| [src/hosts/identity.mjs](src/hosts/identity.mjs) | session prefix (`codex:` / `grok:` / `cursor:`)・`hostOfSessionId`・codex thread id 往復・`NON_CLAUDE_SESSION_PREFIXES`・`KNOWN_STATE_HOSTS` の唯一の正本。codex-capture / handoff-record の旧 export はここへの再 export |
| [src/hosts/index.mjs](src/hosts/index.mjs) | `normalizeHookPayload` (Grok camelCase / Cursor envelope の dispatch) と `hostAdapterForSessionId` |
| [src/hosts/claude.mjs](src/hosts/claude.mjs) | Claude adapter (stdout 注入・flush barrier あり・prompt 素通し) |
| [src/hosts/codex.mjs](src/hosts/codex.mjs) | Codex adapter。Codex hook 本体は [src/cli/codex-hook.mjs](src/cli/codex-hook.mjs) のままで、ここは共有コード向けの識別と既定挙動の明文化 |
| [src/hosts/grok.mjs](src/hosts/grok.mjs) | 旧 hook-envelope.mjs を統合。Grok envelope 正規化・chat_history path・chat_history 直書き注入・user_query 包装の command prompt fallback・`/tl` 後の grok-continue 起動・flush barrier 非適用 |
| [src/hosts/cursor.mjs](src/hosts/cursor.mjs) | Cursor envelope 正規化・agent-transcripts path・sessionStart `additional_context` 注入・flush barrier 非適用・後継自動起動なし |

### OS 境界 `src/os/`（OS 依存の唯一の置き場）

| ファイル | 役割 |
|---|---|
| [src/os/windows-acl.mjs](src/os/windows-acl.mjs) | Windows owner-only ACL の apply / verify (PowerShell) と `isWindows`。runtime-error-store と completed-turn-receipts に二重実装されていたものを集約 (15 秒 timeout・explicit failure 契約は不変) |
| [src/os/portable-spawn-sync.mjs](src/os/portable-spawn-sync.mjs) | 同期・非同期の子プロセス起動。WindowsはnpmのPowerShell起動ファイルを解決し、PowerShell 7で標準入出力をUTF-8へ統一する。macOS/LinuxはNodeの起動APIをそのまま使う |
| [src/os/macos-terminal.mjs](src/os/macos-terminal.mjs) | macOS Terminal.app 起動 (detached exec 形 / do script 形)。grok-continue と codex-handoff-start が共用 |
| [src/os/open-url.mjs](src/os/open-url.mjs) | URL を OS 既定 handler で開く (darwin `open` / win32 `start` / linux `xdg-open`) |
| [src/os/shell.mjs](src/os/shell.mjs) | `shQuote` / `appleString` (POSIX / AppleScript quote の唯一の正本) |
| [src/os/paths.mjs](src/os/paths.mjs) | `foldPathCaseForPlatform` — Windows でだけ path を小文字へ畳む判断の集約 (state-file / project-path が共用) |
| [src/os/windows-acl-test-helper.mjs](src/os/windows-acl-test-helper.mjs) | Windows ACL テスト fixture helper (旧 src/windows-acl-test-helper.mjs) |

### Hook 実装（CLI 経由で呼ばれる）

| ファイル | サブコマンド | Hook event |
|---|---|---|
| [src/session-start.mjs](src/session-start.mjs)<br>二相ハンドオフ第一相: sessions 登録 + pending intent 登録のみ。merge / 注入はしない (ADR 0014) | `throughline session-start` | SessionStart |
| [src/turn-processor.mjs](src/turn-processor.mjs)<br>全ターン走査バックフィル（`turn-backfill.mjs` 経由、Stop 空振りの永久穴を解消） | `throughline process-turn` | Stop |
| [src/prompt-submit.mjs](src/prompt-submit.mjs)<br>二相ハンドオフ第二相: 初回プロンプトで pending consume + merge + 予算内注入。`/tl` batonを書き、Grok `/tl` 成功後は`grok-continue`を副作用起動する。`/clear`互換分岐は残るが、現行の組み込み`/clear`はこのhookへ届かない | `throughline prompt-submit` | UserPromptSubmit |

上記 hook module は `run()` を export し、直接実行時または [bin/throughline.mjs](bin/throughline.mjs) から呼ばれた時だけ hook body を実行する。import だけでは stdin 待ち、DB 作成、state 書き込みをしない。

### 記憶張り替え・注入共通

| ファイル | 役割 |
|---|---|
| [src/baton.mjs](src/baton.mjs) | `writeBaton` / `consumeBaton`（現行利用面では`/tl`で書き、newbornセッションの初回UserPromptSubmitで消費。適格性はセッション誕生時刻`bornAt`基準で、負ageのbatonは`future_baton`として残置。schema v8でmemo_text列と`updateBatonMemo`を削除） |
| [src/pending-handoff.mjs](src/pending-handoff.mjs) | 二相ハンドオフの intent 管理 (schema v9 `pending_handoffs`)。`registerPendingHandoff` (SessionStart) / `consumePendingHandoff` (初回 UserPromptSubmit、BEGIN IMMEDIATE で 1 回限り) |
| [src/handoff-executor.mjs](src/handoff-executor.mjs) | 二相ハンドオフ第二相の本体。pending consume → baton path 優先 → auto path の merge → 前任 transcript backfill → `buildBudgetedResumeContext` で予算内注入テキストを組み立てる |
| [src/decision-log.mjs](src/decision-log.mjs) | inheritance-decision.log の共有 writer。`phase: 'session-start' \| 'prompt-submit'` の 2 種を記録（2026-07-17 incident の一次証拠となった実績のあるログ） |
| [src/handoff-record.mjs](src/handoff-record.mjs) | `HandoffRecord` v1 projection。Claude resume context と Codex projection が共有する安定した中間表現。DB 永続化はせず、現行schema v9の既存テーブルから組み立てる。`codex:<thread_id>` session は `source.adapter = codex` として扱う |
| [src/session-merger.mjs](src/session-merger.mjs) | `resolveMergeTarget` / `mergeSpecificPredecessor`（BEGIN IMMEDIATE トランザクション） |
| [src/resume-context.mjs](src/resume-context.mjs) | `HandoffRecord` から「中断地点からの再開」注入テキストを描画。**v0.4.12 以降**: ヘッダーは「現在地参照案内」「直前の対話の自然な続きとして応答」「`Bash` ツールで `throughline detail HH:MM:SS` を実行」の 3 行。本文は **現在地アンカー (最新 user + 最新 assistant turn を再掲、各 600 字で truncate)** → L1 → L2 (末尾 anchor) の順。L2 が長くなると末尾 anchor だけでは注意が前半固着し話の流れを取り違える事例があった (`/clear` 直後に L2 先頭の古いターンを「現在の作業」と誤認するケース) ため、最新ターンをヘッダ直下にも再掲して二重に固定する。L3 は独立セクションを持たず、各 L1/L2 行末尾に `(詳細：…)` inline suffix として集約する。L1 行頭は `bodies.created_at` MIN 時刻 (元 body 時刻) で表示し detail 解決可能にする。**ADR 0016 以降 (2026-07-18)**: 実注入は `buildBudgetedResumeContext`（上限 9,500 字。hook stdout の 10k file 化対策）で、ヘッダ + アンカー + 案内セクション（無条件表示）を固定部として予約し、残り全予算に L2 をターン原子で新しい順に入るだけ詰める。**L1 は注入しない**。案内セクションは `recall --l2/--l1` コマンドに session / ISO ms 境界 / 件数を焼き込む。**ADR 0023以降**: 通常の引き継ぎ案内は最初の一度だけとし、`handoff-context --disclosure silent`またはproject束縛済み補足の`handoffDisclosure: silent`で案内を消せる。旧版のassistant固定宣言は次回文脈から除外する |
| [src/l3-summary.mjs](src/l3-summary.mjs) | resume-context / codex-handoff 共通の L3 inline suffix ヘルパー。`shortenMcpToolName` / `localizeL3Part` / `groupL3ByTurn` / `buildPartsSummary`。MCP ツール名は末尾関数名に短縮、`tool_output` / hook 出力 (`system`) は noise として suffix から除外、`tool_input` 名 (例: Bash) で turn 内 1 件に集約する |
| [src/state-file.mjs](src/state-file.mjs) | セッション単位の状態ファイル (`~/.throughline/state/<session_id>.json`)。`host` 無しは旧 Claude state として normalize し、Codex state は `host: "codex"` / `sessionId: "codex:<thread_id>"` / `rolloutPath` を持つ。ファイル名は URL encode し、Windows でも `codex:` session id を保存できる。`usage` フィールド (tokens/model/contextWindowSize) は Stop 完了時の fallback snapshot。monitor はライブ transcript / rollout を優先し、取れない時だけ snapshot を使う。旧フォーマット (usage 無し) も読める |
| [src/runtime-error-store.mjs](src/runtime-error-store.mjs) | Throughline所有のlocal runtime error設定・aggregate。`runtime-errors enable|disable --json`が製品configを管理し、有効時だけ固定code/templateをSHA-256 fingerprintで集約する。private atomic store、monotonic cursor/ack、resolve/reopen、unacked保護retention、bounded snapshot/diagnosticsを提供する。dotagents config、network I/O、raw exception/stderr/stack/prompt/session/path/contextは扱わない |
| [src/haiku-summarizer.mjs](src/haiku-summarizer.mjs) | L2 → L1 要約。目標量は削減割合（既定 0.2 = 1/5、`THROUGHLINE_L1_RATIO`。不正値は explicit error）で決め、割合から換算した「約N文字」をプロンプトへ渡す。`hostMode: 'claude-primary'` の backend 順序は codex-sidecar (configured 時) → Codex CLI（既定 `gpt-5.6-luna` / effort `low`、`THROUGHLINE_L1_MODEL` / `THROUGHLINE_L1_EFFORT` で変更可。`--ignore-user-config` でもモデルが明示されるよう `-m` を必ず渡す）→ Claude Haiku → raw L2。各段の失敗理由は `sidecarReason` / `codexCliReason` に記録。`hostMode: 'codex-primary'` では Codex CLI backend 一本で、失敗時は fallback せず explicit error。モデル・effort・割合の選定根拠は [ADR 0015](docs/adr/0015-l1-summarizer-model-effort-ratio.md)（実測評価） |
| [src/trim-model.mjs](src/trim-model.mjs) | `throughline trim --dry-run` の plan builder。captured turns / keep-recent / rollback candidate / host boundary / curated memory preview / context reduction estimate を計算する。`--memo-stdin` の current-work memo を先頭に含められる。Codex guarded execute は live app-server guard までの実装であり、restart-safe 成功とは扱わない |
| [src/vscode-task.mjs](src/vscode-task.mjs) | VSCode の `.vscode/tasks.json` を自動プロビジョニング（token-monitor の folderOpen 自動起動）。`ensureMonitorTaskFile` は `throughline install` と **SessionStart / Stop / UserPromptSubmit の 3 hook すべて**から呼ばれる。冪等性ガード付きなので重複呼び出し安全。install または 1 つの hook が発火すれば tasks.json が生える。純 JSON は安全にマージ、JSONC は触らず stderr で手動手順を 1 度だけ案内。**v0.3.23 以降**: `findMonitorTaskIndex` + `isMonitorTaskBroken` で「既存タスクの絶対パスが現環境に存在しない」を検知して `command` / `args` だけを差し替え修復する (`action: 'repaired'`)。クロス環境 (Windows ↔ WSL2 / Linux ↔ macOS) で commit された tasks.json が壊れる問題を解消。`label` / `presentation` 等のユーザーカスタマイズは保持する。**v0.3.24 以降**: `shouldRecommendGitignore` で「git リポジトリ内かつ `.gitignore` に `.vscode/tasks.json` 系エントリが無い」を判定し、created/merged/repaired 時に 1 度だけ stdout に `<system-reminder>` で除外推奨を出す（`.throughline-gitignore-noted` marker で再発抑止）|
| [src/terminal-size.mjs](src/terminal-size.mjs) | OSC 18t (`\x1b[18t`) で端末に実幅を問い合わせるユーティリティ。Windows ConPTY + VSCode task terminal では `process.stdout.columns` が凍結するので、stdin を raw mode で listen して `\x1b[8;rows;cols t` 応答を parse する。Ctrl+C 検知 (0x03) と stop() での raw mode 解除も担当 |

### CLI

| ファイル | サブコマンド |
|---|---|
| [bin/throughline.mjs](bin/throughline.mjs) | ディスパッチャ |
| [src/cli/install.mjs](src/cli/install.mjs) | `install` / `uninstall`（デフォルト global、`--project` で Claude ローカル）。global install は `~/.claude/settings.json` と slash commands に加えて `~/.codex/hooks.json` の UserPromptSubmit / PostToolUse / Stop に絶対 node + `bin/throughline.mjs codex-hook ...` を先頭登録し、`~/.codex/config.toml` の `[features].codex_hooks = true` と `[features].hooks = true` を有効化し、`~/.codex/skills/throughline` に `$throughline` skill を配置する。既存 Caveat / Spotter Codex hooks は保持し、uninstall は Throughline 管理の Codex hook / skill だけ削除する。**v0.3.23 以降**: `resolveThroughlineOnPath` で install 完了時に PATH 上の `throughline` 解決を確認し、見つからなければ stderr に修復手順 (npm prefix → `~/.bashrc` 編集 → `doctor` 確認) を出す。Claude-facing hooks は PATH 解決型のため、`~/.npm-global/bin` を `.profile` だけに書いて bashrc に書き忘れる sudoless prefix 派の silent fail を防ぐ |
| [src/cli/doctor.mjs](src/cli/doctor.mjs) | `doctor` — 環境チェック。`doctor --session <id-prefix>` で特定セッションの state/transcript 整合性を診断。`doctor --trim --host claude|codex|unknown` で trim host boundary を診断し、Codex では host primitive audit status も表示する。`doctor --codex` で Codex primary の thread env / rollout candidates / captured DB sessions / context refresh memory source と `/tl` memory contract、new-thread handoff / safe continuation status、host primitive audit、VSCode monitor task の登録状態 / Reload Window note を診断 |
| [src/cli/status.mjs](src/cli/status.mjs) | `status` — DB 統計表示 |
| [src/cli/handoff-preview.mjs](src/cli/handoff-preview.mjs) | `handoff-preview` — sidecar 実行なしで `throughline_handoff` JSON projection を stdout に出す。`--session <id>` / `--host-mode claude-primary|codex-primary|unknown` |
| [src/cli/handoff-context.mjs](src/cli/handoff-context.mjs) | `handoff-context (--session <id> \| --project <path>) --json` — 既存DBをread-onlyで開き、SessionStartと同じ9,500字予算のinheritance contextをversioned JSONで返す。project指定時はそのprojectで会話本文を持つ最新sessionを選び、本文がなければ`empty`を返す。`--disclosure silent`は補足なしで基盤案内を消す。session指定時の任意補足JSONは源sessionと同じprojectだけを長期記憶・知識として合成する。DB作成・migration・merge・batonは行わない |
| [src/cli/grok-continue.mjs](src/cli/grok-continue.mjs) | `grok-continue --session <id>` — handoff-context を初手 user 文にして、源セッションの `project_path` で macOS Terminal の対話 `grok` を立てる。context / project_path 失敗では spawn しない。末尾は待機。`--rules` なし |
| [src/cli/auditor-context.mjs](src/cli/auditor-context.mjs) | `auditor-context` — Spotter 専用・JSON-only の read-only projection。`--session` / `--project` と、explicit pair identity/hash または `--host claude\|codex --transcript` を受ける（排他）。`fresh` だけに L2 body を含め、`empty` / `stale` / `session_mismatch` / `unavailable` / `schema_mismatch` は空 turns を返す。DB は create/migrate/write しない |
| [src/cli/observer-read.mjs](src/cli/observer-read.mjs) | `observer-read` — existing absolute project向けJSON-only completed-turn page。opaque cursorを受け、snapshot / delta / thread・host switch、`resync_required`、`projection_pending`を返す |
| [src/cli/observer-wait.mjs](src/cli/observer-wait.mjs) | `observer-wait` — opaque after cursorから最大3600秒待機し、`changed` / `timeout` / `resync_required` / `ambiguous_parent`だけをJSONで返す。cancelは成功に丸めない |
| [src/cli/runtime-errors.mjs](src/cli/runtime-errors.mjs) | `runtime-errors enable\|disable\|snapshot\|diagnostics\|ack\|resolve\|reopen\|compact --json` — product-owned config/store の bounded JSON API。snapshot/diagnostics は state path を出さず、mutation API は cursor または fingerprint だけを受け付ける |
| [src/cli/migrate.mjs](src/cli/migrate.mjs) | `migrate --json` — 既存の Throughline DB だけを production migration で現行 schema へ移行する正規入口。DB 不在時は作成せず `not_applicable`、現行は `already_current`、future schema と migration failure は非 0 の固定 JSON で明示する |
| [src/cli/codex-capture.mjs](src/cli/codex-capture.mjs) | `codex-capture` — 明示 Codex thread id の rollout active turns を `codex:<thread_id>` session として DB に保存する。thread id が無い場合は自動推測しない |
| [src/cli/codex-summarize.mjs](src/cli/codex-summarize.mjs) | `codex-summarize` — captured `codex:<thread_id>` session の古い L2 を Codex CLI backend で L1 skeleton に要約する。Claude Haiku へ fallback しない |
| [src/cli/codex-resume.mjs](src/cli/codex-resume.mjs) | `codex-resume` — Codex primary 用 active-work context を DB から描画する。`--format handoff` で current thread を mutate しない新規 Codex thread 用 handoff prompt を出す。handoff は L2 件数 / 本文長 / detail refs を cap し、full context は通常 text renderer に残す。`--format item-json` で developer message item JSON を出す。`--memo-stdin` で Codex-primary in-flight memo を先頭に足す |
| [src/cli/codex-handoff-smoke.mjs](src/cli/codex-handoff-smoke.mjs) | `codex-handoff-smoke` — `codex-resume --format handoff` の出力が新規 Codex thread 開始 prompt として貼れるかを read-only 検査する。header / reading contract / source session / start instruction / mutation boundary / prompt size / detail command 重複を確認し、DB / Codex thread は mutate しない |
| [src/cli/codex-handoff-model-smoke.mjs](src/cli/codex-handoff-model-smoke.mjs) | `codex-handoff-model-smoke` — handoff prompt を `codex exec --ephemeral --ignore-user-config --ignore-rules --sandbox read-only` に渡す明示 opt-in model smoke。`--dry-run` は env なしで readiness / command boundary を検査し、`--print-prompt` で結合 prompt を監査用に出せる。`--memo-stdin` で Codex-primary current-work memo を handoff prompt に含める。live smoke は `THROUGHLINE_EXPERIMENTAL_CODEX_HANDOFF_MODEL_SMOKE=1` 必須。事前に structural handoff smoke が ready でなければ拒否し、current thread は mutate しない |
| [src/cli/codex-handoff-start.mjs](src/cli/codex-handoff-start.mjs) | `codex-handoff-start` — 新規 Codex thread へ移るための guided surface。structural smoke、model smoke dry-run boundary、handoff render command、optional live smoke command、`--print-prompt` の結合済み handoff prompt をまとめて出す。`--execute` では `codex app-server thread/start` + `thread/inject_items` で新 thread に developer memory を注入し、`--open-host auto\|desktop\|vscode\|cli\|none` で表示を開く。CLIは requested / resolved hostを両方報告する。`auto` はCLIプロセス環境からCodex Desktop起点を識別するが、Codex skillは永続PTYの継承環境へ依存せず現在のCodex surfaceを明示指定する。VS Code / CLI の既存経路は維持する。`--memo-stdin` 時は replay 用の個別 command にも `--memo-stdin` を伝播し、same memo を pipe する注意を出す。current thread は mutate しない |
| [src/cli/codex-visibility-smoke.mjs](src/cli/codex-visibility-smoke.mjs) | `codex-visibility-smoke` — Codex active-work memory を app-server に inject し、`turn/start` の marker 応答で model-visible を測る実験 smoke。`--memo-stdin` / `--resume-after-inject` 対応。`THROUGHLINE_EXPERIMENTAL_CODEX_MODEL_VISIBLE_SMOKE=1` 必須。実 Codex host では marker が `item/agentMessage/delta` に出ることを確認済み |
| [src/cli/codex-rollback-model-visible-smoke.mjs](src/cli/codex-rollback-model-visible-smoke.mjs) | `codex-rollback-model-visible-smoke` — controlled two-phase smoke。`--prepare` は unique marker を含む user turn を開始して 1 turn rollback する。`--verify` は full marker ではなく prefix だけを含む prompt で、rollback 済み marker が model-visible かを測る。`THROUGHLINE_EXPERIMENTAL_CODEX_ROLLBACK_MODEL_VISIBLE_SMOKE=1` 必須。`--marker-file` は full marker を同一 thread の chat/tool output に漏らさず、per-trial prefix を使う。`reproduced` は bug reproduction、`not-reproduced` はこの経路では未再現 |
| [src/cli/codex-restore-smoke.mjs](src/cli/codex-restore-smoke.mjs) | `codex-restore-smoke` — Codex thread を新しい app-server process で複数回 `thread/read` / `thread/resume` / `thread/turns/list` し、rollout active turn count と一致するかを測る read-only smoke。`THROUGHLINE_EXPERIMENTAL_CODEX_RESTORE_SMOKE=1` 必須。`--inspect-risky-rollout` は risk rollout を read-only で監査し、retained rollback text が direct turn text / `replacement_history` などの blocking candidate に出た場合は `app-server-restore-text-retained`、`aggregatedOutput` など quoted/tool-output field のみに出た場合は `app-server-restore-text-quoted` とする。proof scope は `app_server_process_restart_only` で、VS Code restart-safe 証明ではない |
| [src/cli/codex-restore-source-audit.mjs](src/cli/codex-restore-source-audit.mjs) | `codex-restore-source-audit` — Codex rollout / `session_index.jsonl` / `state_*.sqlite` / VS Code globalStorage・workspaceStorage 候補 / settings / logs / installed OpenAI-Codex VS Code extension bundle の restore-path signals を read-only で棚卸しする。VS Code storage では `.vscdb` / `.sqlite` / `.sqlite3` / `.db` 候補の table / column / needle match summary も出す。VS Code logs では thread id / retained rollback text / patch apply failure / thread stream broadcast / `replacement_history` signal を分けて報告する。extension bundle では app-server restore / webview persisted atom / follow-up queue / thread-stream patch apply path signals と、`replacement_history` filter / tombstone などの rollback non-resurrection projection candidate を分けて報告する。proof scope は `local_restore_source_inventory_only` で、VS Code restart-safe 証明ではない。VS Code 診断は host-agnostic repair contract の根拠集めであり、repair primitive そのものではない |
| [src/cli/codex-host-primitive-audit.mjs](src/cli/codex-host-primitive-audit.mjs) | `codex-host-primitive-audit` — installed Codex app-server schema を read-only で監査し、same-thread rollback non-resurrection primitive と host-agnostic same-thread repair contract を報告する。contract は deletion / isolation / projection のいずれかによる rollback non-resurrection guarantee、memory reinjection、post-repair read verification、restart/reconnect non-resurrection smoke を要求する。実 `codex-cli 0.128.0-alpha.1` では diagnostic status として `blocked-missing-current-thread-non-resurrection-guarantee` を返すが、Codex trim execute / auto-refresh の blocker にはしない |
| [src/cli/codex-vscode-restore-smoke.mjs](src/cli/codex-vscode-restore-smoke.mjs) | `codex-vscode-restore-smoke` — `--prepare` で hidden active-work marker memory を注入し、VS Code reload / reconnect 後に marker を含まない prompt への応答を `--verify` で rollout 検証する二段階 smoke。prepare は `THROUGHLINE_EXPERIMENTAL_CODEX_VSCODE_RESTORE_SMOKE=1` 必須。実 marker proof は成功済みだが、rollback 非復活証明ではない |
| [src/cli/codex-vscode-rollback-smoke.mjs](src/cli/codex-vscode-rollback-smoke.mjs) | `codex-vscode-rollback-smoke` — rollout を read-only で読み、rollback event、rollback 済み user text、rollback 後 user turn、`restoreSafety.status = ok`、`--after-vscode-restart` がそろう場合だけ rollback 非復活 proof として `restartSafe: true` を返す。incident-shaped live run は `restore_safety_risk` として扱う。text output は retained / resurrected counts と risk type summary を出す |
| [src/cli/codex-sidecar-diagnostics.mjs](src/cli/codex-sidecar-diagnostics.mjs) | `codex-sidecar-diagnostics` — `codex-sidecar diagnostics --project <repo> --preset <preset>` を実行し、JSON status を返す。failure は explicit `unavailable` |
| [src/cli/codex-sidecar-dry-run.mjs](src/cli/codex-sidecar-dry-run.mjs) | `codex-sidecar-dry-run` — `review` / `risk-check` などの sidecar request を Codex App Server へ送らず正規化 JSON として確認する |
| [src/cli/trim.mjs](src/cli/trim.mjs) | `trim --dry-run` / `--preflight` / guarded `--execute`。Codex `--execute` は明示コマンドとして rollback + Throughline DB memory inject を送る。restore-safety diagnostics、host primitive audit、rollout/app-server turn-count mismatch は診断であり、実行前 blocker ではない。結果 status は `execute-sent-live-only` / `execute-unverified` / `execute-durable-verified` に分かれ、durable verified には rollout 上の新 rollback marker と active-work memory injection が必要。developer memory inject は item-level で、`thread/inject_items` が turn list を返さない場合は post-inject turn 増加を期待しない |
| [src/token-monitor.mjs](src/token-monitor.mjs) | `monitor` — マルチセッション対応トークンモニター。Claude transcript / Codex rollout の mtime と live usage を state snapshot より優先するため、Stop hook 完了待ちではなく監視中に更新できる。Codex は `~/.codex/sessions/**/rollout-*.jsonl` も直接 discovery するため、Throughline state 未生成の現在 thread も表示できる。Claude / Codex の host を compact 表示し、Codex usage が estimate の場合は `est` / `win?`、Codex open turn では `input_tokens + output_tokens` を token count に overlay する。Codex 表示 ID は `codex:` prefix を外した raw thread id 先頭 8 桁。`--diag` で TTY/columns/env を出力（描画不具合の切り分け用） |
| [src/sc-detail.mjs](src/sc-detail.mjs) | `/sc-detail <時刻>` スラッシュコマンド（[.claude/commands/sc-detail.md](.claude/commands/sc-detail.md) 経由） |
| [src/cli/recall.mjs](src/cli/recall.mjs) | `recall --l2\|--l1` — 注入案内から辿る pull 用の read-only DB 直参照 (ADR 0016)。`--l2 --session <id> --before <ISO ms> --last <N>` で境界 (strict less-than) より古い L2 全文を N ターン、`--l1 ... --skip <N>` で --l2 の担当分より古い全ターン一覧（L1 要約 or 未要約明示、冒頭に「全 M / 要約済み K」）。窓の再計算をせず、焼き込まれた引数だけで範囲が決まる。DB は read-only open（存在しなければ explicit error、create/migrate/write なし）。既定 session 解決なし |

### スラッシュコマンド

| ファイル | 用途 |
|---|---|
| [.claude/commands/tl.md](.claude/commands/tl.md) | `/tl` — バトン設置 (UserPromptSubmit hook が検出して handoff_batons に書き込む)。v0.4.0 以降は memo 入力を要求しない最小実装 |
| [.claude/commands/sc-detail.md](.claude/commands/sc-detail.md) | `/sc-detail <時刻>` — L2+L3 詳細取得 |

### テスト

| ファイル | 対象 |
|---|---|
| [src/baton.test.mjs](src/baton.test.mjs) | `writeBaton` / `consumeBaton` / TTL 動作 (v8 で memo_text 関連 test 削除) |
| [src/prompt-submit.test.mjs](src/prompt-submit.test.mjs) | `isBatonCommand` / `isClearCommand` の slash command 判定 (`/tl`, `/clear` の単独・引数つき・前後空白・prefix 偽陽性拒否) |
| [src/codex-capture.test.mjs](src/codex-capture.test.mjs) | Codex `codex:<thread_id>` session identity、rollout active turns の L2 capture、`function_call` / `function_call_output` の L3 details capture、rollback tail 再構成、Codex-origin handoff |
| [src/codex-usage.test.mjs](src/codex-usage.test.mjs) | Codex rollout `token_count` usage 抽出、`token_count` 不在時の明示 estimate、空 rollout の null |
| [src/codex-auto-refresh.test.mjs](src/codex-auto-refresh.test.mjs) | Dormant helper の default disabled、75% 閾値、estimate usage の非実行、明示 enabled 時に threshold reached で rollback/inject を呼ぶこと、DB memory が無い場合の skip |
| [src/codex-handoff.test.mjs](src/codex-handoff.test.mjs) | `toThroughlineHandoffBlock` の `throughline_handoff` v1 JSON shape と Codex active-work context renderer |
| [src/codex-summarize.test.mjs](src/codex-summarize.test.mjs) | `throughline codex-summarize` の Codex CLI backend L1 書き込み、L2 window 内 skip |
| [src/codex-visibility-smoke.test.mjs](src/codex-visibility-smoke.test.mjs) | `throughline codex-visibility-smoke` の env guard と fake app-server marker visibility |
| [src/cli/codex-rollback-model-visible-smoke.test.mjs](src/cli/codex-rollback-model-visible-smoke.test.mjs) | `throughline codex-rollback-model-visible-smoke` の env guard、prepare rollback、verify not-reproduced / reproduced 判定、full marker 非漏洩 |
| [src/codex-restore-smoke.test.mjs](src/codex-restore-smoke.test.mjs) | `throughline codex-restore-smoke` の env guard、fresh app-server process 間の stable / mismatch 判定、restore-safety risk の事前拒否、risky read-only inspection 時の `app-server-restore-text-retained` / `app-server-restore-text-quoted` 分類 |
| [src/codex-restore-source-audit.test.mjs](src/codex-restore-source-audit.test.mjs) | `throughline codex-restore-source-audit` の rollout / session index / Codex state DB / VS Code storage / settings / logs / VS Code extension bundle 棚卸しと missing rollout refusal |
| [src/codex-vscode-restore-smoke.test.mjs](src/codex-vscode-restore-smoke.test.mjs) | `throughline codex-vscode-restore-smoke` の prepare env guard、hidden marker prompt、restart acknowledgement、marker leak rejection |
| [src/codex-vscode-rollback-smoke.test.mjs](src/codex-vscode-rollback-smoke.test.mjs) | `throughline codex-vscode-rollback-smoke` の restart acknowledgement 必須化、restore-safety risk refusal、CLI JSON 出力 |
| [src/codex-sidecar.test.mjs](src/codex-sidecar.test.mjs) | `diagnoseCodexSidecar` の disabled / unavailable / configured status と sidecar dry-run request shape |
| [src/codex-sidecar-cli.test.mjs](src/codex-sidecar-cli.test.mjs) | `throughline codex-sidecar-diagnostics` / `throughline codex-sidecar-dry-run` CLI 出力 |
| [src/db-schema.test.mjs](src/db-schema.test.mjs) | schema v9 の Claude-facing table / field / index 名固定 |
| [src/auditor-context.test.mjs](src/auditor-context.test.mjs) | Spotter auditor projection の freshness、role 除外、bound、schema / DB 状態、Claude / Codex transcript freshness、read-only WAL 契約 |
| [src/cli/auditor-context.test.mjs](src/cli/auditor-context.test.mjs) | `auditor-context` JSON-only CLI、freshness source 排他、固定秘匿 error、bin help / dispatch |
| [src/runtime-error-store.test.mjs](src/runtime-error-store.test.mjs) | collection fail-closed、privacy reject、固定 fingerprint 集約、cursor/ack、resolve/reopen、retention、private mode、atomic write、bounded diagnostics |
| [src/runtime-error-hook.test.mjs](src/runtime-error-hook.test.mjs) | Claude/Codex top-level hook failure の単一 owner 観測、重複排除、store failure 時の固定 stderr と本体 failure 維持 |
| [src/cli/runtime-errors.test.mjs](src/cli/runtime-errors.test.mjs) | runtime error CLI の厳格な引数面、JSON-only snapshot/diagnostics、固定秘匿 failure |
| [src/handoff-record.test.mjs](src/handoff-record.test.mjs) | `buildHandoffRecord` の stable projection、origin 除外、空 projection |
| [src/haiku-summarizer.test.mjs](src/haiku-summarizer.test.mjs) | L2 → L1 要約の host mode 分岐、`codex-sidecar` 使用、disabled 時の Haiku 互換経路、Codex CLI backend、Codex CLI failure 非 fallback、再帰ガード |
| [src/handoff-preview.test.mjs](src/handoff-preview.test.mjs) | `throughline handoff-preview` の explicit session / cwd latest session 出力 |
| [src/cli/handoff-context.test.mjs](src/cli/handoff-context.test.mjs) | `throughline handoff-context` が既存rendererと完全一致する文脈を返し、L1/L2/L3のsession所有権と`merged_into`を変えず、DB不在時に作成しない契約 |
| [src/cli/grok-continue.test.mjs](src/cli/grok-continue.test.mjs) | `grok-continue` の初手待機、源 project_path 起動、handoff-context 失敗時非 spawn、`--rules` / aiterm 非使用、macOS Terminal 起動 |
| [src/codex-resume.test.mjs](src/codex-resume.test.mjs) | `throughline codex-resume` の text / developer message item JSON / cwd latest Codex session 出力 |
| [src/hook-entrypoints.test.mjs](src/hook-entrypoints.test.mjs) | import-safe hook module、temp HOME / isolated DB での `prompt-submit` / `session-start` / `process-turn` subprocess 動作。二相ハンドオフ（SessionStart は intent のみ / 初回プロンプトで merge + 注入）、幽霊先着でもバトンを奪えない incident 回帰、走行中セッションの future baton 非横取り、`/tl` / `/clear` baton 書き込みを含む |
| [src/pending-handoff.test.mjs](src/pending-handoff.test.mjs) | `registerPendingHandoff` / `consumePendingHandoff` の登録・再登録 (resume)・1 回限り消費・他セッション非干渉 |
| [src/trim-model.test.mjs](src/trim-model.test.mjs) | `buildTrimPlan` の captured turns / keep-recent / rollback candidate / host boundary / current-work memo preview |
| [src/trim-cli.test.mjs](src/trim-cli.test.mjs) | `throughline trim --dry-run` JSON 出力、`--memo-stdin`、non-dry-run 明示拒否 |
| [src/resume-context.test.mjs](src/resume-context.test.mjs) | `buildResumeContext` の注入順序・空 context・current-origin 除外に加え、budgeted (ADR 0016): ターン原子詰め、L1 非注入、案内セクション無条件表示、`--before`/`--last`/`--session` 焼き込みの整合、窓外ターンの正直な要約済み/未要約件数、最新ターン切り詰め維持 |
| [src/cli/recall.test.mjs](src/cli/recall.test.mjs) | `throughline recall` の strict less-than ms 境界（同秒・深夜跨ぎ）、窓非再計算（新セッションターン追記で結果不変）、--l1 の未要約明示と skip、他セッション非混入、L3 suffix、read-only 契約（DB 不在で explicit error・作成しない）、bin 経由 E2E |
| [src/session-merger.test.mjs](src/session-merger.test.mjs) | `resolveMergeTarget` / `mergeSpecificPredecessor` |
| [src/state-file.test.mjs](src/state-file.test.mjs) | `writeSessionState` / `readAllSessionStates` / `snapshotStateMtimes` / stale 閾値 / `usage` スナップショット / 旧フォーマット互換 / Codex state filename encoding |
| [src/turn-processor.test.mjs](src/turn-processor.test.mjs) | `countDistinctBodyTurns` / `pickOldestUnsummarizedTurn` / 20 ターン境界 |
| [src/turn-backfill.test.mjs](src/turn-backfill.test.mjs) | `backfillBodies` の群 dedup / 冪等性 / junk / timestamp / sidechain / path munging |
| [src/token-monitor.test.mjs](src/token-monitor.test.mjs) | CLI 引数、cell 幅、bar/色覚マーカー、`formatTimeAgo`、`shouldForceFullRedraw`、`formatLine` の ago 配置 / Codex estimated marker |
| [src/transcript-reader.test.mjs](src/transcript-reader.test.mjs) | transcript JSONL パーサー、`extractDetailBlocks` の全 kind 分類 |
| [src/transcript-usage.test.mjs](src/transcript-usage.test.mjs) | `readLatestUsage` / `inferContextWindowSize` / 1M sticky / size+mtime キャッシュ |
| [src/vscode-task.test.mjs](src/vscode-task.test.mjs) | `ensureMonitorTaskFile` の全分岐 (created / merged / repaired / already_present / skipped×複数 reason)、JSONC 検出、インデント保持、冪等性、`buildSetupNotice` と created/merged/repaired 時の stdout 通知。`findMonitorTaskIndex` / `isMonitorTaskBroken` の単体テスト (v0.3.23+)。`shouldRecommendGitignore` と gitignore 推奨 1 度だけ通知 (v0.3.24+) |
| [src/terminal-size.test.mjs](src/terminal-size.test.mjs) | `parseSizeResponse` / `startSizeQuery` — OSC 18t 応答パース、raw mode 遷移、分割到着、Ctrl+C 捕捉、stop() 冪等性 |
| [src/cli/doctor.test.mjs](src/cli/doctor.test.mjs) | `doctor --session` / `doctor --trim` / `doctor --codex` 用の `parseArgs` / diagnostics helpers |
| [src/cli/install.test.mjs](src/cli/install.test.mjs) | `run` (install / uninstall) の冪等性、`--project` スコープ、Claude Stop `async: true` / Codex Stop `async: false` 登録、既存 Codex hook shape 更新、slash command 配置、`resolveThroughlineOnPath` の PATH 解決テスト (v0.3.23+) |
| [src/cli/self-update.test.mjs](src/cli/self-update.test.mjs) | `self-update` がnpm global rootと公開PATHの実体一致、版情報の文字列・単一結果配列、versioned handshake、公開diagnostics全体のready、Windows `pwsh` + `npm.cmd`、子stderr保持を検証する契約 |

```bash
# 全テスト
npm test
```

### 削除済み

`src/classifier.mjs`, `src/detail-capture.mjs`, `src/throughline.mjs` は schema v4 で不要化して削除済み。 `src/hook-envelope.mjs` は 2026-08-23 のリファクタで `src/hosts/grok.mjs` へ統合済み。`src/context-injector.mjs` は SessionStart との重複注入を解消するため廃止。AGENTS.md や docs の旧記述に残っていたら現状と乖離しているサイン。

---

## Hooks 構成（現状）

`throughline install` が `~/.claude/settings.json` に書く内容は [src/cli/install.mjs](src/cli/install.mjs) の `SC_HOOKS` が正。

リポジトリ直下の `.claude/settings.json` は端末固有なので置かない。ローカル許可設定が必要な場合は Claude Code の permission prompt / fewer-permission-prompts で生成し、端末固有差分は `.claude/settings.local.json` に置く。

```json
{
  "hooks": {
    "SessionStart":     [{ "hooks": [{ "command": "throughline session-start" }] }],
    "Stop":             [{ "hooks": [{ "command": "throughline process-turn", "async": true } ] }],
    "UserPromptSubmit": [{ "hooks": [{ "command": "throughline prompt-submit" }] }]
  }
}
```

global install 時は Codex 側も [src/cli/install.mjs](src/cli/install.mjs) の `CODEX_HOOKS` が正。

```json
{
  "hooks": {
    "UserPromptSubmit": [{ "hooks": [{ "command": "/abs/node /abs/throughline/bin/throughline.mjs codex-hook user-prompt-submit", "async": false, "timeout": 30 }] }],
    "PostToolUse": [{ "hooks": [{ "command": "/abs/node /abs/throughline/bin/throughline.mjs codex-hook post-tool-use", "async": false, "timeout": 30 }] }],
    "Stop": [{ "hooks": [{ "command": "/abs/node /abs/throughline/bin/throughline.mjs codex-hook stop", "async": false, "timeout": 300 }] }]
  }
}
```

あわせて `~/.codex/config.toml` の `[features].codex_hooks = true` と `[features].hooks = true` を有効化し、`~/.codex/skills/throughline` に `$throughline` skill を配置する。`throughline uninstall` は Throughline 管理の Codex UserPromptSubmit / PostToolUse / Stop hook と skill だけを削除し、Caveat / Spotter など既存の非 Throughline hook / skill は保持する。

- **Claude Stop は `async: true`、Codex hooks は `async: false` で登録する。** Claude 側の `throughline process-turn` は内部で `claude -p --model haiku` subprocess を起動するため、同期実行だとターン完了 → ユーザー表示を数秒〜数十秒ブロックしていた。Claude L1 要約は**次** SessionStart 注入用なので今ターンをブロックする必要がない → async 化。Codex 側は Caveat の実測済み Codex hook と同じく同期登録にする。Codex `async: true` では Throughline DB capture / monitor state write が自然に進んだか確認しづらく、既存登録済み hook も `throughline install` で `async: false` に更新する。
- Codex hooks は bare `throughline codex-hook ...` ではなく、絶対 node path + installed `bin/throughline.mjs` で登録する。Codex App Server / VSCode host の PATH は対話 shell と一致しないことがあり、Caveat の動作実績もこの絶対パス型だった。既存の bare Throughline Codex hook は次回 `throughline install` で絶対パス型へ置換する。
- hook shape 変更前から開いている Codex VSCode session は、変更後の自然 Stop smoke として扱わない。Codex host が session 開始時に hook config を読んでいる可能性を排除できないため、VSCode-origin を実測する場合は変更後に新しい Codex session を開始して `doctor --codex` で latest DB session を確認する。
- `doctor --codex` は `~/.codex/hooks.json` の登録有無だけでなく、Codex の新 hook trust gate (`~/.codex/config.toml` の `[hooks.state."<hooks.json>:event:i:j"].trusted_hash`) も表示する。`registered` でも `trusted: no` の hook は Codex の hook 受け入れメニューで承認されるまで実行されない可能性がある。
- 2026-05-06 の最終実測では、hook shape 変更後に新しく開始した VSCode-origin Codex thread `019dfd62-9a9d-7211-bf91-89d8e3fc908e` で自然 Stop hook が発火し、`doctor --codex` の `current Codex thread` と `latest DB session: codex:019dfd62-9a9d-7211-bf91-89d8e3fc908e` が一致した。これにより VSCode-origin の自然 DB capture も確認済み。
- Codex の bare `$throughline` は、Claude の `/clear` 後継続に近い新スレッド handoff surface とする。通常 path は `throughline codex-handoff-start --execute --open-host <current-codex-surface>` で、current thread を rollback / inject しない。current surfaceはCodex UI contextから決め、shell／永続PTYの継承環境から推測しない。`doctor --codex` / `trim --dry-run --all` / `trim --preflight --all` / 明示 `trim --execute --host codex --all` は診断・手動 current-thread 実験用に残すが、通常 `$throughline` の前段にはしない。
- Codex UserPromptSubmit / PostToolUse hooks は token-monitor に依存せず rollout capture と monitor state write だけを行う。verified 75% 以上でも `$throughline` workflow 実行指示を `additionalContext` で注入しない。戻り値は `codex_auto_refresh_disabled` で quiet にし、同じ thread / 同じ状態で自動発火し続けない。
- Codex Stop hook は DB capture / L1 summarize に加え、monitor 用 state も書く。`transcriptPath` は Claude transcript 用に残し、Codex rollout path は `rolloutPath` に保存する。monitor は state の `rolloutPath` と、state 未生成でも `~/.codex/sessions/**/rollout-*.jsonl` から直接 discovery した Codex rollout をライブに読み、`token_count` event がある場合は実測 usage として出し、無い場合だけ `estimated: true` の明示 estimate を出す。
- Codex Stop hook は automatic refresh mutation を実行しない。verified usage が `75%` 以上でも rollback / inject を送らず、capture / L1 summarize / monitor state write のあと `codex_auto_refresh_disabled` を返す。current-thread rollback / inject は明示 `trim --execute --host codex` の診断用 path に限定する。
- Codex guarded trim の rollback source は rollout を使って計画するが、実 rollback 直前に app-server `thread/read` / `thread/resume` が同じ turn count を返し、rollout count と差がある場合は app-server 側の差分で `numTurns` を補正する。turn-count mismatch は診断であり mutation 前 blocker ではない。注入 memory は Throughline DB の `/tl` contract を正とする。`--session` 未指定時の Codex memory source は現在の `CODEX_THREAD_ID` / `THROUGHLINE_CODEX_THREAD_ID` に対応する `codex:<thread_id>` であり、同じ project の latest session へ fallback しない。古い turn は L1 summaries、直近 20 turn は L2 full bodies、L3 は reference only で、L3 bodies / tool payloads は注入しない。rollout preview を DB memory の代わりとして注入せず、DB memory が無い execute は mutation 前に拒否する。`codex-host-primitive-audit` と restore-safety diagnostics は表示するが、mutation 前 blocker にはしない。`doctor --codex` と `doctor --trim --host codex` はこの inject memory source / contract / L1-L2-L3 counts を表示する。
- Codex trim の削減量は host tokenizer の厳密実測ではなく、現時点では rollout text の `chars / 4` heuristic estimate として dry-run に表示する。rollback candidate turns が 0 の場合は、削減量も 0 と明示する。
- L2 → L1 要約は現行実装で唯一の subagent 的 external model call。backend 順序は codex-sidecar (configured 時) → Codex CLI（既定 `gpt-5.6-luna`@`low`、ADR 0015 の実測評価で選定）→ Claude Haiku → raw L2。削減割合は既定 1/5 で `THROUGHLINE_L1_RATIO` により割合形式のまま変更できる。`/tl` の in-flight memo はメイン Claude が slash command 手順で書くため sidecar 移行対象ではない
- Claude CLI を実際に呼ぶテスト / smoke は、明示的に必要な場合だけ実行し、モデルは Haiku を使う。他モデルを使う必要がある場合は根拠を残してから実行する
- 現行 install は Throughline 管理 Codex hook の shape を更新する。同じ `throughline codex-hook stop` command が既にあっても、絶対パス型 command / `timeout` / `async` などを [src/cli/install.mjs](src/cli/install.mjs) の生成値に合わせる。旧 `timeoutSec` entry も command identity で除去し、canonical entryへ置換する。
- **UserPromptSubmit** は二相ハンドオフ第二相 (pending intent 消費 + merge + 予算内注入) + `/tl` バトン書き込み + VSCode tasks.json 自動プロビジョニングの3役 (ADR 0014)。`/clear`互換分岐は残るが、組み込み`/clear`は実測したクライアントからこのhookへ届かない。Grok `/tl` のあとだけ `throughline grok-continue --session <id>` を副作用で呼ぶ。Claude / Codex と Grok `/clear` では呼ばない。注入がこの hook に移ったため、SessionStart 側の注入は廃止（旧「二重注入回避」制約は消滅）。tasks.json 作成は SessionStart / Stop にも同じ呼び出しがあり、どれか 1 つでも発火すれば生成される（冪等）
- **Claude PostToolUse** は登録しない（schema v4 で廃止）。Codex PostToolUse は別用途で、tool loop 中の rollout capture / monitor state write hook として登録する。current-session refresh instruction は注入しない。
- **PreCompact** は使っていない（自動コンパクト依存の設計を放棄したため）
- dev 時に spike 系 hook（`spike/hook-logger.mjs` 等）が並行登録されている場合があるが、動作ログ採取用で実害なし

---

## SQLite スキーマ (v9)

`~/.throughline/throughline.db`（WAL モード）。schema migration の定義は [src/db.mjs](src/db.mjs) にあるので **スキーマを知りたい時は必ずそこを見る**。

主要テーブル:

- `sessions` — `session_id`, `project_path`, `status`, `created_at`, `updated_at`, `merged_into`
- `skeletons` (L1) — `session_id`, `origin_session_id`, `turn_number`, `role`, `summary`, `created_at`
- `bodies` (L2) — `session_id`, `origin_session_id`, `turn_number`, `role`, `text`, `token_count`, `created_at`
- `details` (L3) — `session_id`, `origin_session_id`, `turn_number`, `tool_name`, `input_text`, `output_text`, `token_count`, `created_at`, `kind`, `source_id`
  - `kind`: `'tool_input' | 'tool_output' | 'system' | 'image' | 'thinking'`
  - `source_id`: `tool_use.id` / `attachment.uuid` / `${entry_uuid}:thinking:${idx}` 等の一意キー。`INSERT OR IGNORE` の冪等性を保証
- `handoff_batons` (v8) — `project_path (PK)`, `session_id`, `created_at` — 現行利用面では`/tl`で書き込み、newbornセッションの初回UserPromptSubmitが「誕生時刻基準TTL 1h以内」なら消費してmerge。`/clear`互換分岐は現行クライアントから到達しない。memo_text列はv8でdrop (memo廃止)
- `pending_handoffs` (v9) — `session_id (PK)`, `project_path`, `source`, `auto_predecessor_id`, `created_at` — 二相ハンドオフの intent。SessionStart が登録し、初回 UserPromptSubmit が 1 回だけ消費。幽霊セッションの行は consume されず無害に残る (ADR 0014)
- `injection_log` — 監査用（未活用）

`judgments` テーブルは v4 で DROP 済み。`classifier.mjs` による抽出は精度が低く廃止。

---

## 開発コマンド

```bash
# hooks セットアップ（このリポジトリだけに限定）
node bin/throughline.mjs install --project

# hooks 削除
node bin/throughline.mjs uninstall --project

# テスト
npm test

# モニター（別ターミナルで常駐、VSCode タスクが自動起動するので通常は手動不要）
node src/token-monitor.mjs

# 特定セッションの診断（モニターが止まって見える時の切り分け）
node bin/throughline.mjs doctor --session <id-prefix>

# DB 統計
node bin/throughline.mjs status

# Codex-facing handoff JSON preview
node bin/throughline.mjs handoff-preview --session <id>

# Portable cross-harness handoff context (read-only, ownership unchanged)
node bin/throughline.mjs handoff-context --session <id> --json [--supplement-file <path>]
node bin/throughline.mjs handoff-context --project <path> --json --disclosure silent
node bin/throughline.mjs grok-continue --session grok:<id>

# Codex primary active-work context
node bin/throughline.mjs codex-summarize --session codex:<thread-id> --json
node bin/throughline.mjs codex-resume --session codex:<thread-id>
node bin/throughline.mjs codex-resume --session codex:<thread-id> --format handoff
node bin/throughline.mjs codex-handoff-start --session codex:<thread-id>
node bin/throughline.mjs codex-handoff-smoke --session codex:<thread-id> --json
node bin/throughline.mjs codex-handoff-model-smoke --session codex:<thread-id> --dry-run --json
THROUGHLINE_EXPERIMENTAL_CODEX_HANDOFF_MODEL_SMOKE=1 \
  node bin/throughline.mjs codex-handoff-model-smoke --session codex:<thread-id> --json
node bin/throughline.mjs codex-resume --session codex:<thread-id> --format item-json
printf '**Next move**: continue the Codex implementation\n' \
  | node bin/throughline.mjs codex-resume --session codex:<thread-id> --memo-stdin

# Experimental Codex model-visible smoke (starts a model turn)
printf '**Next move**: continue the Codex implementation\n' \
  | THROUGHLINE_EXPERIMENTAL_CODEX_MODEL_VISIBLE_SMOKE=1 \
      node bin/throughline.mjs codex-visibility-smoke --session codex:<thread-id> --memo-stdin \
        --request-timeout-ms 150000 --timeout-ms 180000 --json

# Codex sidecar diagnostics (configured 以外は exit 1)
node bin/throughline.mjs codex-sidecar-diagnostics --project .

# Codex sidecar dry-run (review / risk-check request shape)
node bin/throughline.mjs codex-sidecar-dry-run --project . --preset risk-check --context-file docs/throughline-handoff-context.example.json

# Trim dry-run / guarded Codex execute surface
printf '**次の一手**: ...\n' | node bin/throughline.mjs trim --dry-run --host claude --memo-stdin --json

# Trim host boundary diagnosis
node bin/throughline.mjs doctor --trim --host claude

# DB を直接覗く
node --input-type=module <<'EOF'
import { getDb } from './src/db.mjs';
const db = getDb();
console.log(db.prepare('SELECT * FROM sessions ORDER BY updated_at DESC LIMIT 5').all());
EOF
```

---

## 技術スタック

- **ランタイム**: Node.js v22.13+、ESM（`.mjs` 統一。`node:sqlite` の flag 不要化以降）
- **データベース**: `node:sqlite`（Node.js 組み込み、同期 API）
- **外部依存**: なし
- **対応プラットフォーム**: Windows、Linux、macOS
- **L1 要約 backend**: 既定は Codex CLI `gpt-5.6-luna`@`low`（Codex 契約の認証、ADR 0015）。sidecar configured 時はそちら優先、両方不在時の fallback が `claude -p --model claude-haiku-4-5-20251001`（Claude Max 契約の認証を使う、API キー不要）

---

## 作業上の規律

- **設計書と実装が食い違っていたら、どちらかが古い**。まずソースを確認する。ソースが正。設計書を更新する
- **進捗を docs に残す**。計画書のチェックボックスと AGENTS.md のステータス行を同時に更新する。README には実装済み behavior だけを載せる
- **新しい .md ファイルを作る前に、既存ファイルに追記できないか考える**。docs フォルダが肥大化する原因はほぼこれ
- **完了した計画・置換済み設計は `docs/archive/` に物理移動**。現行 docs と歴史記述を同じ階層に混在させず、archiveを必読経路へ置かない
- **同じ意味の現行契約は既存の現行文書へ統合**し、文書の分類と寿命は [docs/00_overview.md](docs/00_overview.md) を正とする
- テストは本ファイルの開発コマンドを基準に、変更範囲に応じて追加する。
- 製品所有CIは変更した実装の依存関係から必要なテストだけを3環境へ配り、依存を確定できない変更とrelease変更だけ`npm test`全件へ広げる。

## 製品の所有境界

正規入口は本repositoryの README、CLI、source、release手順である。
外部連携は公開CLI・JSON契約だけを使い、SQLiteを直接操作しない。

Grok は first-class host である。capture は `chat_history.jsonl`、hook は
`~/.grok/hooks/throughline.json` の絶対パス。Grok `/tl` の記憶再開は
`throughline grok-continue --session grok:<id>` だけとする。stdout 再注入、
aiterm、`--rules`、`--from` を現行契約に戻さない。

Cursor は first-class host である。capture は `agent-transcripts` jsonl、hook は
`~/.cursor/hooks.json` への upsert（工場 hook は残す）。絶対 `node` +
`bin/throughline.mjs`。引き継ぎ注入は sessionStart の `additional_context`。
`/tl` 後継の自動起動はしない。

## Claude 契約を守る

- `.claude/`、Claude hooks、`/tl`、`/sc-detail`、Claude transcript parsing、Claude handoff / resume behavior は first-class のまま維持する。
- Codex 対応のために Claude-facing field、command name、hook shape、session / baton semantics を rename しない。
- 既存 Claude path を削除、劣化、Codex path への暗黙置換をしない。
- Codex 向け表現が必要な場合は、既存データを変更するのではなく adapter / projection を追加する。
- Claude contract に触れる変更では、先に現在挙動を固定する test / fixture を置く。

## Codex 作業方針

Codex は、このプロジェクトでは Claude の代替ではなく、追加の作業者または adapter 対象として扱う。

- agent-neutral core を増やす場合も、Claude adapter を既存互換のまま残す。
- Codex support は `throughline_handoff` context block、Codex primary entrypoint、Codex CLI backend、`codex-sidecar` integration として追加する。
- Codex-on-Codex の再帰委譲は、isolated worktree、structured result capture、明示的な review / critic role など別境界がある場合だけ許可する。
- `codex-sidecar` が未設定または diagnostics 失敗の環境を、成功扱いにしない。失敗は明示し、既存 Claude behavior を baseline として維持する。

## Read-only handoff context

`throughline handoff-context --session <id> --json` は、同一端末内のlauncherが既存sessionの
継承文脈を取得するためのread-only境界である。通常handoffのようにbatonを消費したり、memory rowの
`session_id`や`sessions.merged_into`を変更したりしない。consumerはSQLiteを直接読まず、このCLIの
versioned JSONだけを使う。Observer向け`observer-read`／`observer-wait`はcompleted-turn projectionで
目的が異なるため、portable forkの代替にしない。

## 2 つの計画の扱い

[docs/08_codex_dual_support.md](docs/08_codex_dual_support.md) と [docs/09_rollback_context_trim_insight.md](docs/09_rollback_context_trim_insight.md) は趣旨が異なるが、矛盾するものではない。

現時点の実装順は [docs/05_codex_first_roadmap.md](docs/05_codex_first_roadmap.md) と
[docs/06_codex_trim_rollback_fix_plan.md](docs/06_codex_trim_rollback_fix_plan.md) を正とする。

2026-05-07 correction: 2026-05-06 時点では 1 と 2 を完了扱いしていたが、
VS Code restart / reconnect 後に rollback 済み user prompt が復活した incident 後、
2 は restart-safe 完了ではない。Codex primary の capture / summarize / resume は
完了扱いできるが、Codex trim execute / auto-refresh は durable restore safety が
未証明である。

1. Throughline を Codex primary で使えるようにする。Codex primary の L2 -> L1 backend は Codex CLI を本線にする。
2. Codex で Claude Rewind 相当の context trim を完成させる。
3. そのあと Claude 側の `/rewind` UX / 自動化 surface を詰める。

新セッションで迷った場合は、まず [docs/05_codex_first_roadmap.md](docs/05_codex_first_roadmap.md) の「新セッション引き継ぎ」と
[docs/06_codex_trim_rollback_fix_plan.md](docs/06_codex_trim_rollback_fix_plan.md) を読む。
Codex 側をやり直さず、現行状態から継続する。2026-05-08 時点では Codex
current-thread trim は `trim --execute --host codex --all` で guarded rollback +
Throughline DB developer-memory inject を送れる。必須条件は Codex thread identity、
Throughline DB injectable memory であり、rollout/app-server turn-count mismatch は
diagnostic と app-server count 由来の rollback `numTurns` 補正に使う。
`restoreSafety.status = risk`、planned restore-safety risk、host primitive audit は
diagnostic-only として扱う。developer memory inject は item-level で、現行 Codex
host では即時 `thread/read` の turn count を増やさない場合がある。durable success は
rollout 上の新 rollback event と injected active-work memory evidence で判定する。
Claude 側 `/rewind` UX / 自動化 surface は次段階で、Codex current-thread trim を
新規 thread handoff に置き換えない。

[docs/archive/07_codex_trim_implementation_plan.md](docs/archive/07_codex_trim_implementation_plan.md) は旧統合計画と実装履歴として、必要なときだけ参照する。

作業量や複雑さを理由に理想を下げない。ただし、未検証の host behavior を確定仕様として実装しない。
