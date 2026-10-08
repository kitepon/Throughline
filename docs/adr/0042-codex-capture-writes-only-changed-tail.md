# ADR 0042: Codex の取り込みは、L3 の変わった所から後ろだけを書く。WAL の大きさに上限を置く

日付: 2026-10-08

## Context

Codex の hook（UserPromptSubmit・PostToolUse・Stop・PreCompact）は、毎回 `captureCodexRolloutToDb` を呼ぶ。
0.16.4 までは、その会話の `bodies` と `details` を全部消し、rollout を読み直した結果を全部入れ直していた。
PostToolUse は道具を1回使うたびに走るので、会話が長いほど、1回の hook が会話全体と同じ量を WAL へ書く。

2026-10-08 に Windows の端末で次の状態を見た。

- `throughline.db` は 230MB。`throughline.db-wal` は 12.8GB。
- Codex の会話1つが、L3 に 3,552 行・約 1.47 億字を持つ（rollout は 288MB）。
- その会話の hook を、本物の DB の写しへ当てて測ると、1回で WAL へ 152.9MB を書いた。rollout に変化が無い時も同じ量を書く。
- hook が続く間、44 秒で wal-index が約 600MB 分伸びた。

WAL は、checkpoint が全部を本体へ書き戻し、読んでいる接続が無い時にだけ、先頭から使い直される。1回の
hook が百数十 MB を書き、別の会話の hook が続けて来ると、使い直す隙が出来ず、WAL は伸び続ける。また、
SQLite の既定（`journal_size_limit = -1`）では、一度伸びた WAL のファイルは、中身が空になっても縮まない。

rollout は追記で伸びる。普通の hook の間で変わるのは、L3 の末尾の数行だけ。

## Decision

1. `captureCodexRolloutToDb` は、`details` を次の形で書く。
   - DB にある行（`id` の順）と、rollout から作った行を、先頭から1行ずつ比べる。
   - 比べるのは `origin_session_id`・`turn_number`・`tool_name`・`kind`・`source_id`・`token_count`・`created_at` と、
     `input_text`・`output_text` の本文。本文は SQLite の中で比べる（`input_text IS ? AND output_text IS ?`）。
   - 最初に食い違った行から後ろを消し、rollout の同じ位置から後ろを入れる。食い違いが無ければ、増えた行だけを入れる。
2. 比べる前に、rollout から作った行を、DB に入る形へ揃える。同じ `source_id` の2件目は
   `uq_details_source` と `INSERT OR IGNORE` が捨てるので、先に除く。
3. rollout に時刻が無い行は、取り込んだ時刻が `created_at` に入る。その行は `created_at` を比べず、
   最初に取り込んだ時刻のまま残す。0.16.4 までは、取り込むたびにその時の時刻へ変わっていた。
4. `bodies` は、今までどおり全部消して入れ直す。会話の本文は小さい（上の会話で 98 行・約 7.7 万字）。
   `skeletons`（L1）の扱いも変えない。
5. `getDb()` は、開いた接続へ `PRAGMA journal_size_limit = 67108864`（64MB）を設定する。WAL が使い直された
   後の最初の commit で、SQLite がファイルを 64MB まで切り詰める。切り詰めに失敗しても、SQLite はその
   失敗を無視して書き込みを続ける。
6. `captureCodexRolloutToDb` の結果へ、`keptDetails`・`writtenDetails`・`removedDetails` を足す。

## Consequences

- 取り込んだ後の `details` の中身と並び（`id` の順）は、全部入れ直した時と同じになる。3 の `created_at` だけが違う。
- 変わっていない行の `id` は、hook をまたいで変わらなくなる。0.16.4 までは、毎回新しい `id` になっていた。
- 上の会話の写しで測ると、変化の無い hook が WAL へ書く量は 152.9MB から 0.3MB になる。89 行が増えた hook は 12.5MB。
- hook は、今までどおり毎回 rollout の全体を読む。上の会話では、読むのに約 1.1 秒、比べるのに約 0.3 秒かかる。
  本文を比べるために、DB にあるその会話の L3 を毎回読む。書く量は減るが、読む量は減らない。
- rollout の途中の行が変わった時（rollback の後など）は、その行から後ろを入れ直す。先頭の行が変われば、
  今までと同じく全部を入れ直す。
- 同じ会話の hook が2つ同時に走った時は、後で commit した方の rollout の読み取りが残る。今までと同じ。
- すでに伸びている WAL は、この版の接続が、使い直された WAL へ最初に commit した時に縮む。それまでは元の大きさのまま。
- `journal_size_limit` は接続ごとの設定で、DB には残らない。読み取り専用の接続（`openReadOnlyDb`）には設定しない。
- schema は変えない（v12 のまま）。

## 確認していない範囲

- WAL が使い直されない状態（checkpoint が終わる前に次の書き込みが来る状態）が、この版で実際に起きなくなるか。
  書く量が減った分、起きにくくなるが、本物の端末で複数の会話が同時に動いた時の WAL の大きさは、公開の後に読む。
- rollout を毎回全部読む時間が、Codex の画面で道具の後の待ちとして見えているか。
- Claude Code・Grok・Cursor の取り込みは、ターンごとに `INSERT OR IGNORE` で足す形で、この変更の対象ではない。
  これらの host の長い会話での書く量は測っていない。
