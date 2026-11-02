# 導入・監視・診断・更新・エラー報告の現行source対応

基準 `39ff812d46c0e84e8fc1418096c509551cf3928b`。[全体索引](README.md)→本詳細→実file/関数へ辿る。sourceの読取から得た現行図であり、責務整理案の採否・実装・実Host受入ではない。新4図は未描画。ここまでで機械分類source126fileの本文を確認したが、fixture4を含む数であり、全test/config/export/consumerの照合は未完。

## 導入・解除と設定信用

```mermaid
flowchart TD
  CLI[install又はuninstall / project指定] --> Claude[Claude settings読取 / 製品hookを追加又は除去]
  Claude --> Write[settingsを書込]
  Write --> Scope{project指定か}
  Scope -->|global installだけ| Auto[Claude auto設定に合わせhookを維持又は除去]
  Scope -->|project| Commands[製品slash commandをcopy又は削除]
  Auto --> Commands
  Commands --> Global{globalか}
  Global -->|yes| Codex[Codex hooksとfeature設定]
  Codex --> Grok[Grokの製品専用hook file]
  Grok --> Cursor[Cursor hooksを製品entryだけupsert又は除去]
  Cursor --> Skill[Codexの製品skillをcopy又は削除]
  Skill --> Task[install時だけVSCode monitor taskを必要時追加]
  Global -->|project install| Task
  Global -->|project uninstall| Output[結果をCLIへ返す]
  Task --> Output
  Write -->|後段失敗| Partial[先行fileは更新済み / 一括rollbackなし]
  Codex -->|後段失敗| Partial
  Output -.-> Host[hostがhookを信用しロードする / UI表示は別確認]
```

図はfileごとの作用を表し、すべての書込がatomic又は一transactionではない。実コードのglobal順序はClaude settings/auto→commands→Codex hooks/config→Grok→Cursor→Codex skill→monitor taskである。uninstallはmonitor taskや記憶DBを消す処理ではない。製品が登録を書いたことと、hostが信用したこと・次の会話へ適用したことを区別する。

| 実file/関数 | 入力・所有・作用/返却 | 保持/失敗/未確認 |
| --- | --- | --- |
| [cli/install](../../src/cli/install.mjs):run/resolveSettingsPath/readSettings/writeSettings/installSlashCommands/uninstallSlashCommands/installCodexSkills/uninstallCodexSkills | project指定はClaudeだけ、globalは4hostと製品skill。既存settingsへ製品hookを追加し、配布内の固定2command/1skillを配置する | 複数fileの途中失敗は先行作用を戻さない。skillは既destを削除後copy。公開cancel無し、強制終了時に残る状態を成功へ補完しない |
| 同:resolveCodexHookNodePath/buildCodexHookCommand/parseCodexHookCommand/isEquivalentCodexHookCommand/registeredCodexHookCommand | 同じ実node/scriptをrealpathで照合。既登録が同実体なら命令文字列を保持し信用を不要に失効させない | Windowsの`&`、space/quote、PATHと実体の違いを保持。信用DB自体を書換える経路ではない |
| 同:createCodexHooks/installCodexHooks/ensureCodexHooksFeature/uninstallCodexHooks | 自製hookだけを置換/除去し他hookを保持、hooks featureを有効化し旧codex_hooks行を除く。Stop300秒、prompt/tool30秒、PreCompact30秒 | config/settingsは直接書込。uninstallはfeature全体を無効化しない。全fixtureの確認前に登録順を変えない |
| 同:installClaudeAutoHandoffHooks/removeClaudeAutoHandoffHooks/claudeAutoHandoffHooksRegistered/installCodexAutoHandoffHook | auto enable/disableから使うexport。Claudeは使用端末だけhook、既形は並び維持。Codexはauto PreCompact登録とfeatureを設定 | [自動継続](current-continuation.md)へ接続。登録・信用・enabled保存の確定位置は別。一般installと自動有効化を同一作用へまとめない |
| 同:createGrokHooksFile/installGrokHooks/uninstallGrokHooks/createCursorHookEntries/installCursorHooks/uninstallCursorHooks | Grokは製品専用fileを生成/削除。Cursorは共存fileから製品entryだけ置換/除去 | Grok専用fileとCursor共存fileの保持契約は異なる。Claude uninstallは製品commandを含むgroup単位で除去する現実装で、Codex/Cursorのentry単位と同じとは記述しない。混在fixtureは未照合 |
| [vscode-task](../../src/vscode-task.mjs):ensureMonitorTaskFile/detectJsoncFeatures/findMonitorTaskIndex/isMonitorTaskBroken/buildMonitorTask/atomicWrite | VSCode検知・opt-out・cwd/bin確認後、taskを新規/merge又は壊れた絶対pathだけrepair。user label/presentationを保持、JSONCには案内だけ | temp→renameはtask1fileの置換。temp失敗後の掃除はこのhelperに無い。案内markerとtaskは一括確定ではない。通知を抑止しても既markerを記録する枝を保持 |

hook側SessionStart/prompt-submitからのtask provisionも同じhelperへ接続する。実際のmonitor起動はVSCodeのfolderOpen/利用者操作が所有し、設定を書いた返却だけでは起動を確認できない。shell/commandの既OS部品を新しく作り直さない。

## 自己更新・移行・readiness

```mermaid
flowchart TD
  Update[self-update argv] --> OS{OS}
  OS -->|Windows| Pre[global rootと現CLI identityを照合 / npm版取得]
  Pre --> Stage[既Windows package updater / journalでfile昇格]
  OS -->|Linux又はmacOS| Npm[npm global latest更新]
  Stage --> Identity[更新後global root / 版 / 公開CLI identityを照合]
  Npm --> Identity
  Identity --> New[新しいCLIをpost-install phaseで呼出]
  New --> Verify[registryの現在版と新CLI版を照合]
  Verify --> Install[installによるhost接続更新]
  Install --> Migrate[migrate公開JSON / 製品DB transaction]
  Migrate --> Diagnose[factory-diagnostics公開JSON]
  Diagnose --> Accept[各schema / 版 / 状態を検証してupdated又はalready-current]
  Identity -->|失敗| Failed[固定stageとnonzero / 先行更新を成功扱いしない]
  Install -->|失敗| Failed
  Migrate -->|失敗| Failed
  Diagnose -->|失敗| Failed
  Accept -.-> Runtime[実harness稼働 / 本人会話 / 本番受入は別確認]
```

Windowsのpackage昇格中のjournal/rollbackは既[OS詳細](current-continuation.md)の範囲で、後続install/DB migration/diagnosticの全体を巻き戻す保証へ広げない。Unix npm更新後の検証失敗でも自動downgradeはしない。図の処理を今回実行する指示にはしない。

| 実file/関数 | 責任と返却 | 保持/未確認 |
| --- | --- | --- |
| [cli/self-update](../../src/cli/self-update.mjs):run/finishUpdate/buildSelfUpdateIdentity/validateSelfUpdateIdentity/resolveGlobalCliPath | 更新前後のpackage/公開入口実体を照合し、新CLIにinstall→migrate→診断を委譲。envのphase/expected/beforeで新旧の役割を固定 | PATHの別prefixや旧help exit0を成功にしない。Windowsは既package updater、Unixはnpm。公開AbortSignal無し。同期外部commandの総期限保証を供給済みとしない |
| 同:validateMigrationResult/validatePostUpdateDiagnostics/validatePostInstallResult/emitFailure | schema/版/状態と子結果の形を検証し、固定stage/exitと必要な子stderrを返す | shell終了0だけを更新完了にしない。後続失敗後の実導入状態はstage依存で、旧版保持を無条件に保証しない |
| [cli/migrate](../../src/cli/migrate.mjs):parseArgs/run/result | `--json`のみ。既DBの製品migration→migrated/already_current/not_applicable又は固定errorと0/1/2 | DB不在を作成しない、future schemaを下げない。[DB関数](current-entrypoints.md)のlock/transaction/closeへ接続。commit後の出力消失は未移行の証明ではない |
| [cli/factory-diagnostics](../../src/cli/factory-diagnostics.mjs):inspectFactoryDatabase/hasFactoryDatabaseShape/inspectFactoryHooks/inspectFactoryThread/collectFactoryDiagnostics/run | 既DBをreadOnlyで開きsettleFirstRead、現schema/column/PK/unique indexを検査しfinally close。project束縛thread/rolloutと3eventのhook形を検査 | 読取不能unverified、既知不適合not_ready、不在not_applicable。DB schema番号だけではreadyにしない。PreCompact/hostの実hook発火や本人復帰の実測はこのsnapshotに無い |
| [factory-diagnostics](../../src/factory-diagnostics.mjs):buildFactoryDiagnostics/aggregate/statusOf | 入力から許可fieldだけを公開projectionへ。not_readyを優先し、未実施restore smokeをunverifiedに保つ | Codexのoverallと別connector Claudeを区別。overall readyでも全OS/harness/自然hook/restore smokeの合格ではない。raw path/本文/例外を返さない |
| [cli/doctor](../../src/cli/doctor.mjs):run/runSessionDiagnosis/runTrimDiagnosis/runCodexDiagnosis/readCodexHookDiagnosis/readCodexHostPrimitiveDiagnosis/readVsCodeMonitorTaskDiagnosis/buildCodexContextRefreshDiagnosis | 通常環境診断、sessionのstate/transcript、Codex設定信用/monitor/記憶とtrim診断をtext表示 | CodexはgetDb既定引数による初期化/移行作用あり、primitive診断はschema生成CLIを起動する。すべてをpure readと呼ばない。factory側がdoctor `_internal.readCodexHookDiagnosis`を利用する接続は現行の整理検討事項 |

doctorのcheckは表示結果を返すhelperで、各検査失敗をCLI全体のnonzeroへ一括写像していない。doctor text、factory JSON、self-updateの厳密受入は別契約として保つ。Node最低版のdoctor表示とpackage enginesの差、project検索のSQL lowerと共通helper差、state prefixの符号化との関係は全test/正本照合へ残す。

## Monitorと端末表示

```mermaid
flowchart TD
  Main[monitor main / argv] --> Mode{diagか}
  Mode -->|yes| Diag[TTY/env診断の表示とlast-diag保存 / exit]
  Mode -->|no| Terminal[カーソル非表示 / TTY raw modeとsize query]
  Terminal --> Tick[1秒tick / 10秒の経過時間表示 / resize]
  Tick --> State[readAllSessionStates / Codex rollout discovery]
  State --> Live[実file mtime / live usage / 最後のstate値を合成]
  Live --> Filter[project又はsession / stale条件 / 更新順]
  Filter --> View[CJKとANSIセル幅 / 画面描画]
  View --> Tick
  Main --> Signal[SIGINT / SIGTERM / crash]
  Signal --> Cleanup[timer解除 / raw mode解除 / cursor復元 / exit]
  State -->|読取失敗| Retry[frame又はdiscovery診断 / 次tickへ]
  Retry --> Tick
```

| 実file/関数 | 所有・作用と返却 | 保持/失敗/cleanup |
| --- | --- | --- |
| [token-monitor](../../src/token-monitor.mjs):main/readMonitorStates/discoverCodexSessionStates/mergeCodexDiscoveredStates/withLiveActivity/resolveMonitorUsage/filterStates | 製品stateと外部rolloutの読取を合成。live usage優先、不可時だけ最後のstate。stale15分/同project又は明示sessionを表示 | state読取は壊れ/期限file cleanupを伴う既[状態契約](current-entrypoints.md)。discovery上限は既定project30/all又はsession100。source変化をobserver完了cursorに代用しない |
| 同:computeRenderKey/needsRerender/renderFrame/safeRenderFrame/runDiagnostic | stateとlive size/mtimeで描画差分、時間経過/resizeで更新。diagは端末情報とlast-diag.txt保存 | 画面更新はモデル状態や業務完了の証明ではない。frame errorはstderr後次tick、外側callback例外はcrash経路。diagは保存失敗を表示してexit0という既契約 |
| 同:cellWidth/codePointWidth/truncateToCells/padCellsEnd/resolveColumns/formatLine/restoreCursor | ANSI/CJK/emojiのセル幅と1行制限、実測幅→TTY→env→既定。module変数に描画cacheを持つ | 複雑なglyph列は既近似であり新dependencyへ置換しない。複数mainの再入・signal listener寿命は関連testで確認する。SIGKILLでcleanupを保証しない |
| [terminal-size](../../src/terminal-size.mjs):parseSizeResponse/startSizeQuery | TTY限定raw mode、CSI 18t→stdin分割応答の最後を採用、Ctrl+C callback、buffer制限。stopでlistener解除/raw解除/pause | unsupportedはno-op。stopは元raw状態を保存復元する契約ではなくfalseへ戻す既挙動。端末の実幅と描画は実機未確認 |
| [cli/status](../../src/cli/status.mjs):run | getDb→件数と最近5sessionをtext表示 | getDb初期化/移行作用あり、query全体のread-only性と区別。旧bodies table例外だけ互換0件。終了値/stdio callerの全fixture未照合 |
| [cli/codex-threads](../../src/cli/codex-threads.mjs):parseArgs/run/renderReport | thread-indexの読取候補を既limit/project/allで返す | 候補を自動trimの対象へ選ばない。実rolloutを今回開いた意味ではない |
| [spike-transcript-writer](../../src/spike-transcript-writer.mjs):spikeInject/generateSpikeTracer/readLastUuid/buildUserLine/buildAssistantLine | prompt-submitの明示spike marker経路から記憶をJSONLへappend/fsync、uuid chainと独立tracerを作る実験機能 | 通常handoff注入とは別の副作用。書込途中は追記が残り得てtransaction rollback無し。fdはfinally close、tracer等の原本はcaller側。削除/本線化の採否は未定 |

## Runtime error: 観測・受領・解決・保持

```mermaid
flowchart TD
  Hook[hook失敗又は復帰確認] --> Child[bounded observer子process / 固定codeと許可context]
  Child --> Config[製品collection設定 / 未設定はdisabled]
  Config --> Lock[private dirとSQLite lock / BEGIN IMMEDIATE]
  Lock --> Record[固定fingerprint / count / sequence / open又はresolved]
  Record --> Replace[ACL又はmodeを検証 / temp renameでstore置換]
  Replace --> Sidecar[必要時だけcontextとsource-checkを別fileへ]
  Sidecar --> Unlock[lock transaction終了 / close]
  Unlock --> Public[snapshot / 許可field / cursor / resolution]
  Entry[hook入口report trigger又は明示report] --> Enabled[別のreporting設定 / 既定通信OFF]
  Enabled --> Claim[lock下でnext-attemptを先に保存]
  Claim --> Public
  Public --> Sign[credential検証 / 許可snapshotをHMAC署名]
  Sign --> Send[指定宛先のみ / redirect拒否 / 10秒timeout]
  Send --> Verified{200 / accepted / 同report ID / 応答署名}
  Verified -->|yes| Ack[取得pageのcursorだけack]
  Verified -->|no又は不明| Pending[ackを進めずpending保持]
  Ack --> State[last-result / success版 / 次時刻を保存]
  Pending --> State
  Public --> Compact[ack済み / resolved / 保持期限超だけ削除]
```

ロック用SQLiteのtransactionはJSON store/context/source-check全fileのrollback機構ではない。store置換後にsidecar失敗やCOMMIT失敗が起これば、先行fileを戻す保証は無い。失敗を公開診断に出すbest-effort契約と記憶本体の確定を混同しない。

| 実file/関数 | 責任・状態所有と返却 | 保持/取消/不明/cleanup |
| --- | --- | --- |
| [runtime-error-store](../../src/runtime-error-store.mjs):observeRuntimeError/runtimeErrorFingerprint/readRuntimeErrorSnapshot | 許可code/contextのみ、固定template由来fingerprintで累計。発生版/sequenceを更新、再発でopenへ。snapshotは最大256件、公開field/最新発生bindingだけ投影 | collectionは製品configのみ。raw例外/任意field拒否、schema/順序/uniqueness/権限を検証。context sidecarの部分確定を隠さない |
| 同:resolveRuntimeError/reopenRuntimeError/acknowledgeRuntimeErrors/compactRuntimeErrors | expectedCursor指定時は最新観測と一致した時だけresolve。ackは単調でhigh watermark以下、compactはack済みresolvedかつ既定30日期限超のみ | ackは業務解決ではない。新発生を古いsnapshotで解決しない。未受領/open/期限内をcompactで消さない |
| 同:withStoreLock/writePrivateStateFile/writeRuntimeErrorPrivateConfig/ensurePrivateStoreDirectory | 製品private dir/file、symlink拒否、POSIX owner/mode又は既Windows ACL helper。prepared tempをrename、finally temp除去/lock rollback/close | SQLite lock5秒。単体同期APIに公開cancel無し、process killで全finallyを保証しない。既共有ACL部品を独自実装へ置換しない |
| 同:recordRuntimeErrorBestEffort/resolveRecoveredRuntimeErrorBestEffort と [observer](../../src/runtime-error-observer.mjs)のtop-level入口 | 子process5秒、contextは10秒。固定recorded/disabled/store_unavailableと固定stderrを返す | 親hookの本来の例外を消す処理にしない。子期限で記録未作用とは断定できない。内部helperの全option/caller閉包はまだ未完 |
| [runtime-error-report](../../src/runtime-error-report.mjs):reportRuntimeErrors/sendPendingRecords/updateState/setRuntimeErrorReportingEnabled | 製品report設定、backgroundはlock下で間隔claim、明示reportは待たない。通常1時間/設定拒否系24時間、版変化は記録0件でも一回報告 | collectionとreportingは別config。hook triggerの起動受付は送信成功ではない。壊れた送信間隔stateだけ空から再建する既契約 |
| 同:readReportCredential/signRuntimeErrorReport/isVerifiedAcceptance/buildRuntimeErrorReport/observedAtMs/readBoundedText | 許可credential/file/URL/署名、exact body bytesのHMAC、時刻は記録より前へしない。responseは受取後64KiB超を拒否、200と同IDの署名を検証してからack | body上限をstream受信中のhard memory上限と説明しない。timeout/破損/署名違いでackしない。受信済みで応答喪失はあり得る。既report再送方針を自動継続のunknown再送禁止と混同しない |
| 同:getRuntimeErrorReportStatus/normalizeState と [trigger](../../src/runtime-error-report-trigger.mjs):triggerRuntimeErrorReportBestEffort | 最終結果と時刻/版を投影。triggerは次時刻を見てdetached子を起こす既窓口 | 中央受領→ack→送信stateは別確定、後段失敗で中央受付を取り消さない。recoveredは同じ固定fingerprintの製品側解決で、元の本人会話復旧の証明ではない |
| [cli/runtime-errors](../../src/cli/runtime-errors.mjs):parseArgs/run/runReport/reportExitCode | JSON必須の固定command/引数、usage2/operation1、明示reportのdisabled3。background結果はstateへ残して通常exit0 | endpoint/credential/本文を公開結果へ出さない。CLIのack/resolveや送信有効化を本調査で実行しない |

中央受け口の内部・運用上の最終処置は外部所有。公開HMAC/JSON契約への接続だけを製品側の図に残す。署名付き受付を読了/業務解決/本人会話復旧へ補完しない。

## 残る意味調査と検証

### 配布・CIと残存する保守入口

機械分類config-support内にも実行scriptがあるため、source126fileの本文確認だけで全実装を読み終えたとは扱わない。今回以下の10fileも本文確認し、実行はしていない。開発script/workflowはpackage外なので、下表では配布Markdownの相対リンクにせず実path/関数を記す。

| 実path/関数 | sourceから確認した責任と作用 | 残確認/保持 |
| --- | --- | --- |
| `install.mjs:readSettings/writeSettings`とtop-level | repo直下の旧installer。repo-local Claude設定に旧detail-capture/context-injector等のcommandを追加/解除する | 現行`throughline install`のdispatch先でもpackage同梱対象でもない。旧callee/参照と履歴/扱いの正本照合は次工程。利用無しと推測して削除しない |
| `scripts/repair-merge-cycles.mjs:detectCycles/findLiveTarget/main` | one-off。getDb→cycle検出、live target選択、各cycle毎にBEGIN IMMEDIATEで3層row/merged_intoを移動、失敗rollback | dry-runでもgetDb初期化はある。通常handoff resolverとは別で公開CLI非登録、配布外。既cycle/保持/制約fixtureや利用履歴は未確認。実DBへ実行しない |
| `scripts/product-ci-plan.mjs:classifyPaths/selectTestFiles/relativeDependencies/createPlan/verifyResults` | 固定base/HEAD/ancestorを照合、変更pathから環境と逆依存のtestを選ぶ。依存不明/対象test無し/混在変更は広い既検査へ | 文字列依存抽出であり意味調査の読了証拠ではない。Markdownのみをdocs扱いしJSON/SVGを自動除外しない。今回の文書検査を将来のCI合格へ補完しない |
| `scripts/run-product-ci-tests.mjs`とtop-level | 計画のall又はselectedを検証し、既test-envでNode testを起動する | 無効scope/空selectedを拒否。製品のCI所有を外部へ移さない。今回testは起動していない |
| `.github/workflows/test.yml`と`product-full-ci.yml` | 製品所有workflowへ接続、固定SHAの外部action、比較base、3環境matrix/依存/文書又は選択試験、最後に計画と結果を照合 | factory Host/runner自体は外部所有。GitHub CIを今回起動していない |
| `.github/workflows/publish.yml`と`scripts/verify-release-commit.mjs:verifyReleaseCommit` | tag版一致→依存→npm publish、prepublishでdefault branch祖先/clean payloadと試験を確認。packageのbin/files/scriptsが公開入口 | 公開の既承認を解除しない。release gateは既仕組みを維持、新しい承認条件は追加しない |
| `codex/skills/throughline/agents/openai.yaml`と`.gitignore` | 配布skillの表示/implicit invocation、端末settings/task/secret marker等の追跡除外 | skill本文とslash commandの指示/consumer契約は次工程。ignoreは秘密/状態の不存在を証明しない |

今回読んだ残15sourceと、migration/core factory/CLI factory/terminal-size/self-update/runtime store/runtime reportの7testは本文確認のみ、未実行。大きなinstall/doctor/monitor/VSCode task/CLI runtime/context等のtest、fixture/config/skill/export、外部consumerの閉包は未完。全機械sourceの本文確認をもってこれらの完了にしない。

整理検討事項は、factoryからdoctor `_internal`への参照、install内のhost別設定/検査/配布と表示の同居、診断とDB初期化作用の境界、temp writerと複数file部分確定、monitorの観測/描画/プロセス寿命の同居。既存契約が異なる箇所をただ似ているという理由で統合せず、保持契約/関連testの確認後にAstraで採否と代替案を決める。
