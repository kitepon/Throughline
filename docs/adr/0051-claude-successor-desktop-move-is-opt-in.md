# ADR 0051: Claude Code の後継を Claude Desktop へ移す処理は、既定で無効にする

- Status: Accepted
- Date: 2026-10-11
- Supersedes: [ADR 0043](0043-claude-successor-opens-in-desktop.md) の既定（Desktop から始まった会話の後継を、ターンの後に移す）
- Related: [ADR 0048](0048-claude-desktop-origin-successor-has-remote-control.md)、[ADR 0049](0049-claude-handoff-uses-registered-project.md)、[ADR 0050](0050-claude-successor-with-held-peer-message-moves-to-desktop.md)

## Context

Claude Code の自動継続は、後継を裏の会話（`claude --bg`）で立てる。Claude Desktop から始まった会話の後継は、
リモートコントロール付きで立て（ADR 0048）、ターンを終えた時に `claude stop` で止めて `claude --desktop --resume` で
Desktop へ開き直していた（ADR 0043）。

2026-10-11、Windows の実機で、オーナーがスマホ（リモートコントロール）から後継と話している最中に、会話が続けて消えた。

- 10:31:43 と 10:39:50 ごろの2回。どちらも、後継がターンを終えた（返事を返した）直後に、Throughline が止めて Desktop へ移した。
- 止めると、Throughline が起動時に付けたリモートコントロールの接続が切れる。移った先の Desktop の会話は、
  リモートコントロールが有効になっていなかった。スマホと claude.ai/code からは、会話が消えたままになる。
- 1回目の会話は、裏で命令を走らせ（`run_in_background`）、その結果を待つ形でターンを終えていた。止めた時に、その命令も
  止まった（`task-notification` の `status` は `stopped`）。移った後の会話は、その知らせを受けたまま手すきで止まった。
- 1回目の会話は作業ツリーで作業していたが、Desktop で開き直した後の cwd は、会話を立てた元の repository だった。
- ADR 0050（0.16.20、同じ日の 09:16 公開）で、保留の文を持つ会話も移すようにした。それまで移らずに済んでいた会話が
  移るようになり、この2回が起きた。保留の文が無い会話では、0.16.8（macOS）と 0.16.9（Windows）から同じ事が起きていた。

「ターンが終わった」は「作業が終わった」ではなかった。利用者が話している最中の会話も、裏の命令を待っている会話も、
ターンは終わる。その会話を止めて別の場所へ開き直すと、利用者は会話を見失う。

## Decision

1. 後継を Claude Desktop へ移す処理は、既定で無効にする。後継は、裏の会話のまま残す。リモートコントロール（ADR 0048）、
   `claude agents`、`claude attach <id>` で見られる。
2. 環境変数 `THROUGHLINE_AUTO_HANDOFF_OPEN` が `origin` の時だけ、今までの既定（Desktop から始まった会話の後継を、
   ターンの後に移す）で動く。`desktop` は、出どころに関係なく移す（今までと同じ）。それ以外の値と未設定は、移さない。
3. 0.16.21 までの版が「移す」と記録した引き継ぎ（`desktop.wanted: true`、`desktop.state` が空）の後継も、
   有効にしていなければ移さない。記録は書き換えない。
4. リモートコントロール付きで立てる処理（ADR 0048）は変えない。

## Consequences

- 利用者が話している会話を、Throughline が止める事は無くなる。裏の命令も、保留の文も、リモートコントロールの接続も残る。
- Claude Desktop の一覧には、後継が出ない。Desktop の画面だけを見ている利用者は、引き継ぎの後の会話を Desktop では
  見つけられない。旧い会話の止めた理由に、後継の短い ID（`claude attach <id>`）とリモートコントロールで見られる事を書く。
- Desktop へ移したい時は、今までどおり手で `claude stop <id>` と `claude --desktop --resume <session-id>` を使える。
- 移す処理をもう一度既定にするかは、オーナーの裁定を待つ。その時は、少なくとも次を満たす。話している最中の会話を
  止めない。裏の命令が走っている会話を止めない。移した先でリモートコントロールが続く。作業ツリーの会話は作業ツリーで開く。
- ADR 0050 の「保留の文を持つ後継も移す」と、ADR 0049 の「受領を確かめられなかった後継も移す」は、移す処理を
  有効にした時だけ働く。
