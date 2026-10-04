# ADR 0012: Claude Stop receiptの前にtranscript flush barrierを置く

日付: 2026-07-16

## Status

Accepted for implementation。Observer queue 19eを保持し、次のlive turnより先に修理する。

## Context

実Claude turnはassistant `end_turn`、Stop hook 4本・hook error 0、Throughline state更新まで成立したが、
hook実行時の最新sessionにはuser／assistant bodyがなくcompletion receiptも作られなかった。同じtranscriptを
turn後に現行parserで読むとlatest logical groupは1件だった。Claudeのasync Stop hookがfinal assistant行の
永続化可視化より先に一度だけtranscriptを読み、`lastTurnNumber === null`で正常no-opしたflush raceである。

## Decision

1. Stop payloadに非空`last_assistant_message`がある場合、latest user groupの非junk assistant本文が
   その値と一致するまで短いbounded intervalでtranscriptを再読する。
   （2026-10-04 [ADR 0027](0027-stop-flush-barrier-trimmed-marker.md)で、前後の空白を除いて比べることにした。Claude Codeはmarkerを`.trim()`して渡す。）
2. `last_assistant_message`はcompletion identity／flush barrierにだけ使い、L2本文やreceipt digestの
   ソースにはしない。本文は従来どおりtranscriptからDBへcommitしたpairだけを使う。
3. latest user groupを必須にし、過去の同文assistantや前turnを一致として採用しない。
   （2026-10-03 [ADR 0026](0026-stop-flush-barrier-next-user.md)で、Stop直後に次のuser行が届いた時の未捕捉の1つ前のgroupだけを例外にした。）
4. deadlineまで一致しなければ明示errorと`HOOK_PROCESS_TURN_FAILED`を返し、completionなしへ丸めない。
   （2026-10-04 [ADR 0029](0029-stop-flush-barrier-absent-transcript.md)で、deadlineまでtranscriptのファイル自体が無い時だけ、失敗に数えず`transcript_absent`として見送ることにした。）
5. markerを持たない旧Claude hostは既存one-shot transcript parser契約を維持する。
6. Claude Stop hookの`async: true`、DB schema、receipt wire、Observer cursorは変更しない。

## Acceptance

- user行だけの状態でhookを開始し、assistant行を遅延appendしても同じ実行でbody pairとreceiptを作る。
- 過去turnのassistantがcurrent markerと同文でも、latest userが未完なら待機し、誤ったpairをpublishしない。
- marker不一致のdeadlineはexplicit failureになり、runtime error ownerは一回だけ記録する。
- 通常同期flush、markerなし旧payload、複数turn backfillの既存挙動を維持する。
