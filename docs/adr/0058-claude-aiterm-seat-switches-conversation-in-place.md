# ADR 0058: Aiterm が起こした席の Claude の会話は、同じ画面で新しい会話へ替えて引き継ぐ

- Status: Proposed（Aiterm の担当と形を合わせている所。コードはまだ無い）
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

Aiterm の Stop の hook も、会話 ID が環境の値と違う時は何も書かない形へ直す予定になっている。同じ理由で、替えた後の
会話の答えが呼び手へ戻らなくなる。**席の「今の会話 ID」を、環境とは別の所から読める形が、両方の製品に要る。**

その置き場は Aiterm が持つ。席と会話の結び付きを替えるのは Aiterm で、Throughline が自分で数えると、2つの製品の
見ている席が食い違う事がある（Aiterm は失敗と返したが会話は替わっていた、など）。

## Decision

### 1. 席の会話の判定

1. 環境に `AITERM_AGENT_LAUNCH_ID` がある時だけ、席かどうかを見る（ADR 0057 と同じ）。
2. 席の今の会話 ID は、Aiterm が file に書く。file の場所は、席の環境の `AITERM_AGENT_VENDOR_SESSION_FILE`（絶対 path）で
   受け取る。中身は会話 ID の1行。Aiterm は、席を起こした時に起動の ID を書き、席の会話を替えた時に書き換える。
3. 判定は `isAitermSeatConversation(env, sessionId)` の1か所で行う。
   - file の変数があり、読めた時: 中身が `sessionId` と同じなら席。
   - file の変数が無い時（0.59.x の Aiterm）: `AITERM_AGENT_VENDOR_SESSION_ID` が `sessionId` と同じなら席（ADR 0057 のまま）。
   - file の変数があるのに読めない時: 環境の ID と比べる。
4. 環境の印は、ほかの裏の会話へ継がれる（ADR 0057）。file の場所も同じ道で継がれるが、中身は席の会話 ID なので、
   ほかの会話の ID とは合わない。**席だけの動きは、必ずこの判定の後で読む。**

### 2. 同じ画面で替えられる席

席の環境に `AITERM_AGENT_HANDOFF_MARK`（Aiterm への合図の file の絶対 path）がある席だけ、同じ画面で替える。
無い席（この口を持たない版の Aiterm）は、ADR 0057 のとおり圧縮を通す。

`PreCompact(auto)` の判定の順は、次のとおり。

1. 手動の `/compact` → 止めない。
2. 進んでいる引き継ぎがある → 止める（今までどおり）。
3. 無効な project → 止めない。
4. script から起動した会話 → 止めない。
5. 席の会話で、
   - この会話で替える事をあきらめた印（下の 6）がある → 止めない。理由は `aiterm_seat_inplace_unavailable`。
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

あきらめた印は、記録の置き場に会話ごとの file で残す（引き継ぎ ID、理由、時刻。24 時間で掃除）。印がある会話は、
次からの自動圧縮を通す（0.16.27 と同じ）。印が無いと、圧縮のたびにターンを止めては失敗する事を繰り返す。

| Aiterm の返り | 席の画面 | Throughline の扱い |
|---|---|---|
| `continued` | 新しい会話が継続の指示で動いている | `launched` → 受領を 60 秒待つ → `sent`。残らなければ `unknown`（`handoff_delivery_unconfirmed`） |
| `failed`・`typed: none` | 旧い会話のまま。ターンは止まっている | 記録を取り下げ、あきらめた印を残す。理由は返りの `code` |
| `failed`・`typed: clear` | 新しい会話が空で始まっている | 返りに新しい会話の ID があれば `unknown`（`handoff_seat_prompt_not_delivered`）で残す。無ければ取り下げる |
| `failed`・`typed: clear_and_prompt` | 新しい会話に指示を打ったが、Aiterm が確かめられなかった | 受領を 60 秒待つ。残れば `sent`。残らなければ、返りに ID があれば `unknown`、無ければ取り下げる |
| 口が無い（`ENOENT`） | 旧い会話のまま | `typed: none` と同じ。理由は `handoff_aiterm_cli_unavailable` |
| 時間切れ・読めない返り | 分からない | 受領があれば `sent`。無ければ席の今の会話 ID の file を読み、旧い ID のままなら `typed: none` と同じ、替わっていればその ID で `unknown`。file を読めなければ取り下げる |

- **`typed: none` で止まったターン**は、Throughline からは再開できない（席の端末へ打てない）。Aiterm が呼び手の待ちを
  `error` で返し、呼び手が送り直す。旧い会話は残っていて、記録は無いので、送り直した文はそのまま旧い会話で続く。
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
- 連続の引き継ぎ: 替えた後の会話も、1 の判定で席と数えられ、同じ形でまた替わる。元の依頼は、今までどおり
  前の引き継ぎの記録から運ぶ。

### 8. 対象と、対象外

- 対象は Claude Code の席（`AITERM_AGENT_KIND=claude`）。
- Codex の席: 席の CLI は自動継続の対象外（オーナーの決め、2026-10-09）。
- Grok・Cursor の席: 自動継続が無い。

## Aiterm の担当へ頼む事

1. **席の今の会話 ID の file**（`AITERM_AGENT_VENDOR_SESSION_FILE`）。席を起こした時に書き、会話を替えた時に、
   途中の状態が見えない形（別名で書いて付け替える）で書き換える。Aiterm の Stop の hook も同じ file を読めば、
   替えた後の会話の答えを席の物と数えられる。
2. **合図の file**（`AITERM_AGENT_HANDOFF_MARK`）と **`aiterm-seat-handoff`**。形は Aiterm の担当の案のとおり。
   - `typed: clear` と `clear_and_prompt` の失敗でも、新しい会話の ID が分かっていれば `vendor_session_id` へ入れて返す。
   - `typed: none` の失敗と、合図があるのに口が呼ばれない時は、呼び手の待ちを `error` で返す。
   - 替えている間は、呼び手の文を席の端末へ打たない（継続の指示より先に届くと、指示が最初の入力でなくなる）。
3. 継続の指示は、頭より前に何も置かずに、全文を1つの入力として打つ（頭の形で照合している）。

名前と意味は、決まった後は ADR 0057 と同じ扱いにする（変える時は、先に知らせ合う）。

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
- 通話の MCP の hook が、替えた後の会話で前任の通話を引き取る事（担当へ頼む）。

## まだ決めていない事

- `AITERM_AGENT_VENDOR_SESSION_FILE` の名前と、Aiterm がこの file を出せるか。出せない時は、Throughline が
  起動の ID ごとに「替えた先の会話 ID」を自分で持つ形にする（2つの製品の見ている席が食い違う事がある。採りたくない形）。
- 人が席の画面で手で `/clear` した時に、Aiterm が席の会話を替えるか。替えるなら、1 の判定がそのまま追える。
- 口の上限（180 秒）と、受領の待ち（60 秒）を足した時に、Aiterm の側の待ちと合うか。
