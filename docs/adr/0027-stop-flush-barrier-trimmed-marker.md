# ADR 0027: flush barrier は marker と本文を前後の空白を除いて比べ、hook 失敗の理由を端末内に残す

日付: 2026-10-04

## Context

ADR 0012 の flush barrier は、Stop payload の `last_assistant_message` と transcript の本文が
完全に一致するまで最大2秒待ち、一致しなければ `HOOK_PROCESS_TURN_FAILED` で明示失敗する。

Claude Code は `last_assistant_message` を、最後の assistant message の text block を改行でつないで
`.trim()` した値として渡す（Claude Code の実装で確認）。transcript には trim する前の本文が残る。
本文が空白や改行で始まる（終わる）turn は、transcript が出そろっていても一致しない。

Mac の runtime error store には `HOOK_PROCESS_TURN_FAILED` が 679 回あり、最後は
2026-08-31T13:16:06.049Z だった。その turn の transcript は次の並びだった。

```text
13:16:02.150  assistant の最終行（end_turn）。本文は半角空白で始まる
13:16:04.195  stop_hook_summary（同期 hook の終わり。Stop hook の開始は 13:16:03.9 ごろ）
13:16:06.049  HOOK_PROCESS_TURN_FAILED（開始から 2.1 秒後。backfill.log に行は無い）
```

この transcript をその時点で切り、trim した marker で Stop を再生すると、0.10.3・0.12.1・0.12.4 の
どれも 2.1 秒後に `Claude Stop transcript completion was not visible before deadline` で失敗した。
Mac に残る 2026-08-02 以降の transcript では、本文が空白で始まる Stop が8月に 96 回あり、
96 回とも backfill.log に対応する行が無かった。9月以降は、空白で始まる本文が1回も無い。

原因を調べる時、失敗の理由はどこにも残っていなかった。runtime error store は外へ送れる形
（定型 code と回数）だけを持つ（ADR 0025）。Claude の Stop hook は `async: true` なので、
stderr は transcript の `stop_hook_summary` にも残らない。Mac の Codex hook 1151 回と
SessionStart 38 回、main-server の 2026-07-20 の Stop 4 回は、発生時刻と回数しか分からなかった。

## Decision

1. flush barrier は、marker と transcript の本文を、どちらも前後の空白を除いてから比べる。
   latest group と、ADR 0026 の1つ前の group の両方に同じ比べ方を使う。
2. 途中の空白は比べる対象に残す。前後の空白以外が違う本文は一致させない。
3. 空白だけの marker は、marker が無い時（ADR 0012 Decision 5）と同じに扱う。
4. 本文の正本は transcript のまま。DB と完了受領には trim しない本文を書く（ADR 0012 Decision 2）。
5. hook が失敗した時、理由を `~/.throughline/logs/hook-failures.log` へ1行の JSON で追記する。
   項目は `ts`・`code`・`version`・`name`・`message`（1000 字まで）。
6. このログは端末内にだけ置く。runtime error の収集・送信の設定とは独立に書き、外へは送らない。
   runtime error store と report の形（ADR 0025）は変えない。
7. ログの書き込みに失敗した時は stderr へ理由を出す。hook の終了コードは元の失敗のまま変えない。

## Consequences

- 本文が空白や改行で始まる（終わる）turn の L2・完了受領・L3 が、同じ Stop で書かれる。
- 「過去の同文 answer を今回の完了と取り違えない」条件（ADR 0012 Decision 3、ADR 0026）は変わらない。
  前後の空白だけが違う2つの本文は同文として扱うが、どちらの条件も group の位置と捕捉済みかで決まる。
- 次に hook が失敗した時、時刻・code・版・理由が端末に残る。`runtime-errors snapshot` の回数と
  突き合わせて原因を追える。
- `message` には例外の文面が入る。path を含むことがあるので、ログを端末の外へ出す時は読んで確かめる。
- ログの大きさに上限は設けていない。失敗した時だけ1行増える。

## 確認できていないこと

- Mac の 679 回のうち、空白が原因と確かめたのは transcript が残る 96 回と最後の1回。Stop 直後に次の入力が
  届いた回（ADR 0026、0.12.2 で修理）と、それ以外の回の内訳は、当時の理由が残っていないので分からない。
- Claude Code が1つの assistant message に text block を複数持たせた時、marker は block を改行でつなぎ、
  Throughline は block をそのままつなぐ。transcript では1行に1 block で書かれていて、複数 block の行は
  確認していない。
