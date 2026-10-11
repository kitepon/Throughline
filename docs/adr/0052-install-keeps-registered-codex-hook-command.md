# ADR 0052: install は、今の node を指す登録済みの Codex hook の命令を書き換えない

- Status: Accepted
- Date: 2026-10-11

## Context

Codex は、hook を1つずつ信用の対象にする。信用は `config.toml` の `hooks.state."<hooks.json>:<event>:<group>:<hook>".trusted_hash`
に残り、hook の定義（命令の文字列を含む）から作った hash と比べる。hash が違う hook は「変わった hook」（`modified`）になり、
新しい会話は起動の所で「Hooks need review」の画面を出して、人が選ぶまで止まる。

Throughline の Codex hook の命令は `<node> <throughline.mjs> codex-hook <event>` で、`<node>` は
`resolveCodexHookNodePath` が決める。PATH の上に今の node と同じ実体があればその表記、無ければ `process.execPath`。
Homebrew の node を版ごとの場所（Cellar）で登録しないための決め方だが、同じ端末でも、入れる側の PATH で表記が変わる。

2026-10-11、Linux の実機で、`~/.local/bin` を PATH の先頭に付けて `self-update` を流した。それまで
`~/.local/lib/node-v24/bin/node` だった表記が、同じ実体を指す symlink の `~/.local/bin/node` に変わった。
Throughline の hook は4つとも `modified` になり、新しい Codex の会話が確認の画面で止まった。常駐の process が
立てる会話も、そこで止まった。

`install` は、Throughline の hook を毎回作り直して書いていた。`doctor` と `factory-diagnostics` は、登録済みの命令と
期待する命令を実体（realpath）で比べるので、表記が違っても「登録済み」と出す。`install` だけが、文字列で置き換えていた。

## Decision

1. `install` と `auto-handoff enable` は、登録済みの Throughline の Codex hook の命令が、期待する命令と同じ実体
   （node と `throughline.mjs` の realpath、event）を指している時、その文字列のまま書く。
2. 登録が無い時、旧い形の時、node か script の実体が違う時（realpath を解決できない時を含む）は、今までどおり
   期待する命令で書く。
3. 表記を「より安定した物」へ寄せるための書き換えはしない。

## Consequences

- 入れる側の PATH が変わっても、同じ node を使っている間は、Codex の信用が残る。
- node の実体が変わった時（別の版の場所へ入れ直した時など）は命令が変わり、Codex は確認の画面を出す。これは避けない。
  命令が指す実行ファイルが変わった事を、利用者が確かめる場面だから。
- 版ごとの場所（Homebrew の Cellar など）で登録された命令は、その場所が残っている間はそのまま残る。場所が消えた後の
  `install` で、期待する命令へ書き直す。その間 hook は失敗する。`doctor` と `factory-diagnostics` は、実体を
  解決できない登録を「登録済み」と見ないので、そこで分かる。
- `doctor --codex` の「trusted」は、`trusted_hash` が記録されているかだけを見ている。Codex が今の命令と比べた結果
  （`trusted`・`modified`・`untrusted`）は、Codex の App Server の `hooks/list` でしか分からない。この ADR では変えない。
- Grok と Cursor の hook の命令も同じ決め方で node の表記が入るが、この ADR では変えない。
