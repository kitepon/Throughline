---
name: throughline
description: Use when the user asks to use Throughline from Codex, continue or restore Throughline memory, export read-only handoff context for a local launcher, prepare a new Codex thread handoff, summarize a captured Codex session, or check whether the Throughline Codex Stop hook captured the current session. Hide long Throughline command details behind this workflow.
---

# Throughline

Use this skill to operate Throughline from Codex without making the user type long
commands.

If the user invokes `$throughline` by itself, treat that as a request to prepare
a fresh Codex thread handoff from the current Throughline memory. The normal
path is not a current-thread trim/rollback path: it starts a new Codex thread
through app-server, injects the handoff memory as a developer item, and opens
that thread in the selected host.

## Core Rule

Do not ask the user for a Codex thread id when the current environment can
provide it. Prefer the current `CODEX_THREAD_ID` / `THROUGHLINE_CODEX_THREAD_ID`
identity.

For bare `$throughline`, do not run doctor / dry-run / preflight first and do
not ask for confirmation. Execute the handoff-start command directly. If it
fails, report the error plainly instead of silently falling back to another
memory source or current-thread rollback.

Choose the open host from the current Codex application surface, not from
environment variables inherited by the shell or a persistent PTY. Pass it
explicitly whenever the surface is known:

- Codex Desktop: `--open-host desktop`
- Codex in VS Code: `--open-host vscode`
- Codex CLI: `--open-host cli`

Use `--open-host auto` only when the Codex surface is genuinely unknown. In
that case, report both the requested and resolved hosts from the CLI result.

## Common Requests

### Bare "$throughline" / "use Throughline"

Run:

```bash
throughline codex-handoff-start --execute --open-host desktop
```

The example above is for Codex Desktop. Replace `desktop` with `vscode` or
`cli` when that is the current Codex surface. Do not copy the host identity
from the shell or PTY that happens to execute the command.

This is the Codex new-thread continuation flow. It does not mutate the current
Codex thread. Report the new thread id, open status, and any manual resume
command if the host could not be opened automatically.

The manual new-thread handoff uses a concise rendering of the DB memory:

- recent work: the latest 8 L2 body rows by default (user and assistant each
  count as a row), with each body capped at 1,600 characters
- older turns: available L1 summaries
- an optional memo and captured latest Thinking, when present in the record
- L3 tool payloads: references only

Use `throughline codex-resume --session codex:<thread-id>` for the full active
work rendering, or `throughline detail <time>` for a specific body and supported
L3 detail. Codex automatic handoff has a separate memory contract: the latest
20 turns as full L2 bodies and older L1 summaries, without Thinking or tool
payload bodies.

If there are no captured turns or no injectable Throughline DB memory, say that
clearly.

### "Throughline status" / "doctor"

Run:

```bash
throughline doctor --codex
```

Report whether:

- Codex hooks feature is enabled
- Codex Stop hook is registered
- VSCode monitor task is registered, and whether `Developer: Reload Window` is
  needed to make the folder-open monitor appear
- current Codex thread and latest DB session match

### "resume" / "memory" / "continue from Throughline"

First run `throughline doctor --codex`.

If the current thread and latest DB session match, render memory with:

```bash
throughline codex-resume --session codex:<current-thread-id>
```

If the user gave a current-work memo, pipe it with `--memo-stdin`.

If the user wants to continue in a fresh Codex thread instead of mutating the
current thread, use:

```bash
throughline codex-handoff-start --session codex:<current-thread-id> --execute --open-host <current-codex-surface>
```

If the user gave a current-work memo, pipe it with `--memo-stdin`. This starts a
new thread and does not mutate the current thread.

### "summarize"

Run:

```bash
throughline codex-summarize --session codex:<current-thread-id> --json
```

Codex-primary summarization uses the Codex CLI backend. Do not claim it fell
back to Claude Haiku.

### "export memory" / "portable fork context"

Run:

```bash
throughline handoff-context --session <exact-session-id> --json
```

This is a local read-only export for another launcher. It requires an exact
session id and returns `schema`, `status`, `sessionId`, and `context`. It does
not create or migrate the database, consume a baton, merge sessions, move
memory rows, or change `sessions.merged_into`. Do not substitute the Observer
completed-turn feed, infer the latest session, or read the SQLite database
directly. If the command fails or returns no context, report that failure
instead of falling back to a different memory source.

### "trim" / "rewind" / "rollback" / "context cleanup"

Default to the same fresh-thread handoff flow as bare `$throughline` when the
user asks to trim, rewind, rollback, clean up context, or use Throughline
memory, unless they explicitly ask to mutate the current Codex thread.

Execute:

```bash
throughline codex-handoff-start --execute --open-host <current-codex-surface>
```

Report only the essential outcome, especially the new thread id and open status.

Preview:

```bash
throughline trim --dry-run --host codex
```

Safe new-thread continuation:

```bash
throughline codex-handoff-start --session codex:<current-thread-id> --execute --open-host <current-codex-surface> --json
```

Report the context reduction estimate from the dry-run when present:

- rollback candidate estimated tokens
- injected memory estimated tokens
- net estimated token reduction and percentage

The estimate is `chars / 4` from rollout text, not an exact host tokenizer
measurement. If rollback candidate turns are `0`, say that this session has no
current trim savings yet under the active keep-recent setting.

Guard check:

```bash
throughline trim --preflight --host codex
```

Execute path:

```bash
throughline trim --execute --host codex --all
```

This is an explicit current-thread rollback / inject diagnostic path. Do not use
it for bare `$throughline`.

## User-Facing Explanation

Explain the behavior simply:

- normal Codex turn end: Stop hook captures DB memory and writes monitor state
- `$throughline` / context handoff: one script command builds new-thread
  handoff memory from Throughline DB, injects it into a new Codex thread as a
  developer item, and opens that thread
- manual handoff memory includes older L1 summaries and, by default, the
  latest 8 L2 body rows capped at 1,600 characters each; optional memo and
  captured latest Thinking may also appear, while tool payloads remain references
- diagnostics such as doctor, dry-run, preflight, current-thread rollback,
  restore safety, and host primitive audit are optional tools, not the normal
  `$throughline` path
