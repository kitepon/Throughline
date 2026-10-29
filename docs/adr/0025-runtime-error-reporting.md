# ADR 0025: runtime error は、利用者が明示して有効にした端末だけが、製品から送る

日付: 2026-10-03

## Context

v0.6.2 の runtime error 集約は、工場（dotagents）の設定で有効になり、工場の report が BugHub へ運んでいた。
v0.10.4 で設定を製品所有へ移した時に引き継ぎが無く、オーナーの端末は全て収集が無効のまま、
故障がどこにも残らない状態になっていた（2026-10-03 に判明し、端末ごとに有効化した）。

同日、オーナーは責任の境界を定めた。

- エラーを挙げるのは各プロダクトの責務。工場は方針と、プロダクト・パッケージの管理だけを持つ。
- 第三者の端末から受け取るのは課金プロダクトだけ。OSS は第三者から受け取らない。

BugHub は、端末に入る CLI 製品が自分の分だけを送る受け口（runtime-errors v1.0）を、
オーナーの LAN の中に用意する。Throughline は公開 npm package なので、既定で通信しない決まりを保ったまま、
オーナーの端末からだけ送れる形が要る。

## Decision

1. 送信は既定で無効。`throughline runtime-errors report-enable --credential-file <絶対path> --json` で
   明示して有効にした端末だけが送る。宛先・key ID・secret は credential file にあり、package には埋めない。
   credential file が無い端末（外の利用者）は何も送らない。
2. 送信設定は `runtime-errors.report.config.json`（schema `throughline.runtime_error_report_config.v1`）に持ち、
   収集の設定 `runtime-errors.config.json` の形は変えない。収集の設定は厳密な形で読むため、
   同じファイルへ key を足すと、旧版が収集を無効と読む。
3. credential file は写さず、送る時に読む。入れ替えと失効が受け口の側だけで済む。
   POSIX では本人所有・group/other に権限なし・symlink でないファイルだけを読む。
   Windows では通常ファイルであることだけを確かめる（受け口の持ち主が置く ACL は本人以外の管理者を含みうる）。
4. 送る本文は `runtime-errors snapshot` の公開項目だけ（固定 code・定型文・回数・時刻・版・解決記録）。
   本文、path、生のエラー、session は store が持たないので送れない。host 名も入れない（受け口が credential から解決する）。
5. secret は通信に載せない。本文へ `HMAC-SHA256(secret, ts + "\n" + SHA-256(本文))` の署名を付ける。
   redirect は追わない。
6. 受領済み（ack）にするのは、200・`accepted: true`・`report_id` 一致・応答の署名
   `HMAC-SHA256(secret, report_id + "\n" + received_at)` 一致がそろった時だけ。
   そろわない 200 は「届いたか不明」として記録を未受領のまま残す。
7. 送る時機は hook 入口。`process-turn`・`session-start`・`prompt-submit`・`codex-hook` の開始時に、
   送信が有効で、次に試してよい時刻を過ぎていれば、切り離した子 process を1つ起こす。
   hook の終了は待たせない。子 process が store lock の下で時刻を先に書くので、同時に起きても送るのは1つ。
   未受領の記録が無ければ通信しない（2026-10-04 [ADR 0030](0030-report-installed-version-once.md)で、受け口へ届いた版と今の版が違う時だけ、空の report を1回送ることにした）。間隔は1時間。credential や report の形で断られた時は24時間空ける。
   `throughline runtime-errors report --json` は間隔を待たずに1回送る。
8. 送信の状態（最後に試した時刻・結果の固定 code・次の時刻）は `runtime-errors.report.state.json` に持ち、
   `runtime-errors report-status --json` で読む。宛先・credential・path は出さない。

## Consequences

- 既定の利用者には、hook ごとに設定ファイル1つの有無を見る処理が増えるだけで、通信も process 起動も無い。
- Throughline そのものが起動できない端末からは送れない。その故障は工場の `factory-diagnostics` の側で見る。
- OS の予定（cron・Task）や工場の定期実行には依存しない。
- 累計を送るので、届かなかった report は次の発生で補われる。次の発生が無い記録は、次の hook の送信で届く。
- Windows の credential file は ACL を検証しない。置き方は受け口の持ち主の責任とする。
- `observed_at` はミリ秒まで持ち、載せる記録のどの時刻よりも前にしない（2026-10-03、0.12.3）。0.12.0 は秒へ切り捨てていて、
  発生や解決と同じ1秒の中で送ると受け口の順序検査（422 `invalid_report`）に当たり、次の送信が24時間後になった。
  断られた実例は無い。署名の `ts` は同じ時刻の秒で、`observed_at` との差は1秒未満。


## Codex の最新発生の報告補足（2026-10-25）

`HOOK_CODEX_FAILED` は複数のCodex hookを同じ指紋で集約する。汎用文面と累計だけでは、
どの操作で何が起きたか区別できない。以後の新しい発生では通常のCodex hook入口が
固定語彙のevent・処理段階・返答の種類を観測し、公開snapshot/reportの既存
`message_template` にoperation / expected / actual / effectと発生時刻を自動補足する。
任意JSON項目、`safe_context`、`diagnostic_context`は送信契約へ追加しない。

補足は**最新の一回だけ**を説明し、過去の集計全体の現象や影響を説明しない。
利用者への実害は観測できていないので `user_impact=unknown`、
`classification=diagnostic_only`を明示する。`continue_requested` / `stop_requested`は
hookが返した要求だけを意味し、hostでの実行や回復の証明にはしない。
原因不明と現象不明を区別し、この診断だけで対応可能な利用者バグと判定しない。

既store v1の形・固定文面・fingerprint・件数・重大度・sequence/ackは保持する。
補足は同じ私有directoryの `runtime-errors.json.context.json` に別保存し、
fingerprint/count/first_seen/last_seen/product_versionが一致した一回だけへ投影する。
旧版や補足無しの新発生が来た時は、古い補足を表示しない。過去の記録へは補完しない。
補足fileが無い旧storeは従来の文面を出し、破損・権限不正は明示失敗して未送信記録を残す。
基礎記録→補足の順に同じlockの下でprivate atomic保存する。補足保存が失敗しても基礎記録を
消さず、既storage diagnosticを返す。補足のあるobserverだけは二つの私有file保存のため
上限10秒（従来の補足無しは5秒）の有限時間を持つ。

値は製品の固定enumだけで、payload、path、args、例外本文、stack、会話やsessionを
補足へ入れない。端末内の従来理由ログは保持する。この変更の隔離CLI検査を、実native
PreCompact、撤回済みWindows登録の再現・回復・修理成功として扱わない。

2026-10-26のMac最新報告で、引き継ぎ要求の拒否理由と既知の照合状態が補足から落ちることを確認した。
`handoff_hook_source_mismatch`だけは固定の理由名とproject/turnの一致結果（true/false/unknown）、
照合元（session_meta/turn_context/unknown）を最新一回へ追加する。例外文や識別子は使わない。
追加の私有補足は `runtime-errors.json.context.json.source-check.json` のcontext v2へ保存する。
従来のcontext v1も同じlockで保存し、旧版へ戻しても従来のsnapshot/reportを読めるようにする。
両方を同じ最新一回のbindingで照合し、古い比較結果は新しい発生へ転用しない。
3つの私有fileを保存する場合も既存の上限10秒を保つ。外部wireは1.0のまま。
一致結果は拒否時点の比較であり、拒否の正誤、利用者影響や復旧を証明しない。

## PreCompactのフォルダ照合を端末内で調べる（2026-10-28）

PreCompactより後に同じturnのturn_contextが書かれる場合、拒否時に参照した
フォルダと、後から記録された現在turnのフォルダとの比較が必要になる。
source拒否時の端末内hook-failures.logには、観測時刻・現在turnのcontext有無・
turn開始時刻（欠測時unavailable）と、hook要求/照合元それぞれの正規化済み
フォルダのSHA-256を保存する。正規化は照合と同じproject-pathを用いる。
ダイジェストは匿名化を保証するものではないため、端末内に限り、公開snapshot/reportや
source-check補足へは投影しない。生のフォルダ名、会話本文は追加しない。
これで次の発生時に、後から観測したcontextのフォルダを同じ正規化でハッシュ化して
hook要求と照合できる。後から書かれたcontextだけで、過去のhook要求を推測しない。
これらのログ追加を、照合拒否の修理成功や、元会話の回復とは扱わない。

## PreCompactの設定照合（2026-10-29）

current turnのturn_contextはPreCompactの返答後に記録される場合がある。
照合は同一turnのcontextがあればそれを優先し、まだ無ければhostが記録した最新の
thread_settings_applied、どちらも無ければsession_metaを用いる。要求payloadのcwdだけで
照合を通さず、不正・異なるcontextがある時に別の根拠へ切り替えない。
thread/turn識別と停止前のnative primary/project照合は維持する。
端末内診断と公開source-checkの固定project_basis語彙にthread_settingsを追加し、
適用済み設定による照合だったことを通常snapshot/reportまで保持する。任意値は許可しない。
既存v1/v2の状態は引き続き読める。thread_settingsを含む新v2状態は旧.49のreaderが
明示的に拒否するため、その状態を読む時は.50以降を使う。基礎記録とv1補足は保持される。

## 観測世代を指定した解決（2026-10-29）

修理判断後の新発生を古い判断で解決しないため、resolveに任意の--expected-cursorを用意する。
通常snapshotで対象fingerprint/count/last_seen/product_versionとcursor.high_watermarkを
読み、今回の修理対象と照合した上で、そのhigh_watermarkを渡す。解決と同じstore lock内で
next_sequence - 1と一致した場合だけ既存の解決処理を進め、不一致は非0終了/記録無変更とする。
別fingerprintが更新された場合も保守的に拒否するため、再観測して対象世代を再評価する。
既存の自動回復呼出しと指定なしCLIの契約は維持する。wireや報告先は変えない。
解決後は通常の署名reportを使い、accepted/report_id/応答署名だけでなく中央の実際の
source反映を読戻しで確認する。古い報告がacceptedでも未適用の場合は完了を主張しない。
