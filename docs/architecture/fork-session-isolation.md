# Read-only fork session isolation

Owner: Throughline. Requester: N102 (BellTeam conversation). Binding design:
BellTeam `fd61b8e5` `docs/architecture/modules/conversation/fork-inquiry.md`,
"Records and display". Memory policy: Biscuit, "omit fork content by default"
(`bot-da7c1cb5/docs/knowledge/fork-summary-policy.md`).

A fork is a read-only CLI session forked from a Bot's main session in the same
project to answer one inquiry. Throughline keeps its records, labels them as a
fork, and never lets them into the main seat's automatic short-term memory.

## Store contract (schema v13)

`sessions` gains three nullable columns. `NULL` `session_kind` is a main session,
so every pre-v13 row and every DB that a v13 writer has not migrated yet keeps
ordinary main behaviour.

| Column | Value |
| --- | --- |
| `session_kind` | `NULL` (main) or `'fork'` |
| `fork_id` | Launcher-issued fork identity, opaque |
| `fork_parent_session_id` | Main Aiterm seat ID supplied by the launcher (`THROUGHLINE_PARENT_SESSION_ID`), opaque |

The label is written only from the launcher-authoritative marker. It is never
inferred from timing, copied prompts or native parent metadata alone. Once
written, later captures do not clear it (`markForkSession` only sets values).
`markForkSession` refuses (`main_records_exist`) a row that already holds bodies
and is not a fork: mislabelling would erase a main seat's automatic memory.
Every entrypoint labels before it writes bodies, so a new fork row has none.

## Launcher marker (Aiterm 0.70.6, Elegg)

A seat started with `agent_launch.fork_from` has, in its process environment,
`THROUGHLINE_SESSION_KIND=fork`, `THROUGHLINE_PARENT_SESSION_ID=<main Aiterm seat id>`
and `THROUGHLINE_FORK_ID=<caller fork_id>` (absent when none was sent). A normal
seat has none; a resumed fork keeps them. `session-kind.forkIdentityFromEnv` is the
only reader. Claude forks run `--resume <main> --fork-session`, so hooks see the
fork's new session ID. A Codex fork rollout carries native `forked_from_id` in
`session_meta` but not the developer-instructions launch marker.

## Function diagram

| Caller | Function / source | Result |
| --- | --- | --- |
| Claude/Cursor/Grok `session-start` | `markForkSessionFromEnv` before predecessor/pending | Fork row labelled; no `/clear` predecessor, no pending handoff (`intent_note: fork_session`) |
| `prompt-submit` | `markForkSessionFromEnv` before `executeFirstPromptHandoff`; `forkIdentityFromEnv` before baton | Labels a fork whose SessionStart did not run; a fork writes no `/tl`/`/clear` baton (the project's one baton stays main) |
| `turn-processor` Stop | `markForkSessionFromEnv` before merge-target and bodies | Label survives restart/replay; a fork that skipped SessionStart is still labelled before its first body |
| `codex-hook` / `codex-capture` CLI -> `captureCodexRolloutToDb({fork})` | env marker **and** rollout `forked_from_id` (`codex-thread-index` candidate) | `forkLabel: 'marked'`; env without `forked_from_id` = `not_fork_rollout` (thread mismatch, left main); `forked_from_id` without env = user's own Codex fork, left main |
| `remote-ingest.ingestRemoteTranscript` | optional `sessionKind: 'fork'`, `parentSessionId`, `forkId` | Labels the remote session row before bodies; any other `sessionKind` is `E_REMOTE_INPUT` |
| `claude-auto-handoff.requestClaudeAutoHandoff` (PreCompact) | `forkIdentityFromEnv` | `skipped`/`fork_session`, compaction passes, no record or successor. Codex auto handoff already runs only for Codex Desktop threads |
| Automatic selectors | `session-kind.mainSessionFilter(db)` | SQL fragment `AND session_kind IS NULL`, or empty on a DB without the column (read-only opens do not migrate) |
| `session-start.findLatestClaudePredecessor` | main filter | A fork never becomes the `/clear` predecessor |
| `cli/handoff-context.readLatestProjectHandoffContext` / `readRecentProjectHandoffContext` (also remote handoff) | main filter | No fork L2/L3/L1 in latest or recent automatic memory; fork-only project returns `empty` |
| Default latest selectors: `latest-session`, `handoff-preview`, `codex-resume`, `codex-handoff-start`, `codex-summarize`, `codex-handoff-smoke`, `codex-handoff-model-smoke`, `codex-visibility-smoke` | main filter | Default target is the newest main session; explicit `--session` is unchanged |
| `session-merger.mergeSpecificPredecessor` | `isForkSession` on both sides | `skipReason: 'fork_session'`; a fork neither absorbs nor is absorbed into main records |
| `handoff-executor.executeFirstPromptHandoff` | `isForkSession(sessionId)` before any consume | A fork leaves the main seat's pending/baton/auto-continuation state untouched |
| Explicit reads: `handoff-context --session`, `recall` | `readSessionKind` | Return the fork records as before, labelled (`sessionKind: 'fork'` in JSON, a header line in recall) |

Not changed: retention, long-term candidate ingestion, `doctor` capture counts,
`detail`, and summary generation. Automatic summary contribution of fork turns is
off; enabling it later needs a Biscuit-agreed source, provenance, size bound and
rendering contract.

## Data-flow diagram

| From -> to | Data | Boundary |
| --- | --- | --- |
| Aiterm launcher (Elegg) -> local hook process env | `THROUGHLINE_SESSION_KIND`, `THROUGHLINE_PARENT_SESSION_ID`, `THROUGHLINE_FORK_ID?` | Present from the first hook; resumed forks keep it |
| Codex rollout `session_meta` -> Codex capture | `forked_from_id` | Binds the env marker to the fork rollout; never sufficient alone |
| BellTeam execution (C7) -> remote intake | `sessionKind`, `parentSessionId`, `forkId?` | Execution's authenticated launch knowledge; not yet sent by the producer |
| Capture -> product DB `sessions` | `session_kind='fork'`, `fork_id`, `fork_parent_session_id` | Survives restart/replay; never cleared by later captures |
| Product DB -> automatic main memory (predecessor, latest, recent, remote handoff) | main session rows only | Fork rows filtered in SQL before any body/summary is loaded |
| Product DB -> merge / first-prompt handoff | main session rows only | Fork on either side skips; main baton/pending stay for the main successor |
| Product DB -> explicit reads | requested fork records + label | Readability does not opt fork content into automatic memory |

Connections: overall [README](README.md), entrypoints
[current-entrypoints](current-entrypoints.md), projections
[current-projections](current-projections.md), remote [remote-ingest](remote-ingest.md).
