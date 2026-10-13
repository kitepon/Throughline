# ADR 0057: Aiterm が起こした席の Claude の会話は、裏の後継へ引き継がない

- Status: Accepted
- Date: 2026-10-13

## Context

Claude Code の自動継続（ADR 0033）は、自動圧縮を止め、次の道具でターンを止めて、`claude --bg` の後継へ引き継ぐ。
引き継ぎを外すのは、手動の `/compact`、無効な project、subagent の中の圧縮、script から起動した会話
（`CLAUDE_CODE_ENTRYPOINT` が `sdk-` で始まる）だけだった。

Aiterm が起こした Claude の席（Bot がほかの端末に起こす子、通話の MCP が立てる席）は、入口が `cli` の対話の会話なので、
人の端末の会話と同じに引き継がれていた。席での振る舞いは、決めていなかった。

2026-10-13 10:48（JST）、Windows の実機で、Aiterm の remote で起こした席の会話が後継へ引き継がれた。Throughline の記録では
引き継ぎは成立している（`sent`）。席の側では次の事が起きた（Aiterm の担当の調べ）。

- Aiterm の席は、起こした時の会話 ID に結び付いている。別の会話の番の終わりは、席の物と数えない。
- 後継は Claude Code の常駐の process の下で動き、席の端末とは別の木にある。
- 呼び手が席へ送った文は旧い会話へ入り、後継へ届かない。後継の答えも呼び手へ戻らない。2通が落ち、呼び手が
  `claude attach` で手でつないだ。

同じ形は 2026-10-11 にも1回起きている（通話の MCP が立てた席）。BellTeam のコンテナは、席の配送が終わらなくなる事が
分かっていたので、自動継続を無効にしてある。Windows・macOS・Linux の3台は全 project で有効にしていて、そこへ Aiterm が
起こした席が入っていた。

オーナーの決め（2026-10-13）: 席では引き継がない形を先に入れ、続けて「席の同じ画面で新しい会話へ替える」形を Aiterm と
作る。後の形が出来れば、席でも圧縮は走らない。この ADR は先に入れる分を決める。

### 席を何で見分けるか

Aiterm は、席の process の環境へ起動の印（`AITERM_AGENT_LAUNCH_ID`、`AITERM_AGENT_KIND` など）を入れる。人が Aiterm の
端末の中で手で起こした claude には付かない（その端末にあるのは `AITERM_SESSION_ID` と `AITERM_STATE_BASE` だけ）。

印だけで席と決める形は、採れなかった。Linux の実機（Claude Code 2.1.296）で、裏の会話を2本、違う環境で続けて立てた。
1本目は `AITERM_AGENT_LAUNCH_ID` を付け、2本目は `AITERM_AGENT_*` を全部外した環境から立てた。2本目の会話の hook
（`SessionStart`・`UserPromptSubmit`・`Stop`）が受けた環境は、1本目と同じ印を持っていた。裏の会話は、起こした側ではなく、
Claude Code の常駐の process の環境を継ぐ。常駐は、最初に起こした process の環境を持ち続ける。

つまり、席の中（席の Bash、席の hook が起こす Throughline の worker）から常駐が起きると、その後に立つ裏の会話は、席と
関係が無くても席の印を持つ。印だけで外すと、利用者の会話の後継（裏の会話）まで引き継ぎから外れ、自動圧縮が走る。
Throughline は自動圧縮を置き換える物で、利用者の会話でそれが起きるのは、席の文が落ちる事より重い。

Aiterm は、席の Claude を `--session-id <ID>` で起こし、その ID だけを席の物と数える。Aiterm の担当と合わせて、この ID を
席の環境へ `AITERM_AGENT_VENDOR_SESSION_ID` として出してもらう（Aiterm 0.59.0 の次の版から。席の途中で変わらない）。

## Decision

1. **席の会話**は、hook の環境に `AITERM_AGENT_LAUNCH_ID` があり、かつ `AITERM_AGENT_VENDOR_SESSION_ID` が hook の
   `session_id` と同じ会話とする（`isAitermSeatConversation`）。起動の印だけでは席と数えない。
2. `PreCompact(auto)` は、席の会話では圧縮を止めず、引き継ぎの記録も残さない。理由は `aiterm_seat`。判定の順は、
   手動の `/compact` → 進んでいる引き継ぎ → 無効な project → script から起動した会話 → 席。自動継続が無効な端末の
   席は、今までどおり `auto_handoff_disabled` で終わる。
3. 席の会話に、後継を立てる前の記録（`requested`・`failed`）が残っている時は、`PreCompact` と `PreToolUse` が記録と
   立ち上げの札を取り下げ、圧縮と道具を通す。席を外す前の版が予約した会話と、会話 ID を出さない版の Aiterm の時に
   予約した会話が、これに当たる。
4. もう後継へ引き継いだ席の会話（`stopped` から先）は、今までどおり圧縮と道具を止め、後継を案内する。続きは後継にある。
5. 席の印を継いだだけの会話（席が起こした子、席の中から起きた常駐が立てた裏の会話）は、会話 ID が違うので、
   今までどおり引き継ぐ。
6. 会話 ID を出さない版の Aiterm が起こした席は、見分けられないので、今までどおり引き継ぐ。
7. `AITERM_AGENT_LAUNCH_ID` と `AITERM_AGENT_VENDOR_SESSION_ID` の名前と意味は、Aiterm の担当と合わせた物とする。
   変える時は、先に知らせ合う。

## Consequences

- この版が効くのは、`AITERM_AGENT_VENDOR_SESSION_ID` を出す版の Aiterm が起こした席から。それまでの席は、今までどおり
  裏の後継へ引き継がれ、呼び手の文は後継へ届かない。
- 効いた後の席は、同じ画面のまま続き、呼び手との行き来は切れない。文脈が一杯になると、Claude Code の自動圧縮が走る
  （BellTeam のコンテナの席と同じ）。圧縮より前の細かい文脈は、Claude の要約に置き換わる。会話の記録は、今までどおり
  Stop で Throughline に入る。
- 「host の自動圧縮を通さない」（ADR 0033）は、席の会話については、同じ画面で新しい会話へ替える形が出来るまで外す。
- 席の会話を起こし直す・`/clear` するなどで会話 ID が変わった時は、環境の ID と合わなくなり、今までどおり引き継ぐ。
- 席の環境へ足す印は、同じ道でほかの裏の会話へ継がれる。この先、席だけの動きを足す時も、会話 ID の一致で席と決めてから
  印を読む。
- 後継を立てる worker は、席の `AITERM_AGENT_*` を外さずに `claude --bg` を呼ぶ（外すのは会話ごとの `CLAUDE_CODE_*` など）。
  常駐が動いている時は、後継の環境は常駐の物になるので、外しても変わらない。ここは変えていない。

## 確認した範囲

- 単体試験と、本物の CLI の入口（`pre-compact`・`pre-tool-use`）を仮の HOME で動かす試験。
- 公開前に、候補の tarball を macOS（Node 26.11.1）・Linux（Node 24.20.0 と 26.11.1）・Windows 11（Node 24.20.0）へ置き、
  仮の HOME で本物の hook の入口へ5つの場面を通した。席の環境は圧縮も道具も止めず記録を残さない。席の印を継いだだけの
  環境・起動の印だけの環境・印の無い環境は、今までどおり圧縮を止めて引き継ぎを予約する。予約が残った席の会話は、次の
  道具で記録を取り下げる。4台とも同じ結果だった。
- 裏の会話が常駐の環境を継ぐ事は、Linux（Claude Code 2.1.296）だけで見た。macOS と Windows では見ていない
  （動いている常駐の下に試験の会話を立てる事になるので、流していない）。
- `AITERM_AGENT_VENDOR_SESSION_ID` を出す版の Aiterm は、まだ出ていない。本物の席での通し（本物の自動圧縮が起き、
  席が同じ画面のまま答えを返す所）は、その版が入った後に確かめる。
