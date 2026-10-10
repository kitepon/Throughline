# ADR 0047: Codex の内部の文脈からの自動圧縮は、失敗にせず止める

日付: 2026-10-10

## Context

Codex Desktop の自動継続は、`PreCompact(auto)` の hook が受け取った会話の ID とターンの ID が UUID の形でない時、
`handoff_hook_identity_invalid` の例外にしていた。例外になった hook は、失敗の記録（`HOOK_CODEX_FAILED`、high）を残し、
`continue: false` を返して圧縮を止める。

2026-10-10、macOS の実機（Codex Desktop 26.1007、同梱の Codex 0.162.0-alpha.17.2）で、この失敗が3回記録された。

- 13:04:46: 引き継ぎのためにターンを止めた 2.5 秒後。
- 13:24:01: 別のタスクのターンが始まった 3.3 秒後。
- 13:25:25: そのタスクを引き継ぎのために止めた 4.7 秒後。

Codex は、利用者のターンとは別に、自分で作る内部の文脈を持つ。その文脈のターンの ID は `auto-compact-N` の形になる
（`codex-rs/core/src/session/mod.rs` の `next_internal_sub_id`）。`PreCompact` の hook へ渡るターンの ID は、その時の文脈の ID
（`codex-rs/core/src/hook_runtime.rs` の `run_pre_compact_hooks`）なので、内部の文脈から圧縮が始まると、UUID でない ID が届く。
同梱の Codex が 0.162.0-alpha.2 の端末（Linux）では、この呼び出しは起きていない。

3回とも、hook は圧縮を止めていた。2つのタスクの rollout に圧縮の行は無く、使用量も減っていない。13:24:01 に止めた後、
ターンはそのまま進み、80 秒後の `PreCompact`（利用者のターンの ID）で引き継いで `continued` になった。
起きていた害は、起きていない失敗が high で記録された事だった。

## Decision

1. 会話の ID と記録の場所が正しく、ターンの ID が `auto-compact-<数字>` の形の `PreCompact(auto)` は、失敗にしない。
   `continue: false` を返して圧縮を止める（今までと同じ結果）。失敗の記録は残さない。
2. その時に引き継ぎは作らない。内部の文脈は利用者のターンではなく、止める所と続ける作業が決まらない。文脈を残しておけば、
   文脈が上限に近づいた利用者のターンの `PreCompact` で、今までどおり引き継ぐ。
3. 止めた事を `~/.throughline/codex-auto-handoff/internal-compactions.jsonl` に1行残す（時刻・会話の ID・ターンの ID）。
4. それ以外の形（会話の ID が UUID でない、記録の場所が無い、ターンの ID が知らない形）は、今までどおり
   `handoff_hook_identity_invalid` の失敗にする。

## Consequences

- 内部の文脈からの圧縮で、失敗の記録が増えなくなる。圧縮を止める動きは変わらない。
- 内部の文脈からの圧縮が何度も起きるタスクでも、圧縮は通らない。利用者のターンの `PreCompact` が来るまで、文脈はそのまま残る。
- Codex が内部の ID の形を変えると、また失敗として記録される。その時は記録の message で気づける。

## 追記（2026-10-11）

0.16.16 の macOS の実機で、同じ `handoff_hook_identity_invalid` が2回出た（2026-10-10 16:55:08 と 16:55:15）。どちらも、
引き継ぎ先のタスクを作った直後（作成の 1.4 秒後と、最初のターンの開始の 1.5 秒後）。`internal-compactions.jsonl` は
0行だった。この ADR が想定した形（ターンの ID が `auto-compact-N`）の呼び出しではなかった事になる。

- Context に書いた「内部の文脈から `PreCompact(auto)` を呼ぶ」は、Codex の source を読んだ推測で、実機では確かめていない。
  `next_internal_sub_id` の ID は、`thread/inject_items` の文脈（`new_inject_items_context`）にも使われる。
- hook へ渡る `transcript_path` は null になり得る（`codex-rs/hooks/src/schema.rs` の `NullableString`）。ターンの中の
  圧縮は、ターンの ID（UUID）をそのまま渡す（`with_model` は `sub_id` を引き継ぐ）。どの値が不正だったかは、失敗ログに
  文面と位置しか無く、決められなかった。
- 0.16.18 で、この失敗の行へ合図の形（`identity`。ID・種類・絶対 path かどうか）を残す。次に起きた行を読んで、
  扱いを決める。この ADR の Decision 1〜4 は、それまで変えない。

