# Flow Gap Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the five builder capability gaps identified from the broken n8n import: honest run results, value-level checker rules, a persistent import report, data-shape helpers, and a first-class Drive upload tool.

**Architecture:** Warnings become a first-class concept on `StepOutcome` → `FlowRunStep.warnings` (Json) → run panel/activity badges. New `validateFlowGraph` rules reuse the existing issue pipeline (checker panel, node badges, drawer banners — zero new UI). Import warnings become structured notes persisted on `Flow.importNotes`, shown in a builder panel. A `columnarToRecords` data op and a Drive upload delivery tool close the mechanical gaps.

**Tech Stack:** Next.js App Router, Prisma/Postgres, vitest, existing flow engine (`interpret.ts` pure core + `execute-flow.ts` adapters).

## Global Constraints

- Order: Workstream 3 → 2 → 1 → 4 → 5. Commit + gate per task; push per workstream.
- Gate: `npx tsc --noEmit` clean, `npx eslint` 0 errors, `npm test` local-mode green (~1832 tests, 6 skipped OK). DB-backed tests reproduce on ci_repro Postgres before push if touched.
- Migrations via `prisma migrate dev --create-only` + reviewed SQL; deploy path is `prisma migrate deploy` (baselined). All new columns nullable — no backfill.
- No raw `{{ }}` syntax in any UI copy; plain-English messages only.
- No new run status; `succeeded` + warnings = degraded, derived in UI.
- No behavior change to success/failure semantics — warnings are additive.
- Customer-edition fork: no new operator-only surfaces here (all features are end-user; nothing to gate).

---

## Workstream 3 — Honest run results

### Task 3.1: `StepOutcome.warnings` + engine warning producers

**Files:**
- Modify: `src/features/flows/interpret.ts` (StepOutcome type ~line 12; per-item block ~575-625; loop ~1130-1185; tool/http success ~969; knowledge success ~1052)
- Test: `src/features/flows/__tests__/interpret.test.ts` (find the existing interpret test file first — `ls src/features/flows/__tests__/`; add to it)

**Interfaces:**
- Produces: `StepOutcome.warnings?: string[]` — consumed by Task 3.3 persistence and 3.4 UI.
- Helper produced: `emptyResultWarning(output: unknown): string | undefined` (module-local).

- [ ] **Step 1: Write failing tests** — per-item `itemError:'skip'` with 1 of 3 items failing emits aggregate outcome with `warnings: ['1 of 3 items failed and was skipped.']`; same for `'collect'` ("…was recorded as an error."); loop node equivalents; an http step whose adapter returns `[]` gets `warnings: ['This step succeeded but returned no items.']`; a step returning `{items: []}` likewise; non-empty outputs get no warnings.
- [ ] **Step 2: Run tests, confirm they fail** (`npx vitest run src/features/flows/__tests__/interpret.test.ts`).
- [ ] **Step 3: Implement.** Add `warnings?: string[]` to `StepOutcome`. In the per-item fan-out success emit (interpret.ts:623) count `childResults` with `kind === 'fail'` under skip/collect policy and attach the warning. Same in loop success emit (:1183) counting `iterations` where `control?.kind === 'fail'`. Add module helper:

```ts
/** A data-producing step that succeeded with nothing in it — the silent-empty
 * failure mode (a masked upstream stub). Objects count as empty when their
 * only list key is an empty array or they have no keys. */
function emptyResultWarning(output: unknown): string | undefined {
  const empty =
    (Array.isArray(output) && output.length === 0) ||
    (isRecord(output) && (Object.keys(output).length === 0 ||
      ['items', 'records', 'results', 'result', 'data'].some((k) => Array.isArray((output as Record<string, unknown>)[k]) && ((output as Record<string, unknown>)[k] as unknown[]).length === 0 && Object.keys(output).length === 1)))
  return empty ? 'This step succeeded but returned no items.' : undefined
}
```

  Attach on tool/http/knowledge success emits and the per-item aggregate when `outputs.length === 0` with `items.length > 0` → `'All N items were skipped — nothing was produced.'`. HTTP envelope note: http outputs are `{ok, status, ...body}` records — for `kind === 'http'` inspect `output.body` instead of the envelope.
- [ ] **Step 4: Run tests to green; run full local suite.**
- [ ] **Step 5: Commit** `feat(flows): step outcomes carry warnings — skipped items and empty results stop hiding`.

### Task 3.2: In-band tool-error detection

**Files:**
- Modify: `src/features/flows/tool-output.ts`
- Modify: `src/features/flows/execute-flow.ts` (tool branch of `runActionStep`, ~line 865+)
- Test: `src/features/flows/__tests__/tool-output.test.ts` (create if absent)

**Interfaces:**
- Produces: `export function inBandErrorWarning(output: unknown): string | undefined` in tool-output.ts. Consumed by execute-flow's tool adapter and Task 3.3 persistence (via `finish({ ..., warnings })`).

- [ ] **Step 1: Failing tests** — `{error: 'no such channel'}` → warning naming the error; `{ok: false, error: '...'}` → warning; `{error: null}`, `{ok: true, data: []}`, plain strings, arrays → undefined.
- [ ] **Step 2: Implement:**

```ts
/** An MCP result with isError:false can still carry an in-band failure payload
 * ({error: ...}); it reads as success and surfaces two steps later as an opaque
 * type error (parity audit §15). Surface it as a warning at the source. */
export function inBandErrorWarning(output: unknown): string | undefined {
  if (!isRecord(output)) return undefined
  const err = output.error
  if (err === undefined || err === null || err === '') return undefined
  const keys = Object.keys(output)
  const onlyErrorish = keys.every((k) => ['error', 'ok', 'success', 'message', 'code', 'status'].includes(k))
  if (!onlyErrorish) return undefined
  const text = typeof err === 'string' ? err : JSON.stringify(err)
  return `The tool reported success but its response contains an error: ${text.slice(0, 200)}`
}
```

- [ ] **Step 3: Wire into the tool adapter** — after computing the tool output, `const warning = inBandErrorWarning(output)`; pass `warnings: warning ? [warning] : undefined` through `finish` (extended in Task 3.3; until then hold the change or land 3.2+3.3 together — preferred: implement 3.2 and 3.3 in one commit).
- [ ] **Step 4: Green + commit** (with 3.3).

### Task 3.3: Persist warnings — migration + execute-flow plumbing

**Files:**
- Modify: `prisma/schema.prisma` (FlowRunStep, line ~1190: add `warnings Json?` after `logs`)
- Create: `prisma/migrations/<ts>_flow_run_step_warnings/migration.sql` (`ALTER TABLE "flow_run_steps" ADD COLUMN "warnings" JSONB;`)
- Modify: `src/features/flows/execute-flow.ts` — `onStep` (write `warnings` in both create paths and the succeeded-update path), `runActionStep.finish` (accept `warnings?: string[]`), the runs API serializer (find where step rows are shaped for the client — grep `logs` in `src/app/api` and include `warnings` alongside).
- Test: extend `src/app/api/flows/__tests__/` or the step-io persistence db test (grep `step-io-persistence`) — a run with a skip-policy per-item failure persists the aggregate row with warnings.

- [ ] **Step 1:** Schema + `npx prisma migrate dev --create-only --name flow_run_step_warnings` (against ci_repro DB; local has no Supabase). Review SQL.
- [ ] **Step 2: Failing db test** (ci_repro), then plumb: `onStep` writes `warnings: outcome.warnings?.length ? jsonValue(outcome.warnings) : undefined` in the interpreter-persisted create, the adapter-success update (updateMany data gains warnings when present), and the failed backfill; `finish` in `runActionStep` forwards adapter warnings.
- [ ] **Step 3: Green on ci_repro; local suite green; commit** `feat(flows): persist step warnings (+ in-band tool error detection)`.

### Task 3.4: Surface warnings in run panel + activity

**Files:**
- Modify: `src/components/flows/run-panel.tsx` (step rows + run selector), `src/app/flows/[id]/activity/page.tsx` (run rows), `src/lib/flows/run-stream.ts` only if the tick payload needs it (it doesn't — panel refetches on tick).

- [ ] **Step 1:** Step row: when `step.warnings?.length`, render an amber-bordered list under the output (reuse the drawer-issues visual pattern: `border-warn/40 bg-warn-muted` tokens as used by checker issues — copy exact classes from step-drawer's warning banner). Run selector + activity row: amber dot + `title="N warnings"` when any step of the run carries warnings (derive: `steps.some(s => s.warnings?.length)`); a succeeded run with failed steps (onError continue) counts too: `steps.some(s => s.status === 'failed') && run.status === 'succeeded'`.
- [ ] **Step 2:** tsc/eslint/tests; commit `feat(flows): degraded-run surfacing — warnings visible in run panel and activity`. Push workstream 3; watch CI.

---

## Workstream 2 — Checker rules

### Task 2.1: PLACEHOLDER_VALUE + SQL_TOKEN_IN_LITERAL

**Files:**
- Modify: `src/lib/flows/validate.ts`
- Test: `src/lib/flows/__tests__/validate.test.ts`

- [ ] **Step 1: Failing tests** — http url `https://YOUR_ACCOUNT.snowflakecomputing.com/...` → error PLACEHOLDER_VALUE; url with `<your-domain>` → error; normal urls fine. Code node whose code starts `// TODO (imported from n8n` → error. Http json body `{"statement": "SELECT * FROM t WHERE name ILIKE '%{{item.accountName}}%'"}` → warning SQL_TOKEN_IN_LITERAL; body without quoted token → none.
- [ ] **Step 2: Implement** inside the main node loop:

```ts
const PLACEHOLDER_RE = /YOUR_[A-Z][A-Z0-9_]*|<[a-z][a-z0-9 _-]*>/i
// http: url placeholders (checked before brand/auth so the message leads)
if (node.type === 'http' && !hasTemplate(node.data.url) && PLACEHOLDER_RE.test(node.data.url)) {
  add(issues, 'error', 'PLACEHOLDER_VALUE', `${nodeLabel(node)} still has a placeholder in its URL — replace it with your real account address.`, node.id)
}
if (node.type === 'code' && node.data.code.trimStart().startsWith('// TODO (imported from n8n')) {
  add(issues, 'error', 'PLACEHOLDER_VALUE', `${nodeLabel(node)} is an imported stub that passes data through unchanged — finish it or delete it.`, node.id)
}
if (node.type === 'http' && node.data.body) {
  const sqlField = ((): string | undefined => {
    const parsed = parseObjectJson(node.data.body)
    if (!parsed) return undefined
    for (const key of ['statement', 'sql', 'query']) {
      const v = parsed[key]
      if (typeof v === 'string') return v
    }
    return undefined
  })()
  if (sqlField && /'[^']*\{\{[^}]+\}\}[^']*'/.test(sqlField)) {
    add(issues, 'warning', 'SQL_TOKEN_IN_LITERAL', `${nodeLabel(node)} pastes flow data directly into a SQL string — a quote in the data breaks the query. Use the API's bind variables instead.`, node.id)
  }
}
```

- [ ] **Step 3: Green; commit** `feat(flows): checker catches placeholder stubs and SQL-injection-prone bodies`.

### Task 2.2: Token reference validation (TOKEN_UNKNOWN_STEP / TOKEN_UNKNOWN_VAR)

- [ ] **Step 1: Failing tests** — node data containing `{{step.ghost.output}}` where no node `ghost` exists → error naming the step's label; `{{var.typo}}` with no initializer named `typo` → error; valid references, `{{item.x}}`, `{{trigger.input.y}}` untouched. A `{{step.<id>}}` where id exists → fine.
- [ ] **Step 2: Implement** after the TEXT_AGENT_FIELD_REF block, same JSON.stringify scan pattern:

```ts
const varNames = new Set(graph.nodes.filter((n): n is Extract<FlowNode, {type:'variable'}> => n.type === 'variable' && n.data.op === 'initialize').map((n) => n.data.name.trim()).filter(Boolean))
for (const node of graph.nodes) {
  if (node.type === 'trigger') continue
  const dataStr = JSON.stringify(node.data)
  for (const m of dataStr.matchAll(/\{\{\s*step\.([^.}\s]+)/g)) {
    if (!byId.has(m[1])) {
      add(issues, 'error', 'TOKEN_UNKNOWN_STEP', `${nodeLabel(node)} uses data from a step that no longer exists — open its settings and re-pick the value from the data menu.`, node.id)
      break
    }
  }
  for (const m of dataStr.matchAll(/\{\{\s*var\.([^.}\s]+)/g)) {
    if (!varNames.has(m[1])) {
      add(issues, 'error', 'TOKEN_UNKNOWN_VAR', `${nodeLabel(node)} uses a variable "${m[1]}" that no step initializes.`, node.id)
      break
    }
  }
}
```

  (One issue per node per kind — matches the TEXT_AGENT_FIELD_REF dedupe style. Escaped-JSON false positives are impossible: token text has no quotes.)
- [ ] **Step 3: Green; commit.**

### Task 2.3: PER_ITEM_STATIC_ARGS + LIST_INTO_SINGLE cardinality

- [ ] **Step 1: Failing tests** — perItem tool step with args `{"channel": "D095KBU0KNZ"}` → warning PER_ITEM_STATIC_ARGS; args containing `{{item.slackChannelId}}` or `{{input}}` → none. A perItem-enabled step `a` feeding (edge) a non-perItem `http` step whose data references `{{step.a.output}}` → warning LIST_INTO_SINGLE on the http node; same when the http node references it only via the edge chain (`{{input}}`); no warning when the consumer has perItem or is a data/join/loop node.
- [ ] **Step 2: Implement:**

```ts
// A per-item step whose config never mentions the current item makes N
// identical calls — the hardcoded-ID bug. `over` itself is excluded.
for (const node of graph.nodes) {
  const perItem = (node.data as { perItem?: { over?: string } }).perItem
  if (!perItem?.over?.trim()) continue
  const { perItem: _p, ...rest } = node.data as Record<string, unknown>
  const rendered = JSON.stringify(rest)
  if (!/\{\{\s*(item[.}]|item\s*\}\}|input[.}]|input\s*\}\})/.test(rendered)) {
    add(issues, 'warning', 'PER_ITEM_STATIC_ARGS', `${nodeLabel(node)} runs once per item but never uses the current item — every run will be identical. Pick a value from "Current item" in the data menu.`, node.id)
  }
}
// List-shaped output consumed whole by a side-effecting step.
const listProducers = new Set(graph.nodes.filter((n) => {
  if ((n.data as { perItem?: { over?: string } }).perItem?.over?.trim()) return true
  if (n.type === 'loop') return true
  return false
}).map((n) => n.id))
for (const edge of graph.edges) {
  if (!listProducers.has(edge.source)) continue
  const target = byId.get(edge.target)
  if (!target || !['http', 'tool', 'agent'].includes(target.type)) continue
  if ((target.data as { perItem?: { over?: string } }).perItem?.over?.trim()) continue
  add(issues, 'warning', 'LIST_INTO_SINGLE', `${nodeLabel(byId.get(edge.source))} produces a list, but ${nodeLabel(target)} runs only once over the whole thing — turn on "run once per item" on ${nodeLabel(target)} if you meant one run per item.`, target.id)
}
```

- [ ] **Step 3: Green; run the full local suite (importer fixtures exercise validate indirectly via page-level tests); commit.**

### Task 2.4: Agent tool-connection validation

- [ ] **Step 1: Failing tests** — agent node with `toolConnectionIds: ['nango:slack']` and a catalog lacking it → error UNKNOWN_AGENT_TOOL_CONNECTION; catalog entry with `toolsError` → error AGENT_TOOL_CONNECTION_UNAVAILABLE; valid ids → none; no catalog in context → skipped (same convention as tool nodes).
- [ ] **Step 2: Implement** in the agent branch of the node loop, mirroring the tool-node messages:

```ts
for (const connId of node.data.toolConnectionIds ?? []) {
  if (context.toolCatalog && !connectionIds.has(connId)) {
    add(issues, 'error', 'UNKNOWN_AGENT_TOOL_CONNECTION', `${nodeLabel(node)} grants the agent a tool connection that is not available — re-pick it under Tools.`, node.id)
  } else if (toolErrorsByConnection.get(connId)) {
    add(issues, 'error', 'AGENT_TOOL_CONNECTION_UNAVAILABLE', `${nodeLabel(node)} grants the agent a connection that can't be reached — reconnect it in Integrations.`, node.id)
  }
}
```

- [ ] **Step 3: Green; commit; push workstream 2.** Check the publish/execute routes load `toolCatalog` covering agent `toolConnectionIds` (grep how publish collects "used connection ids" — extend the collector to include `toolConnectionIds` so the context isn't blind there).

---

## Workstream 1 — Import report that persists

### Task 1.1: Structured import notes in `n8nToFlow`

**Files:**
- Modify: `src/lib/flows/import/from-n8n.ts`
- Test: `src/lib/flows/import/__tests__/from-n8n.test.ts`

**Interfaces:**
- Produces: `export type FlowImportNote = { code: string; severity: 'error' | 'warning' | 'info'; message: string; nodeId?: string }`; `N8nImportResult` gains `notes: FlowImportNote[]` (keep `warnings: string[]` derived as `notes.map(n => n.message)` for compat).

- [ ] **Step 1: Failing tests** — an import producing a placeholder-URL skeleton yields a note `{code: 'CREDENTIAL_SKELETON', nodeId: <the http node id>}`; unmapped node type yields `{code: 'UNMAPPED_NODE'}`; `warnings` still equals the messages array.
- [ ] **Step 2: Implement.** Replace the internal `warn(message)` with `warn(message, opts?: { code?: string; nodeId?: string; severity?: 'error'|'warning'|'info' })` pushing into `notes` (default code `IMPORT_NOTE`, severity `warning`). Update call sites where a specific node is in hand to pass `nodeId` (at minimum: placeholder skeletons, unmapped nodes, per-item semantics, credential non-transfer, kept-verbatim expressions, dropped loop edges). Codes: `CREDENTIAL_SKELETON`, `UNMAPPED_NODE`, `EXPRESSION_KEPT`, `LOOP_EDGE_DROPPED`, `CREDENTIAL_NOT_TRANSFERRED`, `EXTRA_TRIGGER`, else `IMPORT_NOTE`.
- [ ] **Step 3: testMode heuristic** — detect an n8n boolean param named `/^test[_-]?mode$/i` (Set/Workflow-Parameters node) feeding an IF that gates on it; note on the resulting condition node: code `TEST_MODE_BRANCH`, message: `This looks like an imported test-mode switch. In this builder an unpublished flow already runs privately, so this branch may be dead weight — review whether both paths still make sense.` Add a fixture test with a Params node (`testMode: true`) + IF gating on it.
- [ ] **Step 4: Green; commit** `feat(flows): structured n8n import notes with node correlation + test-mode detection`.

### Task 1.2: Persist + post-import validation

**Files:**
- Modify: `prisma/schema.prisma` (Flow model ~line 871: `importNotes Json?`), new migration `flow_import_notes`
- Modify: `src/app/api/flows/import/route.ts` — after creating the flow, run `validateFlowGraph(converted.graph, {})` (structure-only context — connection-aware issues are the builder's live job) and store `importNotes: jsonValue({ notes, blocking: validation.errors.length })`; response includes both counts.
- Modify: `src/components/flows/use-flow-import.tsx` — toast becomes `Imported — N problems to fix, M notes` (skip when both zero); replace `window.prompt` URL entry with the existing dialog primitives (small; reuse Dialog + Input as in http-credential-dialog).
- Test: `src/app/api/flows/__tests__/import-route.db.test.ts` — imported flow row carries importNotes with notes + blocking count.

- [ ] **Steps:** migration → failing db test → implement → ci_repro green → commit.

### Task 1.3: Import notes panel in the builder

**Files:**
- Create: `src/components/flows/import-notes-panel.tsx` (mirror `checker-panel.tsx`: severity sections, jump-to-node via `onJump`, a "Clear notes" button)
- Modify: `src/app/flows/[id]/page.tsx` (panel toggle in the toolbar cluster from UI Phase B, rendered only when `flow.importNotes` non-null), the flow GET serializer if importNotes isn't already included, and a clear path: `PUT /api/flows` accepts `importNotes: null` (check the zod body schema in `src/app/api/flows/route.ts` and allow the field).

- [ ] **Steps:** build panel → wire toggle + clear → tsc/eslint/tests → commit `feat(flows): import notes panel — the report survives the toast`; push workstream 1.

---

## Workstream 4 — Data-shape helpers

### Task 4.1: `columnarToRecords` data op

**Files:**
- Modify: `src/lib/flows/graph.ts` (DATA_OPS union + zod), `src/lib/flows/data-ops.ts` (op + DATA_OP_LABELS entry "Columns to records"), step-drawer op picker if ops are listed manually (grep `DATA_OP_LABELS` usages)
- Test: `src/lib/flows/__tests__/data-ops.test.ts`

- [ ] **Step 1: Failing tests** — Snowflake shape `{resultSetMetaData: {rowType: [{name:'ACCOUNTNAME'},{name:'DF_ENTITLED'}]}, data: [['Acme', true]]}` → `[{ACCOUNTNAME:'Acme', DF_ENTITLED:true}]`; generic `{columns:['a','b'], rows:[[1,2]]}` → `[{a:1,b:2}]`; already-record arrays pass through unchanged; unrecognized shapes → plain-English error.
- [ ] **Step 2: Implement** in `runDataOp`:

```ts
if (op === 'columnarToRecords') {
  const v = input as Record<string, unknown> | unknown[]
  if (Array.isArray(v) && v.every(isRecord)) return { output: v } // already records
  if (isRecord(v)) {
    const meta = isRecord(v.resultSetMetaData) && Array.isArray(v.resultSetMetaData.rowType)
      ? (v.resultSetMetaData.rowType as { name?: unknown }[]).map((c) => String(c?.name ?? ''))
      : Array.isArray(v.columns) ? (v.columns as unknown[]).map(String) : null
    const rows = Array.isArray(v.data) ? v.data : Array.isArray(v.rows) ? v.rows : null
    if (meta && rows) {
      return { output: (rows as unknown[][]).map((row) => Object.fromEntries(meta.map((name, i) => [name, row?.[i]]))) }
    }
  }
  return { error: 'Columns to records needs a response with column names and rows — like a Snowflake SQL API result.' }
}
```

- [ ] **Step 3: Green; commit.**

### Task 4.2: Import hints for positional merges + Snowflake mapping

- [ ] **Step 1:** In from-n8n.ts, when a Merge node maps to `combineByPosition`, add note `{code: 'MERGE_BY_POSITION', nodeId, severity: 'info', message: 'This merge pairs items by position, which breaks if one side drops an item — switch it to match on a shared field if the lists can get out of step.'}`. When mapping an HTTP skeleton for a Snowflake SQL-API URL (`/api/v2/statements`), auto-insert a downstream `data` node `{op: 'columnarToRecords', input: '{{step.<httpId>.output.body}}'}` wired between the http node and its consumers, with note code `SNOWFLAKE_SHAPE` explaining why. Test both in from-n8n.test.ts.
- [ ] **Step 2: Green; commit.**

### Task 4.3: "Send test request" in the HTTP drawer

- [ ] **Step 1:** In `src/components/flows/step-drawer.tsx` HTTP section (~1383-1520), add a "Send test request" button beside the credential-test button. It calls the existing partial-execution path the builder's "Execute step" uses (find the handler in page.tsx that sets `stopAfterNodeId` — grep `stopAfterNodeId` in page.tsx — and expose it to the drawer as a prop `onExecuteStep?: (nodeId: string) => void`). The resulting run populates `lastOutputs`, so the data tree learns the response shape with zero new machinery. Button disabled while a run is active; helper text: "Runs the steps before this one, then this request, and captures the response for the data menu."
- [ ] **Step 2:** tsc/eslint/tests; commit `feat(flows): send-test-request from the HTTP drawer`; push workstream 4.

---

## Workstream 5 — Drive upload tool

### Task 5.1: `google_drive_upload_file` delivery tool

**Files:**
- Modify: `src/lib/nango/delivery.ts` (DELIVERY_TOOLS + executor), `src/lib/nango/provider-tools.ts` if Drive tools are listed there for the catalog (GDRIVE_TOOLS)
- Test: `src/lib/nango/__tests__/delivery.test.ts` (mime assembly pure-tested like `buildGmailMimeMessage`)

**Interfaces:**
- Tool args schema: `{ filename: string (required), content?: string, fileId?: string, mimeType?: string, folderId?: string }` — one of content/fileId required.
- Produces: `buildDriveMultipartBody({filename, mimeType, bytes, folderId}): { body: Blob | Buffer, contentType: string }` and executor `googleDriveUploadFile(...)` POSTing `upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink` via the same Nango proxy Gmail uses.

- [ ] **Step 1: Failing tests** — multipart body contains a JSON metadata part with `{"name": "report.html", "parents": ["folder123"]}` and a media part with the payload + `Content-Type: text/html`; missing both content and fileId → plain-English error; mimeType defaults from filename extension (`.html` → `text/html`, `.txt` → `text/plain`, `.pdf` → `application/pdf`, else `application/octet-stream`).
- [ ] **Step 2: Implement** following `gmailSendEmail`'s proxy pattern; `fileId` inputs resolve bytes via `saveStoredFile`'s read counterpart in `src/lib/files/storage.ts` (grep for the load function). Register in DELIVERY_TOOLS so tool steps and agents can call it; catalog exposure follows the gmail_send_email registration path exactly.
- [ ] **Step 3: Green; commit.**

### Task 5.2: Importer maps n8n Drive uploads

- [ ] **Step 1: Failing test** — an n8n `googleDrive` node with `operation: 'upload'` maps to a `tool` node `{connectionId: 'nango:google-drive', toolName: 'google_drive_upload_file'}` (exact connection ref: match how the read tools bind — grep `google_drive_list_files` in from-n8n.ts) with `filename`/`content` args mapped from the n8n params, per-item inference applying as usual; the old "read-only" missing note is gone for uploads.
- [ ] **Step 2: Implement in `integrationBindingFor`/`mapNode`; green; commit** `feat(flows): first-class Google Drive upload — imports stop falling back to broken raw HTTP`; push workstream 5.

---

## Final gate

- [ ] Full local suite + tsc + eslint; ci_repro CI-mode suite for db-touched areas; push; watch GitHub Actions to green.
- [ ] Update `.superpowers/sdd/progress.md` with the workstream ledger entry.
