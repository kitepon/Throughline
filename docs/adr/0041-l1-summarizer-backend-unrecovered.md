# ADR 0041: L1 要約 backend の失敗は、復帰を確認できない時だけ数える

日付: 2026-10-07

## Context

オーナーは、通信失敗の報告・重大度・担当の決まりを定めた（2026-10-07、BugHub の `NETWORK_REPORTING.md`）。
通信環境そのものの不調と、その状態への製品の対処不良を分ける。通常のオフライン、正常な取り消し、
適切に処理された一時的な失敗を、自動で製品の欠陥として登録しない。必要な診断は保持する。重大度は
エラーコードや回数だけで固定せず、機能停止・データの喪失・重複・復帰の可否を根拠に付ける。

Throughline が runtime error として数える code は7つで、通信の失敗が入るのは `L1_SUMMARIZER_BACKEND_FAILED`
（ADR 0028）だけだった。Codex Stop の要約は外部 CLI（`codex exec`）を呼ぶ。通信の断、利用上限、認証切れ、
model の失敗、利用者の取り消しによる停止で、CLI は非0で終わるか空を返す。0.16.3 までは、この失敗を
1回ごとに `warn` で数え、BugHub へ未解決の記録として送っていた。

この失敗への Throughline の対処は、次のとおり（ADR 0015・0016・0028）。

- 会話の取り込みは、要約の前に commit している。記憶は失われない。
- 要約は、次の Stop が同じ turn からやり直す。重複は作らない。
- L1 が無い間、recall は L2 の本文を返す。
- hook は終了 code 1 と stderr で失敗を示す。理由と外部 CLI の stderr の末尾は、端末の `hook-failures.log` に残る。

1回ごとの失敗は「適切に処理された一時的な失敗」に当たり、修理の対象として登録する物ではない。
一方、backend が使えないまま続く端末では、古い turn の要約が作られず、Codex の自動継続は要約を作れずに
止まる。この影響を隠さない。

他の通信の扱いは、次のとおりで、変えない。

- BugHub への送信の失敗（`unreachable` など）は、送信の状態（`runtime-errors report-status`）にだけ残し、
  runtime error には数えない。次の時機に、その時点の累計を送り直す。hook の結果は変えない。
- Claude Code の要約は、Codex CLI → Haiku → L2 の本文の、宣言済みの fallback。backend の失敗では throw せず、数えない。
- `self-update` の npm の失敗は、呼び出し元へ結果として返す。runtime error には数えない。
- hook 処理の失敗（`HOOK_*_FAILED`）の経路に、通信は無い。

## Decision

1. `L1_SUMMARIZER_BACKEND_FAILED` を、runtime error として数えるのをやめる。失敗の理由と stderr の末尾は、
   今までどおり `hook-failures.log` に、この code の名前で残す（端末内だけ）。hook の終了 code と stderr は変えない。
2. 端末ごとに、成功を確認できていない間の最初と最後の失敗の時刻を持つ
   （`~/.throughline/l1-backend-recovery.json`。会話の内容も失敗の文面も書かない）。
3. 最初の失敗から24時間を過ぎた後の失敗は、`L1_SUMMARIZER_BACKEND_UNRECOVERED` として数える。
   component は `codex_l1_summarizer`、template は
   `Throughline L1 summarizer backend (Codex CLI) has not recovered for over 24 hours`、severity は `warn`。
4. severity を `warn` にする根拠は影響。記憶は失われていない（取り込みは済み、recall は L2 を返す）。重複は無い。
   backend が戻れば、次の Stop で自動で復帰する。機能が止まるのは、Codex の自動継続が古い turn の要約を
   作れない時で、その時は5の画面が出て、入力と記録は残り、再開できる。
5. Codex の自動継続の worker は、要約の backend の失敗を、汎用の `handoff_worker_failed` ではなく
   `handoff_summarizer_backend_failed` で止める。失敗の画面に、通信の断・利用上限・認証切れで起きる事、
   記録と入力が失われていない事、backend が使える様になった後に旧タスクへ入力すると引き継ぎを始め直す事を書く。
6. backend が要約を返したら、2の記録を消す。3を数えていた時は、その記録を `recovered` で解決にする
   （製品の明示の解決。BugHub へは次の送信で届く）。復帰の後の失敗は、また最初から数える。
7. 前の版が `L1_SUMMARIZER_BACKEND_FAILED` を記録した store を読める様に、その定義は残す。
8. 送信の本文の形（BugHub の契約）は変えない。項目を足さない。

ADR 0028 の1（1回ごとに数える）と5（severity の根拠のうち、数える条件）は、この ADR で置き換える。
ADR 0028 の2（対象の error）・3（終了 code と stderr）・4（`hook-failures.log`）は変えない。

## Consequences

- 通信の一時的な断、利用上限、取り消しで要約が1回失敗しても、BugHub には何も出ない。端末の `hook-failures.log` で読める。
- backend が使えないままの端末は、最初の失敗から24時間を過ぎた後の失敗で、BugHub に `warn` の未解決として出る。
  これは「復帰を確認できていない」という事実で、原因が通信環境か、認証か、製品かは決めていない。
  記録の担当は Throughline の保守だが、通信環境や認証の修理は、その環境を管理する担当へ渡す。
- 「24時間」は、最初の失敗からの経過で見る。その間ずっと失敗し続けていた証明ではない（間に Stop が無ければ、
  試していない）。記録は成功で自動で解決になる。
- 要約が成功したかを見るのは、要約を実際に行った Stop だけ。20 turn 以内のスレッドの Stop は、復帰の証拠にしない。
- runtime error store は、知らない code を持つ記録を schema invalid として拒否する。この版で
  `L1_SUMMARIZER_BACKEND_UNRECOVERED` を記録した端末を 0.16.3 以前へ戻すと、store を読めなくなる。
- 0.16.3 までに `L1_SUMMARIZER_BACKEND_FAILED` を記録した端末の記録は、そのまま残る。書き換えない。
  保守の担当が、端末の正規の入口（`runtime-errors resolve`）で、根拠を付けて閉じる。

## 確認していない範囲

- 要約が失敗し続ける間、Codex の Stop hook は毎回 exit 1 になる。Codex の画面への影響は調べていない（ADR 0028 と同じ）。
- 本物の Codex CLI が、通信の断・利用上限・認証切れのそれぞれで、どの終了 code と stderr を返すか。
  試験は、非0で終わる代わりの CLI で行った。
