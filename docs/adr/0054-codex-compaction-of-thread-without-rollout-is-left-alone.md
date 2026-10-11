# ADR 0054: 記録（rollout）を持たない Codex の会話の自動圧縮には、手を出さない

- Status: Accepted
- Date: 2026-10-12

## Context

Codex の自動継続（ADR 0034）は、`PreCompact(auto)` の hook で圧縮を止めて、新しいタスクへ引き継ぐ。hook は、合図の
会話の ID・記録の場所（`transcript_path`）・ターンの ID を検査し、合わなければ `handoff_hook_identity_invalid` で失敗にして、
圧縮を止める指示（`continue: false`）を返していた。

macOS の実機で、この失敗が7回出た（2026-10-10 に5回、10-11 に2回）。どれも Codex の引き継ぎの直後で、引き継ぎそのものは
成功している。0.16.14（ADR 0047）は「ターンの ID が `auto-compact-N`」の形を想定して直したが、外れていた。0.16.18 で
失敗の行へ合図の形を残し、10-11 の2回で形が分かった。

| | 1回目 | 2回目 |
|---|---|---|
| 失敗の時刻（JST） | 16:22:00.396 | 16:23:01.422 |
| 会話の ID | `01a129d6-fe64…`（作られたのは 16:21:58.116） | `01a129d7-e996…`（16:22:58.326） |
| ターンの ID | UUID（16:21:58.225） | UUID（16:22:58.611） |
| `transcript_path` | null | null |
| `cwd`・モデル・`trigger` | 絶対 path・`gpt-6.1-sol`・`auto` | 同じ |
| agent の ID・種類 | 無し | 無し |

引き継ぎは 16:21:57.996 に予約（旧タスク `01a124ce-f984…`）、後継 `01a129d7-de33…` が 16:22:55.411 に出来て、
16:23:06 に済んだ。失敗した合図の会話は、旧タスクでも後継でもない。

Codex Desktop のログ（アプリの行だけを読んだ）では、この2つの会話は Desktop 自身の App Server の中にあり、MCP が
起動し、`turn/started` と `turn/completed` が出ている。画面の側は「unknown conversation」として受けている。1つ目は
旧タスクのターンが止まって通知を出した直後、2つ目は後継の画面を開いた直後に出来ている。Throughline の worker は、
後継のほかに会話を作らない（`thread/start` は1か所）。要約の `codex exec --ephemeral` は別のモデル（既定
`gpt-5.6-luna`）で動く。

つまり、Codex Desktop が自分で立てた、画面に出ない・記録を持たない会話が、最初のターンで自動圧縮を始め、その合図が
Throughline の hook へ来ていた。Throughline は失敗として記録し、その会話のターンを止めていた（2回とも、hook の失敗の
0.3〜0.5 秒後に `turn/completed`）。Desktop がその会話を何に使っているかは、分かっていない。

Throughline は、会話の記録（rollout）から発言を取り込む。記録を持たない会話は取り込んでいないので、引き継ぐ記憶が無く、
後継も作れない。

## Decision

1. `PreCompact(auto)` の合図の `transcript_path` が null か、項目が無い時は、引き継ぎの対象にしない。失敗にせず、
   `continue: false` も返さない（hook は何も出力せず、終了 code 0）。圧縮は Codex がそのまま行う。
2. 通した事を `~/.throughline/codex-auto-handoff/unrecorded-compactions.jsonl` に1行残す（時刻・会話の ID・ターンの ID・
   モデル名。記号の混じる値は長さだけ）。会話の本文と path は書かない。
3. `transcript_path` が文字列で、絶対 path でない時は、今までどおり失敗にする（記録を持つはずの会話で、場所だけが不正）。
4. 記録を持つ会話の扱い（ADR 0034・0047）は変えない。

## Consequences

- macOS の Codex Desktop の引き継ぎのたびに出ていた失敗の記録が、出なくなる見込み。次の実機の引き継ぎで、失敗ログが
  増えず、`unrecorded-compactions.jsonl` に行が出る事で確かめる。
- Desktop が立てる画面に出ない会話は、Throughline に止められなくなり、Codex の圧縮が通る。自動継続を入れる前
  （0.11.0 より前）と同じ動きに戻る。
- 「host の自動圧縮を通さない」という決め（ADR 0034）は、Throughline が記録している会話についての物として読む。
  記録を持たない会話は、その外に置く。
- 利用者が自分で起こす記録なしの会話（`codex exec --ephemeral` など）も、同じ扱いになる。今までは失敗として止めていた。
  どちらでも引き継ぎは出来ない。
- Codex が、記録を持つ会話の最初のターンで、記録を作る前に `transcript_path` を null で渡す事があれば、その圧縮も通る。
  実機では見ていない。起きた時は `unrecorded-compactions.jsonl` の会話の ID が、後で記録を持つ会話と一致する事で気づける。
- 10-10 の5回は、失敗の行に形が残っていない。同じ検査・同じ場面（引き継ぎの直後）だが、同じ形だったとは確かめられない。
