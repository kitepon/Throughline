# ADR 0071: Windowsの更新と、動いている端末の部品を分ける

- 状態: 採用
- 日付: 2026-10-19

## 問題

WindowsのClaude後継は専用ConPTY端末で動く（ADR 0069）。Node workerがnpm
導入先のnode-ptyを読むと、conpty.node等がWindowsにmapされ続ける。npm global
installは旧packageを別directoryへ移そうとしてEBUSYとなる。会話を止めて部品を
解放する方法は採らない。0.16.39の手作業による部品保持反映を、通常更新の修理とは扱わない。

## 決定

新しいWindows terminalは、導入済みnode-ptyの全ファイルを製品状態の
`terminal-runtimes/node-pty-<arch>-<SHA256>`へコピー・再照合してから読み込む。
名前とbytesをhashに含め、同じ内容は共有する。未完成コピーは非公開の一意directoryに
作り、完成後renameする。既存runtimeも毎回照合し、改変やcopy失敗では起動を失敗させる。
使用中runtimeの削除や差し替えを更新の副作用にしない。node-addon-apiはbuild-time依存で
あり、runtimeのJS/nativeファイルはnode-pty自身に収まる。

Windows self-updateは常に次の順にする。別方式への暗黙fallbackは加えない。

1. npm global root、実行CLI、公開PATHのidentity/versionを変更前に照合する。
2. registry latestを厳密に読み、global node_modulesに専用lockを取得する。
3. 公式npm.cmdをPowerShell 7から呼び、使い捨てprefixへ**その版**をglobal installする。
   npm自身が取得・integrity照合・依存導入を行う。失敗では本物の導入先を変更しない。
4. package名・版、公開binの同一性、直接依存の存在とexact pinを検査する。
   optional node-ptyの導入失敗を端末機能の成功扱いにしない。
5. 全ファイルを比較する。同じファイルは触らない。変更/削除する旧ファイルを先に
   `recovery/package-updates/<id>/before`へ保存し、journalを保存してから反映する。
   個々の変更は一時ファイルからrename、package.jsonを最後に進める。
6. 全incomingファイルをbytesで再照合する。失敗は完了済み変更を逆順に戻し、失敗として
   返す。rollback自体が失敗した時はlockとjournalを残し、自動で繰り返さない。
7. 正規pathの新CLI、公開PATHの新identity、新CLIによるinstall/migrate/diagnosticsと
   versioned成功応答を従来どおり確認する。ここまで成功するまでは完了を返さない。

非Windowsのnpm更新、hook命令、Codexの信用、会話・DB・引き継ぎの設定は変更しない。
依存更新もstageから差分反映するが、旧版workerが使用中の**異なる**nativeファイルは
Windowsの拒否を成功と偽らず、rollbackして返す。新版workerはnpm外runtimeを使うので、
このlegacy制約を次の端末起動に持ち越さない。

## 回復と限界

journalはprepared/promoting/promoted/rolled_backと全変更予定を残す。process crashや
停電を全ファイルのatomic transactionにはできない。残ったlockを自動削除しない。
保守はowner.jsonのPIDが実際に終了したことを確認し、journalと対象pathの各ファイルを
照合してから保全済みbeforeまたは検証済み公式packageへ復旧する。lockだけを消して
成功扱いにしない。通常のI/O失敗のrollbackと、電源断からの保守回復を区別する。

host設定・DB migration後の失敗は既存の明示失敗契約に従い、DBを旧版へ巻き戻さない。
外部npm installとの同時変更は専用lockで制御できないため、更新を重ねない。
全3OSの試験とWindowsの本物ConPTYを使う隔離試験を行う。本物の利用者会話に
故障を注入しない。12組合せの実会話受入とは区別する。
