# ADR 0060: Claude Code の、ターンの途中で届いた入力は依頼へ足し、host が書く meta の行ではターンを区切らない

- Status: Accepted
- Date: 2026-10-14

## Context

Claude Code の transcript から L2（`bodies`）を作る時、この製品は「本文を持つ user 行1つ + それに続く assistant の本文」を
1つのターンとして読んでいた（`getLogicalTurnGroups`）。user 行なら何でもターンの始まりにし、`attachment` の行は L3 にだけ使っていた。

2026-10-14、BellTeam のコンテナ（Linux、Claude Code 2.1.293・2.1.296、この製品は 0.16.27）の本物の transcript で、
人の入力が L2 に入っていない形が3つ見つかった（本文は読んでいない。行の種類・印・長さ・時刻だけ）。

### 1. ターンの途中で届いた入力

Claude Code は、ターンが動いている間に届いた入力を、user 行ではなく `attachment` の行で書く。

```text
{"type":"attachment","attachment":{"type":"queued_command","prompt":…,"commandMode":"prompt","origin":{"kind":"human"},"humanTurn":true,…}}
```

`prompt` は文字列か、text と image の block の配列。裏の作業の完了通知も同じ形で届く（`commandMode: "task-notification"`、
`origin.kind: "task-notification"`）。前後に `queue-operation` の `enqueue` と `remove` の行が並ぶ。ターンが終わるまで
届けられなかった入力は、`dequeue` の後に普通の user 行になる（`promptSource: "queued"`）。

10/10 からの 163 本で、人の入力の `queued_command` は 833 通あった（人の入力の user 行は 1,402）。L2 に入っていたのは 3 通
（同じ文が別の行にもあった物）。作業中に打った文、ほかの席から差し込まれた文が、記憶に残っていなかった。

### 2. host が書く meta の user 行

Claude Code は、skill を読んだ時の本文や、端末で打った命令の注意書きを、`isMeta: true` の user 行で書く。`origin` は無い。
skill の行は、直後に `attachment` の `command_permissions` が続く。

この行をターンの始まりにしていたので、次の事が起きていた。

- その行より前に assistant の本文が無いと、元の依頼は「本文の無い群」になって保存されない。meta の行の本文
  （skill の手順）が、利用者の発言として保存される。
- 本文があると、1つのターンが2つに割れる。
- L3 は「最後の user 本文の行」から切り出すので、meta の行より前の道具の入出力が入らない。
- 自動継続で止めたターンの依頼（`snapshotInFlight`）も「最後の user 本文」を読むので、後継へ運ぶ依頼が skill の本文になる。

同じ 163 本で、`origin` の無い meta の行は 61 行（道具の後 27、人の入力の直後 11、meta の行の後 17、端末の命令の注意書き 6）。
46 行が利用者の発言として L2 の群に入っていた。

別の会話から届いた発言も `isMeta: true` だが、`origin.kind: "peer"` を持つ。届いた入力なので、今までどおりターンの始まりにする。

### 3. ターンの終わりに続けて届いた待ち入力

ターンの間に入力が2通以上たまると、ターンが終わった時に、2通が続けて user 行になる。2行とも `promptSource: "queued"` で、
同じ `turnPosition.promptIndex` を持つ（同じ番へ届いた印）。

1通目は「assistant の本文が無い群」になり、保存されなかった。ADR 0055 は、この形で Stop が失敗する事を直した時に
「保存の欠けは無い」と書いたが、欠けていたのは完了したターンではなく、1通目の入力だった。同じ 163 本で 5 回。

### ほかの host

- Codex: ターンを host の開始と完了の印（`task_started`・`task_complete`）で区切り、その間の利用者の発言を全部持つ
  （`codex-rollout-memory.mjs`）。同じ欠けは起きない作り。
- Grok: `chat_history.jsonl` に、途中で届いた入力を表す別の行は見つからなかった（80 本）。人の入力の行が本文を挟まずに
  続く形は 9 回あり、`prompt_index` は違っていた。止められたターンか、途中の入力かは分けていない。この ADR では扱わない。
- Cursor: 10 本を見て、同じ形の行は無かった。

## Decision

1. **ターンの途中で届いた入力は、届いた先のターンの依頼へ、届いた順に足す。** `attachment` の `queued_command` で、
   `origin.kind` が `human` か `peer` の物。直前に返した user の行の本文の後ろへ、空行・見出しの1行
   （`（作業の途中で届いた入力）`）・本文の順で足す。本文は user 行と同じ正規化を通す（端末の制御の除去、別の会話の注意書きの除去）。
   - `turn_number` は進めない。`attachment` は今までも本文行に数えていない。保存済みの番号とずれない。
   - 完了通知（`origin.kind: "task-notification"`）は足さない。そのターン自身の裏の作業の結果で、L3 に残っている。
   - `origin` の無い物、`isSidechain: true` の物、足す先の user 行がまだ無い物は足さない。
   - ターンの始まり方（`start`）は変えない。完了通知で始まったターンへ人の入力が届いても、`self` のまま。
2. **`isMeta: true` で `origin.kind` の無い user 行は、ターンの始まりにも本文にもしない**（`isClaudeHostWrittenMetaEntry`）。
   圧縮の要約行（ADR 0032）と同じ扱い。`turn_number` は進める（その行を数えていた頃に保存した番号とずれない）。
   L3 の切り出し（`sliceCurrentTurnEntries`・`sliceInFlightTurnEntries`）も、この行で区切らない。
3. **同じ番へ続けて届いた user 行は、1つの依頼にまとめる。** 直前の user 行との間に assistant の本文が無く、両方が
   `origin.kind` を持ち、`turnPosition.promptIndex` が同じ整数の時。空行でつなぐ。`turn_number`・時刻・`start`・`prompt_id` は
   1通目の物。`turn_number` は2通目の分も進める。
   - `promptIndex` が違う行、印の無い行、`origin` の無い行（端末で打った命令）は、まとめない。止められて本文を書かなかった
     ターンの依頼は、今までどおり保存されない。
4. 判定は、host が transcript に書いた印（`type`・`isMeta`・`origin.kind`・`turnPosition`）だけで行う。本文は読まない。
5. 保存済みのターンは書き直さない。直しが効くのは、この版が取り込むターンから。

## Consequences

- 作業中に打った文と、ほかの席から差し込まれた文が、そのターンの利用者の発言として L2 に残る。引き継ぎの記憶と、
  自動継続で後継へ運ぶ依頼（`in_flight.user`）にも入る。
- 利用者の発言の行が長くなる。見出しの1行は、この製品が足した文で、利用者の文ではない。
- skill の本文は L2 に入らなくなる（L3 には `Skill` の道具の入出力として残る）。
- 前の版が取り込んだ会話では、meta の行で割れていた2つの群が1つにまとまる。`backfillBodies` は「群の断片の番号が1つでも
  保存済みなら回収しない」ので、行は増えない。前の版が落とした依頼と途中の入力は、さかのぼっては入らない。
- Stop の flush barrier（ADR 0026・0055）は `readTranscript` の上で動く。続けて届いた待ち入力は1つの群になるので、
  「本文の無い群を飛ばす」場面が減る。飛ばす作りは残す（`promptIndex` の無い版の Claude Code、止められたターン）。
- `auditor-context` と `caveat-context` の鮮度の照合は、transcript の最後の群の依頼と、保存済みの行の hash を比べる。
  前の版が取り込んだ最後のターンに途中の入力や meta の行があると、版を上げた直後の1回だけ合わない（次のターンからは合う）。
- 途中の入力がターンの最後の本文より後に書かれた時も、そのターンの依頼へ足す。Stop の取り込みがもう済んでいれば、
  その入力は L2 に入らない（保存済みの行は書き直さない）。実物では見ていない。

## 確かめた事・確かめていない事

- 確かめた:
  - 単体試験（途中の入力の文字列と配列、完了通知・sidechain・印なしを足さない、別の会話からの文、足す先が無い時、meta の行、
    `origin` を持つ meta の行、続けて届いた待ち入力、まとめない3つの形、L3 の切り出し、前の版が保存した行と重ねない事、
    止めたターンの取り込み）。直す前の版では、形を表す5本が落ちる。
  - 本物の transcript へ、前の版と直した版の読み手を当てて比べた（DB は開かない。数だけ）。3つの OS とも、assistant の行の番号は
    全部同じで、直した版の代表の番号に、前の版に無い物は 0。

    | | 本数 | 群 | 人の入力の user 行が群の依頼にある数 | 途中の人の入力が群の依頼にある数 | 利用者の発言になっていた meta の行 |
    |---|---|---|---|---|---|
    | Linux（コンテナ） | 163 | 1,661 → 1,634 | 1,385 → 1,401（1,402 のうち） | 3 → 832（833 のうち） | 46 → 0 |
    | macOS | 103 | 1,265 → 1,246 | 905 → 910（926 のうち） | 0 → 121（122 のうち） | 36 → 0 |
    | Windows | 108 | 922 → 899 | 324 → 335（369 のうち） | 2 → 111（119 のうち） | 51 → 0 |

    入らなかった途中の入力は、3つの OS とも全部「依頼へは足されたが、そのターンに assistant の本文が無い」物だった
    （止められたターン。完了したターンの回収には出ない）。
  - 別の会話からの文（`origin.kind: "peer"`）が、ターンの途中に `queued_command` で届く実物は、Windows に 187 通あった
    （`commandMode: "prompt"`。頭は地の文か `<cross-session-message>`）。同じ扱いで依頼へ足される。
  - 本物の Stop の入口（`process-turn`）へ、本物の transcript の写しを、使い捨ての HOME で通した。空の DB から（Linux 3 本、
    macOS 4 本、Windows 2 本）: 途中の人の入力の数だけ見出しが入り、2回目の Stop は 0 行。前の版で取り込んだ後に直した版で
    通す（Linux 3 本、macOS 4 本、Windows 1 本）: 行は増えない。
- 確かめていない:
  - 直した版を入れた端末で、本物の Claude Code が、途中の入力のあるターンを終えた時の L2。入れた後の追跡で読む。
  - `turnPosition` を書かない版の Claude Code。その時は 3 が効かず、今までと同じ動きになる。`origin` を書かない版の
    `queued_command`（macOS と Windows の古い行にある）は、足さない。
