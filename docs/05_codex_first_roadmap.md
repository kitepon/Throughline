# Throughline: Codex First Roadmap

この文書は TODO を兼ねた実装計画です。

## この文書の位置づけ

この文書は、2026-05-06 時点の次フェーズ実装順を定義する。

既存文書との関係:

| 文書 | 扱い |
|---|---|
| [archive/07_codex_trim_implementation_plan.md](archive/07_codex_trim_implementation_plan.md) | これまでの統合計画と実装履歴。完了済み成果と根拠は維持するが、今後の実装順はこの文書を優先する |
| [06_codex_trim_rollback_fix_plan.md](06_codex_trim_rollback_fix_plan.md) | 2026-05-06 incident 後の修正計画。controlled smoke で rollback marker の model-visible 復活は未再現となり、overbroad blocker は解除済み |
| [08_codex_dual_support.md](08_codex_dual_support.md) | Claude / Codex 両対応の architecture brief。adapter 境界の基本方針として維持する |
| [09_rollback_context_trim_insight.md](09_rollback_context_trim_insight.md) | rollback / rewind を context delete primitive と見る設計メモ |
| [04_public_release_plan.md](04_public_release_plan.md) | 公開配布の状態表。実装済み behavior だけを公開説明に出す |
| [AGENTS.md](https://github.com/kitepon/Throughline/blob/main/AGENTS.md) | 作業者向け入口。Claude 正本を守りつつ、この文書を次フェーズ計画として参照する |

この文書は、以後の実装順について [archive/07_codex_trim_implementation_plan.md](archive/07_codex_trim_implementation_plan.md) を上書きする。
ただし、Claude primary を壊さない、Claude hooks / `/tl` / baton / DB / resume context を Codex 用に置き換えない、という既存の絶対条件は維持する。

## 現状認識

Windowsの通常の新規タスク引き継ぎは実機確認済み。
起動条件とフック承認は [README](../README.md#codex-windows)、
当時の検証と未完了事項は [実測記録](https://github.com/kitepon/Throughline/blob/main/evidence/2026-09-06-windows-codex-handoff.md) を参照する。
この確認は同一タスクのrollbackや自動記録の承認を保証しない。

- Throughline 本体は、ほとんどが hook から起動されるローカル Node.js コードベースで動く。
- 現行 Claude path は、Claude hooks、slash command、handoff baton、DB、resume context、L1 / L2 / L3 persistence で成立している。
- 外部モデル的に呼ぶ主要箇所は L2 -> L1 要約。
- Claude-primary の現行 L2 -> L1 要約は `codex-sidecar` が configured の場合に sidecar を優先し、使えない場合は Claude Haiku 経路に戻る。Codex-primary は Codex CLI backend 失敗を明示 error にし、Claude Haiku / raw L2 へ fallback しない。
- Codex guarded trim は、Codex app-server の `thread/read` / `thread/resume` / `thread/rollback` / `thread/inject_items` を使う。明示 thread identity と injectable memory がない場合は mutation 前に拒否する。rollout/app-server turn count mismatch は診断に残し、`thread/read` / `thread/resume` が同じ count を返す場合は app-server 側の差分で rollback `numTurns` を補正する。
- Claude `/rewind` 自動化はまだ有効化しない。
- 2026-05-10 update: Codex automatic current-thread refresh mutation は無効化する。live rollback / inject で token_count が一時的に落ちても同一 thread で戻る実測があるため、`UserPromptSubmit` / `PostToolUse` / `Stop` hooks は capture / monitor state write のみ行い、`codex_auto_refresh_disabled` で quiet にする。bare `$throughline` は `codex-handoff-start --execute --open-host <current-codex-surface>` による app-server 新スレッド handoff とし、明示 `trim --execute --host codex` だけを診断用 current-thread rollback / inject path として残す。current surfaceはCodex UI contextから決め、shell／永続PTYの継承環境へ委ねない。

## 新セッション引き継ぎ

2026-05-08 時点では、Codex primary の capture / summarize / resume は実装・実測済み。Codex trim execute / auto-refresh は、controlled rollback model-visible smoke の clean result を受けて blocker を解除した。[06_codex_trim_rollback_fix_plan.md](06_codex_trim_rollback_fix_plan.md) の Phase 0-3 は実装済み。Phase 4 では Codex app-server の protocol / local store 調査、read-only app-server process restart smoke、local restore source audit、manual VS Code restart smoke protocol、実 VS Code reload / reconnect 後の hidden developer memory marker proof、rollback 非復活 verifier、controlled rollback model-visible smoke surface まで進んだ。incident-shaped live rollback run では `compacted.replacement_history` retention を診断したが、後続の risky restore inspection では app-server response 上の retained text は `aggregatedOutput` など quoted/tool-output field に限定され、direct user message / `replacement_history` の復活とは分離された。2026-05-10 の live token_count 実験では同一 thread refresh が持続削減にならない可能性が濃くなったため、auto-refresh は disabled、通常 `$throughline` は新スレッド handoff とする。`throughline codex-host-primitive-audit` は diagnostic-only として残す。

Codex 側で実装済み / 診断可能なもの:

- `codex-capture`: Codex rollout から active turns を DB に保存できる。
- `codex-summarize`: Codex CLI backend で L2 -> L1 を書ける。Claude Haiku / raw L2 へ fallback しない。
- `codex-resume`: L1 summary と active L2 context を Codex active-work context / fresh-thread handoff / developer message item として描画できる。
- `trim --dry-run --host codex` / `doctor --trim --host codex`: rollback / inject plan、memory contract、context reduction estimate、diagnostics を表示する。fresh-thread handoff は代替継続 surface として残すが、current thread trim の代替ではない。
- `trim --preflight --host codex`: rollout / app-server turn count を診断し、必要なら app-server count 由来の rollback 数補正 preview を表示する。restore-safety diagnostics と planned rollback risk は報告するが、拒否条件ではない。
- `trim --execute --host codex`: explicit diagnostic current-thread path として、live app-server へ guarded rollback + Throughline DB memory inject を送る。env gate や host primitive audit gate は不要。DB memory が無い場合は mutation 前に拒否する。rollout/app-server turn count がずれる場合は、`thread/read` / `thread/resume` が一致していれば app-server count を正として rollback `numTurns` を補正する。bare `$throughline` と hooks からは呼ばない。
- `codex-visibility-smoke`: injected active-work memory が次 model turn で model-visible になることを確認済み。
- `codex-rollback-model-visible-smoke`: controlled two-phase smoke。`--prepare` は unique marker を含む user turn を開始して 1 turn rollback し、`--verify` は full marker を含まない prefix-only prompt で rollback 済み marker が model-visible かを測る。これは実 current thread を mutate するため明示 env 必須。live run では `--marker-file` を使い、full marker を同一 thread の chat/tool output に出さない。
- `codex-restore-smoke`: fresh app-server process を複数回起動し、`thread/read` / `thread/resume` / paginated `thread/turns/list` turn count が rollout active turn count と一致し続けるかを read-only で確認できる。ただし proof scope は `app_server_process_restart_only` で、VS Code restart-safe 証明ではない。
- `codex-restore-source-audit`: rollout / `session_index.jsonl` / `state_*.sqlite` / VS Code globalStorage / workspaceStorage 候補 / settings / logs / installed OpenAI-Codex VS Code extension bundle を read-only で棚卸しできる。ただし proof scope は `local_restore_source_inventory_only` で、VS Code restart-safe 証明ではない。
- `codex-host-primitive-audit`: installed Codex app-server schema を read-only で生成・監査し、rollback 済み user text を current-thread の model-visible input に復活させない deletion / isolation / projection primitive があるか判定できる。host-agnostic same-thread repair contract として rollback non-resurrection guarantee、memory reinjection、post-repair read verification、restart/reconnect non-resurrection smoke も要求する。実 `codex-cli 0.128.0-alpha.1` では diagnostic status として `host-primitive-audit-blocked` / `blocked-missing-current-thread-non-resurrection-guarantee` を返すが、Codex trim execute / auto-refresh の blocker にはしない。
- `codex-vscode-restore-smoke`: `--prepare` で hidden active-work marker memory を注入し、VS Code reload / reconnect 後に marker を含まない prompt への応答を `--verify` で rollout 検証する二段階 protocol。実 reload / reconnect run は `TL_CODEX_VSCODE_RESTORE_46888202` で成功済み。ただしこれは injected developer memory の restart visibility 証明であり、rollback 済み user turn の非復活証明ではない。
- `codex-vscode-rollback-smoke`: rollout を read-only で読み、rollback event、rollback 済み user text、rollback 後 user turn、restore-safety ok、`--after-vscode-restart` を満たす場合だけ rollback 非復活 proof として pass する。incident-shaped live rollback/reload run は `restore_safety_risk` として扱う。
- Context 削減量は当初は turn count だけで、実 token 削減量は未計測だった。現行 dry-run は Codex rollout text から `chars / 4` の heuristic estimate として、rollback 候補 tokens、inject memory tokens、net 削減 tokens / % を表示する。これは host tokenizer の厳密実測ではない。

Codex 側で再実装しないこと:

- `codex-sidecar` を Codex primary backend にしない。Codex primary の L2 -> L1 は Codex CLI。
- Claude hooks / `/tl` / baton / transcript parser を Codex 用に置き換えない。
- `thread/inject_items` 後の即時 `thread/read` で injected memory が turn count に出ないことを failure と見なさない。これは実測済み挙動で、次 model turn visibility は別 smoke で確認済み。

後日再開する課題:

- Codex trim rollback incident の修正計画は、blocker 解除後の durable evidence / UX polish に移る。controlled rollback model-visible smoke は clean。restore-safety diagnostics / host primitive audit / VS Code source audit は、今後も説明と監査の補助として残す。
- 完成目標は同じ Codex thread の context trim である。new-thread handoff は補助 surface として残す。
- `plannedRollbackRestoreSafety` は診断として維持する。rollback 予定 tail user text と既存 `compacted.replacement_history` を照合するが、実行前拒否には使わない。
- Claude `/rewind conversation only` の手動 UX を確認する。
- Claude Code CLI と VSCode extension で `/rewind` の挙動差があるか確認する。
- 現時点では Claude rewind は manual-only 正式仕様。documented / scriptable な conversation-only rewind primitive が見つかるまで、Throughline から Claude の rewind UI を自動操作しない。

再開時の入口:

1. この `新セッション引き継ぎ` を読む。
2. Codex 側をやり直さず、Claude `/rewind conversation only` の手動 UX 確認へ進む。
3. Claude 側に触る前に [AGENTS.md](https://github.com/kitepon/Throughline/blob/main/AGENTS.md) を読む。
4. Codex rollback incident の追加診断が必要な場合だけ、[06_codex_trim_rollback_fix_plan.md](06_codex_trim_rollback_fix_plan.md) の Phase 4 を参照する。
5. `.claude/settings.json` はユーザー環境差分を含み得るため、明示依頼なしに整理・置換しない。

## 新しい実装順

現行の実装順は次の通り。2026-05-08 時点では 1 と 2 は完了扱いで、次に進めるのは 3。

```text
1. Throughline を Codex primary で使えるようにする
   -> Codex 用 hook / lifecycle 相当の入口を作る
   -> L2 -> L1 backend は Codex CLI を本線にする

2. Codex で Claude Rewind 相当の current-thread context trim を実現する
   -> conversation-visible context を安全に削る
   -> curated memory を同一 thread に戻す
   -> model turn を不用意に開始しない
   -> controlled rollback model-visible smoke と VS Code restore smoke で restart / reconnect 境界を確認する
   -> retained compacted history / host primitive audit は diagnostics として残す

3. Claude 側のトドメを刺す
   -> Claude `/rewind conversation only` の手動 UX / 自動化 surface を詰める
   -> Codex 側と同等の運用体験に寄せる
```

## 絶対に守ること

- Claude の設定を Codex 用に置き換えない。
- `AGENTS.md` を全 host 共通の作業者向け正本とし、Claude 契約を守る規則もそこに置く。
- Claude hooks / slash command / transcript parser / baton / resume context の既存 semantics を rename しない。
- Codex 対応は adapter / bridge / Codex primary entrypoint として足す。
- Codex CLI / app-server / rollout の仕様は実測で固定する。未確認の host behavior を成功扱いにしない。
- silent fallback で失敗を隠さない。互換経路を使う場合は、理由と source を結果に残す。

## Phase 0: Current State Audit

目的: いま何が Codex-ready で、何が Claude 専用かを切り分ける。

TODO:

- [x] hook entrypoint 一覧を作る。
  - `process-turn`
  - `session-start`
  - `prompt-submit`
  - `save-inflight`
  - install / uninstall
- [x] 各 entrypoint について、Claude 固有入力に依存している箇所と、agent-neutral core にできる箇所を分ける。
- [x] L1 / L2 / L3 persistence のうち、Codex rollout / app-server から再現できる最小入力を定義する。
- [x] Codex primary で必要な session identity を定義する。
  - Codex `thread_id`
  - project path
  - rollout file
  - Throughline `session_id` 相当を作るかどうか
- [x] `codex-sidecar` と Codex CLI の役割を再整理する。
  - `codex-sidecar`: review / risk-check / second opinion
  - Codex CLI: Codex primary の L2 -> L1 backend
  - Codex app-server: thread read / resume / rollback / inject

完了条件:

- [x] Claude 専用 entrypoint と Codex primary entrypoint の境界が docs と tests で追える。
- [x] Codex primary に必要な input contract が決まっている。

Audit result (2026-05-06):

| Area | 現状 | Codex primary で必要なこと |
|---|---|---|
| `process-turn` | Claude Stop hook payload (`session_id` / `transcript_path` / `cwd`) と Claude transcript reader に依存して L2 / L3 / delayed L1 を保存する | Codex rollout JSONL を source にした capture entrypoint を別に足す。Claude transcript parser は置き換えない |
| `session-start` | Claude SessionStart payload と stdout injection で baton を consume し、`buildResumeContext` を注入する | Codex 用 resume renderer / injection surface を別に作る。Claude stdout contract は維持する |
| `prompt-submit` | Claude UserPromptSubmit で `/tl` を検知して baton を作る | Codex primary では slash command 前提にせず、CLI command または explicit memo stdin で同等の baton / memo を作る |
| `save-inflight` | Claude slash command がメイン Claude に書かせた memo を stdin で受け、現在 project の baton に保存する | Codex primary でも stdin memo writer として再利用可能。ただし memo 生成者は Codex command surface 側で決める |
| install / uninstall | `~/.claude/settings.json` と `.claude/commands` を管理する Claude 専用 entrypoint | Codex setup は別 command にする。Claude 設定へ Codex hook を混ぜない |
| DB schema | `sessions` / `bodies` / `skeletons` / `details` は `session_id` / `origin_session_id` で agent-neutral に近いが、現行 writer は Claude 由来 | Codex 由来を書き込む前に source/origin と session identity を固定する。既存 Claude-facing field は rename しない |
| Codex rollout adapter | `parseCodexRolloutFile` は `thread_rolled_back` を適用した active turns を復元できる。現在は trim preview 用 | 通常 capture 用にも使う。rollback 済み tail を current L2 として保存しない |
| Handoff projection | `HandoffRecord` は DB から安定 object を作るが、現行 `source.adapter` は `claude` 固定 | Codex capture 後に `source.adapter` / `sourceAgent` を Codex 由来にできるよう調整する |
| L2 -> L1 backend | `summarizeToL1` は `codex-sidecar` -> Claude Haiku -> `raw_l2` の Claude primary 互換経路 | host mode を必須化し、Codex primary は Codex CLI backend failure を明示 error にする |

Codex primary の最小 input contract は Phase 1 で固定した。Codex `thread_id` は裸の `session_id` として流用せず、Throughline DB では `codex:<thread_id>` に namespacing する。

## Phase 1: Codex Primary Capture

目的: Codex の会話を Throughline DB に取り込めるようにする。最初の実装 slice は L2 `bodies` capture で開始し、実測済み rollout 形式に基づいて L3 `details` も追加する。

TODO:

- [x] Codex rollout JSONL から active turns を読む adapter を、trim 用だけでなく通常 capture 用にも使える形へ整理する。
- [x] `event_msg:thread_rolled_back` を適用した active turn reconstruction を共通化する。
- [x] Codex turn を Throughline の `bodies` / `details` に保存する mapping を決める。
  - `bodies`: user / assistant / developer message を role ごとに L2 として保存する。
  - `details`: `function_call` / `function_call_output` を L3 tool input / output として保存する。
- [x] Claude transcript 由来と Codex rollout 由来を `source` / `origin` で区別する。
  - Codex primary の Throughline `session_id` / `origin_session_id` は `codex:<thread_id>` とする。
  - `thread_id` を裸の `session_id` として流用しない。
  - `HandoffRecord.source.adapter` は `codex:` namespaced session から `codex` を推定する。
- [x] Codex primary session を作る CLI entrypoint を追加する。
  - `throughline codex-capture --codex-thread-id <id>`
  - env identity は `THROUGHLINE_CODEX_THREAD_ID` / `CODEX_THREAD_ID`
  - thread id がない場合は guessing せず error
- [x] 既存 Claude session merge semantics と衝突しないことを test で固定する。
  - Codex session は namespaced id で分離する。
  - capture は同じ Codex thread session を再構成し、rollback 済み tail を DB に残さない。

完了条件:

- [x] Codex thread の active turns から Throughline DB に L2 を保存できる。
- [x] rollback 済み tail は current L2 として保存されない。
- [x] Claude path の transcript capture tests は変わらず通る。

Phase 1 implementation result (2026-05-06):

- [x] `src/codex-capture.mjs` を追加した。`parseCodexRolloutFile` の active turns を DB `bodies` へ保存する。
- [x] `throughline codex-capture` を追加した。明示 `--codex-thread-id` または env thread id が必須で、候補を自動選択しない。
- [x] Codex session identity は `codex:<thread_id>` に固定した。これにより Claude `session_id` と衝突せず、`origin_session_id` も Codex 由来として追跡できる。
- [x] 同じ Codex thread の再 capture は `skeletons` / `bodies` / `details` を再構成する。前回 capture 後に rollback された tail は残らない。
- [x] `HandoffRecord` は `codex:` namespaced session を `source.adapter = codex` として扱い、`throughline_handoff.data.sourceAgent` も `codex` になる。
- [x] Codex rollout の L3 details mapping を追加した。`response_item` の `function_call` / `function_call_output` を `details.kind = tool_input / tool_output` として保存する。
  - 実 session 再 capture: `capturedTurns = 41`, `capturedRows = 75`, `capturedDetails = 2424`
  - parser stats: `toolInputs = 1940`, `toolOutputs = 1937`
- [x] `npm test` で Claude hook entrypoint / transcript capture を含む 355 tests pass。

## Phase 2: Codex CLI L2 -> L1 Backend

目的: Codex primary で使う L2 -> L1 要約 backend を Codex CLI にする。

現在の `codex-sidecar` 優先 / Claude Haiku fallback は、Claude primary から sidecar を使う互換経路として残す。
Codex primary では、Codex CLI を本線 backend として扱う。

TODO:

- [x] `summarizeToL1` の backend 選択を host mode で分ける。
  - `claude-primary`: `codex-sidecar` configured なら sidecar、なければ Claude Haiku
  - `codex-primary`: Codex CLI
  - `unknown`: 明示エラー。呼び出し側が `claude-primary` / `codex-primary` を決める
- [x] Codex CLI summarizer wrapper を追加する。
- [x] Codex CLI subprocess は recursion / hook loop を起こさない cwd / env で起動する。
  - `codex exec --ephemeral --ignore-user-config --ignore-rules --skip-git-repo-check --sandbox read-only -C <project>`
  - env guard: `THROUGHLINE_IN_CODEX_SUMMARIZER=1`
- [x] Codex CLI summarizer は structured output または厳格な plain text output contract を持つ。
  - Phase 2 では strict plain text output contract とする。
- [x] Codex CLI failure は `source` / `reason` に残す。
  - failure は `source = codex-cli` / `reason = codex_cli_failed` 付き Error として throw する。
- [x] Codex CLI が使えない場合の扱いを決める。
  - Codex primary では fallback せず error にする。
  - Claude primary 互換経路だけ、既存通り `codex-sidecar` / Claude Haiku / `raw_l2` を source 付きで許可する。
- [x] tests を追加する。
  - Codex primary は Codex CLI backend を呼ぶ
  - Claude primary は既存 sidecar / Haiku 経路を維持する
  - Codex CLI failure は silent success にならない

完了条件:

- [x] Codex primary の L2 -> L1 source が `codex-cli` として記録される。
- [x] Claude primary の L2 -> L1 source は既存通り `codex-sidecar` / `haiku` / `raw_l2` を返せる。

Phase 2 implementation result (2026-05-06):

- [x] `summarizeToL1(l2Text, { hostMode })` は `claude-primary` / `codex-primary` / `unknown` を分岐する。
- [x] `turn-processor` は Claude Stop hook path として `hostMode: 'claude-primary'` を明示する。
- [x] Codex primary は Codex CLI backend を使い、`codex-cli` source を返す。
- [x] Codex CLI failure は Claude Haiku / raw L2 へ fallback しない。
- [x] `throughline codex-summarize --session codex:<thread_id>` を追加した。captured Codex L2 が L2 window を超えた場合、最古の未要約 turn を Codex CLI backend で L1 skeleton に書く。
- [x] 実 Codex host での `codex-summarize` smoke を実施した。`codex-cli` backend で L1 skeleton を書き、Claude Haiku / raw L2 へ fallback しないことを確認した。
  - result: `status = summarized`, `reason = codex_cli_l1_written`, `source = codex-cli`, `inserted = true`
  - target: `session = codex:019dfa40-1cc8-7d13-a110-16b09364fa6a`, `turnNumber = 1`, `l2Window = 20`
- [x] `node --test src/haiku-summarizer.test.mjs src/turn-processor.test.mjs src/hook-entrypoints.test.mjs` で 24 tests pass。
- [x] `npm test` で 355 tests pass。

## Phase 3: Codex Primary Resume / Handoff

目的: Codex で Throughline の記憶を「今やっている作業」として復元する。

TODO:

- [x] Codex primary 用 resume context renderer を作る。
- [x] `HandoffRecord` / `throughline_handoff` を Codex primary 向けに調整する。
- [x] Active Work Thread / Reading Contract / Continuation Instruction の構造を維持する。
- [x] `/tl` の in-flight memo 相当を Codex primary でどう作るか決める。
  - Codex CLI command
  - explicit memo stdin
  - automatic current-work snapshot
  - 判断: 初期 surface は `--memo-stdin` とする。main Codex が memo を書き、`codex-resume` / `codex-visibility-smoke` に stdin で渡す。Claude baton / `save-inflight` は触らない。
- [x] Codex に注入する memory item の role を固定する。
  - developer message
  - `throughline codex-resume --format item-json` は `role: developer` の message item を返す。
  - user message への格下げはしない。
  - app-server injected item として自動投入するかは Phase 4 の guarded inject で扱う。
- [x] model-visible smoke の実行 surface を追加する。
- [x] 実 Codex host で model-visible であることを実測する。

完了条件:

- [x] Codex primary で、現時点で保存済みの L2 memory を現在作業として読ませられる。
- [x] 「過去ログとして読まれる」問題を Codex primary でも再発させない。

Phase 3 implementation result (2026-05-06):

- [x] `src/codex-handoff.mjs` に `renderCodexActiveWorkContext` と `toCodexDeveloperMessageItem` を追加した。
- [x] `throughline codex-resume --session codex:<thread_id>` を追加した。保存済み Codex memory を Active Work Thread / Reading Contract / Continuation Instruction 付き Markdown として描画する。
- [x] `throughline codex-resume --format handoff` は current thread を mutate せず、新規 Codex thread に貼る短い handoff prompt を返す。handoff view は L2 件数 / 本文長 / detail refs を cap し、full active-work context は通常 text renderer に残す。
- [x] `throughline codex-handoff-smoke --session codex:<thread_id>` は新規 thread handoff prompt を read-only に検査し、prompt size / required sections / mutation boundary / detail command dedupe を固定する。
- [x] `throughline codex-handoff-model-smoke --session codex:<thread_id>` は明示 opt-in 時だけ `codex exec --ephemeral --ignore-user-config --ignore-rules --sandbox read-only` で handoff prompt の marker model smoke を行う。`--dry-run` は env なしで readiness / command boundary を監査し、`--print-prompt` で結合 prompt を出せる。`--memo-stdin` で Codex-primary current-work memo も同じ prompt に含める。structural handoff smoke が ready でなければ拒否し、current thread は mutate しない。
- [x] `throughline codex-handoff-start --session codex:<thread_id>` は safe continuation の guided entrypoint として、structural smoke / model smoke dry-run / handoff render / optional live smoke / `--print-prompt` をまとめて表示する。`--execute` では app-server `thread/start` + `thread/inject_items` で新 thread に developer memory を注入し、`--open-host auto|desktop|vscode|cli|none` で表示を開く。CLIはrequested / resolved hostを両方報告する。`auto` は Codex Desktop 起点（`CODEX_INTERNAL_ORIGINATOR_OVERRIDE="Codex Desktop"` または `__CFBundleIdentifier=com.openai.codex`）を CLI より先に識別するが、bare `$throughline` skillは現在のCodex UI surfaceを明示指定し、永続PTYの継承環境へhost選択を委ねない。Desktop の `codex://threads/<thread-id>` deep linkとVS Code / CLI の既存経路は維持する。`--memo-stdin` 時は replay 用コマンドにも `--memo-stdin` を伝播し、same memo を pipe する注意を出す。
- [x] `throughline codex-resume --format item-json` は Codex developer message item JSON を返す。
- [x] `codex-resume` は explicit session を受け取れる。省略時は cwd の最新 `codex:%` session だけを対象にし、Claude session を混ぜない。
- [x] `src/codex-handoff.test.mjs` / `src/codex-resume.test.mjs` で renderer と CLI shape を固定した。
- [x] `throughline codex-visibility-smoke --session codex:<thread_id>` を追加した。`codex-resume` 相当の active-work developer message に marker 指示を加えて `thread/inject_items` へ送り、`turn/start` の agent delta に marker が出るか確認する。
- [x] `codex-visibility-smoke` は実 model turn を開始するため、`THROUGHLINE_EXPERIMENTAL_CODEX_MODEL_VISIBLE_SMOKE=1` がない場合は app-server を起動せず refuse する。
- [x] fake app-server で marker visibility と env guard をテスト固定した。
- [x] 実 Codex host に対する `codex-visibility-smoke` を実施した。
- [x] 実 host smoke result:
  - session: `codex:019dfa40-1cc8-7d13-a110-16b09364fa6a`
  - marker: `TL_CODEX_VISIBLE_REAL_20260506_C`
  - result: `status = visible`, `reason = marker_found_in_agent_message`
  - read / resumed turns: `33 / 33`
  - observed notifications: `turn/started`, `item/started`, `item/completed`, `item/agentMessage/delta`, `turn/completed`
  - note: initial 45s attempts exposed that app-server `turn/start` returns before the model delta; the smoke helper now waits for notification events and exposes `--request-timeout-ms` / `--timeout-ms`.
- [x] `codex-visibility-smoke --resume-after-inject` を追加した。これは `thread/inject_items` 後に再度 `thread/resume` してから `turn/start` を呼び、injected memory が resume 後も model-visible かを確認する。
- [x] 実 host post-inject resume smoke result:
  - session: `codex:019dfa40-1cc8-7d13-a110-16b09364fa6a`
  - marker: `TL_CODEX_RESUME_AFTER_INJECT_REAL_20260506`
  - result: `status = visible`, `reason = marker_found_in_agent_message`
  - read / resumed / post-inject resumed turns: `38 / 38 / 38`
  - observed notifications included: `turn/started`, `item/agentMessage/delta`, `turn/completed`
- [x] 実 host smoke 後に `codex-capture` を再実行し、current Codex thread を再 capture した。
  - captured turns: `40`
  - captured body rows: `73`
  - rollback events: `3`
  - rolled-back turns excluded from active thread: `16`
  - injected active-work developer messages counted as Codex turns: `4`
- [x] Codex primary の `/tl` 相当 memo 作成 surface は `--memo-stdin` に決めた。`codex-resume` は memo を developer context の `In-flight Memo` に含めるが、thread / DB は mutate しない。
- [x] `codex-visibility-smoke --memo-stdin` は同じ memo を実 injected memory に含めて model-visible smoke できる。

## Phase 4: Codex Rewind-Compatible Trim

目的: Codex で Claude Rewind 相当の current-thread context trim を実現する。

この Phase では、Codex app-server の `thread/rollback` / `thread/inject_items` を使い、同一 thread の conversation-visible context を削って curated memory を戻す。

TODO:

- [x] guarded execute の条件を本線仕様として再定義する。
  - explicit thread identity
  - rollout/app-server turn count match
  - rollback candidate preview
  - memory preview
  - post-inject visibility check
- [x] execute env gate を外せる条件を再検討した。
  - 2026-05-07 correction: live app-server smoke / post-inject visibility / worktree 非破壊性だけでは不十分だったため、一時的に `THROUGHLINE_EXPERIMENTAL_CODEX_TRIM_EXECUTE=1` gate を戻した。
  - 2026-05-08 unblock: controlled rollback model-visible smoke が app-server restart 境界と VS Code reload/reconnect 境界の両方で `not-reproduced` だったため、env gate / host primitive audit gate / restore-safety-only blocker を解除した。2026-05-09 update: rollout/app-server turn-count mismatch も blocker から外し、app-server `thread/read` / `thread/resume` が一致する場合は差分補正で rollback `numTurns` を決める。
- [x] partial rollback の multi-turn harness を作る。
- [x] rollback marker / injected memory が live `thread/resume` 後も効くか確認する。
- [x] ローカルファイル変更が戻らないことを、実ファイル付き smoke で確認する。
- [x] model turn を開始しない execute path を維持する。
- [x] dry-run / preflight / execute の JSON schema を固定する。
- [x] read-only app-server process restart smoke を追加する。
  - `throughline codex-restore-smoke --codex-thread-id <id>` は fresh app-server process を複数回起動し、rollout active turn count と `thread/read` / `thread/resume` / paginated `thread/turns/list` の一致を確認する。
  - proof scope は `app_server_process_restart_only`。VS Code restart / reconnect 越しの rollback / inject durability はまだ証明しない。
- [x] failure mode を固定する。
  - turn count mismatch diagnostic / app-server-count rollback adjustment
  - inject visibility timeout
  - app-server unavailable
  - thread not found
  - rollout missing

完了条件:

- [x] Codex で「Claude Rewind 相当」と呼べる current-thread context trim が同一 thread で動く。
  - 2026-05-08 live run: current thread で guarded rollback + Throughline DB developer-memory inject を実行し、`execute-durable-verified` を確認した。durable success は rollout 上の新 rollback event と injected active-work memory evidence で判定する。`restoreSafety.status = risk` は compacted history retention の diagnostic であり、単独 blocker ではない。
- [x] 誤 thread を trim しない guard が test で固定されている。
- [x] inject 済み memory が次の model turn で使えることを実測済み。

Phase 4 implementation status (2026-05-07):

- [x] `throughline trim --preflight --host codex --codex-thread-id <id>` は `thread/read` / `thread/resume` まで実行し、rollback / inject は送らない。
- [x] historical: `throughline trim --execute --host codex --codex-thread-id <id>` は guarded execute を行う実装だった。2026-05-07 correction では env gate と host primitive audit gate を戻して一時 blocked にした。2026-05-08 unblock では controlled rollback model-visible smoke が再現しなかったため、env gate / host primitive audit gate / restore-safety-only blocker を外し、DB memory と rollout/app-server turn-count diagnostics を残した。
- [x] rollout source を使う場合、rollback 前に rollout active turn count と app-server `thread/read` / `thread/resume` turn count を照合する。不一致でも refuse せず診断に残す。`readTurns === resumedTurns` なら planned rollback turns に `readTurns - expectedTurns` を足して `thread/rollback.numTurns` を送る。
- [x] guarded execute は `thread/rollback` -> `thread/inject_items` -> post-inject `thread/read` polling の順に進む。`turn/start` は呼ばない。
- [x] fake app-server harness で partial rollback、delayed inject visibility、mismatch adjustment、mutation not sent preflight を固定した。
- [x] `thread/resume` 後に injected memory が維持されることを、実 Codex host smoke として確認済み。
- [x] 実 Codex host での next model turn visibility smoke は Phase 3 の `codex-visibility-smoke` で確認済み。active-work developer message が次の model turn の agent delta に反映された。
- [x] 実 Codex host で `trim --preflight --host codex --codex-thread-id 019dfa40-1cc8-7d13-a110-16b09364fa6a --json` を実行し、guard が mutation 前に read / resume count を照合することを確認した。
  - latest rollout active turns: `41`
  - latest app-server read / resumed turns: `41 / 41`
  - result: `preflight-ready`, `reason = rollback_not_sent`
  - rollback preview: `numTurns = 1`
  - 判断: `thread/rollback` / `thread/inject_items` は preflight では送らない。
- [x] 旧 mismatch の原因を調査して解消した。
  - app-server は `thread/inject_items` で入れた `## Throughline: Active Work Context` を standalone turn ではなく `contextCompaction` item として扱う。
  - app-server は legacy `## Throughline Trim Memory Preview` response item を rollback 対象 turn としては数えない。
  - app-server は `task_complete` 後の assistant continuation を `rollout-*` synthetic turn として扱う。
  - rollout parser はこの実測に合わせ、Throughline injected developer memory を turn count へ入れず、assistant continuation を synthetic turn として数える。
- [x] 実 Codex host で guarded execute を再実施した。2026-05-07 correction 時点では live app-server smoke であり、restart-safe durability の証明ではなかった。
  - historical execute output: `status = executed`, `rollbackSent = true`, `injectSent = true`, `rollbackRequestedTurns = 1`
  - pre-execute guard: rollout / app-server turns `41 / 41`, `status = match`
  - post-inject read: `afterTurns = 40`
  - note: current Codex app-server では injected memory は即時 turn count としては見えない場合がある。2026-05-08 の修正後は、`thread/inject_items` が turn list を返さない developer item-level injection では rollback 後 turn count のまま `postInjectVisibilityCheck.status = match` とし、rollout 上の新 rollback event と injected active-work memory evidence で `execute-durable-verified` と判定する。
- [x] 実ファイル変更を伴う smoke で、context rollback が worktree を戻さないことを再確認した。2026-05-07 correction: これは worktree 非破壊性の確認であり、restart-safe durability の証明ではない。
  - temporary file: `THROUGHLINE_CODEX_ROLLBACK_SMOKE.tmp`
  - pre-execute hash: `a38b82d91eb5dd83cd116c2ede362b66001612c06f97e84de104074979756f03`
  - post-execute hash: `a38b82d91eb5dd83cd116c2ede362b66001612c06f97e84de104074979756f03`
  - historical execute output: `status = executed`, `rollbackSent = true`, `injectSent = true`, `rollbackRequestedTurns = 1`
  - post-execute preflight: rollout / app-server turns `37 / 37`, `status = preflight-ready`
  - note: rollback 後、同一 Codex turn 内で続いた assistant messages は app-server では `rollout-*` synthetic turn として見える。rollout parser も「最新 rollback 後、次の `task_started` がまだ無い assistant continuation」だけ synthetic turn として数える。
- [x] 実 resume-after-inject smoke 後の preflight で、rollout / app-server turn count が `40 / 40` に戻ることを確認した。
  - note: `task_complete` 後に続く末尾 pending messages も app-server では現在 turn として見えるため、rollout parser は EOF の pending messages を synthetic turn として数える。
- [x] Codex app-server protocol / local store を調査した。
  - `codex app-server --help` と generated schema / TypeScript では、`thread/rollback`、`thread/inject_items`、`thread/read`、`thread/resume`、`thread/compact/start` は確認できたが、compacted replacement history を直接更新する documented durable rollback primitive は見つからなかった。
  - `throughline codex-host-primitive-audit --json` を追加し、installed schema の method set を機械監査できるようにした。実環境では `methodCount = 89`、`thread/resume(history)` は `[UNSTABLE] FOR CODEX CLOUD - DO NOT USE` かつ `thread_id` ignored のため不採用、current-thread history rewrite / compacted-history clear candidate は `0`。
  - `~/.codex/state_5.sqlite` の `threads` table は rollout path / metadata を持つが、turn bodies は持たない。turn body の主根拠は rollout JSONL 側である可能性が高い。ただし VS Code extension の restore source は未確定。
- [x] `throughline codex-restore-smoke` を追加した。
  - `THROUGHLINE_EXPERIMENTAL_CODEX_RESTORE_SMOKE=1` が無い場合は app-server を起動せず refuse する。
  - rollout source が無い場合、または restore-safety risk がある場合も app-server 起動前に refuse する。
  - count-only stable result は `status = app-server-restart-stable` / `proofScope = app_server_process_restart_only` / `restartSafe = false`。
  - 2026-05-07 historical count-only 実測: project thread `019dfddb-8288-7392-a461-bf3ebc5da409` で read-only smoke を実行し、2 cycles とも rollout / read / resume turns `14 / 14 / 14` で stable。これは app-server process restart の部分証明であり、VS Code restart-safe 証明ではない。
  - 2026-05-07 追加: 同 smoke は `thread/turns/list` も paginated に確認するよう拡張した。`thread/read` / `thread/resume` と `thread/turns/list` のどれかが rollout active turn count と不一致なら mismatch とする。2026-05-08 の risky response inspection では、turn count 安定だけでは成功扱いせず、retained rollback text を blocking candidate と quoted/tool-output field に分類する。
- [x] `throughline codex-restore-source-audit` を追加した。
  - Codex rollout、`session_index.jsonl`、`state_*.sqlite`、VS Code globalStorage / workspaceStorage 候補、installed OpenAI/Codex VS Code extension bundle を read-only で棚卸しする。
  - 実 project thread `019dfddb-8288-7392-a461-bf3ebc5da409` では rollout と session index と `state_5.sqlite` の `threads` metadata row が見つかった。`agent_job_items` / `stage1_outputs` は content 系 table 候補だが、この thread id に紐づく row は 0。VS Code globalStorage / workspaceStorage audit は 45 files scanned / 0 matches だった。
  - proof scope は `local_restore_source_inventory_only`。VS Code extension restart の実 restore path を直接実行するものではない。
- [x] installed VS Code extension の static audit を実施した。
  - `code --status` で Code `1.118.1`、WSL Remote、`openai.chatgpt` extension が確認できた。
  - `openai.chatgpt-26.429.30905-linux-x64` の minified webview / extension bundle には `thread/read`、`thread/resume`、`thread/turns/list`、`thread/compact/start`、`markAllConversationsNeedResumeAfterReconnect` が見える。reconnect 時は in-memory conversation を `needs_resume` に戻し、app-server resume/read 系へ寄せる仮説が強い。
  - 同 bundle には webview `localStorage` の `codex:persisted-atom:` prefix も見える。これは UI atom persistence であり、rollback 済み user turn の durable restore source かは未確定。
  - `code --status` は read-only で使えるが、`workbench.action.reloadWindow` をこの非対話 Codex session から実行して proof とするのは危険。Caveat のとおり parent-pid watch に依存せず、VS Code extension restart / reconnect smoke は明示 phase boundary として設計する。
  - 2026-05-07 追加実装後の `codex-restore-source-audit` 実測では、extension scan は 942 files / 6 matches / truncated false。`openai.chatgpt-26.429.30905-linux-x64` から `thread/read`、`thread/resume`、`thread/turns/list`、`thread/compact/start`、`thread/rollback`、`markAllConversationsNeedResumeAfterReconnect`、`needs_resume`、`codex:persisted-atom:`、`chatgpt.followUpQueueMode`、`send-follow-up-message`、`steeringUserMessage` を検出し、`replacement_history` は未検出。VS Code storage は 45 files scanned / 0 matches のまま。VS Code settings は searched だが `chatgpt.followUpQueueMode` は not-configured、extension package default は `queue`。conclusion は `vscode_extension_reconnect_appears_to_resume_threads_via_app_server`。
  - 2026-05-08 追加実装後の VS Code log audit は thread-id raw match だけでなく、retained rollback text、patch apply failure、thread stream broadcast、`replacement_history` signal に分類する。実 current thread では logs 1185 files scanned / thread id matches `40` / retained rollback text matches `0` / patch apply failures `39` / patch failure window `2026-05-07 00:35:35.339 -> 2026-05-07 00:36:29.925` / thread stream signals `164` / `replacement_history` signals `0`。patch failure は `Failed to apply patches for conversationId=<thread-id>` の thread-specific signal で、retained rollback text が logs に残っている証拠ではない。
- [x] `throughline codex-vscode-restore-smoke` を追加した。
  - `--prepare` は hidden active-work marker memory を app-server に inject し、VS Code reload / reconnect 後に送る marker-free prompt と verify command を出す。mutation のため `THROUGHLINE_EXPERIMENTAL_CODEX_VSCODE_RESTORE_SMOKE=1` 必須。
  - `--verify` は rollout を read-only で読み、prepare 後の marker-free smoke prompt、assistant の marker-only answer、user prompt への marker leak 不在を確認する。
  - `restartSafe: true` は `--after-vscode-restart` 明示と marker proof がそろう場合だけ。
  - 実 project thread `019dfddb-8288-7392-a461-bf3ebc5da409` で marker
    `TL_CODEX_VSCODE_RESTORE_46888202` を注入し、VS Code reload / reconnect 後に
    marker-free smoke prompt を送った。`--verify --after-vscode-restart` は
    `status = vscode-restart-visible` / `restartSafe = true`、`userMarkerMatches = []`。
  - verifier は false positive 防止のため、assistant の marker mention だけではなく
    marker-free prompt と marker-only answer の組を要求する。

## Phase 5: Codex UX

目的: Codex primary ユーザーが Throughline を普通に使える入口を作る。

TODO:

- [x] Codex 用 command surface の先行 slice を決める。
  - `throughline codex-capture`
  - `throughline codex-resume`
- [x] Codex trim / setup まで含む command surface を決める。
  - `throughline trim --host codex`
  - `throughline trim --preflight --host codex --codex-thread-id <id>`
  - `throughline trim --execute --host codex --codex-thread-id <id>` (DB memory がある場合に current-thread rollback / inject を実行し、rollout/app-server turn-count mismatch は診断と `numTurns` 補正に使う)
  - `doctor --codex` / `codex-capture` / `codex-summarize` / `codex-resume --memo-stdin` / `codex-visibility-smoke`
- [x] Codex primary の doctor を追加または拡張する。
- [x] Codex primary の setup / install 手順を追加する。
  - global `throughline install` は `~/.codex/hooks.json` に絶対 node + installed `bin/throughline.mjs codex-hook stop` を登録し、`~/.codex/config.toml` の `[features].codex_hooks = true` を有効化し、`~/.codex/skills/throughline` に `$throughline` skill を配置する。
  - 既存 Caveat / Spotter などの Codex hooks は保持し、`throughline uninstall` は Throughline 管理 hook だけを削除する。
  - manual diagnostics / explicit operation: `doctor --codex` -> `codex-capture` -> `codex-summarize` -> `codex-resume --memo-stdin` -> 必要なら model-visible smoke / trim preflight / explicit trim execute。
- [x] README には実装済み behavior だけ載せる。
- [x] Codex primary の smoke 手順を docs に固定する。

完了条件:

- [x] Codex だけを使うセッションで、capture -> summarize -> resume -> trim が通る。
- [x] Claude 設定なしでも Codex primary path の診断ができる。

Phase 5 implementation status (2026-05-06):

- [x] `throughline doctor --codex` を追加した。Codex thread env identity、cwd の rollout candidates、captured `codex:<thread_id>` DB sessions、context-refresh memory contract、new-thread handoff readiness、safe continuation status、host primitive audit status、次に使う capture / handoff / resume / audit command を表示する。doctor 自体は read-only で、Codex thread / DB / Claude settings を変更しない。`doctor --trim --host codex` も host primitive audit status を表示する。
- [x] `doctor --codex` は Claude settings を変更しない。Codex primary entrypoint の診断に限定する。
- [x] 実セッションで `doctor --codex` -> `codex-capture` -> `codex-resume --format item-json` -> `doctor --codex` の local smoke を実施した。`codex-resume` は developer message item JSON を描画し、再診断で captured DB session が 1 件として表示された。
- [x] 実セッションで `codex-visibility-smoke` を実施した。`THROUGHLINE_EXPERIMENTAL_CODEX_MODEL_VISIBLE_SMOKE=1` を必須にし、長い model turn に備えて `--request-timeout-ms 150000` / `--timeout-ms 180000` を使えるようにした。
- [x] Codex primary の setup / install 手順は README に記録した。global install は Codex hooks と `$throughline` skill を自動登録する。2026-05-10 以降、bare `$throughline` は `throughline codex-handoff-start --execute --open-host <current-codex-surface>` による app-server 新スレッド handoffとし、current surfaceはCodex UI contextから明示する。hooks は capture / monitor state write だけを行い、current-thread rollback / inject は明示 `trim --execute --host codex` を要求された時だけ使う。
- [x] `codex-summarize` を明示診断・運用 flow に追加した。Codex CLI backend を使い、Claude Haiku へ fallback しない。
- [x] Codex primary の summarize / guarded execute まで含む end-to-end smoke を実施した。2026-05-07 correction では guarded execute を live app-server smoke としてのみ扱った。2026-05-08 unblock 後は、controlled rollback model-visible smoke の `not-reproduced` と current-thread live run の `execute-durable-verified` を合わせて、Codex current-thread trim 完了条件に含める。
  - `codex-capture`: `capturedTurns = 41`, `capturedRows = 75`, `capturedDetails = 2424`
  - `codex-summarize`: `status = summarized`, `source = codex-cli`
  - `codex-resume --format item-json`: L1 summary と active L2 context を developer message item として描画
  - `trim --preflight --host codex`: rollout / app-server turns `41 / 41`
  - historical `trim --execute --host codex`: `status = executed`, `rollbackSent = true`, `injectSent = true`
- [x] global install 後の実環境で Codex 設定を確認した。
  - `~/.codex/hooks.json` の Stop 先頭に Throughline Codex Stop hook が入り、Caveat / Spotter hooks は保持されていた。
  - `~/.codex/config.toml` は `[features].codex_hooks = true`。
  - API 経由のこの Codex turn では自然 Stop hook 発火は未確認だったため、同じ payload shape を手動再現して `codex:019dfd15-db7b-7521-9f66-050268bef1c8` capture と `codex-resume --format item-json` 描画まで確認した。
  - 追加実測: assistant final 後に rollout は `task_complete` まで進んだが、latest DB session は `codex:019dfd15-db7b-7521-9f66-050268bef1c8` のままで、current thread `019dfd38-c530-71c3-b7b8-180bdd3054bc` の自然 capture は発生しなかった。同じ payload shape の手動再現では capture できたため、Throughline の payload parser / DB writer は成立している。ただし Caveat project (`/home/kite/projects/Caveat`) では Codex Stop hook が動く実測があるため、これは Codex Stop hook 全体の不発とは一般化せず、Throughline DB capture が自然に進んだかを `doctor --codex` で確認する運用上の制約として扱う。
  - 修正: Caveat の Codex Stop hook は `async: false` で登録され、nested `codex exec` smoke で Stop -> 次 turn 注入まで確認済みだった。Throughline は Claude Stop と同じ発想で Codex Stop も `async: true` にしていたため、Codex 側だけ Caveat と同じ同期 hook に寄せた。既に `async: true` で登録済みの Throughline Codex Stop hook も次回 `throughline install` で `async: false` に更新される。
  - 再実測: `npm install -g .` -> `throughline install` 後、`~/.codex/hooks.json` の Throughline Codex Stop は `async: false` になり、Caveat / Spotter hooks は保持された。`codex exec --json -C /home/kite/projects/Throughline "Reply exactly: TL_CODEX_SYNC_STOP_SMOKE_20260506"` で child thread `019dfd4f-93ff-7522-8f89-bd1e1996c8d7` が作られ、直後の `throughline doctor --codex` で latest DB session が `codex:019dfd4f-93ff-7522-8f89-bd1e1996c8d7` に進んだ。Codex Stop hook の自然 capture は同期登録で確認済み。
  - 追加修正: Caveat の Codex hook は bare `caveat` ではなく絶対 node + installed CLI script path で登録されていた。Throughline も Codex App Server / VSCode host の PATH 差分を避けるため、旧 bare `throughline codex-hook stop` を次回 install で絶対 node + `bin/throughline.mjs codex-hook stop` に置換する。`doctor --codex` は Codex hook feature / Throughline Stop hook command / legacy bare command を診断表示する。
  - 絶対パス型の再実測: `npm install -g .` -> `throughline install` 後、`~/.codex/hooks.json` の Stop 先頭は `/usr/bin/node /home/kite/projects/Throughline/bin/throughline.mjs codex-hook stop`、`async: false`になり、Caveat / Spotter hooks は 2 番目以降に保持された。2026-08-02 correction: 当時記録した`timeoutSec: 300`はCodexに無視される誤keyで、v0.8.8から正規の`timeout: 300`へ修正した。`doctor --codex` は `Codex hooks feature: enabled` / `Codex Stop hook: registered` を表示した。`codex exec --json -C /home/kite/projects/Throughline "Reply exactly: TL_CODEX_ABSOLUTE_STOP_SMOKE_20260506"` で child thread `019dfd5e-1248-7c11-8ddc-97e1b0701e10` が作られ、直後の `throughline doctor --codex` で latest DB session が `codex:019dfd5e-1248-7c11-8ddc-97e1b0701e10` に進んだ。
  - 追加確認: current VSCode-origin parent thread `019dfd38-c530-71c3-b7b8-180bdd3054bc` は hook shape 変更前に開始していたため、変更後の自然 Stop smoke としては不適格。assistant final 後に rollout は `task_complete` まで進んだが latest DB session は exec child のままだった。次に VSCode-origin を見る場合は、hook shape 変更後に新しく開始した Codex session で確認する。
  - 最終確認: hook shape 変更後に新しく開始した VSCode-origin Codex session で 1 turn 完了後、`throughline doctor --codex` を実行した。`current Codex thread` は `019dfd62-9a9d-7211-bf91-89d8e3fc908e`、`latest DB session` は `codex:019dfd62-9a9d-7211-bf91-89d8e3fc908e` で一致し、`Codex hooks feature: enabled`、`Codex Stop hook: registered`、command は `/usr/bin/node /home/kite/projects/Throughline/bin/throughline.mjs codex-hook stop`、`async: false`だった。2026-08-02 correction: 当時の`timeoutSec: 300`は無効で、v0.8.8の再install後は`timeout: 300`を正とする。VSCode-origin の自然 Stop hookによるDB captureの証拠自体は維持する。
  - historical 2026-05-07 correction: 以下の Codex trim smoke は live app-server primitive の履歴として残す。ただし 2026-05-06 incident 後、restart / reconnect 越しの durable context trim 成功とは一時的に扱わず、`$throughline` / Codex Stop hook の automatic mutation を止めていた。
  - 2026-05-10 UX 修正: bare `$throughline` は `doctor --codex` / `trim --dry-run --all` / `trim --preflight --all` を AI に順番実行させる説明 surface でも、`trim --execute --host codex --all` を直接実行する current-thread refresh でもなく、`throughline codex-handoff-start --execute --open-host <current-codex-surface>` による app-server 新スレッド handoff とする。current surfaceはCodex UI contextから明示し、current-thread rollback / inject は明示要求時だけ使う。
  - memory contract 修正: Codex guarded trim でも注入 memory は元の `/tl` 思想を正とする。古い turn は L1 summaries、直近 20 turn は L2 full bodies、L3 は reference only で、L3 bodies / tool payloads は注入しない。rollout source は rollback candidate と app-server turn-count 補正の根拠であり、Throughline DB memory がある場合に rollout active work preview を注入 memory として使わない。DB memory が無い execute は rollout preview を注入せず、mutation 前に拒否する。
  - doctor visibility 修正: `doctor --codex` は旧 context refresh readiness として rollback source、inject memory source、memory contract、L1 summaries / recent L2 bodies / L3 references-only count、heuristic reduction estimate を表示していた。実 thread `019dfd62-9a9d-7211-bf91-89d8e3fc908e` では live readiness として `context refresh: ready`、`rollback source: codex-rollout`、`inject memory source: throughline-db`、`memory contract: older L1 + latest 20 L2 full bodies + L3 references only` を確認した。ただし incident 後は restart-safe readiness ではない。
  - 削減量の記録: `trim --dry-run --host codex` は rollout text がある場合に `contextReductionEstimate` を返す。2026-05-06 の現在 thread `019dfd62-9a9d-7211-bf91-89d8e3fc908e` では通常 keep-recent preview だと `capturedTurns = 14` / `keepRecent = 20` のため `rollbackTurns = 0`、推定削減量も 0 だった。旧 bare `$throughline` context refresh は `--all` を使っていたため、この keep-recent preview の 0 は「Codex で削減できない」という意味ではない。
  - historical live-only `$throughline` context refresh smoke: 同じ VSCode-origin thread `019dfd62-9a9d-7211-bf91-89d8e3fc908e` で `trim --dry-run --host codex --all --json` -> `trim --preflight --host codex --all --json` -> `trim --execute --host codex --all` を実行した。preflight は rollout/app-server turn count `20 / 20` match、execute は `rollbackSent = true`、`injectSent = true`、`injectedItems = 1`、`rollback candidate turns = 20`。直前見積もりは `rollbackEstimatedTokens = 179780`、`injectedMemoryEstimatedTokens = 2009`、`netEstimatedTokens = 177771`、`reductionPct = 99` (`chars / 4` heuristic)。これは live app-server smoke であり、restart-safe durability の証明ではない。
  - post-refresh confirmation: execute 後の次 user turn で `doctor --codex` は current thread と latest DB session の一致を維持し、latest DB session は `2026-05-06 22:41:10` へ更新された。`trim --dry-run --host codex --all --json` は `activeTurns = 2`、`rollbackEvents = 1`、`rolledBackTurns = 20` を返し、`codex-resume` は rollback 後の短い active work context を L2 として描画した。
  - monitor adapter 修正: `throughline monitor` は Claude / Codex host-aware state を読む。Codex Stop hook は `codex:<thread_id>` monitor state を書き、Codex rollout path は Claude transcript 用 `transcriptPath` ではなく `rolloutPath` に保存する。2026-05-09 以降、monitor は `~/.throughline/state` だけでなく `~/.codex/sessions/**/rollout-*.jsonl` も直接 discovery するため、state 未生成の現在 Codex thread も表示できる。既存 state がある場合は usage snapshot を保持しつつ discovered rollout path / mtime を合流する。rollout に `event_msg` / `token_count` がある場合は verified usage として表示し、無い場合だけ `estimated: true` / `source = codex-rollout-chars-div-4` の明示 estimate を使う。state filename は URL encode し、`codex:` session id を Windows でも保存可能にした。表示 ID は `codex:` prefix を外した raw thread id 先頭 8 桁。
  - monitor doctor 修正: Codex Stop hook stdout は VSCode chat に必ず見えるとは限らないため、`doctor --codex` に `.vscode/tasks.json` の Throughline Monitor task 診断を追加した。登録済み / 未登録 / JSONC / parse error / broken absolute path と `runOn`、および初回作成後は `Developer: Reload Window` が必要という note を read-only で表示する。
  - historical automatic refresh 実装: Codex Stop hook は capture / L1 summarize / monitor state 書き込み後、verified usage が verified context window の `90%` 以上なら automatic refresh を試行する経路を持っていた。2026-05-06 incident 後、この経路は blocker として扱い、monitor state / warning / diagnostics は残しても rollback + inject は送らない状態にした。2026-05-08 unblock 後は guarded rollback / inject を再有効化し、2026-05-09 以降は verified usage `75%` 以上を既定閾値にした。2026-05-10 の live token_count 実験後は、automatic refresh mutation を再び無効化する。
  - current-session trigger 修正: Codex `UserPromptSubmit` / `PostToolUse` hooks は当該 session の rollout capture / monitor state write だけを行う。verified 75% 以上でも `$throughline` workflow 実行指示を `additionalContext` として注入しない。monitor は表示専用で、自動発火の判定元にしない。

## Phase 6: Claude Side Finalization

目的: Codex 側の互換機能が固まったあと、Claude 側の Rewind / trim を最後に詰める。

TODO:

- [ ] Claude `/rewind conversation only` の手動 UX を確認する。
- [ ] Claude Code CLI / VSCode extension で挙動差があるか確認する。
- [x] 外部ツールから自動化できる surface があるか確認する。
  - local evidence: `claude --help` on Claude Code `2.1.128` exposes `--resume` / `--continue` / session flags, but no non-interactive rewind command or rollback flag.
  - public docs evidence: Anthropic Claude Code slash command docs list `/clear` and `/compact`, but do not list `/rewind` as a documented built-in slash command.
  - conclusion: Throughline must not claim automatic Claude rewind unless a future Claude CLI / API surface is found and verified.
- [x] 自動化できない場合、Throughline がどこまで UX を持つか決める。
  - decision: Claude primary remains manual-only for conversation rewind.
  - Throughline provides `/tl-trim` dry-run, current-work memory preview, and explicit instructions. It does not try to drive the interactive `/rewind` UI.
  - No `/tl restore` mutation surface is added until Claude exposes a verified conversation-only rewind primitive.
- [x] Claude trim で L2 / L1 を current work として再注入する最終 contract を決める。
  - contract: reuse the same Reading Contract / Active Work Thread / Continuation Instruction framing as Codex, but render it as a manual preview for Claude after the user performs conversation-only rewind.
  - in-flight memo remains first-class and comes from the main Claude agent via `/tl` / `save-inflight`; it is not generated by a sidecar.
- [x] Claude 側の docs / README / doctor を更新する。
  - README に Claude primary は manual-only であり、Throughline は rewind UI を自動操作しないことを明記した。
  - `doctor --trim --host claude` は manual procedure を表示する既存 surface を維持する。

完了条件:

- [x] Claude 側でできること / できないことが明確に documented されている。
- [x] Codex 側で完成した互換機能との差分が明示されている。
- [x] Claude primary の既存 `/tl` baton handoff は壊れていない。
  - verification: `npm test` で baton / SessionStart / hook entrypoint coverage を含む 355 tests pass。

## Open Questions

- [x] Codex primary の session id は Codex `thread_id` をそのまま使うか、Throughline 独自 session を別に作るか。
  - 判断: 裸の `thread_id` は使わず、Throughline DB では `codex:<thread_id>` を `session_id` / `origin_session_id` に使う。
- [x] Codex CLI L2 -> L1 backend は `codex` を直接 spawn するか、Throughline 内に thin wrapper module を置くか。
  - 判断: `src/haiku-summarizer.mjs` 内に thin wrapper を置き、Codex primary では `codex exec --ephemeral --ignore-user-config --ignore-rules --skip-git-repo-check --sandbox read-only -C <project>` を呼ぶ。`codex-cli 0.128.0-alpha.1` の `codex exec` には `--ask-for-approval` が無いため使わない。
- [x] Codex primary で L2 -> L1 backend が失敗した場合の扱い。
  - 判断: Codex primary は Codex CLI backend 失敗を明示 error にする。Claude primary の既存互換経路だけ fallback reason/source 付きで維持する。
- [x] Codex Rewind-compatible trim を本線化するとき、experimental env を外す条件は何か。
- [x] Claude 側は automatic rewind を目指すのか、manual-only を正式仕様にするのか。
  - 判断: 現時点は manual-only を正式仕様にする。将来、Claude Code が documented / scriptable な conversation-only rewind primitive を公開した場合だけ automatic 化を再検討する。

## 次の作業

Codex primary の capture / summarize / resume は完了扱い。Codex trim execute は明示診断用 current-thread path として残すが、auto-refresh は 2026-05-10 の live token_count 実験後に無効化済み。[06_codex_trim_rollback_fix_plan.md](06_codex_trim_rollback_fix_plan.md) の Phase 0-4、read-only app-server process restart smoke、local restore source audit、host primitive audit、manual VS Code restore smoke protocol、実 VS Code reload / reconnect marker proof、rollback 非復活 verifier、controlled rollback model-visible smoke surface は実装済み。incident-shaped live rollback run は `restoreSafety.status = risk` で、`compacted.replacement_history` retention と rollback 済み text match を診断上は観測した。後続の app-server response 分類では retained text が `aggregatedOutput` の引用に限定され、direct user message / model-visible reproduction とは分けて扱う。host primitive audit でも current-thread rollback non-resurrection primitive は見つかっていない。通常 `$throughline` は新スレッド handoff prompt とし、current-thread rollback / inject は自動化しない。

再開時は次を実施する:

1. Codex 新スレッド handoff UX を通常 `$throughline` surface として磨き、必要な場合だけ明示 `trim --execute --host codex` の telemetry を見る。
2. VS Code restore path の追加実測を行い、`compacted.replacement_history` が rollback 済み user text の復元元として残る経路をさらに特定する。
3. restore-safety / host primitive audit を blocker として再導入する場合は、controlled smoke で再現した具体的 evidence を先に記録する。
4. その後に Claude `/rewind conversation only` の手動 UX 確認へ戻る。

## Audit Notes

2026-05-08 監査結果:

- [x] `restartSafe` / `restore_safety` / `safeContinuation` / `current-thread compacted-history` / `trim --execute` / `auto-refresh` まわりの README / CLAUDE.md / Codex roadmap / rollback fix plan を再スキャンし、restart-safe evidence がない automatic mutation を安全扱いしている記述が残っていないことを確認した。
- [x] 同じ文書内で「Codex rollback trim は explicit refusal として固定済み」と「これから product decision を固める」が並ぶ古い引き継ぎ文を修正した。2026-05-08 unblock 後の現行の次手は、実運用結果分類と VS Code restore path の追加実測を続けること。
- [x] CLI help に載せた Codex subcommand が `bin/throughline.mjs` の dispatch から漏れたら落ちるテストを追加した。
- [x] Historical audit: current thread `019dfddb-8288-7392-a461-bf3ebc5da409` を read-only 再監査した。当時の `doctor --codex` は context refresh `blocked` / `restore_safety_risk`、new-thread handoff `ready`、host primitive audit `no_current_thread_restore_non_resurrection_primitive`。`trim --preflight --host codex --all` は `restore_safety_risk` で拒否。2026-05-08 unblock 後、この restore-safety risk と host primitive audit は diagnostic-only に変更済み。
- [x] `codex-restore-source-audit` に VS Code extension signal の bounded `sourceSnippets` と機械判定用 `sourceFacts` を追加した。実 bundle の snippet では `thread/resume` が `history:null` と `path:c?.rolloutPath??null` を渡す近傍、reconnect handler が `markAllConversationsNeedResumeAfterReconnect()` を呼ぶ近傍、follow-up queue default が `queue` である近傍を JSON で監査できる。`sourceFacts.reconnectResumeViaAppServerRolloutPath = true` も出る。これは static source evidence であり、restart-safe proof ではない。
- [x] `codex-restore-smoke --inspect-risky-rollout` を追加し、risky rollout でも明示 flag 時だけ read-only app-server response を監査できるようにした。実 current thread では `thread/read` / `thread/resume` / `thread/turns/list` の全 response に retained rollback text が見えた。これは app-server process restart count が stable でも、response payload 側には rollback 済み text が残る risk evidence である。risk inspection は exit 1 のまま。
- [x] `codex-restore-smoke` は restore text が app-server response に残る場合、count stability を成功風に扱わず retained text location を報告する。初期実装では `status = app-server-restore-text-retained` / `reason = restore_text_seen_in_app_server_response` としていたが、後続分類で direct turn text / `replacement_history` と quoted/tool-output field を分けるようにした。
- [x] `codex-vscode-rollback-smoke` の text output に `rollbackTextRetainedInCompacted` / `resurrectedUserMessages` / risk type summary を追加した。実 current thread の read-only verify は `restore_safety_risk`、retained `20`、resurrected は live snapshot で増え得る。2026-05-08 の再確認時点では user messages after rollback `37`、resurrected `16`、risk types `rollback_text_retained_in_compacted_replacement_history:20` / `rolled_back_user_text_reappeared_after_rollback:3`。
- [x] `codex-restore-source-audit` の VS Code storage audit に SQLite-backed storage inventory を追加した。`.vscdb` / `.sqlite` / `.sqlite3` / `.db` 候補を read-only で開き、table / searchable column / needle match summary を返す。実 current thread の再確認では default VS Code storage roots は 45 files scanned、direct matches `0`、SQLite DB candidates `0`、SQLite matches `0`。このため current environment では VS Code storage 側に retained rollback text を持つ local persisted restore source は見つかっていない。
- [x] `codex-restore-smoke --inspect-risky-rollout` を再実行した。2026-05-08 の中間確認では `expectedTurns = 16` / read-resume-list `16 / 16 / 16` で count は一致し、retained rollback text 7 件が全 response source に残っていた。後続分類ではこれらは `aggregatedOutput` に限定され、`app-server-restore-text-quoted` / `blocking-candidates=no` へ分離された。
- [x] `codex-restore-source-audit` の VS Code log audit に structured signal と patch failure timestamp window を追加した。実 current thread の再確認では VS Code logs は 1185 files scanned、raw log match files `2`、thread id matches `40`、retained rollback text matches `0`、patch apply failures `39`、patch failure window `2026-05-07 00:35:35.339 -> 2026-05-07 00:36:29.925`、thread stream signals `164`、`replacement_history` signals `0`。つまり logs には thread-specific patch failure は強く出ているが、retained rollback text の local log persistence は見つかっていない。
- [x] `codex-restore-source-audit` の VS Code extension source facts に thread-stream patch path を追加した。実 bundle では owner が `thread-stream-state-changed` patches を broadcast し、follower が `handleThreadStreamStateChanged` 内で patches を会話 state に適用し、失敗時に `Failed to apply patches for` を log する経路が見える。実 current thread では `threadStreamPatchApplyPathPresent = true` かつ log patch failures `39` なので `vscodeThreadStreamPatchFailureSignal = true`。同一 thread repair の次の調査対象は VS Code reconnect / follower patch apply path。
- [x] `codex-restore-source-audit` の VS Code extension source facts に rollback non-resurrection projection candidate を追加した。削除だけでなく、`replacement_history` filter / tombstone、`restoreMessage` suppress / exclude / projection などの明示近傍 signal を別枠で拾う。実 current thread の再監査では extension reconnect / rollout-path resume / thread-stream patch path は引き続き見える一方、`VS Code rollback projection candidate: no`。つまり現 bundle からは、rollback 済み source を model-visible input から投影・隔離する明示経路は見つかっていない。
- [x] `codex-restore-smoke` の retained text match に JSON path と location kind を追加した。実 current thread の再確認では `expectedTurns = 20` / read-resume-list `20 / 20 / 20` で count は一致するが、retained rollback text 7 件は `thread_read` / `thread_resume` / `thread_turns_list` の `turns[1].items[*].aggregatedOutput` にあり、location kind は `aggregated_output`。これは user message field ではなく過去 tool/output aggregate に同文が引用されている evidence なので、同一 thread repair では `userMessage.text`、`replacement_history`、`aggregatedOutput` を分けて追う。
- [x] `codex-restore-smoke --inspect-risky-rollout` は retained text の location kind を blocking candidate と quoted/tool-output に分類する。direct turn text / `replacement_history` は `app-server-restore-text-retained`、`aggregatedOutput` のみなら `app-server-restore-text-quoted` として報告する。実 current thread の再監査では `expectedTurns = 29` / read-resume-list `29 / 29 / 29`、retained rollback text 7 件はすべて `aggregated_output` / `quoted_or_tool_output_context`、`blocking-candidates=no`。つまり app-server response 上の retained text は直接の user message 復活ではなく、過去 tool/output aggregate 内の引用として分類された。
- [x] `codex-rollback-model-visible-smoke` を追加した。`--prepare` は controlled marker user turn を start して rollback し、`--verify` は marker prefix だけを含む prompt でモデルに問い合わせる。full marker が返った場合だけ `reproduced`、明示 not-visible 応答なら `not-reproduced`。この smoke は current thread を mutate するため env opt-in 必須。
- [x] 2026-05-08 live current thread で controlled smoke を実行した。最初の run は prepare JSON と assistant 発言に full marker が漏れ、後続 verify がその leaked marker に反応したため汚染ありとして破棄。修正後、`--marker-file` と per-trial prefix で full marker を chat/tool output に出さない run を実施し、fresh app-server process の即時 verify は `status = not-reproduced` / `promptIncludesMarker = false` / `observedMarkers = []`。これは VS Code reload/reconnect 後 proof ではないが、少なくとも app-server process restart 境界では rollback 済み controlled user marker の model-visible reproduction は未再現。
- [x] VS Code reload/reconnect 後 verify 用の marker-file `.throughline-smoke/rollback-model-visible-after-restart.json` を作成し、restart 前 baseline verify も `not-reproduced` で固定した。`.throughline-smoke/` は secret marker を含むため `.gitignore` に追加済み。Windows 側 VS Code window に reload command を送り、その後 `--after-vscode-restart` 付き verify も `status = not-reproduced` / `promptIncludesMarker = false` / `observedMarkers = []`。controlled user marker の rollback 後 model-visible reproduction は、app-server process restart 境界でも VS Code reload/reconnect 境界でも未再現。

2026-05-06 監査結果:

- [x] 旧統合計画との関係を明確化した。この文書は今後の実装順を上書きし、旧計画は実装履歴と根拠として残す。
- [x] `codex-sidecar` と Codex CLI の役割を分離した。`codex-sidecar` は Claude primary からの review / risk-check / second opinion / 互換 L2 -> L1 経路、Codex CLI は Codex primary の L2 -> L1 本線 backend とする。
- [x] Codex primary の fallback 方針を固定した。Codex CLI backend が使えない場合、Codex primary は silent fallback せず明示 error にする。
- [x] Claude primary 保護条件を維持した。Claude hooks / `/tl` / baton / resume context は Codex 用に置き換えない。
- [x] Phase 0 実装時に、Codex primary session identity を実装前に再監査する。結論: `codex:<thread_id>` を Throughline DB の `session_id` / `origin_session_id` に使う。
