# Throughline 機能図とsource対応

状態: 現行図/source調査を受けたAstra責務設計。調査固定候補 `747560bf1354c8b5991b69984636ffa9359172d8`、base `39ff812d46c0e84e8fc1418096c509551cf3928b`。以下の現行図と末尾の未実装設計を区別する。構造実装・全consumer閉包・Astra最終整合は未完。

- [未読台帳](unread-ledger.md): baseのtracked全417file。source126/test99/documentation141/config-support51を機械分類した。fixture4件と機械分類config-support内の現役script/設定14件は本文確認。残る意味分類と適用性は台帳へ分ける。
- [bytes/SHAと宣言候補](file-inventory.json): 宣言行の文字列索引は部分的な手掛かりで、実関数や全callerの網羅を保証しない。全fileのsemanticMappingCompleteはfalse。
- [今回読んだ入口と記録・引継ぎの現行図](current-entrypoints.md): CLI/SessionStart/DB、初回handoff、Stopの保存/receipt/L1/L3、Codex専用capture/hookの3追加詳細図と実file/関数対応。未読callee/caller/testを明記する。新4図は実描画/目視済み、Astra確認は未了。
- [自動継続・旧会話入力・OS起動](current-continuation.md): Claudeのrecord/accepted/inboxとCodexの停止準備/不変snapshot/mutation stage/公開配送APIを、成功/確定失敗/unknown/cleanupへ結ぶ。Grok手動継続とOS共通部品も対応付ける。新3図は実描画/目視済み、全consumer閉包は未完。
- [文脈復元・observer・外部文脈](current-projections.md): 予算付きpush/pull、固定page/cursorと本文freshness、wait取消、auditor/caveat/roomをsourceへ結ぶ。observer現行図だけは既描画原稿/SVGを再利用し、復元/room新2図も実描画/目視済み、全consumer閉包は未完。
- [手動継続・trim・app-server診断](current-manual-continuation.md): 新threadへの記憶注入とモデル開始、同threadのrollback/injectとdurable診断、通信中断/cleanupを区別する。自動継続の永続状態と異なる責任なので別詳細とし、既存図の内部を複製しない。実描画/目視済み、全consumer閉包未了。
- [導入・監視・診断・更新・報告](current-lifecycle.md): 製品設定/信用と外部適用、複数fileの部分確定、readinessと実動作、送信受付/ack/解決を4現行図と実関数へ結ぶ。既存詳細と所有が異なる製品寿命/運用入口を一か所に置く。実描画/目視済み、全consumer閉包未了。
- 既存設計の索引は[docs/00_overview.md](../00_overview.md)、記録/復元の既存図は[README](../../README.md#three-layer-memory-model)、Codex継続は[docs/05](../05_codex_first_roadmap.md)。有効な図を作り直さず、対応を確認して再利用する。

## 全体で埋める機能

導入/host登録、4host記録、DB/schema/競合、記憶/要約/再注入、Claude継続、Codex継続/trim、Grok/Cursor継続、usage/monitor、observer、外部文脈projection、診断/更新/エラー報告を調べる。これは調査順序であり、責務分割の確定案ではない。
各機能は実file/関数・状態/所有・caller・test/fixture/config/export・正常/失敗/停止/取消/不明/cleanupまで結ぶ。部分図の完成を全体完成へ補完しない。

## 現行の全体接続

```mermaid
flowchart TB
  External["4hostのhook / 利用者 / 外部consumer"] --> CLI["bin: 引数dispatch / host payload入口"]
  CLI --> Install["導入・解除 / 製品hookとskillの配置"]
  CLI --> Capture["Claude互換Stop / Codex専用capture"]
  CLI --> First["SessionStart intent / 初回promptでhandoff"]
  CLI --> Auto["Claude・Codex自動継続 / 旧入力配送"]
  CLI --> Manual["手動新thread / 明示trim / 診断smoke"]
  CLI --> Projection["復元 / recall・detail / 公開context・observer"]
  CLI --> Ops["monitor / doctor / factory診断 / migrate・self-update"]
  Transcript[("外部所有transcript / Codex rollout")] --> Capture
  Transcript --> Auto
  Transcript --> Projection
  Capture --> DB[("製品DB: L1・L2・L3 / session・snapshot・room・pending・baton")]
  Capture --> Summary["L1 backend / L3分類"]
  Summary --> DB
  Capture --> Receipt[("製品receipt / monitor state / 固定error")]
  First --> DB
  First --> Local[("Claude auto record・inbox / 製品設定")]
  Auto --> Local
  Auto --> DB
  DB --> Auto
  DB --> Projection
  Projection -->|roomのみ保存| DB
  Receipt --> Projection
  DB --> Manual
  Ops --> DB
  Ops --> Local
  Receipt --> Ops
  Install --> Config["各hostの設定 / 製品配置物 / monitor task"]
  Auto --> Native["公開native配送API / 製品OS helper"]
  Manual --> Native
  First --> Adapter["host adapterの注入返却"]
  Projection --> Result["公開JSON・text / cursor・pending / 呼出元へ"]
  Native --> Host["外部host: 実停止・入力採用・モデル実行・画面"]
  Adapter --> Host
  Config -.-> Host
  Capture --> Error["固定code観測 / private error store"]
  Auto --> Error
  Error --> Report["明示有効時だけ署名report / verified受付後ack"]
  Report --> Receiver["外部中央受け口 / 処置は別所有"]
  Result -.-> Consumer["consumerの消費保存 / 表示・業務完了は別所有"]
```

現行sourceを辿る概略で、新しいmodule分割案ではない。実描画/目視は済み、全接続照合とAstra最終整合は未完。線は複数fileを一括commitする意味ではなく、破線は外部適用/consumerの証明範囲を分ける。Codex自動継続の台帳はDB、Claude record/inboxはprivate fileという違いを詳細へ残す。receipt・monitor state・固定errorは別の保存先で、図の一ノードへの併記を同じstateの所有/確定境界とは扱わない。
記録/初回は[current-entrypoints](current-entrypoints.md)、自動継続/OSは[current-continuation](current-continuation.md)、投影は[current-projections](current-projections.md)、手動nativeは[current-manual-continuation](current-manual-continuation.md)、導入/運用と個別storeは[current-lifecycle](current-lifecycle.md)を詳細正本とする。実関数と失敗/取消/unknown/cleanupは各表を辿り、欠けるものは未読台帳と次の意味調査に残す。

## 保持する外部契約

CLI名/引数/JSON schema/exit/stdout/stderr、ClaudeとCodex/Grok/Cursorのhost別hook形、記憶/receipt/cursor/baton/後継と設定信用、保存/移行とreport/ackの意味を保つ。既読だけで保持済みとはせず、全callerと関連試験へ結ぶ。
observer新batch APIはこの候補の構造整理に含めない。実DB/稼働会話/他製品/OSを変更せず、公開・配布・本番反映は既条件に従う。

## 次工程

適用済みAstra xhighで以下の責務設計を行った。次はSol Highの適用後、採用した変更のcaller/test/fixture/config/exportを閉じて段階実装する。未調査213fileの全読了は開始条件にしない。全体の説明不足は末尾の残確認を埋め、実装/関連検証後にAstraの最終整合を行う。

機械分類source126file（fixture4を含む）の本文確認は済んだ。これは全機能の意味調査・全caller/test/fixture/config/exportの照合完了ではない。次は未読の関連試験・設定/配布入口・現行正本と外部consumerを調べ、図から実関数/状態/返却までの不足を埋める。

host adapter/identity・記録側helperは[入口詳細](current-entrypoints.md#host-adapterと記録側helperの対応追補)、本文digest/L3参照は[投影詳細](current-projections.md)、path比較とClaude保持試験は[継続詳細](current-continuation.md#自動継続の保持根拠と未検証境界)、usage/推定/要約復帰は[運用詳細](current-lifecycle.md#既存の観測表示helperの所有)へ追補した。機械source126pathは5詳細内の直接参照へ接続したが、pathの出現検査は全関数・動的caller・外部consumerの意味確認を保証しない。全semanticMapping/consumer閉包は未完。

最初のsource調査追補時点は本文58file（機械役割source47/test9/doc1/config1）、同blob参照1、未読358。以降の現在値は未読台帳を正本とする。source分類のうち現在4件は本文からfixtureと確認した。全fileの依存/consumer閉包は未了。各source調査ではbase417fileのSHA不変を確認した。今回の設計ではAGENTSに図/設計入口と未完状態を追補し、他416fileとruntime/設定は不変。関連testは本文読取だけで未実行。

## 描画と目視の固定対応

新17図は既導入Mermaid CLI 12.0.0でSVG/PNGへ描画し、PNGを個別表示してラベル・分岐・矢印を確認した。既observer1図は固定原稿/SVGを再利用し再描画していない。全体図は接続の交差が多いため機能詳細への索引として使い、単独で意味整合を証明しない。原稿は本Markdownのblockを正本とし、編集用の別原稿を二重管理しない。[描画manifest](render-manifest.json)にblockのSHA、SVG/PNGのSHA/bytes、確認状態を残す。

| 原稿 | block順のSVG | 状態 |
| --- | --- | --- |
| [README](README.md) | [1](diagrams/readme-01.svg) | 描画/目視済み |
| [current-continuation](current-continuation.md) | [1](diagrams/current-continuation-01.svg) / [2](diagrams/current-continuation-02.svg) / [3](diagrams/current-continuation-03.svg) | 描画/目視済み |
| [current-entrypoints](current-entrypoints.md) | [1](diagrams/current-entrypoints-01.svg) / [2](diagrams/current-entrypoints-02.svg) / [3](diagrams/current-entrypoints-03.svg) / [4](diagrams/current-entrypoints-04.svg) | 描画/目視済み |
| [current-lifecycle](current-lifecycle.md) | [1](diagrams/current-lifecycle-01.svg) / [2](diagrams/current-lifecycle-02.svg) / [3](diagrams/current-lifecycle-03.svg) / [4](diagrams/current-lifecycle-04.svg) | 描画/目視済み |
| [current-manual-continuation](current-manual-continuation.md) | [1](diagrams/current-manual-continuation-01.svg) / [2](diagrams/current-manual-continuation-02.svg) / [3](diagrams/current-manual-continuation-03.svg) | 描画/目視済み |
| [current-projections](current-projections.md) | [1](diagrams/current-projections-01.svg) / [2](diagrams/observer-current.svg) / [3](diagrams/current-projections-03.svg) | observer既確認再利用を含む |

初稿の復元図だけ、detailとrecallの結線を実関数に合わせて訂正し、その1図を再描画/目視した。変更理由は詳細本文とmanifestへ残す。他のblockの意味変更は無し。図の可読性確認は全caller/test/fixture/config/exportの閉包・実host受入・責務整理の採否・Astra最終整合ではない。

## 責務設計と採否（2026-11-03、Astra xhigh）

この節は実装前の設計である。get_selfでAstra xhigh/fast OFFの適用受理を確認してから、固定候補の全体/5詳細、既読source・関数・保持試験の対応を評価した。本文確認203file/同blob1/未読213と全semanticMapping未完は変えない。機械source126pathの出現、描画済み、設計の採用は、全関数/動的caller/実consumerの照合や最終受入の証拠ではない。

5詳細の「採否未定」「次工程で調べる」はsource読取時点の記録である。現在の採否と順序はこの節を正本とし、実装済みの接続は各現行図へ戻す。未読/未検証の状態は設計の採用だけでは進めない。

### 対象全体の所有と構造判断

| 機能・図の正本 | 維持する責任/接続 | 今回の構造判断と理由 |
| --- | --- | --- |
| CLI dispatch・hook入口 → [入口](current-entrypoints.md) | binは引数/公開名/入口例外、各runはstdin/host返却、固定errorとprivate logは別 | 変更不要。入口と実処理の既分離を使う。hookごとにexit2/deny/continue/skipが異なり、共通catch/汎用runへまとめない。hook統合試験の未読は残す |
| DB/schema・merge・pending/baton → [入口](current-entrypoints.md) | getDb/openReadOnlyDbが接続、各writerがtransaction/保持を所有 | 変更不要。migrationやmergeの一括確定とpending/batonの個別確定を「unit of work」へ包み直すと失敗時契約が変わる。schema/保存path/保持期限は変更しない |
| 4hostの記録・L2/L3・receipt・L1 → [入口](current-entrypoints.md) | host adapter/identity、transcript reader/backfill、Codex capture、receipt、既summarizerがそれぞれの規則を所有 | 変更不要。Claude append/Grok書換世代/Codex rollback後置換は別契約。汎用parserや共通completionを作らず、既body-digest/turn-start/L3 helperを使う。全parser fixture閉包は未完 |
| 初回handoff・prompt実験 → [入口](current-entrypoints.md) | executorがpending→選択→merge→accepted→backfill→context、promptはhost配送/forward/slashを調停 | 本体分割は見送る。既executor/adapterに作用が分かれ、runは順序の所有者として残す。spikeはmarker限定の既helper境界があり、移動だけでは順序・保持の曖昧さを解かない。削除/本線化/有効化をせず、実験の作用を索引に残す |
| Claude auto・forward → [継続](current-continuation.md) | private record/accepted/claim/inboxとOS terminalが別所有。workerは作用順を調停 | 変更不要。大きさだけでrecord/worker/後継照合を再分割するとlate write・受領優先・再送禁止の相関が隠れる。既config/forward/terminal分離を維持し、同じ状態へ触る処理は現在の所有者に残す |
| Codex auto → [継続](current-continuation.md) | storeのCAS/snapshot、memoryの描画/要約、host観測、公開配送、orchestrator | 変更不要。既store/memory/host/runtime分離を再利用する。sourceStopGate/実停止/mutation_stage/continuedと後続goal/queueは別確定。Claudeと共有state machineへまとめない |
| 文脈/pull/public projection → [投影](current-projections.md) | HandoffRecordは中間表現、各rendererが予算/表現、公開CLIがDB接続/JSON/exit | 変更不要。9500字push、短い手動引継ぎ、auto全文、observer完了投影を共通formatterへ統一しない。read-onlyへの一括変更もCLI接続作用を変えるため不採用 |
| observer・auditor・caveat・room → [投影](current-projections.md) | 完了根拠、本文freshness、consumer消費位置、room書込は別所有 | 変更不要。共有済みpair照合/digestを使い、room writerをread-only群へ入れない。batch/token/daemon/poolは別工程。確認だけでconsumer cursorを進めない |
| 手動new-thread・trim・診断smoke → [手動](current-manual-continuation.md) | app-serverがtransport/要求相関、明示操作がnative順序、CLIがopt-inと表示 | 変更不要。autoの永続台帳を手動経路へ足すことは機能/保持変更。close/timeoutをremote rollbackと解釈せず、既guardとunknown限界を記す。旧停止中の実験を再開しない |
| hook導入/解除・信用検査 → [運用](current-lifecycle.md#採用設計-hook命令とcodex診断の所有を分ける未実装) | installは設定書込と配布、host hook命令は形/実体照合、診断は既設定の観測、doctorは表示、factoryは公開投影 | **構造変更を採用**。factory→doctor._internalと診断→installer本体への迂回を除き、命令の既処理とCodex検査を各専用moduleへ移す。旧exportは互換参照として保持。詳しい境界/代替案/図は運用詳細へ一度だけ置く |
| monitor・VSCode task → [運用](current-lifecycle.md) | state/live usage合成、表示cache/端末寿命、task配置は既別helper | 変更不要。現在の表示helperを別fileへ移すだけではsingle mainのcache/信号寿命が明瞭にならない。既terminal-size/usage/taskを再利用し、main/signalの未coverageを明記する |
| OS/起動・自己更新 → [継続](current-continuation.md)・[運用](current-lifecycle.md) | os配下のquote/PTY/ACL/runtime/package journal、self-updateの順序 | 変更不要。既共通所有者を使う。Windows昇格rollbackと後段install/migrateを同一transactionにしない。新OS/Host責任を増やさない |
| runtime error・送信・回復 → [運用](current-lifecycle.md) | store/context/observer、report/trigger、中央の受付/処置は別所有 | 変更不要。JSON置換とlock、ackとresolve、報告の再送とnative unknownの禁止を分けたままにする。既定OFF/署名/許可field/expectedCursorを保持 |
| config/temp/path helper → 各詳細 | host別configのschemaと既定、各writerのACL/lock/cleanup、project比較の意味を各所有者が持つ | 統合しない。似たtemp→renameでも権限・失敗・CAS・掃除・直書きが異なる。sameProjectPath/子孫/SQL lower、shell quoteの変更を「整理」として混ぜない。既共通helperで同契約を扱っている箇所は維持 |
| 配布文書・CI・旧保守script → [運用](current-lifecycle.md) | 現行説明はREADME/現行docs/配布skill、版履歴はADR/archive、選択試験/releaseは製品CI | **確定した説明差分の訂正を採用**。runtimeを古い説明へ戻さない。旧installer/one-offは現役公開入口でないことを明記し、利用履歴未確認の削除/移動はしない。既CIを作り直さない |

変更しない判断は、対象の全試験合格や全private関数の意味確認を表さない。現在の責任分離で目的を満たせる理由を示したもので、後段で図の説明が足りないと分かればその範囲を埋める。何も変えないために未調査を隠すことも、全fileを形式的に分割することもしない。

### 段階と検証の受け渡し

| 段階 | 実施内容・完了条件 | モデル/残確認 |
| --- | --- | --- |
| S1 共有hook命令/診断 | 運用詳細の採用案について全caller/再export/test/fixture/config/packを確認し、既処理を移動。doctor/factory/installの観測と返却が不変、旧import面が保持され、下位moduleからCLIへの依存が無いことを確認 | 次ターン以降Sol High。対象以外の大規模test読了を開始条件にしない。必要な仮home/DB/process fixtureだけを実行し、実Host設定/CLIは操作しない |
| S2 現行説明の同期 | tl/skillの注入量、docs02の確定順、docs04の診断作用、README両言語のdependency/backend/reportを実関数と既試験へ照合して訂正。AGENTS内の同じ旧説明も同期し、過去ADRは置換関係を残す | Sol。READMEのThinking/detailは未確定項目として先に関連test/表示枝を確認する。機能追加や表示枝修理を説明訂正へ紛れ込ませない。確認できない約束を達成済みと記さない |
| S3 全体対応の不足を閉じる | 全体/5詳細→実関数/状態/失敗返却→代表caller/保持根拠を再照合。特にCodex auto/hook/復元/外部consumer、import時作用/直接実行/取消とcleanupの未説明を埋める。対象外資料は理由を残す | Solの実source調査。必要な関数/試験を読み、宣言文字列だけで完了しない。既共有部品の再分割や全99test/未読213件の一律読了を関所にしない |
| S4 関連検証と図の同期 | 採用差分に対応するfocused testsと既product-ci-planの選択/拡張理由を保存、verify:docsとpackリンクを確認。現在図を実装に合わせ、意味の変わったblockだけ描画/PNG目視/hash/XMLを更新 | Sol。既CIが広い確認を選ぶ場合は既ルールとして扱う。既18図の無変更反復なし。試験skip/未実行/OS未確認を分ける |
| S5 最終整合/固定返却 | 完成候補全体の図・責任・接続・関数・保持・検証をAstraで照合。未確認/既知制限と本番未反映を含めレヴィアタンへ固定成果を返す | Astra xhighの正規変更/次ターン適用後。今回の設計確認を最終整合へ代用しない。公開/本番は既手順、batchはさらに別工程 |

S1/S2の変更前確認は既Owner手順であり、新しい人の承認関所ではない。設計で指名した責任を動かす必要が生じた時だけ採否を見直す。構造整理の実装は、その完成後に行うS5を先行条件にして止めない。

### 残る意味確認と保持の境界

- Codex auto本体/hook統合、resume/context、backfill/各parser等の大規模testは未読が残る。変更が届く試験は実装前に読む。変更不要領域も全体説明の根拠が足りない箇所をS3で補い、未読数やpath出現だけでsemanticMappingCompleteを立てない。
- BellTeamのhandoff-context/observer/roomの公開consumer、Spotter/Caveat、配送APIの外部内部は別所有。公開JSON/exit/入力制限/消費cursorの境界を既callerへ照合する。旧deep import/exportは候補内参照と既知consumerを検索し、到達できない利用は未確認とする。他席checkoutを変更しない。
- 取消APIの無い同期処理は「不適用」、強制終了/通信喪失は段階ごとの既確定とunknownを記す。accepted/captured/queued/continued/ready/updated/ackを一つのdoneへ変換しない。
- sc-detailのThinking表示、doctorのNode最低版表示、旧installer呼出、temp残存/一部writerのCAS無し、monitor signal寿命などは既知の未照合又は制限。今回の二つの構造境界の整理で自動解決したことにしない。
