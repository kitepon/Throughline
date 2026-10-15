# Windows Stop receipt lock repair (2026-10-15 JST)

## Production evidence

The Windows host `windows-workstation` is distinct from `bellteam-container` even
though both use fingerprint
`08be80f2f59b293a7efb5d58dcc584f663e40f2fa9f8dff0865a1d957d8c35ee`.

The native user store had new 0.16.34 Stop failures at 21:42:14.839,
22:26:23.742 and 22:41:49.167 JST, all SQLite errcode 5 at the receipt-store
`BEGIN IMMEDIATE`. Compared with the 04:40 check, hook failure log lines increased
from 6 to 9. Local cumulative Stop count is 22, not the central historical count 64.
The runtime store records the last failure at 22:41:47.904; the failure-detail log
is later because its own recording follows runtime-error collection.

The MSIX store under `Claude_pzs8sxrjxfjjc/LocalCache/Local/throughline` still has
count 64, product version 0.10.3, last occurrence 2026-08-30 21:56:26.128 JST,
resolved at 2026-10-10 13:17:32.935 JST. It was last reported on 10/12 09:15:52.128
with CLI version 0.16.25. It has no new occurrence on 10/15. Thus actual new
0.16.34 failures are independently proven by the native store and stack logs;
the central cumulative 64 is not a count of this incident's failures.

At 22:46 the affected session had 79 L2 pairs, with receipts matching the first
77 pairs under the production NFC/newline/trim digest contract. The two latest
pairs were still pending publication during live Stop activity. All earlier
pairs, including those near failures, had receipts. No handoff operation exists
for this session. L3 completeness is not established by that L2/receipt check.
No conversation text or task title was displayed. No production capture, DB
repair, handoff or conversation stop was performed.

An authenticated product report was accepted with report ID
`15e914c4-8af0-432f-a33d-cd6a298d6f24`, acknowledged through sequence 95,
containing the native open occurrence count 22 and no resolution. Host-specific
central reconciliation is requested from BugHub's maintainer; it must retain
the container resolution and the Windows open state independently.

## Repair and isolated acceptance

See [ADR 0066](../docs/adr/0066-stop-receipts-batch-and-lock-deadline.md).
The synthetic tests use separate HOME/USERPROFILE, XDG directories, and Windows
LOCALAPPDATA/APPDATA. No real DB/receipt/runtime store is used.

- Native Windows 0.16.34 with a synthetic competing writer holding the receipt
  lock for 14 seconds: errcode 5, `database is locked`, exit path after 6,669 ms.
- Same test with the repaired source: success after 15,280 ms.
- Two simultaneous real `process-turn` invocations with 72 synthetic captured
  pairs: Linux exits 0/0 in 67 ms; macOS 0/0 in 92 ms; Windows final 0.16.35
  package 0/0 in 2,917 ms. Each has 144 L2 rows, exactly 72 unique receipts,
  next sequence 73 and zero failure-log lines.
- Linux full suite: 1,090 tests, 1,088 passed, 2 skipped, 0 failures.
- macOS focused receipt/processor suite: 38 passed, 0 failures.
- Windows focused receipt/processor suite: 38 tests, 36 passed, 2 POSIX-only
  skips, 0 failures. Final native Stop smoke: 2,793 ms.
- Documentation and packed Markdown link checks pass.

The initial Windows native unit invocation passed a drive path to Node's
`--import` and failed before running tests. Using the package directory and its
relative `./src/test-env.mjs` corrects this test-command issue. The native Stop
smoke succeeded separately. Early repaired-source probes retained the pre-bump
0.16.34 package label; the two changed production files are unchanged by the
0.16.35 version/changelog update. Native final-package tests identify 0.16.35.

## Applicability versus confirmation

| OS | Claude Code | Codex | Grok | Cursor |
|---|---|---|---|---|
| Linux | Common processor changed; isolated native Stop and full suite pass; no new production error | Capture unchanged; installed diagnostic ready; no live turn forced | Common Stop changed; adapter/unit coverage; live harness not rerun | Common Stop changed; adapter/unit coverage; live harness not rerun |
| macOS | Common processor changed; native focused and Stop smoke pass; no new production error | Capture unchanged; installed diagnostic ready; no live turn forced | Common Stop changed; live harness not rerun | Common Stop changed; live harness not rerun |
| Windows | New real failures proven; native contention reproduced; isolated repaired Stop passes | Capture unchanged; installed diagnostic ready; no live turn forced | Common Stop changed; live harness not rerun | Common Stop changed; live harness not rerun |

Live harness activity is not started to prove a receipt-store repair; shared
processor/ACL behavior is tested directly. Full-harness success is not claimed.
Production acceptance requires the published package installed through the
regular updater with unchanged hook configuration/trust, and subsequent normal
Stops without recurrence. Only then may Windows resolve/report be sent.
