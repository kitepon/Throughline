# Codex自動新規タスク継続の一次ソース抜粋

- 出典: [Codex Hooks](https://learn.chatgpt.com/docs/hooks#precompact)、[Codex App Server](https://learn.chatgpt.com/docs/app-server#inject-items-into-a-thread)、[aiterm-steer-deliveryの配送実装](https://github.com/kitepon/aiterm-steer-delivery/blob/ad1aaf20f1c4ad49cdf6a9981f814f3a1f1dbbdb/src/codex-receiver.ts)
- 取得日: 2026-10-03
- 確度: 公式文書・固定commitのソース確認。ThroughlineからのDesktop実火・自動再開は未実測。
- 検討と検証手順: [自動新規タスク継続の設計案](../../../docs/05_codex_first_roadmap.md#自動新規タスク継続の設計案)

以下は出典の短い原文抜粋。実機成立の証拠ではない。

## Codex PreCompact

[公式仕様](https://learn.chatgpt.com/docs/hooks#precompact):

> If a matching `PreCompact` hook returns `continue: false`, Codex stops before compacting.

## Codex記憶注入

[公式仕様](https://learn.chatgpt.com/docs/app-server#inject-items-into-a-thread):

> Use `thread/inject_items` to append prebuilt Responses API items to a loaded thread's prompt history without starting a user turn.

## Codex継続指示の配送

[固定commitのsource](https://github.com/kitepon/aiterm-steer-delivery/blob/ad1aaf20f1c4ad49cdf6a9981f814f3a1f1dbbdb/src/codex-receiver.ts):

```typescript
const result = await request("thread/queue/add", {
  threadId: parent.thread_id,
  input: [{ type: "text", text, text_elements: [] }],
  clientUserMessageId: deliveryId,
});
```

公開contractは [README](https://github.com/kitepon/aiterm-steer-delivery/blob/ad1aaf20f1c4ad49cdf6a9981f814f3a1f1dbbdb/README.md#non-node-products) と
[エラーと配送状態](https://github.com/kitepon/aiterm-steer-delivery/blob/ad1aaf20f1c4ad49cdf6a9981f814f3a1f1dbbdb/README.md#errors-and-delivery-states) にある。
受付IDは配送要求の受付を示す。新規idleタスクを起動すること、
Desktopが実行を引き受けること、配送process終了後の継続は設計案の検証B〜Cで確認する。
