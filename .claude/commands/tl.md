---
description: 次の新規セッションに現セッションの記憶を引き継ぐためのバトンを置く (Throughline)
---

Throughline の UserPromptSubmit hook が `/tl` を検出し、バトン（現セッション ID）を保存しました。

これだけで完了です。**追加の操作は不要**。

このあと:
- バトン保存から1時間以内に生まれた新セッションの初回入力で、Throughline がバトンを消費して記憶を引き継ぎます。約9,500字以内で現在地・取得案内・予算に入る直近L2ターン本文を注入し、L1と残りのL2は案内の `throughline recall`、L3は `throughline detail` で取得します。L1・Thinking本文はこの注入に含めません
- バトンは 1 時間で失効します

VS Codeでは `/clear` だけでも自動引継ぎが発火します。Claude Desktopでは `/clear` の前に `/tl` が必要です。`THROUGHLINE_DISABLE_AUTO_HANDOFF=1` で自動引継ぎを止めている場合や、`/clear` を経由せず新セッションを開く場合にも `/tl` を使います。

ユーザーへの追加報告テキストは不要です。一言だけ完了を伝えるか、何も返さずターンを終えて構いません。
