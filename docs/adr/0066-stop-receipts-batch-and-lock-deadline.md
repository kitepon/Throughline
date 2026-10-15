# ADR 0066: Publish Stop receipts in one transaction with a bounded lock wait

- Status: Accepted
- Date: 2026-10-15

## Evidence

Windows 0.16.34 logged two `HOOK_PROCESS_TURN_FAILED` failures on 2026-10-15
at 21:42:14 and 22:26:23 JST. Both failed at `BEGIN IMMEDIATE` in
`completed-turn-receipts.mjs` with SQLite errcode 5. The L2 pairs were already
committed. The session had 72 captured pairs by 22:29 JST and overlapping Stop
calls after short responses. This differs from the container's ADR 0065 failure.

An isolated native Windows writer holding the receipt lock for 14 seconds makes
0.16.34 fail with `database is locked`. The five-second wait is shorter than the
holder's allowed Windows ACL work: verification of the existing store and
protection of its replacement can each run for 15 seconds. Replaying every
captured pair separately also repeats directory/lock/store ACL processes for all
previous pairs on every Stop.

## Decision

1. Resolve and validate all captured DB pairs before receipt publication. Publish
   one Stop's ordered pairs with one lock, one store read and at most one atomic
   replacement. A retry returns the original retained pair identities/sequences.
2. Keep the single-pair API as a wrapper over the batch API. Reject mixed-project
   batches before any store mutation. Retain schema, 256-receipt limit, hashes,
   sequence order, owner-only ACL checks and atomic replacement.
3. Wait at most 60 seconds for the receipt lock. This permits the existing bounded
   ACL work plus contention. Lock exhaustion and ACL failures remain explicit;
   neither advances the receipt store. No timeout change to host hook settings.
4. Do not modify the live DB, manufacture completion receipts, stop a live
   conversation, or run handoff operations to demonstrate recovery. Use isolated
   copies/synthetic pairs for failure reproduction and normal subsequent Stops
   for production recovery evidence.

## Applicability

The common Stop processor is used by Claude Code, Grok and Cursor on Linux,
macOS and Windows. The new failure was observed only in Windows Claude Code;
source applicability does not establish a production failure in other cells.
Codex uses its own capture/completion boundary and is unaffected. Verify common
processor and ACL behavior in tests and native OS smoke; record harness-specific
live evidence separately.
