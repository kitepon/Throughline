# ADR 0031: schema の移行は書き込み lock の中で版を読み直して行い、WAL への切り替えは読み直して待つ

日付: 2026-10-04

## Context

`getDb()` は DB を開くたびに `PRAGMA user_version` を読み、現行版より古ければ移行を走らせていた。
版を読むのも、移行の各 statement も、transaction の外だった。

Windows の Cursor の会話では、同じ hook が2本ほぼ同時に走る（2026-10-04 の記録では、1会話の SessionStart が
数ms〜320ms の間隔で2行残る。`~/.cursor/hooks.json` と `~/.claude/settings.json` の両方に Throughline の登録がある。
2本目がどちらの登録から来るかは確かめていない）。新しい端末の最初の会話では、2本とも版 0 を読む。片方が先に移行を終えると、もう片方は版 0 のつもりで
v2 の移行（`DELETE FROM judgments ...`）を走らせ、v4 で消えた表へ触って `no such table: judgments` で落ちる。

もう1つ、新しい DB の journal mode を WAL へ切り替える `PRAGMA journal_mode = WAL` は排他 lock を要る。
他の process が同じ DB を開いている間は、`busy_timeout` を待たずに `database is locked` で断られる。

2026-10-04 に、切り離した置き場で再現した。新しい DB を 6 process が同時に開くと、Linux（Node 26）で
6回中3回、どれか1本が上のどちらかで落ちた。Windows（Node 24）でも、SessionStart と UserPromptSubmit を
2本ずつ同時に動かした最初の1回で2本が `no such table: judgments` で落ちた。
既に現行 schema の DB では、どちらも起きない（版が現行なら移行は何も書かず、WAL なら切り替えない）。

## Decision

1. 移行は `BEGIN IMMEDIATE` で書き込み lock を取り、その中で `PRAGMA user_version` を読み直してから走らせ、
   `user_version` の更新まで1つの transaction で commit する。失敗した時は rollback し、途中の schema を残さない。
2. lock の外で読んだ版が現行版以上なら、lock を取らない。現行 schema の DB を開く hook は、今までどおり何も書かない。
3. 他の process が移行している間に開いた process は、`busy_timeout`（5秒）まで lock を待ち、
   取れた後に読み直した版が現行なら何もしない。
4. WAL への切り替えは、`database is locked` で断られたら 25ms 待って journal mode を読み直し、
   `busy_timeout` と同じ時間まで繰り返す。他の process が先に切り替えれば、読み直しで WAL が見えて終わる。
5. `migrate --json`（ADR 0018 の正規入口）も同じ関数を通る。結果の形は変えない。

## Consequences

- 新しい端末で複数の hook が同時に最初の DB を開いても、全員が現行 schema で開ける。
- 古い schema からの移行中、他の hook は最長5秒待つ。移行が5秒を超えると、待った hook は
  `database is locked` で失敗する。今までは、移行の途中の schema で走るか、同じ移行をもう一度走らせていた。
- 移行が途中で失敗した DB は、移行前の schema のまま残る。次に開いた時に最初からやり直す。
- 2026-10-04 に Windows（0.12.4）で起きた SessionStart と UserPromptSubmit の失敗各1回は、
  現行 schema の DB で起きている。この ADR の2つの形ではなく、原因は分かっていない。
  理由の文面は 0.12.4 では端末に残らない。0.12.9 は `hook-failures.log` に失敗した位置（stack の先頭）を足し、
  hook の stdin が JSON として読めない時の文面に字数を入れる。
