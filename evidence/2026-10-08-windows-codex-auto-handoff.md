# WindowsのCodex Desktopでの自動継続の実測

- 実測日: 2026-10-08（Asia/Tokyo）
- 端末: Windows、Codex Desktop（`OpenAI.Codex` 26.930.7945.0）、同梱CLI `codex-cli 0.160.1`、Node.js 24.20.0、PowerShell 7.6.6
- 状態: **0.16.5はWindowsで1回も引き継げなかった。入口を1か所直した版と、公開した0.16.6で、A→B→Cの2回の引き継ぎを人の操作なしで1回ずつ通した。**
- macOSの実測と試験の組み方: [Codex自動新規タスク継続の成立検証](2026-10-03-codex-auto-continuation.md)

## 0.16.5で起きた事

試験用フォルダだけで自動継続を有効にし（`throughline auto-handoff enable --project <試験用フォルダ>`）、
試験用フォルダの圧縮の上限を60,000 tokensへ下げて、公式の`PreCompact(auto)`を実際に発火させた。

| 時刻 | 起きた事 |
|---|---|
| 12:31:32 | 最初のタスクのターンが始まる |
| 12:31:51 | 工程1のコマンドが完了 |
| 12:31:55.811 | `codex-hook pre-compact`が`EISDIR: illegal operation on a directory, lstat 'C:'`で失敗（`requestCodexAutoHandoff`の`realpathSync`） |
| 12:31:55.851 | 同じターンに`turn_aborted(reason=interrupted)` |

hookは失敗した時に圧縮を止める返答（`continue:false`）を返すので、旧ターンは止まった。
引き継ぎの記録は作られず、workerも起動していない。後継のタスクは出来なかった。

## 原因

Codex Desktopが起動したhookの中では、Node.jsのJS実装の`fs.realpathSync`が、driveの根の`lstat`で落ちる。
同じ端末のsshの中では落ちない。
試験用の`PostToolUse` hookで、同じ`transcript_path`へ両方を呼んで比べた。

| 呼び方 | 結果（13回） |
|---|---|
| `fs.realpathSync(transcript_path)` | 13回とも `EISDIR: illegal operation on a directory, lstat 'C:'` |
| `fs.realpathSync.native(transcript_path)` | 13回とも成功 |

製品のほかの所（project pathの正規化、thread index、observer）は`fs.realpathSync.native`を使っていた。
JS実装を使っていたhookの道は、自動継続の入口の1か所だけだった。

## 直した版での通し

0.16.5の配布物の写しへ、`src/codex-auto-handoff.mjs`の1行の直しだけを当てた物を、試験用フォルダの`PreCompact(auto)`へ登録した。
最初の指示を1回送った後は、手動のresume、追加の入力、コードの修正をしていない。

| 引き継ぎ | 要求 | 結果 | 後継のターンの開始 |
|---|---|---|---|
| A→B | 12:39:06 | `continued` | 12:39:31までに入力と進捗を観測 |
| B→C | 12:39:51 | `continued`（`previous_handoff_id`はA→B） | 12:40:14までに入力と進捗を観測 |

- 工程1・2・3のファイルは、最初の指示の値と一致した（12:39:03、12:39:50、12:40:42）。
- Cは最初のタスクのL3を`auto-handoff detail`で取得し、工程1の入力と完了出力を読めた事を記録した。
- A・Bは`turn_aborted`が1件ずつ、Cは`task_complete`が1件。3つのrolloutに圧縮の記録は無い。
- 後継の名前は2つとも`proj｜Throughline 自動継続の統合試験（fox）（自動引き継ぎ）`。
- hookが起動したworkerは、hookが終わった後も動き続け、後継を作り、`codex://threads/<id>`で開き、指示を届けた。
- 設定（model・推論の強さ・承認・sandbox）は、後継をDesktopで開いた後も準備した値と一致した。

この間、既定のhook（入っている0.16.5）も同じ`PreCompact`で動き、同じ理由で2回失敗した。
試験用フォルダの設定でそのhookを無効にする指定は効かなかった。失敗した側は圧縮を止める返答を返すだけなので、通しの結果には影響していない。

## 公開版（0.16.6）での通し

[v0.16.6](https://github.com/kitepon/Throughline/releases/tag/v0.16.6)（commit `6e03e49`、registryの時刻 2026-10-08T03:53:12.342Z、shasum `98343ce4f6951d68ac654b5953b58d7726e358b4`）を、
公開の`throughline self-update`で端末へ入れた（12:54:46）。`config.toml`・`hooks.json`は更新の前後で同じ。
試験用フォルダの`PreCompact`は外し、既定のhook（入っている0.16.6）だけで同じ通しを流した。

| 引き継ぎ | 要求 | 結果 |
|---|---|---|
| A→B | 12:55:47 | `continued` |
| B→C | 12:56:24 | `continued`（`previous_handoff_id`はA→B） |

- 工程1・2・3のファイルは、最初の指示の値と一致した（12:55:45、12:56:23、12:57:12）。Cは最初のタスクのL3を取得して記録し、`task_complete`で終わった。
- 3つのrolloutに圧縮の記録は無い。後継の名前は2つとも付いた。
- `hook-failures.log`は、この通しの間に1行も増えていない（0.16.5の3行のまま）。
- `throughline doctor --codex`は`Codex hook trust: trusted`（0.16.5は`0/3 trusted`）。
- macOS（Node.js 26.10.0）の本物のrollout 2,832件で、`fs.realpathSync`と`fs.realpathSync.native`は同じ値を返した。macOSの動きは変わらない。

## 試験の組み方（macOSとの違い）

- 最初のタスクは、sshの中から、Desktop同梱CLIの`app-server`へ`thread/start`を送って作った。
  環境変数`CODEX_INTERNAL_ORIGINATOR_OVERRIDE=Codex Desktop`を付けた。
  Desktopの中で動く製品のworkerは、この値を親から受け継いで後継を作る。付けずに作ったタスクは、
  `originator`が接続の名前になり、製品は対象外（`handoff_host_unsupported`）として扱う。
- sshはsession 0で動くので、最初のタスクをDesktopで開く所だけ、1回きりのタスク スケジューラ（対話session）で
  `codex://threads/<id>`を開いた。後継を開く所は製品が行った。
- 容量を進める道具（`PostToolUse`で試験用の文脈を足す）と、工程の順序と値を検査するscriptは、macOSの統合試験と同じ形。

## 確認していない範囲

- Desktopの画面から人が始めたタスクを最初の旧タスクにした引き継ぎ。
- 容量の既定の上限まで進んだ長い会話の引き継ぎ。
- 失敗した時の説明ページの表示と、`resume`。
- 複数のタスクが同時に上限へ達した時。
