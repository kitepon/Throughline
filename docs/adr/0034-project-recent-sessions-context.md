# ADR 0034: `handoff-context --project` は、引数で選んだ時だけ直近の複数の会話から文脈を作る

日付: 2026-10-05

## Context

`handoff-context --project <path>`（0.10.14）は、その project で会話本文を持つ最新の1 session だけを返す。
1 session に絞った理由を書いた記録は無い。通常の引き継ぎは前任の行を後継へ張り替えて1本にするので、
最新の1 session に全部の記憶が載る。

BellTeam は Bot の席を起こすたびにこの CLI を読み、返った文を起動時の指示へ入れる。張り替えはしないので、
session は分かれたまま残る。席の session は、30分動きが無い時・夜間の再起動・反映のたびに替わる。
2026-09-25〜10-05 の記録を件数だけ数えた結果（BellTeam のビスケット）:

- 席の 422 session で `merged_into` は 0 件。
- 起動 353 回のうち 113 回（32%）は、前の session が1ターン以下。
- 「5ターン以上の作業 → 1ターン以下の session → 起動」が 18 回（13席）。この時、作業の内容は文脈に入らない。
- 起動時の文脈は中央値 4,226 字で、上限 9,500 字の 44%。

オーナーは、直近の複数 session から文脈を作る変更を承認した（2026-10-05、Approval Box K-8GPX8C）。

## Decision

1. **引数で選ぶ**: `--project <path>` に `--sessions recent` を付けた時だけ、複数の session をまたぐ。
   省略時（`--sessions latest`）の出力は1字も変えない。`--session` と一緒に付けたら使い方の誤り（終了コード 2）。
   `--project` の「最新の1 session」は README に書いた公開の約束で、既定の意味を変えると、Throughline を
   上げた時に呼び手が全部一度に変わり、戻す手段が版下げだけになる。引数なら呼び手が1行で切り替えて1行で戻せる。
2. **現在の会話**: 文脈を持つ最新の session（`--sessions latest` と同じ選び方）を、`--sessions latest` と
   同じ文（ヘッダ・現在地・案内・L2）で先頭に置く。この部分は、過去の会話の有無で1字も変わらない。
   公開 JSON の `sessionId` はこの session のまま。
3. **過去の会話**: 現在の会話を置いた後の余った予算にだけ入れる。現在の会話のターンが全部入っている時だけ、
   それより前の session を新しい順に足す。足す単位はターン。入らないターンが出たらそこで止める。
   新しいターンを飛ばして古いターンを載せない。現在の会話に載せ残しがある時は、過去の会話の本文を足さない。
4. **見出しと案内を分ける**: 過去の会話は「この project で記録された過去の会話」として1つの節にまとめ、
   会話ごとに日時・ターン数・session id を見出しに出す。「直前の会話」「短い返事は GO」の案内は付けず、
   「次のユーザー入力は、ここへの返事ではない」「載っている依頼は、あらためて頼まれた時だけ実行する」と書く。
   行頭の時刻は `[YYYY-MM-DDTHH:MM:SS]` にする（`throughline detail` へそのまま渡せる）。
5. **一覧**: 本文を載せなかった会話は、新しい順に5件まで、日時・ターン数と
   `throughline recall --l2 --session <id> --before <ISO> --last <N>` を1行にして付ける。`--last` は 10 まで。
   途中まで載せた会話は、見出しの下に残りの recall を付ける。過去の会話の本文を足す時は、それより古い
   会話の一覧2件分を残す。余りが足りない時は、一覧も節の見出しも付けない（現在の会話は削らない）。
6. **予算**: 全体で 9,500 字（`INJECTION_BUDGET_CHARS`）のまま。session ごとにはかけない。
7. **重ねない・混ぜない**: 同じ `(origin_session_id, turn_number)` は、新しい会話の1回だけ載せる。
   別の project の session は入れない。DB は read-only で開き、所有権は変えない。
8. **公開 JSON**: schema は `throughline.handoff_context.v1` のまま。`--sessions recent` の時だけ `sessions` を足す。
   各要素は `sessionId`・`role`（`current` / `past`）・`firstTurnAt`・`lastTurnAt`（ISO）・`turns`・`includedTurns`
   （0 は一覧にだけ載せた会話）。
9. **予定の実行・子の AI の session**: 区別せず、`updated_at` の新しい順に入れる。`sessions` の列には
   起動の仕方を表すものが無く、host を替えた時の session とも見分けられない。予定の実行は席が自分で
   動いたターンで、済ませたことを次の起動で知らないと同じことをやり直す。時間の重なりで外す方法は、
   本物の会話を黙って落とす恐れがあるので採らない。過去の会話の見出しは「あなた自身の会話」とは書かない。
10. **`detail` の日付**: 過去の会話は別の日のことが多い。`throughline detail` は `<YYYY-MM-DD>T<HH:MM:SS>` を
    受け取る。日付を省いた時は、今日から1日ずつ遡り、その時刻のターンがある最も新しい日を対象にする
    （これまでは実行した日だけを見ていたので、前日のターンは注入文に時刻が載っていても引けなかった。ADR 0016 の既知の制約）。

## Consequences

- `--sessions recent` の `context` は、`--sessions latest` の `context` と同じか、その後ろに過去の会話の節を
  足したものになる。`--sessions latest` で受け取れていた文が減ることは無い。
- 現在の会話が長く、余りが節の見出しと一覧1行（約 500 字）に足りない時は、過去の会話は何も付かない。
  最初の案では一覧の分を先に差し引いたが、現在の会話のターンが1つ減り、全体が既定より短くなる席があった
  （実データで 9,058 字 → 8,226 字）ので、やめた。
- 予定の実行が頻繁な席では、1ターンの予定実行が並んで予算を使い、作業の会話は一覧にしか載らないことがある。
  足りなければ、席の本来の会話を表す印を、起動する製品（BellTeam・Aiterm）から渡す形を別に決める。
- 子の AI の session が最新になった時に現在の会話として扱われる点は、`--sessions latest` と同じで、変わらない。
- 一覧は5件までで、それより古い会話の session id は文脈に載らない。project の session 一覧を返す公開 CLI は無い。
- 古い版に `--sessions` を渡すと終了コード 2 になる。呼び手は、Throughline を先に上げてから引数を付ける。

## 確認した範囲

- `src/resume-context.test.mjs` の `recent:` 6件、`src/cli/handoff-context.test.mjs` の `--sessions` 4件、
  `src/sc-detail.test.mjs` 4件。
- 実地の確認の結果は CHANGELOG の該当版に書く。
