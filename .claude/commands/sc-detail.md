---
description: Throughline の退避済みターン（L2 本文 + L3 ツール入出力）を時刻で復元する
argument-hint: <HH:MM:SS>、<HH:MM:SS>-<HH:MM:SS>、または <YYYY-MM-DD>T<HH:MM:SS>
---

以下の Bash コマンドを実行し、結果を全文そのまま表示してください（要約せず、一字一句）。

```bash
throughline detail "$ARGUMENTS"
```

## 使い方

- `/sc-detail 14:23:05` — 指定時刻のターンを復元
- `/sc-detail 14:23-14:30` — 時刻範囲のターンをまとめて復元
- `/sc-detail 2026-10-04T14:23:05` — 日付を指定してターンを復元

日付を省くと、今日から遡って、その時刻のターンがある最も新しい日を対象にします。

## 何が返るか

- **L2**: そのターンの会話本文（ユーザー発言 + Claude 返答）
- **L3**: そのターンで実行されたツールの入出力

これは Throughline のセッション記憶 `~/.throughline/throughline.db` から読み出されます。
