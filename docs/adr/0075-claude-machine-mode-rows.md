# ADR 0075: Claude Code の機械インターフェース（`claude -p` の stream-json）の記録の行を、TUI と同じに読む

- Status: Accepted
- Date: 2026-11-20

## Context

BellTeam は Claude の席を、TUI ではなく Claude Code の機械インターフェース（`claude -p --input-format stream-json --output-format stream-json`、
常駐、`--resume`）で動かす試験をする（BellTeam チャート `a471-throughline`、a471-spike の実測は Elegg）。この形でも Throughline の hook
（SessionStart、UserPromptSubmit、PreToolUse、Stop）は動く。確かめたのは、記録と短期記憶が TUI の席と同じになるか。

## 実測（Claude Code 2.1.328、Linux、隔離した THROUGHLINE_HOME と CLAUDE_CONFIG_DIR）

本物の `claude -p` を、Throughline の hook だけを入れた設定で動かした（ターン実行中の割り込み入力、裏作業の完了通知、通常の入力、各1回以上）。

| 項目 | TUI | `-p` | 影響 |
|---|---|---|---|
| ターン先頭の user 行 | `promptSource: typed`、`turnOrigin: human`、`origin: {kind: human}` | `promptSource: sdk`、`turnOrigin: sdk`、`origin` なし | `classifyTurnStart` が unknown を返した（TUI は prompt）。observer の `turn_start` が unknown になる |
| ターンの途中で届いた入力 | `queued_command` に `origin: {kind: human}` | `queued_command` に `origin` なし（`commandMode: prompt`、`delivery_id`、`hostsOwnTurn`） | `claudeMidTurnInputText` が null を返し、入力が依頼へ足されず、記憶から消えた |
| 裏作業の完了通知 | `origin: {kind: task-notification}` | 同じ（`turnOrigin: task_notification`） | 差なし（self） |
| Stop の hook 入力 | `scratchpad_dir` あり | `scratchpad_dir` なし。SessionStart に `model` もなし | Claude の hook は両方を読まない。差なし |
| 本文・L3・turn 番号・receipt | – | 同じ形で保存 | 差なし |
| 余分な行（`stop_hook_summary`、`cost-state`、`ai-title` などの欠落） | – | 読まない行の種類 | 差なし |

`claude-forward-wait`（ADR 0063）は `CLAUDE_CODE_ENTRYPOINT` が `sdk-` で始まると何もしない。席の会話は引き継がれない（ADR 0057）ので、
機械インターフェースの席でも待つ相手が無い。この判定は変えない。

## Decision

読み方を、機械インターフェースだけが書く印の時だけ足す（1. は `turnOrigin: sdk`、2. は `entrypoint` が `sdk-` で始まる行）。TUI の行は、今までと同じ判定のまま。

1. `classifyTurnStart`: `origin.kind` を持たず、`turnOrigin` が `sdk` の user 行は prompt。標準入力から来た入力で、人（または席の呼び手）の依頼。
   `origin.kind` を持つ行は、今までの表のまま。`turnOrigin` が `scheduled` などの行は、今までの判定のまま。
2. `claudeMidTurnInputText`: `entrypoint` が `sdk-` で始まり、`origin` を持たず、`commandMode` が `prompt` の `queued_command` は、
   TUI の `origin.kind: human` と同じに依頼の後ろへ足す。

## 守るもの・自分で抜ける道

何を守るか: 記録の中身。機械インターフェースの席の依頼を unknown のままにすると、observer の利用者が人の依頼を見分けられない。割り込み入力は記憶から消える。
guard は増やさない。新しい判定は機械インターフェースだけが書く印の行にだけ効き、それ以外は今までの経路をそのまま通る。

## Limits

- 実測したのは Linux の Claude Code 2.1.328。Mac（2.1.329）・Windows の `-p` の行は、同じ行の形である前提で、読んでいない。
- `-p` で2通以上の入力が1ターンの終わりにまとまって user 行になる形（TUI の `promptSource: queued`）は、実測で出なかった。`isSameClaudePromptDelivery` は変えない。
- `-p` の裏作業の完了通知が、ターンの途中で `queued_command` として届く形は、今回の実測では user 行（ターンの先頭）だけだった。
