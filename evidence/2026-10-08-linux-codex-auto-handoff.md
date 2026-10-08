# LinuxのCodex Desktopでの自動継続の実測

- 実測日: 2026-10-08（Asia/Tokyo）
- 端末: Ubuntu（GNOME、Wayland）、Codex Desktop（deb `chatgpt` 26.1002.52244）、同梱CLI `codex-cli 0.162.0-alpha.2`、Node.js 24.20.0
- 状態: **0.16.6は、同梱CLI 0.162のCodex Desktopで毎回止まった。設定の照合を1か所直した版で、止まった2つの引き継ぎをやり直してA→B→Cを最後まで通し、公開した0.16.7で、hookから始まるA→B→Cを人の操作なしで通した。**
- 試験の組み方: [Windowsの実測](2026-10-08-windows-codex-auto-handoff.md)と同じ。最初のタスクはsshからDesktop同梱CLIの`app-server`で作り、画面のあるsessionで`chatgpt codex://threads/<id>`を1回実行してDesktopに読み込ませた。

## 前提

deb `chatgpt` 26.825.51511 に同梱のCLIは`0.151.0-alpha.7.2`で、引き継ぎの指示を届ける部品（0.154以上が必要）が断るため、`auto-handoff enable`が通らない。
`apt`で26.1002.52244へ更新し、Desktopを起動し直してから試した。

## 0.16.6で起きた事

| 時刻 | 起きた事 |
|---|---|
| 21:18:42 | 工程1の後に`PreCompact(auto)`が発火。旧ターンは`turn_aborted`、引き継ぎの記録とworkerが出来る |
| 21:18:44 | 後継を作り、記憶を注入した後、`handoff_prepared_settings_mismatch`で失敗。失敗の説明ページが開く |
| 21:20:38 | （1つ目をやり直した後）2つ目の引き継ぎも、同じ所で同じ理由で失敗 |

## 原因

製品は、旧タスクの設定と、後継の設定（作成直後と、Desktopで開いた後）が一致する事を確かめてから指示を送る。
Codex 0.162は、`thread/settings/update`の後の`thread_settings_applied`へ`service_tier: "default"`を書く。
旧タスクのrolloutには`service_tier`の項目が無く、製品はこれを`null`として読む。

| 比べた項目 | 旧タスク | 後継 |
|---|---|---|
| `serviceTier` | `null`（項目なし） | `"default"` |
| `collaborationMode.settings.developer_instructions` | `null` | 標準モードの本文（1,309字。今までも展開された値を受け入れている） |

食い違いは`serviceTier`だけだった。未指定と`default`は同じ枠なので、同じ設定として扱う。

## 直した版でのやり直し

入っている0.16.6の写しへ`src/hosts/codex-handoff-state.mjs`の直しだけを当て、止まった引き継ぎを
`auto-handoff resume --operation <id>`でやり直した（画面のあるsessionの環境で実行）。

| 引き継ぎ | 0.16.6 | やり直し | 結果 |
|---|---|---|---|
| A→B | 21:18:44 に失敗 | 21:20:21〜21:20:28 | `continued` |
| B→C | 21:20:40 に失敗 | 21:21:04〜21:21:12 | `continued`（`previous_handoff_id`はA→B） |

- `resume`は、出来ていた後継（記憶は注入済み）をそのまま使い、後継を作り直していない。
- 工程1・2・3のファイルは、最初の指示の値と一致した。Cは最初のタスクのL3を取得して記録した。
- A・Bは`turn_aborted`が1件ずつ。3つのrolloutに圧縮の記録は無い。
- 後継の名前は2つとも`proj｜Throughline 自動継続の統合試験（rabbit）（自動引き継ぎ）`。
- `PreCompact(auto)`のhookは、Linuxでは0.16.6のままで引き継ぎの記録とworkerを作れた（Windowsで落ちた`realpath`は、Linuxでは落ちない）。

## 公開版（0.16.7）での通し

[v0.16.7](https://github.com/kitepon/Throughline/releases/tag/v0.16.7)（commit `084e4dc`、registryの時刻 2026-10-08T12:31:55.519Z、shasum `9a7cbf1435062bed61b063c299f1cc81c69f715d`）を、
公開の`throughline self-update`で端末へ入れた（21:32:59）。hookの設定5つは更新の前後で同じ。
既定のhook（入っている0.16.7）だけで、最初の指示を1回送った後は何も操作していない。

| 引き継ぎ | 要求 | `continued` |
|---|---|---|
| A→B | 21:33:23 | 21:33:31 |
| B→C | 21:33:41（`previous_handoff_id`はA→B） | 21:33:49 |

- 工程1・2・3のファイルは、最初の指示の値と一致した（21:33:22、21:33:41、21:34:13）。Cは最初のタスクのL3を取得して記録し、`task_complete`で終わった。
- 3つのrolloutに圧縮の記録は無い。後継の名前は2つとも付いた。失敗の記録は増えていない。
- macOS（同梱CLI 0.162.0-alpha.2）とWindowsの端末にも、同じ日に0.16.7を入れた。

## 確認していない範囲

- 容量の既定の上限まで進んだ長い会話の引き継ぎ。
- Desktopの画面から人が始めたタスクを最初の旧タスクにした引き継ぎ。
