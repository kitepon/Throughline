# Claude Code: 圧縮まわりの hook（一次ソース抜粋）

取得: 2026-10-04、`https://code.claude.com/docs/en/hooks.md`・`context-window.md`・`deep-links.md`・`agent-view.md`・`env-vars.md`。
実機は Claude Code 2.1.289。設計は [ADR 0033](../../../docs/adr/0033-claude-auto-handoff-new-session.md)（0.13.0 の時点は ADR 0032）。

## PreCompact

> Exit with code 2 to block compaction. For a manual `/compact`, the stderr message is shown to the user. You can also block by returning JSON with `"decision": "block"`.
>
> Blocking automatic compaction has different effects depending on when it fires. If compaction was triggered proactively before the context limit, Claude Code skips it and the conversation continues uncompacted. If compaction was triggered to recover from a context-limit error already returned by the API, the underlying error surfaces and the current request fails.
>
> Claude Code discards a PreCompact hook's `systemMessage` and `continue` fields.

- matcher は `manual` / `auto`。入力は共通項目に加えて `trigger` と `custom_instructions`（auto では `null`）。
- → 圧縮の前に作業を止める口は無い。止められるのは圧縮だけ。

## SessionStart（source=compact）

> | `compact` | Auto or manual compaction |

> | [SessionStart hooks](/docs/en/hooks-guide#re-inject-context-after-compaction) that match the `compact` source | Claude Code runs them and adds their output to the compacted context |

- 入力の `source` は `compact`。auto と manual の区別は入力に無い。
- → 区別は `PreCompact` の `trigger` で取る。

## PostCompact

> PostCompact hooks have no decision control. They can't affect the compaction result but can perform follow-up tasks.

- 入力に `compact_summary`（生成された要約）。Throughline は使わない。

## subagent

> | `agent_id` | Unique identifier for the subagent. Present only when the hook fires inside a subagent call. Use this to distinguish subagent hook calls from main-thread calls. |

## 作業を止める（PreToolUse）

- `PreCompact` の `continue` は捨てられるので、圧縮を止めた後の作業は別の hook で止める。
- 実機: `PreToolUse` が `{"continue": false, "stopReason": "…"}` だけを返すと、その道具は実行されてからターンが止まる
  （transcript に `hook_stopped_continuation`）。`hookSpecificOutput.permissionDecision: "deny"` を一緒に返すと、
  道具は実行されずに止まる。同じ応答に並んだ道具には、それぞれ hook が走る。
- hook で止めたターンでは `Stop` hook は走らない。

## 新しい会話を始める口

> A deep link never executes anything on its own. The link only chooses a directory and fills the prompt box.

> When you dispatch a background session from agent view or start one with `claude --bg`, the session starts in your working directory. Before editing files, Claude moves the session into an isolated git worktree under `.claude/worktrees/`

- `claude-cli://open?q=…` と Claude Desktop の `claude://code/new?q=…&folder=…` は、入力欄へ下書きを入れるだけ。
  Desktop の新しい会話は、最初の指示が送られるまで process が起動しない（実機: hook も受け口も現れない）。
- `claude --bg "<prompt>"` は別の background session を立てて、すぐ戻る。指示を付けずに起動すると
  `backgrounded · <id> · <name> (idle — send a prompt to start)` と出て、指示を待つ会話が立つ（実機。SessionStart は走る）。
  `--model`・`--effort`・`--permission-mode`・`--name`・`--settings` を受ける。`--session-id` は無視される
  （短い ID は session id の先頭8桁）。別の background session の中から起動すると、出力の ID に色の制御文字が付く。
- 動いている background session は Desktop へ移せない（`claude --desktop --resume`）。ターンが終わった後は開ける。

## 既存の会話へ外から送る口（inbox socket）

> Read this section when a session you expect isn't in the agent list, when you want a script or hook to post into a session, or when a sandboxed command can't reach the socket.

- 会話ごとに Unix domain socket（Windows は named pipe）。path は hook と Bash へ `CLAUDE_CODE_MESSAGING_SOCKET`、
  会話ごとの token は `CLAUDE_CODE_MESSAGING_TOKEN`。起動時に `--messaging-socket-path` でも指定できる。
- 送る形は Claude Code 本体の中の例: 1行の JSON `{"type":"user","message":{"role":"user","content":"…"}}`。
  先頭に `{"type":"auth","token":"…"}`（macOS・Linux は任意、Windows は必須）。
- 実機: 入力待ちの会話へ送るとターンが始まり、`UserPromptSubmit` hook が `prompt` にその文を持って走る。
  transcript では `origin: {kind: "peer"}`、本文の前後に Claude Code が送り主の行と定型の注意書きを付ける。
- 製品の配送は `aiterm-steer-delivery` 0.1.13 の `sendClaudeInbox` を使う（受領の確認は呼び出し側の観測）。

## 自動圧縮の窓

> | `CLAUDE_CODE_AUTO_COMPACT_WINDOW` | Set the auto-compact window in tokens, from `100000` to `1000000`. … |

- 実機試験だけで使う。製品は依存しない。

## 実機で見た transcript（2.1.289）

- 圧縮の後に `{"type":"system","subtype":"compact_boundary","compactMetadata":{"trigger":"auto","preTokens":…,"postTokens":…}}`。
- 続けて `{"type":"user","isCompactSummary":true,"isVisibleInTranscriptOnly":true,"message":{"role":"user","content":"This session is being continued from a previous conversation that ran out of context. …"}}`。
- `SessionStart:compact` の hook 出力は `attachment`（`type: "hook_success"`）として残り、モデルには `<system-reminder>` で届く。
- 圧縮より前の行は消えない。
