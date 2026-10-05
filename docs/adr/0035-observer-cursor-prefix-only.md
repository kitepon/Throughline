# ADR 0035: Observer の位置は、下限の番号を比べず、先頭からの照合だけで検証する

日付: 2026-10-05

## Context

ADR 0003 は、Claude の完了ターンの控え（project ごとに 256 件まで、`COMPLETED_TURN_RECEIPT_LIMIT`）から
作る chain に位置（cursor）を結び、「保持の下限より古い位置は resync を求める」と決めた。位置には、
発行した時点の控えの下限の番号（`history_floor`）、会話の chain の長さ（`length`）、先頭から `length` 件の
digest（`prefix_sha256`）が入る。

実装は「位置の `history_floor` < 今の `history_floor`」なら `resync_required` にしていた。控えが 256 件に
達すると、1 ターン増えるたびに古い 1 件が落ちて下限の番号が 1 上がる。そのため、追いついている位置も、
次の 1 ターンで必ず無効になった。下限は project 全体で 1 つなので、落ちた控えが別の古い会話のものでも、
今の会話の位置が無効になった。

BellTeam（0.14.3、2026-10-05）で、控えが 323 件ある席の読み出しが、ターン 10 回すべてで `resync_required` に
なった。BellTeam は `resync_required` のたびに今の位置から読み直していたので、その間に終わったターンの
回答が画面に出なかった（同じ日に 2 回）。BellTeam のビスケットとトロニーが見つけた。

`history_floor` の比較が無くても、位置が指す会話の先頭の控えが落ちたことは分かる。先頭が k 件落ちると、
今の chain の先頭から `length` 件は、発行した時の先頭から `length` 件と違う控えになり、`prefix_sha256` が
合わない（各項目は控えの連番から作る `source_sha256` を含む）。chain が `length` より短くなった時も無効になる。

## Decision

1. 位置の検証から `history_floor` の比較を外す。位置が有効なのは、その会話の chain が `length` 件以上あり、
   先頭から `length` 件の digest が `prefix_sha256` と一致する時だけとする。`resolveObserverTurnFeed` と
   `readObserverTurnPage`（`validateCursorCandidate`）の両方。
2. 位置の形は変えない。`history_floor` は今までどおり入れる（発行した時点の控えの下限の番号）。
   検証には使わない。0.15.0 以前が出した位置は、そのまま使える。
3. snapshot の返し方、`resync_required` を終了コード 0 で返すこと、page token の作りは変えない。

## Consequences

- 別の古い会話の控えが落ちても、今の会話の位置は有効なままで、`append`・`delta` が返る。
- 位置が指す会話そのものの先頭が落ちた時は、今までどおり `resync_required` になる。1 つの会話だけで
  控えが 256 件を超えると、その会話の位置は 1 ターンごとに無効になる。これを無くすには、位置を
  先頭からの digest ではなく控えの連番に結ぶ必要があり、位置の作りが変わるので、別に決める。
- `history_floor` だけを書き換えた位置は、先頭からの照合が合えば受け入れる。位置は認可の鍵ではなく
  （ADR 0003）、控えそのものと照合するので、読める範囲は変わらない。
- ADR 0003 の「cursor below `history_floor` … returns `resync_required`」は、この ADR で置き換える。
  「保持で失われたことを黙って隠さない」は、先頭からの照合で保つ。

## 確認した範囲

- `src/observer-turn-feed.test.mjs`: 古い会話の控えで上限まで埋まった project で、新しい会話のターンを
  1 つずつ足し、毎回 `append` と、足したターンだけの `delta` が返ること。同じ会話の先頭が落ちた時は
  `resync_required` になること。修理前のコードでは 2 件とも失敗する。
