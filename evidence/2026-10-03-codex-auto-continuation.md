# Codex自動新規タスク継続の成立検証

- 実測日: 2026-10-03（Asia/Tokyo）
- 状態: **圧縮前停止・新規タスクへの自動開始・配送process終了後の継続は合格。製品の自動引き継ぎは未実装。**
- 対象と版・model・effort: [実測JSON](codex-auto-continuation/2026-10-03-results.json)を正とする。
- 実行した試験source: [保存source](codex-auto-continuation/2026-10-03-probe-source.mjs)
- 設計: [自動新規タスク継続](../docs/05_codex_first_roadmap.md#自動新規タスク継続の設計案)

## 判定

`aiterm-steer-delivery`を、新規タスクへの継続指示の配送に採用する。
実認証済みのCodex Desktopで、合成記憶を注入した未実行タスクを開き、
公開APIの `verifyCodexParent` / `submitCodexParentAnswer` から一度だけ指示を送った。
Desktopは人の追加promptなしで作業を開始し、配送process終了後に成果物を生成した。
配送用のSteer hook・channel・MCPサーバーは追加していない。

| 検証 | 判定 | 実測 |
|---|---|---|
| A: 圧縮前停止 | 合格 | 正規承認済み `PreCompact(auto)` が発火。返答は `continue:false`。同じturnに `turn_aborted(reason=interrupted)` が記録され、圧縮記録は0件。最初の操作だけ完了し、二番目の操作は未実行 |
| B: 新規タスクの自動開始 | 合格 | developer記憶にだけ入れた試験値を、queue指示で開始した新規タスクが3つのJSONファイルへ正しく記録。queue残数0、turnはcompleted |
| C: 配送process終了後の継続 | 合格 | 配送処理が返った約24.6秒後に最初、約42.1秒後に二番目と検証結果のファイルが生成された。送信processの終了も確認 |

B/Cの開始から完了までは一つのturnである。
試験値はuser指示へ含めず、生成した3ファイルすべてで注入した値と一致した。
新しいタスクの開始を確認するために人が「続けて」と入力する操作は行っていない。
Desktopの画面確認にはJev Desktopを使い、ユーザーが示した画面でも完了応答を確認した。

Aは試験projectだけ `model_auto_compact_token_limit=8192` に設定した。
実際のモデル要求のinputは40,915 tokens、報告されたcontext windowは828,400 tokens。
閾値を下げて公式のauto経路を実火させた確認であり、
既定閾値までの長時間作業や容量上限の受入証拠ではない。
manual compact、hook関数の直接実行、偽のhook payloadは使っていない。

## 設計へ反映する観測

1. **停止の証拠は実際のhost/rolloutへ束縛する。**
   B/Cが進行中の時、別app-serverの `thread/read` はturnをinterrupted、
   threadをnotLoadedとして返した。その後同じturnはDesktopでcompletedになった。
   途中のcold readだけで旧タスクの停止を確定しない。
   Aではhookのsession/turn、hook返答、同じturnの永続 `turn_aborted` を照合した。

2. **作成後、記憶注入を確定してから作成processを閉じる。**
   Aの初回準備では記憶もuser turnも無い空タスクを作って接続を閉じ、
   rolloutが0件のまま後続要求が `thread not loaded` で拒否された。
   sourceを修正してdeveloper記憶の注入を加えた後、通常のDesktop経路でAを完了した。
   この初回は準備失敗であり、Aの不合格や配送の結果不明として数えていない。

3. **設定継承は表示後も確認する。**
   B/C・Aとも作成時のsandboxはworkspace-writeだったが、Desktopで実行するturnは
   アプリ設定のdanger-full-accessへ更新された。model、effort、approval policyは保持された。
   作成応答だけで権限継承を合格にしない。実効設定を保持する手段は次工程で確定する。

## 試験設定と後片付け

試験用の一時projectと試験ファイルだけを操作した。
通常のCodex homeでDesktopとの共有storeを使い、試験projectの設定から
他のMCPとhookを無効にしてPreCompactの因果を限定した。
試験projectのtrustと、試験用hookのcurrentHashの承認は公式 `config/batchWrite` で登録した。
hook trustのbypassは使っていない。

設定変更前に `config.toml` と `hooks.json` を非公開のtarへbackupした。
終了後は試験projectと試験hookの設定sectionだけを公式APIで削除した。
backupとの比較で、user configは意味的に一致し、通常hooks.jsonはbyte単位で一致した。
credentials、設定backup、完全なrollout、他のチャットを含む画面画像は公開証拠へ含めない。

## 証明範囲と次工程

各検証は1回の成立実測である。AとB/Cは別の試験タスクであり、
Aの停止を契機にThroughlineが自動でBを作る一連の処理はまだ実装・検証していない。
実際のThroughline DB記憶、20ターンのL2全文、祖先snapshot、二重発火、
結果不明からの回復、他host・他OSは未検証である。

次は、Desktop表示後の実効設定継承と停止観測を実装設計へ確定し、
製品所有schema・継続処理・配送profileを実装する。
その後に連続引き継ぎと中断試験D/E、対象host/OSの受入を行う。
