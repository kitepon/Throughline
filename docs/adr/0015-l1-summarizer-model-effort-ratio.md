# ADR 0015: L1 要約の既定を gpt-5.6-luna / effort low / 削減割合 1/5 にする

日付: 2026-07-17

## Status

Accepted（実装済み・全テスト green。実運用での要約品質の継続観察は運用に委ねる）。

## Context

- オーナー方針: 裏方で動く AI は Codex に寄せる。GPT-5.6 系列（sol / terra / luna）の
  登場を受け、コスト効率を含めてモデルを選定する。要約の目標量は文字数指定ではなく
  **削減割合**で決めたい（割合はオーナーが設定で動かせること）。
- 現行実装の問題: `summarizeWithCodexCli` は isolation のため `--ignore-user-config` で
  `codex exec` を呼ぶが、これにより `~/.codex/config.toml` のモデル選択も読まれず、
  **CLI 内蔵デフォルトで走っていた**（明示 `-m` なし）。
- 基準線: 現行 Claude Haiku 経路は削減割合 1/5（`l2Text.length / 5` を「約N文字」に
  換算してプロンプトへ渡す割合ベース。docs の「L1 = one-liner」記述は実装と乖離）。

## 実測評価（2026-07-17、このMac）

方法: 実 DB の L2 ターンをソースに、本番と同型のプロンプト・`codex exec` flag で要約を
生成。**要約を見る前に**各ソースから要点チェックリスト（固有名詞・数値・因果・決定・
未解決）を作成し、要約ごとの「要点拾い数」で採点。原文に無い内容の混入（捏造）は別枠で
全数検査。判定者は親セッション（単一判定者、n は下記のとおり＝既定値選定には十分、
論文品質ではない）。

### Round 1: モデル × 削減割合（5ソース × 7構成 = 35ラン）

| 構成 | 拾い率 | 備考 |
|---|---|---|
| Haiku@1/5（現行基準線） | 26/35 = 74%（timeout 1件込み。完走分のみ 93%） | **5本中1本が90秒 timeout で完全失敗**。本番はリトライ後 raw L2 fallback = 実質無圧縮 |
| luna@1/5 | 32/35 = 91% | 6〜16秒 |
| luna@1/10 | 80% / luna@1/15 | 64% |
| terra@1/5 | 32.5/35 = 93% | luna+2%のために上位量を払う価値なし |
| terra@1/10 | 73% / terra@1/15 | 60% |

**結論1: 圧縮を 1/5 より強めると要点が死ぬ（93%→73〜80%）。モデルを賢くしても
救えない＝情報量の物理であり、既定割合は 1/5 のまま。**

### Round 2: luna の effort 比較（8ソース × {none, low, medium} × 2反復 = 48ラン）

ソースは別プロジェクト由来3本（Caveat 技術報告 / OpenCClaw 指示書散文 / 6.2k字
subagent 報告）を追加。`minimal` は luna 非対応（400 error。サポートは
none/low/medium/high/xhigh）のため none を下端とした。

| effort | 拾い率 | 中央値レイテンシ | 特徴的な欠落 |
|---|---|---|---|
| none | 103/116 = 89% | 11.8s | **物語の現在地を落とす**（親の裁定で再開済み→「裁定待ち」と書く ×2、設計矛盾の同型性、「効果検証はこれから」） |
| **low** | **107.5/116 = 93%** | 12.4s | 最もバランス。反復ブレ ±1〜2項目 |
| medium | 107.5/116 = 93% | 16.3s | low と同点。**事故の白状を2回とも落とした**（整理しすぎて都合の悪い脱線を刈る傾向） |

捏造は Round 1+2 の全 82 有効ランで 0 件。

**結論2: low が既定。medium は同点で 1.4 倍遅くコスト高。none は事実の羅列は拾えるが
「誰が何を決めて今どこか」を落とし、再開用 L1 として痛い欠落をする。**

## Decision

1. **既定: `gpt-5.6-luna` / `model_reasoning_effort="low"` / 削減割合 0.2 (=1/5)**。
2. `summarizeWithCodexCli` は明示 `-m` / `-c model_reasoning_effort=...` を渡す
   （`--ignore-user-config` によるモデル未指定の穴を修理）。
3. env で設定可能: `THROUGHLINE_L1_MODEL` / `THROUGHLINE_L1_EFFORT` /
   `THROUGHLINE_L1_RATIO`（割合形式 0 < r ≤ 1）。**不正な RATIO は黙って既定へ
   落とさず explicit error**（フォールバック禁止原則）。
4. claude-primary の backend 順序を **codex-sidecar → Codex CLI (luna@low) → Haiku →
   raw L2** にする。各段の失敗理由は結果 (`sidecarReason` / `codexCliReason`) に記録
   する宣言済み fallback。codex-primary は従来どおり Codex CLI 一本で explicit error。
   （2026-10-04 [ADR 0028](0028-l1-summarizer-backend-failure-code.md)で、この explicit error を runtime error store では
   `L1_SUMMARIZER_BACKEND_FAILED` として数えることにした。hook の終了 code と stderr は変えていない。）
   （実測で Haiku は timeout 完全失敗があり、luna は同等品質・半分以下のレイテンシ・
   失敗ゼロのため、Haiku より先に置く。）
5. sidecar `summarize-l1` preset のモデルは codex-sidecar（別repo）の所有。本 ADR では
   変更しない。
6. docs の「L1 = one-liner」記述は「割合ベース（既定 1/5）」へ修正する。

## Acceptance

- `npm test` 684/685 PASS（1 skip は既存 win32 契約）。
- 新規テスト: 明示 `-m`/effort 引数、env 上書き、RATIO のプロンプト反映、不正 RATIO の
  explicit error、claude-primary の sidecar→codex-cli→haiku 梯子。
- 評価の生データ: 実測スクリプト・全要約・採点はセッション scratchpad（使い捨て）。
  要旨は本 ADR の表が正本。
