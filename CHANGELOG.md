# Changelog

All notable changes to Throughline are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Pre-`0.3.18` iteration history is preserved as a rollup section near the bottom
since most of those releases were rapid-fire monitor render bug fixes that
shipped to npm but were not individually tagged on GitHub.

## [Unreleased]

## [0.16.16] — 2026-10-10

### 追加

- Claude Desktopから始まった会話の後継を、リモートコントロール付き（`--remote-control=<後継の名前>`）で立てる。後継は裏の会話で、ターンを終えるまでClaude Desktopの一覧に出ない。作業の最中も、claude.ai/codeとClaudeのアプリから様子を見て操作できる（[ADR 0048](docs/adr/0048-claude-desktop-origin-successor-has-remote-control.md)）。
  - 端末から始めた会話の後継には付けない。後継がさらに引き継ぐ時は、元の会話の出どころを引き継ぐ。
  - 付けて立てるのに失敗した時は、付けずに1回だけ立て直す。引き継ぎは止めない。
  - `auto-handoff status --host claude --json`の`remote_control_state`で読める（`requested`: 付けて立てた、`unavailable`: 付けずに立て直した、`null`: 対象外）。
  - 環境変数`THROUGHLINE_AUTO_HANDOFF_REMOTE_CONTROL`で上書きできる（`on`・`off`）。

### 対応の範囲

| | macOS | Linux | Windows |
|---|---|---|---|
| Claude Code | 追加した。試験用フォルダで、本物のworkerが後継をリモートコントロール付きで立て、transcriptにリモートのURLが入った（Claude Code 2.1.289、画面のあるsessionの端末）。sshから立てた時は、後継は立つがURLが入らなかった | 追加した。同じ確かめでURLが入った（2.1.296）。信頼していないフォルダでは、付けずに立て直す所まで動き、どちらも`Workspace not trusted`で立たなかった（今までと同じ） | 追加した。同じ確かめでURLが入った（2.1.296） |
| Codex | 対象外。リモートコントロールはClaude Codeの機能 | 同じ | 同じ |
| Grok | 対象外。同じ理由。自動継続の機能も無い | 同じ | 同じ |
| Cursor | 対象外。同じ理由。自動継続の機能も無い | 同じ | 同じ |

### 変わらない事

- 後継がターンを終えた時にClaude Desktopへ移して開く動き。端末から始めた会話の引き継ぎ。

### 確認していない範囲

- claude.ai/codeとClaudeのアプリの側で、後継が見えて操作できる所（確かめたのは、後継のtranscriptにリモートのURLが入った事まで）。
- Claude Desktopの会話の、本物の引き継ぎでの動き（試験は、端末から始めた会話にDesktopの印を付けて流した）。
- リモートコントロールが使えない状態（未ログインなど）での実物の動き（試験では作り物の失敗で、付けずに立て直す事を確かめた）。

## [0.16.15] — 2026-10-10

### 追加

- `throughline auto-handoff successor --thread <Codexの会話のID> --json`。あるCodexのタスクの「今の続き」を返す、読むだけの入口。ほかの製品が、旧タスクあての連絡を今の続きへ渡す時に使う。`auto-handoff status --json`は新しい20件だけを返すので、古い引き継ぎの続きを引けなかった。
  - 返す物: `handed_off`（残っている後継があるか）、`current_thread_id`（引き継ぎを先までたどった、残っている一番先の後継。無ければ渡したID自身）、`chain`（そこまでの引き継ぎ）、`pending`（今の続きのタスクで、後継へ指示を送る前の引き継ぎ。`in_flight`がtrueならworkerが動いている最中、falseなら止まっていて`error_code`と`resume_state`が入る）。
  - 消された後継とアーカイブ済みの後継は、無い物として扱う（旧タスクへ入力が来た時に開く後継と同じ決め方）。
  - 記録が無い端末では、引き継ぎが1つも無い時と同じ答えを返す。記録は読み取り専用で開く。

### 対応の範囲

| | macOS | Linux | Windows |
|---|---|---|---|
| Codex（Desktop） | 追加した。実機の記録で確認（引き継ぎ済みのタスク2つから今の続きが返り、引き継ぎの無いタスクは自分自身が返った） | 追加した。実機の記録で確認（後継がアーカイブ済みの系列は、旧タスク自身が返った） | 追加した。実機の記録で確認（16本続いた系列の最初と途中から、同じ今の続きが返った。止まったタスクは`pending`に理由が出た） |
| Claude Code | 対象外。Claude Codeの自動継続の記録は別の形で、`auto-handoff status --host claude --json`が全件を返す | 同じ | 同じ |
| Grok | 対象外。自動継続の機能が無い | 同じ | 同じ |
| Cursor | 対象外。自動継続の機能が無い | 同じ | 同じ |

### 変わらない事

- 引き継ぎの動き。`auto-handoff status --json`の出力。

## [0.16.14] — 2026-10-10

### 修正

- Codex Desktop（同梱のCodex 0.162.0-alpha.17.2）が、内部の文脈（ターンのIDが`auto-compact-N`）から`PreCompact(auto)`のhookを呼ぶ時、Throughlineが`handoff_hook_identity_invalid`の失敗として記録していた。macOSの実機で3回。圧縮は止まっていて、タスクにも影響は無かったが、起きていない失敗がhighで記録された。この形の呼び出しは、失敗にせず圧縮だけを止め、`~/.throughline/codex-auto-handoff/internal-compactions.jsonl`に1行残す（[ADR 0047](docs/adr/0047-codex-internal-compaction-is-stopped-without-error.md)）。
  - 圧縮を止める動きは今までと同じ。引き継ぎは、文脈が上限に近づいた利用者のターンで今までどおり起きる。
  - それ以外の不正なID（会話のIDがUUIDでない、記録の場所が無い、知らない形のターンのID）は、今までどおり失敗として記録する。

### 対応の範囲

| | macOS | Linux | Windows |
|---|---|---|---|
| Codex（Desktop） | 直した。単体試験と、切り離した置き場での本物のhookの命令で確認（内部のIDは失敗0件・記録1行、不正なIDは失敗1件）。CIのmacOSも成功。**本物のCodex Desktopが内部の文脈からhookを呼ぶ場面は、狙って起こせないので未確認** | 直した。単体試験とCI。実機（同梱0.162.0-alpha.2）では、この呼び出しが起きていない | 直した。単体試験とCI。実機では、この失敗の記録が無い |
| Claude Code | 対象外。Claude Codeの`PreCompact`は別の実装で、ターンのIDを検査しない | 同じ | 同じ |
| Grok | 対象外。自動継続の機能が無く、`PreCompact`のhookを登録していない | 同じ | 同じ |
| Cursor | 対象外。自動継続の機能が無く、`PreCompact`のhookを登録していない | 同じ | 同じ |

### 確認していない範囲

- 本物のCodex Desktopが内部の文脈からhookを呼ぶ場面での、新しい版の動き（次に起きた時に、失敗の記録が増えず、`internal-compactions.jsonl`に行が出る事で確かめる）。
- 内部の文脈からの圧縮が、Codexのどの処理から始まるか（公開ソースでIDの形と渡り方だけを確かめた）。

## [0.16.13] — 2026-10-10

### 修正

- Codex Desktopの自動継続が、手動の引き継ぎ（`$throughline`）などで始めたタスクを`handoff_memory_lineage_untracked`で止め、そのタスクでは何度入力しても同じ理由で止まり続けた。macOSの実機で1つのタスクが止まり、ほかの道具からの返信も始まらなくなった。前任をさかのぼれない記憶を受け取ったタスクも引き継ぎ、受け取った記憶の本文をそのまま後継へ渡す（[ADR 0046](docs/adr/0046-codex-handoff-carries-untracked-inherited-memory.md)）。
  - 後継の記憶に「系列の最初のタスクが受け取っていた記憶（そのまま）」の節として載せる。その後継がさらに引き継ぐ時も載せる。120,000字を超える分は切り、切った事を書く。
  - 0.16.12までで止まっていたタスクは、次の入力か`throughline auto-handoff resume --operation <ID>`で引き継がれる。

### 対応の範囲

| | macOS | Linux | Windows |
|---|---|---|---|
| Codex（Desktop） | 直した。実機の止まっていたタスクの記録を読めた（受け取った記憶10,006字）。再開の結果は公開の後に確かめる | 直した。本物のCodex Desktopで、手動の引き継ぎの記憶を持つタスクから2回続けて引き継ぎ、記憶が2つの後継へ渡った | 直した。本物のCodex Desktopでは流していない。CIのWindowsで単体試験が通った |
| Claude Code | 対象外。Claude Codeの自動継続には、この理由で止める所が無い（記憶は通常のrecallで取る） | 同じ | 同じ |
| Grok | 対象外。自動継続の機能が無い | 同じ | 同じ |
| Cursor | 対象外。自動継続の機能が無い | 同じ | 同じ |

### 変わらない事

- 自動継続の記録に前任があるタスクの記憶の集め方。実行中の子agent・設定の不一致で止まる扱い。

### 確認していない範囲

- Windowsの本物のCodex Desktopでの通し。
- 受け取った記憶が120,000字を超える実物（試験では作り物で確かめた）。

## [0.16.12] — 2026-10-10

### 修正

- Codex Desktopの自動継続が、旧タスクの順番待ちに入力が残っていると`handoff_source_input_pending`で止まり、そのタスクでは何度入力しても同じ理由で止まり続けた。Windowsの実機で、2つのタスクに7回続き、どちらもそのまま使われなくなった。止めたタスクではCodexが順番待ちを動かさないので、順番待ちは空にならない。
  - 引き継ぎを断らない。後継が作業を続けたのを確かめた後に、旧タスクの順番待ちの入力を、順番を保って後継の順番待ちへ運ぶ（[ADR 0045](docs/adr/0045-codex-handoff-carries-pending-queue.md)）。
  - 二重に送らない。後継へ入れた結果が分からない入力は入れ直さず、旧タスクの順番待ちに残す。運べなくても引き継ぎは止めない。
  - 0.16.11までで止まっていたタスクは、次の入力でやり直しが動き、引き継がれる。その時点で順番待ちに残っている入力は、全部後継へ運ばれる。

### 変わらない事

- 実行中の子agent、設定の不一致、追跡されていない旧handoff記憶で止まる扱い。引き継ぎ済みの旧タスクへ後から届く入力の扱い。Claude Codeの自動継続。

### 確認した範囲

- Linux（Codex Desktop同梱のCodex 0.162.0-alpha.2）の試験用フォルダで、本物のCodex Desktopに自動継続を2回続けて流した。最初のターンが動いている間に、順番待ちへ入力を1つ入れた。2回とも引き継ぎは`continued`になり、入力は後継から次の後継へ運ばれ、最後の後継で継続の指示のターンの後に1回だけ実行された。旧い2本のrolloutには出ていない。順番待ちは3本とも空になった。
- macOS（同梱のCodex 0.162.0-alpha.2）とWindowsの同梱のCodexで、試験タスク2本の間で順番待ちを運んだ。入力2つが、先に入っていた1つの後ろへ元の順番で並び、旧い方は空になった。もう一度呼んでも入れ直さなかった。この2つの端末では、引き継ぎの通しは流していない。

### 確認していない範囲

- 0.16.11までで止まっていた実機のタスクが、次の入力で引き継がれる所（利用者の入力が要る）。
- 後継へ入れる応答が本当に切れた時の動き（試験では作り物の応答で確かめた）。

## [0.16.11] — 2026-10-09

### 修正

- `throughline auto-handoff mark-sources`が、名前の無いタスクを残していた。後継へ名前を付けない版（0.15より前）が作った後継は、継続の指示（`Throughline自動継続 <ID>…`）が題として見える。0.16.10は、この題のタスクへ印を付けず、名前も付けなかった。macOSの実機では、一覧に名前の無いタスクが12本（今の続き6本、旧タスク6本）残った。
  - 古い引き継ぎから順に、名前の無い後継へ`<project名>｜<作業の概要>（自動引き継ぎ）`の名前を付けてから、旧タスクへ印を付ける。利用者が名前を付けたタスクは、名前を変えない。
  - アーカイブ済みのタスクは触らない（Codexが名前の変更を断る）。0.16.10は失敗として数えていた。
- 名前の無い後継がさらに引き継いだ時、旧タスクへ印が付かなかった。その後継を作った引き継ぎから名前を作り直し、印を付ける。

### 追加

- `throughline auto-handoff mark-sources --dry-run`。名前を書かず、付ける名前の一覧（`changes`）だけを返す。

### 確認した範囲

- macOS（Codex Desktop同梱のCodex 0.162.0-alpha.2）の実機の引き継ぎ29件（14系列）へ流した。`--dry-run`で付ける名前を確かめてから実行し、名前の無い後継12本へ名前、旧タスク6本へ印が付いた（0.16.10で付けた19本と合わせて、一覧に在る旧タスクは全部印あり）。失敗は0、もう一度流すと変更は0。Codexの`thread/list`で、系列ごとに印の無いタスクが今の続きの1本だけになった事を確かめた。

### 確認していない範囲

- 付け直した名前が、Codex Desktopの一覧の表示へいつ出るか（画面は見ていない）。

## [0.16.10] — 2026-10-09

### 修正

- Codex Desktopの自動継続で、引き継ぎを重ねると後継のタスクが全部同じ名前になり、一覧でどれが今の続きかを見分けられなかった。元のタスクも、引き継いだ後に名前が変わらなかった。後継が作業を続けたのを確かめた後に、旧タスクの名前の頭へ`【引き継ぎ済み】`を付ける。同じ作業の系列で、印の無い1本が今の続きになる（[ADR 0044](docs/adr/0044-codex-handed-off-source-is-marked.md)）。
  - 名前は、その時の旧タスクの名前を読んでから作る。利用者が付け直した名前も、印の後ろに残る。付けられなくても引き継ぎは止めない。
  - 途中で止まった引き継ぎの旧タスクには付けない。

### 追加

- `throughline auto-handoff mark-sources`。0.16.9までの版が引き継いだ旧タスクへ、印を付け直す。生きている後継がある旧タスクだけに付ける。何度流しても同じ結果になる。

### 変わらない事

- 後継の名前（`<project名>｜<作業の概要>（自動引き継ぎ）`）。引き継ぎ済みの旧タスクへ入力した時の扱い（止めて後継を開く）。Claude Codeの自動継続。

### 確認した範囲

- Linux（Codex Desktop同梱のCodex 0.162.0-alpha.2）の試験用フォルダで、本物のCodex Desktopに自動継続を2回続けて流した。2回とも、後継が作業を続けた後に旧タスクが`【引き継ぎ済み】`の名前になり、印の無いタスクは最後の後継の1本だけになった。
- macOS（同梱のCodex 0.162.0-alpha.2）とWindowsの同梱のCodexで、試験タスクへ印を付けた。1回目は付き、2回目は付け直さなかった。`thread/list`の`updatedAt`は変わらなかった。この2つの端末では、引き継ぎの通しは流していない。
- Desktopが開いたままのタスクへ、別のprocessから名前を付けられる事（Linux。`thread/archive`は`already has an active writer`で断られ、`thread/name/set`は通った）。

### 確認していない範囲

- 付け直した名前が、Codex Desktopの一覧の表示へいつ出るか（画面は見ていない。Codexの`thread/list`と`session_index.jsonl`では、付けた直後に新しい名前が返る）。
- Claude Codeの後継も同じ名前の付け方だが、旧い会話の名前を外から変える公式の入口を確かめていない。

## [0.16.9] — 2026-10-09

### 追加

- Claude Desktopから始まった会話の後継を、作業を終えた時にClaude Desktopへ開く動き（0.16.8、[ADR 0043](docs/adr/0043-claude-successor-opens-in-desktop.md)）を、Windowsでも行う。`claude --desktop --resume`は出力が端末でないと動かないので、Windowsでは新しいconsole（最小化）の中のPowerShellに実行させ、その終了codeで成否を決める。
  - Windowsの端末（Claude Code 2.1.293、Claude Desktop 2.16120）の実測。裏の会話は、作業中も手すきも`That session is running in the background`（終了code 1）で断られ、`claude stop`の後は`Opening session <id> in Claude Desktop`（終了code 0）で開いた。macOSと同じ。
  - `cmd /c start /wait`は、中の命令が断られても0を返し、batchのshim（`claude.cmd`）を閉じないwindowで開くので使わない。

### 変わらない事

- macOSの動き。LinuxのClaude Codeには`--desktop`が無い（`--desktop isn't available on this platform. It works on macOS and Windows (x64).`）ので、Linuxでは今までどおり裏の会話のままにする。

### 確認した範囲

- Windowsで、端末から始めた会話に`THROUGHLINE_AUTO_HANDOFF_OPEN=desktop`を付けて流した。続けて4回引き継ぎ、最後の後継が作業を終えた16秒後に、Claude Desktopがその会話を取り込んだ。途中の後継は移っていない。
- Linux（Claude Code 2.1.293）で、Claude Codeの自動継続が続けて3回引き継いで完了する事（後継は裏の会話のまま）。

### 確認していない範囲

- WindowsとmacOSの、Claude Desktopの画面から始めた本物の会話での通し。

## [0.16.8] — 2026-10-08

### 追加

- Claude Codeの自動継続で、Claude Desktopの画面から始まった会話の後継を、そのターンの作業を終えた時にClaude Desktopへ移して開く（macOS。[ADR 0043](docs/adr/0043-claude-successor-opens-in-desktop.md)）。今までは、後継は裏の会話（`claude agents`の一覧）にだけ出て、Desktopの一覧には出なかった。Desktopで作業している時、旧い会話が止まり、続きが見えないまま裏で進んでいた。
  - 後継がターンを終えると、手すきになるのを待って`claude stop`で止め、`claude --desktop --resume <session id>`で開く。Claude Codeは、裏で動いている会話（作業中も手すきも）をDesktopへ移さない。作業の間は、今までどおり裏で動く。
  - 続けて引き継いだ時は、最後に作業を終えた後継だけを開く。
  - 端末から始めた会話の後継は、今までどおり裏の会話のままにする。環境変数`THROUGHLINE_AUTO_HANDOFF_OPEN`で上書きできる（`desktop`は必ず開く、`off`は開かない）。
- `auto-handoff status --host claude --json`の各引き継ぎへ、`desktop_state`（`waiting`・`requested`・`opened`・`superseded`・`failed`。対象外は`null`）と`desktop_error_code`を足す。

### 変更

- Desktopで開く引き継ぎでは、旧い会話を止めた理由の文に、後継がターンを終えた時にClaude Desktopへ開く事を書く。

### 変わらない事

- 後継の立て方（`claude --bg`）、記憶の渡し方、モデル・推論強度・権限の引き継ぎ。Codexの自動継続。schema（v12）。

### 確認した範囲

- macOS（Claude Code 2.1.289、Claude Desktop 2.26454.2、Haiku 4.5）の試験用フォルダで、端末から始めた会話に`THROUGHLINE_AUTO_HANDOFF_OPEN=desktop`を付けて流した。1回の引き継ぎでは、後継が作業を終えた4秒後にDesktopがその会話を取り込んだ。続けて3回の引き継ぎでは、最後の後継だけが取り込まれた。

### 確認していない範囲

- Claude Desktopの画面から始めた本物の会話での通し。印の付き方は、実物の会話記録の値（`"entrypoint":"claude-desktop"`）と単体の試験で確かめた。
- WindowsとLinuxのClaude Desktop（この版は開かない）。
- 長いターンの後継と、後継が質問で止まった時の見え方。

## [0.16.7] — 2026-10-08

### 修正

- Codex Desktopに同梱のCodexが0.162になると、自動継続が毎回`handoff_prepared_settings_mismatch`で止まっていたのを直す。旧ターンを止め、後継を作って記憶を入れた後、設定の照合で止まり、失敗の画面を出していた。Codex 0.162は、後継の設定を整えた時の記録（`thread_settings_applied`）へ、未指定のservice tierを`"default"`と書く。旧タスクの記録には項目が無いので、製品は「未指定」と「`default`」を別の設定として比べていた。同じ枠として扱う。`fast`などの別の枠は、今までどおり不一致で止める。
  - Linuxの端末（Codex Desktop 26.1002、同梱CLI 0.162.0-alpha.2）の実測。0.16.6は、続けた2回の引き継ぎが2回ともこの理由で止まった。
  - macOSとWindowsのCodex Desktopも、26.1002から同梱CLIが0.162になっている。

### 確認した範囲

- LinuxのCodex Desktopで、公式の`PreCompact(auto)`を実際に発火させた。0.16.6で止まった2つの引き継ぎを、この直しを当てた版の`auto-handoff resume`でやり直し、2つとも`continued`になった。3つの工程の値は元の指示と一致し、3つ目のタスクが最初のタスクのL3を取得した。圧縮の記録は0件。後継の名前も付いた（[実測](https://github.com/kitepon/Throughline/blob/main/evidence/2026-10-08-linux-codex-auto-handoff.md)）。
- 止まった引き継ぎの`resume`が、出来ている後継を使って続きを届ける事（上の2回）。

### 変わらない事

- 同梱CLIが0.160.1までのCodex Desktopでの動き。schema（v12）。Claude Code・Grok・Cursor。

### 確認していない範囲

- この版そのものを入れた端末で、hookから始まって人の操作なしで終わる通し。公開の後に、Linux・Windows・macOSの端末で流す。
- Linuxで、容量の既定の上限まで進んだ長い会話の引き継ぎ。

## [0.16.6] — 2026-10-08

### 修正

- WindowsのCodex Desktopで、自動継続が1回も引き継げなかったのを直す。`PreCompact(auto)`のhookが、会話記録の場所を確かめる所で`EISDIR: illegal operation on a directory, lstat 'C:'`で落ち、旧ターンだけを止めて、引き継ぎを作らずに終わっていた。Desktopが起動したhookの中では、Node.jsのJS実装の`fs.realpathSync`がdriveの根を読めない。OSの`realpath`（`fs.realpathSync.native`）を使う。製品のほかの所は、すでにこちらを使っていた。
  - Windowsの端末の実測（Codex Desktop 26.930、同梱CLI 0.160.1、Node.js 24.20.0）。同じhookの中で、JS実装は13回とも同じ理由で落ち、OSの`realpath`は13回とも通った。
  - Windowsで自動継続を有効にしていた端末は、今まで無い（既定は無効。有効にする前の確認で見つけた）。
- `throughline doctor --codex`が、Windowsで承認済みのhookを「0/3 trusted - accept hooks in Codex menu」と表示していたのを直す。Codexは、`\`を含むkey（Windowsのpath）を`config.toml`へTOMLのliteral string（`[hooks.state.'C:\Users\…']`）で書く。doctorは`"…"`の形しか読んでいなかった。hookの動きと、Codexの公式API（`hooks/list`）が返す承認状態は、今までも正しかった。

### 確認した範囲

- WindowsのCodex Desktopで、公式の`PreCompact(auto)`を実際に発火させ、A→B→Cの2回の引き継ぎを人の操作なしで通した（[実測](https://github.com/kitepon/Throughline/blob/main/evidence/2026-10-08-windows-codex-auto-handoff.md)）。2回とも`continued`。3つの工程の値は元の指示と一致し、3つ目のタスクが最初のタスクのL3を取得して完了した。圧縮の記録は0件。後継の名前は`<project名>｜<作業の概要>（自動引き継ぎ）`で付いた。

### 変わらない事

- macOSの自動継続の動き。schema（v12）。Claude Code・Grok・Cursor。

### 確認していない範囲

- Windowsで、Desktopの画面から人が始めたタスクを最初の旧タスクにした引き継ぎ。実測の最初のタスクは、製品が後継を作るのと同じ道（Desktop同梱CLIのapp-server）で作り、Desktopで開いて実行させた。
- Windowsで、容量の既定の上限まで進んだ長い会話の引き継ぎ（実測は、試験用フォルダだけ上限を60,000 tokensへ下げた）。
- Windowsの、失敗した時の説明ページの表示と、`resume`。

## [0.16.5] — 2026-10-08

### 修正

- Codexのhookが、道具を1回使うたびに、その会話のL3（`details`）を全部消して入れ直していたのを直す（[ADR 0042](docs/adr/0042-codex-capture-writes-only-changed-tail.md)）。DBにある行とrolloutの行を先頭から本文まで比べ、最初に食い違った行から後ろだけを書く。取り込んだ後の中身と並びは、全部入れ直した時と同じ。
  - Windowsの端末で、L3が3,552行・約1.47億字（rolloutは288MB）の会話のhookが、1回でWALへ152.9MBを書いていた。その端末の`throughline.db-wal`は12.8GBまで伸びていた（DB本体は230MB）。本物のDBの写しで測ると、変化の無いhookは0.3MB、89行が増えたhookは12.5MBになる。
- `getDb()`が`PRAGMA journal_size_limit`を64MBに設定する。WALが使い直された後の最初のcommitで、ファイルを64MBまで切り詰める。今までは、一度伸びたWALは中身が空になっても縮まなかった。

### 変更

- rolloutに時刻の無いL3の行は、最初に取り込んだ時刻のまま残る。今までは、取り込むたびにその時の時刻へ変わっていた。
- `codex-capture --json`の結果へ、`keptDetails`・`writtenDetails`・`removedDetails`を足す。

### 変わらない事

- schema（v12）。`bodies`（L2）と`skeletons`（L1）の扱い。
- Claude Code・Grok・Cursorの取り込み。

### 確認していない範囲

- 複数のCodexの会話が同時に動く本物の端末で、WALが伸びなくなるか。公開の後に端末で読む。
- hookは今までどおり毎回rolloutの全体を読む。上の会話では約1.1秒かかる。Codexの画面での待ちとして見えているかは調べていない。

## [0.16.4] — 2026-10-07

### 変更

- Codex StopのL1要約backend（Codex CLI）の失敗を、1回ごとにruntime errorとして数えるのをやめる（[ADR 0041](docs/adr/0041-l1-summarizer-backend-unrecovered.md)）。この失敗は、通信の断、利用上限、認証切れ、利用者の取り消しでも起きる。会話の取り込みは済んでいて、要約は次のStopがやり直し、recallはL2の本文を返すので、修理の対象として自動で登録しない。理由と外部CLIのstderrの末尾は、今までどおり端末の`hook-failures.log`に残る。hookの終了codeとstderrは変えない。
- 最初の失敗から24時間を過ぎても成功を確認できない時だけ、`L1_SUMMARIZER_BACKEND_UNRECOVERED`（`warn`）で数える。要約が成功したら、その記録を`recovered`で解決にする。
- Codexの自動継続のworkerは、要約のbackendの失敗を`handoff_summarizer_backend_failed`で止める（今までは汎用の`handoff_worker_failed`）。失敗の画面に、通信の断・利用上限・認証切れで起きる事、記録と入力が失われていない事、再開の仕方を書く。

### 変わらない事

- BugHubへ送る本文の形。項目は足していない。
- hook処理の失敗（`HOOK_*_FAILED`）の数え方と重大度。これらの経路に通信は無い。
- BugHubへの送信の失敗は、今までどおり送信の状態にだけ残し、runtime errorには数えない。

### 確認していない範囲

- 要約が失敗し続ける間のCodexの画面への影響。
- 本物のCodex CLIが、通信の断・利用上限・認証切れのそれぞれで返す終了codeとstderr。

## [0.16.3] — 2026-10-07

### 修正

- Codexの自動継続で、引き継ぎの最中（継続の指示を送る前）に旧タスクへ入力が来ると、同じ旧タスクから2つ目の引き継ぎが立っていたのを直す（[ADR 0040](docs/adr/0040-auto-handoff-no-second-successor-while-pending.md)）。1つ目は`handoff_source_advanced`で失敗して失敗の画面を出し、記憶だけが入った後継が残っていた。workerが動いている引き継ぎがある間は、新しい引き継ぎを作らず、ターンを止めて進んでいる引き継ぎのIDを示す。入力を受けただけで止まったturnは、元turnの境界を進めた物として数えない。
- 後継を作った後、配送の前に止まった引き継ぎは、次の入力で同じ引き継ぎをやり直す（同じID、出来ている後継を使う）。今までは別の引き継ぎを作り、後継が2つになっていた。後継を利用者がもう使っている時、後継が消えている時、旧タスクが進んでいる時、後継を作る前に止まった時は、今までどおり新しい引き継ぎを作る。
- 2つの入力がほぼ同時に来た時は、先に記録した方だけが引き継ぎを作る。
- 引き継ぎの最中に旧タスクへ来た入力は、後継へ渡す記憶に入れない。
- Claude Codeの自動継続で、引き継ぎの記録を24時間で掃除していたため、その後に同じ会話からもう1つ後継が立っていたのを直す。後継の会話が残っている間は、記録を消さない。

### 変わらない事

- 後継が残っていない（消した、アーカイブした）旧タスクからは、今までどおり新しい後継を立てる。
- 止める場所は`PreCompact(auto)`のまま。旧タスクが圧縮に掛からない間は、旧タスクはそのまま動く。
- DBの形は変えない（v12）。

### 確認した範囲

- macOSで、公開するtarballを切り離したHOMEへ入れ、2026-10-07の実物のrolloutと`codex_handoffs`の写しへ当てた。止まった入力が続くrolloutで境界が進まない事、最中の入力で行もworkerも増えない事、引き継ぎ済みの旧タスクと引き継いでいないタスクが0.16.2と同じ動きである事。
- 同じ旧タスクへ6つの入力を同じ時刻に入れて、引き継ぎが1つだけ出来る事（LinuxとmacOS、本物のprocess）。

### 確認していない範囲

- 本物のCodex Desktopでの通しと、画面で最中の入力を止めた理由がどう見えるか。
- 同じ引き継ぎのやり直しを、本物の後継のタスクで。
- Claude Codeの記録を残す事を、本物のClaude Codeの会話で。

## [0.16.2] — 2026-10-07

### 修正

- Codexの自動継続で、引き継ぎ済みの旧タスクへ新しい入力が届くたびに、同じ作業を引き継いだ後継がもう1つ立っていたのを直す（[ADR 0039](docs/adr/0039-codex-auto-handoff-one-successor-per-source.md)）。重複を見ていたのは元のタスクと元のターンの組で、旧タスクに新しいターンが出来ると別の引き継ぎとして受けていた。継続の指示が届いた後継が残っている間は、新しい引き継ぎを作らず、ターンを止めて、止めた理由に引き継ぎID・後継の名前・`codex://threads/<後継>`を書き、Desktopで後継を開く。後継がさらに引き継いでいれば、その先を示す。
- workerは、継続の指示を送る直前に、同じ旧タスクの別の引き継ぎが先に指示を送っていないかを確かめる。送られていれば`handoff_source_already_continued`で止まり、後継へ指示を送らない。
- 止めた事を`~/.throughline/codex-auto-handoff/redirects.jsonl`に1行残す（会話の本文は書かない）。

### 変わらない事

- 配送の前に失敗した引き継ぎしか無い旧タスクと、後継が残っていない（消した、アーカイブした）旧タスクからは、今までどおり新しい後継を立てる。
- 旧タスクへ打った入力は後継へ渡さない。後継で打ち直す。

### 確認した範囲

- macOSのCodex Desktop（0.16.1）で2026-10-07に起きた記録（同じ旧タスクから3つの引き継ぎ）を読んだ。

### 確認していない範囲

- Codex Desktopの画面で、旧タスクに止めた理由がどう見えるか。

## [0.16.1] — 2026-10-07

### 修正

- Claudeのターンの途中で会話記録（transcript）のフォルダが消され、Claude Codeが残りの行だけでファイルを作り直した時、Stopのhookが`Claude Stop transcript completion was not visible before deadline`で失敗し、`HOOK_PROCESS_TURN_FAILED`を数えていたのを直す（[ADR 0038](docs/adr/0038-stop-flush-barrier-head-lost-transcript.md)）。期限まで待って、transcriptに応答だけがあり利用者の発言が1つも無い時は、失敗に数えず、`backfill.log`に`skipped: "transcript_head_lost"`を残して終わる。ファイルが残らなかった時（`transcript_absent`、[ADR 0029](docs/adr/0029-stop-flush-barrier-absent-transcript.md)）と同じ扱いにする。
- 利用者の発言が残っているのに完了が見えない時は、今までどおり失敗に数える。

### 確認した範囲

- Linuxのコンテナ（0.15.5、Claude Code 2.1.292）で2026-10-07に起きた失敗の、transcriptとStopのpayloadを切り離した置き場で再生した。0.15.5は同じ文面で失敗して1回数え、この版は失敗に数えず`transcript_head_lost`を記録した。

### 確認していない範囲

- 同じ朝に同じ試験の道具で数えられた残り11回の失敗は、transcriptが後で消されていて、同じ形だったかを直接は見ていない。11回とも、その会話の最後のStopで起きている。
- macOSとWindowsでは、この形の失敗を再現していない（足した試験はCIの3環境で走る）。

## [0.16.0] — 2026-10-07

### 変更

- 自動継続が立てる後継に、`<project 名>｜<作業の概要>（自動引き継ぎ）`の名前を付ける（[ADR 0037](docs/adr/0037-auto-handoff-successor-title.md)）。一覧を見た時に、どのprojectの何の作業の続きかを読めるようにする。
  - Claude Code: 今までの名前は`tl-<フォルダ名>-<引き継ぎIDの先頭8桁>`で、Claude Desktopの一覧にもそのまま出ていた。作業の概要は前任の会話の題（Claude Desktopの題、人が付けた題、Claude Codeが付けた題の順）から取り、題が無ければ止めた時点の依頼の最初の行を使う。
  - Codex: 今までは後継タスクに名前を付けておらず、継続の指示（`Throughline自動継続 <ID> / <ID>`）がそのまま題として見えていた。前任のタスクの題を概要にして、後継を作った直後に`thread/name/set`で付ける。前任がこの版より前に立てた名前の無い後継なら、引き継ぎの記録をさかのぼって元のタスクの題を使う。
- 概要は40字で切る。引き継ぎを重ねても、project名と印は積み重ならない。AIは呼ばない。
- Codexで名前を付けられなかった時も、引き継ぎは止めない（理由はworkerのログに残る）。

### 確認した範囲

- Linux（Claude Code 2.1.292、Haiku）の切り離した置き場で、本物の会話に自動圧縮と道具のhookを渡した。後継は`p1｜read file fruit colors（自動引き継ぎ）`の名前で立ち、継続の指示を受け取った。その後継からもう一度引き継ぐと、3つ目も同じ名前になった。
- Linux（Codex 0.160.1）のapp-serverで、新しいスレッドに最初のターンの前に付けた名前が、ターンの後も残る。
- 公開するpackageを展開して、本物のworkerから後継を立て、`claude agents`に出る名前が渡した名前と一致することを3環境で見た（題は日本語・全角の記号・`&`・二重引用符を含む）: Linux（Claude Code 2.1.292）、macOS（2.1.289）、Windows 11（2.1.292、PowerShellのshim経由、Node 24.20.0）。
- macOSのCodex Desktopに同梱のCodex（0.160.1）が`thread/name/set`を持つ。

### 確認していない範囲

- Codex Desktopの実機での自動継続の通し（後継タスクが一覧に新しい名前で出るところ）。確かめたのは、同じ版のCodexのapp-serverで名前が付いて残ることまで。
- Claude Desktopの一覧に新しい名前が出るところ。今までの名前（`tl-…`）がDesktopの題としてそのまま出ていたことは、macOSの記録で見ている。

## [0.15.5] — 2026-10-07

### 修正

- Windowsで、同じhookが続けて走る会話（Cursorが約10秒おきにターンを回す会話など）の間に、hookが`disk I/O error`で落ちることがある不具合を直す（[ADR 0036](docs/adr/0036-first-read-retry-on-io-error.md)）。落ちるのはDBを開いた直後の最初の読み取りで、落ちたhookはその回の記憶の注入や保存をしなかった。hookはDBを閉じずに終わる。終わったprocessの片付けと次のprocessの最初の読み取りが重なると、SQLiteがWALの索引を切り詰められずに失敗を返していた。最初の読み取りを、`disk I/O error`の間だけ25msごとに読み直す（hookは最長5秒）。
- 読み取り専用でDBを開く所（`handoff-context`、`latest-session`、`auto-handoff status`、`recall`、`factory-diagnostics`、`caveat-context`、Spotter向けの`auditor-context`とObserver向けの読み出し）も同じ形で落ちていたので、同じ読み直しを通す。`migrate`も通す。

### 追加

- `hook-failures.log`に、SQLiteの拡張code（`errcode`）を残す。`disk I/O error`は文面が同じでも、codeで原因が分かれる。

### 確認した範囲

- Windows 11（Node 24.20.0）の切り離した置き場。DBを開いて閉じずに終わる短命のprocessを6列で続ける再現で、直す前は5,295本のうち128本が`disk I/O error`（code 1546）で落ち、読み直しを入れると5,180本とも開けた（読み直したのは139本、最大2回、最長74ms）。読み取り専用は、直す前に4,059本のうち217本が落ちた。
- 同じ端末で、足した試験（240本）がこの版では2回とも通り、読み直しを外すと同じ試験が`disk I/O error`で落ちる。
- Linux（Node 26）では、直す前から同じ再現で1,398本とも開ける。

### 確認していない範囲

- Windowsのどの操作が失敗を返したか。SQLiteのcode（切り詰めの失敗）までで、その下は確かめていない。
- 2026-10-04に同じ端末で起きたSessionStartとUserPromptSubmitの失敗が、同じ形だったか（当時の版は理由を残していない）。
- Codexの状態DBなど、他の製品のDBを読む所（`codex-restore-source-audit`）は変えていない。

## [0.15.4] — 2026-10-06

### 修正

- Claude Desktopで別のprojectへ移した会話を、移った後に1回もターンを終えないまま自動継続で引き継ぐと、後継へ記憶が入らない不具合を直す（0.15.2・0.15.3）。後継の最初の指示は、前任と後継のprojectが同じ時だけ前任を合流させる。前任の`sessions.project_path`を移った先へ付け替えるのはターン終了（Stop）だけだったので、その前に引き継ぐと移る前の場所のまま残り、合流が`project_mismatch`で見送られていた。後継は継続の指示だけを受け取り、記憶と止めた時点の依頼を持たずに動き出していた。
- 自動圧縮を止める時（`pre-compact`）にも、移っている会話の`sessions.project_path`を移った先へ付け替える。

### 確認した範囲

- macOS、Claude Desktop（同梱の2.1.286、権限はバイパス、0.15.3）。画面から送った指示で、圧縮を止める・旧い会話を止める・後継を立てる・継続の指示が届く、の4段が通り、承認待ちは出なかった。1つ目の後継には記憶が入らず（上の不具合）、後継は自分でフォルダを調べて作業を続け、次の引き継ぎ（後継から後継、記憶あり）を経て作業を完了した。
- macOS、同じ会話の本物のtranscriptの写しを使い、切り離したHOMEでhookを手で呼ぶ再現。0.15.3は`pre-compact`の後も`sessions.project_path`が移る前の場所で、後継の最初の指示は`project_mismatch`・注入なし。この版は移った先へ付け替わり、合流して注入する。

### 確認していない範囲

- Claude Desktopの画面で、この版の1つ目の後継に記憶が入ること。
- Linuxで実物のClaude Codeを動かした通し。Windowsのバイパスの会話、Opus・Fableの後継（0.15.3と同じ）。


## [0.15.3] — 2026-10-06

### 修正

- Claude Codeの自動継続（`auto-handoff enable --host claude`）で、旧い会話が権限のバイパス（`bypassPermissions`）の時、後継が継続の指示を受け取らずに止まる不具合を直す。後継は旧い会話の権限を引き継ぐ。Claude Codeは、バイパス中の会話へ別の会話やprocessから届いた文を、送り手が権限のmodeを名乗らない限り利用者の承認まで止める（画面には`Held peer message`と出る）。0.15.2までは、後継を立てた後で受け口へ指示を送っていたので、ここで止まり、記録は`unknown`・`handoff_delivery_timeout`になっていた。バイパス以外の権限では起きない。
- 継続の指示は、後継を立てる時の最初の指示として渡す（`claude --bg … "<指示>"`）。立てた後で外から送らない。後継の受信の設定（`crossSessionInbound`）は変えない（[ADR 0033](docs/adr/0033-claude-auto-handoff-new-session.md)の4と5を書き換え）。
- 受領は、後継の最初の指示が`~/.throughline/claude-auto-handoff/<旧会話のsession_id>.accepted`に残し、workerがそれを待って`sent`にする。最初の指示は、workerが後継のIDを記録へ写す前に届くことがあるので、その間は指示が運ぶ引き継ぎIDで後継と認める。期限（60秒）までに残らなければ`unknown`・`handoff_delivery_unconfirmed`にし、後継は立て直さない。`handoff_successor_target_unavailable`と`handoff_delivery_timeout`は出なくなる。
- 継続の指示の文に、「実行されなかった道具」はまだ実行されていないこと、最初にそれを呼び出すことを書き足す。指示が利用者の発言として届くようになり、Haiku 4.5の後継が、止められた道具をやり直さずに「読みました」と書いて先へ進んだ回があった（macOS、1回）。
- 後継の`SessionStart`は受け口を控えなくなる。Codexの自動継続は変えない。

### 確認した範囲

- macOS、Claude Desktop（同梱の2.1.286、権限はバイパス、0.15.2）。作業フォルダを移した会話で、圧縮を止める・旧い会話を止める・後継を立てる、の3段がDesktopの画面から送った指示で通り、4段目が上の理由で止まることを確かめた。
- macOS、端末の会話（Claude Code 2.1.289、Haiku 4.5）。この版で、バイパスの会話は4回、編集の自動許可（`acceptEdits`）の会話も4回、連続で引き継いで14個を読み切り完了。どの引き継ぎも`sent`で、承認待ちは出ない。指示の文を書き足す前の版では、バイパスで2回動かし、1回は完了、1回は上の「読みました」で未完了。
- Windows 11、端末の会話（2.1.289、Haiku 4.5、`acceptEdits`）。この版で4回連続で引き継いで完了。最初の指示（改行と日本語を含む）は、そのまま後継のhookへ届く。

### 確認していない範囲

- Claude Desktopの画面で、この版が最後まで通ること（後継が指示を受け取って作業を終える所）。
- Linuxで実物のClaude Codeを動かした通し。単体と結合の試験だけ。
- Windowsのバイパスの会話、Opus・Fableの後継。


## [0.15.2] — 2026-10-06

### 修正

- Claude Desktopで「フォルダなし」で始めて、後から作業フォルダへ移した会話では、自動継続（`auto-handoff enable --host claude`）を有効にしていても引き継ぎが始まらない不具合を直す。Desktopは会話を移した後も、hookへ渡す`CLAUDE_PROJECT_DIR`を移る前の場所のままにする。Throughlineはその値で対象のprojectかどうかを決めていたので、自動圧縮の前のhookが`auto_handoff_disabled`で見送り、圧縮がそのまま走っていた。
- 会話が移った先は、Claude Codeがtranscriptへ書く`relocated`の行（`relocatedCwd`）から読む。移っている会話では、自動継続の有効判定と印（baton）のprojectを、移った先にする。
- 同じ会話のターン終了では、完了ターンの控えを移った先のprojectへ書き、`sessions.project_path`を移った先へ付け替える。これまでは移る前の場所のまま残り、移った先のprojectの過去の会話（`handoff-context`、`throughline detail`）にも`observer-read`にも、その会話が出なかった。
- 移っていない会話の扱いは変わらない。`relocated`の行が無ければ、これまでどおり`CLAUDE_PROJECT_DIR`、無ければhookの`cwd`を使う。

### 確認した範囲

- macOS（Claude Desktop同梱の2.1.286が書いた本物のtranscriptの写し、移った後に自動圧縮が2回走った会話）。切り離したHOMEでhookを手で呼び、0.14.2は`pre-compact`が終了コード0・`auto_handoff_disabled`、`sessions.project_path`と控えは移る前の場所。この版は`pre-compact`が終了コード2（圧縮を止める）・`requested`、`sessions.project_path`と控えは移った先、`observer-read`は移った先のprojectで`snapshot`を返す。
- macOS、端末から始めた移っていない会話（Claude Code 2.1.289、Haiku 4.5）。この版で4回連続で引き継ぎ、14個を番号順に読み切って完了。自動圧縮は0回。

### 確認していない範囲

- Claude Desktopの画面で、この版が通しで引き継ぐこと（旧い会話を止める所と、後継を立てる所）。Desktopの画面からの送信が要るため、hookを手で呼ぶ確認までにとどまる。
- Windows・Linuxで移した会話。`relocated`の行の読み取りは、Windowsの書き方の場所を単体の試験で確かめただけ。

## [0.15.1] — 2026-10-05

### 修正

- Claudeの席で、完了ターンの控えが256件に達した後、`observer-read`・`observer-wait`へ前に受け取った位置（`--after-cursor`）を渡すと、1ターン増えるたびに`resync_required`が返る不具合を直す（[ADR 0035](docs/adr/0035-observer-cursor-prefix-only.md)）。位置の検証が、位置に入っている控えの下限の番号と今の下限の番号を比べていた。上限に達すると1ターンごとに古い1件が落ちて下限が1上がるので、追いついている位置も必ず無効になった。下限はproject全体で1つなので、落ちた控えが別の古い会話のものでも同じだった。
- 位置の検証は、位置が指す会話の先頭から読んだ分が今も同じかどうか（`prefix_sha256`の照合）だけで行う。別の古い会話の控えが落ちても、今の会話の位置は有効なままで、`append`・`delta`が返る。
- 位置の形、snapshotの返し方、`resync_required`を終了コード0で返すことは変わらない。0.15.0以前が出した位置は、そのまま使える。

### 残る制限

- 1つの会話だけで控えが256件を超えると、その会話の先頭が落ちるので、その会話の位置は今までどおり1ターンごとに`resync_required`になる。

### 確認した範囲

- 古い会話の控えで上限まで埋まったprojectで、新しい会話のターンを1つずつ足す再現。0.15.0は2ターン目から毎回`resync_required`、0.15.1は毎回`append`と、足したターンだけの`delta`を返す。
- BellTeamのコンテナで、控えが上限に達している席（連番は329まで進み、保持は256件、会話は27本、最新の会話の控えは14件）の控えを一時ファイルへ写し、最新の会話へ3ターン足した。読み終えた位置を毎回取り直しても、0.15.0は3回とも`resync_required`、0.15.1は3回とも`append`を返す。控えはhashとsession idだけで、本文は含まない。

## [0.15.0] — 2026-10-05

### 追加

- `handoff-context --project <path> --json` に `--sessions recent` を足す（[ADR 0034](docs/adr/0034-project-recent-sessions-context.md)）。同じprojectの直近の複数sessionから、同じ9,500字の予算で文脈を作る。sessionを合流させず、起動のたびに新しいsessionができるlauncher（BellTeam）向け。これまでは会話本文を持つ最新の1 sessionだけを返していたので、長い作業の後に1ターンの短い会話を挟むと、作業の内容が文脈に入らなかった。
  - 最新のsessionは、既定と同じ文（ヘッダ・現在地・案内・L2）で先頭に置く。この部分は1字も変わらない。JSONの`sessionId`もこのsessionのまま。
  - 過去の会話は、その後ろの余った予算にだけ入れる。最新のsessionのターンが全部入っている時だけ、それより前のsessionを新しい順にターン単位で足す。入らないターンが出たらそこで止める。新しいターンを飛ばして古いターンは載せない。
  - 過去の会話は別の節にまとめ、会話ごとに日時・ターン数・session idを見出しに出す。「直前の会話」「短い返事はGO」の案内は付けず、次のユーザー入力をその会話への返事として扱わないよう書く。
  - 本文を載せなかったsessionは5件まで、`throughline recall --l2 --session <id> --before <ISO> --last <N>`を付けた一覧にする。余りが足りない時は付けない。
  - 同じ`(origin_session_id, turn_number)`は1回だけ載せる。別のprojectのsessionは入れない。
  - JSONに`sessions`（`sessionId`・`role`・`firstTurnAt`・`lastTurnAt`・`turns`・`includedTurns`）を足す。schemaは`throughline.handoff_context.v1`のまま。
- 引数を付けない時（`--sessions latest`と同じ）の出力は変わらない。`--session`の意味も変わらない。`--sessions`を`--session`と一緒に付けると、使い方の誤りとして終了コード2を返す。sessionが1つのprojectでは、`--sessions recent`の`context`は既定と同じになる。
- `throughline detail` が `<YYYY-MM-DD>T<HH:MM:SS>` を受け取る。範囲は `<YYYY-MM-DD>T<HH:MM:SS>-<HH:MM:SS>`。

### 修正

- `throughline detail <HH:MM:SS>` が、実行した日のターンしか探さなかった不具合を直す。注入文の`[HH:MM:SS]`は過去の時刻で、日付が変わった後（UTCの端末では日本時間の朝9時以降）は前日のターンを指す。その時は「該当するターンが見つかりませんでした」と返っていた。日付を省いた時は、今日から1日ずつ遡り、その時刻のターンがある最も新しい日を対象にする。今日以外の日のターンを返す時は、見出しに日付を出す。

### 互換性

- 0.14.3以前に`--sessions`を渡すと終了コード2になる。呼び手は、Throughlineを先に上げてから引数を付ける。

### 確認した範囲

- BellTeamのコンテナ（Linux）の実データ。Botの席35のうち、会話のあるsessionが1つの6席は既定と同じ文、複数ある29席も最新のsessionの部分は全部、既定と同じ文。22席で過去の会話の本文が入り、文脈の中央値は4,225字から9,110字、最大9,500字で、上限を超えた席は無い。数えたのは件数と字数だけ。
- 同じ実データで、9/25以後のsession開始428回を、その時点より前に始まったsessionだけで再生した。「直前の会話が1ターン・その前が5ターン以上」の場面は19回（14席）。既定で作業の会話が入ったのは0回、`--sessions recent`では19回（入ったターンは中央値5、最少2）。
- Claude Code 2.1.289を隔離した置き場で動かした。6ターンの作業（最後に「追記してよければ『はい』と言ってください」と申し出て終わる）と、その後の1ターンの会話（別の申し出で終わる）を用意し、文脈を起動時の指示へ入れた。「はい」だけの入力は、Haiku 3回・Sonnet 1回とも最新の会話の申し出として扱われ、過去の会話の申し出は実行されなかった。過去の会話で決めた事柄を尋ねると、`--sessions recent`の文脈では道具を使わずに答え、既定の文脈では答えられなかった。過去の作業をあらためて頼んだ時は実行した。Codex・Grok・Cursorでは確かめていない。
- macOS 27.0（arm64）とWindows 11（10.0.26200）の実DBをread-onlyで読み、上限内・`sessionId`の一致・最新のsessionの部分が既定と同じ文であることを確かめた。試験はLinuxとmacOSで全件、Windowsで関係する7ファイル。
- `detail`は、UTCのコンテナで前日のターンの時刻を引き、0.14.3が「見つかりませんでした」と返す場面で、そのターンを返すことを確かめた。

## [0.14.3] — 2026-10-05

### 修正

- Windowsで、同じhookが2本同時に走った時に、片方が`Windows owner-only ACL verification failed`で失敗することがあった不具合を直す。Cursorは同じStop hookを2本ほぼ同時に起動する。新しいフォルダでの最初の応答では、1本目が受領記録のlockファイルを作り、その後で所有者だけの権限（ACL）を付けていた。権限を付け終わるまでの約1秒、lockファイルはフォルダから継承した権限のまま見える。2本目がその間に権限を検証して落ち、`HOOK_PROCESS_TURN_FAILED`に数えられていた。会話の保存は同じStopで済んでいて、失われていない。
- lockファイルは、別名で作って権限を付け、検証してから、hard linkで最終の場所へ出す。最終の場所に現れた時点で、所有者だけの権限が付いている。先に出した側が勝ち、後から来た側は既にあるlockを検証して使う。
- 実行時エラーの記録（`runtime-errors`）のlockファイルも同じ作りだったので、同じ形に直す。
- macOSとLinuxの動作は変わらない（作る時点で`0600`を指定しているので、この隙間は無い）。既にあるlockファイルの検証は変えていない。

### 確認した範囲

- Windows 11（10.0.26200）の実機。0.14.2では、lockファイルが作られて権限がまだ付いていない状態で2本目を走らせると、Cursorの実際の失敗と同じ文面・同じ呼び出し位置で落ちる。0.14.3は、同じ場面（1本目が別名を作った直後）で2本とも成功し、lockファイルと受領記録の権限は所有者だけになる。
- 同じ実機で、新しい置き場に2本・4本を同時に起動する確認を、受領記録で51回、実行時エラーの記録で15回行い、失敗0。0.14.2は同じ確認18回のうち1回で失敗した。

## [0.14.2] — 2026-10-05

### 修正

- WindowsのClaude Codeの自動継続で、後継へ記憶が入らない不具合を直す。Claude CodeはWindowsのhookをGit Bashで走らせ、起動したprojectの場所を`C:/Users/…`の形で渡す。0.14.1までは、圧縮を止めるhookがこの形のまま印（baton）を残していた。後継の最初の指示は`C:\Users\…`の形で印を探すので見つからず、記憶を注入しなかった。継続の指示は届くので、後継は記憶の無いまま動いた。配送の結果は`unknown`（`handoff_delivery_timeout`）になった。
- 印と引き継ぎの記録に残すprojectの場所を、そのOSの書き方にそろえる。macOSとLinuxの動作は変わらない。
- 「ここまでにしたこと」の道具の対象を作業フォルダからの相対で書く処理も、Windowsで効くようになる。

### 確認した範囲

- Windows 11（10.0.26200）のClaude Code 2.1.289、Haiku 4.5。対話の会話から始めて、4回連続で引き継いで作業を完了した。読み直しも読み飛ばしも無く、どの会話でも自動圧縮は走っていない。0.14.1では、同じ条件で1回目の後継に記憶が入らなかった。
- 圧縮を止める・道具を止める・`claude --bg`で後継を立てる・受け口（named pipe）へ継続の指示を送る、の4つは、0.14.1の時点からWindowsで動いていた。
- Claude Desktopの画面から始めた会話、WindowsでのHaiku以外のモデル、subagentが動いている最中の引き継ぎは確かめていない。

## [0.14.1] — 2026-10-05

### 修正

- Claude Codeの自動継続で、後継が完了済みの作業をやり直すことがあった不具合を直す。0.14.0は、止めたターンについて「止める直前の発言」1つしか後継へ渡していなかった。そのターンでそこまでにした発言と道具の呼び出しは、記憶に入っていなかった。macOSの実機（Haiku 4.5）で、後継2つが読み終えたファイルを最初から読み直した。
- Codexの自動継続と同じく、後継を立てる前に、止めたターンをDBへ取り込む。発言は全部をつないで本文（L2）に、道具の入出力は止めた道具の呼び出しまで詳細（L3）に入れる。後継は`throughline detail HH:MM:SS`で、止めたターンの入出力を取り出せる。0.14.0では、止めたターンの入出力はどこにも残らなかった。
- 後継へ渡す現在地に、次の2つを足す。
  - **このターンでここまでにしたこと**: 発言と道具の呼び出しを古い順に並べる。作業フォルダの中のファイルは相対で書く。多い時は新しい側から2,400字まで載せ、残りは件数にする。
  - **止める直前に呼ぼうとして、実行されなかった道具**: 圧縮を止めた後の応答が呼んだ道具。同じ応答に並んだ道具は全部ここに入る。
- 止めたターンは現在地にだけ載せ、直前の対話（L2）の一覧に重ねない。依頼の上限は4,000字から3,500字にする。

### 追加

- `throughline auto-handoff status --host claude --json`の各引き継ぎに`in_flight_captured`を足す。止めたターンをDBへ取り込めた時に`true`。取り込めなくても引き継ぎは止めず、依頼とここまでにしたことは後継へ渡る。

### 確認した範囲

- macOS 27.0のClaude Code。端末の会話（2.1.289）と、Claude Desktopが同梱する本体（2.1.286）を端末から起動した会話の両方から始めた。直した版で、Haiku 4.5は4回、Opus 5.5は7回、連続で引き継いで作業を完了した。読み直しも読み飛ばしも無く、どの会話でも自動圧縮は走っていない。
- Claude Desktopの画面から始めた会話、Windows、Fable、subagentが動いている最中の引き継ぎは確かめていない。

## [0.14.0] — 2026-10-05

### 変更

- Claude Codeの自動継続を作り直す（[ADR 0033](docs/adr/0033-claude-auto-handoff-new-session.md)）。0.13.0の方式（自動圧縮を通し、圧縮の直後に同じ会話へ記憶を注入する）は取り下げた。Throughlineは自動圧縮を置き換えるもので、圧縮が走る前に旧い会話を止め、記憶を持った新しい会話で作業を続ける。Codexの自動継続と同じ並びにした。
  1. 自動圧縮の直前に、`PreCompact`フックが圧縮を止め、`/tl`と同じ印を残す。
  2. `PreToolUse`フックが、旧い会話の次の道具を実行させずに止める。旧い会話は空にしない。
  3. 同じprojectに、`claude --bg`で指示を待つ新しい会話を立てる。モデル・推論強度・権限は旧い会話から引き継ぐ。
  4. 新しい会話の受け口へ、配送ライブラリ（`aiterm-steer-delivery` 0.1.13の`sendClaudeInbox`）で継続の指示を1通送る。届いた時に、止めた時点の依頼と直近の会話の原文を注入する。
- `throughline auto-handoff enable --host claude`が`PreCompact`と`PreToolUse`のフックを登録し、`disable`が外す。`throughline install`は登録しない。0.13.0の`install`が置いた`PreCompact`フックは、自動継続が無効な端末の`install`で外す。
- 続きは裏の会話で動く。`claude agents`の一覧と`claude attach <id>`で見られる。Claude Desktopの画面には出ず、後継のターンが終わって入力待ちになった後に開ける。
- 別の会話から届いた発言（`Another Claude session sent a message:`）は、Claude Codeが後ろに付ける定型の注意書きを落として保存する。
- 依存の`aiterm-steer-delivery`を0.1.9から0.1.13に上げる。

### 0.13.0から変わらないもの

- 圧縮の要約行（`isCompactSummary`）をユーザー発言として保存しない修理は、そのまま有効。

### 確認した範囲

- LinuxのClaude Code 2.1.289。対話画面の会話から始めて後継へ3回連続で引き継ぎ、最後の後継が作業を完了した。4つの会話のどれにも圧縮の記録は無く、止めた道具は実行されていなかった。
- macOS・Windows、Claude Desktopから始まる会話、subagentが動いている最中の引き継ぎは確かめていない。

## [0.13.0] — 2026-10-04

### 追加

- Claude Codeの自動継続（[ADR 0032](docs/adr/0032-claude-compact-continuation.md)）。`throughline auto-handoff enable --host claude [--project <path>]`で有効にすると、自動圧縮の直後に、圧縮前の記録を同じ会話へ注入する。注入するのは、作業途中のユーザー依頼と圧縮直前の発言、直近の会話の原文（上限9,500字）。モデルは追加の入力なしで作業を続ける。既定は無効。手動`/compact`は対象外。
- Claude Codeは、hookから作業を止めることも、新しい会話へ指示を送ることもできない。Codexのように新しいタスクへは切り替えず、hostが続ける同じ会話へ記憶を渡す。
- `throughline install`は、Claudeの`PreCompact`フック（`throughline pre-compact`）を登録する。自動継続が無効の時は、判定を記録して抜ける。このフックは圧縮を止めない。
- `auto-handoff`に`--host claude`を足す。使えるのは`enable`・`disable`・`status`。`--host`を省いた時は今までどおりCodex。

### 修正

- 圧縮をまたいだClaudeのターンが、複数のターンに割れて保存されていた不具合を直す。Claude Codeは圧縮の直後に、要約を本文に持つ`user`行（`isCompactSummary: true`）をtranscriptへ書く。0.12.9以前はこの行をユーザーの発言として数え、要約をユーザー発言としてL2へ保存していた。3回圧縮した実機のターンは4ターンとして保存された。圧縮より前のtool入出力はL3に入らなかった。
- 修正後は、元の依頼と最終回答の1ターンとして保存し、圧縮より前のtool入出力も同じターンのL3へ入れる。Observer feedの`turn_start`は元の依頼のものになる（今までは要約行のターンとして`unknown`）。修正より前に保存した行は変えない。

### 確認した範囲

- LinuxのClaude Code 2.1.289（Haiku 4.5）。`claude -p`と対話画面のそれぞれで、自動圧縮2回をまたいで作業が完了し、圧縮のたびに注入が届いた。9,099字の注入はfile化されずに届いた。
- macOS・Windows、VS Code拡張・Desktop、subagentの中の圧縮は確かめていない。

## [0.12.9] — 2026-10-04

### 修正

- 新しいDBを複数のhookが同時に開くと、どれかが`no such table: judgments`か`database is locked`で落ちる不具合を直す（[ADR 0031](docs/adr/0031-serialized-schema-migration.md)）。WindowsのCursorの会話では同じhookが2本ほぼ同時に走るので、新しい端末の最初の会話で起きる。schemaの移行は、書き込みlockを取ってから版を読み直し、1つのtransactionで終える。WALへの切り替えは、断られたら読み直して5秒まで待つ。既に現行schemaのDBを開く時の動作は変わらない。
- 切り離した置き場で再現した。新しいDBを6 processが同時に開くと、Linuxで6回中3回、どれか1本が落ちた。Windowsでも、最初の1回で2本が落ちた。修理後は48回（6 process）で失敗0。

### 変更

- `~/.throughline/logs/hook-failures.log`に、失敗した位置（`stack`、先頭6行まで）を足す。`database is locked`のような文面だけでは、どの処理で落ちたかが分からないため。端末内にだけ残し、外へは送らない。
- hookのstdinがJSONとして読めない時の文面を`hook stdin is not valid JSON (N chars): …`にする。hostがstdinを渡さずに閉じた時（0字）と、途中で切れた時を見分けられる。失敗として数えることと、終了codeは変えない。
- 2026-10-04にWindows（0.12.4）で起きたSessionStartとUserPromptSubmitの失敗各1回は、原因が分かっていない。どちらもCursorの会話で2本ほぼ同時に走ったhookの片方で、もう片方は成功している。現行schemaのDBで起きたので、上の修正の形ではない。この2つの変更は、次に起きた時に理由を端末へ残すためのもの。

## [0.12.8] — 2026-10-04

### 変更

- runtime errorの送信を有効にした端末は、未受領の記録が無くても、受け口へ最後に届いた版と今の版が違う時に、`runtime_errors`と`resolutions`が空のreportを1回送る（[ADR 0030](docs/adr/0030-report-installed-version-once.md)）。reportは`installed_version`を持つので、受け口は記録が出ていない端末の版も分かる。届いた後は、版が変わるまで送らない。reportの形、署名、送る時機と間隔は変えない。送信を有効にしていない端末（既定）と、収集が無効な端末は、今までどおり何も送らない。
- 0.12.7以前は、未受領の記録が無ければ通信しなかった。更新した端末で何も起きなければ、受け口は古い版を持ち続けていた。

## [0.12.7] — 2026-10-04

### 修正

- Claude Stop hookで、transcriptのファイルが無い会話を`HOOK_PROCESS_TURN_FAILED`（Claude Stop hook processing failed・high）として数えていた不具合を直す（[ADR 0029](docs/adr/0029-stop-flush-barrier-absent-transcript.md)）。Claude Codeを`--no-session-persistence`で起動すると、hookへ`transcript_path`は渡るが、ファイルは最後まで作られない。保存する元が無いので、Stopは期限（2秒）まで待った後、`~/.throughline/logs/backfill.log`に`skipped: "transcript_absent"`を1行残して終了code 0で終わる。ファイルがあるのに完了が見えない時と、`transcript_path`がpayloadに無い時は、今までどおり失敗として数える。
- BellTeamコンテナ（0.12.6）で2026-10-04に2回起きた失敗は、transcriptがディスクに無い1会話のStopだった。Claude Code 2.1.289を`--no-session-persistence`で動かして、同じ文面の失敗を再現した。その2回の会話がこの引数で起動されたことを示す記録は無い。

### 変更

- `~/.throughline/logs/hook-failures.log`に、Stopが失敗した会話の`session_id`と`transcript_path`を足す。理由の文面だけでは、どの会話のStopかを端末の他の記録から探すことになるため。端末内にだけ残し、外へは送らない。

## [0.12.6] — 2026-10-04

### 修正

- Codex Stop hookで、会話の取り込みが済んだ後のL1要約backend（Codex CLI）の失敗を、`HOOK_CODEX_FAILED`（Codex hook processing failed・high）ではなく`L1_SUMMARIZER_BACKEND_FAILED`（L1 summarizer backend failed・warn）として数える（[ADR 0028](docs/adr/0028-l1-summarizer-backend-failure-code.md)）。Codex CLIが利用上限や認証切れで非0終了すると、取り込みは成功しているのにhook処理の失敗として記録されていた。hookの終了codeとstderrは変えない。要約は次のStopが同じturnからやり直す。
- 0.9.0と0.12.5の両方で、20 turnを超えるスレッドのStopがCodex CLIの失敗で`HOOK_CODEX_FAILED`を記録することを再現した。Macに残っていた1151回の最後の1回は、そのスレッドが利用上限に当たった時刻と一致する。1151回すべてがこの形だったことを示す記録は無い。

### 変更

- `~/.throughline/logs/hook-failures.log`に、errorが持つ`reason`と、外部CLIの`stderr`の末尾（1000字まで）を足す。`Codex CLI summarizer failed: exit 1`だけでは、利用上限か認証切れかが分からないため。端末内にだけ残し、外へは送らない。

### 試験

- Observerのcursorがprojectのpath・session id・本文を持たないことを確かめる試験が、偶然落ちることがあった。sha256の16進に目印の`a257`が現れると失敗し、Windowsではpathをそのまま正規表現にしていた。目印を16進に現れない文字列にし、値をそのまま探す形に直す。製品の動作は変えていない。

## [0.12.5] — 2026-10-04

### 修正

- Claudeの応答が空白や改行で始まる（終わる）turnで、Stop hookが2秒待って`HOOK_PROCESS_TURN_FAILED`で失敗していた不具合を直す。Claude CodeはStop payloadの`last_assistant_message`を`.trim()`して渡すが、transcriptにはtrimする前の本文が残る。flush barrierは完全一致で比べていたので、transcriptが出そろっていても一致しなかった。前後の空白を除いて比べる（[ADR 0027](docs/adr/0027-stop-flush-barrier-trimmed-marker.md)）。保存する本文はtranscriptのままで変えない。
- Macで記録された最後の`HOOK_PROCESS_TURN_FAILED`（2026-08-31）がこの形だった。その時のtranscriptでStopを再生すると、0.10.3・0.12.1・0.12.4のどれも失敗し、この版では成功する。Macに残る8月のtranscriptでは、空白で始まる応答のStopが96回あり、96回とも保存されていなかった。

### 追加

- hookが失敗した時の理由を、端末内の`~/.throughline/logs/hook-failures.log`へ残す。1行のJSONで、項目は`ts`・`code`・`version`・`name`・`message`（1000字まで）。SessionStart・UserPromptSubmit・Stop・Codex hookが対象。runtime errorの収集・送信の設定とは独立に書き、外へは送らない。runtime error storeは定型codeと回数だけを持つので、これまでは失敗の理由が残らず、後から原因を追えなかった。

## [0.12.4] — 2026-10-04

### 修正

- WindowsのCursorがhookの標準入力へ付けるUTF-8 BOMをJSONとして読もうとして、SessionStart・UserPromptSubmit・Stopが失敗する不具合を直す。共有の読取処理で先頭のBOMを1つ取り除いてから解析する。JSONの文字列中のBOMは保ち、不正なJSONは引き続き失敗として扱う。Windowsの実hook入力でSessionStartの例外を再現し、3種類のhookで会話の保存と不正JSONの拒否を試験した。
- Cursorの`transcript_path`が未指定の場合、projectのフォルダ名をCursor自身と同じ規則で作る。以前はアンダースコアやドットを残していたため、foxの`C:\Users\kite_\.cache\…`などで実際の記録フォルダを見つけられなかった。英数字以外をハイフンに置き換え、連続するハイフンと両端を整える。指定された`transcript_path`はそのまま優先する。

## [0.12.3] — 2026-10-03

### 修正

- runtime errorの送信で、reportの`observed_at`を秒へ切り捨てていた不具合を直す。storeの`first_seen`・`last_seen`・`resolved_at`はミリ秒まで持つので、発生や解決と同じ1秒の中で送ると`observed_at`が記録の時刻より前になり、受け口が422 `invalid_report`で断る。Throughlineは422を受けると次の送信を24時間空けるので、届くのが1日遅れる。`observed_at`はミリ秒まで持ち、載せる記録のどの時刻よりも前にしない（送信を始めた後に書かれた記録にも合わせる）。署名の`ts`は今までどおり同じ時刻の秒。
- 実際に断られた送信は、この版までに確認されていない（BellTeamコンテナとMacの送信は全て受理）。同じ欠陥はLatticeで見つかり、BugHubの持ち主から確認の依頼があった。

## [0.12.2] — 2026-10-03

### 修正

- Claudeのturnが終わった直後に次の入力が届くと、Stop hookが2秒待って`HOOK_PROCESS_TURN_FAILED`で失敗していた不具合を直す。BellTeamのようにqueueの入力がturnの終わりに届く環境では、Stopの数十ms後に次のuser行がtranscriptへ書かれる。flush barrierはlatest user groupだけを見ていたため、完了したturnが1つ前のgroupへ移ると一致しなかった。latest groupにassistant本文がまだ無く、1つ前のgroupがStopの本文と一致し、そのturnが未捕捉の時は、1つ前のgroupを完了したturnとして待たずに採用する（ADR 0026）。
- これまで失敗したturnは、L2と完了受領が次のStopまで遅れ、L3（toolの入出力）は保存されなかった。直した後は同じStopで書かれる。捕捉済みの同文answerを今回の完了と取り違えない条件（ADR 0012）は変えていない。
- hookの試験の子プロセスが、親の`XDG_CONFIG_HOME`・`XDG_STATE_HOME`・`LOCALAPPDATA`を引き継いでいた。収集を有効にした端末でhookの試験が落ちると、本物のruntime error storeへ記録されていたので、設定とstateの置き場も一時HOMEへ向ける。製品の動作は変わらない。

## [0.12.1] — 2026-10-03

### 修正

- 親の会話を引き継いだCodex子agentがいるタスクで、自動継続が`handoff_thread_mismatch`で止まる不具合を直す。子のrolloutにコピーされた親の`session_meta`で子自身のIDを上書きしていたため、先頭のmetadataを識別の正本として保持する。元タスクと子の停止確認、別threadの拒否は維持する。

## [0.12.0] — 2026-10-03

### 追加

- runtime errorのaggregateを、利用者が指定した受け口へ製品自身が送れるようにする（ADR 0025）。既定では送らない。`throughline runtime-errors report-enable --credential-file <絶対path> --json`で有効にした端末だけが、credential file（`{url, key_id, secret}`）の宛先へ送る。宛先はpackageに入っていない。
- 送るのは`runtime-errors snapshot`の公開項目（固定code・定型文・回数・時刻・版・解決記録）だけ。secretは通信に載せず、本文へ`HMAC-SHA256(secret, ts + "\n" + SHA-256(本文))`の署名を付ける。redirectは追わない。
- 受領済みにするのは、受け口が200・`accepted: true`・同じ`report_id`・正しい応答署名`HMAC-SHA256(secret, report_id + "\n" + received_at)`を返した時だけ。そろわない応答では、記録を未受領のまま残す。
- 有効にした端末では、`process-turn`・`session-start`・`prompt-submit`・`codex-hook`の開始時に、多くて1時間に1回、切り離した送信processを起こす。未受領の記録が無ければ通信しない。hookは送信を待たない。credentialやreportの形で断られた時は24時間空ける。
- `throughline runtime-errors report --json`は間隔を待たずに1回送り、`sent`と`nothing_pending`だけexit 0にする。`report-status --json`は最後に試した時刻と結果の固定codeを返し、宛先・credential・pathは出さない。`report-disable --json`で止める。
- 送信設定は`runtime-errors.report.config.json`に持ち、収集の設定`runtime-errors.config.json`の形は変えない。送信を有効にしていない端末の動きは、hook入口で設定ファイル1つの有無を見ることを除いて変わらない。

## [0.11.0] — 2026-10-03

### 追加

- Codex Desktopで、公式の`PreCompact(auto)`に合わせて作業を止め、記憶を持つ新しいタスクを開いて自動で続きを実行する。`throughline auto-handoff enable [--project <path>]`で有効化し、既定では無効とする。
- 旧ターンの停止、新タスク表示後のモデル・推論強度・権限などの一致、配送した入力と実際の進捗を照合する。設定不一致や実行中状態は理由を記録して止め、送信結果不明の指示は再送しない。`status`と`resume`で同じ引き継ぎを確認・再開できる。
- schema v12に引き継ぎの状態、不変のL1/L2/L3、祖先との関係、古いターンのL1生成結果を追加する。引き継ぎ全体の直近20ターンはL2全文、それより古いターンはL1を渡し、L3は引き継ぎID・origin・turnに束縛した`detail`で取得する。
- macOSのCodex DesktopでA→B→Cを介入なしで実行し、CからAのL3を取得して3工程の完了を確認した。VS Code・CLI・他OSの自動継続は未検証とする。

### 修正

- Codexを再captureするたびにL1を削除していた不具合を直す。user/assistant両方の本文が変わらないターンのL1を保持する。
- Desktopの`custom_tool_call`と`custom_tool_call_output`もL3へ保存し、詳細を失わないようにする。
- read-only projectionの対応schema上限を製品の`CURRENT_VERSION`から参照し、schema更新後も既存の読取機能を利用できるようにする。

## [0.10.23] — 2026-10-03

### 修正

- `throughline install`がCodexの`~/.codex/config.toml`へ廃止済みの`[features].codex_hooks = true`を書き足していた不具合を直す。`codex_hooks`は現行の`hooks`の旧名で、Codexは起動のたびにdeprecated警告を出す。installは`hooks = true`だけを書き、`[features]`に残っている`codex_hooks`の行は値によらず外す。旧名は`false`でもhookを無効にするため、`hooks`へ寄せる。`[features]`以外のsectionは触らない。既存環境は`throughline self-update`で書き直される。
- `[features]`へ行を足す時、次のsectionとの間の空行より前へ入れる。これまでは空行の後ろへ足し、次のsection見出しと隣り合っていた。

## [0.10.22] — 2026-10-01

### 追加

- `throughline observer-read --wire v2`を足す。v2は本文を切らずに返し、各ターンへ実際のharness（`claude`・`codex`・`grok`・`cursor`）と始まり方`turn_start`（`prompt`・`self`・`unknown`）を付ける。既定のv1は変わらない（ADR 0024）。
- DB schema v11で`bodies.turn_start`を足し、Stop時にhostの印からターンの始まり方を残す。Claudeは`origin.kind`、Grokは`synthetic_reason`、Cursorは自分から始める時の固定文で見分ける。既存の行は`unknown`になる。

### 修正

- Claude Codeで作業中に下位ディレクトリへ`cd`して終わったターンが、起動したprojectのObserver feedに載らなかった不具合を直す。完了受領はClaude Codeがhookへ渡す`CLAUDE_PROJECT_DIR`のprojectに書く。

## [0.10.21] — 2026-09-30

### 修正

- WindowsのGrok hookが全件`ParserError`で失敗していた不具合を直す。GrokはWindowsでhook commandをPowerShellで実行するため、引用符付きの`node.exe`パスの後ろに引数を並べると構文エラーになる。`throughline install`はWindowsでGrok hookの先頭へCodex hookと同じ呼出し演算子`& `を付ける。既存環境は`throughline self-update`で書き直される。

## [0.10.20] — 2026-09-27

### 追加

- `throughline room-context --json`で外部のルーム発言を部屋ごとに記録し、指定発言までの直近3ターンを公開JSONとして返す。発言IDによる再送は冪等とし、異なる本文への再利用はエラーにする。
- DB schema v10にルーム発言テーブルを追加する。既存の会話記憶とread-only projectionは引き続き利用できる。

### 修正

- 高負荷時の外部app-server記録を待つ時間を最大3秒にし、durable verificationの早すぎる失敗を防ぐ。hook失敗時の診断子プロセスにも最大5秒を与える。全試験の同時実行数を4に抑え、子プロセス起動を含む試験の資源競合を減らす。

## [0.10.19] — 2026-09-24

### 追加

- `throughline caveat-context`で、指定セッションの完了済み直近3ターンの会話と保存済みThinkingを、ツールログを含めずに読み取り専用JSONとして渡す。ホストの記録を指定した場合は最新ターンとの一致を検証する。

### 削除

- codex-sidecarのL1要約呼出し、診断・dry-run CLI、専用設定を削除する。Claude primaryの要約はCodex CLIから始める。

## [0.10.18] — 2026-09-23

### 修正

- runtime snapshotに実発生時の`product_version`を公開し、取得時の導入版と区別する。snapshotによる件数・時刻・発生版の変更は行わない。
- L2のuser本文から端末制御を落とす。色・cursor移動・private mode・OSC（Windows ConPTYのtitle等）を除き、CRLFはLFに、行内のCR上書きは最後の表示だけにする。L3のtool出力にも同じ処理を使う。
- Claude Codeの背景task通知は、状態・要約・Monitorのevent・subagentのresultだけを記憶に残す。識別子・出力path・定型の注記と、入力待ち時に付く端末の生出力は落とす。

### 変更

- npm公開をTrusted Publishingへ移した。既定ブランチへ着地したrelease commitに`v<version>` tagをpushすると、`.github/workflows/publish.yml`が公開する。

## [0.10.17] — 2026-09-12

### 修正

- npm 12が単一要素配列で返す公開版情報を自己更新で受け入れるようにした。
  正常にpackageを更新しても`version_verification_failed`で停止する問題を修正した。
  旧文字列形式を維持し、複数版・空配列・不正な値は後続の設定・移行処理の前に拒否する。
- 公開前の梱包文書検査も、npm 12がpackage名をキーにして返す梱包情報に対応した。

## [0.10.16] — 2026-09-07

### 修正

- WindowsのDesktop引き継ぎで、稼働中のアプリが使うCodex実行ファイルを選ぶようにした。
  PATH上の古いCodexがデスクトップ版の設定を読めず、新規タスクの作成に失敗する問題を修正した。
- 引き継ぎ結果へCodex実行元を表示する。アプリの実体を特定できない場合は理由を出して停止する。

## [0.10.15] — 2026-09-06

### Fixed

- Windowsでnpmから導入したCodexをThroughlineの新規タスク引き継ぎと診断から起動できるようにした。
  OS境界の起動処理を通し、PowerShell 7経由の標準入出力をUTF-8で受け渡す。
- Windowsの起動試験を通常のテストと製品CIへ含め、日本語と接続中の要求・応答を検証する。
- Windowsの起動条件、Codexフックの承認、既存ログの回収を文書化した。
  自動refreshの古い案内を直し、公開版と開発中の版の参照先を分けた。

## [0.10.14] — 2026-09-02

### Added

- `handoff-context --project <path> --json`で、指定project内の会話本文を持つ最新sessionを
  read-onlyで選び、本文がなければ`empty`を返せるようにした。
- `--disclosure silent`を補足ファイルなしで指定できるようにし、埋込製品が短期記憶だけを
  基盤案内なしで受け取れるようにした。

## [0.10.13] — 2026-09-02

### Fixed

- 通常の引き継ぎ案内を最初の応答だけに限定し、project束縛済み補足から
  `handoffDisclosure: "silent"`を指定したlauncherは案内を非表示にできるようにした。
- Throughline旧版がassistant本文へ付けた固定宣言行だけを次回引き継ぎ時に除外し、
  ユーザーの引用と宣言後の会話本文は保持する。

## [0.10.12] — 2026-09-01

### Changed

- 変更した実装の依存関係から必要なテストと工場環境を選び、依存を確定できない変更だけ全件へ広げ、選択jobのskip・cancel・failureを最終gateで拒否する製品所有CIへ更新した。
- 文書だけの変更はLinuxの文書検査だけを実行し、共通・未分類の製品変更は従来どおり3環境で検証する。

## [0.10.11] — 2026-09-01

### Fixed

- Codex 0.151以降が会話本文を`response_item`だけに記録するrolloutでも、userとassistantの
  発言をL2へ取り込む。旧`event_msg`が併記されるrolloutでは同じ発言を二重保存しない。

## [0.10.10] — 2026-09-01

### Fixed

- Grok 1.0.13がcamelCaseとsnake_caseのhook属性を同時に送る場合でも、Grokの
  予約環境変数をhost境界として`grok:` sessionへ正規化する。Stop hookをCursorと
  誤認して同じBotに`cursor:` sessionを作る問題を修正した。
- `latest-session`と`handoff-context`のread-only SQLite接続にも、書込接続と同じ
  5秒の競合待ちを適用した。hook書込と再起動時の記憶読取が重なっても、即時失敗しない。

## [0.10.9] — 2026-09-01

### Fixed

- `handoff-context --supplement-file`は、capture済みsessionに会話本文がまだ無い場合でも、
  同じprojectに束縛された補足記憶だけを9,500字予算内で返す。Cursorの初回Workspace
  Trust直後など、session行だけが先に作られたBotも記憶付きで再起動できる。
- Windowsの子プロセスとowner-only ACL処理を、工場標準のPowerShell 7へ統一した。
  製品CIも現行の3環境（macOS・Linux workstation・Windows native）を直接検証する。

## [0.10.8] — 2026-09-01

### Added

- `handoff-context`へ任意の`--supplement-file`を追加した。補足JSONは元sessionの
  `project_path`と一致する場合だけ、長期記憶・RAGとして既存の9,500字枠へ合成する。
  DBの所有権と既存の補足なし出力は変えない。

## [0.10.7] — 2026-09-01

### Added

- `throughline latest-session --project <absolute-path> --json`で、指定した
  projectだけの直近session IDをread-onlyで取得できるようにした。
  BellTeamのような外部ランチャーは、別projectの記憶を混ぜずに既存の
  `handoff-context`境界へ接続できる。

## [0.10.6] — 2026-09-01

### Fixed

- Document the one-time official npm bootstrap required when upgrading from
  v0.10.4 or earlier, whose CLI predates `throughline self-update`. Once the
  current CLI is installed, all later updates continue through the single
  `throughline self-update` entry.

## [0.10.5] — 2026-09-01

### Added

- `throughline self-update` now owns the complete product update path: official
  npm package update, integration reapplication, existing-database migration,
  installed-version verification, and public diagnostics. Factory callers no
  longer need to interpret Throughline's migration schema. It resolves the new
  CLI from npm's global root, rejects old-CLI help or malformed handshakes even
  when they exit zero, requires overall diagnostics readiness, preserves child
  errors, and uses `npm.cmd` through PowerShell 7 on Windows. It also refuses a
  mixed-prefix update when the public `throughline` on PATH does not resolve to
  the newly installed CLI and version.

### Fixed

- Session inheritance now refuses to reassign L1/L2/L3 memory when the named
  predecessor and successor belong to different projects. Project-scoped
  predecessor discovery already filtered candidates, but the final merge
  state transition did not enforce the same ownership invariant itself.

## [0.10.4] — 2026-08-30

### Changed

- Runtime-error collection is now configured and owned by Throughline itself.
  `throughline runtime-errors enable|disable --json` writes the private,
  versioned product config under the Throughline config directory. The runtime
  no longer reads dotagents factory-reporter configuration; factory integration
  uses the public `runtime-errors ... --json` boundary.
- Corrected the documented Claude handoff boundary: built-in `/clear` does not
  reach `UserPromptSubmit`; VS Code uses `SessionStart source='clear'`, while
  Claude Desktop requires `/tl` before `/clear`.
- Moved the completed v0.4 auto-handoff plan into `docs/archive/` and replaced
  the current path with a concise current contract. Fixed Lattice consumers of
  other archived plans keep small compatibility entrypoints.
- Product-owned CI now runs `npm run verify:docs` for Markdown-only changes,
  checking local links, the document/archive indexes, compatibility stubs, and
  relative link/image closure inside the actual npm tarball file list.
- The Windows-native product CI path now uses PowerShell 7 exclusively.

## [0.10.3] — 2026-08-24

### Added

- Cursor を first-class hook host にする（工場 Cursor harness campaign Wave 6）。
  - envelope は `hook_event_name=sessionStart|beforeSubmitPrompt|stop` と
    `conversation_id` / `cursor_version`。session id は `cursor:<uuid>`。
  - L2 は payload の `transcript_path`、無ければ
    `~/.cursor/projects/<slug>/agent-transcripts/<id>/<id>.jsonl`。
  - `throughline install` は `~/.cursor/hooks.json` へ絶対 `node` +
    `bin/throughline.mjs` の sessionStart / beforeSubmitPrompt / stop を upsert
    する。工場 hook（`cursor-*-hook`）は残す。bare `throughline` は書かない。
  - beforeSubmitPrompt は continue のみなので、引き継ぎ注入は sessionStart の
    `additional_context`。`/tl` 後継の自動起動はしない。
  - Claude / Codex / Grok 契約は変えない。

## [0.10.2] — 2026-08-24

### Changed

- 挙動不変のOS/harness層集約リファクタ（harness用語統一campaignの分離規約）:
  - LOCALAPPDATA / XDG_CONFIG_HOME / XDG_STATE_HOME のベースディレクトリ組み立てを
    新設`src/os/app-dirs.mjs`へ一本化（runtime-error-store / completed-turn-receipts
    に3重実装されていた）。
  - hostリテラル比較（`'claude'`／`'codex'`）6ファイルを`src/hosts/identity.mjs`の
    定数importへ統一し、「識別の唯一の正本」宣言と実装を一致させた。
  - codex-auto-refreshの独自パス正規化を`src/os/paths.mjs`の
    `foldPathCaseForPlatform`へ、codex-sidecarのwin32判定を同`isWin32Platform`へ委譲。
  - `hosts/identity.mjs`の分類語をvendorからharnessへ更新（用語のみ）。

## [0.10.1] — 2026-08-23

### Changed

- Internal refactor with no behavior change. Vendor (hook host) identity and
  per-host behavior moved into `src/hosts/` — `hosts/identity.mjs` is the
  single source of the `codex:` / `grok:` session prefixes (previously
  duplicated across four files), and the shared hook entrypoints
  (`session-start` / `prompt-submit` / `process-turn`) now branch through
  `hosts/{claude,codex,grok}.mjs` adapters instead of inline host checks.
  `src/hook-envelope.mjs` is merged into `hosts/grok.mjs`.
- OS-specific code moved into `src/os/` — the Windows owner-only ACL
  PowerShell implementation that was duplicated verbatim in
  `runtime-error-store` and `completed-turn-receipts` is now the single
  `os/windows-acl.mjs`, alongside macOS Terminal launch, OS URL open,
  shell/AppleScript quoting, Windows path case folding, and the portable
  spawn helper. DB schema, injection contract, and every CLI surface are
  unchanged; full regression is 761 pass / 0 fail.

## [0.10.0] — 2026-08-17

### Added

- Grok is a first-class hook host. CamelCase envelopes are normalized to
  `grok:<sessionId>` and L2 is recovered from Grok `chat_history.jsonl`.
  `throughline install` writes `~/.grok/hooks/throughline.json` with absolute
  `node` + `bin/throughline.mjs` commands so Desktop GUI PATH can fire them.
  The v0.9.1 Claude-facing no-op for non-Claude envelopes is withdrawn.
- `throughline grok-continue --session <id>` starts a person-facing Grok seat
  whose first user text is the handoff-context body. cwd is the source
  session's `project_path`, not the caller's cwd. The first user text is
  preamble + context + continue + wait. Missing context or project_path does
  not spawn. `--rules`, aiterm, and `--from` are not used. macOS Terminal only.
- Grok `/tl` writes the baton and then launches `grok-continue` as a side
  effect. Claude `/tl`, Codex `/tl`, and Grok `/clear` do not launch it.
  Empty-L2 sources (including a `merged_into` chain member with no bodies)
  do not spawn. The list of record is the session directory under
  `~/.grok/sessions/<encodeURIComponent(cwd)>/`. Desktop Inactive folding is
  not a success condition.

### Documentation

- README, README.ja, contributor entrypoints, docs overview, ADR 0021
  current state, and the successor-launch plan now state the live Grok
  `/tl` → `grok-continue` contract. Historical ADRs and archived plans
  remain point-in-time records.

## [0.9.1] — 2026-08-14

### Fixed

- Claude-facing SessionStart, UserPromptSubmit, and Stop entrypoints now ignore
  non-Claude camelCase envelopes immediately after JSON parsing and before any
  database, state, VS Code task, handoff, transcript, or runtime-error side
  effect. The boundary requires non-empty `sessionId` and `hookEventName` and
  the absence of Claude's `session_id`; it does not convert payloads or add a
  Grok transcript reader.

### Changed

- CI now uses the shared factory workflow for the maintained native and WSL2
  environments.

### Documentation

- Synchronized the current README, Codex skill, contributor entrypoint, docs
  overview, and implementation plan around the v0.9.0 read-only handoff-context
  contract. Historical ADRs, archived plans, and RAG source records remain
  unchanged as point-in-time evidence.

## [0.9.0] — 2026-08-04

### Added

- `throughline handoff-context --session <id> --json` returns the exact
  budgeted SessionStart inheritance context through a versioned local CLI
  boundary. It opens only an existing database read-only and never creates or
  migrates it, consumes a baton, merges sessions, changes `sessions.merged_into`,
  or reassigns L1/L2/L3 memory rows.

## [0.8.9] — 2026-08-02

### Fixed

- Codex hook diagnosis no longer depends on the caller's `PATH`. The expected
  hook command is rebuilt per invocation, and `resolveCodexHookNodePath` returns
  the PATH form of Node when one is on `PATH` and `process.execPath` otherwise.
  Comparing that string against the registered command classified a correctly
  installed hook as a legacy command whenever the two representations differed,
  so `doctor --codex` reported "legacy command needs reinstall" and
  `factory-diagnostics` reported `codex_hooks` as `not_ready` for every scheduled
  run started from a minimal environment. Hook commands are now compared by
  parsed identity — same Node executable by realpath, same CLI script by
  realpath, same event — so a hook registered as `/opt/homebrew/bin/node` still
  matches an expectation resolved to `/opt/homebrew/Cellar/node/<ver>/bin/node`.
  Hooks pointing at a different Throughline installation, a different event, or
  the legacy PATH-resolved form remain flagged for reinstall, and paths whose
  realpath cannot be resolved are never treated as equivalent.

## [0.8.8] — 2026-08-02

### Fixed

- Codex hook installation now writes the supported `timeout` field in seconds
  for UserPromptSubmit, PostToolUse, and Stop. The previously emitted
  `timeoutSec` field was ignored by Codex, leaving all three hooks at the
  600-second default.
- Reinstall canonicalizes existing Throughline-managed hooks by command
  identity, replacing legacy `timeoutSec` entries while preserving unrelated
  Codex hooks. Doctor reports the effective `timeout` field and explicitly
  flags the legacy key for reinstall; factory diagnostics no longer classify
  the ignored key as ready.

## [0.8.7] — 2026-07-20

### Fixed

- Windows CI no longer calls the completed-turn receipt ACL PowerShell path
  hundreds of times just to construct 256-record boundary fixtures. Boundary
  behavior still crosses the limit through the public API, while dedicated
  tests preserve native owner-only ACL verification and atomic failure safety.
- Completed-turn receipt mutations now spend ACL subprocesses only on distinct
  state transitions: three for a new Windows store and four for a replacement.
- CI keeps the full 3-OS by 3-Node matrix, cancels only older runs for the same
  event and ref, and gives the unit-test step an eight-minute regression guard
  around a five-minute Windows SLO.

## [0.8.6] — 2026-07-20

### Fixed

- Republish the v0.8.5 runtime from a clean worktree after the v0.8.5 npm
  tarball accidentally included one unrelated, uncommitted in-progress
  document written concurrently after the release dry-run. Runtime behavior
  and the database migration contract are unchanged.

## [0.8.5] — 2026-07-20

### Added

- `throughline migrate --json` now provides the product-owned database
  migration entry point used after package updates. It migrates only an
  existing Throughline database, reports a versioned bounded result, leaves a
  missing database absent, and rejects future schemas or migration failures
  with a non-zero exit status.

## [0.8.4] — 2026-07-20

### Fixed

- The installed Codex skill now selects Desktop, VS Code, or CLI from the
  current Codex surface and passes an explicit `--open-host` value. A command
  launched through an older persistent PTY can no longer silently redirect a
  Desktop handoff to the PTY's inherited VS Code or Terminal host.
- `codex-handoff-start` now reports both requested and resolved open hosts in
  JSON and text output while retaining the existing `openHost` field.

## [0.8.3] — 2026-07-20

### Fixed

- Codex fresh-thread handoffs now detect when they were launched from Codex
  Desktop and open the new local task with the app's
  `codex://threads/<thread-id>` deep link instead of spawning a Terminal
  `codex resume` session. `--open-host desktop` is available explicitly;
  VS Code and CLI opening behavior is unchanged.
- Concurrent CLI and Codex hook processes now configure a bounded SQLite busy
  timeout and avoid reapplying WAL mode when it is already active. A transient
  writer or WAL recovery lock no longer makes DB initialization fail
  immediately, and a failed initialization is never retained as the singleton.

## [0.8.2] — 2026-07-20

### Fixed

- Windows native Codex hook commands now prefix quoted Node executables with the
  PowerShell call operator `&`. POSIX command strings are unchanged, and the
  existing managed-hook detector continues to recognize the canonical commands.

## [0.8.1] — 2026-07-19

### Fixed

- **Native factory diagnostics now report the database compatibility label from
  the canonical schema version.** Throughline schema v9 previously emitted the
  stale `throughline.database.v8` label alongside numeric versions `9`/`9`, so
  exact factory reporters correctly classified the installation as
  incompatible. The label is now derived from the DB migration version and a
  regression test requires the label, actual version, and supported version to
  stay aligned on future schema bumps.

## [0.8.0] — 2026-07-18

### Changed (breaking behavior)

- **Injection is now push/pull, and L1 is no longer injected (ADR 0016).** The
  budgeted resume context (9,500 chars) is rebuilt as: header +
  current-position anchor + an always-shown retrieval-guide section as the
  fixed part, then the **entire remaining budget is filled with L2 turns in
  full**, newest-first, turn-atomically (a user+assistant pair goes in whole
  or not at all — no fixed N, no fragment packing). L1 summaries are no longer
  injected; older memory is pulled on demand instead. The guide section bakes
  in the exact session id, ISO-millisecond boundary (strict less-than) and
  turn counts at injection time, so the pull side never recomputes the window.

### Added

- **`throughline recall --l2|--l1` (ADR 0016).** Read-only pull commands the
  injected guide section points at. `recall --l2 --session <id> --before
  <ISO ms> --last <N>` returns the N turns of full L2 bodies older than the
  boundary, in the same line grammar as the injection (including L3 inline
  suffixes). `recall --l1 ... --skip <N>` lists every turn older than the
  `--l2` range with its L1 summary, honestly marking unsummarized turns
  ("全 M ターン / 要約済み K") and always pointing at `throughline detail
  <time>` for full text. The DB is opened read-only; a missing DB is an
  explicit error and is never created or migrated.

### Fixed

- **Windows ACL scripts get a 15s timeout (was 3s).** On windows-latest CI
  runners a cold PowerShell start was measured at 3.0–3.2s, so the 3s
  `spawnSync` cap killed the ACL apply/verify scripts of the completed-turn
  receipt store and the runtime error store and surfaced as a flaky
  "Windows owner-only ACL verification failed" (2 consecutive runs, including
  a docs-only commit). The explicit hard-failure contract is unchanged; only
  the cap was raised.

## [0.7.0] — 2026-07-17

### Changed (breaking behavior)

- **Two-phase handoff (ADR 0014).** Claude Code can fire multiple
  `SessionStart` hooks for the same project within a few hundred ms, and some
  of them never materialize into a real session (no transcript is ever
  written). Such a "ghost" could consume the handoff baton first and silently
  swallow the predecessor's memory while the real session started empty
  (observed twice on 2026-07-17; upstream report:
  anthropics/claude-code#78455). `SessionStart` now only registers a pending
  intent (new schema v9 table `pending_handoffs`); the merge and the context
  injection happen at the session's **first `UserPromptSubmit`** — a prompt is
  proof the session is real, and a ghost never submits one. Baton eligibility
  is measured against the consuming session's birth time (`0 <= birth −
  baton_write <= 1h TTL`); a baton written after the session was born is left
  in place for its true successor instead of being stolen by a running
  session. The auto path (`source='clear'`) freezes its predecessor choice at
  `SessionStart` and skips transcript-less (ghost) candidates.
- **Injection is budgeted to 9,500 chars (ADR 0014).** Hook stdout larger than
  ~10,000 chars is silently persisted to a file by Claude Code and the model
  only sees the first 2KB (measured: 9,501 chars pass inline, 15,286 get
  persisted; every >10k injection since v2.1.195 was degraded this way).
  The resume context now always fits inline: header + current-position anchor
  are kept in full, then L1 and L2 fill newest-first. Dropped L2 rows are
  announced inside the injection with their `[time role]` references so the
  model can retrieve any of them via `throughline detail`.
- **L1 summarization backend and ratio are configurable (ADR 0015).** The
  Claude-primary backend order is now `codex-sidecar` (when configured) →
  Codex CLI (default `gpt-5.6-luna`, reasoning effort `low`, chosen by a
  measured 83-run evaluation) → Claude Haiku → raw L2, with every fallback
  step recording its reason. The compression target is a ratio (default 0.2 =
  1/5 of the source turn). Overrides: `THROUGHLINE_L1_MODEL`,
  `THROUGHLINE_L1_EFFORT`, `THROUGHLINE_L1_RATIO` (invalid ratio values are an
  explicit error, not a silent default). The Codex CLI invocation now passes
  an explicit `-m`; previously `--ignore-user-config` silently ran the CLI's
  built-in default model.

### Added

- Schema v9: `pending_handoffs` table (session_id PK, project_path, source,
  auto_predecessor_id, created_at). Rows belonging to ghost sessions are never
  consumed and stay behind harmlessly.
- The inheritance decision log now records both phases
  (`phase: 'session-start' | 'prompt-submit'`) including injection size and
  dropped-row counts.
- First npm release to include the JSON-only completed-turn Observer CLI
  boundary: `throughline observer-read` (opaque-cursor pages) and
  `throughline observer-wait` (bounded wait up to 3600s). The completed feed
  uses Throughline-owned Claude Stop receipts and Codex rollout
  `task_complete` records; stale DB projection is reported as
  `projection_pending` without bodies (ADR 0002–0013).

### Fixed

- Claude Stop waits for the transcript flush barrier before backfilling
  (ADR 0012), and Observer reads wait out transient SQLite writer locks with a
  bounded busy wait instead of failing hard (ADR 0013).

## [0.6.3] — 2026-07-14

### Fixed

- `throughline factory-diagnostics --json` now reports the Codex hook summary
  as `ready` when all three canonical managed hooks are ready. The Codex-only
  overall aggregate no longer treats the separately exposed, uninspected
  Claude connector as a blocking `unverified` state. The Claude connector
  remains explicitly `unverified`; diagnostic output remains read-only and
  privacy-safe.
- Windows runtime-error mutations no longer repeat identical PowerShell ACL
  verification inside one bounded observation. Existing lock/store files are
  still verified before use, new temporary files receive an exact
  current-SID-only ACL before atomic replacement, and the five-second hook
  observer deadline is unchanged.

## [0.6.2] — 2026-07-13

### Added

- Added an opt-in, local-only runtime error aggregate for BugHub factory
  reporting. Collection requires the canonical dotagents config boolean
  `collection.enabled: true`; it never performs network I/O or accepts raw
  exceptions, stderr, stacks, prompts, sessions, paths, or arbitrary context.
  Fixed hook error codes/templates are aggregated by SHA-256 fingerprint in an
  owner-private atomic store with count, first/last seen, resolve/reopen,
  monotonic cursor/ack, retention that preserves unacknowledged records, and
  bounded `throughline runtime-errors ... --json` snapshot/diagnostics APIs.
- Collection remains disabled by default and the local store sends no network
  traffic. Public commit `e6ce6e3`, CI `29238704750`, npm `latest`, tag / GitHub
  Release, and a registry-derived isolated install were verified.
- Raised the Node.js floor to 22.13, where `node:sqlite` is available without
  an experimental command-line flag; CI now exercises that exact minimum.

## [0.6.1] — 2026-07-13

### Added

- **Spotter auditor context v1.** `throughline auditor-context` adds an
  opt-in, JSON-only, read-only projection for Spotter. It verifies the exact
  session/project and the latest completed L2 user/assistant pair against an
  origin/turn/SHA-256 freshness expectation, supplied explicitly or derived
  from a Claude JSONL or Codex rollout. Only `fresh` returns bounded pair
  bodies; all other states return no bodies. The command never creates,
  migrates, or writes the Throughline DB. Opt-in and any onward transmission
  remain Spotter responsibilities.

## [0.6.0] — 2026-07-12

L2 capture is rebuilt from "save only the last pair each Stop" to a
full-transcript backfill, closing the permanent holes that left `/clear`
handoffs with empty or partial memory. Also documents that Claude Code
Desktop `/clear` cannot be auto-detected by hooks (upstream client bug).

### Fixed

- **L2 capture completeness (backfill).** The Stop hook previously stored
  only the last user/assistant pair, so any Stop that fired before the
  transcript flushed — or did not fire at all — became a permanent gap in
  `bodies`. Measured omission of completed logical turns was 27% (Desktop) /
  41% (VS Code). `turn-processor` now scans the whole transcript into logical
  turn groups and backfills every uncaptured turn (`src/turn-backfill.mjs`
  `backfillBodies`). On a `/clear` merge, `session-start` also backfills the
  predecessor's transcript **before** rendering the resume context, so the
  turn immediately preceding `/clear` is recovered. Verified end-to-end on a
  real Desktop `/tl` → `/clear` handoff (successor inherits the full
  predecessor conversation).
  - Group-level dedup: a logical turn group whose fragments are already in
    `bodies` is skipped whole, preventing duplicate pairs when a turn spans
    multiple Stops (interrupts, plan rejections, AskUserQuestion replies).
  - Representative fragment = the last non-junk assistant fragment; API
    notices (e.g. session-limit messages) no longer overwrite the real reply.
  - `created_at` uses the transcript entry timestamp so bulk-recovered rows
    preserve conversation order for the L2 window / current anchor.
  - Predecessor transcript path is derived deterministically from the project
    path (`deriveTranscriptPath`); the state file is only a fallback, because
    a predecessor whose Stop never fired has no state file.
  - `readTranscript` now excludes `isSidechain` entries.

### Known limitations

- **Claude Code Desktop `/clear` is undetectable by hooks.** Desktop sends
  SessionStart `source:"startup"` (not `"clear"`) and SessionEnd
  `reason:"other"` (indistinguishable from session deletion), so the auto
  handoff path never fires there. Reported upstream
  ([anthropics/claude-code#76704](https://github.com/anthropics/claude-code/issues/76704)).
  Workaround: run `/tl` before `/clear` on Desktop.
- **Desktop can drop assistant text from the transcript entirely.** In long
  tool-heavy turns, intermediate assistant text blocks are sometimes never
  written to the session JSONL (permanent, no local recovery path). Reported
  upstream ([anthropics/claude-code#76706](https://github.com/anthropics/claude-code/issues/76706)).

## [0.5.0] — 2026-05-24

This release closes out the v0.5 transcript-injection investigation and
locks in **path C** (`resume-context.mjs` v2.1 header + 現在地 anchor) as
the plugin-scope completion form for Throughline.

### Changed

- Strengthened the Claude `/clear` resume context header with two new
  short-message handling rules so the cleared-me side stops misreading
  follow-up shorts as fresh requests:
  - **短文/相槌の判定**: any user message that is ≤50 chars or built solely
    out of acknowledgment / agreement / prompt words (はい / うん / 了解 /
    OK / やって / 進めて / 続き / 次) must be treated as a GO sign on the
    previous assistant's proposed next move, not a new request, and the
    cleared-me must not ask back, re-list options, or pivot to other work.
  - **古い番号リストの再実行禁止**: when the latest user references an
    older numbered list (e.g. `2 をやれ`) but the most recent assistant turn
    already executed that item, the cleared-me must respond with a result
    confirmation / next move, not by re-executing the already-done item.
    The latest assistant utterance outranks any older numbered list
    referenced from it.

### Research (no shipped behavior change)

Two alternative injection routes were spiked end-to-end against real
Claude Code (v2.1.145) and both confirmed dead, locking path C as the
plugin-scope ceiling.

- **D route — transcript JSONL append** (Phase 0-2 / Phase 0-5): four
  real-machine runs across `SessionStart` (chain `null` orphan) and
  `UserPromptSubmit` (chain `b` reachable-from-attachment) timings, with
  both synthetic and real Claude model names. All four runs produced
  「ない」when the cleared-me was asked to quote the spike tracer. Root
  cause: Claude Code decides each new turn's `parentUuid` from its
  in-process memory state and never re-reads the JSONL, so any text a
  hook writes to `transcript_path` lives on a parallel chain that the
  next prompt's parent-walk never reaches.
- **`hookSpecificOutput.initialUserMessage` route** (Phase 0-6): real
  Claude Code interactive run on 2026-05-24 13:33 (tracer `9220a79c`,
  session `0979ad20-…`) returned 「ない」, empirically confirming the
  openclaude source comment that `initialUserMessage` is consumed only
  for headless orchestrator sessions, not for the interactive `/clear`
  scenario this project needs.

Both routes are kept in-tree behind marker files
(`~/.throughline/spike-inject.flag`,
`~/.throughline/spike-prompt.flag`,
`~/.throughline/initial-user-message-test.flag`) as research
infrastructure for future re-evaluation; they are no-op when the flags
are absent and have no effect on the shipped path.

### Added

- `docs/archive/10_transcript_injection_plan.md`: full Phase 0 plan and
  result log for the D / `initialUserMessage` investigation.
- `rag/`: third-party spec knowledge base (Claude Code hooks
  reference, Anthropic Messages API, sessions docs, openclaude
  `initialUserMessage` source extract) used as the grounding for the
  no-go calls above.

## [0.4.12] — 2026-05-17

### Changed

- Added a 「現在地 (直前のやりとり)」 anchor at the top of the Claude
  `/clear` resume context injection. The anchor re-surfaces the latest user
  directive and the latest assistant turn body (each truncated to 600
  characters) directly under the header, before the L1 / L2 sections.
  Observed failure mode: with a long L2 window the model's attention could
  fixate on the *first* L2 entry (oldest in the window) and mistake an older
  plan discussion for the current state of the conversation. The anchor pins
  the latest exchange at the position the model reads first, with the existing
  L2-tail anchor preserved as reinforcement. The header reading instructions
  now point to the new anchor as the first bullet.

## [0.4.11] — 2026-05-10

### Changed

- Disabled Codex automatic current-thread refresh from `UserPromptSubmit`,
  `PostToolUse`, and `Stop` hooks. The hooks now capture rollout memory and
  monitor state, then return `codex_auto_refresh_disabled` without injecting
  `$throughline` or sending rollback/inject. The lower-level auto-refresh helper
  is also default-disabled.
- Changed the Codex `$throughline` skill back to a new-thread handoff flow:
  bare `$throughline` now runs `throughline codex-handoff-start --execute`,
  which creates a new Codex app-server thread, injects developer handoff memory,
  and opens the selected host. Explicit `throughline trim --execute --host codex`
  remains available as a diagnostic current-thread rollback / inject command.

### Fixed

- Codex hooks registered by `throughline install` now resolve the Node
  executable through `PATH` (matching `process.execPath` by `realpath`) instead
  of always hard-coding `process.execPath`. On Homebrew-installed Node on macOS,
  `process.execPath` points at a Cellar-versioned binary that disappears on the
  next `brew upgrade`, leaving stale absolute paths in `~/.codex/hooks.json`.
  The new resolver prefers a stable `PATH` entry (e.g. `/opt/homebrew/bin/node`)
  and falls back to `process.execPath` only when no PATH entry resolves to the
  same binary.

## [0.4.10] — 2026-05-09

### Fixed

- Codex current-thread trim no longer refuses execution solely because the
  rollout active turn count differs from the Codex app-server count. When
  `thread/read` and `thread/resume` agree, Throughline now treats the mismatch
  as diagnostics and adjusts `thread/rollback.numTurns` by the app-server delta.
  For example, `expectedTurns = 6` and `readTurns = resumedTurns = 7` under
  `--all` now sends `numTurns: 7`.
- `trim --preflight --host codex` now reports the same rollback adjustment
  preview instead of returning `preflight-refused` for this recoverable
  mismatch.

## [0.4.9] — 2026-05-09

### Changed

- **Resume context overhaul.** The Claude `/clear` resume injection no longer
  carries a verbose meta-instruction ("respond with: I have inherited the prior
  task..."). The header now contains only a one-line natural-continuation cue
  and the `Bash` invocation contract for `throughline detail HH:MM:SS`. The L2
  active-work thread is anchored at the very bottom of the injected context so
  Claude's attention falls on the most recent turn instead of on a recap line.
  Older L1 summaries are now timestamped with the original turn body time
  (`bodies.created_at` MIN) instead of the skeleton row's summarization time,
  so detail commands derived from L1 lines actually resolve.
- **L3 references collapsed into per-line `(詳細：…)` suffixes.** Both the
  Claude resume context and the Codex active-work / new-thread handoff
  renderers no longer print a standalone `### L3 詳細参照` /
  `### Detail References` section. Instead, every L1 / L2 line ends with a
  compact `(詳細：…)` suffix that aggregates the L3 evidence belonging to that
  turn (`本文`, tool name, `思考`, `画像`, etc.), with `×N` only when count > 1.
  The same-turn user / assistant pair only emits the suffix on the last role to
  avoid duplicating the per-turn L3 hint. MCP tool names are shortened to the
  trailing function name (`mcp__plugin_..._playwright__browser_navigate` →
  `browser_navigate`) so namespace noise does not dominate the suffix.
- Codex auto-refresh and current-session `$throughline` trigger now use a 75%
  verified-usage threshold instead of 80%, so Throughline can fire before Codex
  native auto-compact wins the race.
- `throughline doctor --codex` now reads the Codex hook trust gate from
  `~/.codex/config.toml` (`[hooks.state."<hooks.json>:event:i:j"].trusted_hash`)
  and reports a top-level `Codex hook trust:` summary plus per-hook
  `trusted: yes/no`. A registered hook that is not yet trusted in the Codex
  hook acceptance menu may not actually run.

### Added

- `src/l3-summary.mjs`: shared helpers (`shortenMcpToolName`, `localizeL3Part`,
  `groupL3ByTurn`, `buildPartsSummary`) used by both the Claude resume context
  and the Codex handoff renderers to build the per-line `(詳細：…)` suffix.

### Notes

- The Codex `--max-detail-refs` CLI flag is preserved for backwards
  compatibility but is now a validated no-op: the new per-line suffix
  aggregates L3 references at turn granularity, so a separate cap on a
  standalone Detail References list is no longer meaningful.
- `codex-handoff-smoke` now reports `renderedDetailSuffixes` instead of
  `renderedDetailCommands` / `uniqueRenderedDetailCommands`. The
  `detail_commands_deduplicated` check has been retired because the new
  rendering aggregates L3 by turn structurally and cannot emit duplicate
  detail commands for the same turn.

## [0.4.8] — 2026-05-09

### Changed

- Codex install now registers `UserPromptSubmit` and `PostToolUse` hooks in
  addition to the Stop hook. These hooks read the current Codex rollout
  `token_count` directly and, at the verified 80% threshold, inject a
  current-session `$throughline` instruction before the assistant answers or
  continues a tool loop. This keeps automatic refresh independent of
  token-monitor and available to users who never run the monitor.
- `throughline install` now enables both `[features].codex_hooks = true` and
  `[features].hooks = true` for Codex hook compatibility.

## [0.4.7] — 2026-05-09

### Changed

- Codex Stop hook auto-refresh now uses an 80% verified-usage threshold instead
  of 90%, so Throughline can refresh before Codex native auto-compact while
  still staying above the monitor's 70% warning band. Estimate-only usage and
  estimated context windows still do not mutate the thread.
- Token monitor now discovers active Codex rollout files directly from
  `~/.codex/sessions/**/rollout-*.jsonl`, so current Codex sessions appear even
  when the Codex Stop hook has not written a Throughline state file.
- Token monitor now displays Codex session ids as the raw first 8 thread-id
  characters (`019e085c`) instead of the confusing prefixed slice (`codex:01`).
  Codex in-flight turns still overlay transient `output_tokens` in the token
  count, but the model column no longer adds a separate `live+<tokens>` marker.

## [0.4.6] — 2026-05-09

### Changed

- Codex monitor usage now overlays transient `output_tokens` while a Codex turn
  is open. During an in-flight turn the row displays `input_tokens +
  output_tokens` and marks the model with `live+<tokens>`; after `task_complete`
  the row drops back to verified `input_tokens` only.

## [0.4.5] — 2026-05-09

### Fixed

- VS Code detection now treats `VSCODE_HANDLES_SIGPIPE` as a VS Code-family
  environment signal. This lets `throughline install` provision the monitor task
  in Codex / VS Code sessions where `TERM_PROGRAM`, `VSCODE_PID`, and
  `VSCODE_IPC_HOOK_CLI` are absent.

## [0.4.4] — 2026-05-09

### Changed

- Token monitor now treats Claude transcript and Codex rollout files as live
  inputs. State-file `usage` snapshots remain a fallback, but the display and
  stale hiding no longer wait for Stop hook completion when the live files are
  still changing.
- `throughline install` now provisions or repairs the current project's VS Code
  `Throughline Monitor` task when running under VS Code / Cursor / VSCodium, so
  monitor auto-start setup no longer depends solely on the first hook event.

## [0.4.3] — 2026-05-09

### Changed

- Changed the installed Codex `$throughline` skill so bare `$throughline` runs
  the scripted current-thread refresh directly:
  `throughline trim --execute --host codex --all`. Doctor, dry-run,
  preflight, restore-safety analysis, host primitive audit, and fresh-thread
  handoff remain available only when explicitly requested instead of being the
  normal skill path.
- Changed Codex auto-refresh hook instructions to avoid `--json` on execute so
  the full trim plan / memory preview is not reintroduced as tool output after
  rollback.

## [0.4.2] — 2026-05-09

### Fixed

- Codex trim no longer falls back to the latest project session when `--session`
  is omitted. For `--host codex`, the default memory session is now the current
  Codex thread (`codex:<thread_id>` from `--codex-thread-id`,
  `CODEX_THREAD_ID`, or `THROUGHLINE_CODEX_THREAD_ID`), so Claude-side work
  cannot accidentally become the injected memory for a Codex rollback.

## [0.4.1] — 2026-05-09

### Changed

- **`/clear` も baton を書き込むように変更**。UserPromptSubmit hook で `/clear`
  を検出した時点で当該セッションの `session_id` を `handoff_batons` に書き、
  次の新規 SessionStart が確定的にそのセッションを引き継ぐ。これにより、複数
  VSCode ウィンドウなどで「最新更新セッション ≠ /clear したセッション」になる
  シナリオで `findLatestClaudePredecessor` heuristic が誤った前任を選ぶ問題を
  解消。
- **2 経路の優先順位を入れ替え**: baton path が **primary**、`source='clear'`
  の auto path は **fallback**。auto path は `/clear` が UserPromptSubmit hook
  に届かない経路 (例: VSCode 拡張のメニュー由来) のためのフォールバック扱い。

### Added

- `src/prompt-submit.mjs`: `isClearCommand` 判定 (`/clear`, `/clear ...`,
  前後空白許容、`/cleared` / `/clearcache` 等の prefix 偽陽性は拒否)。
- `~/.throughline/logs/baton-write.log` の `trigger` フィールドに
  `'tl' | 'clear'` を記録。
- `src/prompt-submit.test.mjs`: `isBatonCommand` / `isClearCommand` の判定
  テスト 14 件。
- `src/hook-entrypoints.test.mjs`: `/clear` baton の subprocess+DB 実体テスト
  3 件 (`/clear` 書き込み / `/tl` → `/clear` 後勝ち上書き / 通常 prompt は no-op)。

### Notes

- 既存の `THROUGHLINE_DISABLE_AUTO_HANDOFF=1` env は **fallback path のみに作用**
  するようになった。typed `/clear` は env に関係なく baton 書き込み → 引継ぎ発火
  する (= ユーザーが明示的に `/clear` を打った時点で「続けたい」という意思表示
  と解釈する)。auto path (VSCode メニュー由来) には引き続き env が効く。

### Repository hygiene

- `.vscode/tasks.json` を git 追跡から外す (`.gitignore` に追加)。
  `ensureMonitorTaskFile` が hook 発火ごとに絶対パスを書き換えるため、追跡
  対象に置くと別 OS / 別マシンで毎回 dirty diff が出続けていた。各マシンでは
  初回 hook 発火時に自動生成される。

## [0.4.0] — 2026-05-08

### Breaking changes

- **`/clear` で自動引継ぎがデフォルト ON** に変更。Claude Code 2.1.128 で
  SessionStart hook の `source='clear'` が reliable になったため、`/clear` 後の
  新セッションは自動的に前セッションの memory を merge + 注入する。
  ([GitHub issue #49937](https://github.com/anthropics/claude-code/issues/49937)
  は解決済み)
- **`THROUGHLINE_DISABLE_AUTO_HANDOFF=1`** env var で auto path を OFF にできる。
- **`/tl` の役割を明示意思マーカーに簡素化**。memo 4 項目入力の指示を削除し、
  baton を立てるだけの slash command に。`/tl` は env で auto OFF にしている
  ユーザー、または `/clear` を経由しない引継ぎに使う逃げ道。
- **`/tl-trim` slash command 廃止**。memo 入力 + dry-run preview の役割を持って
  いたが、memo 廃止と軽量化方針で役割なしに。Codex 経路の `throughline trim`
  CLI は維持 (`--host codex` での guarded execute / preflight など)。
- **`throughline save-inflight` CLI 削除**。memo 廃止に伴う除去。
- **`updateBatonMemo` 関数削除**。`src/baton.mjs` の export から外した。
- **schema v8 migration**: `handoff_batons.memo_text` 列を drop。
- **注入内容を L1 + L2 + L3 references のみに簡素化**。memo セクション、
  中断直前 thinking セクション、Claude 向け footer の使い方説明を削除。L2 全文
  に「次に何をしようとしていたか」が含まれているため redundant。

### Added

- `src/db.mjs`: schema v8 migration (handoff_batons.memo_text 列 drop)。
- `src/session-start.mjs`: 引継ぎ判定の 2 経路ロジック:
  1. baton path: `consumeBaton` 先発で baton ありなら merge + 注入
  2. auto path: baton 無し + `source='clear'` + env disable 無し で同 project の
     最新 Claude unmerged session を自動 predecessor に merge + 注入
- `inheritance-decision.log` に `triggered_path` / `auto_handoff_disabled`
  フィールドを追加。`baton_has_memo` フィールドは削除。
- `src/resume-context.mjs`: L3 references 一覧を注入テキストに追加
  (Codex `renderCodexRolloutMemoryPreview` 形式の `- ${kind}:
  \`throughline detail <time>\``)。Reading Contract / Continuation Instruction
  も Codex 風 framing に揃えた。

### Notes

- `src/handoff-record.mjs` の memo / thinking projection は **維持**: Codex 側
  (`codex-handoff.mjs`, `codex-resume.mjs`, `codex-handoff-smoke.mjs` など) が
  `memory.inflightMemo` / `memory.latestThinking` を参照しているため。Claude
  側は resume-context.mjs で「使わない」だけ。
- `src/cli/trim.mjs` は **維持**: Codex 経路 (`--host codex`) と doctor
  (`--trim --host claude`) で使う `describeTrimHost('claude')` の dry-run 表示
  が依存しているため。`/tl-trim` slash command が無くなっても CLI は残る。
- 既存 `~/.throughline/logs/inflight-memo.log` ファイルは新版で書き込まれない。
  ユーザー側で手動削除可能。

## [0.3.25] — 2026-05-08

### Added
- Claude-primary / Codex-sidecar groundwork:
  `HandoffRecord` projection, `throughline handoff-preview`,
  `throughline_handoff` example context, and `codex-sidecar-diagnostics` /
  `codex-sidecar-dry-run` command surfaces.
- Optional `codex-sidecar` L2→L1 summarization path. When the sidecar is
  configured for the `summarize-l1` preset, Throughline uses it for the only
  subagent-like external model call; disabled/unavailable/run-failed sidecar
  states keep the existing Claude Haiku route.
- `/tl-trim` dry-run surface:
  `throughline trim --dry-run`, `--host`, `--keep-recent`, `--all`,
  `--memo-stdin`, `--codex-thread-id`, and `throughline doctor --trim`.
- Codex app-server protocol helpers for the verified trim flow: newline JSON
  framing, initialize / resume / rollback / inject / turn-start request
  builders, and parser coverage.
- Codex rollout-backed trim source for explicit `--codex-thread-id` plans.
  This lets Codex dry-run / preflight / guarded execute use the active rollout
  even when the Throughline DB has no Codex `bodies` rows.
- `throughline codex-capture`, which captures explicit Codex rollout active
  turns into a namespaced `codex:<thread_id>` Throughline DB session. Re-capture
  rebuilds that session so rolled-back tail turns do not survive as current L2.
- Codex capture now stores rollout function-call L3 details as well as L2
  bodies: `function_call` becomes `details.kind = tool_input`, and
  `function_call_output` becomes `details.kind = tool_output`.
- Host-mode L2→L1 backend selection. Claude-primary keeps the existing
  `codex-sidecar` / Claude Haiku compatibility route, while Codex-primary uses
  the Codex CLI backend and reports failure explicitly instead of falling back.
- `throughline codex-summarize`, which writes L1 skeletons for captured
  `codex:<thread_id>` sessions through the Codex CLI backend once the captured
  body count exceeds the L2 window.
- `throughline codex-resume`, which renders captured `codex:<thread_id>` memory
  as Codex active-work context. `--format handoff` emits a concise fresh-thread
  handoff prompt for safe continuation without mutating the current Codex
  thread; the handoff view caps recent L2 entries, long body text, and detail
  references while preserving the full context in the normal text renderer.
  `--format item-json` emits a Codex developer message item so hosts can
  inject the memory as current-task context instead of a passive archive.
  `--memo-stdin` prepends a Codex-primary in-flight memo without touching Claude
  `/tl` batons.
- `throughline codex-handoff-smoke`, a read-only validator for the
  `codex-resume --format handoff` prompt. It checks fresh-thread header /
  current-task contract / source session / start instruction / mutation
  boundary / prompt size / detail-command deduplication before a user starts a
  new Codex thread with that prompt.
- `throughline codex-handoff-model-smoke`, an explicit opt-in model smoke for
  the same handoff prompt. It first requires the structural handoff smoke to be
  ready, then runs `codex exec --ephemeral --ignore-user-config --ignore-rules
  --sandbox read-only` with a marker prompt. `--dry-run` inspects the exact
  readiness / command boundary without starting Codex exec, and
  `--print-prompt` can include the combined prompt for audit. Live model smoke
  requires `THROUGHLINE_EXPERIMENTAL_CODEX_HANDOFF_MODEL_SMOKE=1` and does not
  mutate the current Codex thread.
- `throughline codex-handoff-start`, a guided fresh-thread start plan
  for Codex handoff. It reports the structural smoke command, model-smoke dry-run
  boundary, handoff render command, optional live model smoke command, and can
  include the handoff prompt with `--print-prompt`. When `--memo-stdin` is used,
  the replay commands include `--memo-stdin` and the output reminds callers to
  pipe the same memo. With `--execute`, it starts a new app-server thread,
  injects developer handoff memory with `thread/inject_items`, and opens it
  through `--open-host auto|vscode|cli|none`.
- `throughline doctor --codex`, a read-only Codex-primary diagnostic that shows
  current thread env identity, rollout candidates for the cwd, captured
  `codex:<thread_id>` DB sessions, context refresh blockage, new-thread
  handoff readiness, and the next capture/resume commands.
- Global `throughline install` now also registers the Codex Stop hook in
  `~/.codex/hooks.json` with absolute node + installed `bin/throughline.mjs`,
  `async: false`, and `timeoutSec: 300`, and enables
  `[features].codex_hooks = true` in `~/.codex/config.toml`. Existing non-
  Throughline Codex hooks, including Caveat / Spotter hooks, are preserved.
- Global install now also installs a `$throughline` Codex skill under
  `~/.codex/skills/throughline`, giving Codex a natural-language entrypoint for
  Throughline status, resume, summarize, dry-run, preflight, and explicit
  execute workflows. The rollback / inject execute path is enabled again after
  controlled rollback model-visible smokes failed to reproduce rollback marker
  resurrection.
- A bare `$throughline` Codex skill invocation now runs the safe inspection
  shape: `doctor --codex`, guarded dry-run, and preflight. Explicit
  `trim --execute --host codex --all` mutates the current Codex thread when the
  user asks for it and the guard checks pass.
- Codex Stop hook automatic refresh now attempts guarded rollback + Throughline
  DB memory injection at the 90% verified-usage threshold. Estimate-only usage
  still never triggers mutation.
- `throughline codex-visibility-smoke`, an experimental opt-in Codex app-server
  smoke that injects the Codex active-work developer message and starts a
  marker-check model turn. It requires
  `THROUGHLINE_EXPERIMENTAL_CODEX_MODEL_VISIBLE_SMOKE=1` and supports explicit
  model-turn timeouts with `--request-timeout-ms` / `--timeout-ms`; it also
  accepts the same `--memo-stdin` active-work memo surface as `codex-resume`.
  `--resume-after-inject` re-runs `thread/resume` after injection before
  starting the marker turn, so resume persistence can be checked explicitly.
- Codex-first roadmap docs that set the next implementation order: Codex
  primary support with a Codex CLI L2→L1 backend, then Codex rewind-compatible
  trim, then Claude rewind finalization.

### Changed
- Resume context now frames recent L2 as an active work thread with explicit
  reading/continuation instructions at both the top and bottom of injected
  memory. Older L2 entries may be superseded by later entries and are not
  blindly treated as still-current truth.
- Hook entry modules are import-safe and expose `run()` so subprocess tests can
  cover the Claude path without touching the user's real database.
- VSCode task tests suppress Claude-facing `<system-reminder>` notices by
  default and opt in only for notice assertions, keeping test output from
  looking like fresh user-facing instructions.
- `codex-sidecar` subprocess calls now shell-wrap on Windows so npm global
  `.cmd` shims resolve consistently, matching the existing Claude CLI handling.
- L2→L1 sidecar summarization accepts the stable `SidecarResult` JSON shape
  (`summary` without `status: "ok"`) as well as the older test fixture shape.
- `codex-sidecar-dry-run --turn-timeout-ms` now forwards the timeout into the
  normalized sidecar request instead of only changing the local subprocess
  timeout.
- `.codex-sidecar.yml` no longer denies every path containing `token`, so
  legitimate source files such as `src/token-monitor.mjs` remain reviewable.
- `.codex-sidecar.yml` allows release docs and Claude slash commands, so
  review/risk-check sidecars can inspect the same contract surfaces that are
  shipped in the npm tarball.
- `.codex-sidecar/logs/` is ignored as a runtime artifact from real sidecar
  smoke runs.
- Codex trim host status now distinguishes verified app-server rollback/inject
  primitives from guarded execution requirements. Codex Stop hook automatic
  refresh is enabled only at the 90% verified-usage threshold and still uses the
  same explicit thread identity, injectable DB memory, and rollout/app-server
  turn-count guards.
- Trim dry-run now carries an explicit Codex thread identity separately from
  the Claude/Throughline `session_id`, avoiding latest-rollout guessing.
- Codex trim can now use `THROUGHLINE_CODEX_THREAD_ID` or `CODEX_THREAD_ID` as
  a current-thread identity signal when `--codex-thread-id` is omitted; the CLI
  flag remains authoritative and Throughline still does not guess from the
  latest rollout.
- `throughline doctor --trim --host codex` now reports whether a current Codex
  thread id is available from env and adjusts its dry-run example accordingly.
- `throughline doctor --trim --host codex` now also reports the read-only host
  primitive audit status as diagnostic evidence rather than an execute blocker.
- `throughline trim --preflight --host codex --codex-thread-id <id>` now
  performs a guarded Codex app-server initialize/read/resume check and stops
  before sending rollback or inject. When the plan source is `codex-rollout`,
  preflight compares rollout active turns with app-server read/resume turns and
  refuses the plan if they differ.
- Codex rollout-backed trim source now excludes the current in-flight turn from
  rollback planning, including the latest post-rollback assistant continuation.
  This keeps preflight aligned with app-server `thread/read` / `thread/resume`,
  which only report completed host-visible turns during an ongoing Codex turn.
- `throughline trim --execute --host codex --codex-thread-id <id>` no longer
  requires `THROUGHLINE_EXPERIMENTAL_CODEX_TRIM_EXECUTE=1` and no longer treats
  host primitive audit or restore-safety diagnostics as mutation blockers.
  Execute still refuses before mutation when Codex thread identity, injectable
  Throughline DB memory, or rollout/app-server turn-count agreement is missing.
- Codex guarded execute now polls post-inject `thread/read` until the injected
  memory item is visible when the app-server reports an injected turn count, and
  reports `postInjectVisibilityCheck` so stale immediate app-server reads are
  explicit. If `thread/inject_items` returns no turn list, developer memory is
  treated as item-level injection and the expected post-inject turn count remains
  the rollback result turn count.
- Codex guarded execute status now separates live mutation from durable
  success: a visible app-server mutation reports `execute-sent-live-only` with
  `durableVerification.durableVerified: false` and exits non-zero; post-inject
  visibility timeout reports `execute-unverified`.
- Codex guarded execute can now report `execute-durable-verified` only when the
  rollout records a new `thread_rolled_back` event, records the injected
  `## Throughline: Active Work Context` memory, and restore-safety diagnostics
  remain `ok`.
- Added `throughline codex-restore-smoke`, a read-only diagnostic that starts
  fresh Codex app-server processes and compares `thread/read`,
  `thread/resume`, and paginated `thread/turns/list` turn counts against the
  rollout active turn count. Its proof scope is
  `app_server_process_restart_only`, and it always reports `restartSafe: false`
  because it is not VS Code restart / reconnect proof. If the required
  read-only app-server request fails, the CLI returns structured
  `app-server-restore-smoke-error` JSON instead of a stack trace.
- `codex-restore-smoke --inspect-risky-rollout` can now inspect a risky rollout
  read-only and search app-server responses for retained rollback text. If
  retained text appears in direct turn text or `replacement_history`, the smoke
  reports `app-server-restore-text-retained` instead of a success-like stable
  status, even when read/resume/list turn counts are stable. If retained text
  appears only in quoted/tool-output fields such as `aggregatedOutput`, it
  reports `app-server-restore-text-quoted`. Match reports include sample JSON
  paths, location kinds, risk classes, and blocking-candidate summaries.
- `codex-vscode-rollback-smoke` text output now includes retained rollback text
  count, resurrected user message count, and restore-safety risk type summary so
  incident audits do not require opening the full JSON payload.
- `codex-restore-source-audit` now inventories SQLite-backed VS Code storage
  candidates (`.vscdb`, `.sqlite`, `.sqlite3`, `.db`) read-only and reports
  table / searchable column / needle match summaries alongside raw byte matches.
- `codex-restore-source-audit` now classifies VS Code log evidence into thread
  id hits, retained rollback text hits, patch-apply failures, thread stream
  broadcasts, and `replacement_history` signals, including a first/last
  timestamp window for patch-apply failures when log timestamps are present.
- `codex-restore-source-audit` now reports explicit VS Code extension
  rollback non-resurrection projection candidates, such as
  `replacement_history` filter / tombstone paths, separately from deletion-based
  repair primitives.
- `codex-restore-smoke --inspect-risky-rollout` now separates blocking retained
  text candidates from quoted/tool-output matches. Direct turn text and
  `replacement_history` keep the `app-server-restore-text-retained` status;
  matches found only in fields such as `aggregatedOutput` report
  `app-server-restore-text-quoted` with `blocking-candidates=no`.
- Added `throughline codex-rollback-model-visible-smoke`, a controlled
  two-phase smoke for the unresolved rollback question. `--prepare` starts a
  unique marker user turn and rolls it back; `--verify` later starts a model
  turn that contains only the marker prefix, not the full marker. A returned
  full marker reports `reproduced`; an explicit not-visible answer reports
  `not-reproduced`. The command is gated by
  `THROUGHLINE_EXPERIMENTAL_CODEX_ROLLBACK_MODEL_VISIBLE_SMOKE=1`. Live runs can
  use `--marker-file` so the full marker is not printed into the same thread
  being tested; marker-file prepares also use a unique per-trial prefix. Verify
  output reports `rolledBackMarkerModelVisible` and `modelReportedNotVisible`
  separately from `restartSafe`.
- Real controlled current-thread smoke on 2026-05-08 returned
  `not-reproduced` both before and after a VS Code reload/reconnect command,
  with `promptIncludesMarker: false` and no observed full marker. This weakens
  the rollback-resurrection hypothesis for the controlled marker path enough to
  remove the overbroad automatic Codex trim blocker. Retained compacted history
  and same-thread host primitive audit remain diagnostics.
- Added `throughline codex-restore-source-audit`, a read-only local inventory of
  Codex rollout, `session_index.jsonl`, `state_*.sqlite`, and VS Code
  globalStorage / workspaceStorage candidates for an explicit Codex thread. It
  now also scans VS Code `settings.json`, VS Code logs, and installed
  OpenAI/Codex VS Code extension bundles for restore-path signals such as
  `thread/read`, `thread/resume`, `thread/turns/list`, reconnect
  `needs_resume`, persisted webview atoms, and follow-up queue signals.
  Its proof scope is `local_restore_source_inventory_only`, and it does not
  prove VS Code restart safety.
- Added `throughline codex-vscode-restore-smoke`, a manual two-phase VS Code
  reload/reconnect proof protocol. `--prepare` injects a hidden active-work
  marker memory behind `THROUGHLINE_EXPERIMENTAL_CODEX_VSCODE_RESTORE_SMOKE=1`;
  `--verify` scans the rollout for a marker-free smoke prompt followed by an
  assistant marker-only answer after prepare, and rejects marker leaks in the
  user prompt. It reports `restartSafe: true` only with an explicit
  `--after-vscode-restart` acknowledgement and marker proof.
- Real VS Code reload/reconnect marker proof passed for thread
  `019dfddb-8288-7392-a461-bf3ebc5da409` with marker
  `TL_CODEX_VSCODE_RESTORE_46888202`. This proves hidden developer memory
  visibility across reconnect, not rollback-target non-resurrection.
- Tightened the VS Code restore smoke verifier after a false-positive hazard:
  assistant marker mentions in normal progress text no longer count. The proof
  now requires the marker-free smoke prompt and an assistant marker-only answer.
- Added `throughline codex-vscode-rollback-smoke`, a read-only rollback
  non-resurrection verifier. It requires a rollback event, rolled-back user
  text, a later user turn, restore-safety `ok`, and explicit
  `--after-vscode-restart` before reporting `restartSafe: true`.
- Added `throughline codex-host-primitive-audit`, a read-only audit that
  generates the installed Codex app-server JSON schema and checks whether a
  same-thread rollback non-resurrection primitive exists. The primitive may
  delete/rewrite retained rollback sources, or isolate/project them away from
  model-visible input. It now also reports a host-agnostic same-thread repair
  contract requiring a rollback non-resurrection guarantee, memory reinjection,
  post-repair host reads, and restart/reconnect non-resurrection proof; VS Code
  diagnostics can provide evidence but do not satisfy the contract. On
  `codex-cli 0.128.0-alpha.1`, the audit reports
  `diagnostic-only`: rollback/inject/new-thread primitives exist, but no
  current-thread rollback non-resurrection primitive is exposed, and
  `thread/resume(history)` is marked unstable/do-not-use with `thread_id`
  ignored.
- Real incident-shaped live rollback run for thread
  `019dfddb-8288-7392-a461-bf3ebc5da409` remains a `restoreSafety: risk`
  incident: rollout recorded `thread_rolled_back` and injected active-work
  memory, while `compacted.replacement_history` retained rollback-targeted user
  text and read-only diagnostics later observed matching text after rollback.
  Later app-server restore inspection separated direct user-message candidates
  from quoted/tool-output matches; the current thread's retained app-server
  matches are `aggregatedOutput` only, and the controlled model-visible smoke
  did not reproduce marker resurrection. Automatic Codex trim is enabled again
  with DB memory and turn-count guards.
- Codex trim dry-run plans and `doctor --trim --host codex` now expose the safe
  continuation path as `new-thread-handoff-only`: use the guided entrypoint
  `throughline codex-handoff-start --session codex:<thread-id>`, or validate the
  handoff with `throughline codex-handoff-smoke --session codex:<thread-id>`, optionally
  inspect the model-smoke boundary with
  `throughline codex-handoff-model-smoke --session codex:<thread-id> --dry-run --json`,
  render a fresh-thread handoff with
  `throughline codex-resume --session codex:<thread-id> --format handoff`, and
  start a new Codex thread, without mutating the current risky thread.
- Human-readable trim dry-run reports now truncate the inline curated memory
  preview for scanability while leaving full `memoryPreview.text` intact in JSON
  and in the Codex `codex-resume` safe-continuation command.
- `parseCodexRolloutFile` now exposes `userMessagesAfterRollback`,
  `latestRollbackAt`, and `restoreSafety.rolledBackTexts` so rollback smoke
  results carry enough audit evidence instead of only pass/fail status.
- Guarded execute now still checks rollout durability evidence when post-inject
  live read visibility times out, so reports can include observed rollback
  markers, observed injected memory, and post-execute restore-safety risk.
- Codex trim preflight / execute now reports planned restore-safety diagnostics:
  if the planned rollback would remove user text that already appears in
  `compacted.replacement_history`, Throughline reports
  `planned_restore_safety_risk` as diagnostic evidence but does not refuse
  solely for that reason.
- `codex-restore-source-audit` no longer uses very short retained rollback texts
  as VS Code storage needles, avoiding false positives from generic prompts such
  as `go`.
- Codex guarded execute no longer uses the old
  `THROUGHLINE_EXPERIMENTAL_CODEX_TRIM=1` gate or the later
  `THROUGHLINE_EXPERIMENTAL_CODEX_TRIM_EXECUTE=1` blocker. It now requires only
  explicit `--execute`, Codex thread identity, injectable Throughline DB memory,
  and rollout/app-server turn-count checks before mutation.
- Codex app-server helpers now report spawn failures explicitly instead of
  waiting for a request timeout.
- Codex app-server stderr in diagnostics is now capped after warning
  compaction, so external plugin/OAuth warnings cannot make smoke JSON
  excessively large.
- `throughline codex-threads` lists read-only Codex rollout/thread candidates
  for the current project so users can pass an explicit `--codex-thread-id`
  without Throughline guessing the active thread.
- `throughline codex-threads` now sorts candidates by rollout file mtime, not
  stale `session_index.jsonl` timestamps, so actively written threads appear
  before old probe threads.
- Codex trim memory previews now apply `thread_rolled_back` rollout events
  before building the active work thread, so rolled-back tail turns are not
  reintroduced as current memory.
- Codex trim dry-run now reports a heuristic context reduction estimate when
  rollout text is available: rollback-candidate estimated tokens, injected
  memory estimated tokens, net estimated reduction, and reduction percentage.
  This is intentionally labeled as `chars / 4`, not an exact host tokenizer
  measurement.
- Codex rollout parsing now mirrors app-server turn counts for injected
  active-work developer messages and for the latest post-rollback assistant
  continuation turn. This keeps guarded trim preflight aligned after a real
  rollback/inject cycle.
- Codex guarded trim now uses rollout/app-server data for rollback planning and
  turn-count guards, but uses Throughline DB memory for injection when
  available: older turns as L1 summaries, the latest 20 turns as full L2 bodies,
  and L3 as references only; L3 bodies / tool payloads are not injected.
  Execute refuses before mutation when only a rollout preview is available.
- `throughline doctor --codex` now reports context-refresh readiness, including
  rollback source, inject memory source, the L1/L2/L3 memory contract, current
  memory counts, and heuristic reduction estimate when available.
- `throughline doctor --codex` now reports the host primitive audit status and
  prints `throughline codex-host-primitive-audit` as the next read-only command
  for diagnostic detail.
- `throughline doctor --codex` labels context refresh as `ready` when the
  executable guard inputs are present, even if restore-safety diagnostics are
  risky. Those diagnostics are reported separately.
- `throughline doctor --codex` now reports the VS Code monitor task status and
  prints the Reload Window note there too, because Codex Stop hook stdout is not
  guaranteed to appear in the chat.
- `throughline doctor --codex` and human-readable guarded trim reports now label
  L3 as references-only and explicitly say L3 bodies are not injected.
- Guarded Codex execute now performs the same rollout/app-server turn-count
  check before rollback; mismatch or unavailable app-server counts refuse
  execution before any rollback or inject request is sent.
- Codex app-server stderr in trim preflight / guarded execute now compacts
  repeated unknown-turn item warnings while preserving the first occurrence and
  unrelated diagnostics.
- Codex visibility smoke now waits for app-server notification events
  (`item/agentMessage/delta` or `turn/completed`) after `turn/start`, so it does
  not mistake an accepted model turn for completed model visibility.
- Codex visibility smoke can now verify the `inject -> resume -> turn/start`
  path. Real-host smoke confirmed marker
  `TL_CODEX_RESUME_AFTER_INJECT_REAL_20260506` after a post-inject resume.
- Codex CLI L1 summarization now uses the `codex exec` option set supported by
  local `codex-cli 0.128.0-alpha.1`; the removed `--ask-for-approval` flag is
  no longer passed. The subprocess also passes `--ignore-user-config` so
  user-level Codex plugins/hooks are not loaded during the summarization call.
- Codex CLI summarization errors now include compacted stderr in JSON output,
  preserving actionable `ERROR:` lines without dumping enormous HTML challenge
  pages verbatim.
- `throughline monitor` is now host-aware for Claude and Codex state files.
  Codex Stop hook writes `codex:<thread_id>` monitor state with `rolloutPath`,
  snapshots verified rollout `token_count` usage when present, and marks
  rollout-text estimates with `estimated: true` / `est` when no token-count
  event is available. State filenames are URL-encoded so `codex:` session ids
  remain portable. The compact row now displays used tokens over the model
  context window, instead of percent plus remaining tokens.

### Documentation
- Added integrated implementation/TODO plan and cross-links for the Codex dual
  support and rollback trim design docs.
- README now documents Claude-primary behavior, optional Codex sidecar usage,
  and the current dry-run-only state of context trim.
- npm packaging now includes `docs/` and `CHANGELOG.md`, so README-linked
  design docs and the `throughline_handoff` example context are present in the
  tarball.
- npm packaging also includes `.codex-sidecar.yml`, keeping the documented
  sidecar diagnostics / dry-run examples reproducible from the package source.
- `npm test` now includes nested `src/cli/*.test.mjs` coverage in addition to
  the top-level `src/*.test.mjs` tests.
- Recorded the 2026-05-06 Codex app-server rollback/inject spike: `thread/read`
  can read persisted threads, `thread/rollback` requires a loaded thread via
  `thread/resume`, and injected developer items are visible to the next turn.
- Recorded the 2026-05-06 real Codex-primary active-work smoke: injected
  `codex-resume` developer context produced marker `TL_CODEX_VISIBLE_REAL_20260506_C`
  in `item/agentMessage/delta`, confirming the rendered memory is model-visible
  as current work in a real Codex host.
- Documented the current Codex-primary setup flow. Global install manages only
  the Throughline Codex Stop hook / skill and preserves existing
  non-Throughline hooks; users can verify natural capture with `doctor --codex`,
  then summarize, render, or inject active-work memory through the `$throughline`
  skill or the explicit Codex CLI surfaces.
- Recorded the 2026-05-06 final Codex Stop hook smoke: after the absolute-path
  hook shape was installed, a newly started VSCode-origin Codex thread
  `019dfd62-9a9d-7211-bf91-89d8e3fc908e` naturally advanced the latest DB
  session to `codex:019dfd62-9a9d-7211-bf91-89d8e3fc908e` as reported by
  `doctor --codex`.
- Added and completed the Codex monitor implementation plan, documenting the
  host-aware state contract, Codex `rolloutPath`, verified `token_count`
  usage, and explicit estimate labeling.

## [0.3.24] — 2026-05-02

### Added
- `shouldRecommendGitignore` in [src/vscode-task.mjs](src/vscode-task.mjs):
  when `ensureMonitorTaskFile` transitions to `created` / `merged` / `repaired`
  inside a git repository whose `.gitignore` lacks a `.vscode/tasks.json`-
  matching entry, emit a one-time `<system-reminder>` to stdout recommending
  `.gitignore` registration. Suppressed by a `.throughline-gitignore-noted`
  marker so it does not repeat. Negation patterns (`!.vscode/tasks.json`) are
  treated as explicit-track intent and still trigger the recommendation.

### Why
- `.vscode/tasks.json` always contains environment-specific absolute paths
  (`process.execPath`, the install location of `throughline.mjs`). Even though
  v0.3.23 auto-repairs stale paths after the fact, the right answer is to not
  commit it in the first place. The published npm tarball was already clean of
  absolute paths (`files` field excludes `.vscode/`, no hardcoded paths in
  source); this release strengthens runtime advice for the consumer side.

## [0.3.23] — 2026-05-02

### Added
- Cross-environment `.vscode/tasks.json` repair: when an existing Monitor task
  references absolute paths that don't exist on the current machine
  (e.g. a Windows path on a WSL2 clone), `ensureMonitorTaskFile` now rewrites
  just `command` / `args` while preserving any `label` / `presentation` /
  `isBackground` customization. New helpers `findMonitorTaskIndex` and
  `isMonitorTaskBroken` (absolute-path + non-existent test) drive the new
  `action: 'repaired'` branch, and `buildSetupNotice('repaired')` returns a
  one-time `Reload Window` notice.
- `resolveThroughlineOnPath` in [src/cli/install.mjs](src/cli/install.mjs):
  after `throughline install` completes, walk PATH to confirm `throughline`
  resolves. If not, print a stderr fix recipe (`npm prefix -g` → add to
  `~/.bashrc` → re-run `doctor`). Catches the silent-fail case where
  `~/.npm-global/bin` is exported in `~/.profile` but not `~/.bashrc` (VSCode's
  interactive non-login bash skips `.profile`).

### Documentation
- README Troubleshooting now covers PATH resolution, WSL2 ↔ Windows PATH
  crossover, cross-OS DB separation (each `os.homedir()` is its own DB), and
  the auto-repair behavior for stale tasks.

## [0.3.22] — 2026-04-19

### Changed
- Register the `Stop` hook with `"async": true` so `throughline process-turn`
  runs in the background and no longer blocks the user-visible turn completion
  on the Haiku L1-summarization subprocess (which can take seconds to tens of
  seconds). L1 summaries are only needed for the *next* `SessionStart`
  injection, so there is no reason to make the current turn wait for them.
  `SessionStart` and `UserPromptSubmit` remain synchronous because their work
  must complete before the next turn begins.

### Migration
- Existing installs need `throughline uninstall && throughline install` to
  pick up the new `async` flag. The install dedup compares the `command`
  string, so a re-install without uninstalling first will skip the already-
  registered (but still synchronous) entry.

## [0.3.21] — 2026-04-19

### Changed
- `throughline install` now writes the `/tl` and `/sc-detail` slash command
  definitions to `~/.claude/commands/*.md` (user scope) instead of relying on
  per-project `.claude/commands/`. New projects no longer need to copy the
  slash command files manually.

## [0.3.20] — 2026-04-19

### Changed
- Monitor's context-exhaustion warning now recommends `/tl` instead of
  `/clear`, so the suggested action does not break the handoff baton path.

## [0.3.19] — 2026-04-18

### Added
- `ensureMonitorTaskFile` now emits a one-time `<system-reminder>` to stdout
  the moment it creates or merges a `.vscode/tasks.json`, so Claude can tell
  the user a **Developer: Reload Window** is needed to activate the
  `folderOpen` task. The notice is silent on the `already_present` path so it
  fires at most once per project.

## [0.3.18] — 2026-04-18

### Added
- Fan-out of `ensureMonitorTaskFile` to **all three hooks** (`SessionStart`,
  `UserPromptSubmit`, `Stop`) so `.vscode/tasks.json` is provisioned by
  whichever hook fires first in a given environment. Previously only `Stop`
  invoked it, which meant projects where `Stop` did not fire on the first
  session never got the monitor task. The provisioning logic is idempotent,
  so the redundant calls are no-ops once the task exists.

## [0.3.0] — 2026-04-18

This is the first release line that supports the schema v7 / `/tl` baton
handoff with in-flight memo and L3 thinking storage. `0.3.1` through `0.3.17`
were rapid-fire monitor render-bug iterations published to npm but not tagged
on GitHub; they are summarized in the rollup section below for completeness.

### Added
- **In-flight memo via `/tl`** (schema v7). When `/tl` fires, the
  `UserPromptSubmit` hook writes a baton row, then Claude itself pipes a
  Markdown memo (next planned move, current hypothesis, open questions,
  in-progress TODOs) into `throughline save-inflight`, which attaches it to
  `handoff_batons.memo_text`. The next `SessionStart` injects the memo at the
  top of the resume context so the new Claude picks up mid-thought.
- **Extended thinking captured at L3.** Assistant `thinking` blocks are
  persisted in `details` with `kind='thinking'`. The most recent turn's
  thinking is injected inline above the L2 history on `SessionStart`; older
  thinking remains retrievable via `throughline detail <time>`.
- **Resume reframing.** The injected context is presented as "resuming an
  interrupted task" rather than "reading past logs", so the new session
  behaves like a continuation rather than a recap.

## [0.2.0] — 2026-04-18

### Added
- **Explicit `/tl` baton handoff** (schema v6). Replaces the auto-inheritance
  heuristics. The previous session writes a baton, the next session consumes
  it within a 1-hour TTL, and merge happens via deterministic
  `UPDATE session_id = ?` inside a `BEGIN IMMEDIATE` transaction. Sessions
  without a baton start clean — no false-positive carryover.

## [0.1.0] — 2026-04-17

### Added
- Initial public release on npm. Schema v5 (L1/L2/L3 with `kind` and
  `source_id` columns on `details`).
- CLI: `install`, `uninstall`, `doctor`, `status`, `monitor`, `detail`.
- Hook entry points: `session-start`, `process-turn`, `prompt-submit`.
- Multi-session token monitor reading real `message.usage` from the
  Claude Code transcript JSONL (no `length / 4` heuristics) with 1M-context
  detection.
- Zero runtime dependencies; uses Node 22.5+ built-in `node:sqlite`.

---

## Unreleased pre-0.3.18 iterations (npm-only, not tagged on GitHub)

These versions shipped to npm in rapid succession on 2026-04-18 while
debugging a single class of monitor render bugs (rows stacking instead of
redrawing in place inside Windows ConPTY + VS Code task terminals). They are
rolled up here because individually they are not interesting consumption
units — the user-visible result is "the monitor finally renders correctly
across PTY, ConPTY, VS Code task terminal, and panel resize".

| Version | Theme |
| ------- | ----- |
| `0.3.1`–`0.3.2`     | Monitor crash resilience, accurate 1M-context detection, color-blind-safe markers. |
| `0.3.3`             | `.vscode/tasks.json` auto-provisioning (two-stage merge, JSONC detection). |
| `0.3.4`–`0.3.5`     | Stop-hook `state.usage` snapshot, `doctor --session` diagnostic, `(Nm ago)` per-row stamp, columns polling. |
| `0.3.6`–`0.3.12`    | Successive guesses at the "rows stacking" render bug (columns fallback, `isTTY` branching, `clearScreen`, alt screen, `type:shell`). All later confirmed off-target by the `--diag` instrumentation added in `0.3.11`. |
| `0.3.13`            | Root-cause fix: removed the `>= 40` columns floor in `resolveColumns` that was misclassifying real 30-cell panels as "insane" and falling back to 200, which then wrapped output and undercounted CUU on redraw. |
| `0.3.14`–`0.3.15`   | Diagnostic surfacing (startup header, per-frame columns) confirming that `process.stdout.columns` does not track panel resize on Windows ConPTY + VS Code tasks. |
| `0.3.16`            | New module `src/terminal-size.mjs`: query the terminal directly via OSC 18t (`\x1b[18t`) and parse the `\x1b[8;rows;cols t` reply on stdin in raw mode. Resize now follows panel width even when Node's `columns` is frozen. |
| `0.3.17`            | Force a full `clearScreen` (`\x1b[2J\x1b[3J\x1b[H`) on every resize-triggered redraw so the previous, wrongly-sized frame can no longer stack beneath the new one. |

### Lessons preserved as memory

The seven-version stretch of `0.3.6`–`0.3.12` was guesswork without
measurement; once `--diag` (`0.3.11`) and `terminal-size.mjs` (`0.3.16`) were
added, the real cause was found in two more versions. This is recorded as a
working-discipline note: when a terminal- or platform-specific bug resists
two attempts, instrument first instead of patching again.

---

[Unreleased]: https://github.com/kitepon/Throughline/compare/v0.16.16...HEAD
[0.16.16]: https://github.com/kitepon/Throughline/compare/v0.16.15...v0.16.16
[0.16.15]: https://github.com/kitepon/Throughline/compare/v0.16.14...v0.16.15
[0.16.14]: https://github.com/kitepon/Throughline/compare/v0.16.13...v0.16.14
[0.16.13]: https://github.com/kitepon/Throughline/compare/v0.16.12...v0.16.13
[0.16.12]: https://github.com/kitepon/Throughline/compare/v0.16.11...v0.16.12
[0.16.11]: https://github.com/kitepon/Throughline/compare/v0.16.10...v0.16.11
[0.16.10]: https://github.com/kitepon/Throughline/compare/v0.16.9...v0.16.10
[0.16.9]: https://github.com/kitepon/Throughline/compare/v0.16.8...v0.16.9
[0.16.8]: https://github.com/kitepon/Throughline/compare/v0.16.7...v0.16.8
[0.16.7]: https://github.com/kitepon/Throughline/compare/v0.16.6...v0.16.7
[0.16.6]: https://github.com/kitepon/Throughline/compare/v0.16.5...v0.16.6
[0.16.5]: https://github.com/kitepon/Throughline/compare/v0.16.4...v0.16.5
[0.16.4]: https://github.com/kitepon/Throughline/compare/v0.16.3...v0.16.4
[0.16.3]: https://github.com/kitepon/Throughline/compare/v0.16.2...v0.16.3
[0.16.2]: https://github.com/kitepon/Throughline/compare/v0.16.1...v0.16.2
[0.16.1]: https://github.com/kitepon/Throughline/compare/v0.16.0...v0.16.1
[0.16.0]: https://github.com/kitepon/Throughline/compare/v0.15.5...v0.16.0
[0.15.5]: https://github.com/kitepon/Throughline/compare/v0.15.4...v0.15.5
[0.15.4]: https://github.com/kitepon/Throughline/compare/v0.15.3...v0.15.4
[0.15.3]: https://github.com/kitepon/Throughline/compare/v0.15.2...v0.15.3
[0.15.2]: https://github.com/kitepon/Throughline/compare/v0.15.1...v0.15.2
[0.15.1]: https://github.com/kitepon/Throughline/compare/v0.15.0...v0.15.1
[0.15.0]: https://github.com/kitepon/Throughline/compare/v0.14.3...v0.15.0
[0.14.3]: https://github.com/kitepon/Throughline/compare/v0.14.2...v0.14.3
[0.14.2]: https://github.com/kitepon/Throughline/compare/v0.14.1...v0.14.2
[0.14.1]: https://github.com/kitepon/Throughline/compare/v0.14.0...v0.14.1
[0.14.0]: https://github.com/kitepon/Throughline/compare/v0.13.0...v0.14.0
[0.13.0]: https://github.com/kitepon/Throughline/compare/v0.12.9...v0.13.0
[0.12.9]: https://github.com/kitepon/Throughline/compare/v0.12.8...v0.12.9
[0.12.8]: https://github.com/kitepon/Throughline/compare/v0.12.7...v0.12.8
[0.12.7]: https://github.com/kitepon/Throughline/compare/v0.12.6...v0.12.7
[0.12.6]: https://github.com/kitepon/Throughline/compare/v0.12.5...v0.12.6
[0.12.5]: https://github.com/kitepon/Throughline/compare/v0.12.4...v0.12.5
[0.12.4]: https://github.com/kitepon/Throughline/compare/v0.12.3...v0.12.4
[0.12.3]: https://github.com/kitepon/Throughline/compare/v0.12.2...v0.12.3
[0.12.2]: https://github.com/kitepon/Throughline/compare/v0.12.1...v0.12.2
[0.12.1]: https://github.com/kitepon/Throughline/compare/v0.12.0...v0.12.1
[0.12.0]: https://github.com/kitepon/Throughline/compare/v0.11.0...v0.12.0
[0.11.0]: https://github.com/kitepon/Throughline/compare/v0.10.23...v0.11.0

[0.10.23]: https://github.com/kitepon/Throughline/compare/v0.10.22...v0.10.23
[0.10.22]: https://github.com/kitepon/Throughline/compare/v0.10.21...v0.10.22
[0.10.21]: https://github.com/kitepon/Throughline/compare/v0.10.20...v0.10.21
[0.10.20]: https://github.com/kitepon/Throughline/compare/v0.10.19...v0.10.20
[0.10.19]: https://github.com/kitepon/Throughline/compare/v0.10.18...v0.10.19
[0.10.18]: https://github.com/kitepon/Throughline/compare/v0.10.17...v0.10.18
[0.10.17]: https://github.com/kitepon/Throughline/compare/v0.10.16...v0.10.17
[0.10.16]: https://github.com/kitepon/Throughline/compare/v0.10.15...v0.10.16
[0.10.15]: https://github.com/kitepon/Throughline/compare/v0.10.14...v0.10.15
[0.10.14]: https://github.com/kitepon/Throughline/compare/v0.10.13...v0.10.14
[0.10.13]: https://github.com/kitepon/Throughline/compare/v0.10.12...v0.10.13
[0.10.12]: https://github.com/kitepon/Throughline/compare/v0.10.11...v0.10.12
[0.10.11]: https://github.com/kitepon/Throughline/compare/v0.10.10...v0.10.11
[0.10.10]: https://github.com/kitepon/Throughline/compare/v0.10.9...v0.10.10
[0.10.9]: https://github.com/kitepon/Throughline/compare/v0.10.8...v0.10.9
[0.10.8]: https://github.com/kitepon/Throughline/compare/v0.10.7...v0.10.8
[0.10.7]: https://github.com/kitepon/Throughline/compare/v0.10.6...v0.10.7
[0.10.6]: https://github.com/kitepon/Throughline/compare/v0.10.5...v0.10.6
[0.10.5]: https://github.com/kitepon/Throughline/compare/v0.10.4...v0.10.5
[0.10.4]: https://github.com/kitepon/Throughline/compare/v0.10.3...v0.10.4
[0.10.3]: https://github.com/kitepon/Throughline/compare/v0.10.2...v0.10.3
[0.10.2]: https://github.com/kitepon/Throughline/compare/v0.10.1...v0.10.2
[0.10.1]: https://github.com/kitepon/Throughline/compare/v0.10.0...v0.10.1
[0.10.0]: https://github.com/kitepon/Throughline/compare/v0.9.1...v0.10.0
[0.9.1]: https://github.com/kitepon/Throughline/compare/v0.9.0...v0.9.1
[0.9.0]: https://github.com/kitepon/Throughline/compare/v0.8.9...v0.9.0
[0.8.9]: https://github.com/kitepon/Throughline/compare/v0.8.8...v0.8.9
[0.8.8]: https://github.com/kitepon/Throughline/compare/v0.8.7...v0.8.8
[0.8.7]: https://github.com/kitepon/Throughline/compare/v0.8.6...v0.8.7
[0.8.6]: https://github.com/kitepon/Throughline/compare/v0.8.5...v0.8.6
[0.8.5]: https://github.com/kitepon/Throughline/compare/v0.8.4...v0.8.5
[0.8.4]: https://github.com/kitepon/Throughline/compare/v0.8.3...v0.8.4
[0.8.3]: https://github.com/kitepon/Throughline/compare/v0.8.2...v0.8.3
[0.8.2]: https://github.com/kitepon/Throughline/compare/v0.8.1...v0.8.2
[0.8.1]: https://github.com/kitepon/Throughline/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/kitepon/Throughline/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/kitepon/Throughline/compare/v0.6.3...v0.7.0
[0.6.3]: https://github.com/kitepon/Throughline/compare/v0.6.2...v0.6.3
[0.6.2]: https://github.com/kitepon/Throughline/compare/v0.6.1...v0.6.2
[0.3.22]: https://github.com/kitepon/Throughline/releases/tag/v0.3.22
[0.3.21]: https://github.com/kitepon/Throughline/compare/v0.3.19...v0.3.21
[0.3.20]: https://github.com/kitepon/Throughline/compare/v0.3.19...v0.3.20
[0.3.19]: https://github.com/kitepon/Throughline/releases/tag/v0.3.19
[0.3.18]: https://github.com/kitepon/Throughline/releases/tag/v0.3.18
[0.3.0]: https://github.com/kitepon/Throughline/releases/tag/v0.3.0
[0.2.0]: https://github.com/kitepon/Throughline/releases/tag/v0.2.0
[0.1.0]: https://github.com/kitepon/Throughline/compare/v0.1.0
