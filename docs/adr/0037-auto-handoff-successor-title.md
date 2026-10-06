# ADR 0037: 自動継続の後継に「project 名｜作業の概要（自動引き継ぎ）」の名前を付ける

日付: 2026-10-07

## Context

自動継続が立てる後継は、一覧で何の project の何の続きかを読めなかった（2026-10-07、オーナーの指摘）。

- Claude Code: 後継を `claude --bg --name tl-<フォルダ名>-<引き継ぎ ID の先頭8桁>` で立てていた。Claude Desktop の一覧にも
  この名前がそのまま題として出る（macOS で実測: `tl-tl-claude-probe-3eacc0af`）。作業の中身は名前に入らない。
- Codex: 後継タスクに名前を付けていなかった。Codex は名前の無いタスクを最初の user 発言で表示するので、継続の指示
  （`Throughline自動継続 <引き継ぎ ID> / <配送 ID>`）がそのまま題として見える。macOS の実機で、自動継続が立てた
  後継4つに名前が無いことを `session_index.jsonl` で確かめた。project 名も作業の中身も読めない。

前任の題は host が既に持っている。

- Claude Code は会話記録に題を書く。端末の会話は `ai-title`（Claude Code が付ける。変わるたびに行が増える）、
  Claude Desktop の会話と人が名前を変えた会話は `custom-title`。`--name` で立てた会話も `custom-title` に入り、
  `ai-title` は付かない（Linux 2.1.292、macOS の記録で確認）。
- Codex は `thread/read` が `name`（Desktop が付けた題、または人が付けた題）と `preview`（最初の user 発言）を返す。
  自動継続は、前任の状態を読む時にこの値を既に取っている（`runtime.title`）。名前は `thread/name/set` で付けられ、
  最初のターンの前に付けた名前はターンの後も残る（Linux 0.160.1 で確認）。書かれるのは `session_index.jsonl` だけで、
  rollout には何も足されない。

## Decision

1. 後継の名前を `<project 名>｜<作業の概要>（自動引き継ぎ）` にする。project 名は project の場所の最後のフォルダ名。
   概要が取れない時は `<project 名>（自動引き継ぎ）`。形は `src/auto-handoff-title.mjs` に1か所だけ置く。
2. 作業の概要は前任の題から取る。AI は呼ばない（引き継ぎを遅らせず、後継を立てる前に失敗する所を増やさない）。
   - Claude Code: 最後の `custom-title`、無ければ最後の `ai-title`、どちらも無ければ止めた時点の依頼の最初の行。
   - Codex: 前任の `name`、無ければ `preview`。
3. 概要は最初の行だけを1行にして、40字で切る。制御文字と二重引用符は落とす（名前は起動の引数として渡す。
   Windows は PowerShell の shim を通る）。
4. 前任がこの形の名前を持つ後継なら、中の概要だけを取り出して使う。引き継ぎを重ねても project 名と印は
   積み重ならない。継続の指示は概要にしない。Codex で前任が名前の無い後継（この版より前に立てたもの）の時は、
   引き継ぎの記録をさかのぼって元のタスクの題を使う。
5. Claude Code へは `--name=<名前>` の形で渡す。フォルダ名が `-` で始まっても option として読まれない。
6. Codex は、後継を作った直後、記憶を注入する前に `thread/name/set` を呼ぶ。名前は表示だけに使うので、
   断られても引き継ぎは止めず、worker のログに理由の code を残す。

## Consequences

- 名前に引き継ぎ ID が入らなくなる。後継の ID は今までどおり記録（Claude は `successor.short_id`、Codex は
  `target_thread_id`）と `auto-handoff status` にある。Throughline は名前で後継を探していない。
- 同じ会話から引き継ぎを重ねると、後継は同じ名前になる。一覧では新しい順で見分ける。
- 概要は前任の題を写すだけなので、題が作業の中身からずれていれば、名前もずれる。
- 記録の schema は変えない。
