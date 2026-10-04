# Claude Code 自動継続（自動圧縮後の注入）の成立検証

- 実測日: 2026-10-04（Asia/Tokyo）
- 対象: Claude Code 2.1.289、Linux（BellTeam コンテナ）、model `claude-haiku-4-5-20251001`
- 設計: [ADR 0032](../docs/adr/0032-claude-compact-continuation.md)
- 状態: **`claude -p` と対話画面のそれぞれで、自動圧縮2回をまたいで作業が完了した。macOS・Windows、VS Code 拡張・Desktop、subagent の中の圧縮は確かめていない。**

## 条件

- 試験 project は scratch の空ディレクトリ。`--setting-sources project --settings <json>` で、試験用の hook だけを読ませた。
- hook は手元の作業ツリーの `bin/throughline.mjs` を、`HOME`・`XDG_CONFIG_HOME`・`XDG_STATE_HOME` を切り離して呼ぶ wrapper。
  本物の DB と runtime error store には書いていない。
- 自動圧縮を早く起こすため `CLAUDE_CODE_AUTO_COMPACT_WINDOW=100000`（設定できる最小値）を付けた。
  製品はこの変数に依存しない。
- 圧縮の発火は Claude Code 自身の判断で、hook の関数を直接呼んだ結果ではない。

## 判定

| 検証 | 判定 | 実測 |
|---|---|---|
| A: hook の順序と payload | 合格 | `PreCompact`（`trigger: "auto"`）→ 圧縮 → 同じ `session_id` の `SessionStart`（`source: "compact"`）→ `PostCompact`。Throughline 無しの hook でも、`SessionStart` の stdout に書いた合言葉をモデルが成果物へ書いた |
| B: `claude -p` での継続 | 合格 | 4ターン目で5ファイルを順に読む作業中に自動圧縮が2回（圧縮前 69,671 / 84,768 tokens）。どちらも注入（1,252 字）が `<system-reminder>` としてそのまま届き、追加の入力なしで残りを読み、`result.txt` を作って完了した。1ターン目で約束した1行目の文言も書かれた |
| C: 対話画面での継続 | 合格 | 14ファイルを順に読む1ターンの中で自動圧縮が2回（圧縮前 73,428 tokens が2回）。どちらも注入（859 字）が届き、入力なしで14個を読み切り、`result.txt` を作って完了を報告した |
| D: 予算に近い注入 | 合格 | 直前のターンの回答が 9,041 字の会話で、注入は 9,099 字。`<persisted-output>` に置き換わらず、全文が届いた |
| E: 保存 | 合格 | 圧縮をまたいだターンは、元の依頼と最終回答の1ターンとして保存された。L3 には圧縮より前の Read を含む全 tool 入力が入った（B: Read 4 + Write 1、C: Read 14 + Write 1）。C の `turn_start` は `prompt` |
| F: 依頼を送った直後の圧縮 | 合格 | 約7万字の依頼を送ると、最初の応答の前に自動圧縮が起きた。現在地にはその依頼（先頭から 4,000 字）が載り、前のターンを作業中とは扱わなかった。モデルは依頼の末尾の指示に正しく答え、そのターンは1ターンとして保存された。この回の後で、長い依頼の切り詰めを「先頭 3/4 と末尾 1/4 を残す」形に変えた（変更後は unit test で確認） |

注入の中身は `inheritance-decision.log` の `phase: "compact-continuation"` に残る。
B は `injected_l2_turns: 1 / remaining_l2_turns: 2`（9,041 字のターンが予算に入らず、そこで打ち切り。残りは `recall` の案内）、
C は `in_flight_fragments: 5` と `10`（圧縮のたびに、その時点までの発言の最後を現在地へ載せた）。

最終版のコード（`prompt_id` の照合と、長い依頼の先頭・末尾を残す切り詰めを足した後）でも、`claude -p` で
C と同じ14ファイルの作業を通した。自動圧縮2回（圧縮前 68,759 / 69,006 tokens）、注入はどちらも 887 字で
そのまま届き、`in_flight_unreadable: false`（実物の `prompt_id` と transcript の `promptId` は一致）、
圧縮直前の発言も現在地に載り、作業は完了して1ターンとして保存された。この回のモデルは、
「文脈に `## Throughline` で始まる見出しがあれば書け」という試験の問いには `NONE` と書いた
（B・C の回では見出しを書いた）。注入が届いたことは transcript の `hook_success` で確かめた。

## 試験条件で止まった回

1ファイルが約2万 tokens のファイルを、10万 tokens の窓で続けて読ませた回は、Claude Code が
`Autocompact is thrashing`（圧縮の3連続）で止まった。Throughline の hook を外した最初の試験でも、
圧縮直後の文脈は約 42,000 tokens あった（Claude Code は直前の読み込み結果を圧縮後も残す）。
注入が 861 字の回でも同じ結果で、試験ファイルの大きさが原因。この回でも、止まるまでの各圧縮の後は
注入が届き、作業は入力なしで続いた。

## 修正前の保存（比較）

修正前の `readTranscript` で、3回圧縮した1ターンの transcript を読むと、論理ターンは4つになった。
2つ目以降の user 発言は圧縮の要約（`This session is being continued from a previous conversation…`）で、
`turn_start` は全て `unknown`。修正後は1つで、断片の番号は `[1, 3, 5, 7]`（要約行の番号 2・4・6 を空けたまま）。
