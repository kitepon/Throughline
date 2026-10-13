# ADR 0058: Aiterm が起こした席の Claude の会話は、同じ画面で新しい会話へ替えて引き継ぐ

- Status: Proposed（口の形と失敗の code は Aiterm の担当と合った。2026-10-13。Aiterm の側はまだ出来ていない。本物の席で通してから Accepted にする）
- Date: 2026-10-13

## Context

ADR 0057（0.16.27）は、Aiterm が起こした席の会話を自動継続から外した。席は同じ画面のまま続き、呼び手との行き来は
切れない。代わりに、文脈が一杯になると Claude Code の自動圧縮が走る。Throughline は自動圧縮を置き換える物なので、
これは仮の形である。

オーナーの決め（2026-10-13）の後ろの半分は「席の同じ画面で新しい会話へ替える」。席の端末と process はそのままで、
会話だけを新しくする。呼び手は同じ席へ送り続け、答えも同じ席から戻る。

裏の後継（`claude --bg`）を使う今の形（ADR 0033）と比べると、次の所が違う。

| 段 | 裏の後継（ADR 0033） | 同じ画面で替える（この ADR） |
|---|---|---|
| 圧縮を止める | `PreCompact` の exit code 2 | 同じ |
| 旧い会話を止める | `PreToolUse` の `deny` と `continue: false` | 同じ。止める直前に、Aiterm への合図を書く |
| 新しい会話を作る | worker が `claude --bg` を立てる | Aiterm が席の端末へ `/clear` を打つ |
| 継続の指示を渡す | `claude --bg` の最初の指示 | Aiterm が、`/clear` の後に席の端末へ打つ |
| 記憶を入れる | 最初の指示の `UserPromptSubmit` | 同じ（指示の頭の引き継ぎ ID で前任を決める。ADR 0053） |
| モデル・effort・権限 | 起動の引数で渡す | 渡さない（同じ process が続く） |

席の端末へ文字を打てるのは Aiterm だけなので、`/clear` と継続の指示を打つ所は Aiterm が持つ。Throughline は、いつ替えるかを
決め、止めたターンを取り込み、継続の指示の文を作り、Aiterm の口を1回呼ぶ。

### `/clear` の後は、環境の会話 ID が合わなくなる

ADR 0057 は、席の会話を「`AITERM_AGENT_VENDOR_SESSION_ID` が hook の `session_id` と同じ会話」と決めた。環境の値は、
席の process を起こした時の物で、途中で変わらない。`/clear` で会話が替わると、新しい会話の ID は環境の値と違う。
そのままだと、替えた後の会話は席と数えられず、次に文脈が一杯になった時に裏の後継へ引き継がれる（2026-10-13 の朝の
不具合と同じ形）。

**席の「今の会話 ID」を、環境とは別の所から読める形が要る。** その置き場は Aiterm が持つ。席と会話の結び付きを
替えるのは Aiterm で、Throughline が自分で数えると、2つの製品の見ている席が食い違う事がある（Aiterm は失敗と返したが
会話は替わっていた、など）。

Aiterm の側は、席の記録に会話 ID を持っている。Stop の hook は、席の記録の会話 ID を先に見て、記録が無い時だけ
環境の ID と比べる形へ直す（Aiterm の ADR 0119、未公開）。会話を替える時に Aiterm が席の記録を書き換え、同じ所の
file も一緒に書き換えるので、2つの製品は同じ席を見る。

`/clear` を打つと、同じ秒のうちに `SessionEnd`（`reason: clear`、旧い ID）と `SessionStart`（`source: clear`、新しい ID）の
hook が走り、hook の環境の `AITERM_AGENT_VENDOR_SESSION_ID` は旧い ID のままだった（Aiterm の担当の実測。Linux、
Claude Code 2.1.296、Aiterm 0.59.0 の席）。Aiterm は、席ごとの設定へ `SessionStart` の hook を足し、`source: clear` を
受けた時に席の記録と file を書き換える。口が打った `/clear` も、人が席で打った `/clear` も、同じ hook を通る。

## Decision

### 1. 席の会話の判定

1. 環境に `AITERM_AGENT_LAUNCH_ID` がある時だけ、席かどうかを見る（ADR 0057 と同じ）。
2. 席の今の会話 ID は、Aiterm が file に書く。file の場所は、席の環境の `AITERM_AGENT_VENDOR_SESSION_FILE`（絶対 path）で
   受け取る。中身は会話 ID の1行（末尾に改行1つ）。Aiterm は、席の process を起こす前に起動の ID を書き、席の会話が
   替わった時に別名で書いて付け替え、席を閉じた時に消す。変数がある席には、起こした時点で必ず file がある。
   入るのは Claude Code と Grok の席（`AITERM_AGENT_VENDOR_SESSION_ID` と同じ）。Throughline は環境の path だけを読む
   （置き場と file の名前は Aiterm の中の事で、変わりうる）。
3. 判定は `isAitermSeatConversation(env, sessionId)` の1か所で行う。
   - file の変数があり、読めた時: 中身が `sessionId` と同じなら席。
   - file の変数が無い時（0.59.x の Aiterm）: `AITERM_AGENT_VENDOR_SESSION_ID` が `sessionId` と同じなら席（ADR 0057 のまま）。
   - file の変数があるのに読めない時: 環境の ID と比べる。
4. 環境の印は、ほかの裏の会話へ継がれる（ADR 0057）。file の場所も同じ道で継がれるが、中身は席の会話 ID なので、
   ほかの会話の ID とは合わない。**席だけの動きは、必ずこの判定の後で読む。**
5. **`SessionStart` の hook では、この判定をしない。** Aiterm の hook と Throughline の hook は同じ `SessionStart` で並んで
   走るので、その時点の file は旧い ID の事がある。判定するのは `PreCompact` と `PreToolUse` だけで、どちらも
   最初の入力より後に走る。空で始まった会話へ記憶を入れる道（下の 6）は、この判定ではなく記録で決める。

### 2. 同じ画面で替えられる席

席の環境に `AITERM_AGENT_HANDOFF_MARK`（Aiterm への合図の file の絶対 path）がある席だけ、同じ画面で替える。
無い席（この口を持たない版の Aiterm）は、ADR 0057 のとおり圧縮を通す。

`PreCompact(auto)` の判定の順は、次のとおり。

1. 手動の `/compact` → 止めない。
2. 進んでいる引き継ぎがある → 止める（今までどおり）。
3. 無効な project → 止めない。
4. script から起動した会話 → 止めない。
5. 席の会話で、
   - この会話で替える事をあきらめている（下の 6。やり直さない失敗が1回、または席が番の最中だった失敗が3回）→ 止めない。
     理由は `aiterm_seat_inplace_unavailable`。
   - `AITERM_AGENT_HANDOFF_MARK` が無い → 止めない。理由は `aiterm_seat`（0.16.27 と同じ）。
   - ある → 記録を残して圧縮を止める。記録に `seat`（起動の ID、`AITERM_SESSION_ID`、合図の file の場所）を持たせる。
6. 席でない会話 → 今までどおり、裏の後継へ引き継ぐ記録を残して止める。

`seat` を持つ記録は、Claude Desktop へ移す指定とリモートコントロールの指定を、上書きの環境変数があっても付けない。

### 3. 旧い会話を止める（`PreToolUse`）

`seat` を持つ記録（`requested`・`failed`）の会話が次の道具を呼んだ時、最初に札を取った hook が、次の順で動く。

1. 合図の file へ、引き継ぎ ID の1行を書く（上書き）。書けなければ、記録を取り下げ、あきらめた印を残し、道具を通す。
2. 記録を `stopped` にして、worker を起動する。
3. 道具を実行させずにターンを止める。止めた時の文は「同じ席の画面で新しい会話へ替えます」と書く
   （`claude agents`・`claude attach` の案内は出さない）。

`seat` を持たない記録が席の会話に残っている時は、ADR 0057 のとおり取り下げる。
圧縮を止めた後、道具を呼ばずにターンが終わった時は、今までどおり Stop が記録を取り下げる。合図の file はまだ書いていない。

hook で止めたターンでは Stop hook が走らない（ADR 0033）。Aiterm は、合図の file で「このターンの終わりは、呼び手へ
返す答えではない」と知る。

### 4. worker

`stopped` の記録を受けて、今までと同じ順で、止めた道具が transcript に書かれるのを待ち、止めた時点の依頼と
ここまでにした事を記録へ写し、止めたターンを DB へ取り込み、記録を `launching` にする。その後が違う。

1. 継続の指示（`claudeContinuationInput`。今と同じ文）を、記録の置き場の file（本人だけが読める）へ書く。
2. Aiterm の口を1回だけ呼ぶ。上限は 180 秒。

   ```text
   aiterm-seat-handoff --session <AITERM_SESSION_ID> --launch <AITERM_AGENT_LAUNCH_ID>
     --from <旧い会話の ID> --handoff <引き継ぎ ID> --prompt-file <指示の file> --json
   ```

3. 返り（`aiterm.seat-handoff.v1`）の `session_id`・`launch_id`・`from_vendor_session_id` が渡した値と同じ事を確かめる。
4. 指示の file を消す（成功でも失敗でも）。
5. 返りを記録へ写す（下の 5 と 6）。

`claude --bg` は立てない。モデル・effort・権限は渡さない。記録の `settings` には、止めた時点の値を今までどおり残す
（後から調べる時に使う）。

### 5. 記録の状態と、後継の ID

新しい状態は足さない。今ある状態を、同じ意味で使う。

| 状態 | 裏の後継 | 同じ画面で替える |
|---|---|---|
| `requested` | 圧縮を止めた | 同じ |
| `stopped` | 旧い会話を止めた | 同じ（合図の file を書いた） |
| `launching` | 後継を立てている | Aiterm の口を呼んでいる |
| `launched` | 後継が立った | Aiterm が `continued` を返した |
| `sent` | 後継の最初の指示が受領を残した | 同じ |
| `unknown` | 受領を確かめられなかった | 同じ |
| `failed` | 後継を立てられなかった | worker を起動できなかった時だけ（次の道具でやり直す。今までどおり）。Aiterm の口の失敗は、下の 6 で取り下げる |

- `/clear` の後の最初の入力（継続の指示）は、worker が後継の ID を記録へ写す前に届く。今の形でも同じ事が起きていて、
  `launching` の間は指示が運ぶ引き継ぎ ID で後継と認めている（ADR 0033 の 5）。同じ道を使う。
- 後継の ID は、Aiterm の返りの `vendor_session_id` を `successor.session_id` へ、その頭8字を `successor.short_id` へ写す。
  受領が残っていれば、受領の ID と同じ事を確かめる。違う時は受領の ID を採り、worker のログへ残す。
- 外へ見せる項目（`auto-handoff status`）に `in_place`（`true`／`false`）を足す。ほかの項目の名前と意味は変えない。
- ほかの製品が頼っている2つの形（ADR 0053）は変えない: 最初の指示の頭 `Throughline自動継続 <引き継ぎ ID>` と、
  `auto-handoff status --host claude --operation <引き継ぎ ID> --json` の `handoffs[0].source_session_id`。
- `resolveClaudeAutoHandoffSuccessor`（旧い会話の今の続きを引く口）は、`successor.session_id` をたどるので、そのまま使える。
  新しい会話の transcript は、旧い会話と同じ project のフォルダに出来る。

### 6. 失敗の扱い

決まりは1つ: **新しい会話の ID が分かった時だけ記録を残す。分からない時は記録を取り下げ、その会話で替える事をあきらめる。**

あきらめた印は、記録の置き場に会話ごとの file で残す（引き継ぎ ID、理由、失敗の回数、時刻。24 時間で掃除）。
印がある会話は、次からの自動圧縮を通す（0.16.27 と同じ）。印が無いと、圧縮のたびにターンを止めては失敗する事を繰り返す。

**何も打たれなかった失敗（`typed: none`）のうち、少し後なら通る物は、1回ではあきらめない。** 記録を取り下げて回数を数え、
次の自動圧縮でもう一度替える。同じ会話で3回失敗した時に、あきらめる。理由は下の「止めた後に、旧い会話で次の番が
始まる時」。1回であきらめるのは、やり直しても通らない物だけ: 席が無い（`SEAT_NOT_FOUND`）、席と合わない
（`SEAT_MISMATCH`）、指示の file を読めない（`PROMPT_INVALID`）、口が無い（`ENOENT`）、合図の file を書けない。
一覧に無い code は、`typed` と新しい会話の ID の有無だけで扱う（`typed: none` なら、やり直す側）。

| Aiterm の返り | 席の画面 | Throughline の扱い |
|---|---|---|
| `continued` | 新しい会話が継続の指示で動いている | `launched` → 受領を 60 秒待つ → `sent`。残らなければ `unknown`（`handoff_delivery_unconfirmed`） |
| `failed`・`typed: none`（`TURN_NOT_STOPPED`・`SEAT_BUSY`・`SEAT_NOT_READY`・`HANDOFF_MARK_MISMATCH`・一覧に無い code） | 旧い会話のまま | 記録を取り下げ、失敗の回数を数える。3回目であきらめる |
| `failed`・`typed: none`（`SEAT_NOT_FOUND`・`SEAT_MISMATCH`・`PROMPT_INVALID`） | 旧い会話のまま。ターンは止まっている | 記録を取り下げ、あきらめた印を残す。理由は返りの `code` |
| `failed`・`typed: clear` | 新しい会話が空で始まっている | 返りに新しい会話の ID があれば `unknown`（`handoff_seat_prompt_not_delivered`）で残す。無ければ（`/clear` の後の `SessionStart` が Aiterm へ届かなかった時）取り下げる |
| `failed`・`typed: clear_and_prompt` | 新しい会話に指示を打ったが、Aiterm が確かめられなかった | 受領を 60 秒待つ。残れば `sent`。残らなければ、返りに ID があれば `unknown`、無ければ取り下げる |
| 口が無い（`ENOENT`） | 旧い会話のまま | `typed: none` と同じ。理由は `handoff_aiterm_cli_unavailable` |
| 時間切れ・読めない返り（引数が足りない時の終了コード 2 も） | 分からない | 受領があれば `sent`。無ければ席の今の会話 ID の file を読み、旧い ID のままなら `typed: none` と同じ、替わっていればその ID で `unknown`。file を読めなければ取り下げる |

- **`typed: none` で止まったターン**は、Throughline からは再開できない（席の端末へ打てない）。Aiterm が呼び手の待ちを
  `error` で返し、呼び手が送り直す。旧い会話は残っていて、記録は無いので、送り直した文はそのまま旧い会話で続く。
- **止めた後に、旧い会話で次の番が始まる時**: 合図の file を書く前に Claude Code の待ち行列へ入っていた文は、Aiterm には
  止められない。hook で止めた番の後にその文が次の番として動くかは、まだ実物で見ていない（2026-10-13 の Windows の
  記録には、止めた時に行列に入っていた文が無かった）。動く時は、次のようになる。
  - その番の道具は、記録がある間は断られ、番は止まる（引き継ぎ済みの会話と同じ。同じ日の記録で、止めた後に届いた文の番が
    最初の道具で止まった事を見ている）。
  - Aiterm の口は、何も打たずに `typed: none`・`TURN_NOT_STOPPED` で返す。worker は記録を取り下げる。
    `TURN_NOT_STOPPED` の意味は「合図の後に、旧い会話で次の番が始まっている」。番が動いている最中の時（画面で見て、
    短く待ってから返す）と、その番も hook で止まって画面が入力待ちに見える時（旧い会話の記録に、合図の file の時刻より
    後の利用者の入力の行がある）の両方を含む。
  - 行列の文は旧い会話が読んでいて、新しい会話へ運ぶ記憶（止めた時点の依頼）には入っていない。ここで `/clear` を打つと
    その文が落ちるので、打たない形が正しい。
  - 文脈は一杯のままなので、旧い会話の次の番でまた自動圧縮が起き、同じ順で替える。この時は、その番の依頼が
    「止めた時点の依頼」になって新しい会話へ運ばれる。
  - 1回であきらめると、番の最中に文が届く席（呼び手が差し込みで送る席）は、いつまでも圧縮へ戻る。3回までやり直す。
- **新しい会話が空で始まった時**（`typed: clear`、または指示を確かめられなかった時）は、次に届いた入力がその会話の最初の
  入力になる。その入力へ記憶を入れる道を2つ持つ。
  - 記録が残っている時: 最初の入力の hook が「この会話を後継に持つ、`seat` 付きの記録」を引き、継続の指示が無くても、
    前任を合流させて、止めた時点の依頼とここまでにした事を現在地として入れる（自動継続の注入と同じ形）。
  - 記録を取り下げた時: `/clear` の後の会話が前任を引き継ぐ今の道（ADR 0014）で、直近の会話として入る。止めたターンは
    worker が DB へ取り込んでいるので、その中に入っている。同じ project でほかの会話が後から動いていると、
    そちらを前任に選ぶ事がある（今の道の制約）。
- 後から届いた継続の指示（空で始まった会話が別の入力で動いた後）は、最初の入力ではないので、配送としては扱わない。
- **worker を起動できなかった時**は、合図の file は書いてあり、ターンは止まっているが、口は呼ばれない。Aiterm が
  待つのをやめて、呼び手の待ちを `error` で返す。記録は `failed` で残り、呼び手が送り直した文の次の道具で、
  合図を書き直してやり直す。

### 7. 旧い会話と掃除

- `/clear` で、旧い会話は席の画面から消える。transcript は残る。
- 記録は、今までどおり、後継の transcript が残っている間は消さない。旧い会話を誰かが開き直して道具を呼んだ時は、
  今までどおり断り、「同じ席の新しい会話へ引き継ぎ済み」と新しい会話の ID を案内する。
- 合図の file は、Throughline は書くだけで、消すのは Aiterm（口を呼ばれた時と、待つのをやめた時）。
  Aiterm は、合図が書かれてから 180 秒のうちに口が呼ばれなければ、合図を消して呼び手の待ちを `error` で返す。
  その後に呼ばれた口は、何も打たずに `typed: none` で返る。worker は、止めてから口を呼ぶまでを 180 秒より十分短く保つ
  （止めた道具が書かれるのを待つ上限は 5 秒）。
- 連続の引き継ぎ: 替えた後の会話も、1 の判定で席と数えられ、同じ形でまた替わる。元の依頼は、今までどおり
  前の引き継ぎの記録から運ぶ。

### 8. 対象と、対象外

- 対象は Claude Code の席（`AITERM_AGENT_KIND=claude`）。
- Codex の席: 席の CLI は自動継続の対象外（オーナーの決め、2026-10-09）。
- Grok・Cursor の席: 自動継続が無い。

## Aiterm の側が持つ事（担当と合わせた。2026-10-13）

1. **席の今の会話 ID の file**（`AITERM_AGENT_VENDOR_SESSION_FILE`）。上の 1 のとおり。`SessionStart`（`source: clear`）の
   hook で、席の記録と一緒に書き換える。
2. **合図の file**（`AITERM_AGENT_HANDOFF_MARK`）と **`aiterm-seat-handoff`**。形は Aiterm の担当の案のとおり。
   - 口の中の上限は 150 秒。Throughline の 180 秒は、口の process が固まった時の備え。
   - `/clear` の後、新しい会話の `SessionStart` で file を書き換えてから、継続の指示を打つ。口が途中で落ちても、
     file は実際の会話を指す。
   - `typed: clear` と `clear_and_prompt` の失敗でも、新しい会話の ID を `vendor_session_id` へ入れて返す。
     `/clear` を打ったのに `SessionStart` が届かなかった時だけ null。
   - `typed: none` の失敗と、合図があるのに口が呼ばれない時は、呼び手の待ちを `error` で返す。
   - 席が番の最中の時は、何も打たずに `typed: none`・`TURN_NOT_STOPPED` で返す。
   - 合図の file がある間は、その席への送信を Aiterm の中で待たせる。待たせた文は、`continued` の後に続きのターンへの
     差し込みとして入る。待ちの上限（POSIX 60 秒、Windows 180 秒）を越えた文は、未送信で断り、呼び手が送り直す。
3. 継続の指示は、頭より前に何も置かずに、全文を1つの入力として打つ（頭の形で照合している）。
4. `continued` を返した後、呼び手の待ちは、続きのターンの終わりまで続く（普通のターンと同じ）。受領の 60 秒と競る時計は、
   Aiterm の側に無い。

名前と意味は、ADR 0057 と同じ扱いにする（変える時は、先に知らせ合う）。

### 口の返り（Aiterm の担当の一覧。2026-10-13）

標準出力へ1行: `{ "schema": "aiterm.seat-handoff.v1", "outcome", "session_id", "launch_id", "from_vendor_session_id",
"vendor_session_id", "typed", "code", "message" }`。`outcome` は `continued`（終了コード 0、`code` は null）か
`failed`（終了コード 1）。引数が足りない時は終了コード 2 で、JSON は出ない。`vendor_session_id` は新しい会話の ID で、
分からない時は null。

| `typed` | code | 起きる時 | 新しい会話の ID |
|---|---|---|---|
| `none` | `TURN_NOT_STOPPED` | 合図の後に、旧い会話で次の番が始まっている | null |
| `none` | `SEAT_BUSY` | 席ごとの送信の行列の順番が、口の上限のうちに来ない | null |
| `none` | `SEAT_NOT_READY` | 番は動いていないが、席が入力待ちにならない（選ぶ画面や確かめの画面、画面を読めない） | null |
| `none` | `HANDOFF_MARK_MISMATCH` | 合図の file が無い（180 秒を過ぎて Aiterm が消した）か、中身が `--handoff` と違う | null |
| `none` | `SEAT_NOT_FOUND` | その名前の席が無い | null |
| `none` | `SEAT_MISMATCH` | 起動の ID、旧い会話の ID、harness のどれかが、席の今と合わない | null |
| `none` | `PROMPT_INVALID` | 指示の file を読めない、空、64KiB を越える | null |
| `clear` | `CLEAR_NOT_CONFIRMED` | 新しい会話の `SessionStart` を上限のうちに受けていない | null |
| `clear` | `PROMPT_NOT_TYPED` | 新しい会話は始まったが、入力待ちにならず、指示を打てていない | 入る |
| `clear_and_prompt` | `PROMPT_NOT_ACCEPTED` | 指示を打ったが、新しい会話が受け付けたのを確かめられない | 入る |
| どれでも | `INTERNAL_ERROR` | 上に無い失敗。`typed` はそこまでに打った所 | 分かっていれば入る |

呼び手の待ち: `typed: none` と `typed: clear` の失敗、合図から 180 秒過ぎた時は、Aiterm が `error` で返す。
`PROMPT_NOT_ACCEPTED` は待ちを残す（指示が受け付けられていれば、続きのターンの終わりが呼び手へ届く）。

## Consequences

- 同じ画面で替えられる席では、Claude Code の自動圧縮は走らない。呼び手との行き来は切れない。
- 呼び手から見ると、替わる所で席の答えが1回遅れる（止める → `/clear` → 継続の指示 → 続きのターンの終わり）。
  替わった後の答えは、続きのターンの答えである。
- 席の会話 ID は、替わるたびに変わる。会話 ID で席を覚えている物（Aiterm の記録、通話の MCP）は、Aiterm の file か、
  `auto-handoff status`・`successor` の口で今の ID を引く。
- この口を持たない版の Aiterm の席と、あきらめた印のある会話は、0.16.27 と同じに圧縮が走る。
- Throughline が Aiterm の CLI を呼ぶ依存が1つ増える。口が無い端末では、何も打たれずに 0.16.27 の動きへ戻る。
- `PreToolUse` の速い道（記録の file が無ければ終わる）は変えない。あきらめた印は `PreCompact` だけが読む。

## 確かめる範囲（作った後）

- 3OS（macOS・Linux・Windows）の本物の席（Aiterm の `agent_launch`）で、本物の自動圧縮を起こして通す。
  見る物: 圧縮の記録が無い事、止めた道具が実行されていない事、新しい会話へ記憶と現在地が入った事、
  続きの答えが呼び手へ戻った事、替えた後の会話がもう1回替わる事（連続）。
- `/clear` の後に、モデル・effort・権限の mode が同じまま続く事（同じ process なので続くはずだが、実機で見る）。
- 失敗の3つの形（`typed: none`、`typed: clear`、口が無い）を、試しの席で起こして見る。
- 番の最中に席へ文を送り、hook で止めた番の後に、行列の文が旧い会話で次の番として動くかを見る。動く時は、
  `TURN_NOT_STOPPED` → 取り下げ → 次の圧縮で替わる、の順になる事を見る。
- 人が席の画面で手で `/clear` した後の会話が、席と数えられて、同じ形で替わる事。
- 通話の MCP の hook が、替えた後の会話で前任の通話を引き取る事（担当へ頼む）。

## まだ決めていない事・見ていない事

- `SessionEnd`・`SessionStart` が `/clear` と同じ秒に走る事は、Linux でだけ見た（Aiterm の担当）。macOS と Windows は
  見ていない。
- 席で `/resume` して別の会話へ移った時（`source: resume`）に、Aiterm が席の会話を替えるか。Aiterm の担当が実物を
  見てから決める。替えない間は、移った先の会話は席と数えられず、裏の後継へ引き継がれる（ADR 0057 と同じ）。

## 採らなかった形

- **Throughline が、起動の ID ごとに「替えた先の会話 ID」を自分で持つ**: Aiterm が file を出せるので要らない。
  2つの製品の見ている席が食い違う事がある。
- **止めた後に旧い会話で次の番が動いている時、その番が終わるのを待って `/clear` を打つ**: その番が読んだ文は、
  新しい会話へ運ぶ記憶に入っていないので、落ちる。
