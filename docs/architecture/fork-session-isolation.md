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
| `fork_parent_session_id` | Native parent session ID supplied by the launcher, opaque |

The label is written only from the launcher-authoritative marker. It is never
inferred from timing, copied prompts or native parent metadata alone. Once
written, later captures do not clear it (`markForkSession` only sets values).

## Function diagram

| Caller | Function / source | Result |
| --- | --- | --- |
| Capture entrypoints (SessionStart, Stop, Codex capture, remote intake) | `session-kind.markForkSession` | Persists the fork label on the session row. **Wire input pending**: the Elegg launch-marker contract has not been supplied, so no entrypoint calls it yet |
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
| Launcher (Elegg) -> capture | fork kind, fork ID, parent session ID | **Pending contract.** Must arrive before the first capture/handoff; local Claude/Codex and remote C7 |
| Capture -> product DB `sessions` | `session_kind='fork'`, `fork_id`, `fork_parent_session_id` | Survives restart/replay; never cleared by later captures |
| Product DB -> automatic main memory (predecessor, latest, recent, remote handoff) | main session rows only | Fork rows filtered in SQL before any body/summary is loaded |
| Product DB -> merge / first-prompt handoff | main session rows only | Fork on either side skips; main baton/pending stay for the main successor |
| Product DB -> explicit reads | requested fork records + label | Readability does not opt fork content into automatic memory |

Connections: overall [README](README.md), entrypoints
[current-entrypoints](current-entrypoints.md), projections
[current-projections](current-projections.md), remote [remote-ingest](remote-ingest.md).
