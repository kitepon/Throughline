# Windows Claude terminal handoff acceptance — 2026-10-17

All times are JST. This is the Windows repair scope, not a claim that every live
OS/harness combination has been accepted.

## Incident and change

A shared Claude background service restarted under a different process context.
The normal-user handoff could not reach it. Its failed successor had no transcript
or receipt, while Throughline 0.16.37 retained an unknown state and blocked the
source's tools. Restarting the shared service once had not prevented recurrence.

The owner's contents were restored at 23:14 using an independently owned hidden
terminal, with the original model, effort and permissions. The old conversation
was not stopped, moved or renamed. Its private transcript backup and connection
URL are retained in the maintainer's private incident record, not this repository.

## Final candidate on native Windows

- Normal user, Windows interactive session 1; both the dedicated WMI worker and
  the native Claude child had non-elevated tokens. Claude Code 2.1.302.
- A dedicated trusted test project and synthetic source/session IDs only. The
  source fixture set old session/PID/background environment variables.
- The final candidate received the real successor prompt in 3,701 ms at
  23:58:58.082. The original pending tool stopped only after memory acceptance.
- The source process exited. The same successor subsequently executed Read and
  Write and copied a nonce that was absent from the initial continuation prompt.
- Source and successor each had a user/assistant L2 pair. The real Stop saved
  Read and Write L3 input/output records. Remote Control registered the exact
  successor, with its original UUID preserved.
- Haiku was used for acceptance. Only the synthetic test used bypassPermissions,
  matching the incident's source permission mode. An earlier auto-mode run
  correctly waited for permission to Write; it was not counted as a completed
  execution and its approval was not bypassed.
- A separate HOME with a fake CLI exiting 77 released the first source tool in
  2,407 ms. The terminal's actual exit was recorded, no successor remained, and
  no database was created. This was not fault injection into the owner's work.
- With the accepted test session still alive, its isolated installation was
  updated from 0.16.38 to a metadata-only 0.16.38-update-probe.0 fixture at
  23:32:35.978. npm succeeded and the same native process remained alive. No
  fixture version was published. The worker's cwd is product state rather than
  the installation, and the dedicated worker exits after its terminal closes.

An earlier candidate pinned its installation/bin as cwd and the isolated update
failed with EBUSY. This was corrected before publication; only completed
synthetic workers were removed. The real recovery terminal remained running.

## Source identity

These are the implementation bytes accepted by the final candidate; release
commit, registry identity and post-installation results are recorded separately.

| File | SHA-256 |
|---|---|
| `src/claude-auto-handoff.mjs` | `98a1e35a8504287bec99c75b471f15f65fe938c389f51b717bac2e0de3780e50` |
| `src/os/claude-terminal.mjs` | `5b7f45237b987cc2f480a63b6086d1ffef30f7d0016165a6b0cc029fd9d9a511` |
| `src/cli/auto-handoff.mjs` | `b307175212f0edb7538a21232325534884f3c123ef990b8787d46cdf3c259c7c` |

## Verification limits

The local suite passed 1,104 tests with 2 skips. Focused tests cover the terminal
lifetime, exact receipt and link identity, environment privacy, initial failure
continuation and absence of shared-daemon calls. Release CI runs the regression
suite on Linux, macOS and Windows. Linux/macOS keep their existing launcher;
Codex, Grok and Cursor hooks are unchanged. CI is not live acceptance of those
applications or installation on those machines.

Native Remote Control registration was verified; this record does not claim an
inspection of the owner's Desktop screen. The shared daemon and its existing
workers were not restarted as part of this repair.

The launcher uses Microsoft's documented
[Win32_ProcessStartup](https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/win32-processstartup)
environment and process-start fields and
[node-pty](https://github.com/microsoft/node-pty) for ConPTY ownership.

## CI fixture correction

The first Windows full CI still used a batch-only fake CLI. A batch file could
leave a command shell waiting instead of exiting, so those fixtures timed out.
The fake now uses the same PowerShell shim form as the supported Windows
launcher. Batch-only shims are rejected before allocating a terminal, keeping
the first source tool available. A separate regression test verifies that a
terminal failure is published only when the worker can finish, so recovery of
the source cannot race a later write from the failed worker.
