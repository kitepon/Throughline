# ADR 0067: 後継が無い引き継ぎ失敗では旧い会話を通す

- 日付: 2026-10-17
- 状態: 採用

## 背景

Windows の Claude Desktop の実作業で、`claude --bg` が背景サービスへ接続できず、
後継が無いまま `failed/handoff_successor_launch_failed` になった。従来は次の道具で
failed を stopped に戻して再起動し、圧縮も止め続けていた。起動失敗の間、利用者は
旧い会話でも作業を進められなかった。

## 決定

- failed で、後継・accepted_at・独立した受領ファイルのすべてが無ければ、旧い会話の
  PreToolUse と PreCompact を通す。失敗の記録と保存済みの記憶は保持する。
- 道具の hook は失敗理由と継続可能であることを利用者とモデルへ明示する。
  同じ failed を道具のたびに立ち上げ直さない。worker 自体の起動失敗も同じ扱い。
- 後継や受領が残る記録は通さない。既に作られた後継との二重実行を防ぐ。
  launched / sent / unknown の既存の配送・再送禁止契約は変更しない。
- 席に残った requested / failed の取り下げは ADR 0057 を維持する。
- 診断ログでは、道具を通した失敗を pre-tool-use-handoff-failed と記録し、
  実際に止めた pre-tool-use-stop と区別する。

## Windows の原因と復旧

同じ CLI で、通常権限の対話セッションは daemon の control.sock が unreachable、
同じ対話セッションの管理者権限は reachable だった。SSH から管理者権限で起きた
背景サービスと、通常権限の Desktop 側との到達性の差を実測した。

今回の復旧は、停止時点の保存済みの記憶から同じ handoff を一度だけ進め、受領と
記憶の合流・実作業を確認した。さらに背景サービスを `--keep-workers` で交替し、
通常権限の daemon を起動した。実行中の会話を止めず、通常権限でも reachable に戻した。
単なる daemon の再起動では管理者側のクライアントが先に起動し直したため、通常権限の
起動役を先に待機させ、旧 daemon の終了後に引き継がせた。権限を上げる launcher は作らない。

## 検証

- worker 起動失敗後の道具・圧縮は通り、再起動・再停止しない。
- CLI 不在、起動拒否、異常な起動出力でも failed の原本を保持して通す。
- 後継か受領が存在する failed は旧い会話を止め、二重起動しない。
- 席の取り下げと、成功・受領不明の停止を維持する。
