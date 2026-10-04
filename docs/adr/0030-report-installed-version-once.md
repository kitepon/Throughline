# ADR 0030: 未受領の記録が無くても、受け口へ届いた版と今の版が違う時は、空の report を1回送る

日付: 2026-10-04

## Context

ADR 0025 Decision 7 は、未受領の記録（runtime error と解決記録）が無ければ通信しないと決めている。
report は毎回 `installed_version` を持つが、記録が無い端末からは report が出ない。

BugHub は 2026-10-04 から、工場の report を送らない端末について、製品の report の `installed_version` と
`observed_at` を端末の導入版として表示する。受け口は `runtime_errors` と `resolutions` が空の report も受ける
（BugHub の担当が確認。同じ端末×製品は1分に1回まで）。

BellTeam コンテナは工場の report を送らない。0.12.7 へ更新して未解決が0件になった後は、
次に runtime error か解決記録が出るまで report が出ず、BugHub の導入版は「未確認」のままになる。
更新した端末で何も起きなければ、受け口は古い版を持ち続ける。

オーナーは 2026-10-04 に、エラーが無い時にも版を知らせる report を送ってよいか、送るなら
版が変わった時に1回だけか・1時間ごとかを選び、「版が変わった時に1回だけ送る」と決めた。

## Decision

1. 送信の状態（`runtime-errors.report.state.json`）に、受け口が受領した最後の report の版
   `last_reported_version` を持つ。書くのは、report が `sent`（ADR 0025 Decision 6 の受領がそろった時）に
   なった時だけ。記録を載せた report でも、空の report でも同じ。
2. 未受領の記録が無い時、`last_reported_version` が今の版と同じなら、今までどおり通信しない（`nothing_pending`）。
   違う時（版を上げた・下げた後、この項目を持たない旧版の state）は、`runtime_errors` と `resolutions` が
   空の report を1回送る。
3. 空の report の形は ADR 0025 と同じ。項目は `schema_version`・`report_id`・`product_id`・
   `installed_version`・`observed_at`・空の `runtime_errors`・空の `resolutions`。wire の版は変えない。
   署名、redirect を追わないこと、受領の確認も同じ。
4. 送るのは、今までどおり `report-enable` で明示して有効にし、収集も有効な端末だけ。
   送信が無効な端末と収集が無効な端末は、版も送らない。
5. 送る時機と間隔は変えない（hook 入口、1時間、断られた時は ADR 0025 の間隔）。
   断られた時と届いたか分からない時は `last_reported_version` を書かず、次の送信でもう一度送る。
6. `runtime-errors report --json` の結果は `sent`（`runtime_errors: 0`・`resolutions: 0`）。
   `report-status` の項目は変えない。

## Consequences

- 送信を有効にした端末は、0.12.8 へ上げた後に1回、その後は版が変わるたびに1回、空の report を送る。
  受け口には、端末がその版で動いた時刻が1つ届く。
- 版が同じ間は、記録が無ければ通信しない。端末が動いているかどうかは、この report からは分からない。
- 版を上げた後、次の送信の時刻（最長1時間）と、その後の最初の hook までは届かない。
  急ぐ時は `runtime-errors report --json` を回す。
- 0.12.7 以前へ戻すと、旧版は state を書き直す時に `last_reported_version` を落とす。
  再び上げた時に、もう1回送る。
- 既定の利用者（送信を有効にしていない端末）の動作は変わらない。
