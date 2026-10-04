# Claude Code: 圧縮まわりの hook（一次ソース抜粋）

取得: 2026-10-04、`https://code.claude.com/docs/en/hooks.md`・`context-window.md`・`deep-links.md`・`agent-view.md`・`env-vars.md`。
実機は Claude Code 2.1.289。設計は [ADR 0032](../../../docs/adr/0032-claude-compact-continuation.md)。

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

## 新しい会話を始める口

> A deep link never executes anything on its own. The link only chooses a directory and fills the prompt box.

> When you dispatch a background session from agent view or start one with `claude --bg`, the session starts in your working directory. Before editing files, Claude moves the session into an isolated git worktree under `.claude/worktrees/`

- `claude-cli://open?q=…` は入力欄へ下書きを入れるだけ。`claude --bg "<prompt>"` は別の background session。
- → 対話中の会話を、記憶を入れた新しい会話へ入れ替えて続けさせる公開の口は無い。

## 自動圧縮の窓

> | `CLAUDE_CODE_AUTO_COMPACT_WINDOW` | Set the auto-compact window in tokens, from `100000` to `1000000`. … |

- 実機試験だけで使う。製品は依存しない。

## 実機で見た transcript（2.1.289）

- 圧縮の後に `{"type":"system","subtype":"compact_boundary","compactMetadata":{"trigger":"auto","preTokens":…,"postTokens":…}}`。
- 続けて `{"type":"user","isCompactSummary":true,"isVisibleInTranscriptOnly":true,"message":{"role":"user","content":"This session is being continued from a previous conversation that ran out of context. …"}}`。
- `SessionStart:compact` の hook 出力は `attachment`（`type: "hook_success"`）として残り、モデルには `<system-reminder>` で届く。
- 圧縮より前の行は消えない。
