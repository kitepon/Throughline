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
   未受領の記録が無ければ通信しない。間隔は1時間。credential や report の形で断られた時は24時間空ける。
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
