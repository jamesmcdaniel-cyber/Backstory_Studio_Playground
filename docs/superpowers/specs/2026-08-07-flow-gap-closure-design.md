# Flow gap closure — run truthfulness, checker rules, import report, data-shape helpers, Drive upload

**Date:** 2026-08-07
**Status:** Approved (user: "Yes close all gaps in that order")
**Origin:** A real broken v2.3 n8n import (Snowflake → Slack → agent → Gmail account-brief flow) whose seven failure classes were diagnosed externally. Credentials aside, they collapse into five builder capability gaps. Build order: **3 → 2 → 1 → 4 → 5** (numbers kept from the design discussion).

## Motivating failure classes (from the diagnosed flow)

1. Per-item Slack read hardcoded to one DM id — ignored the per-item `slackChannelId` computed upstream.
2. Snowflake HTTP step was a placeholder skeleton (`YOUR_ACCOUNT.snowflakecomputing.com`); fail-soft downstream masked it, so runs "succeeded" with no provisioning data.
3. Merge by position over a fragile per-item HTTP fan-out; Snowflake SQL API returns columnar `{resultSetMetaData, data: [[...]]}` — field access returns `undefined` even with working auth.
4. Drive upload via raw HTTP: no auth, `uploadType=media` (no filename), and ran once over an N-item input.
5. Imported `testMode` boolean + IF gate — dead branch in a platform where unpublished flows ARE test mode; side effects lived on the "test" branch.
6. Agent prompt assumed MCP tools that may not be attached; label→id shim referenced replaced nodes.
7. Minor: ILIKE injection via token-in-SQL-literal, mimeType/extension mismatch, orphaned note edge.

Already covered today (no work): `HTTP_NO_AUTH` blocks unauthenticated HTTP at run/publish; Gmail auto-detects HTML bodies (`buildGmailMimeMessage`).

---

## Workstream 3 — Honest run results (build first)

**Problem:** No warning/degraded concept exists. `StepOutcome` (src/features/flows/interpret.ts) has no warnings field; `FlowRunStep` has no warnings column; `itemError:'skip'` drops items while the step reports `succeeded`; MCP tools returning in-band `{error}` payloads read as success (src/features/flows/tool-output.ts; parity audit §15); "succeeded but 0 rows" surfaces nowhere.

**Design:**
- `StepOutcome` gains `warnings?: string[]` (plain user-facing sentences).
- `FlowRunStep` gains a `warnings Json?` column (Prisma migration, `prisma migrate deploy` path). Runs derive degraded-ness; **no new run status** — a run stays `succeeded` but the run panel/activity show a warning badge when any step carries warnings (YAGNI: no schema change on `FlowRun`).
- Warning producers in the engine:
  - Per-item / loop: `N of M items failed (skipped|collected)` when `itemError` is `skip`/`collect` and failures occurred.
  - `onError:'continue'`: `Step failed (<reason>) — continuing because on-error is set to continue.`
  - Empty result: side-effect-free data-producing steps (`http`, `tool`, `knowledge`, per-item fan-outs) that succeed with an empty array / empty object / 0 paginated items: `Returned no items.`
  - In-band tool errors: `flowToolOutput` detects `isError:false` payloads whose parsed body is `{error: ...}` (single-key or `error` + `ok:false` shapes) → warning (not failure — behavior change kept minimal).
- Surfacing: run panel step rows get an amber warning list; run selector/activity rows get an amber dot + count when the run has ≥1 step warning. Realtime stream passes warnings through.

## Workstream 2 — Checker rules for "configured but wrong"

New rules in `src/lib/flows/validate.ts` (existing issue shape `{level, code, message, nodeId}`), surfaced automatically by the existing checker panel / node badges / drawer banners:

- `PLACEHOLDER_VALUE` (error): HTTP url containing `YOUR_ACCOUNT`, `YOUR_DOMAIN`, `YOUR_INSTANCE`, `example.com` skeleton hosts, or `<...>` angle-bracket placeholders; code steps whose body is the importer's `// TODO (imported from n8n` passthrough stub.
- `PER_ITEM_STATIC_ARGS` (warning): a step with `perItem` enabled whose serialized config contains no `{{item.` token — N identical calls is almost always a bug.
- `LIST_INTO_SINGLE` (warning): an upstream step that statically produces a list (perItem-enabled step, loop container output, data op that emits arrays — `parseCsv`, `splitOut`-style ops) feeds a side-effecting non-per-item consumer (`http`/`tool`/`agent` with a template referencing that step's output). Heuristic port of the importer's `isItemProducing`/`dataParentOf` idea onto our graph.
- `TOKEN_UNKNOWN_STEP` / `TOKEN_UNKNOWN_VAR` (error): any `{{step.<id>.…}}` naming a node id absent from the graph; `{{var.<name>}}` naming a variable no upstream variable node declares. (Foreign/malformed syntax already fails at runtime; this makes it a builder-time error.)
- `AGENT_TOOL_CONNECTION` checks (error/warning): agent `toolConnectionIds` validated for existence in the tool catalog and availability — parity with what `tool` nodes already get (`UNKNOWN_TOOL_CONNECTION`, `TOOL_CONNECTION_UNAVAILABLE`).
- `SQL_TOKEN_IN_LITERAL` (warning): a template token inside a single-quoted SQL string literal in an HTTP body (`'…{{token}}…'` preceded by ILIKE/LIKE/= within a `statement`/`sql`/`query` body field) → suggest bind variables.

## Workstream 1 — Import report that persists

- `n8nToFlow` warnings become structured: `{code, severity: 'error'|'warning'|'info', message, nodeId?}` (keep a `messages: string[]` compatibility view). Call sites get codes + node correlation where the target node id is known.
- `Flow` gains `importNotes Json?` (migration). The import route stores the structured report **plus** the result of a post-import `validateFlowGraph` pass (blocking count included in the toast: "Imported with N blocking problems and M notes").
- Builder: "Import notes" panel (checker-panel pattern: sections, jump-to-node, dismiss-all clears `importNotes`). Toolbar shows an entry only when notes exist.
- New importer heuristic: detect an n8n boolean parameter named like `testMode`/`test_mode` gating an IF/condition node → warning note on the condition node explaining that unpublished flows are test mode here and the branch is likely dead. Detection + note only; no auto-collapse (invariant: never reintroduce a test-mode concept).

## Workstream 4 — Data-shape helpers

- **Columnar→records data op** (`data` node op `columnarToRecords`): input `{resultSetMetaData:{rowType:[{name}]}, data:[[…]]}` (Snowflake SQL API v2) or generic `{columns:[…], rows:[[…]]}` → `[{col: value}]`. Auto-detects which of the two shapes it received; declared output fields inferred when metadata is present at build time via sample data.
- **Importer merge preference:** n8n Merge in combine-by-position mode with a shared key inferable from downstream usage stays positional but gets a structured note suggesting `combineByKey`; n8n merge configured `combineByKey` already maps (verify + test).
- **HTTP "Send test request"**: button in the HTTP drawer that executes just this step server-side (reusing `prepareHttpRequest` + credential resolution, tokens resolved against the selected run's outputs / test input like the existing preview context), and feeds the response into the drawer's data tree as observed sample (client state; no new persistence — `pinData` already exists for durable mocks).

## Workstream 5 — First-class Drive upload

- New delivery tool `google_drive_upload_file` (Nango Drive plane, alongside the two read tools): args `{filename, content | fileId, mimeType?, folderId?}` → multipart upload (metadata part carries `name`, media part carries bytes; `StoredFile` bytes when a file reference is passed, else UTF-8 content). Registered in the tool catalog like `gmail_send_email`.
- Importer: n8n `googleDrive` upload operation maps to a `tool` step bound to this tool (per-item inference applies) instead of the current "read-only" missing-mapping fallback.

## Error handling & testing

- Engine changes are additive (`warnings` optional everywhere); no behavior change to success/failure semantics except new warnings.
- Migrations: two (`FlowRunStep.warnings`, `Flow.importNotes`), both nullable Json — deploy-safe via `prisma migrate deploy`.
- Tests per workstream: interpret/execute unit tests for warning producers; validate.test.ts cases per new rule; from-n8n.test.ts for structured warnings, testMode heuristic, Drive mapping; merge/data-ops tests for `columnarToRecords`; db tests for persisted warnings/importNotes (CI-mode; reproduce on ci_repro before push).
- Gate per workstream commit: tsc clean, eslint 0 errors, local-mode test suite green; CI validates DB-backed tests + build.

## Out of scope

Gmail cc/bcc/attachments; convert-to-file/extract-from-file first-class steps (stays deferred per parity audit); auto-collapse of imported testMode branches; new run statuses; raw `{{ }}` exposure anywhere in UI (chips only, per standing mandate).
