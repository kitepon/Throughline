# Throughline 公開・運用契約

この文書は現行release判断と製品単独運用の正本である。版ごとの実装履歴は
[CHANGELOG.md](../CHANGELOG.md)、完了済みの計画と受入記録は [archive/](archive/) に置く。
同じrelease履歴をこの文書へ複製しない。

## 現行状態

- 候補の版は `package.json`、公開版はnpm registryを正とする。tagとnpmの一致はpublish後に確認する。
- Claude Code、Codex、Grok、Cursorをfirst-class hostとして扱う。
- 現行DB schemaはv9。schemaの正本は [src/db.mjs](../src/db.mjs) の
  `CURRENT_VERSION`、二相handoffの判断は
  [ADR 0014](adr/0014-two-phase-handoff-ghost-baton.md)である。
- repositoryの正規URLは `https://github.com/kitepon/Throughline`。

## 製品単独運用

Throughline は次の入口を自分で所有し、dotagentsが無くても利用・保守できる。

| 判断 | 正規入口 |
|---|---|
| 導入・host配線 | `npm install -g throughline` → `throughline install` |
| project限定導入 | `throughline install --project` |
| 設定 | READMEの環境変数・host契約と、`throughline install` が管理する設定 |
| 状態 | `~/.throughline/`、`throughline status` |
| schema更新 | `throughline migrate --json`。既存DBだけを製品所有migrationで更新する |
| 診断 | `throughline doctor`、host別doctor、`factory-diagnostics --json` |
| runtime error収集 | `throughline runtime-errors enable\|disable --json`。製品所有configへ保存する |
| 復旧 | READMEのTroubleshootingと、診断が返す明示的な修復手順 |
| 更新 | `throughline self-update`。公式package更新、更新先global rootと公開PATHが同じ新CLI・versionを指すことの確認、host配線の再適用、既存DB migration、公開diagnosticsの`ready`確認までを一回で行う |
| 削除 | `throughline uninstall`。Throughline管理面だけを除去する |

v0.10.4以前からの初回更新だけは、その版に `self-update` が無いため
`npm install --global throughline@latest` の後に `throughline self-update` を実行する。
v0.10.5以降は `throughline self-update` だけを公開更新入口とする。
| release判断 | この文書のrelease gateと `scripts/verify-release-commit.mjs` |

dotagentsは工場への配線と統合結果を所有するが、ThroughlineのDB、schema、migration、
設定、診断、復旧、releaseを代行・制御しない。runtime error collectionはThroughline所有configで
既定OFFとし、工場側は公開`runtime-errors ... --json`契約だけを利用する。

Windows nativeの更新はPowerShell 7から公式`npm.cmd`を呼び、`npm.ps1`や
Windows PowerShell 5.1へ切り替えない。更新前CLIを再利用せず、更新先global rootから解決した
新CLI、公開PATHから起動したCLI、そのversion、`throughline.self_update.v1`成功結果がすべて
一致した場合だけ完了とする。複数npm prefixが混在して公開PATHが旧実体を指す場合は失敗する。

公開版の照合は、npmの旧文字列形式と[npm 12の単一結果配列](https://docs.npmjs.com/cli/v12/commands/npm-view/#output)を受け入れる。
複数版・空配列・不正な版情報から一つを推測して選ばず、後続の設定・移行処理の前に失敗を返す。

## 明示的失敗の契約

想定外の状態、外部入力違反、I/O失敗、依存不足を成功扱いにしない。

- `try { ... } catch { /* ignore */ }` で例外を消さない。
- failureを記録しながらexit 0へ落とさない。
- 暗黙に別backend・別session・別pathへ切り替えない。
- DB不在を診断・migrationの副作用で新規作成しない。
- 外部連携は公開CLI・versioned JSONを使い、SQLiteやWALを直接操作しない。

## release gate

release候補は次の全条件を満たしたときだけ公開する。

1. `package.json` と `CHANGELOG.md` の候補版が一致し、READMEとAGENTS.mdが版の正本を参照する。
   schema・host契約も実装と一致し、`npm run verify:docs` が全Markdownと梱包内リンクを検査する。
2. 変更に直結するfocused testがgreenで、その後に `npm test` を最終確認として1回通す。
3. `npm run verify:release-commit` が、clean working treeかつHEADが`origin`既定ブランチの
   祖先であることを確認する。既定ブランチへ着地していないcommitからpublishしない。
4. `npm pack --dry-run`でtarball内容、秘密混入、必要なREADME/docsの収録を確認する。
5. 公開は既定ブランチへ着地したrelease commitへ`v<version>` tagをpushし、`.github/workflows/publish.yml`がnpm Trusted Publishingで行う。手元から`npm publish`しない。公開後にregistryのversionとshasum、tag、GitHub Releaseを確認する。
6. registry由来の隔離installで `throughline --version`、`throughline install`、
   `throughline migrate --json`、`throughline doctor`を確認する。
7. 変更したhost面で実captureまたはfocused install/diagnostics smokeを行う。

publish済みでも、上の確認が終わるまではrelease完了としない。失敗時は同じ版を上書きせず、
原因を直して新しいversionとして公開する。

## host配線の現行契約

- Claude Code: user/project hooksとslash command。PATH解決型CLIを使う。
- Codex: UserPromptSubmit / PostToolUse / Stop hook、feature flags、`$throughline` skill。
  絶対Node + installed CLI pathを使う。
  登録と利用者の承認は別であり、未承認は `doctor --codex` で確認する。
  Windowsのnpm版Codex起動は `src/os/portable-spawn-sync.mjs` が所有し、PowerShell 7を使う。
- Grok: `~/.grok/hooks/throughline.json`と`grok-continue`。絶対pathを使う。
  Grok予約環境変数でhostを確定し、camelCase／snake_caseの属性名を同じ境界で正規化する。
- Cursor: `~/.cursor/hooks.json`へsessionStart / beforeSubmitPrompt / stopをupsertし、
  既存hookを保持する。注入は`additional_context`を使う。

詳細な挙動は [README.md](../README.md)、host不変判断は [ADR 0021](adr/0021-grok-host-capture.md) と
[ADR 0022](adr/0022-cursor-host-capture.md)を正とする。
