# Codex自動新規タスク継続の一次ソース抜粋

- 出典: [Codex Hooks](https://learn.chatgpt.com/docs/hooks#precompact)、[Codex App Server](https://learn.chatgpt.com/docs/app-server#inject-items-into-a-thread)、[aiterm-steer-deliveryの配送実装](https://github.com/kitepon/aiterm-steer-delivery/blob/ad1aaf20f1c4ad49cdf6a9981f814f3a1f1dbbdb/src/codex-receiver.ts)
- 取得日: 2026-10-03
- 確度: 公式文書・固定commitのソース確認。実火・自動再開の確度は[独立した実測記録](https://github.com/kitepon/Throughline/blob/main/evidence/2026-10-03-codex-auto-continuation.md)を参照する。
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
受付IDは配送要求の受付を示す。新規idleタスクの自動開始と配送process終了後の継続は
[検証B〜C](https://github.com/kitepon/Throughline/blob/main/evidence/2026-10-03-codex-auto-continuation.md)で実測した。
この一次ソース抜粋自体を実測証拠として扱わず、設計案の合格条件と記録を照合する。

## 製品統合で照合したhost記録

- Desktopの最新`thread_settings_applied`と実行turnの`turn_context`を合わせて実効設定を取る。作成processがwriterを持つ間に`thread/settings/update`の確定値を保存し、表示後の値と比較する。
- collaboration modeの`developer_instructions=null`は標準指示の選択で、公式APIが本文へ展開する。展開後の値は表示前に固定し、表示後の変更を正当化するために読み替えない。
- `task_started`からユーザー本文の永続化まで時間差があった。入力が保存される前の開始eventだけで別入力の混入を断定しない。
- 自動圧縮がターン開始前に発火した時、新しいuser本文は`response_item`にあり、対応する`turn_context`と`event_msg.user_message`はまだ無かった。
- Desktopの`custom_tool_call`と`custom_tool_call_output`もL3保存の対象とする。詳細は凍結した元operation/origin/turnへ束縛する。

上記は[製品統合の実測](https://github.com/kitepon/Throughline/blob/main/evidence/2026-10-03-codex-auto-continuation.md#製品統合の受入d)と対で扱う。
