# ADR 0048: Claude Desktop から始まった会話の後継は、リモートコントロール付きで立てる

日付: 2026-10-10

## Context

Claude Code の自動継続は、後継を `claude --bg`（裏の会話）で立てる（ADR 0033）。Claude Desktop から始まった会話の後継は、
ターンを終えた時に Desktop へ移して開く（ADR 0043）。動いている最中の裏の会話は Desktop へ移せないので、後継が作業している間は、
Desktop の一覧に何も出ない。

2026-10-10、Windows の実機で、本物の会話の最初の引き継ぎが起きた（Claude Desktop の会話、約 96.8 万トークン）。引き継ぎは成功したが、
後継は裏で作業を続け、オーナーには状況が見えなかった（「スルーラインは発動したのか？状況がわからん」「リモートコントロールは有効に
なっているのかな」）。旧い会話は Desktop の会話で、リモートの接続の記録があった。後継には無かった。Throughline が後継を立てる時に、
リモートコントロールの指定を付けていなかった。

Claude Code には `--remote-control [name]` がある。付けて立てた会話は、claude.ai/code と Claude のアプリから見て操作できる。
実機で確かめた事（試験用フォルダ、Haiku）:

- `claude --bg --name=<名前> --remote-control=<名前> …` は、Windows・Linux（Claude Code 2.1.296）と macOS（2.1.289）で通る。
  立った会話は裏の会話（`kind: background`）で、transcript の `remote_session_change` にリモートの URL が入る。
- 名前は `=` の形で渡す。名前を省ける option なので、離して書くと次の引数を名前として読む。
- macOS で ssh から立てた時は、指定は通り会話も立つが、URL が入らなかった。画面のある session の端末からは入った。
  本物の引き継ぎの worker は Claude Desktop の下で動く。
- 信頼していないフォルダでは、リモートコントロールの有無に関係なく `Workspace not trusted` で立たない。

## Decision

1. Claude Desktop から始まった会話の後継と、その後継がさらに引き継ぐ時の後継を、`--remote-control=<後継の名前>` を付けて立てる。
   端末から始めた会話の後継には付けない（オーナーの裁定。Approval Box K-4DNZDK）。
2. Desktop から始まったかは、ADR 0043 と同じく、止める時点の transcript の最後の `entrypoint`（`claude-desktop`）と、hook の環境変数
   `CLAUDE_CODE_ENTRYPOINT` で決める。OS は問わない。引き継ぎの記録に `remote_control.wanted` として残す。
3. 付けて立てるのに失敗した時（終了 code が 0 でない、裏の会話の ID が返らない）は、付けずに1回だけ立て直す。引き継ぎは止めない。
   後継が立っていない事が分かっている時だけ立て直すので、後継は2つにならない。
4. 結果を記録の `remote_control.state`（`requested`: 付けて立てた、`unavailable`: 付けずに立て直した）に残し、
   `auto-handoff status --host claude --json` の `remote_control_state` で読める。付けて立てた後に、Claude Code がリモートへ
   つなげたかまでは見ない。
5. 環境変数 `THROUGHLINE_AUTO_HANDOFF_REMOTE_CONTROL` で上書きできる。`on` は出どころに関係なく付け、`off` は付けない。
6. 旧い会話を止めた理由の文に、後継がリモートコントロール付きで立つ事を書く。
7. 後継がターンを終えた時に Desktop へ移して開く動き（ADR 0043）は変えない。

## Consequences

- Desktop で作業している利用者は、後継が作業している最中も、claude.ai/code と Claude のアプリから様子を見て操作できる。
- リモートコントロールを付けた会話は、利用者のアカウントでログインした端末から操作できる状態になる。
- claude.ai/code とアプリの一覧に、Desktop から始まった会話の後継が並ぶ。
- すでに動いている後継には付かない。次の引き継ぎから付く。
- リモートコントロールは Claude Code の機能なので、Codex・Grok・Cursor には当てはまらない。
