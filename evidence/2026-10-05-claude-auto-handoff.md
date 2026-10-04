# Claude Code 自動継続（自動圧縮を止めて新しい会話へ引き継ぐ）の成立検証

- 実測日: 2026-10-04〜05（Asia/Tokyo）
- 対象: Claude Code 2.1.289 と、Claude Desktop が同梱する本体 2.1.286。Linux（BellTeam コンテナ）と macOS 27.0。
  配送ライブラリ `aiterm-steer-delivery` 0.1.13
- 設計: [ADR 0033](../docs/adr/0033-claude-auto-handoff-new-session.md)
- 状態: **Linux と macOS で、対話の会話から始めて後継へ連続で引き継ぎ、最後の後継が作業を完了した。どの会話でも自動圧縮は走っていない。0.14.0 は macOS の Haiku で、後継が読み終えたファイルを読み直した。止めたターンを取り込む 0.14.1 で、同じ条件の読み直しは無くなった。Claude Desktop の画面から始めた会話、Windows、Fable、subagent が動いている最中の引き継ぎは確かめていない。**

## 条件

- 旧い会話は、Aiterm の PTY で起動した対話の `claude`（`entrypoint: cli`）。後継は製品が `claude --bg` で立てた会話。
- hook は全体の設定（`throughline session-start`・`prompt-submit`・`process-turn`・`pre-compact`）と、試験 project の
  `.claude/settings.json` に置いた `throughline pre-tool-use`。`throughline` は PATH の先頭の wrapper で、手元の作業ツリーの
  `bin/throughline.mjs` を、`HOME`・`XDG_CONFIG_HOME`・`XDG_STATE_HOME` を切り離して呼ぶ。本物の DB と runtime error store には
  書いていない（試験の後、本物の store は0件のまま、本物の DB に試験の会話は無い）。
- 自動継続の設定は、切り離した置き場の `claude-auto-handoff.json`（試験 project だけ有効）。
- 自動圧縮を早く起こすため `CLAUDE_CODE_AUTO_COMPACT_WINDOW=100000`（設定できる最小値）を付けた。製品はこの変数に依存しない。
- 作業は「約6千 tokens のファイル14個を番号順に1つずつ読み、最後に `result.txt` を作る」。

以下の「判定」は 0.14.0 の Linux の実測。macOS と 0.14.1 は、後ろの節に分けて書く。

## 判定

| 検証 | 判定 | 実測 |
|---|---|---|
| A: 圧縮を止める | 合格 | `PreCompact`（`trigger: auto`）で hook が exit code 2 を返し、圧縮は走らなかった。全ての会話の transcript に `compact_boundary` も要約行も無い。旧い会話の画面は `0% until auto-compact` のまま |
| B: 旧い会話を止める | 合格 | 圧縮を止めた直後の道具（次のファイルの Read）は実行されず、ターンが止まった。画面には hook の文（引き継ぎ ID と、後継が `claude agents` に出ること）が出た。止めた会話ごとに、止まった道具は1つ |
| C: 新しい会話を立てる | 合格 | worker が `claude --bg --name … --model … --effort … --permission-mode … --settings '{"worktree":{"bgIsolation":"none"}}'` を指示なしで実行し、指示を待つ会話が立った。モデル（`claude-opus-5-5`）・推論強度（`xhigh`）・権限（`acceptEdits`）を引き継いだ |
| D: 継続の指示を1通送る | 合格 | 後継の `SessionStart` が控えた受け口へ、`sendClaudeInbox` が1通送り、結果は毎回 `accepted`。後継の `UserPromptSubmit` が印（baton）を消費して前任を合流させ、作業ディレクトリ・止めた時点の依頼・直前の発言・直近の L2 を注入した |
| E: 続きを自分で始める | 合格 | 後継は入力なしで、止めた道具（次のファイル）から作業を続けた。読み飛ばしも、完了済みのファイルの読み直しも無い（止めた1個だけを後継が読む） |
| F: 連続の引き継ぎ | 合格 | Haiku: A→B→C→D（3回）。Opus: A→…→G（6回）。現在地の依頼は、最初の会話の依頼を最後まで運んだ。最後の後継が14個目を読み、`result.txt`（`完了` / `14`）を作って完了を報告した |

各会話が読んだファイル（Opus の回、止めた道具を含む）:

| 会話 | 読んだファイル | 止めた道具 |
|---|---|---|
| A（対話） | 01〜03 | 04 |
| B | 04〜05 | 06 |
| C | 06〜07 | 08 |
| D | 08〜09 | 10 |
| E | 10〜11 | 12 |
| F | 12〜13 | 14 |
| G | 14、`result.txt` を作成 | なし |

引き継ぎ1回（圧縮を止めてから、後継が最初の道具を呼ぶまで）は、Opus の回で約11〜12秒だった。

## 途中で直したこと

- 後継の中から `claude --bg` を実行すると、出力の ID に色の制御文字が付く。ID を読めず、2回目の引き継ぎを失敗扱いにしていた。
  制御文字を外してから読むようにした。
- hook の時点では、止めた道具の直前の発言が transcript に書かれていないことがある。止めた道具の呼び出しが transcript に
  書かれるのを worker が待ってから、依頼と直前の発言を読むようにした。
- Haiku は、注入した記憶に作業ディレクトリが無いと、ファイルをホームから読もうとして許可待ちで止まった。
  Codex 版と同じく、ヘッダに作業ディレクトリを書くようにした。
- 後継が止められた時の最後の user 発言は、前の引き継ぎの継続の指示になる。現在地には、前の引き継ぎが運んだ元の依頼を
  引き続き載せるようにした。

## 単体で確かめた入口（製品に組み込む前）

- `PreToolUse` が `continue: false` だけを返すと、その道具は実行されてから止まる。`permissionDecision: "deny"` を一緒に返すと
  実行されない（Haiku、`claude -p`）。
- `claude --bg` を指示なしで script から実行すると、`backgrounded · <id> · <name> (idle — send a prompt to start)` と出て、
  `SessionStart` が走る。
- 入力待ちの会話の受け口へ `sendClaudeInbox` で1通送ると、0.2秒で `accepted` が返り、`UserPromptSubmit` が走った。

## macOS（2026-10-05 00:26〜01:09）

macOS 27.0、Node 26.10。試験用フォルダの中に npm の package を入れ、`HOME`・`XDG_CONFIG_HOME`・`XDG_STATE_HOME` を
切り離した wrapper を PATH の先頭に置いた。hook は試験用フォルダの `.claude/settings.json` に置いた
`throughline pre-compact` と `throughline pre-tool-use`、全体の設定の3つ（wrapper へ解決される）。
利用者の本物の DB と設定には書いていない（試験の後、本物の DB に試験の会話は無く、全体の設定の hook は3つのまま）。
旧い会話は Aiterm の PTY で起動した対話の `claude`。後継は、Homebrew の `claude`（2.1.289）の `claude --bg`。

| 回 | 版 | 始めた会話 | モデル | 引き継ぎ | 結果 |
|---|---|---|---|---|---|
| 1 | 0.14.0 | 端末の 2.1.289 | Haiku 4.5 | 4回 | 完了。読み直し無し |
| 2 | 0.14.0 | 端末の 2.1.289 | Opus 5.5（medium） | 7回 | 完了。読み直し無し。最後の引き継ぎは `result.txt` の Write を止め、後継が作った |
| 3 | 0.14.0 | Desktop 同梱の 2.1.286（端末から起動） | Haiku 4.5 | 7回 | 完了。**後継2つが読み終えたファイルを読み直した** |
| 4 | 0.14.1 | Desktop 同梱の 2.1.286（端末から起動） | Haiku 4.5 | 4回 | 完了。読み直し無し |
| 5 | 0.14.1 | Desktop 同梱の 2.1.286（端末から起動） | Opus 5.5（medium） | 7回 | 完了。読み直し無し |

- 5回とも、全ての会話の transcript に圧縮の記録は無い。止めた道具は実行されていない。
- 圧縮を止めてから、後継が継続の指示を受け取るまでは 3.3〜6.1 秒。
- 3〜5 回目は、圧縮の窓を試験用フォルダの設定の `env`（`CLAUDE_CODE_AUTO_COMPACT_WINDOW`）で指定した。
  2.1.286 と 2.1.289 のどちらも、設定の `env` の値で自動圧縮の時機が変わった。
- 3回目の後継の1つは、同じ応答で Read を4つ並べて呼んだ。4つとも実行されずに止まり、引き継ぎは1回だけ起きた。
- 推論強度（`medium`）は、Opus の回で後継へ引き継がれた。

### 3回目の読み直しの原因（0.14.0）

後継へ渡した記憶は正しく「止める直前の発言: part06 を読みました。」を持っていた。足りなかったのは、止めたターンで
そこまでにしたことだった。

- 完了したターンの本文（L2）は最後の発言だけを残す。止めたターンも同じ扱いで、後継の記憶には
  「part03 を読みました。」「part06 を読みました。」のように、引き継ぎごとの最後の発言だけが並んだ。
- 止めたターンは Stop hook を通らないので、道具の入出力（L3）はどこにも保存されなかった。
  後継の1つは `throughline detail` を実行したが、最後の発言しか返らず、part01 から読み直した。
- 別の後継は「読み終わった: part02、part03、part05、part06」と数えた。記憶に載っていた発言そのままの数え方だった。
- Opus は同じ記憶から、連番の続きを推測して正しく進んだ。

Codex の自動継続は、止めたターンを DB へ取り込んでから記憶を作る。0.14.0 はこの段を写していなかった。

### 0.14.1 の記憶（4・5回目）

- worker が、後継を立てる前に止めたターンを取り込む。本文は発言を全部つないだもの、詳細は止めた道具の呼び出しまで。
  どの引き継ぎでも取り込みは成功した（記録の `in_flight.turn`、詳細は1ターン 24〜36 行）。
- 現在地に「このターンでここまでにしたこと」（発言と道具の呼び出し）と「実行されなかった道具」が載った。
  止めた道具は `Read part04.txt` のように、作業フォルダからの相対で載る。
- 切り離した置き場で `throughline detail <止めたターンの時刻>` を実行し、発言の全部と Read の入出力が返ることを確かめた。
- Linux（コンテナ、2.1.289、Haiku 4.5）でも 0.14.1 を通した。2回の引き継ぎで完了し、読み直しは無い。

### macOS で起きた副作用

Desktop 同梱の本体（2.1.286）を端末から起動すると、起動時に自動更新が走り、`~/.local/bin/claude` と
`~/.local/share/claude/versions/2.1.289` を作った（native install）。試験の手順が起こした変更で、製品の動作ではない。
同梱の本体を端末から起動する試験は、利用者の環境を変える。

## 残っていること

- 止めた会話（対話の会話も、途中の後継も）は、止まったまま一覧に残る。途中の後継は agent view で `working` と表示される。
- Claude Desktop の画面から始めた会話で、同じ hook が同じに動くかは確かめていない。同梱の本体 2.1.286 を端末から
  起動した会話では動いた。Desktop が本体を起動する時の環境（PATH、`CLAUDE_CODE_ENTRYPOINT=claude-desktop`）での動作は未確認。
- Windows は確かめていない。
