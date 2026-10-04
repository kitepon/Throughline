# Throughline handoff 現行契約

この文書は Claude Code の `/clear` と、各 host の `/tl` による現行 handoff 契約を
まとめる。v0.4 系の実装計画と当時の TODO は
[archive/02_clear_auto_handoff_plan.md](archive/02_clear_auto_handoff_plan.md) に移した。

## 発火条件

| 操作 | 現行挙動 |
|---|---|
| `/tl` | `UserPromptSubmit` が現在の session id を baton として保存する。次の実セッションがその前任を確定的に引き継ぐ |
| VS Code の `/clear` | 組み込みコマンドは `UserPromptSubmit` に届かない。`SessionStart source='clear'` を使う auto path が、同じ project の直近前任を凍結して引き継ぐ |
| Claude Desktop の `/clear` | `UserPromptSubmit` に届かず、`SessionStart source='clear'` も来ないため自動継承しない。続ける場合は `/clear` の前に `/tl` を実行する |
| Claude Code の自動圧縮 | `auto-handoff enable --host claude` で有効にした時だけ、`PreCompact`（`trigger: auto`）が圧縮を止めて `/tl` と同じ印を残し、`PreToolUse` が旧い会話を止める。Throughline が `claude --bg` で新しい会話を立て、継続の指示を1通送る。その指示の `UserPromptSubmit` が印を消費して記憶を注入する。既定は無効。手動 `/compact` は対象外。正本は [ADR 0033](adr/0033-claude-auto-handoff-new-session.md) |

`/clear` が `UserPromptSubmit` に届かないことは、VS Code と Desktop の対照実測で
確定している。`prompt-submit` に残る `/clear` 分岐は host が将来その文字列を渡した場合の
互換処理であり、現在の利用者向け発火経路として案内しない。実測と Desktop の制約は
[archive docs 12](archive/12_desktop_clear_handoff_plan.md) を参照する。

`THROUGHLINE_DISABLE_AUTO_HANDOFF=1` は `source='clear'` を使う auto path だけを止める。
明示 `/tl` の baton は止めない。

## 二相 handoff

1. `SessionStart` は `pending_handoffs` に intent を登録するだけで、merge も注入もしない。
2. 次の最初の `UserPromptSubmit` が実セッションの存在証明となり、pending intent を一度だけ消費する。
3. 適格な baton があればその session id を優先する。baton が無く、`source='clear'` の
   auto predecessor があれば、その前任を使う。
4. 前任 transcript を backfill してから merge し、予算内の再開文脈を注入する。

この順序により、transcript を作らない幽霊 SessionStart が baton を先取りしない。
baton の適格性は新セッション誕生時刻を基準に
`0 ≤ bornAt - baton.created_at ≤ 1 hour` で判定する。詳細は
[ADR 0014](adr/0014-two-phase-handoff-ghost-baton.md) が正である。

## 注入内容

baton path と auto path は同じ `buildBudgetedResumeContext` を使う。注入上限は9,500字で、
現在地アンカー、取得案内、予算に入る直近L2ターン全文を含む。L1は直接注入せず、
`throughline recall --l2` / `throughline recall --l1` で必要時に取得する。L3は
`throughline detail <time>` で参照する。正本は
[ADR 0016](adr/0016-push-pull-recall-injection.md) である。

## host 別境界

- Claude Code: VS Code `/clear` は auto path、Desktop `/clear` は `/tl` 併用。自動圧縮は、有効にした時だけ、圧縮を止めて新しい会話へ引き継ぐ（ADR 0033）。
- Grok: `/tl` の baton 成功後に `throughline grok-continue --session <id>` で後継席を
  起動する。`/clear` では起動しない。正本は [ADR 0021](adr/0021-grok-host-capture.md)。
- Cursor: `/tl` は baton を残すが後継会話を自動起動しない。次の会話が baton を消費する。
  正本は [ADR 0022](adr/0022-cursor-host-capture.md)。

利用者向けの導入・設定・診断・復旧は [README.md](../README.md) と
[README.ja.md](../README.ja.md) を正とする。
