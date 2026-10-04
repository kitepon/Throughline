# Claude Code 自動継続（自動圧縮を止めて新しい会話へ引き継ぐ）の成立検証

- 実測日: 2026-10-04〜05（Asia/Tokyo）
- 対象: Claude Code 2.1.289、Linux（BellTeam コンテナ）、配送ライブラリ `aiterm-steer-delivery` 0.1.13
- 設計: [ADR 0033](../docs/adr/0033-claude-auto-handoff-new-session.md)
- 状態: **対話画面の会話から始めて、後継へ連続で引き継ぎ、最後の後継が作業を完了した。Haiku 4.5 で3回連続、Opus 5.5 で6回連続。どの会話でも自動圧縮は走っていない。macOS・Windows、Claude Desktop から始まる会話、Fable、subagent が動いている最中の引き継ぎは確かめていない。**

## 条件

- 旧い会話は、Aiterm の PTY で起動した対話の `claude`（`entrypoint: cli`）。後継は製品が `claude --bg` で立てた会話。
- hook は全体の設定（`throughline session-start`・`prompt-submit`・`process-turn`・`pre-compact`）と、試験 project の
  `.claude/settings.json` に置いた `throughline pre-tool-use`。`throughline` は PATH の先頭の wrapper で、手元の作業ツリーの
  `bin/throughline.mjs` を、`HOME`・`XDG_CONFIG_HOME`・`XDG_STATE_HOME` を切り離して呼ぶ。本物の DB と runtime error store には
  書いていない（試験の後、本物の store は0件のまま、本物の DB に試験の会話は無い）。
- 自動継続の設定は、切り離した置き場の `claude-auto-handoff.json`（試験 project だけ有効）。
- 自動圧縮を早く起こすため `CLAUDE_CODE_AUTO_COMPACT_WINDOW=100000`（設定できる最小値）を付けた。製品はこの変数に依存しない。
- 作業は「約6千 tokens のファイル14個を番号順に1つずつ読み、最後に `result.txt` を作る」。

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

## 残っていること

- 止めた会話（対話の会話も、途中の後継も）は、止まったまま一覧に残る。途中の後継は agent view で `working` と表示される。
- 止めたターンは Stop hook を通らないので、その tool 入出力は L3 に入らない。
- Claude Desktop から始まる会話で、同じ hook が同じに動くかは確かめていない（Desktop の会話本体は同梱の 2.1.286）。
