# Throughline Claude / Codex両host契約

ThroughlineはClaude CodeとCodexの会話を製品所有DBに記録し、hostごとの公開CLIから読み取る。
Claudeのslash commandとCodexのnative hookは、それぞれのhost契約のまま維持する。

## 完了ターンの投影

`throughline caveat-context --session <id> --project <root> --host <claude|codex> --transcript <path> --json`
は、指定sessionとprojectに束縛された直近の完了3ターンを返す。会話本文と取得可能なThinkingを
上限付きで含め、tool入力・出力は含めない。host transcriptとの最新ターン照合が終わらない時は
`projection_pending`、3ターン未満なら`incomplete`を返す。Codexの暗号化Reasoningは平文に
復元できないため`thinkingAvailable: false`と空欄を返す。

Caveatはこの公開JSONを使って苦戦判定する。ThroughlineのSQLiteを直接読んだり、Observerの
状態を経由したりしない。詳細な引数と戻り値はREADMEと
[src/caveat-context.mjs](../src/caveat-context.mjs)を参照する。

## Codex primary

Codexのcapture、resume、handoffは`throughline codex-capture`、`codex-resume`、
`codex-handoff-start`が所有する。L2→L1要約はCodex CLIを使い、失敗を明示する。
Claude primaryはCodex CLIを先に試し、失敗時はClaude Haikuへ進む。各backendの
結果はThroughlineが記録する。
