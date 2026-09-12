# Changelog

All notable changes to Throughline are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Pre-`0.3.18` iteration history is preserved as a rollup section near the bottom
since most of those releases were rapid-fire monitor render bug fixes that
shipped to npm but were not individually tagged on GitHub.

## [Unreleased]

## [0.10.17] — 2026-09-12

### 修正

- npm 12が単一要素配列で返す公開版情報を自己更新で受け入れるようにした。
  正常にpackageを更新しても`version_verification_failed`で停止する問題を修正した。
  旧文字列形式を維持し、複数版・空配列・不正な値は後続の設定・移行処理の前に拒否する。
- 公開前の梱包文書検査も、npm 12がpackage名をキーにして返す梱包情報に対応した。

## [0.10.16] — 2026-09-07

### 修正

- WindowsのDesktop引き継ぎで、稼働中のアプリが使うCodex実行ファイルを選ぶようにした。
  PATH上の古いCodexがデスクトップ版の設定を読めず、新規タスクの作成に失敗する問題を修正した。
- 引き継ぎ結果へCodex実行元を表示する。アプリの実体を特定できない場合は理由を出して停止する。

## [0.10.15] — 2026-09-06

### Fixed

- Windowsでnpmから導入したCodexをThroughlineの新規タスク引き継ぎと診断から起動できるようにした。
  OS境界の起動処理を通し、PowerShell 7経由の標準入出力をUTF-8で受け渡す。
- Windowsの起動試験を通常のテストと製品CIへ含め、日本語と接続中の要求・応答を検証する。
- Windowsの起動条件、Codexフックの承認、既存ログの回収を文書化した。
  自動refreshの古い案内を直し、公開版と開発中の版の参照先を分けた。

## [0.10.14] — 2026-09-02

### Added

- `handoff-context --project <path> --json`で、指定project内の会話本文を持つ最新sessionを
  read-onlyで選び、本文がなければ`empty`を返せるようにした。
- `--disclosure silent`を補足ファイルなしで指定できるようにし、埋込製品が短期記憶だけを
  基盤案内なしで受け取れるようにした。

## [0.10.13] — 2026-09-02

### Fixed

- 通常の引き継ぎ案内を最初の応答だけに限定し、project束縛済み補足から
  `handoffDisclosure: "silent"`を指定したlauncherは案内を非表示にできるようにした。
- Throughline旧版がassistant本文へ付けた固定宣言行だけを次回引き継ぎ時に除外し、
  ユーザーの引用と宣言後の会話本文は保持する。

## [0.10.12] — 2026-09-01

### Changed

- 変更した実装の依存関係から必要なテストと工場環境を選び、依存を確定できない変更だけ全件へ広げ、選択jobのskip・cancel・failureを最終gateで拒否する製品所有CIへ更新した。
- 文書だけの変更はLinuxの文書検査だけを実行し、共通・未分類の製品変更は従来どおり3環境で検証する。

## [0.10.11] — 2026-09-01

### Fixed

- Codex 0.151以降が会話本文を`response_item`だけに記録するrolloutでも、userとassistantの
  発言をL2へ取り込む。旧`event_msg`が併記されるrolloutでは同じ発言を二重保存しない。

## [0.10.10] — 2026-09-01

### Fixed

- Grok 1.0.13がcamelCaseとsnake_caseのhook属性を同時に送る場合でも、Grokの
  予約環境変数をhost境界として`grok:` sessionへ正規化する。Stop hookをCursorと
  誤認して同じBotに`cursor:` sessionを作る問題を修正した。
- `latest-session`と`handoff-context`のread-only SQLite接続にも、書込接続と同じ
  5秒の競合待ちを適用した。hook書込と再起動時の記憶読取が重なっても、即時失敗しない。

## [0.10.9] — 2026-09-01

### Fixed

- `handoff-context --supplement-file`は、capture済みsessionに会話本文がまだ無い場合でも、
  同じprojectに束縛された補足記憶だけを9,500字予算内で返す。Cursorの初回Workspace
  Trust直後など、session行だけが先に作られたBotも記憶付きで再起動できる。
- Windowsの子プロセスとowner-only ACL処理を、工場標準のPowerShell 7へ統一した。
  製品CIも現行の3環境（macOS・Linux workstation・Windows native）を直接検証する。

## [0.10.8] — 2026-09-01

### Added

- `handoff-context`へ任意の`--supplement-file`を追加した。補足JSONは元sessionの
  `project_path`と一致する場合だけ、長期記憶・RAGとして既存の9,500字枠へ合成する。
  DBの所有権と既存の補足なし出力は変えない。

## [0.10.7] — 2026-09-01

### Added

- `throughline latest-session --project <absolute-path> --json`で、指定した
  projectだけの直近session IDをread-onlyで取得できるようにした。
  BellTeamのような外部ランチャーは、別projectの記憶を混ぜずに既存の
  `handoff-context`境界へ接続できる。

## [0.10.6] — 2026-09-01

### Fixed

- Document the one-time official npm bootstrap required when upgrading from
  v0.10.4 or earlier, whose CLI predates `throughline self-update`. Once the
  current CLI is installed, all later updates continue through the single
  `throughline self-update` entry.

## [0.10.5] — 2026-09-01

### Added

- `throughline self-update` now owns the complete product update path: official
  npm package update, integration reapplication, existing-database migration,
  installed-version verification, and public diagnostics. Factory callers no
  longer need to interpret Throughline's migration schema. It resolves the new
  CLI from npm's global root, rejects old-CLI help or malformed handshakes even
  when they exit zero, requires overall diagnostics readiness, preserves child
  errors, and uses `npm.cmd` through PowerShell 7 on Windows. It also refuses a
  mixed-prefix update when the public `throughline` on PATH does not resolve to
  the newly installed CLI and version.

### Fixed

- Session inheritance now refuses to reassign L1/L2/L3 memory when the named
  predecessor and successor belong to different projects. Project-scoped
  predecessor discovery already filtered candidates, but the final merge
  state transition did not enforce the same ownership invariant itself.

## [0.10.4] — 2026-08-30

### Changed

- Runtime-error collection is now configured and owned by Throughline itself.
  `throughline runtime-errors enable|disable --json` writes the private,
  versioned product config under the Throughline config directory. The runtime
  no longer reads dotagents factory-reporter configuration; factory integration
  uses the public `runtime-errors ... --json` boundary.
- Corrected the documented Claude handoff boundary: built-in `/clear` does not
  reach `UserPromptSubmit`; VS Code uses `SessionStart source='clear'`, while
  Claude Desktop requires `/tl` before `/clear`.
- Moved the completed v0.4 auto-handoff plan into `docs/archive/` and replaced
  the current path with a concise current contract. Fixed Lattice consumers of
  other archived plans keep small compatibility entrypoints.
- Product-owned CI now runs `npm run verify:docs` for Markdown-only changes,
  checking local links, the document/archive indexes, compatibility stubs, and
  relative link/image closure inside the actual npm tarball file list.
- The Windows-native product CI path now uses PowerShell 7 exclusively.

## [0.10.3] — 2026-08-24

### Added

- Cursor を first-class hook host にする（工場 Cursor harness campaign Wave 6）。
  - envelope は `hook_event_name=sessionStart|beforeSubmitPrompt|stop` と
    `conversation_id` / `cursor_version`。session id は `cursor:<uuid>`。
  - L2 は payload の `transcript_path`、無ければ
    `~/.cursor/projects/<slug>/agent-transcripts/<id>/<id>.jsonl`。
  - `throughline install` は `~/.cursor/hooks.json` へ絶対 `node` +
    `bin/throughline.mjs` の sessionStart / beforeSubmitPrompt / stop を upsert
    する。工場 hook（`cursor-*-hook`）は残す。bare `throughline` は書かない。
  - beforeSubmitPrompt は continue のみなので、引き継ぎ注入は sessionStart の
    `additional_context`。`/tl` 後継の自動起動はしない。
  - Claude / Codex / Grok 契約は変えない。

## [0.10.2] — 2026-08-24

### Changed

- 挙動不変のOS/harness層集約リファクタ（harness用語統一campaignの分離規約）:
  - LOCALAPPDATA / XDG_CONFIG_HOME / XDG_STATE_HOME のベースディレクトリ組み立てを
    新設`src/os/app-dirs.mjs`へ一本化（runtime-error-store / completed-turn-receipts
    に3重実装されていた）。
  - hostリテラル比較（`'claude'`／`'codex'`）6ファイルを`src/hosts/identity.mjs`の
    定数importへ統一し、「識別の唯一の正本」宣言と実装を一致させた。
  - codex-auto-refreshの独自パス正規化を`src/os/paths.mjs`の
    `foldPathCaseForPlatform`へ、codex-sidecarのwin32判定を同`isWin32Platform`へ委譲。
  - `hosts/identity.mjs`の分類語をvendorからharnessへ更新（用語のみ）。

## [0.10.1] — 2026-08-23

### Changed

- Internal refactor with no behavior change. Vendor (hook host) identity and
  per-host behavior moved into `src/hosts/` — `hosts/identity.mjs` is the
  single source of the `codex:` / `grok:` session prefixes (previously
  duplicated across four files), and the shared hook entrypoints
  (`session-start` / `prompt-submit` / `process-turn`) now branch through
  `hosts/{claude,codex,grok}.mjs` adapters instead of inline host checks.
  `src/hook-envelope.mjs` is merged into `hosts/grok.mjs`.
- OS-specific code moved into `src/os/` — the Windows owner-only ACL
  PowerShell implementation that was duplicated verbatim in
  `runtime-error-store` and `completed-turn-receipts` is now the single
  `os/windows-acl.mjs`, alongside macOS Terminal launch, OS URL open,
  shell/AppleScript quoting, Windows path case folding, and the portable
  spawn helper. DB schema, injection contract, and every CLI surface are
  unchanged; full regression is 761 pass / 0 fail.

## [0.10.0] — 2026-08-17

### Added

- Grok is a first-class hook host. CamelCase envelopes are normalized to
  `grok:<sessionId>` and L2 is recovered from Grok `chat_history.jsonl`.
  `throughline install` writes `~/.grok/hooks/throughline.json` with absolute
  `node` + `bin/throughline.mjs` commands so Desktop GUI PATH can fire them.
  The v0.9.1 Claude-facing no-op for non-Claude envelopes is withdrawn.
- `throughline grok-continue --session <id>` starts a person-facing Grok seat
  whose first user text is the handoff-context body. cwd is the source
  session's `project_path`, not the caller's cwd. The first user text is
  preamble + context + continue + wait. Missing context or project_path does
  not spawn. `--rules`, aiterm, and `--from` are not used. macOS Terminal only.
- Grok `/tl` writes the baton and then launches `grok-continue` as a side
  effect. Claude `/tl`, Codex `/tl`, and Grok `/clear` do not launch it.
  Empty-L2 sources (including a `merged_into` chain member with no bodies)
  do not spawn. The list of record is the session directory under
  `~/.grok/sessions/<encodeURIComponent(cwd)>/`. Desktop Inactive folding is
  not a success condition.

### Documentation

- README, README.ja, contributor entrypoints, docs overview, ADR 0021
  current state, and the successor-launch plan now state the live Grok
  `/tl` → `grok-continue` contract. Historical ADRs and archived plans
  remain point-in-time records.

## [0.9.1] — 2026-08-14

### Fixed

- Claude-facing SessionStart, UserPromptSubmit, and Stop entrypoints now ignore
  non-Claude camelCase envelopes immediately after JSON parsing and before any
  database, state, VS Code task, handoff, transcript, or runtime-error side
  effect. The boundary requires non-empty `sessionId` and `hookEventName` and
  the absence of Claude's `session_id`; it does not convert payloads or add a
  Grok transcript reader.

### Changed

- CI now uses the shared factory workflow for the maintained native and WSL2
  environments.

### Documentation

- Synchronized the current README, Codex skill, contributor entrypoint, docs
  overview, and implementation plan around the v0.9.0 read-only handoff-context
  contract. Historical ADRs, archived plans, and RAG source records remain
  unchanged as point-in-time evidence.

## [0.9.0] — 2026-08-04

### Added

- `throughline handoff-context --session <id> --json` returns the exact
  budgeted SessionStart inheritance context through a versioned local CLI
  boundary. It opens only an existing database read-only and never creates or
  migrates it, consumes a baton, merges sessions, changes `sessions.merged_into`,
  or reassigns L1/L2/L3 memory rows.

## [0.8.9] — 2026-08-02

### Fixed

- Codex hook diagnosis no longer depends on the caller's `PATH`. The expected
  hook command is rebuilt per invocation, and `resolveCodexHookNodePath` returns
  the PATH form of Node when one is on `PATH` and `process.execPath` otherwise.
  Comparing that string against the registered command classified a correctly
  installed hook as a legacy command whenever the two representations differed,
  so `doctor --codex` reported "legacy command needs reinstall" and
  `factory-diagnostics` reported `codex_hooks` as `not_ready` for every scheduled
  run started from a minimal environment. Hook commands are now compared by
  parsed identity — same Node executable by realpath, same CLI script by
  realpath, same event — so a hook registered as `/opt/homebrew/bin/node` still
  matches an expectation resolved to `/opt/homebrew/Cellar/node/<ver>/bin/node`.
  Hooks pointing at a different Throughline installation, a different event, or
  the legacy PATH-resolved form remain flagged for reinstall, and paths whose
  realpath cannot be resolved are never treated as equivalent.

## [0.8.8] — 2026-08-02

### Fixed

- Codex hook installation now writes the supported `timeout` field in seconds
  for UserPromptSubmit, PostToolUse, and Stop. The previously emitted
  `timeoutSec` field was ignored by Codex, leaving all three hooks at the
  600-second default.
- Reinstall canonicalizes existing Throughline-managed hooks by command
  identity, replacing legacy `timeoutSec` entries while preserving unrelated
  Codex hooks. Doctor reports the effective `timeout` field and explicitly
  flags the legacy key for reinstall; factory diagnostics no longer classify
  the ignored key as ready.

## [0.8.7] — 2026-07-20

### Fixed

- Windows CI no longer calls the completed-turn receipt ACL PowerShell path
  hundreds of times just to construct 256-record boundary fixtures. Boundary
  behavior still crosses the limit through the public API, while dedicated
  tests preserve native owner-only ACL verification and atomic failure safety.
- Completed-turn receipt mutations now spend ACL subprocesses only on distinct
  state transitions: three for a new Windows store and four for a replacement.
- CI keeps the full 3-OS by 3-Node matrix, cancels only older runs for the same
  event and ref, and gives the unit-test step an eight-minute regression guard
  around a five-minute Windows SLO.

## [0.8.6] — 2026-07-20

### Fixed

- Republish the v0.8.5 runtime from a clean worktree after the v0.8.5 npm
  tarball accidentally included one unrelated, uncommitted in-progress
  document written concurrently after the release dry-run. Runtime behavior
  and the database migration contract are unchanged.

## [0.8.5] — 2026-07-20

### Added

- `throughline migrate --json` now provides the product-owned database
  migration entry point used after package updates. It migrates only an
  existing Throughline database, reports a versioned bounded result, leaves a
  missing database absent, and rejects future schemas or migration failures
  with a non-zero exit status.

## [0.8.4] — 2026-07-20

### Fixed

- The installed Codex skill now selects Desktop, VS Code, or CLI from the
  current Codex surface and passes an explicit `--open-host` value. A command
  launched through an older persistent PTY can no longer silently redirect a
  Desktop handoff to the PTY's inherited VS Code or Terminal host.
- `codex-handoff-start` now reports both requested and resolved open hosts in
  JSON and text output while retaining the existing `openHost` field.

## [0.8.3] — 2026-07-20

### Fixed

- Codex fresh-thread handoffs now detect when they were launched from Codex
  Desktop and open the new local task with the app's
  `codex://threads/<thread-id>` deep link instead of spawning a Terminal
  `codex resume` session. `--open-host desktop` is available explicitly;
  VS Code and CLI opening behavior is unchanged.
- Concurrent CLI and Codex hook processes now configure a bounded SQLite busy
  timeout and avoid reapplying WAL mode when it is already active. A transient
  writer or WAL recovery lock no longer makes DB initialization fail
  immediately, and a failed initialization is never retained as the singleton.

## [0.8.2] — 2026-07-20

### Fixed

- Windows native Codex hook commands now prefix quoted Node executables with the
  PowerShell call operator `&`. POSIX command strings are unchanged, and the
  existing managed-hook detector continues to recognize the canonical commands.

## [0.8.1] — 2026-07-19

### Fixed

- **Native factory diagnostics now report the database compatibility label from
  the canonical schema version.** Throughline schema v9 previously emitted the
  stale `throughline.database.v8` label alongside numeric versions `9`/`9`, so
  exact factory reporters correctly classified the installation as
  incompatible. The label is now derived from the DB migration version and a
  regression test requires the label, actual version, and supported version to
  stay aligned on future schema bumps.

## [0.8.0] — 2026-07-18

### Changed (breaking behavior)

- **Injection is now push/pull, and L1 is no longer injected (ADR 0016).** The
  budgeted resume context (9,500 chars) is rebuilt as: header +
  current-position anchor + an always-shown retrieval-guide section as the
  fixed part, then the **entire remaining budget is filled with L2 turns in
  full**, newest-first, turn-atomically (a user+assistant pair goes in whole
  or not at all — no fixed N, no fragment packing). L1 summaries are no longer
  injected; older memory is pulled on demand instead. The guide section bakes
  in the exact session id, ISO-millisecond boundary (strict less-than) and
  turn counts at injection time, so the pull side never recomputes the window.

### Added

- **`throughline recall --l2|--l1` (ADR 0016).** Read-only pull commands the
  injected guide section points at. `recall --l2 --session <id> --before
  <ISO ms> --last <N>` returns the N turns of full L2 bodies older than the
  boundary, in the same line grammar as the injection (including L3 inline
  suffixes). `recall --l1 ... --skip <N>` lists every turn older than the
  `--l2` range with its L1 summary, honestly marking unsummarized turns
  ("全 M ターン / 要約済み K") and always pointing at `throughline detail
  <time>` for full text. The DB is opened read-only; a missing DB is an
  explicit error and is never created or migrated.

### Fixed

- **Windows ACL scripts get a 15s timeout (was 3s).** On windows-latest CI
  runners a cold PowerShell start was measured at 3.0–3.2s, so the 3s
  `spawnSync` cap killed the ACL apply/verify scripts of the completed-turn
  receipt store and the runtime error store and surfaced as a flaky
  "Windows owner-only ACL verification failed" (2 consecutive runs, including
  a docs-only commit). The explicit hard-failure contract is unchanged; only
  the cap was raised.

## [0.7.0] — 2026-07-17

### Changed (breaking behavior)

- **Two-phase handoff (ADR 0014).** Claude Code can fire multiple
  `SessionStart` hooks for the same project within a few hundred ms, and some
  of them never materialize into a real session (no transcript is ever
  written). Such a "ghost" could consume the handoff baton first and silently
  swallow the predecessor's memory while the real session started empty
  (observed twice on 2026-07-17; upstream report:
  anthropics/claude-code#78455). `SessionStart` now only registers a pending
  intent (new schema v9 table `pending_handoffs`); the merge and the context
  injection happen at the session's **first `UserPromptSubmit`** — a prompt is
  proof the session is real, and a ghost never submits one. Baton eligibility
  is measured against the consuming session's birth time (`0 <= birth −
  baton_write <= 1h TTL`); a baton written after the session was born is left
  in place for its true successor instead of being stolen by a running
  session. The auto path (`source='clear'`) freezes its predecessor choice at
  `SessionStart` and skips transcript-less (ghost) candidates.
- **Injection is budgeted to 9,500 chars (ADR 0014).** Hook stdout larger than
  ~10,000 chars is silently persisted to a file by Claude Code and the model
  only sees the first 2KB (measured: 9,501 chars pass inline, 15,286 get
  persisted; every >10k injection since v2.1.195 was degraded this way).
  The resume context now always fits inline: header + current-position anchor
  are kept in full, then L1 and L2 fill newest-first. Dropped L2 rows are
  announced inside the injection with their `[time role]` references so the
  model can retrieve any of them via `throughline detail`.
- **L1 summarization backend and ratio are configurable (ADR 0015).** The
  Claude-primary backend order is now `codex-sidecar` (when configured) →
  Codex CLI (default `gpt-5.6-luna`, reasoning effort `low`, chosen by a
  measured 83-run evaluation) → Claude Haiku → raw L2, with every fallback
  step recording its reason. The compression target is a ratio (default 0.2 =
  1/5 of the source turn). Overrides: `THROUGHLINE_L1_MODEL`,
  `THROUGHLINE_L1_EFFORT`, `THROUGHLINE_L1_RATIO` (invalid ratio values are an
  explicit error, not a silent default). The Codex CLI invocation now passes
  an explicit `-m`; previously `--ignore-user-config` silently ran the CLI's
  built-in default model.

### Added

- Schema v9: `pending_handoffs` table (session_id PK, project_path, source,
  auto_predecessor_id, created_at). Rows belonging to ghost sessions are never
  consumed and stay behind harmlessly.
- The inheritance decision log now records both phases
  (`phase: 'session-start' | 'prompt-submit'`) including injection size and
  dropped-row counts.
- First npm release to include the JSON-only completed-turn Observer CLI
  boundary: `throughline observer-read` (opaque-cursor pages) and
  `throughline observer-wait` (bounded wait up to 3600s). The completed feed
  uses Throughline-owned Claude Stop receipts and Codex rollout
  `task_complete` records; stale DB projection is reported as
  `projection_pending` without bodies (ADR 0002–0013).

### Fixed

- Claude Stop waits for the transcript flush barrier before backfilling
  (ADR 0012), and Observer reads wait out transient SQLite writer locks with a
  bounded busy wait instead of failing hard (ADR 0013).

## [0.6.3] — 2026-07-14

### Fixed

- `throughline factory-diagnostics --json` now reports the Codex hook summary
  as `ready` when all three canonical managed hooks are ready. The Codex-only
  overall aggregate no longer treats the separately exposed, uninspected
  Claude connector as a blocking `unverified` state. The Claude connector
  remains explicitly `unverified`; diagnostic output remains read-only and
  privacy-safe.
- Windows runtime-error mutations no longer repeat identical PowerShell ACL
  verification inside one bounded observation. Existing lock/store files are
  still verified before use, new temporary files receive an exact
  current-SID-only ACL before atomic replacement, and the five-second hook
  observer deadline is unchanged.

## [0.6.2] — 2026-07-13

### Added

- Added an opt-in, local-only runtime error aggregate for BugHub factory
  reporting. Collection requires the canonical dotagents config boolean
  `collection.enabled: true`; it never performs network I/O or accepts raw
  exceptions, stderr, stacks, prompts, sessions, paths, or arbitrary context.
  Fixed hook error codes/templates are aggregated by SHA-256 fingerprint in an
  owner-private atomic store with count, first/last seen, resolve/reopen,
  monotonic cursor/ack, retention that preserves unacknowledged records, and
  bounded `throughline runtime-errors ... --json` snapshot/diagnostics APIs.
- Collection remains disabled by default and the local store sends no network
  traffic. Public commit `e6ce6e3`, CI `29238704750`, npm `latest`, tag / GitHub
  Release, and a registry-derived isolated install were verified.
- Raised the Node.js floor to 22.13, where `node:sqlite` is available without
  an experimental command-line flag; CI now exercises that exact minimum.

## [0.6.1] — 2026-07-13

### Added

- **Spotter auditor context v1.** `throughline auditor-context` adds an
  opt-in, JSON-only, read-only projection for Spotter. It verifies the exact
  session/project and the latest completed L2 user/assistant pair against an
  origin/turn/SHA-256 freshness expectation, supplied explicitly or derived
  from a Claude JSONL or Codex rollout. Only `fresh` returns bounded pair
  bodies; all other states return no bodies. The command never creates,
  migrates, or writes the Throughline DB. Opt-in and any onward transmission
  remain Spotter responsibilities.

## [0.6.0] — 2026-07-12

L2 capture is rebuilt from "save only the last pair each Stop" to a
full-transcript backfill, closing the permanent holes that left `/clear`
handoffs with empty or partial memory. Also documents that Claude Code
Desktop `/clear` cannot be auto-detected by hooks (upstream client bug).

### Fixed

- **L2 capture completeness (backfill).** The Stop hook previously stored
  only the last user/assistant pair, so any Stop that fired before the
  transcript flushed — or did not fire at all — became a permanent gap in
  `bodies`. Measured omission of completed logical turns was 27% (Desktop) /
  41% (VS Code). `turn-processor` now scans the whole transcript into logical
  turn groups and backfills every uncaptured turn (`src/turn-backfill.mjs`
  `backfillBodies`). On a `/clear` merge, `session-start` also backfills the
  predecessor's transcript **before** rendering the resume context, so the
  turn immediately preceding `/clear` is recovered. Verified end-to-end on a
  real Desktop `/tl` → `/clear` handoff (successor inherits the full
  predecessor conversation).
  - Group-level dedup: a logical turn group whose fragments are already in
    `bodies` is skipped whole, preventing duplicate pairs when a turn spans
    multiple Stops (interrupts, plan rejections, AskUserQuestion replies).
  - Representative fragment = the last non-junk assistant fragment; API
    notices (e.g. session-limit messages) no longer overwrite the real reply.
  - `created_at` uses the transcript entry timestamp so bulk-recovered rows
    preserve conversation order for the L2 window / current anchor.
  - Predecessor transcript path is derived deterministically from the project
    path (`deriveTranscriptPath`); the state file is only a fallback, because
    a predecessor whose Stop never fired has no state file.
  - `readTranscript` now excludes `isSidechain` entries.

### Known limitations

- **Claude Code Desktop `/clear` is undetectable by hooks.** Desktop sends
  SessionStart `source:"startup"` (not `"clear"`) and SessionEnd
  `reason:"other"` (indistinguishable from session deletion), so the auto
  handoff path never fires there. Reported upstream
  ([anthropics/claude-code#76704](https://github.com/anthropics/claude-code/issues/76704)).
  Workaround: run `/tl` before `/clear` on Desktop.
- **Desktop can drop assistant text from the transcript entirely.** In long
  tool-heavy turns, intermediate assistant text blocks are sometimes never
  written to the session JSONL (permanent, no local recovery path). Reported
  upstream ([anthropics/claude-code#76706](https://github.com/anthropics/claude-code/issues/76706)).

## [0.5.0] — 2026-05-24

This release closes out the v0.5 transcript-injection investigation and
locks in **path C** (`resume-context.mjs` v2.1 header + 現在地 anchor) as
the plugin-scope completion form for Throughline.

### Changed

- Strengthened the Claude `/clear` resume context header with two new
  short-message handling rules so the cleared-me side stops misreading
  follow-up shorts as fresh requests:
  - **短文/相槌の判定**: any user message that is ≤50 chars or built solely
    out of acknowledgment / agreement / prompt words (はい / うん / 了解 /
    OK / やって / 進めて / 続き / 次) must be treated as a GO sign on the
    previous assistant's proposed next move, not a new request, and the
    cleared-me must not ask back, re-list options, or pivot to other work.
  - **古い番号リストの再実行禁止**: when the latest user references an
    older numbered list (e.g. `2 をやれ`) but the most recent assistant turn
    already executed that item, the cleared-me must respond with a result
    confirmation / next move, not by re-executing the already-done item.
    The latest assistant utterance outranks any older numbered list
    referenced from it.

### Research (no shipped behavior change)

Two alternative injection routes were spiked end-to-end against real
Claude Code (v2.1.145) and both confirmed dead, locking path C as the
plugin-scope ceiling.

- **D route — transcript JSONL append** (Phase 0-2 / Phase 0-5): four
  real-machine runs across `SessionStart` (chain `null` orphan) and
  `UserPromptSubmit` (chain `b` reachable-from-attachment) timings, with
  both synthetic and real Claude model names. All four runs produced
  「ない」when the cleared-me was asked to quote the spike tracer. Root
  cause: Claude Code decides each new turn's `parentUuid` from its
  in-process memory state and never re-reads the JSONL, so any text a
  hook writes to `transcript_path` lives on a parallel chain that the
  next prompt's parent-walk never reaches.
- **`hookSpecificOutput.initialUserMessage` route** (Phase 0-6): real
  Claude Code interactive run on 2026-05-24 13:33 (tracer `9220a79c`,
  session `0979ad20-…`) returned 「ない」, empirically confirming the
  openclaude source comment that `initialUserMessage` is consumed only
  for headless orchestrator sessions, not for the interactive `/clear`
  scenario this project needs.

Both routes are kept in-tree behind marker files
(`~/.throughline/spike-inject.flag`,
`~/.throughline/spike-prompt.flag`,
`~/.throughline/initial-user-message-test.flag`) as research
infrastructure for future re-evaluation; they are no-op when the flags
are absent and have no effect on the shipped path.

### Added

- `docs/archive/10_transcript_injection_plan.md`: full Phase 0 plan and
  result log for the D / `initialUserMessage` investigation.
- `rag/`: third-party spec knowledge base (Claude Code hooks
  reference, Anthropic Messages API, sessions docs, openclaude
  `initialUserMessage` source extract) used as the grounding for the
  no-go calls above.

## [0.4.12] — 2026-05-17

### Changed

- Added a 「現在地 (直前のやりとり)」 anchor at the top of the Claude
  `/clear` resume context injection. The anchor re-surfaces the latest user
  directive and the latest assistant turn body (each truncated to 600
  characters) directly under the header, before the L1 / L2 sections.
  Observed failure mode: with a long L2 window the model's attention could
  fixate on the *first* L2 entry (oldest in the window) and mistake an older
  plan discussion for the current state of the conversation. The anchor pins
  the latest exchange at the position the model reads first, with the existing
  L2-tail anchor preserved as reinforcement. The header reading instructions
  now point to the new anchor as the first bullet.

## [0.4.11] — 2026-05-10

### Changed

- Disabled Codex automatic current-thread refresh from `UserPromptSubmit`,
  `PostToolUse`, and `Stop` hooks. The hooks now capture rollout memory and
  monitor state, then return `codex_auto_refresh_disabled` without injecting
  `$throughline` or sending rollback/inject. The lower-level auto-refresh helper
  is also default-disabled.
- Changed the Codex `$throughline` skill back to a new-thread handoff flow:
  bare `$throughline` now runs `throughline codex-handoff-start --execute`,
  which creates a new Codex app-server thread, injects developer handoff memory,
  and opens the selected host. Explicit `throughline trim --execute --host codex`
  remains available as a diagnostic current-thread rollback / inject command.

### Fixed

- Codex hooks registered by `throughline install` now resolve the Node
  executable through `PATH` (matching `process.execPath` by `realpath`) instead
  of always hard-coding `process.execPath`. On Homebrew-installed Node on macOS,
  `process.execPath` points at a Cellar-versioned binary that disappears on the
  next `brew upgrade`, leaving stale absolute paths in `~/.codex/hooks.json`.
  The new resolver prefers a stable `PATH` entry (e.g. `/opt/homebrew/bin/node`)
  and falls back to `process.execPath` only when no PATH entry resolves to the
  same binary.

## [0.4.10] — 2026-05-09

### Fixed

- Codex current-thread trim no longer refuses execution solely because the
  rollout active turn count differs from the Codex app-server count. When
  `thread/read` and `thread/resume` agree, Throughline now treats the mismatch
  as diagnostics and adjusts `thread/rollback.numTurns` by the app-server delta.
  For example, `expectedTurns = 6` and `readTurns = resumedTurns = 7` under
  `--all` now sends `numTurns: 7`.
- `trim --preflight --host codex` now reports the same rollback adjustment
  preview instead of returning `preflight-refused` for this recoverable
  mismatch.

## [0.4.9] — 2026-05-09

### Changed

- **Resume context overhaul.** The Claude `/clear` resume injection no longer
  carries a verbose meta-instruction ("respond with: I have inherited the prior
  task..."). The header now contains only a one-line natural-continuation cue
  and the `Bash` invocation contract for `throughline detail HH:MM:SS`. The L2
  active-work thread is anchored at the very bottom of the injected context so
  Claude's attention falls on the most recent turn instead of on a recap line.
  Older L1 summaries are now timestamped with the original turn body time
  (`bodies.created_at` MIN) instead of the skeleton row's summarization time,
  so detail commands derived from L1 lines actually resolve.
- **L3 references collapsed into per-line `(詳細：…)` suffixes.** Both the
  Claude resume context and the Codex active-work / new-thread handoff
  renderers no longer print a standalone `### L3 詳細参照` /
  `### Detail References` section. Instead, every L1 / L2 line ends with a
  compact `(詳細：…)` suffix that aggregates the L3 evidence belonging to that
  turn (`本文`, tool name, `思考`, `画像`, etc.), with `×N` only when count > 1.
  The same-turn user / assistant pair only emits the suffix on the last role to
  avoid duplicating the per-turn L3 hint. MCP tool names are shortened to the
  trailing function name (`mcp__plugin_..._playwright__browser_navigate` →
  `browser_navigate`) so namespace noise does not dominate the suffix.
- Codex auto-refresh and current-session `$throughline` trigger now use a 75%
  verified-usage threshold instead of 80%, so Throughline can fire before Codex
  native auto-compact wins the race.
- `throughline doctor --codex` now reads the Codex hook trust gate from
  `~/.codex/config.toml` (`[hooks.state."<hooks.json>:event:i:j"].trusted_hash`)
  and reports a top-level `Codex hook trust:` summary plus per-hook
  `trusted: yes/no`. A registered hook that is not yet trusted in the Codex
  hook acceptance menu may not actually run.

### Added

- `src/l3-summary.mjs`: shared helpers (`shortenMcpToolName`, `localizeL3Part`,
  `groupL3ByTurn`, `buildPartsSummary`) used by both the Claude resume context
  and the Codex handoff renderers to build the per-line `(詳細：…)` suffix.

### Notes

- The Codex `--max-detail-refs` CLI flag is preserved for backwards
  compatibility but is now a validated no-op: the new per-line suffix
  aggregates L3 references at turn granularity, so a separate cap on a
  standalone Detail References list is no longer meaningful.
- `codex-handoff-smoke` now reports `renderedDetailSuffixes` instead of
  `renderedDetailCommands` / `uniqueRenderedDetailCommands`. The
  `detail_commands_deduplicated` check has been retired because the new
  rendering aggregates L3 by turn structurally and cannot emit duplicate
  detail commands for the same turn.

## [0.4.8] — 2026-05-09

### Changed

- Codex install now registers `UserPromptSubmit` and `PostToolUse` hooks in
  addition to the Stop hook. These hooks read the current Codex rollout
  `token_count` directly and, at the verified 80% threshold, inject a
  current-session `$throughline` instruction before the assistant answers or
  continues a tool loop. This keeps automatic refresh independent of
  token-monitor and available to users who never run the monitor.
- `throughline install` now enables both `[features].codex_hooks = true` and
  `[features].hooks = true` for Codex hook compatibility.

## [0.4.7] — 2026-05-09

### Changed

- Codex Stop hook auto-refresh now uses an 80% verified-usage threshold instead
  of 90%, so Throughline can refresh before Codex native auto-compact while
  still staying above the monitor's 70% warning band. Estimate-only usage and
  estimated context windows still do not mutate the thread.
- Token monitor now discovers active Codex rollout files directly from
  `~/.codex/sessions/**/rollout-*.jsonl`, so current Codex sessions appear even
  when the Codex Stop hook has not written a Throughline state file.
- Token monitor now displays Codex session ids as the raw first 8 thread-id
  characters (`019e085c`) instead of the confusing prefixed slice (`codex:01`).
  Codex in-flight turns still overlay transient `output_tokens` in the token
  count, but the model column no longer adds a separate `live+<tokens>` marker.

## [0.4.6] — 2026-05-09

### Changed

- Codex monitor usage now overlays transient `output_tokens` while a Codex turn
  is open. During an in-flight turn the row displays `input_tokens +
  output_tokens` and marks the model with `live+<tokens>`; after `task_complete`
  the row drops back to verified `input_tokens` only.

## [0.4.5] — 2026-05-09

### Fixed

- VS Code detection now treats `VSCODE_HANDLES_SIGPIPE` as a VS Code-family
  environment signal. This lets `throughline install` provision the monitor task
  in Codex / VS Code sessions where `TERM_PROGRAM`, `VSCODE_PID`, and
  `VSCODE_IPC_HOOK_CLI` are absent.

## [0.4.4] — 2026-05-09

### Changed

- Token monitor now treats Claude transcript and Codex rollout files as live
  inputs. State-file `usage` snapshots remain a fallback, but the display and
  stale hiding no longer wait for Stop hook completion when the live files are
  still changing.
- `throughline install` now provisions or repairs the current project's VS Code
  `Throughline Monitor` task when running under VS Code / Cursor / VSCodium, so
  monitor auto-start setup no longer depends solely on the first hook event.

## [0.4.3] — 2026-05-09

### Changed

- Changed the installed Codex `$throughline` skill so bare `$throughline` runs
  the scripted current-thread refresh directly:
  `throughline trim --execute --host codex --all`. Doctor, dry-run,
  preflight, restore-safety analysis, host primitive audit, and fresh-thread
  handoff remain available only when explicitly requested instead of being the
  normal skill path.
- Changed Codex auto-refresh hook instructions to avoid `--json` on execute so
  the full trim plan / memory preview is not reintroduced as tool output after
  rollback.

## [0.4.2] — 2026-05-09

### Fixed

- Codex trim no longer falls back to the latest project session when `--session`
  is omitted. For `--host codex`, the default memory session is now the current
  Codex thread (`codex:<thread_id>` from `--codex-thread-id`,
  `CODEX_THREAD_ID`, or `THROUGHLINE_CODEX_THREAD_ID`), so Claude-side work
  cannot accidentally become the injected memory for a Codex rollback.

## [0.4.1] — 2026-05-09

### Changed

- **`/clear` も baton を書き込むように変更**。UserPromptSubmit hook で `/clear`
  を検出した時点で当該セッションの `session_id` を `handoff_batons` に書き、
  次の新規 SessionStart が確定的にそのセッションを引き継ぐ。これにより、複数
  VSCode ウィンドウなどで「最新更新セッション ≠ /clear したセッション」になる
  シナリオで `findLatestClaudePredecessor` heuristic が誤った前任を選ぶ問題を
  解消。
- **2 経路の優先順位を入れ替え**: baton path が **primary**、`source='clear'`
  の auto path は **fallback**。auto path は `/clear` が UserPromptSubmit hook
  に届かない経路 (例: VSCode 拡張のメニュー由来) のためのフォールバック扱い。

### Added

- `src/prompt-submit.mjs`: `isClearCommand` 判定 (`/clear`, `/clear ...`,
  前後空白許容、`/cleared` / `/clearcache` 等の prefix 偽陽性は拒否)。
- `~/.throughline/logs/baton-write.log` の `trigger` フィールドに
  `'tl' | 'clear'` を記録。
- `src/prompt-submit.test.mjs`: `isBatonCommand` / `isClearCommand` の判定
  テスト 14 件。
- `src/hook-entrypoints.test.mjs`: `/clear` baton の subprocess+DB 実体テスト
  3 件 (`/clear` 書き込み / `/tl` → `/clear` 後勝ち上書き / 通常 prompt は no-op)。

### Notes

- 既存の `THROUGHLINE_DISABLE_AUTO_HANDOFF=1` env は **fallback path のみに作用**
  するようになった。typed `/clear` は env に関係なく baton 書き込み → 引継ぎ発火
  する (= ユーザーが明示的に `/clear` を打った時点で「続けたい」という意思表示
  と解釈する)。auto path (VSCode メニュー由来) には引き続き env が効く。

### Repository hygiene

- `.vscode/tasks.json` を git 追跡から外す (`.gitignore` に追加)。
  `ensureMonitorTaskFile` が hook 発火ごとに絶対パスを書き換えるため、追跡
  対象に置くと別 OS / 別マシンで毎回 dirty diff が出続けていた。各マシンでは
  初回 hook 発火時に自動生成される。

## [0.4.0] — 2026-05-08

### Breaking changes

- **`/clear` で自動引継ぎがデフォルト ON** に変更。Claude Code 2.1.128 で
  SessionStart hook の `source='clear'` が reliable になったため、`/clear` 後の
  新セッションは自動的に前セッションの memory を merge + 注入する。
  ([GitHub issue #49937](https://github.com/anthropics/claude-code/issues/49937)
  は解決済み)
- **`THROUGHLINE_DISABLE_AUTO_HANDOFF=1`** env var で auto path を OFF にできる。
- **`/tl` の役割を明示意思マーカーに簡素化**。memo 4 項目入力の指示を削除し、
  baton を立てるだけの slash command に。`/tl` は env で auto OFF にしている
  ユーザー、または `/clear` を経由しない引継ぎに使う逃げ道。
- **`/tl-trim` slash command 廃止**。memo 入力 + dry-run preview の役割を持って
  いたが、memo 廃止と軽量化方針で役割なしに。Codex 経路の `throughline trim`
  CLI は維持 (`--host codex` での guarded execute / preflight など)。
- **`throughline save-inflight` CLI 削除**。memo 廃止に伴う除去。
- **`updateBatonMemo` 関数削除**。`src/baton.mjs` の export から外した。
- **schema v8 migration**: `handoff_batons.memo_text` 列を drop。
- **注入内容を L1 + L2 + L3 references のみに簡素化**。memo セクション、
  中断直前 thinking セクション、Claude 向け footer の使い方説明を削除。L2 全文
  に「次に何をしようとしていたか」が含まれているため redundant。

### Added

- `src/db.mjs`: schema v8 migration (handoff_batons.memo_text 列 drop)。
- `src/session-start.mjs`: 引継ぎ判定の 2 経路ロジック:
  1. baton path: `consumeBaton` 先発で baton ありなら merge + 注入
  2. auto path: baton 無し + `source='clear'` + env disable 無し で同 project の
     最新 Claude unmerged session を自動 predecessor に merge + 注入
- `inheritance-decision.log` に `triggered_path` / `auto_handoff_disabled`
  フィールドを追加。`baton_has_memo` フィールドは削除。
- `src/resume-context.mjs`: L3 references 一覧を注入テキストに追加
  (Codex `renderCodexRolloutMemoryPreview` 形式の `- ${kind}:
  \`throughline detail <time>\``)。Reading Contract / Continuation Instruction
  も Codex 風 framing に揃えた。

### Notes

- `src/handoff-record.mjs` の memo / thinking projection は **維持**: Codex 側
  (`codex-handoff.mjs`, `codex-resume.mjs`, `codex-handoff-smoke.mjs` など) が
  `memory.inflightMemo` / `memory.latestThinking` を参照しているため。Claude
  側は resume-context.mjs で「使わない」だけ。
- `src/cli/trim.mjs` は **維持**: Codex 経路 (`--host codex`) と doctor
  (`--trim --host claude`) で使う `describeTrimHost('claude')` の dry-run 表示
  が依存しているため。`/tl-trim` slash command が無くなっても CLI は残る。
- 既存 `~/.throughline/logs/inflight-memo.log` ファイルは新版で書き込まれない。
  ユーザー側で手動削除可能。

## [0.3.25] — 2026-05-08

### Added
- Claude-primary / Codex-sidecar groundwork:
  `HandoffRecord` projection, `throughline handoff-preview`,
  `throughline_handoff` example context, and `codex-sidecar-diagnostics` /
  `codex-sidecar-dry-run` command surfaces.
- Optional `codex-sidecar` L2→L1 summarization path. When the sidecar is
  configured for the `summarize-l1` preset, Throughline uses it for the only
  subagent-like external model call; disabled/unavailable/run-failed sidecar
  states keep the existing Claude Haiku route.
- `/tl-trim` dry-run surface:
  `throughline trim --dry-run`, `--host`, `--keep-recent`, `--all`,
  `--memo-stdin`, `--codex-thread-id`, and `throughline doctor --trim`.
- Codex app-server protocol helpers for the verified trim flow: newline JSON
  framing, initialize / resume / rollback / inject / turn-start request
  builders, and parser coverage.
- Codex rollout-backed trim source for explicit `--codex-thread-id` plans.
  This lets Codex dry-run / preflight / guarded execute use the active rollout
  even when the Throughline DB has no Codex `bodies` rows.
- `throughline codex-capture`, which captures explicit Codex rollout active
  turns into a namespaced `codex:<thread_id>` Throughline DB session. Re-capture
  rebuilds that session so rolled-back tail turns do not survive as current L2.
- Codex capture now stores rollout function-call L3 details as well as L2
  bodies: `function_call` becomes `details.kind = tool_input`, and
  `function_call_output` becomes `details.kind = tool_output`.
- Host-mode L2→L1 backend selection. Claude-primary keeps the existing
  `codex-sidecar` / Claude Haiku compatibility route, while Codex-primary uses
  the Codex CLI backend and reports failure explicitly instead of falling back.
- `throughline codex-summarize`, which writes L1 skeletons for captured
  `codex:<thread_id>` sessions through the Codex CLI backend once the captured
  body count exceeds the L2 window.
- `throughline codex-resume`, which renders captured `codex:<thread_id>` memory
  as Codex active-work context. `--format handoff` emits a concise fresh-thread
  handoff prompt for safe continuation without mutating the current Codex
  thread; the handoff view caps recent L2 entries, long body text, and detail
  references while preserving the full context in the normal text renderer.
  `--format item-json` emits a Codex developer message item so hosts can
  inject the memory as current-task context instead of a passive archive.
  `--memo-stdin` prepends a Codex-primary in-flight memo without touching Claude
  `/tl` batons.
- `throughline codex-handoff-smoke`, a read-only validator for the
  `codex-resume --format handoff` prompt. It checks fresh-thread header /
  current-task contract / source session / start instruction / mutation
  boundary / prompt size / detail-command deduplication before a user starts a
  new Codex thread with that prompt.
- `throughline codex-handoff-model-smoke`, an explicit opt-in model smoke for
  the same handoff prompt. It first requires the structural handoff smoke to be
  ready, then runs `codex exec --ephemeral --ignore-user-config --ignore-rules
  --sandbox read-only` with a marker prompt. `--dry-run` inspects the exact
  readiness / command boundary without starting Codex exec, and
  `--print-prompt` can include the combined prompt for audit. Live model smoke
  requires `THROUGHLINE_EXPERIMENTAL_CODEX_HANDOFF_MODEL_SMOKE=1` and does not
  mutate the current Codex thread.
- `throughline codex-handoff-start`, a guided fresh-thread start plan
  for Codex handoff. It reports the structural smoke command, model-smoke dry-run
  boundary, handoff render command, optional live model smoke command, and can
  include the handoff prompt with `--print-prompt`. When `--memo-stdin` is used,
  the replay commands include `--memo-stdin` and the output reminds callers to
  pipe the same memo. With `--execute`, it starts a new app-server thread,
  injects developer handoff memory with `thread/inject_items`, and opens it
  through `--open-host auto|vscode|cli|none`.
- `throughline doctor --codex`, a read-only Codex-primary diagnostic that shows
  current thread env identity, rollout candidates for the cwd, captured
  `codex:<thread_id>` DB sessions, context refresh blockage, new-thread
  handoff readiness, and the next capture/resume commands.
- Global `throughline install` now also registers the Codex Stop hook in
  `~/.codex/hooks.json` with absolute node + installed `bin/throughline.mjs`,
  `async: false`, and `timeoutSec: 300`, and enables
  `[features].codex_hooks = true` in `~/.codex/config.toml`. Existing non-
  Throughline Codex hooks, including Caveat / Spotter hooks, are preserved.
- Global install now also installs a `$throughline` Codex skill under
  `~/.codex/skills/throughline`, giving Codex a natural-language entrypoint for
  Throughline status, resume, summarize, dry-run, preflight, and explicit
  execute workflows. The rollback / inject execute path is enabled again after
  controlled rollback model-visible smokes failed to reproduce rollback marker
  resurrection.
- A bare `$throughline` Codex skill invocation now runs the safe inspection
  shape: `doctor --codex`, guarded dry-run, and preflight. Explicit
  `trim --execute --host codex --all` mutates the current Codex thread when the
  user asks for it and the guard checks pass.
- Codex Stop hook automatic refresh now attempts guarded rollback + Throughline
  DB memory injection at the 90% verified-usage threshold. Estimate-only usage
  still never triggers mutation.
- `throughline codex-visibility-smoke`, an experimental opt-in Codex app-server
  smoke that injects the Codex active-work developer message and starts a
  marker-check model turn. It requires
  `THROUGHLINE_EXPERIMENTAL_CODEX_MODEL_VISIBLE_SMOKE=1` and supports explicit
  model-turn timeouts with `--request-timeout-ms` / `--timeout-ms`; it also
  accepts the same `--memo-stdin` active-work memo surface as `codex-resume`.
  `--resume-after-inject` re-runs `thread/resume` after injection before
  starting the marker turn, so resume persistence can be checked explicitly.
- Codex-first roadmap docs that set the next implementation order: Codex
  primary support with a Codex CLI L2→L1 backend, then Codex rewind-compatible
  trim, then Claude rewind finalization.

### Changed
- Resume context now frames recent L2 as an active work thread with explicit
  reading/continuation instructions at both the top and bottom of injected
  memory. Older L2 entries may be superseded by later entries and are not
  blindly treated as still-current truth.
- Hook entry modules are import-safe and expose `run()` so subprocess tests can
  cover the Claude path without touching the user's real database.
- VSCode task tests suppress Claude-facing `<system-reminder>` notices by
  default and opt in only for notice assertions, keeping test output from
  looking like fresh user-facing instructions.
- `codex-sidecar` subprocess calls now shell-wrap on Windows so npm global
  `.cmd` shims resolve consistently, matching the existing Claude CLI handling.
- L2→L1 sidecar summarization accepts the stable `SidecarResult` JSON shape
  (`summary` without `status: "ok"`) as well as the older test fixture shape.
- `codex-sidecar-dry-run --turn-timeout-ms` now forwards the timeout into the
  normalized sidecar request instead of only changing the local subprocess
  timeout.
- `.codex-sidecar.yml` no longer denies every path containing `token`, so
  legitimate source files such as `src/token-monitor.mjs` remain reviewable.
- `.codex-sidecar.yml` allows release docs and Claude slash commands, so
  review/risk-check sidecars can inspect the same contract surfaces that are
  shipped in the npm tarball.
- `.codex-sidecar/logs/` is ignored as a runtime artifact from real sidecar
  smoke runs.
- Codex trim host status now distinguishes verified app-server rollback/inject
  primitives from guarded execution requirements. Codex Stop hook automatic
  refresh is enabled only at the 90% verified-usage threshold and still uses the
  same explicit thread identity, injectable DB memory, and rollout/app-server
  turn-count guards.
- Trim dry-run now carries an explicit Codex thread identity separately from
  the Claude/Throughline `session_id`, avoiding latest-rollout guessing.
- Codex trim can now use `THROUGHLINE_CODEX_THREAD_ID` or `CODEX_THREAD_ID` as
  a current-thread identity signal when `--codex-thread-id` is omitted; the CLI
  flag remains authoritative and Throughline still does not guess from the
  latest rollout.
- `throughline doctor --trim --host codex` now reports whether a current Codex
  thread id is available from env and adjusts its dry-run example accordingly.
- `throughline doctor --trim --host codex` now also reports the read-only host
  primitive audit status as diagnostic evidence rather than an execute blocker.
- `throughline trim --preflight --host codex --codex-thread-id <id>` now
  performs a guarded Codex app-server initialize/read/resume check and stops
  before sending rollback or inject. When the plan source is `codex-rollout`,
  preflight compares rollout active turns with app-server read/resume turns and
  refuses the plan if they differ.
- Codex rollout-backed trim source now excludes the current in-flight turn from
  rollback planning, including the latest post-rollback assistant continuation.
  This keeps preflight aligned with app-server `thread/read` / `thread/resume`,
  which only report completed host-visible turns during an ongoing Codex turn.
- `throughline trim --execute --host codex --codex-thread-id <id>` no longer
  requires `THROUGHLINE_EXPERIMENTAL_CODEX_TRIM_EXECUTE=1` and no longer treats
  host primitive audit or restore-safety diagnostics as mutation blockers.
  Execute still refuses before mutation when Codex thread identity, injectable
  Throughline DB memory, or rollout/app-server turn-count agreement is missing.
- Codex guarded execute now polls post-inject `thread/read` until the injected
  memory item is visible when the app-server reports an injected turn count, and
  reports `postInjectVisibilityCheck` so stale immediate app-server reads are
  explicit. If `thread/inject_items` returns no turn list, developer memory is
  treated as item-level injection and the expected post-inject turn count remains
  the rollback result turn count.
- Codex guarded execute status now separates live mutation from durable
  success: a visible app-server mutation reports `execute-sent-live-only` with
  `durableVerification.durableVerified: false` and exits non-zero; post-inject
  visibility timeout reports `execute-unverified`.
- Codex guarded execute can now report `execute-durable-verified` only when the
  rollout records a new `thread_rolled_back` event, records the injected
  `## Throughline: Active Work Context` memory, and restore-safety diagnostics
  remain `ok`.
- Added `throughline codex-restore-smoke`, a read-only diagnostic that starts
  fresh Codex app-server processes and compares `thread/read`,
  `thread/resume`, and paginated `thread/turns/list` turn counts against the
  rollout active turn count. Its proof scope is
  `app_server_process_restart_only`, and it always reports `restartSafe: false`
  because it is not VS Code restart / reconnect proof. If the required
  read-only app-server request fails, the CLI returns structured
  `app-server-restore-smoke-error` JSON instead of a stack trace.
- `codex-restore-smoke --inspect-risky-rollout` can now inspect a risky rollout
  read-only and search app-server responses for retained rollback text. If
  retained text appears in direct turn text or `replacement_history`, the smoke
  reports `app-server-restore-text-retained` instead of a success-like stable
  status, even when read/resume/list turn counts are stable. If retained text
  appears only in quoted/tool-output fields such as `aggregatedOutput`, it
  reports `app-server-restore-text-quoted`. Match reports include sample JSON
  paths, location kinds, risk classes, and blocking-candidate summaries.
- `codex-vscode-rollback-smoke` text output now includes retained rollback text
  count, resurrected user message count, and restore-safety risk type summary so
  incident audits do not require opening the full JSON payload.
- `codex-restore-source-audit` now inventories SQLite-backed VS Code storage
  candidates (`.vscdb`, `.sqlite`, `.sqlite3`, `.db`) read-only and reports
  table / searchable column / needle match summaries alongside raw byte matches.
- `codex-restore-source-audit` now classifies VS Code log evidence into thread
  id hits, retained rollback text hits, patch-apply failures, thread stream
  broadcasts, and `replacement_history` signals, including a first/last
  timestamp window for patch-apply failures when log timestamps are present.
- `codex-restore-source-audit` now reports explicit VS Code extension
  rollback non-resurrection projection candidates, such as
  `replacement_history` filter / tombstone paths, separately from deletion-based
  repair primitives.
- `codex-restore-smoke --inspect-risky-rollout` now separates blocking retained
  text candidates from quoted/tool-output matches. Direct turn text and
  `replacement_history` keep the `app-server-restore-text-retained` status;
  matches found only in fields such as `aggregatedOutput` report
  `app-server-restore-text-quoted` with `blocking-candidates=no`.
- Added `throughline codex-rollback-model-visible-smoke`, a controlled
  two-phase smoke for the unresolved rollback question. `--prepare` starts a
  unique marker user turn and rolls it back; `--verify` later starts a model
  turn that contains only the marker prefix, not the full marker. A returned
  full marker reports `reproduced`; an explicit not-visible answer reports
  `not-reproduced`. The command is gated by
  `THROUGHLINE_EXPERIMENTAL_CODEX_ROLLBACK_MODEL_VISIBLE_SMOKE=1`. Live runs can
  use `--marker-file` so the full marker is not printed into the same thread
  being tested; marker-file prepares also use a unique per-trial prefix. Verify
  output reports `rolledBackMarkerModelVisible` and `modelReportedNotVisible`
  separately from `restartSafe`.
- Real controlled current-thread smoke on 2026-05-08 returned
  `not-reproduced` both before and after a VS Code reload/reconnect command,
  with `promptIncludesMarker: false` and no observed full marker. This weakens
  the rollback-resurrection hypothesis for the controlled marker path enough to
  remove the overbroad automatic Codex trim blocker. Retained compacted history
  and same-thread host primitive audit remain diagnostics.
- Added `throughline codex-restore-source-audit`, a read-only local inventory of
  Codex rollout, `session_index.jsonl`, `state_*.sqlite`, and VS Code
  globalStorage / workspaceStorage candidates for an explicit Codex thread. It
  now also scans VS Code `settings.json`, VS Code logs, and installed
  OpenAI/Codex VS Code extension bundles for restore-path signals such as
  `thread/read`, `thread/resume`, `thread/turns/list`, reconnect
  `needs_resume`, persisted webview atoms, and follow-up queue signals.
  Its proof scope is `local_restore_source_inventory_only`, and it does not
  prove VS Code restart safety.
- Added `throughline codex-vscode-restore-smoke`, a manual two-phase VS Code
  reload/reconnect proof protocol. `--prepare` injects a hidden active-work
  marker memory behind `THROUGHLINE_EXPERIMENTAL_CODEX_VSCODE_RESTORE_SMOKE=1`;
  `--verify` scans the rollout for a marker-free smoke prompt followed by an
  assistant marker-only answer after prepare, and rejects marker leaks in the
  user prompt. It reports `restartSafe: true` only with an explicit
  `--after-vscode-restart` acknowledgement and marker proof.
- Real VS Code reload/reconnect marker proof passed for thread
  `019dfddb-8288-7392-a461-bf3ebc5da409` with marker
  `TL_CODEX_VSCODE_RESTORE_46888202`. This proves hidden developer memory
  visibility across reconnect, not rollback-target non-resurrection.
- Tightened the VS Code restore smoke verifier after a false-positive hazard:
  assistant marker mentions in normal progress text no longer count. The proof
  now requires the marker-free smoke prompt and an assistant marker-only answer.
- Added `throughline codex-vscode-rollback-smoke`, a read-only rollback
  non-resurrection verifier. It requires a rollback event, rolled-back user
  text, a later user turn, restore-safety `ok`, and explicit
  `--after-vscode-restart` before reporting `restartSafe: true`.
- Added `throughline codex-host-primitive-audit`, a read-only audit that
  generates the installed Codex app-server JSON schema and checks whether a
  same-thread rollback non-resurrection primitive exists. The primitive may
  delete/rewrite retained rollback sources, or isolate/project them away from
  model-visible input. It now also reports a host-agnostic same-thread repair
  contract requiring a rollback non-resurrection guarantee, memory reinjection,
  post-repair host reads, and restart/reconnect non-resurrection proof; VS Code
  diagnostics can provide evidence but do not satisfy the contract. On
  `codex-cli 0.128.0-alpha.1`, the audit reports
  `diagnostic-only`: rollback/inject/new-thread primitives exist, but no
  current-thread rollback non-resurrection primitive is exposed, and
  `thread/resume(history)` is marked unstable/do-not-use with `thread_id`
  ignored.
- Real incident-shaped live rollback run for thread
  `019dfddb-8288-7392-a461-bf3ebc5da409` remains a `restoreSafety: risk`
  incident: rollout recorded `thread_rolled_back` and injected active-work
  memory, while `compacted.replacement_history` retained rollback-targeted user
  text and read-only diagnostics later observed matching text after rollback.
  Later app-server restore inspection separated direct user-message candidates
  from quoted/tool-output matches; the current thread's retained app-server
  matches are `aggregatedOutput` only, and the controlled model-visible smoke
  did not reproduce marker resurrection. Automatic Codex trim is enabled again
  with DB memory and turn-count guards.
- Codex trim dry-run plans and `doctor --trim --host codex` now expose the safe
  continuation path as `new-thread-handoff-only`: use the guided entrypoint
  `throughline codex-handoff-start --session codex:<thread-id>`, or validate the
  handoff with `throughline codex-handoff-smoke --session codex:<thread-id>`, optionally
  inspect the model-smoke boundary with
  `throughline codex-handoff-model-smoke --session codex:<thread-id> --dry-run --json`,
  render a fresh-thread handoff with
  `throughline codex-resume --session codex:<thread-id> --format handoff`, and
  start a new Codex thread, without mutating the current risky thread.
- Human-readable trim dry-run reports now truncate the inline curated memory
  preview for scanability while leaving full `memoryPreview.text` intact in JSON
  and in the Codex `codex-resume` safe-continuation command.
- `parseCodexRolloutFile` now exposes `userMessagesAfterRollback`,
  `latestRollbackAt`, and `restoreSafety.rolledBackTexts` so rollback smoke
  results carry enough audit evidence instead of only pass/fail status.
- Guarded execute now still checks rollout durability evidence when post-inject
  live read visibility times out, so reports can include observed rollback
  markers, observed injected memory, and post-execute restore-safety risk.
- Codex trim preflight / execute now reports planned restore-safety diagnostics:
  if the planned rollback would remove user text that already appears in
  `compacted.replacement_history`, Throughline reports
  `planned_restore_safety_risk` as diagnostic evidence but does not refuse
  solely for that reason.
- `codex-restore-source-audit` no longer uses very short retained rollback texts
  as VS Code storage needles, avoiding false positives from generic prompts such
  as `go`.
- Codex guarded execute no longer uses the old
  `THROUGHLINE_EXPERIMENTAL_CODEX_TRIM=1` gate or the later
  `THROUGHLINE_EXPERIMENTAL_CODEX_TRIM_EXECUTE=1` blocker. It now requires only
  explicit `--execute`, Codex thread identity, injectable Throughline DB memory,
  and rollout/app-server turn-count checks before mutation.
- Codex app-server helpers now report spawn failures explicitly instead of
  waiting for a request timeout.
- Codex app-server stderr in diagnostics is now capped after warning
  compaction, so external plugin/OAuth warnings cannot make smoke JSON
  excessively large.
- `throughline codex-threads` lists read-only Codex rollout/thread candidates
  for the current project so users can pass an explicit `--codex-thread-id`
  without Throughline guessing the active thread.
- `throughline codex-threads` now sorts candidates by rollout file mtime, not
  stale `session_index.jsonl` timestamps, so actively written threads appear
  before old probe threads.
- Codex trim memory previews now apply `thread_rolled_back` rollout events
  before building the active work thread, so rolled-back tail turns are not
  reintroduced as current memory.
- Codex trim dry-run now reports a heuristic context reduction estimate when
  rollout text is available: rollback-candidate estimated tokens, injected
  memory estimated tokens, net estimated reduction, and reduction percentage.
  This is intentionally labeled as `chars / 4`, not an exact host tokenizer
  measurement.
- Codex rollout parsing now mirrors app-server turn counts for injected
  active-work developer messages and for the latest post-rollback assistant
  continuation turn. This keeps guarded trim preflight aligned after a real
  rollback/inject cycle.
- Codex guarded trim now uses rollout/app-server data for rollback planning and
  turn-count guards, but uses Throughline DB memory for injection when
  available: older turns as L1 summaries, the latest 20 turns as full L2 bodies,
  and L3 as references only; L3 bodies / tool payloads are not injected.
  Execute refuses before mutation when only a rollout preview is available.
- `throughline doctor --codex` now reports context-refresh readiness, including
  rollback source, inject memory source, the L1/L2/L3 memory contract, current
  memory counts, and heuristic reduction estimate when available.
- `throughline doctor --codex` now reports the host primitive audit status and
  prints `throughline codex-host-primitive-audit` as the next read-only command
  for diagnostic detail.
- `throughline doctor --codex` labels context refresh as `ready` when the
  executable guard inputs are present, even if restore-safety diagnostics are
  risky. Those diagnostics are reported separately.
- `throughline doctor --codex` now reports the VS Code monitor task status and
  prints the Reload Window note there too, because Codex Stop hook stdout is not
  guaranteed to appear in the chat.
- `throughline doctor --codex` and human-readable guarded trim reports now label
  L3 as references-only and explicitly say L3 bodies are not injected.
- Guarded Codex execute now performs the same rollout/app-server turn-count
  check before rollback; mismatch or unavailable app-server counts refuse
  execution before any rollback or inject request is sent.
- Codex app-server stderr in trim preflight / guarded execute now compacts
  repeated unknown-turn item warnings while preserving the first occurrence and
  unrelated diagnostics.
- Codex visibility smoke now waits for app-server notification events
  (`item/agentMessage/delta` or `turn/completed`) after `turn/start`, so it does
  not mistake an accepted model turn for completed model visibility.
- Codex visibility smoke can now verify the `inject -> resume -> turn/start`
  path. Real-host smoke confirmed marker
  `TL_CODEX_RESUME_AFTER_INJECT_REAL_20260506` after a post-inject resume.
- Codex CLI L1 summarization now uses the `codex exec` option set supported by
  local `codex-cli 0.128.0-alpha.1`; the removed `--ask-for-approval` flag is
  no longer passed. The subprocess also passes `--ignore-user-config` so
  user-level Codex plugins/hooks are not loaded during the summarization call.
- Codex CLI summarization errors now include compacted stderr in JSON output,
  preserving actionable `ERROR:` lines without dumping enormous HTML challenge
  pages verbatim.
- `throughline monitor` is now host-aware for Claude and Codex state files.
  Codex Stop hook writes `codex:<thread_id>` monitor state with `rolloutPath`,
  snapshots verified rollout `token_count` usage when present, and marks
  rollout-text estimates with `estimated: true` / `est` when no token-count
  event is available. State filenames are URL-encoded so `codex:` session ids
  remain portable. The compact row now displays used tokens over the model
  context window, instead of percent plus remaining tokens.

### Documentation
- Added integrated implementation/TODO plan and cross-links for the Codex dual
  support and rollback trim design docs.
- README now documents Claude-primary behavior, optional Codex sidecar usage,
  and the current dry-run-only state of context trim.
- npm packaging now includes `docs/` and `CHANGELOG.md`, so README-linked
  design docs and the `throughline_handoff` example context are present in the
  tarball.
- npm packaging also includes `.codex-sidecar.yml`, keeping the documented
  sidecar diagnostics / dry-run examples reproducible from the package source.
- `npm test` now includes nested `src/cli/*.test.mjs` coverage in addition to
  the top-level `src/*.test.mjs` tests.
- Recorded the 2026-05-06 Codex app-server rollback/inject spike: `thread/read`
  can read persisted threads, `thread/rollback` requires a loaded thread via
  `thread/resume`, and injected developer items are visible to the next turn.
- Recorded the 2026-05-06 real Codex-primary active-work smoke: injected
  `codex-resume` developer context produced marker `TL_CODEX_VISIBLE_REAL_20260506_C`
  in `item/agentMessage/delta`, confirming the rendered memory is model-visible
  as current work in a real Codex host.
- Documented the current Codex-primary setup flow. Global install manages only
  the Throughline Codex Stop hook / skill and preserves existing
  non-Throughline hooks; users can verify natural capture with `doctor --codex`,
  then summarize, render, or inject active-work memory through the `$throughline`
  skill or the explicit Codex CLI surfaces.
- Recorded the 2026-05-06 final Codex Stop hook smoke: after the absolute-path
  hook shape was installed, a newly started VSCode-origin Codex thread
  `019dfd62-9a9d-7211-bf91-89d8e3fc908e` naturally advanced the latest DB
  session to `codex:019dfd62-9a9d-7211-bf91-89d8e3fc908e` as reported by
  `doctor --codex`.
- Added and completed the Codex monitor implementation plan, documenting the
  host-aware state contract, Codex `rolloutPath`, verified `token_count`
  usage, and explicit estimate labeling.

## [0.3.24] — 2026-05-02

### Added
- `shouldRecommendGitignore` in [src/vscode-task.mjs](src/vscode-task.mjs):
  when `ensureMonitorTaskFile` transitions to `created` / `merged` / `repaired`
  inside a git repository whose `.gitignore` lacks a `.vscode/tasks.json`-
  matching entry, emit a one-time `<system-reminder>` to stdout recommending
  `.gitignore` registration. Suppressed by a `.throughline-gitignore-noted`
  marker so it does not repeat. Negation patterns (`!.vscode/tasks.json`) are
  treated as explicit-track intent and still trigger the recommendation.

### Why
- `.vscode/tasks.json` always contains environment-specific absolute paths
  (`process.execPath`, the install location of `throughline.mjs`). Even though
  v0.3.23 auto-repairs stale paths after the fact, the right answer is to not
  commit it in the first place. The published npm tarball was already clean of
  absolute paths (`files` field excludes `.vscode/`, no hardcoded paths in
  source); this release strengthens runtime advice for the consumer side.

## [0.3.23] — 2026-05-02

### Added
- Cross-environment `.vscode/tasks.json` repair: when an existing Monitor task
  references absolute paths that don't exist on the current machine
  (e.g. a Windows path on a WSL2 clone), `ensureMonitorTaskFile` now rewrites
  just `command` / `args` while preserving any `label` / `presentation` /
  `isBackground` customization. New helpers `findMonitorTaskIndex` and
  `isMonitorTaskBroken` (absolute-path + non-existent test) drive the new
  `action: 'repaired'` branch, and `buildSetupNotice('repaired')` returns a
  one-time `Reload Window` notice.
- `resolveThroughlineOnPath` in [src/cli/install.mjs](src/cli/install.mjs):
  after `throughline install` completes, walk PATH to confirm `throughline`
  resolves. If not, print a stderr fix recipe (`npm prefix -g` → add to
  `~/.bashrc` → re-run `doctor`). Catches the silent-fail case where
  `~/.npm-global/bin` is exported in `~/.profile` but not `~/.bashrc` (VSCode's
  interactive non-login bash skips `.profile`).

### Documentation
- README Troubleshooting now covers PATH resolution, WSL2 ↔ Windows PATH
  crossover, cross-OS DB separation (each `os.homedir()` is its own DB), and
  the auto-repair behavior for stale tasks.

## [0.3.22] — 2026-04-19

### Changed
- Register the `Stop` hook with `"async": true` so `throughline process-turn`
  runs in the background and no longer blocks the user-visible turn completion
  on the Haiku L1-summarization subprocess (which can take seconds to tens of
  seconds). L1 summaries are only needed for the *next* `SessionStart`
  injection, so there is no reason to make the current turn wait for them.
  `SessionStart` and `UserPromptSubmit` remain synchronous because their work
  must complete before the next turn begins.

### Migration
- Existing installs need `throughline uninstall && throughline install` to
  pick up the new `async` flag. The install dedup compares the `command`
  string, so a re-install without uninstalling first will skip the already-
  registered (but still synchronous) entry.

## [0.3.21] — 2026-04-19

### Changed
- `throughline install` now writes the `/tl` and `/sc-detail` slash command
  definitions to `~/.claude/commands/*.md` (user scope) instead of relying on
  per-project `.claude/commands/`. New projects no longer need to copy the
  slash command files manually.

## [0.3.20] — 2026-04-19

### Changed
- Monitor's context-exhaustion warning now recommends `/tl` instead of
  `/clear`, so the suggested action does not break the handoff baton path.

## [0.3.19] — 2026-04-18

### Added
- `ensureMonitorTaskFile` now emits a one-time `<system-reminder>` to stdout
  the moment it creates or merges a `.vscode/tasks.json`, so Claude can tell
  the user a **Developer: Reload Window** is needed to activate the
  `folderOpen` task. The notice is silent on the `already_present` path so it
  fires at most once per project.

## [0.3.18] — 2026-04-18

### Added
- Fan-out of `ensureMonitorTaskFile` to **all three hooks** (`SessionStart`,
  `UserPromptSubmit`, `Stop`) so `.vscode/tasks.json` is provisioned by
  whichever hook fires first in a given environment. Previously only `Stop`
  invoked it, which meant projects where `Stop` did not fire on the first
  session never got the monitor task. The provisioning logic is idempotent,
  so the redundant calls are no-ops once the task exists.

## [0.3.0] — 2026-04-18

This is the first release line that supports the schema v7 / `/tl` baton
handoff with in-flight memo and L3 thinking storage. `0.3.1` through `0.3.17`
were rapid-fire monitor render-bug iterations published to npm but not tagged
on GitHub; they are summarized in the rollup section below for completeness.

### Added
- **In-flight memo via `/tl`** (schema v7). When `/tl` fires, the
  `UserPromptSubmit` hook writes a baton row, then Claude itself pipes a
  Markdown memo (next planned move, current hypothesis, open questions,
  in-progress TODOs) into `throughline save-inflight`, which attaches it to
  `handoff_batons.memo_text`. The next `SessionStart` injects the memo at the
  top of the resume context so the new Claude picks up mid-thought.
- **Extended thinking captured at L3.** Assistant `thinking` blocks are
  persisted in `details` with `kind='thinking'`. The most recent turn's
  thinking is injected inline above the L2 history on `SessionStart`; older
  thinking remains retrievable via `throughline detail <time>`.
- **Resume reframing.** The injected context is presented as "resuming an
  interrupted task" rather than "reading past logs", so the new session
  behaves like a continuation rather than a recap.

## [0.2.0] — 2026-04-18

### Added
- **Explicit `/tl` baton handoff** (schema v6). Replaces the auto-inheritance
  heuristics. The previous session writes a baton, the next session consumes
  it within a 1-hour TTL, and merge happens via deterministic
  `UPDATE session_id = ?` inside a `BEGIN IMMEDIATE` transaction. Sessions
  without a baton start clean — no false-positive carryover.

## [0.1.0] — 2026-04-17

### Added
- Initial public release on npm. Schema v5 (L1/L2/L3 with `kind` and
  `source_id` columns on `details`).
- CLI: `install`, `uninstall`, `doctor`, `status`, `monitor`, `detail`.
- Hook entry points: `session-start`, `process-turn`, `prompt-submit`.
- Multi-session token monitor reading real `message.usage` from the
  Claude Code transcript JSONL (no `length / 4` heuristics) with 1M-context
  detection.
- Zero runtime dependencies; uses Node 22.5+ built-in `node:sqlite`.

---

## Unreleased pre-0.3.18 iterations (npm-only, not tagged on GitHub)

These versions shipped to npm in rapid succession on 2026-04-18 while
debugging a single class of monitor render bugs (rows stacking instead of
redrawing in place inside Windows ConPTY + VS Code task terminals). They are
rolled up here because individually they are not interesting consumption
units — the user-visible result is "the monitor finally renders correctly
across PTY, ConPTY, VS Code task terminal, and panel resize".

| Version | Theme |
| ------- | ----- |
| `0.3.1`–`0.3.2`     | Monitor crash resilience, accurate 1M-context detection, color-blind-safe markers. |
| `0.3.3`             | `.vscode/tasks.json` auto-provisioning (two-stage merge, JSONC detection). |
| `0.3.4`–`0.3.5`     | Stop-hook `state.usage` snapshot, `doctor --session` diagnostic, `(Nm ago)` per-row stamp, columns polling. |
| `0.3.6`–`0.3.12`    | Successive guesses at the "rows stacking" render bug (columns fallback, `isTTY` branching, `clearScreen`, alt screen, `type:shell`). All later confirmed off-target by the `--diag` instrumentation added in `0.3.11`. |
| `0.3.13`            | Root-cause fix: removed the `>= 40` columns floor in `resolveColumns` that was misclassifying real 30-cell panels as "insane" and falling back to 200, which then wrapped output and undercounted CUU on redraw. |
| `0.3.14`–`0.3.15`   | Diagnostic surfacing (startup header, per-frame columns) confirming that `process.stdout.columns` does not track panel resize on Windows ConPTY + VS Code tasks. |
| `0.3.16`            | New module `src/terminal-size.mjs`: query the terminal directly via OSC 18t (`\x1b[18t`) and parse the `\x1b[8;rows;cols t` reply on stdin in raw mode. Resize now follows panel width even when Node's `columns` is frozen. |
| `0.3.17`            | Force a full `clearScreen` (`\x1b[2J\x1b[3J\x1b[H`) on every resize-triggered redraw so the previous, wrongly-sized frame can no longer stack beneath the new one. |

### Lessons preserved as memory

The seven-version stretch of `0.3.6`–`0.3.12` was guesswork without
measurement; once `--diag` (`0.3.11`) and `terminal-size.mjs` (`0.3.16`) were
added, the real cause was found in two more versions. This is recorded as a
working-discipline note: when a terminal- or platform-specific bug resists
two attempts, instrument first instead of patching again.

---

[Unreleased]: https://github.com/kitepon/Throughline/compare/v0.10.17...HEAD
[0.10.17]: https://github.com/kitepon/Throughline/compare/v0.10.16...v0.10.17
[0.10.16]: https://github.com/kitepon/Throughline/compare/v0.10.15...v0.10.16
[0.10.15]: https://github.com/kitepon/Throughline/compare/v0.10.14...v0.10.15
[0.10.14]: https://github.com/kitepon/Throughline/compare/v0.10.13...v0.10.14
[0.10.13]: https://github.com/kitepon/Throughline/compare/v0.10.12...v0.10.13
[0.10.12]: https://github.com/kitepon/Throughline/compare/v0.10.11...v0.10.12
[0.10.11]: https://github.com/kitepon/Throughline/compare/v0.10.10...v0.10.11
[0.10.10]: https://github.com/kitepon/Throughline/compare/v0.10.9...v0.10.10
[0.10.9]: https://github.com/kitepon/Throughline/compare/v0.10.8...v0.10.9
[0.10.8]: https://github.com/kitepon/Throughline/compare/v0.10.7...v0.10.8
[0.10.7]: https://github.com/kitepon/Throughline/compare/v0.10.6...v0.10.7
[0.10.6]: https://github.com/kitepon/Throughline/compare/v0.10.5...v0.10.6
[0.10.5]: https://github.com/kitepon/Throughline/compare/v0.10.4...v0.10.5
[0.10.4]: https://github.com/kitepon/Throughline/compare/v0.10.3...v0.10.4
[0.10.3]: https://github.com/kitepon/Throughline/compare/v0.10.2...v0.10.3
[0.10.2]: https://github.com/kitepon/Throughline/compare/v0.10.1...v0.10.2
[0.10.1]: https://github.com/kitepon/Throughline/compare/v0.10.0...v0.10.1
[0.10.0]: https://github.com/kitepon/Throughline/compare/v0.9.1...v0.10.0
[0.9.1]: https://github.com/kitepon/Throughline/compare/v0.9.0...v0.9.1
[0.9.0]: https://github.com/kitepon/Throughline/compare/v0.8.9...v0.9.0
[0.8.9]: https://github.com/kitepon/Throughline/compare/v0.8.8...v0.8.9
[0.8.8]: https://github.com/kitepon/Throughline/compare/v0.8.7...v0.8.8
[0.8.7]: https://github.com/kitepon/Throughline/compare/v0.8.6...v0.8.7
[0.8.6]: https://github.com/kitepon/Throughline/compare/v0.8.5...v0.8.6
[0.8.5]: https://github.com/kitepon/Throughline/compare/v0.8.4...v0.8.5
[0.8.4]: https://github.com/kitepon/Throughline/compare/v0.8.3...v0.8.4
[0.8.3]: https://github.com/kitepon/Throughline/compare/v0.8.2...v0.8.3
[0.8.2]: https://github.com/kitepon/Throughline/compare/v0.8.1...v0.8.2
[0.8.1]: https://github.com/kitepon/Throughline/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/kitepon/Throughline/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/kitepon/Throughline/compare/v0.6.3...v0.7.0
[0.6.3]: https://github.com/kitepon/Throughline/compare/v0.6.2...v0.6.3
[0.6.2]: https://github.com/kitepon/Throughline/compare/v0.6.1...v0.6.2
[0.3.22]: https://github.com/kitepon/Throughline/releases/tag/v0.3.22
[0.3.21]: https://github.com/kitepon/Throughline/compare/v0.3.19...v0.3.21
[0.3.20]: https://github.com/kitepon/Throughline/compare/v0.3.19...v0.3.20
[0.3.19]: https://github.com/kitepon/Throughline/releases/tag/v0.3.19
[0.3.18]: https://github.com/kitepon/Throughline/releases/tag/v0.3.18
[0.3.0]: https://github.com/kitepon/Throughline/releases/tag/v0.3.0
[0.2.0]: https://github.com/kitepon/Throughline/releases/tag/v0.2.0
[0.1.0]: https://github.com/kitepon/Throughline/compare/v0.1.0
