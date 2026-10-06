# ADR 0036: DB を開いた最初の読み取りは、`disk I/O error` の間だけ読み直す

日付: 2026-10-07

## Context

Windows（0.15.4、2026-10-07）で、UserPromptSubmit の hook が2回 `disk I/O error` で落ちた。落ちた位置は
`getDb()` の中の最初の読み取り（`db.prepare('PRAGMA journal_mode')`）だった。Cursor の会話が約10秒おきに
ターンを回している最中で、Cursor は同じ hook を2本ほぼ同時に起動する。

同じ端末の切り離した置き場で再現した。DB を開いて読み、**閉じずに `process.exit` で終わる**短命の process を
6列で続けると、5,295 本のうち 128 本（約2%）が同じ位置・同じ文面で落ちた。node:sqlite の拡張 code は
1546（`SQLITE_IOERR_TRUNCATE`）。読み取り専用で開いた process は、4,059 本のうち 217 本が落ちた。
Linux（Node 26）では 1,398 本で 0 本。process の中で開いて閉じるのを繰り返す形（閉じてから次を開く）では、
Windows でも 8,906 回で 0 回だった。

SQLite は WAL の索引（`-shm`）を開く時、他に接続が無いと見ると索引を 0 バイトへ切り詰める。Windows は、
他の process が map したままのファイルを切り詰めさせない。閉じずに終わった process の片付けと、次の process の
最初の読み取りが重なると、この切り詰めが断られる、と読める（Windows のどの API がどの code で断ったかは、
node:sqlite からは取れないので確かめていない）。Throughline の hook は DB を閉じずに `process.exit` で終わる。

失敗した読み取りを同じ接続で読み直すと、同じ再現で 5,180 本とも開けた。読み直したのは 139 本、
最大2回、最長 74ms だった。接続を閉じて開き直す形でも同じ結果だった（5,227 本、最長 87ms）。

2026-10-04 に同じ端末（0.12.4）で起きた SessionStart と UserPromptSubmit の失敗（ADR 0031 の Consequences で
「原因は分かっていない」とした分）は、UserPromptSubmit が今回と同じ記録（fingerprint）に数えられている。
0.12.4 は理由を端末に残さなかったので、同じ形だったとは確かめられない。

## Decision

1. `src/db.mjs` に `settleFirstRead(db, { timeoutMs })` を置く。`PRAGMA user_version` を読み、
   SQLite の `disk I/O error`（拡張 code の下位 8 bit が 10）で断られたら 25ms 待って読み直す。
   既定の期限は `busy_timeout` と同じ 5 秒。期限まで解けなければ、同じ失敗をそのまま返す。
2. 他の失敗は読み直さない。lock の待ちは今までどおり `busy_timeout` が受け持つ。
3. Throughline の DB を開く所は、開いた直後にここを通す: `getDb()`、`openReadOnlyDb()`、`migrateDefaultDb()`、
   `auditor-context`（2か所）、`caveat-context`、`factory-diagnostics`、`recall`。hook の途中で呼ばれる
   `caveat-context` と Observer 向けの読み出しは、それぞれの `busy_timeout` と同じ 1 秒を期限にする。
4. hook は今までどおり DB を閉じずに終わる。終わる時に閉じると、最後の接続が checkpoint と WAL の削除を
   行い、hook の終了が遅くなる。host に止められた process は閉じられないので、閉じる側だけでは無くせない。
5. `hook-failures.log` に、node:sqlite が付ける拡張 code（`errcode`）を残す。`disk I/O error` は文面が同じでも
   code で原因が分かれる。

## Consequences

- Windows で同じ hook が続けて走る会話でも、DB を開く所で落ちなくなる。重なった時は 25〜100ms ほど待つ。
- 本当に読めない DB（壊れたディスクなど）では、失敗が返るまで期限の分だけ待つ（hook は最長 5 秒）。
  今までは即座に失敗していた。
- Codex の状態 DB など、他の製品の DB を読む所（`codex-restore-source-audit`）と、lock 用の小さな DB
  （WAL を使わない）は変えていない。
- macOS と Linux では、この失敗は元から起きていない。読み取りが1回増えるだけで、動きは変わらない。
