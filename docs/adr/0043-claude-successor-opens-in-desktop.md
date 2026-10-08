# ADR 0043: Claude Desktop から始まった会話の後継を、作業を終えた時に Desktop へ開く

日付: 2026-10-08

## Context

Claude Code の自動継続は、後継を `claude --bg`（裏の会話）で立てる（ADR 0033）。Claude Desktop と端末は会話の一覧が別で、
裏の会話は Desktop の一覧に出ない。Desktop で作業している利用者には、旧い会話が止まり、続きが見えないまま裏で進む
（2026-10-08、オーナーの指摘「デスクトップで新しいセッションが見えてるかは不明ということかな？」「直してくれ」）。

macOS（Claude Code 2.1.289、Claude Desktop 2.26454.2）で確かめた事:

- 0.16.7 の後継3つは、Desktop の会話の置き場（`claude-code-sessions/…/local_<id>.json`）に入らず、Desktop のログにも出なかった。
- 公式の入口は `claude --desktop --resume <session-id>`。公式の説明は「別の端末で開いている会話と、裏でまだ動いている会話は
  移さない」と書いている（[一次ソース抜粋](../../rag/01-hooks/raw/claude-desktop-session-open-extract.md)）。
- 裏の会話を3つの状態で試した。作業中（`claude agents` の `status: busy`）と、ターンを終えた手すき（`status: idle`）は、
  どちらも `That session is running in the background` で断られた。`claude stop <id>` の後は通り、Desktop のログに
  `Resume deep link: importing CLI session …` → `Imported CLI session … as Desktop session local_…` が出た。
- `claude --desktop` は、出力が端末でないと動かない（`can't run non-interactively (… or redirected output)`）。
  `script -q /dev/null claude --desktop --resume <id>` で擬似端末を挟むと、端末の無い process からも通る。
- Desktop へ「resume」を渡す URL は公開されていない。Desktop の公開の link は `claude://code/new`（新しい会話の下書き）だけ。
- Desktop の画面から始まった会話の transcript は、各行に `"entrypoint":"claude-desktop"` を持つ。端末と裏の会話は `cli`。

動いている最中の後継を Desktop に出す道は無い。出せるのは、後継を止めた後だけ。

## Decision

1. Claude Desktop から始まった会話の後継は、**そのターンの作業を終えた時に**、Desktop へ移して開く。
   作業の間は今までどおり裏で動く（モデル・推論強度・権限は旧い会話のまま）。
2. Desktop から始まったかは、止める時点の transcript の最後の `entrypoint`（`claude-desktop`）と、hook の環境変数
   `CLAUDE_CODE_ENTRYPOINT` で決め、引き継ぎの記録に `desktop.wanted` として残す。裏で作業している後継がさらに引き継ぐ時は、
   元の会話の印を引き継ぐ。端末から始めた会話の後継は、今までどおり `claude agents` の一覧に出すだけにする。
3. きっかけは後継自身の Stop hook。対象の後継がターンを終えたら、切り離した process を起動する。その process は
   `claude agents --json --all` でその後継が手すき（`status: idle`）になるのを待ち、`claude stop <短い ID>` で止め、
   擬似端末の中で `claude --desktop --resume <session id>` を呼ぶ。出力の `Opening session <id>` と終了 code で成否を決める。
4. 後継が引き継ぎの途中（その後継自身の記録がある）なら移さない。作業は次の後継が続けるので、移すのは最後に作業を終えた
   後継だけ。手すきにならないまま時間切れになった時は、止めずに戻り、次の Stop でやり直す。
5. 対応は macOS と Windows。macOS は擬似端末に `/usr/bin/script` を使う。Windows は PowerShell の
   `Start-Process -Wait -PassThru` で新しい console（最小化）の中の pwsh に実行させ、その終了 code で成否を決める
   （出た文は読めない）。Linux の Claude Code には `--desktop` が無いので、印を付けず、今までどおり裏の会話のままにする。
6. 環境変数 `THROUGHLINE_AUTO_HANDOFF_OPEN` で上書きできる。`desktop` は出どころに関係なく開き、`off` は開かない。
7. 旧い会話を止めた理由の文に、後継がターンを終えた時に Desktop へ開く事を書く。
8. 結果は記録の `desktop`（`state`: `requested`・`opened`・`superseded`・`failed`、`error_code`、`opened_at`）に残し、
   `auto-handoff status --host claude --json` の `desktop_state`・`desktop_error_code` で読める。失敗しても引き継ぎの
   `state` は変えない（作業は後継が済ませている）。

## Consequences

- Desktop で作業している利用者は、後継の作業が終わると、その会話が Desktop に開いて続きを打てる。
- 後継が作業している間は、Desktop には出ない。長いターンの間は、旧い会話の止めた理由の文だけが手がかりになる。
  途中の様子は `claude agents`・`claude attach <id>` で見られる。
- Desktop へ移した会話の権限は、Desktop が決める（実測では `acceptEdits` で取り込まれた）。作業のターンは移す前に
  終わっているので、作業中の権限は変わらない。
- `claude stop` の後で `--desktop --resume` が失敗すると、後継は止まったまま裏に残る。記録に理由が残り、
  `claude --resume <session id>` か、手で `claude --desktop --resume <session id>` で開ける。
- Claude の Stop hook は、会話ごとに引き継ぎの記録の一覧を1回読む（記録は数個）。

## 確かめた範囲

macOS、Claude Code 2.1.289、Haiku 4.5、試験用フォルダ。端末から始めた会話に `THROUGHLINE_AUTO_HANDOFF_OPEN=desktop` を
付けて流した（[実測](https://github.com/kitepon/Throughline/blob/main/evidence/2026-10-05-claude-auto-handoff.md)）。

- 1回の引き継ぎ: 後継が 22:00:59 に作業を終え、22:01:03 に Desktop が取り込んだ。
- 続けて3回の引き継ぎ: 最後の後継だけが移り（22:03:13）、途中の2つは移らなかった。

## Windows（2026-10-08 23:45〜23:57、0.16.9）

Claude Code 2.1.293、Claude Desktop 2.16120（MSIX）。画面のある session で確かめた（ssh は session 0 で、Desktop へ届かない）。

- 裏の会話の3つの状態は macOS と同じ。作業中と手すきは `That session is running in the background`（終了 code 1）、
  `claude stop` の後は `Opening session <id> in Claude Desktop`（終了 code 0）で、数秒後に Desktop の会話の置き場
  （`%LOCALAPPDATA%\Packages\Claude_…\LocalCache\Roaming\Claude\claude-code-sessions`）へ入った。
- `cmd /c start "" /min /wait claude …` は、batch の shim を `cmd /K` で開いて戻らない。内側に `cmd /c` を挟むと戻るが、
  断られた時も終了 code は 0 だった。`Start-Process pwsh … -Wait -PassThru` の `ExitCode` は、断られた時 1、開けた時 0。
- 通し: 端末から始めた会話に `THROUGHLINE_AUTO_HANDOFF_OPEN=desktop` を付けた。続けて4回引き継ぎ、最後の後継が
  23:56:26 に作業を終え、23:56:42 に Desktop が取り込んだ。途中の3つは移っていない。

Linux（Claude Code 2.1.293）は `--desktop isn't available on this platform. It works on macOS and Windows (x64).` で断る。

## 確かめていない範囲

- Claude Desktop の画面から始めた本物の会話での通し（印の付き方は、実物の transcript の値と単体の試験で確かめた）。
- 長いターンの後継と、後継が質問で止まった時の見え方。
