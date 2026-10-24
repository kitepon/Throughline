# ADR 0070: Codexは記憶の準備を確認してから元ターンの停止を許可する

日付: 2026-10-19

## Context

WindowsのCodex Desktopで0.16.38が要約backend失敗の前に元ターンを中断し、
後継も作れず作業が止まった。13:17と13:35 JSTの個別stderrは保存されていなかった。
14:00の独立した合成試験では同じbackendがcapacityを返し、14:40には同じモデルで復帰した。
過去の失敗も同じ原因だったとは断定しない。指揮官から復旧・原因調査・恒久対策、
および「引き継ぎ失敗で旧セッションを止めない」と指示された。

[Codexの公式hook契約](https://learn.chatgpt.com/docs/hooks)では、PreCompactの
continue=falseは元ターンを止める。圧縮だけを止めてモデルの作業を続ける返答はない。
準備できないのにこの返答を先に送る順序が、製品側の対処の誤りだった。

## Decision

- 新しい要求にはruntime.sourceStopGateを持たせる。登録済み30秒hookの命令と
  信用設定を変えず、hookは準備完了を最大20秒待つ。
- workerは、そのhookが待つ間に元ID/turn・未完了operation・設定・native状態を確認し、
  captureから一時snapshotを作って必要なL1を準備する。元ゴール停止、後継作成、
  表示、配送はまだ行わない。モデルは従来と同じで、失敗後の代替モデル選択はしない。
- 準備完了を確認したhookだけが停止を許可する。workerはその許可と同じ元turnの
  実停止を確認し、正規の不変snapshotを凍結する。停止後には外部要約を再実行せず、
  必要なL1がcacheに全て存在するか確認する。その後の作成・設定照合・配送は既存契約を維持する。
- 起動失敗、準備失敗、時間切れはfailedを保持し、continue=trueとsystemMessageで
  明示的に警告する。元ターンとゴールを停止せず、Codexの通常処理（必要ならその圧縮）を
  続ける。引き継ぎ成功、要約成功、別backendへの暗黙切替として扱わない。
  「旧セッションを止めない」という指揮官指示に基づく明示的な失敗時契約である。
- 準備中に元の別turnが進んだ場合や、hookが準備を取り消した場合は、workerが遅れても
  停止を許可したり後継を作ったりしない。モデル呼出の前後と準備完了の保存時に確認する。
- ローカル診断には時刻、元session ID、固定category、reason、整数exit codeだけを残す。
  stderr・会話・秘密をコピーしない。元例外を汎用codeだけにして理由を失わない。
- 既存のsource_stopped以降で失敗した要求は、同じIDでresumeできる。
  新しい停止前の準備失敗は、その時点のhook leaseを再利用して停止を許可しない。
  元の会話が続いた後、次の正規PreCompactで新しい境界から準備する。

## Limits and validation

- 停止後の新タスク作成・設定確認・配送・開始における失敗と結果不明は別工程である。
  送信結果不明時に旧会話を自動再開して二重実行することはしない。
- 外部backendの混雑自体を解消する変更ではない。準備時間が20秒を超えれば安全に
  元の会話を継続し、Throughlineによる切替は成立していないと表示する。
- schema、hookの命令、timeout、他hostの記録・引き継ぎ契約は変更しない。
- fixture試験は混雑失敗・起動失敗・時間切れ・取消後の遅延完了・重複要求・正常な
  準備から停止実測後の一度だけの配送、および診断の本文非漏出を検証する。

## Active goalの暫定的な停止前判定（2026-10-24）

Macで元turn停止の83ms後にactive goalが次turnを起こし、workerの停止境界照合が
`handoff_source_advanced`で失敗した。停止許可前にgoalを一時停止する案は、失敗時の
復帰と利用者の手動pauseが競合するとpauseを上書きするため採用しない。
[公式のgoal API](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/src/protocol/v2/thread.rs)に
expected status/revisionは無く、origin=automaticも条件付き更新ではない。
[条件付き再開APIの提案](https://github.com/openai/codex/issues/56148)を参照する。

0.16.45では記憶の準備に成功した後、停止を許可する前にgoal/getだけで確認する。
activeなら`handoff_active_goal_conditional_resume_unavailable`で明示失敗し、
元会話とgoalを停止せずcontinue=trueで通常処理を続ける。読取失敗も同じ停止前失敗の
契約に従う。goalの書込み・一時停止・復帰はこの判定で行わない。
判定後に要求の状態と準備を再確認し、取消済みの要求を許可しない。
goalなし・paused・complete・budgetLimitedは既存の判定へ進む。

これはactive goal検出時の自動切替を見送る機能制限であり、完全修理ではない。
goalの読取と停止許可はatomicではなく、確認後にgoalが作成・再開される競合までは
排除しない。その場合も既存のsource-advanced検査を削除しない。
後継・配送・結果不明の既存要求をこの処理で再実行・二重再開しない。
fixtureではactive goalの不変、停止未許可、後継/配送なし、通常goal状態、
読取失敗と判定中の取消を検証する。3OSの試験と、実行中の本物の会話の受入を区別する。

## Worktreeへ移動した会話の照合（2026-10-24）

session_meta.cwdは作成時の場所であり、Codex Desktopが同じ会話をworktreeへ移すと
現在のturn_context.cwdと異なる。同じthread/turnの完結したcontextがある時は、
そのcwdとhook.cwdを照合する。contextが無い既存記録ではsession_meta.cwdを用いる。
存在するcontextのcwdが欠測・相対であれば拒否し、別turnや途中行は採用しない。
最新turnの一致、native threadの主会話/現在cwdの照合、停止前準備は維持する。

要求のproject_pathは検証した現在cwdとし、runtime.sourceCaptureProjectPathに
元rolloutのprojectを保存する。停止前・停止後のcaptureとsnapshotのsession照合は
この元projectへ束縛し、後継の作業場所や設定と混ぜない。既存要求にこの値が無い時は
従来どおりproject_pathへ束縛する。記録の移動やschema変更はしない。
系譜の各辺では前任target_thread_idと後任source_thread_id、および前任の継続projectと
後任の元capture projectの一致を確認する。違うprojectやthreadの記憶は合流しない。
ローカル失敗ログにはproject/turnの比較結果と比較元だけを記録し、cwd値は足さない。

試験はworktree移動の拒否再現、停止前captureから後継配送までの合成受入、
複数のworktreeを通るA→B→Cの全記憶保持、および別thread/古いturn/任意cwd/
欠測cwd/途中行/壊れた系譜の拒否を検証する。本物の自然発火の回復確認は別に行う。

通常のCodex hookによるcaptureでも、元projectと現在cwdが異なる時は、明示threadに
対応するrolloutの完結した最新turn_context.cwdを照合する。一致すれば元projectへ
記録を保持し、不一致/古いcontext/相対cwdなら取り込まない。Stopの保存を、次の
PreCompactだけに依存させない。projectを推測して別threadを選ぶことはしない。

系譜のproject辺も要求・native設定と同じsameProjectPathで比較する。両端に絶対pathが
あることを先に要求し、Windowsの大小文字/区切りの同一性を許す。POSIXで別名のままのcase差、
別project、兄弟prefix、欠測・相対pathは拒否する。同じ実体へ解決されるpathは、Macの
caseを区別しないfilesystemも含め、既存sameProjectPathの規則で受け入れる。snapshotの元session束縛とthread辺は変えない。
