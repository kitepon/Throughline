# Remote Claude transcript intake

Owner: Throughline. Consumer: BellTeam execution C7 (PR 765). Completion source:
Aiterm `agent_done` / Claude Stop, remote-terminal contract at `b35eb48`.

## Public contract

`throughline remote-ingest --json` consumes one JSON object on stdin:

```ts
{
  botId: string,
  sessionName: string,
  launchId: string, // native 32 hex launch identity
  claudeSessionId: string,
  entries: string[],
  cursor: { claudeSessionId: string, offset: number }
}
```

Success is `{schema: 'throughline.remote_ingest.v1', status: 'ready', ackedCursor}`.
`throughline remote-handoff-context --bot <botId> --json` returns the existing
`throughline.handoff_context.v1` ready/empty JSON with recent sessions and silent
disclosure. Execution adapts these to `ingest(input) -> {ackedCursor}` and
`handoffContext({botId}) -> string`; it must not import private source or read DBs.

Every entry is one complete original JSONL line including LF/CRLF. Cursor offset
is the exclusive original UTF-8 byte offset, starting at zero. Range start is
`end - sum(byteLength(entries))`. Cursor and enclosing session IDs must agree.
The provider authenticates Bot/session/launch and supplies only the prefix bounded
by the latest native-confirmed Stop; execution waits for completion after a
mid-turn reconnect. No unfinished tail is forwarded. A line flushed after Stop
is included in a later completed read. A transport byte page can split a logical
turn: later bytes update its projection without duplicating the pair.

## Function diagram

| Caller | Function / source | Result |
| --- | --- | --- |
| Remote native Stop/reconnect | Terminals/Aiterm transcript read, execution binding validation | Original completed-prefix lines + byte cursor |
| Execution ingest | `bin/throughline.mjs` -> `cli/remote-context.mjs` -> `ingestRemoteTranscript` in `remote-ingest.mjs` | Validate range; compare overlap; atomically store source + L2 + cursor; ACK |
| Execution launch preparation | `remote-handoff-context` -> `readRemoteHandoffContext` -> existing `readRecentProjectHandoffContext` | Existing 9,500-character short-term memory text, isolated to this Bot |
| Private remote DB connection | `db.openDb(path)` | Existing schema 13/migrations/locking, caller closes connection; shared `getDb()` keeps its singleton contract |
| Conversation projection | Existing parser/grouping logic exposed as `parseTranscript` / `groupTranscriptTurns` | User/last non-junk assistant pairs; existing file readers delegate to the same logic; append updates preserve one stable group identity |

The overall architecture links here; existing Stop and local handoff connections
stay in [entrypoints](current-entrypoints.md) and [projections](current-projections.md).

## Data-flow diagram

| From -> to | Data / owner | Commit / recovery |
| --- | --- | --- |
| Native transcript -> public stdin | Byte-exact original lines, bound Bot + Claude session | Native source remains; execution stores only ACK cursor |
| Validated input -> per-Bot private SQLite | `~/.throughline/remote-transcripts/<sha256(botId)>.sqlite`; `remote_transcripts` owns raw BLOB, offset and seat/launch provenance | Source/L2/cursor share one SQLite transaction; only committed state is ACKed |
| Stored raw + new suffix -> existing in-memory parser | Product-owned raw JSONL; parser assigns stable user line number to each group | No temporary plaintext snapshot; raw JSONL retained only in SQLite |
| Parsed pairs -> same per-Bot SQLite | Existing sessions/bodies schema; origin = hash(Bot, Claude session), project = Bot-isolated virtual project | Upsert user + assistant under the user line number; late final text updates prior partial page; missing source timestamps preserve the first capture time; no second pair |
| Read-only SQLite -> existing recent renderer | Only this Bot's sessions | No cursor advance, no local-seat DB write, no model/backend invocation |
| Commit -> execution | Latest durable cursor for this Claude session | Lost ACK replays identical bytes; older replay returns current ACK without changing ordering |

Stable source identity is `(botId, claudeSessionId)`, across sessionName/launchId
changes. Different Claude sessions for one Bot coexist. Different Bots have
different DBs even if their native Claude session IDs collide. New remote stores
reuse core schema 13 plus a private intake table; the shared local DB is untouched.
Remote handoff selects main sessions only ([fork isolation](fork-session-isolation.md));
remote fork labelling needs the pending launcher marker in authenticated input.

## Errors, exits and scope

| Error | Protected state | Automatic recovery |
| --- | --- | --- |
| `E_REMOTE_INPUT` | Source identity/byte accounting | Correct bound request; original cursor unchanged |
| `E_REMOTE_GAP`, with `expectedCursor` | Missing source prefix | Execution reads again from returned durable offset (or zero after restart) |
| `E_REMOTE_CONFLICT`, with `expectedCursor` | Previously stored source bytes | Execution re-reads original bytes; a genuinely new native transcript uses a new Claude session ID |
| `E_REMOTE_STORE` | Committed conversation/cursor | Transaction rolls back, connection closes, execution retries the unacknowledged range |

Errors expose fixed codes and recovery cursors, never transcript text or native
paths. SQLite releases its write lock on close/process exit. Private file and
directory modes/ACLs protect transcript contents; no secret is requested.

This addition covers raw transcript durability and L2 short-term handoff. Raw
tool/thinking/system lines remain preserved. It does not run L1 summarization,
project remote L3 into `details`, or add a completed Observer feed. Existing
local hooks, L1/L3, Observer receipts and local handoff remain unchanged.
The existing renderer's `recall`/`detail` hints require access to this server-side
store; a terminal-side pull transport is outside this short-term memory API.
Focused verification covers replay/overlap/conflict/gap, Unicode/CRLF offsets,
restart and failed transaction recovery, late/page-split final text, empty reads,
Bot/session isolation, budget/silent recent rendering and unchanged local handoff.
