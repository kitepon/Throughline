# Claude Code 自動継続（自動圧縮を止めて新しい会話へ引き継ぐ）の成立検証

- 実測日: 2026-10-04〜05（Asia/Tokyo）
- 対象: Claude Code 2.1.289 と、Claude Desktop が同梱する本体 2.1.286。Linux（BellTeam コンテナ）、macOS 27.0、Windows 11（10.0.26200）。
  配送ライブラリ `aiterm-steer-delivery` 0.1.13
- 設計: [ADR 0033](../docs/adr/0033-claude-auto-handoff-new-session.md)
- 状態: **Linux・macOS・Windows で、対話の会話から始めて後継へ連続で引き継ぎ、最後の後継が作業を完了した。どの会話でも自動圧縮は走っていない。0.14.0 は macOS の Haiku で、後継が読み終えたファイルを読み直した（0.14.1 で修理）。0.14.1 は Windows で、後継に記憶が入らなかった（0.14.2 で修理）。Claude Desktop の画面から始めた会話、Fable、subagent が動いている最中の引き継ぎは確かめていない。**

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

## Windows（2026-10-05 01:27〜01:34）

Windows 11（10.0.26200）、Node 24.20、Claude Code 2.1.289（npm の入口）、Haiku 4.5。試験用フォルダの中に package を入れ、
`USERPROFILE`・`HOME`・`LOCALAPPDATA`・`XDG_CONFIG_HOME`・`XDG_STATE_HOME` を切り離した wrapper を PATH の先頭に置いた
（hook は Git Bash で走るので sh の wrapper）。worker が後継を立てる時に呼ぶ `claude` は、切り離した値を本物へ戻してから
本物の入口を呼ぶ wrapper。端末の本物の Throughline（0.12.9）と設定には書いていない。
旧い会話は Aiterm の PTY（Git Bash から `pwsh` 経由）で起動した対話の `claude`。

| 回 | 版 | 引き継ぎ | 結果 |
|---|---|---|---|
| 1 | 0.14.1 | 1回 | **後継に記憶が入らなかった。** 配送の結果は `unknown`（`handoff_delivery_timeout`） |
| 2 | 0.14.2（公開前の同じ内容） | 4回 | 完了。読み直し無し。圧縮の記録無し |

- 1回目でも、圧縮を止める（exit code 2）、道具を止める、`claude --bg` で後継を立てる（`--settings` の JSON はそのまま届いた）、
  後継の受け口（named pipe、token あり）へ継続の指示を送る、止めたターンを取り込む、の5つは動いた。
  後継の transcript に継続の指示は届いていた。
- 1回目の原因: 圧縮を止める hook が残した印の project は `C:/Users/kite_/tl-claude-probe/proj`
  （Git Bash で走る hook の `CLAUDE_PROJECT_DIR`）。後継の最初の指示は、payload の cwd
  `C:\Users\kite_\tl-claude-probe\proj` で印を探した。判定の記録は `baton_skip_reason: "missing"`。
  記憶が入らないので受領も記録されず、配送ライブラリは受領を確認できないまま時間切れになった。
  後継は記憶を持たずに動き、端末の中を調べ始めて、許可待ちで止まった。
- 2回目: 印と記録の project を OS の書き方にそろえた。4回とも配送は `accepted`、圧縮を止めてから受領まで 4.0〜4.5 秒。
  「実行されなかった道具」は `Read part04.txt` のように相対で載った。

## 残っていること

- 止めた会話（対話の会話も、途中の後継も）は、止まったまま一覧に残る。途中の後継は agent view で `working` と表示される。
- Claude Desktop の画面から始めた会話で、同じ hook が同じに動くかは確かめていない。同梱の本体 2.1.286 を端末から
  起動した会話では動いた。Desktop が本体を起動する時の環境（PATH、`CLAUDE_CODE_ENTRYPOINT=claude-desktop`）での動作は未確認。
- Windows は Haiku 4.5 だけで確かめた。

## Claude Desktopの画面（2026-10-06）

**0.15.4で、Desktopから最初の後継への記憶注入と作業完了を確認した。フォルダを選んで始めた会話では3回連続で引き継いだ。**

前の節は10月4〜5日の端末試験の記録で、この節は10月6日10:00〜10:02 JSTの追加受入である。
macOS 27.0、Desktop同梱のClaude Code 2.1.286、後継はHomebrewの2.1.289。
モデルは画面で選択済みのOpus 5.5、推論強度はhigh。製品の継承設定をそのまま検証した。
公開されたThroughline 0.15.4を使い、試験用projectだけ自動継続を有効にした。
圧縮の窓はproject設定の`CLAUDE_CODE_AUTO_COMPACT_WINDOW=141000`。

| 始めた会話 | 権限 | 引き継ぎ | 記憶注入 | 実際の作業結果 |
|---|---|---|---|---|
| フォルダなしで始め、後から試験projectへ移動した既存会話 | bypassPermissions | 1回 | 最初の後継に5,718字。`merged:true`、`merge_skip_reason:null`、`sent`、受領あり | part06〜09を順に1回ずつReadし、result4.txtに「再読完了」、FINISHED-4 |
| 画面で最初から試験projectを選んだ新会話 | auto | 3回 | 各後継に6,906 / 7,471 / 7,832字。全て合流・受領済み | part01〜14を順に1回ずつReadし、result5.txtに「DESKTOP-FOLDER-OK」/「14」、FINISHED-5 |

新会話の起動場所はDesktopの`Starting local session … in <試験project>`で確認し、
transcriptの`relocated`は0件だった。読み取りの成功した道具と結果を会話の鎖に沿って照合した。
途中で止めたReadはpart04、part09、part14で、それぞれ次の後継が最初に実行した。
読み飛ばし・完了済みファイルの読み直し・制限付きRead・重複Writeは無かった。
両ケースの今回の実行範囲に圧縮記録・`Held peer message`・権限待ちは無く、
`hook-failures.log`も無かった。runtime errorのopenは0件だった。

### 試行の経緯と証明範囲

- 移動済み会話への最初の指示では、モデルが過去2回の停止を理由に道具を呼ばずに終了した。
  `PreCompact`は引き継ぎを要求したが、仕様どおりStopで取り下げられ、後継は作られなかった。
  更新済みであることと今回のReadを実際に呼ぶことを画面から指示し、次の試行で注入と完了を確認した。
  この実機試験だけで、Stopを挟まない移動直後のDB更新まで独立に証明したとはしない。
- フォルダ選択済みの新会話は、前試験の後継が残したbatonにより、その記憶も最初に引き継いだ。
  過去の記憶が無い会話としての試験ではない。フォルダを移さずに起動し、新しい依頼を連続継承して完了したことを証明する。
- Linux・Windowsの追加試験、Fable、subagent実行中、既定の圧縮容量は今回の対象に含めていない。
- Jevの画面操作は対象選択で停止した。画面で対象会話と入力を確認し、agent-desktopの標準キーボード操作で入力・送信した。
  会話の受け口へ外から文は送っていない。

[実測JSON](2026-10-06-claude-desktop-acceptance.json)に会話の鎖、引き継ぎID、設定、注入量、
成功したRead/Write、結果のhashと判定を保存した。元のtranscriptと引き継ぎ記録は端末のprivate cacheに控えた。
試験後は自動継続を無効に戻し、今回立てた4つの後継を停止・削除した。
全体のClaude設定は試験前とバイト単位で一致する。Desktopの利用者の会話と試験用フォルダは残した。

### 完了した後継をDesktopで開く

利用者の質問を受け、停止済みの最後の後継`fb9f06b4-588e-4ee1-bb21-cf92235d851c`を、
`claude --desktop --resume <session-id>`で開いた。新しい会話や追加のモデル応答は作っていない。
Desktopの画面で、題名「tl-tl-claude-probe-3eacc0af」、引き継ぎの指示、part14の再開、
`FINISHED-5`、結果ファイルへのリンク、完了報告を確認した。同じsessionIdが`kind:interactive`で登録された。
Desktopへの自動表示と、実行中の後継のDesktop表示は確認していない。
公式仕様は[一次ソース抜粋](../rag/01-hooks/raw/claude-desktop-session-open-extract.md)を参照する。

## macOSの端末、0.16.7（2026-10-08 21:43〜21:48）

利用者の端末で全projectへ有効にする前に、入っている公開版（0.16.7）と本物のDB・設定のまま、試験用フォルダだけで有効にして流した。
Claude Code 2.1.289（Homebrew）、Haiku 4.5、`CLAUDE_CODE_AUTO_COMPACT_WINDOW=141000`（試験用フォルダのproject設定）。
端末の対話画面へ指示を1回送った後は、何も操作していない。

| 回 | 権限 | 指示 | 引き継ぎ | 結果 |
|---|---|---|---|---|
| 1 | acceptEdits | part01〜14を順にRead | 1回（21:44:34、旧い会話は114,444 tokens） | 21:44:59 に結果ファイル |
| 2 | bypassPermissions | part01〜14を2周（28回） | 2回続けて（21:46:23、21:46:54） | 21:47:12 に結果ファイル |

- 引き継ぎの記録は3つとも`sent`、`error_code`なし。5つのtranscriptに圧縮の記録は無い。
- 旧い会話は、次のReadで`PreToolUse:Read hook stopped continuation`になり、止めた理由と引き継ぎIDが画面に出た。
- 後継の名前は`tl-claude-probe｜<前任の題>（自動引き継ぎ）`。2回目の後継でも、project名と印は重なっていない。
- `hook-failures.log`は無く、実行時エラーのopenは0のまま。
- 試験の後、後継3つを`claude stop`・`claude rm`で消した。

## 後継をClaude Desktopへ開く（macOS、2026-10-08 21:53〜22:03）

設計は[ADR 0043](../docs/adr/0043-claude-successor-opens-in-desktop.md)。Claude Code 2.1.289、Claude Desktop 2.26454.2、Haiku 4.5。

### 裏の会話をDesktopへ移せる状態

`claude --bg`で立てた会話1つを、3つの状態で`claude --desktop --resume <session-id>`へ渡した。

| 状態（`claude agents`） | 結果 |
|---|---|
| 作業中（`status: busy`） | 断られた（`That session is running in the background`、終了code 1） |
| ターンを終えた手すき（`status: idle`） | 同じ理由で断られた |
| `claude stop <id>`の後 | 開いた（`Opening session <id> in Claude Desktop`、終了code 0） |

- 開いた時、Desktopのログに`Resume deep link: importing CLI session <id>`、`Imported CLI session <id> as Desktop session local_<id>`が出た。
  Desktopの会話の置き場に`local_<id>.json`（`adoptedFromOtherSurface: true`）が出来た。
- 出力を端末以外へ向けると`--desktop … can't run non-interactively (… or redirected output)`で動かない。
  `script -q /dev/null claude --desktop --resume <id>`は、端末の無いprocess（`nohup`、標準入力は`/dev/null`、出力はファイル）からも通った。
- sshの中からは`--desktop requires signing in with a Claude account`で断られる（利用者のログインの中で動かす必要がある）。

### 引き継ぎからDesktopで開くまでの通し

入っている0.16.7の写しへこの直しを当て、試験用フォルダの会話のhookだけをその写しへ向けた。本物のDBと設定のまま。
端末から始めた会話に`THROUGHLINE_AUTO_HANDOFF_OPEN=desktop`を付け、指示を1回送った後は何も操作していない。

| 回 | 引き継ぎ | 後継が作業を終えた時刻 | Desktopが取り込んだ時刻 |
|---|---|---|---|
| 1（acceptEdits、14個を順にRead） | 1回（22:00:39） | 22:00:59 | 22:01:03 |
| 2（bypassPermissions、2周） | 続けて3回（22:01:57、22:02:26、22:02:51） | 22:03:04（最後の後継） | 22:03:13 |

- 記録の`desktop.state`は、開いた後継の引き継ぎだけ`opened`。2回目の途中の2つの後継は、自身が引き継ぎの途中だったので移っていない。
- 引き継ぎの`state`は全部`sent`。結果ファイルは2回とも書かれた。
- Claude Desktopの画面から始めた本物の会話では流していない。

### 公開版（0.16.8）での通し

[v0.16.8](https://github.com/kitepon/Throughline/releases/tag/v0.16.8)（commit `31eeed9`、registryの時刻 2026-10-08T13:14:58.084Z、shasum `24fdf0d93025432f4bab9e525c3c0eeb2d4b1489`）を
公開の`throughline self-update`で入れた（22:15:29。設定7つは更新の前後で同じ）。既定のhookだけで、同じ通しを1回流した。

| 引き継ぎ | 後継が作業を終えた時刻 | Desktopが取り込んだ時刻 | 記録 |
|---|---|---|---|
| 22:16:06 | 22:16:21 | 22:16:24 | `state: sent`、`desktop_state: opened` |

- `hook-failures.log`は無く、実行時エラーのopenは0のまま。
- 試験の後、Desktopへ移していない途中の後継2つを`claude stop`・`claude rm`で消した。Desktopへ移した試験の会話4つは、Desktopの一覧に残っている。
- 続けて引き継いだ時の途中の引き継ぎは、`desktop_state`が`waiting`のまま残る（後継が次の引き継ぎへ進んだため）。表示だけの事で、動きには関わらない。
