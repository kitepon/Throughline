# ADR 0049: Claude の引き継ぎは、会話を登録した project で後継を立てる。受領を確かめられなかった後継も Desktop へ移す

日付: 2026-10-11

## Context

Claude Code の自動継続は、PreCompact の hook で、後継を立てる project を決める（ADR 0033）。決め方は、会話が別の project へ
移っていれば移った先、そうでなければ hook の環境変数 `CLAUDE_PROJECT_DIR`、無ければ hook の cwd だった。後継の最初の指示は、
前任と後継の project（`sessions.project_path`）が同じ時だけ、前任の記憶を合流させる。`sessions` の行は SessionStart の cwd で作る。

2026-10-11、オーナーから「WindowsのClaudeの自動スルーラインで起動する新セッションってRemoteがONで立ち上がってるの？
なんか意図した挙動と違う気がする」と指摘があった。Windows の実機（Claude Code 2.1.296）の記録を読んだ。

- 0.16.16 より後の Claude の引き継ぎは5回。5回とも、後継はリモートコントロール付きで立っていた（ADR 0048）。
  4回は、後継がターンを終えた後に Claude Desktop へ移っていた（ADR 0043）。
- 1回（10/10 23:43）は、受領を確かめられないまま（`unknown`・`handoff_delivery_unconfirmed`）だった。後継は立って作業を
  続けていたが、Desktop へ移らず、裏の会話のまま残った。見えるのはリモートコントロールからだけだった。
- この回の前任は、作業ツリー（`<repository>/.claude/worktrees/<名前>`）で動く後継を、Claude Desktop が取り込んだ会話だった。
  SessionStart の cwd は作業ツリーで、`sessions` の project も作業ツリーだった。PreCompact の時、`CLAUDE_PROJECT_DIR` は
  元の repository を指していた。transcript に `relocated` の行は無い。
- その結果、後継は元の repository（branch は `main`）で立った。前任と project が違うので、記憶は合流しなかった
  （`merge_skip_reason: project_mismatch`）。合流しないと受領も残らないので、引き継ぎは `unknown` で終わった。
- Desktop へ移す処理は、受領が残った引き継ぎ（`sent`）の後継だけを対象にしていた。`unknown` の記録には後継の session id が
  無く、後継の Stop では何も起きなかった。

## Decision

1. PreCompact で後継を立てる project は、次の順で決める。会話が移った先（`relocated`）、会話を登録した project
   （`sessions.project_path`。その場所が今もある時）、`CLAUDE_PROJECT_DIR`、hook の cwd。
   印（baton）・有効かどうかの判定・後継を立てる場所は、同じ値を使う。
2. `sessions` を読むのは、自動圧縮で、自動継続が有効で、まだ引き継ぎの記録が無い時だけ。読めない時と、登録した場所が
   もう無い時（作業ツリーを消した後）は、今までと同じ値で進める。
3. 受領を確かめられなかった引き継ぎ（`unknown`、後継の短い ID だけが記録にある）でも、その後継がターンを終えたら、
   Desktop へ移す。継続の指示は起動時の引数で渡してあるので、ターンを終えた後継は指示を受けている。
   後継の session id を記録へ入れる。`state` と `error_code` は変えない（記憶が合流しなかった事は、記録に残す）。
   移す process が後継の手すきを待ち切れずに戻った時は、次の Stop で同じ記録からやり直す。この時は、記録に入れた
   session id が同じ会話だけを対象にする（0.16.21。0.16.19 と 0.16.20 は、session id が無い記録だけを探していて、
   2回目より後の Stop では何も起きなかった。Windows の実機で 2026-10-11 に1回起きた）。
4. 後継が立たなかった引き継ぎ（`failed`）は、今までどおり何もしない。

## Consequences

- 作業ツリーの会話は、Desktop が取り込んだ後に引き継いでも、同じ作業ツリーで続く。記憶も合流する。
- 何かの理由で受領を確かめられなかった時も、後継は裏の会話のまま残らない。ただし、その後継に前任の記憶が入ったかは
  別の話で、`unknown` の記録を見て確かめる必要がある。
- 会話を起動した後で `CLAUDE_PROJECT_DIR` だけが変わる場面では、登録した project が優先される。会話を別の project へ
  移す場面は、今までどおり `relocated` の行で分かる。
- Stop の完了受領の project（`turn-processor`）は変えていない。Desktop が取り込んだ作業ツリーの会話の完了受領は、
  今までどおり `CLAUDE_PROJECT_DIR`（元の repository）へ出る。
- リモートコントロール付きで立てた後継は、Desktop へ移す時に止める（`claude stop`）。起動時のリモートの接続はそこで切れ、
  移った後は Claude Desktop 自身のリモートの設定に従う。ここは変えていない。
- Codex・Grok・Cursor は、hook の cwd で project を決める。この ADR の対象は Claude Code だけ。
