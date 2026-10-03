# Codex自動新規タスク継続の成立検証

- 実測日: 2026-10-03（Asia/Tokyo）
- 状態: **A〜Cの成立と、製品経路でのD（A→B→C、介入なし）の実機受入は合格。Eの失敗境界はfocused試験で確認した。**
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

## 製品統合の受入（D）

[統合結果JSON](codex-auto-continuation/2026-10-03-integrated-results.json)と
[統合試験source](codex-auto-continuation/2026-10-03-integrated-probe-source.mjs)を保存した。
最初の指示を1回送った後は、手動resume、追加prompt、コード修正を行っていない。
3工程の順序と一意性を試験プログラムが検査し、工程3まで同じ元の値を保持した。

| 引き継ぎ | 要求から旧turn停止 | 圧縮記録 | 凍結L2行 / L3行 | 表示後の設定 | 結果 |
|---|---:|---:|---:|---|---|
| A→B | 32 ms | 0 | 2 / 6 | 一致 | 配送入力・開始・実進捗を観測 |
| B→C | 39 ms | 0 | 2 / 6 | 一致 | 配送入力・開始・実進捗を観測 |

CではAに束縛した取得コマンドが実際に呼ばれ、L3結果が記録された。
Cの最終`task_complete`と3工程の成果物を確認した。後継作成数は2、各配送受付は1である。

試験projectの圧縮閾値は60,000 tokensとした。工程1/2の完了後だけ試験hookから
合成tool文脈を追加し、公式`PreCompact(auto)`を実火させた。
初回タスクの基盤指示より低い閾値で空の引き継ぎを繰り返す試験にはしていない。
この確認は既定容量上限での長時間作業の証明ではない。
macOSのDesktop以外のOS/hostは未検証である。

## 失敗境界の受入（E）

`src/codex-auto-handoff.test.mjs`で、元turnの重複、workerのPID再利用、
設定不一致での配送0回と同じ後継からの再開、作成応答喪失での再作成0回、
配送応答喪失での再送0回と観測による回復、入力保存前の開始event、
実行中のnative session、未処理入力・子agent、追跡されていない継承記憶を確認した。
これらはfocused fixtureの検証であり、すべてをDesktop障害として実火したとは扱わない。

ターン開始前のauto発火でも、新しいユーザー入力はrolloutの`response_item`へ
保存されていた。`turn_context`や`user_message`の不在を入力喪失と扱わない。
標準モードの指示が公式settings APIで展開されることと、`task_started`から入力保存までに
時間差があることは最小再現で確認し、設定と開始の照合へ反映した。

自分の試験project/hook用設定6 sectionは、完了後に公式APIで削除した。
通常の他hookやuser設定は巻き戻していない。製品の新しいPreCompact登録は
標準installの管理対象とし、公開後に正規の導入先へ更新する。
