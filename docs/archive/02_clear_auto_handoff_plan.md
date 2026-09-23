# Throughline `/clear` 自動引継ぎ計画 (TODO 兼)

> **履歴:** v0.4系の実装計画と当時の検証記録。現行契約は
> [../02_clear_auto_handoff_plan.md](../02_clear_auto_handoff_plan.md) を参照する。

`/clear` をトリガーにした **自動かつ軽量な引継ぎ** を実現する計画。
2026-05-08 セッションの議論と実機検証、外部仕様調査に基づく。
A 案 (= /clear で自動引継ぎ + /tl は逃げ道として残す + /tl-trim 廃止) **採択確定**。

> 過去の経緯 (なぜ `/tl` バトンを採用したか) は [03_inheritance_on_clear_only.md](03_inheritance_on_clear_only.md) を参照。
> 本書は **2026-05-08 時点の現状検証 + 新理想設計** を扱う。

> **2026-05-09 (v0.4.1) update**: 2 経路の優先順位を **入れ替えた**。
> baton path が **primary**、auto path は **fallback**。理由: typed `/clear`
> は UserPromptSubmit に届くので baton 書き込みで確定的に当該セッションを
> 指名できる。一方 VSCode 拡張のメニュー由来 `/clear` は UserPromptSubmit
> に届かない (= `findLatestClaudePredecessor` heuristic が誤った前任を選ぶ
> リスクあり) ため、auto path を残してフォールバック化した。typed `/clear`
> も UserPromptSubmit hook で baton を書く ([src/prompt-submit.mjs](../../src/prompt-submit.mjs))。
> `THROUGHLINE_DISABLE_AUTO_HANDOFF=1` は **fallback path のみに作用** する
> ようになった (typed `/clear` / `/tl` には効かない)。

> **2026-08-17 (ADR 0021 / v0.10.0)**: 本書は Claude `/clear`・`/tl` の現行仕様である。
> Grok は UserPromptSubmit stdout をモデルへ渡さない。Grok `/tl` の記憶再開は
> `throughline grok-continue` であり、本書の「次セッション初回プロンプトで注入」を
> Grok に適用しない。正本は [ADR 0021](../adr/0021-grok-host-capture.md) と
> [plan_grok-successor-launch.md](plan_grok-successor-launch.md)。

> **2026-07-18 (ADR 0016) update**: 注入の中身を push/pull 二段に再設計した。
> push (9,500 字) はヘッダ + 現在地アンカー + 案内セクション + **L2 をターン原子で
> 入るだけ全文**（L1 は注入しない）。窓 20 ターンの残りは `throughline recall --l2`、
> それより古い全ターンは `recall --l1`（要約 or 未要約明示）で pull する。範囲・境界
> (ISO ms)・件数・session は注入時に案内コマンドへ焼き込み、recall 側は窓を再計算
> しない。正典は [ADR 0016](../adr/0016-push-pull-recall-injection.md)。本書内の
> 「L1 + L2 を注入する」旧記述はこの update で読み替えること。

---

## 1. 確定した事実 (実機検証済み)

### 1.1 `/clear` 後の SessionStart `source` は 2.1.128 で reliable

```
inheritance-decision.log (2026-05-08 12:26 検証)
  12:26:08.481Z  source="startup"   session=05735717  ← 新 chat 開始
  12:26:52.257Z  source="clear"     session=b2addc4a  ← /clear 後
```

- Claude Code `2.1.128` (VSCode native extension, Linux/WSL2) で `/clear` 後の SessionStart は **確実に `source='clear'`** を payload に乗せる
- 過去の [GitHub issue #49937](https://github.com/anthropics/claude-code/issues/49937) (= VSCode 拡張で /clear 後も `source='startup'` になっていたバグ) は **解決済み**
- v2.1.105 (VSCode `/clear` not clearing conversation context fix) と v2.1.126 (Windows SessionStart hook env files apply) のリリースで段階的に修正された

### 1.2 SessionStart `source` の 4 値 (公式 docs)

| 値 | 意味 |
|---|---|
| `startup` | 新 chat / VSCode 再起動 / 別 project / cold start |
| `resume` | `--resume` / `--continue` / `/resume` |
| `clear` | `/clear` 直後 |
| `compact` | 自動 / 手動 compaction 直後 |

source: [code.claude.com/docs/en/hooks](https://code.claude.com/docs/en/hooks)

### 1.3 `/clear` 等価の user-defined slash command は **作れない**

調査結果 (claude-code-guide Agent + bundled `claude-code` 検査):

- `.claude/commands/*.md` (skill markdown) は **prompt 拡張**であり、built-in `/clear` を programmatic に invoke できない
- "subcommand" や "exec built-in" 構文は無い
- `/clear` には built-in alias が存在しない
- CLI flag `claude clear` も無い
- cross-platform で「新ウィンドウ起動」する built-in も無い (`/branch` は full history copy で軽量化と矛盾、VSCode URL scheme は VSCode 専用)

→ **「引継ぎたい /clear」と「reset したい /clear」を `source` 値で区別する手段は無い**

### 1.4 `/rewind` は fork 動作 (caveat 記録済み)

- `/rewind` Continue 確認画面に "A new forked conversation will be created after rewinding" と明示
- 同 thread 内 rollback ではなく、新 fork session id を生成
- 詳細は caveat `claude-code/claude-code-rewind-fork-conversation-rollback-primitive` を参照
- 本計画では `/rewind` は **対象外**

---

## 2. 採用する理想設計

### 2.1 引継ぎ発火条件 (2 経路 × 二相、ADR 0014 で二相化)

| 経路 | 条件 | 起動 |
|---|---|---|
| **baton path (primary)** | `handoff_batons` テーブルに「セッション誕生時刻基準で TTL (1 時間) 内」の baton あり (= ユーザーが `/tl` または `/clear` を打った) | `source` 値関係なく確定的に引継ぎ |
| **auto path (fallback)** | baton 不在 + `source='clear'` + env `THROUGHLINE_DISABLE_AUTO_HANDOFF` が `'1'` でない | SessionStart 時点で凍結した前任 (transcript 実在フィルタ付き heuristic) へ引継ぎ |

**二相化の理由 (ADR 0014)**: Claude Code は同一 project に短時間で複数の SessionStart を
発火させることがあり、一部は transcript を生成しない幽霊になる。SessionStart 時点では
実体と幽霊を判別できない (本物の transcript も hook より数百 ms 遅れて作られる) ため、
merge・注入は「実体の証明」= 最初の UserPromptSubmit まで遅延する。
2026-07-17 に幽霊がバトンを先取りして実セッションが記憶ゼロで始まる incident が
同日 2 回発生した (詳細・実測は [ADR 0014](../adr/0014-two-phase-handoff-ghost-baton.md))。

判定ロジック (擬似コード):

```
on UserPromptSubmit(prompt, session_id, project_path):
  // ---- 第二相: 初回プロンプト = 実体の証明 ----
  pending = consumePendingHandoff(session_id)   // atomic、1 セッション 1 回
  if pending:
    baton = consumeBaton(project_path, bornAt = pending.created_at)
      // age = bornAt - baton.created_at。0 ≤ age ≤ TTL のみ消費。
      // age < 0 (自分の誕生後に書かれた baton) は本来の後継のため残置
    if baton.sessionId:
      merge + inject(budgeted_memory_from(baton.sessionId))   // baton path
    elif pending.auto_predecessor_id:
      merge + inject(budgeted_memory_from(pending.auto_predecessor_id))  // auto path
  // ---- 従来のバトン書き込み (第二相の後) ----
  if isBatonCommand(prompt) or isClearCommand(prompt):
    writeBaton(project_path, session_id, now)

on SessionStart(source, session_id, project_path):
  // ---- 第一相: intent 登録のみ。merge も注入もしない ----
  auto_predecessor = null
  if source == 'clear' and env.THROUGHLINE_DISABLE_AUTO_HANDOFF != '1':
    auto_predecessor = findLatestClaudePredecessor(project_path, session_id)
      // transcript 実在フィルタ付き: 幽霊 twin (transcript 無し) を前任に選ばない
  registerPendingHandoff(session_id, project_path, source, auto_predecessor)
```

baton 消費が auto 判定より先発なので「両方同時成立」は構造上発生しない。typed `/clear` も
UserPromptSubmit hook で baton を書くため、通常はほぼ常に baton path が走る。auto path は
VSCode 拡張のメニュー由来 `/clear` のように UserPromptSubmit に届かない経路のためのフォールバック。
幽霊セッションはプロンプトを発火しないため第二相に到達できず、pending 行 (数百バイト) が
無害に残るだけになる。TTL ベースの pending GC は置かない (長時間 idle 後の初回プロンプトから
引継ぎを silent に奪う fallback になるため)。

### 2.2 注入内容: 現在地アンカー + L1 + L2 + L3 refs (baton/auto どちらの経路でも同一)

含める (順序):
- ヘッダ + Reading Contract framing (= Codex 側 `renderCodexRolloutMemoryPreview` の写像)
- **現在地アンカー** (v0.4.12+): 最新 user turn と最新 assistant turn の本文をヘッダ直下に再掲 (各 600 字で truncate)
- **L1 summaries** (古い turn の一行要約)
- **L2 bodies** (直近 20 turn の verbatim)
- **L3 references** (= `throughline detail <時刻>` の取り出しコマンド一覧、各 L1/L2 行末尾の inline suffix として集約)
- Continuation Instruction (= 「これは過去ログではなく現在進行中の作業」と明示)

**注入予算 (ADR 0014)**: hook stdout は約 10,000 字超で `<persisted-output>`
(ファイルパス + 先頭 2KB preview) に file 化され、モデル可視が先頭 2KB に劣化する
(実測: 9,501 字 inline 通過 / 15,286 字 file 化。v2.1.195 以降の 10k 超注入 12/12 が劣化)。
注入は `buildBudgetedResumeContext` (上限 9,500 字) で行い、ヘッダ + アンカーは常に全文、
L1 → L2 の順に新しい側から予算まで詰める。省略行数は注入文内と decision log に明示する。

含めない (= 削除):
- 中断直前の in-flight memo (memo セクション)
- 中断直前の thinking (extended thinking セクション)
- 既存の Claude 向け footer の冗長な使い方説明

理由:
- L2 末尾アンカーだけだと、L2 が長いセッションで注意が前半 (= L2 内の最古ターン) に固着し、古い計画ターンを「現在の作業」と誤認するケースがあった (実観測あり)。最新ターンをヘッダ直下にも再掲して、最初に目に入る位置で文脈を固定する。
- L2 全文があれば最後の assistant turn 自体に「次に何をしようとしていたか」が含まれている。memo / thinking は redundant。

### 2.3 `/tl` の役割: **残すが簡素化**

- `/tl` slash command 自体は **維持** (= 明示意思マーカー = baton path のトリガー)
- 簡素化:
  - memo 4 項目入力要求を **削除** ([.claude/commands/tl.md](../../.claude/commands/tl.md) を「baton 立てるだけ」の最小実装に)
  - `save-inflight` CLI を **削除** (memo を baton.memo_text に保存する役目だった)
  - `handoff_batons.memo_text` 列を **drop** (schema v8 migration)
  - `src/baton.mjs` の `updateBatonMemo` 関数を **削除** (memo_text 列が drop されるため)
- `prompt-submit.mjs` の baton 書き込み path は **維持** (`UserPromptSubmit` hook で `/tl` 検出 + writeBaton)
- v0.4.1 で `/clear` も同じ hook で baton を書くように拡張 ([src/prompt-submit.mjs](../../src/prompt-submit.mjs) `isClearCommand`)

ユーザーから見た `/tl` の使い方:
- typed `/clear` (デフォルト): `/clear` を打った時点で baton が書かれ、次セッションが確定的に引継ぐ。`/tl` を打つ必要なし
- VSCode メニュー `/clear` 経由: UserPromptSubmit に届かないので baton は書かれず、auto path (fallback) が `findLatestClaudePredecessor` で前任を選ぶ
- 非 `/clear` 境界 (新規 chat / VSCode 再起動): `/tl` で baton を立ててから新セッションを開く
- env で auto OFF: typed `/clear` / `/tl` は引き続き動く (env は fallback 専用)

### 2.4 `/tl-trim` 廃止 (Codex 側を壊さない)

- 元機能: memo 入力 + dry-run preview 表示
- 新仕様で memo 廃止 + 軽量化方針 → 役割なし
- 削除対象:
  - `.claude/commands/tl-trim.md` (deleted slash command)
  - [src/cli/trim.mjs](../../src/cli/trim.mjs) の **Claude path 部分のみ** 削除 (`describeTrimHost('claude')` ブランチ、Claude 用 memory preview 経路など)
  - 関連 test
- **維持** (Codex 側を壊さないため):
  - [src/cli/trim.mjs](../../src/cli/trim.mjs) の Codex path (`--host codex`, `--codex-thread-id`, `--preflight`, `--execute`, etc.) はすべて維持
  - [src/trim-model.mjs](../../src/trim-model.mjs) の `describeTrimHost('codex')` / `buildTrimPlan` の Codex 関連
  - [src/codex-app-server.mjs](../../src/codex-app-server.mjs), [src/codex-rollout-memory.mjs](../../src/codex-rollout-memory.mjs), `codex-*` CLI 全般
  - `bin/throughline.mjs` の `trim` dispatch (Codex 経路で必要)
  - Codex skill ([codex/skills/throughline](../../codex/skills/throughline)) の trim 機能 (= 機能自体は無変更、SKILL.md 内の `/tl-trim` 言及があれば 4 TODO で update)

### 2.5 `THROUGHLINE_DISABLE_AUTO_HANDOFF` env var

- 値が `'1'` のとき auto path を skip
- それ以外の値、または未設定 → auto path 有効 (= デフォルト ON)
- 判定箇所: [src/session-start.mjs](../../src/session-start.mjs)
- 設定方法: ユーザーが `.bashrc` / `.zshrc` / VSCode terminal env / `~/.claude/settings.json` の `env` セクションで設定

### 2.6 トレードオフ (受容する)

- ⚠️ 「reset したい /clear」も auto path で引継ぎ発火する → 受容 (= 不要なら env で OFF)
- ⚠️ baton TTL は 1 時間 (= 既存仕様維持)

---

## 3. 確定した内部判断

### 3.1 `/rewind` source 検証 — 不要

A 採択により本計画は `/rewind` を扱わない。`/rewind` 後の `source` 値は将来要件で再検討。

### 3.2 `handoff_batons` テーブル — 残す + memo_text 列だけ drop

- table 自体は baton path で必要なので **維持**
- `memo_text TEXT` 列を schema v8 migration で drop
- 既存の memo データは廃棄 (受容)
- **SQLite DROP COLUMN 互換確認必須**: `ALTER TABLE ... DROP COLUMN` は SQLite 3.35.0+ で利用可。Node.js v22.5+ 同梱の SQLite バージョンで動作するか実装時に検証

### 3.3 旧 `/tl` ユーザー移行 — `/tl` 自体は continue、memo 関連だけ breaking

- `/tl` slash command 自体は使い続けられる (簡素化されただけ)
- 廃止される機能: memo 4 項目入力、`save-inflight` CLI、`/tl-trim`
- breaking change として CHANGELOG に明示

### 3.4 `source='compact'` 扱い — 引継ぎしない

auto-compaction は Claude Code 内部の context 圧縮で、conversation 連続性は host 側が担保している。Throughline 側で別途引継ぎを発火する必要なし。

### 3.5 ログファイルの扱い

- `~/.throughline/logs/inflight-memo.log`: `save-inflight` CLI 削除で **新規書き込みなし**。既存ファイルは削除提案を README / CHANGELOG に書く (= 自動削除はしない、ユーザー手動)
- `~/.throughline/logs/inheritance-decision.log` 内の `baton_has_memo` フィールド: memo 廃止で意味を失うため、`logDecision()` から **削除**
- `~/.throughline/logs/baton-write.log`: 維持 (= `/tl` baton 書き込みログとして引き続き有用)

---

## 4. 実装 TODO (実装開始可)

優先度順:

- [ ] **schema v8 migration** ([src/db.mjs](../../src/db.mjs)): `ALTER TABLE handoff_batons DROP COLUMN memo_text`
  - SQLite 3.35.0+ サポート確認 (Node.js v22.5+ 同梱版)
  - 動かない場合は `CREATE TABLE` + `INSERT SELECT` + `DROP` の rebuild migration に切り替え
- [ ] **`src/baton.mjs`**:
  - `consumeBaton` 戻り値から `memoText` プロパティを削除
  - `updateBatonMemo` 関数を **削除**
  - `BATON_TTL_MS`, `writeBaton`, `consumeBaton` は維持
- [x] **`src/handoff-record.mjs`**: **維持** (Codex 側 codex-handoff.mjs / codex-resume / codex-handoff-smoke 等が `memory.inflightMemo` / `memory.latestThinking` を参照しているため、削除すると Codex を壊す)。Claude 側で「使わない」のは resume-context.mjs 側で実現済み
- [ ] **`src/resume-context.mjs`**: 注入テキストを新仕様に書き換え:
  - memo セクション削除
  - thinking セクション削除
  - L3 references 一覧追加 (Codex `renderCodexRolloutMemoryPreview` 形式)
  - footer 簡素化 (Continuation Instruction だけ残す)
- [ ] **`src/session-start.mjs`** を 2.1 のロジックに改修:
  - `consumeBaton` 先発 → `baton.sessionId` あれば inject
  - 無ければ `source==='clear'` かつ env が `'1'` でない場合に inject
  - それ以外は何もしない
  - `logDecision()` から `baton_has_memo` フィールド削除
- [ ] **`src/cli/save-inflight.mjs`** 削除
- [ ] **`bin/throughline.mjs`** の `save-inflight` dispatch 削除 (`trim` dispatch は **維持**)
- [ ] **`src/prompt-submit.mjs`**: 維持 (baton 書き込み + ensureMonitorTaskFile)
- [ ] **[.claude/commands/tl.md](../../.claude/commands/tl.md)**: memo 4 項目入力要求を削除、純粋に「baton 立てるだけ」の最小実装に書き換え
- [x] **`/tl-trim` 関連削除**:
  - `.claude/commands/tl-trim.md` ファイル削除
  - **`src/cli/trim.mjs` 自体は維持**: Codex 経路 (`--host codex`, `--preflight`, `--execute`, `--codex-app-server-bin` 等) と doctor `--trim --host claude` で使う `describeTrimHost('claude')` の dry-run 表示が依存しているため、コード削除はしない (= ユーザーが直接 `throughline trim --host claude --dry-run` を打つ余地は残す。実用は SessionStart 自動経路に置き換わる)
- [ ] **[src/cli/install.mjs](../../src/cli/install.mjs)**: Throughline 管理 slash commands の copy 対象リストから `tl-trim.md` を除外。`tl.md` は維持。`src/cli/install.test.mjs` の関連 test も update
- [ ] **[bin/throughline.mjs](../../bin/throughline.mjs) の `showHelp()` 文言 update**:
  - `save-inflight` 関連 help 文言を削除
  - `/tl-trim` / Claude trim 関連の help 文言を削除
  - Codex trim 関連 (`trim --dry-run`, `--preflight`, `--execute --host codex` など) は **維持**
  - `bin/throughline.mjs` の `save-inflight` dispatch case 削除 (上の TODO と重複するが help text だけ別作業)
- [ ] **[codex/skills/throughline/SKILL.md](../../codex/skills/throughline/SKILL.md)**: `/tl-trim` への言及があれば削除し、`throughline trim --execute --host codex` 直接呼び出しに統一。Codex 側 trim 案内自体は維持
- [ ] **当時の`.codex-sidecar.yml`** 確認: `/tl-trim` / `save-inflight` 経路の参照があれば削除。無ければ no-op
- [ ] **テスト全部更新**:
  - `src/baton.test.mjs` → memo 関連 test 削除、`updateBatonMemo` test 削除
  - `src/session-merger.test.mjs` → source='clear' 自動経路の test 追加
  - `src/resume-context.test.mjs` → memo/thinking 削除を反映
  - `src/handoff-record.test.mjs` → projection 簡素化
  - `src/hook-entrypoints.test.mjs` → save-inflight subprocess test ケース削除 (= 独立ファイルではなく本ファイル内の test)
  - `src/turn-processor.test.mjs` → 既存維持
  - `src/trim-cli.test.mjs` / `src/trim-model.test.mjs` → Claude path 関連テストのみ削除、Codex 経路テストは維持
  - 新規: env var 判定 test、source='clear' auto path test
- [ ] **docs 更新**:
  - [CLAUDE.md](https://github.com/kitepon/Throughline/blob/main/CLAUDE.md): 設計の核を書き換え (「`/tl` バトンのみ」→「`source='clear'` 自動 + `/tl` 逃げ道」)
  - [README.md](../../README.md): 以下範囲を update:
    - Quick Start: 「`/clear` で自動引継ぎ」中心に書き直し
    - 「Explicit handoff via `/tl`」セクション: `save-inflight` / memo 4 項目要求の記述を削除、`/tl` は逃げ道として簡素な記述に
    - Troubleshoot / How it compares 等の他セクション: `/tl-trim`, `save-inflight`, `inflight-memo.log` への言及をすべて削除
    - `THROUGHLINE_DISABLE_AUTO_HANDOFF` env var 紹介を新規追加
    - 既存 `inflight-memo.log` ファイルは新版で書き込み停止することを README で告知 (= 手動削除提案)
  - [CHANGELOG.md](../../CHANGELOG.md): breaking change を明示 (memo 廃止、save-inflight 削除、/tl-trim 削除、`updateBatonMemo` 削除、baton_has_memo フィールド削除)
  - [03_inheritance_on_clear_only.md](03_inheritance_on_clear_only.md): 「2026-04 段階の検証 → 2026-05 でバグ修正により案 A 成立、本書は履歴扱い」note 追加
  - [04_public_release_plan.md](../04_public_release_plan.md): version bump + breaking change 反映
- [ ] **package.json**: **0.4.0** に bump (semver minor、pre-1.0 の breaking)
- [ ] **caveat 記録**: 「`/clear` SessionStart `source` は 2.1.128 で reliable、過去 #49937 は fix 済み」を public で記録

---

## 5. 削減できるコード規模 (見積もり)

廃止対象:
- `src/cli/save-inflight.mjs` (~80 行) → 削除
- `src/cli/trim.mjs` の Claude path 部分 (~30 行) → 削除 (Codex path は維持)
- `.claude/commands/tl-trim.md` (~40 行) → 削除
- `src/baton.mjs` の `updateBatonMemo` 関数 (~10 行) → 削除
- `handoff_batons.memo_text` 列 (schema migration、コードへの影響は consumeBaton 戻り値変更のみ)
- `src/hook-entrypoints.test.mjs` 内 save-inflight test ケース (~30 行) → 削除
- `resume-context.mjs` の memo/thinking セクション (~30 行) → 削除
- `handoff-record.mjs` の memo/thinking projection (~50 行) → 削除
- [.claude/commands/tl.md](../../.claude/commands/tl.md) の memo 4 項目要求 (~20 行) → 削除

代わりに追加:
- `session-start.mjs` の env / source 判定 (~15 行)
- `resume-context.mjs` の L3 refs framing (~30 行)

純減 ~245 行。

---

## 6. Codex 側との整合 (壊さない)

Codex 側 v0.3.25 の以下は本計画で **完全に無変更**:

- `codex-capture` / `codex-summarize` / `codex-resume` (Codex primary L1/L2/L3 path)
- `codex-resume --format handoff` (新規 Codex thread 用 prompt)
- `trim --execute --host codex` / `--preflight --host codex` (app-server `thread/rollback` + `thread/inject_items`)
- Codex Stop hook 75% auto-refresh
- restore-safety / host primitive audit diagnostics
- Codex skill ([codex/skills/throughline](../../codex/skills/throughline)) の trim 機能 (= 機能自体は無変更、SKILL.md 内の `/tl-trim` 言及があれば 4 TODO で update)
- [src/codex-app-server.mjs](../../src/codex-app-server.mjs), [src/codex-rollout-memory.mjs](../../src/codex-rollout-memory.mjs)
- [src/trim-model.mjs](../../src/trim-model.mjs) の Codex 関連 (`describeTrimHost('codex')`, `buildTrimPlan` の Codex source path)

`codex-resume --memo-stdin` は引き続きユーザーが stdin で memo を流す経路。Throughline DB の baton.memo_text には依存していない (= 列削除の影響なし)。

`/tl-trim` 削除に伴って Codex 経由でも slash command としての `/tl-trim` は使えなくなる。Codex 用 trim は `throughline trim --execute --host codex` を **CLI 直接呼ぶ**運用に統一 (Codex skill SKILL.md がそれを案内する)。

---

## 7. 進め方

1. **本計画 確定** (ユーザー A 採択済み、本書 update により方針固定)
2. **実装** (上記 TODO 順)
3. **テスト + 実機 smoke + commit**
4. **publish** (npm 0.4.0 として release)

実機 smoke 手順:
- 自動引継ぎ ON (デフォルト): /clear → 新セッションで curated memory 注入を確認
- 自動引継ぎ OFF: env を立てて /clear → 注入されないことを確認
- baton path: `/tl` を打って新 chat タブで開く → baton 経由で注入を確認
- Codex 側 regression: `npm test` で既存 Codex test がすべて pass することを確認、`throughline trim --execute --host codex` の CLI 動作も維持
