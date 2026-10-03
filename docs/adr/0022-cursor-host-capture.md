# ADR 0022: Treat Cursor as a first-class Throughline host

Date: 2026-08-24

## Status

Accepted

## Context

dotagents Wave 5 made Cursor a peer factory harness. Throughline still had only Claude / Codex / Grok adapters. Cursor parent sessions were not captured.

Cursor hook envelope is not Claude PascalCase and not Grok camelCase. Official events are `sessionStart`, `beforeSubmitPrompt` (Claude `UserPromptSubmit` 相当), and `stop`. Common fields include `conversation_id`, `workspace_roots`, `cursor_version`, and optional `transcript_path`.

L2 lives in `~/.cursor/projects/<slug>/agent-transcripts/<uuid>/<uuid>.jsonl` with role-first rows (`{role, message.content}`), not Claude `{type, message}`.

`beforeSubmitPrompt` stdout is `{continue}` only. `sessionStart` may return `additional_context`. Cursor has a single `~/.cursor/hooks.json`; factory hooks already occupy that file.

## Decision

- Detect Cursor envelope (`cursor_version` or `hook_event_name` in the Cursor event set) as host=cursor.
- Shared hook stdin parsing accepts one leading UTF-8 BOM, as emitted by Windows Cursor. It preserves BOM characters inside JSON strings and still rejects malformed JSON.
- When `transcript_path` is absent, derive the project folder with Cursor's `utils/workspace-paths` rule: replace non-ASCII-alphanumeric characters with `-`, collapse consecutive hyphens, and remove leading/trailing hyphens. A supplied `transcript_path` remains authoritative.
- Normalize to the existing snake_case hook contract and prefix ids with `cursor:`. Strip optional `bc-` from cloud conversation ids when looking up transcripts.
- Prefer payload `transcript_path`. If absent, derive the agent-transcripts path. Do not invent a Claude-shaped transcript.
- `throughline install` upserts product hooks into `~/.cursor/hooks.json`. Keep factory / personal commands. Command is absolute `node` + `bin/throughline.mjs`. Do not write factory.json. Do not write bare `throughline`.
- Cursor `sessionStart` of a new composer conversation is the handoff injection mouth (`additional_context`). Consume pending there. Skip `is_background_agent`. Claude ghost-SessionStart rules stay on Claude.
- `/tl` writes a baton. Do not auto-launch a successor Cursor chat. The next new conversation's `sessionStart` drinks the baton.
- Keep Claude, Codex, and Grok adapters unchanged. Do not mix `cursor:` rows into Claude predecessor search.

## Consequences

- Cursor capture / restore / `handoff-context` reuse the existing DB after hook fire exists.
- Live injection in the same conversation after `/tl` is not a Cursor contract (no additional_context on `beforeSubmitPrompt`).
- Factory apply-cursor-config must keep Throughline commands, matching the existing personal-hook upsert.

## 現在地

公式 Cursor hooks 文書（2026-08-24）とこのMacの
`~/.cursor/projects/Users-kite-Developer-dotagents/agent-transcripts/<uuid>/<uuid>.jsonl`
を実測した。公開後の新規 Cursor session 受入は別 H。
