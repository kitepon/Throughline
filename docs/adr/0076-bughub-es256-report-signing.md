# ADR 0076: runtime error report can be signed by an external signer (BugHub-ES256)

- Status: accepted (2026-11-28)
- Related: [ADR 0025](0025-runtime-error-reporting.md)

## Context

[ADR 0025](0025-runtime-error-reporting.md) signs each report with `HMAC-SHA256(secret, ...)`, so the receiver's secret sits in a credential file on every machine.
The owner's rule (2026-11-28) is that no key leaves the authentication module. The receiver (BugHub) now accepts `BugHub-ES256`: the private key stays in the
authentication module, the receiver keeps only the public key, and its answer is signed with its own key.

## Decision

1. A credential file may take a second exact shape: `{ "url", "key_id", "sign_command", "response_public_key" }`. The HMAC shape `{ url, key_id, secret }` stays valid. Any other key set is refused.
2. `sign_command` is an argv array whose first element is an absolute path; it is run without a shell. Throughline writes `<ts>\n<SHA-256 hex of the exact body>` to a private temporary file and gives the command that file as standard input (a file, not a pipe: the Windows ssh client hangs on a pipe).
   Exit 0 and a standard output that is the base64 of a 64-byte raw r||s are the only accepted signature; stderr is never read. At most 1 KiB of output and 20 s.
3. The header is `Authorization: BugHub-ES256 key_id=<key_id>, ts=<ts>, sig=<base64>`. The signed text is the same as the HMAC one.
4. An acceptance is acknowledged only when it is `200`, `accepted: true`, the same `report_id`, `sig_alg: "ES256"` and an ES256 signature over `report_id + "\n" + received_at` that verifies with `response_public_key` (PEM or base64 SPKI DER, P-256 only). A missing or wrong signature leaves the records pending (`unverified_response`).
5. A signer that fails, times out or prints anything else is `signer_unavailable` (retry after the normal 1 h interval; the credential is not at fault). Nothing is sent and nothing is acknowledged.
6. Throughline names no authentication module, host or route: how the command reaches the key (the module's `auth sign` directly, or ssh to a host that has it) is the credential file's business. The file runs code, so the POSIX owner/mode/symlink checks of ADR 0025 apply unchanged.

## Consequences

- A machine can report without any secret on it; the file holds a public key, a key ID and a command line.
- The sign command is a new local process per report (at most once an hour per machine).
- If the signer is unreachable, error records stay pending until it is back; collection is not affected.
