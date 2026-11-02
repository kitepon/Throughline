# 文脈復元・observer・外部文脈の現行source対応

基準base `39ff812d46c0e84e8fc1418096c509551cf3928b`、S1実装後の現行対応。[全体索引と現在の工程](README.md)から本詳細を経て実file/関数へ辿る。上段のsource調査時点の未読/未実行と、末尾のS1/S2/S3追補・保持根拠を区別する。[描画manifest](render-manifest.json)の原稿/描画物対応は固定し、意味が変わらない図を反復描画しない。適用済みAstraの最終照合結果は[全体索引末尾のS5](README.md#s5最終整合2026-11-03適用済みastra-xhigh)へ固定した。3OS全件/gateと指導担当の全体成果受入は完了。通常保守への引継ぎは全体索引末尾を参照。

## 記憶の読取と表現の境界

```mermaid
flowchart TD
  Caller[hook初回引継ぎ / 公開CLI caller] --> Entry{公開入口と目的}
  Entry -->|handoff-context| RO[既存DBだけread-only open / finally close]
  Entry -->|handoff-preview / codex-resume| RW[getDb / schema初期化・移行の作用あり]
  Entry -->|detail| DetailDB[getDb / 日時とprojectでmerge chain照合]
  Entry -->|recall| Pull[明示sessionとbefore境界 / read-only DB]
  RO --> Select[明示session / 同project最新の本文あり / recent集合]
  Select --> Record[buildHandoffRecord: L1/L2/Thinking/L3参照の中間表現]
  RW --> Record
  Record --> Budget[buildBudgetedResumeContext: 9500字 / 現在地 / 案内 / L2]
  Record --> Manual[Codex text / fresh-thread text / developer item / JSON block]
  Budget --> Auto[auto継続では途中依頼・止めた道具を現在地へ]
  Budget --> Recent[recentは現在会話を保ち / 余りだけ過去会話]
  Auto --> Out[文脈text又はversioned JSON / callerへ]
  Recent --> Out
  Manual --> Out
  Budget --> Hints[取得案内へsession / before / last / skipを固定]
  Hints --> Pull
  Pull --> Recall[recall: 固定境界からL2全文又はL1索引を返却]
  Recall -.->|必要時に別CLIを呼ぶ案内| DetailDB
  DetailDB --> Detail[detail: 日時・projectからL2/L3を取得]
  Recall --> Out
  Detail --> Out
  Out -.-> Consumer[callerの注入 / モデル読了 / 業務完了は別所有]
```

図の`getDb`はpure projectionそのものの書込ではなくCLIの接続初期化の作用。公開`handoff-context`と`recall`はread-onlyを使うが、`handoff-preview`/`codex-resume`/`detail`まで同じread-only接続と補完しない。`detail`はhandoff recordを生成せず、`recall`も内部で`detail`を実行しない。破線は返却文にある別CLIへの取得案内である。初稿の両経路の結線を実関数に合わせて訂正した。hook側のmerge/pending/acceptedは[記録図](current-entrypoints.md)と[自動継続図](current-continuation.md)に正本を置く。

| source / 関数 | 入力・返却と状態所有 | 保持契約/未確認 |
| --- | --- | --- |
| [handoff-record](../../src/handoff-record.mjs):buildHandoffRecord/formatTime/loadBodies/loadL1Summaries/loadLatestThinking/loadL3References | DBを読み、中間record v1を返す。直近20turnはorigin+turnで選び、古いL1と最新Thinking、L3取得参照を分離。record自体は保存しない | 既存のquery失敗→null/空arrayという互換動作を保持。source adapter推定は現状Codex/Claude区別であり、4harness正本への変更採否は未定 |
| [resume-context](../../src/resume-context.mjs):buildResumeContext/buildBudgetedResumeContext/buildResumeSections/renderBudgetedSections/groupL2Turns/buildGuidanceLines | 無制限rendererと予算付きrendererは別export。予算付きは9500字、現在地/案内を予約しL2を新しい順にturn原子で選んで古い順に表示。最新だけ明示切詰め可 | L1/Thinkingを通常pushへ注入しない。旧memo引数は互換の無作用。pull境界はISO ms strict less-thanとして固定し、recall側で窓を再計算しない |
| 同:buildRecentSessionsContext/loadSessionTurnSpans/renderPastBlock/renderPastIndexLine | 現在会話の本文は不変、残予算だけ同project過去会話へ。origin+turnを重複排除、途中で入らないturnより古い本文へ飛ばない | 複数sessionをDBで合流しない。過去会話の依頼を現在の依頼として再開しない説明を保持。索引/recall件数の既上限を維持 |
| 同:buildAutoContinuationContext/renderInFlightSteps/truncateInFlight | 途中依頼・実行済み/未実行道具・最終発言・backgroundを現在地へ。捕捉済み途中turnはL2一覧から外す | 途中turnを古い記憶へ二重計上しない。文脈生成はaccepted後なので、その失敗で受領済みを取り消す保証は無い |
| [cli/handoff-context](../../src/cli/handoff-context.mjs):parseArgs/readHandoffContext/readLatestProjectHandoffContext/readRecentProjectHandoffContext/readSessionProjectPath/renderHandoffSupplement/run | session/project/recentを選択、projectに束縛したsupplementを予算に含める。read-only、DB不存在は新規作成しない、finally close。v1 ready/empty JSON | project emptyはexit0、session unavailableはexit1、構文はexit2。supplement/disclosure/recentの組合せ拒否を保持。本文の所有/消費位置を変更しない |
| [latest-session](../../src/cli/latest-session.mjs):findLatestSession/parseArgs/run | 同projectの更新時刻最新IDをread-onlyで返す | 本文を持つ会話を選ぶhandoff-contextとは異なる意味。候補なしempty、読取失敗exit1を混同しない |
| [handoff-preview](../../src/cli/handoff-preview.mjs):run / [codex-resume](../../src/cli/codex-resume.mjs):run | getDb→record→既存Codex renderer。Codexはmemo stdin/3formatと制限引数を持つ | JSON/textを生成しただけで配送しない。format/旧引数/export/既default session選択を勝手にそろえない。manual起動/trimの下流本体は[手動詳細](current-manual-continuation.md)へ接続、全consumer閉包は未完 |
| [recall](../../src/cli/recall.mjs):parseRecallArgs/runRecall/renderRecallL1/renderRecallL2/run | 明示session/before、L2 last、L1 skip/lastでread-only取得。L1未要約を明記、L3は参照suffix | DB未存在/引数/接続/queryは明示失敗、finally close。注入時の境界から追記後も同じ担当範囲を読む |
| [sc-detail](../../src/sc-detail.mjs):parseDetailArg/detailRangeOn/run | 明示日時又は最近該当日の同project本文→対応turnのL3をbatch読取。getDb経由、範囲とkind別text表示 | 同時刻の複数turnを保持。project比較/日時の全caller閉包は未了。S2でThinkingが既知kindのためlegacyにも振り分けられず表示されないことを確認。sc-detail既test4件はtool_inputのみでThinking非coverage。README両言語へ制限を反映、表示機能は変更しない |

同期rendererとread-only queryに公開AbortSignalは無い。文脈生成失敗はcallerへ戻り、出力後の取消・reader消失で新しい消費位置を製品が保存する経路も無い。DB handleはread-only wrapperのfinallyでcloseするが、強制終了で全cleanup実行を保証しない。`handoff-record`の空/部分fallbackと外側の明示失敗の差は構造整理で保存すべき既存挙動として調べる。

中間recordから返却表現までの既存共通責任も、一つの正本へ結ぶ。

| 実file/関数 | caller/データと返却 | 保持/作用 |
| --- | --- | --- |
| [l3-summary](../../src/l3-summary.mjs):shortenMcpToolName/localizeL3Part/groupL3ByTurn/buildPartsSummary | resume-context/codex-handoff/recall→origin+turn毎の表示suffix。tool_inputだけ件数化、system/tool_outputはsuffixに載せず、Thinking/画像を区別 | 参照labelの省略はDB本文の削除ではない。Map順序を保持し、L1だけincludeBody可。pure表示、state/取消/cleanup無し |
| [body-digest](../../src/body-digest.mjs):normalizeAuditorBody/hashAuditorBody | completed-turn-receipts/observer/auditor/caveat→NFC・改行統一・trimした本文のSHA256。完了証拠と本文投影を照合する共通責任 | hash一致をDB保存/業務完了の証明に単独使用しない。保存本文そのものをこの関数で書き換えない。正規化を変えると既receipt/cursorとの照合へ届く |

[ADR0016](../adr/0016-push-pull-recall-injection.md)はADR0014のL1先詰めを置換し、現在地/取得案内とturn原子L2をpushする。古い設計の注入順へ戻さない。S2でtl/skill/READMEをrendererへ照合して訂正した。Thinkingはdetailで表示されない既制限を明記し、手動Codex rendererに取得済み最新Thinkingが入り得る点を通常Claude push/自動Codex継続と分けた。依存/版変更時の空reportの同期と検証根拠は[運用詳細のS2記録](current-lifecycle.md#s2説明同期と保持確認2026-11-03)へ置く。

## Observer: 既描画の現行図を再利用

```mermaid
flowchart LR
  N[N102 SelfTurns・保存済み消費cursor] --> R[CLI observer-read run/parseArgs]
  W[CLI observer-wait run/取消controller] --> Wait[waitForObserverTurnChange]
  Wait --> Resolve[resolveObserverTurnFeed]
  R --> Page[readObserverTurnPage]
  Resolve --> Sources[claudeCandidates / codexCandidates]
  Page --> Sources
  Sources --> Receipt[readCompletedTurnReceiptSnapshot]
  Sources --> Index[listCodexThreadCandidates → parseCodexRolloutFile]
  Receipt --> Chain[完了chain・prefix・host/thread選択]
  Index --> Chain
  Chain --> Wire[waitのchanged/timeout/resync/ambiguity]
  Chain --> ReadPage[固定through/pageToken・page投影]
  ReadPage --> DB[readCompletedPairProjection: read-only DB照合]
  DB --> Pending[projection_pending又は本文page]
  Pending --> N
  Wire --> N
```

[既描画SVG](diagrams/observer-current.svg)。Mermaid原稿は固定草案4344c16の第2block（末尾LF込みSHA256 `c18c482eb1d4bb05c2b7d6997803f20ac5407c78e2e3d29667d979c3723f5e7b`）と同bytes。SVGも既受入の `b4457cc284a61f103e370c28c9dc12fed5b2e6b0f3aa322344292e62b7663029` を再利用し、同じ描画/目視を反復しない。以前の図の限界であるreceiptと本文freshness、長い横図の拡大読取条件を保持する。現在sourceとの本文対応を以下へ追記し、有限の描画受入を製品全体の整合受入には広げない。元の草案/描画レビューは当席docsの監査原本として固定したまま保持する。

| source / 関数 | 正常返却と状態の所有 | 失敗・取消・部分成功・保持 |
| --- | --- | --- |
| [feed](../../src/observer-turn-feed.mjs):resolveObserverTurnFeed/claudeCandidates/codexCandidates/codexTurnEntry/selectLatest | Claude互換receipt又はCodex task_completeから完了chainを作り、最新host/threadを選ぶ。本文DBやmtimeを完了証拠にしない | 同時刻cross-hostはambiguous。旧source消失/rollback/prefix不一致はswitchへ補完せずresync。各pollで候補探索/rollout parseを行う既構造で、batch/O(1)供給済みではない |
| 同:encodeObserverCursor/decodeObserverCursor/validateCursorCandidate/prefixDigest | project SHA/host lane/thread SHA/length/prefixをopaque cursorへ。形はv1を保持 | history_floorは形に残すが位置検証では比較しない（ADR0035）。prefixが一致する既cursorを不必要に失効させない。cursorは認可鍵やconsumer保存値ではない |
| 同:readObserverTurnPage/logicalDeltaSeries/fixedCandidate/projectReadPage | snapshotは直近limit件・historyTruncated付きでcomplete。deltaは固定throughまでpage分割。limit1..100、既定10 | page tokenはproject/after/through/offset-prefixに束縛。本文pairが一つでも不足なら全pageのturns空、through=null、complete=false/next=null。前の成功pageを製品が保存確定するわけではない |
| 同:decodeObserverPageToken/validatePageTokenBinding/validatePageTokenPrefix/harnessOf | cursorは共通、page tokenはcanonical符号化を検証。v1は既lane/本文制限、v2は全文/実harness/turn_start | Grok/Cursorは互換receipt laneを使う。v2だけ実session prefixからhostを求め、v1はclaude laneのまま。wire切替でcursorを変えない |
| [auditor](../../src/auditor-context.mjs):readCompletedPairProjection/buildCompletedPairs/matchExpectedPairs/fullProjectedPairs | read-only DB v9..current、project同一又は子孫、origin/user/assistant hashの順序付き全pair照合。v2 fullBodiesと旧turn_startのunknown | DB/session/pair不足はpending、schema/project/I/Oはhard error。busy待ちは1秒、finally close。完了証拠と本文freshnessを二重に混ぜない |
| [wait](../../src/observer-turn-wait.mjs):waitForObserverTurnChange/terminalWire/abortableSleep | timeout1..3600秒（0不可）、monotonic deadline、各wakeで完了cursorを再確認し、最後までunchangedだけtimeout | AbortSignalを開始前/解決後/sleep後に照合。timer/listenerを除去。waitは本文DBを待たず、changed後readでpendingを裁定。同期source走査中の即時中断やSIGKILL cleanupは保証しない |
| [cli/read](../../src/cli/observer-read.mjs):parseArgs/run/mapError / [cli/wait](../../src/cli/observer-wait.mjs):parseArgs/run/installCancellation | 必須JSON/引数/重複/limit/timeout検証、成功stdout1 JSON。waitはSIGINT/SIGTERM/disconnect/親ppid変化/ESRCHを単一controllerへ写す | 既知resync等はexit0、hard error/cancelはstderr固定JSON・exit1。EPERMを親不在にしない。finallyで親watchとlisteners除去、raw例外/path/本文を転記しない |

N102が消費cursor・pageの消費/保存・pendingの次巡再読を持つ。製品は確認値だけでconsumer保存を進めない。今回の候補へ新batch APIや変更確認tokenを足していない。元のbatch提案図と仮契約は実装済み機能の図へ混ぜない。

## Auditor / Caveat / Room

```mermaid
flowchart TD
  Auditor[CLI auditor-context / 明示pair又はhost transcript] --> Expected[freshness expectationを導出]
  Expected --> Read[read-only DB / schema / project / 完了pair照合]
  Read --> Bound[一致したpairまでを文字数予算に制限]
  Bound --> Fresh[fresh等のversioned JSON]
  Caveat[CLI caveat-context] --> Three[read-only DB / 直近完了3pair]
  Three --> Think[任意host照合 / Thinkingだけ追加 / tool本文除外]
  Think --> Ready[ready / incomplete / projection_pending等]
  Room[CLI room-context / stdin EOF JSON] --> Open[製品DB取得 / 入力検証]
  Open --> Tx[BEGIN IMMEDIATE: 同project・room・message ID]
  Tx --> Conflict{既存本文とspeakerが一致するか}
  Conflict -->|不一致| Rollback[ROLLBACK / 固定error / exit1]
  Conflict -->|新規又は同じ| Upsert[既存不変 / 新規insert]
  Upsert --> Select[指定message rowidまでの直近3発言]
  Select --> Commit[COMMIT / ready JSON]
  Fresh -.-> Consumer[外部consumerの判定 / 表示 / 保存は別]
  Ready -.-> Consumer
  Commit -.-> Consumer
```

| source / 関数 | 返却と所有 | 保持/未確認 |
| --- | --- | --- |
| [auditor](../../src/auditor-context.mjs):deriveAuditorFreshnessExpectation/readAuditorContext/boundCompletedPairs/isSameProjectOrDescendant | host transcript又は明示pairとDBの両方を照合、boundedな完了文脈を返す。Codexはrollback後ordinalではなくorigin+両hashで照合可 | expectation不足/本文違いはstale。schema/session/projectの状態と例外を分け、finally close。通常auditorとobserver projectionでは返却/切詰め順が違う |
| [cli/auditor](../../src/cli/auditor-context.mjs):parseArgs/run/hasFreshnessSource | host+transcriptと明示pairは排他的入力、JSON-only | 曖昧な入力を補完しない。query/parseのraw例外を固定errorへ変換。全consumer未読 |
| [caveat](../../src/caveat-context.mjs):readCaveatContext / [cli/caveat](../../src/cli/caveat-context.mjs):parseArgs/run | 完了3pairが揃った時だけ本文と取得可能なThinking、各上限付き。任意host期待値不一致はpending。tool本文を含めない | 3pair未満はincomplete、別projectを漏らさない。read-only/1秒busy/finally close。Thinking無しを存在すると補完しない |
| [room](../../src/room-context.mjs):recordRoomTurn / [cli/room](../../src/cli/room-context.mjs):run | project/room/message keyでDB保存、同じmessageの再送は不変。指定messageまで3発言を返す | read-only projectionと異なるwriter。既定db=getDb評価の接続作用は関数内の入力検証より先。内容相違はconflict/rollback。COMMIT後の出力失敗は保存取消ではない |

今回読んだ8testはlatest-session、room、caveat、observer core/wire/wait/Codex hash projectionで、実行はしていない。resume-context/handoff-context/auditor/recall/detailの大きなtest、Host以外の実consumer、fixture/config/export閉包は未完。`docs/02_clear_auto_handoff_plan.md`の二相step4はbackfill→mergeという説明だが、実executorはmerge→accepted→backfillであり、図は実source順を採用した。既正本文書の訂正は整理工程の差分で行う照合事項として残す。


## S3追補1: 復元保持と既知の公開consumer

[handoff-record.test](../../src/handoff-record.test.mjs)全4件、[codex-resume.test](../../src/codex-resume.test.mjs)全7件、[公開handoff-context試験](../../src/cli/handoff-context.test.mjs)全16件を本文確認して通過した。recordの20turn/最新Thinking/L3参照、manualの短縮/memo/format/引数拒否、公開read-onlyの所有不変・欠落DB非作成・他project非漏洩・同project recent/emptyを確認する。試験数を全renderer/private関数/全consumerの網羅へ広げない。

以下は製品外の既知callerを読取だけで照合した接点であり、内部図を製品内へ複製しない。実体はinstalled `/app/src/` の3file。本文SHA/範囲を自席semantic-pass-01のexternal-consumer-source.jsonへ固定した。他製品の実装・設定・予定は変更せず、その試験も実行していない。

| 外部の公開接点 | Throughline側の関数/返却契約 | callerが所有する消費・失敗・取消 |
| --- | --- | --- |
| `throughline-context.mjs:latestThroughlineHandoffContext` | [handoff-context.run/readRecentProjectHandoffContext](../../src/cli/handoff-context.mjs)。project/json/silent/recentを明示、v1 ready又はsessionId=null/context空のempty | emptyは空文字、readyは非空session/contextだけ採用。子終了/JSON/schema不正はcallerの失敗。注入/席の起動は外部所有。本文を引く時に製品がmerge/baton消費をしない契約と一致 |
| 同:completedThroughlineTurns | [observer-read.run](../../src/cli/observer-read.mjs)のv1既定・limit20 | schema/turns配列を検証し件数だけ返す用途。全DBターン数や業務完了数と同一視しない |
| `self-turns.mjs:readObserverTurns/SelfTurns.follow` | [feed.readObserverTurnPage](../../src/observer-turn-feed.mjs)→公開v2、limit100、after/through/page-token | fixed-throughを最後まで読んでからconsumer cursorを進める。projection_pendingは保留して再読。seen/lastCompletedAt/画面出力と保存はcallerの所有。DB/WAL mtimeは起動の手がかりであり完了証拠ではない |
| `room-routing.mjs:roomTurnsFromThroughline` | [room-context.run](../../src/cli/room-context.mjs)へJSON stdin/EOF、v1 ready・末尾messageIdを照合 | 子close/nonzeroと固定errorを検査、speaker/textを投影。DB COMMIT後の出力喪失を保存取消へ補完しない。callerに新しい取消/再送/記憶APIを要求していない |

外部の子process runner/Host内部、Spotter/Caveatの現在の実caller、未知のdeep import/export利用はこの3fileの読取では未確認。公開versioned JSONと旧import面を保持し、到達できない利用を全閉包完了と記さない。新batch/token/poolや実consumer受入は別工程のまま。


## S3追補2: 復元・公開projectionの残る保持根拠

[auditor-context.test](../../src/auditor-context.test.mjs)全418行と[observer-read CLI試験](../../src/cli/observer-read.test.mjs)全108行を追加照合した。auditorはoriginと本文2hash/完了pairを照合し、Codexの不安定なordinalだけを根拠にしない。project/schema不一致と不足pairのpendingを分け、pendingには部分本文を返さない。仮WALのbytes/mtime保持、exclusive lock時の固定error、有限busy待ちのassertを確認した。CLIは既知stateのexit0、hard errorの固定stderr/exit1、v1/v2 schema、引数重複拒否を保持する。外部Spotter/Caveatの現caller受入は依然未確認で、製品側の既窓口との保持根拠を示す範囲である。

[resume-context.test](../../src/resume-context.test.mjs)の既読budgetに加え913..1333を照合した。autoの途中依頼/完了済みと未実行道具/background/重複turn除外、長文の中略と件数、recentの現在文不変/残予算だけ過去本文/turn原子/途中打切り以降は索引/origin+turn重複除去/索引5件上限を確認した。無制限rendererの85..689は今回読了にせずpartialを維持する。実行結果は先行Linux全件を参照し、追加source変更が無いため再走していない。

[auditor](../../src/auditor-context.mjs):defaultAuditorContextDbPath と[recall](../../src/cli/recall.mjs):defaultRecallDbPath は、それぞれ公開CLIからhome/.throughline/throughline.dbを返す既path窓口であり、呼ぶだけでDBを作成/移行しない。実接続/close/例外は各read-only wrapperが持つ。同期path決定に取消/cleanupは不適用。`codex-resume`等のgetDbを使うCLIと統合しない。
