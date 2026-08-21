# Trace & Analytics Evidence Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every reported trace value and analytics number measured-at-source, persisted server-side, and traceable to evidence — with explicit markers wherever anything is estimated, truncated, or sampled.

**Architecture:** Two planes hardened in place. Trace plane: the flow engine (`src/features/flows/execute-flow.ts` + interpreter) records real timings, retries, truncations, and terminal statuses; the LLM ledger becomes transactional and fully attributed. Analytics plane: every aggregate (`/api/admin/costs`, `/api/admin/models`, `/api/usage`, `/api/snapshot`, roster KPIs, bench/shadow evals) derives from source rows with honest denominators and disclosed sampling.

**Tech Stack:** Next.js App Router, Prisma/Postgres, BullMQ (Fly worker), Redis/Upstash, vitest/node test runner as repo convention dictates.

**Spec:** `docs/superpowers/specs/2026-08-20-trace-analytics-evidence-hardening-design.md`

## Global Constraints

- Local env has no Supabase vars — validate via `npx tsc --noEmit`, lint, and unit tests; never `next build` locally. DB-backed tests run in CI mode (local Postgres `ci_repro`) before push.
- Schema changes: author a real migration under `prisma/migrations/` (deploy path is `prisma migrate deploy`, baselined). Never `db push`.
- Test files must stay under ~45KB (tsx+node22 load hang) — split rather than grow.
- Peers may commit the whole tree: `git status` and re-check state before staging; stage only your task's files.
- No new operator-only UI without the customer-edition gate in the same commit (all admin pages here are already operator surfaces — verify the gate covers your edits, do not add new routes outside it).
- After engine/runtime changes merge, the Fly worker needs `fly deploy` (flag it in the final report; do not deploy from a task).
- Statuses remain plain strings; update the schema doc-comments when you add a status to the written set.
- Commit after every task, direct to main, message style `fix(scope):`/`feat(scope):` matching recent history.

---

### Task 1: Truncation markers everywhere + tool-error heuristic (T4, X7, X8)

**Files:**
- Create: `src/lib/flows/truncate.ts`
- Modify: `src/features/flows/execute-flow.ts` (error slices at ~356, 807, 830, 909, 963, 1759; knowledge extraction ~1462), `src/features/flows/code-runner.ts` (~28, 73, 128, 243), `src/features/flows/http.ts` (~304), `src/lib/flows/tool-output.ts` (~52), `src/features/flows/run-step-persistence.ts` (~20–29)
- Test: `src/lib/flows/truncate.test.ts` (mirror the repo's existing test-file placement convention — check where sibling tests live first)

**Interfaces:**
- Produces: `truncateWithMarker(text: string, max: number): string` — returns `text` unchanged when `text.length <= max`; otherwise returns `text.slice(0, max) + "\n… [truncated ${text.length - max} chars]"`. Also `truncateError(err: unknown, max?: number): string` (default 300) that stringifies then applies the marker.

- [ ] **Step 1:** Write failing tests: under-limit passthrough; over-limit output ends with `[truncated N chars]` where N is exact; `truncateError` handles Error, string, and object inputs; marker never appears on exact-length input.
- [ ] **Step 2:** Run the test file; verify it fails (module missing).
- [ ] **Step 3:** Implement `truncate.ts`; replace every silent `.slice()` at the listed sites with the helper (error 300, code logs 2000/entry + a final log entry `"… [log truncated at 200 entries]"` when the 200 cap hits, HTTP bodyText 50k, tool output 50k, knowledge 200k). In `run-step-persistence.ts`, change the prose replacing `context.steps` to state the executed input contained the full prior-step context and was elided at persistence. In `tool-output.ts` (~42–50), harden the in-band error heuristic: a payload whose keys are all errorish **after ignoring benign metadata keys** (`request_id`, `requestId`, `trace_id`, `traceId`, `id`, `timestamp`) is treated as an error, and when the heuristic fires the step's warnings record which rule matched (`"in-band tool error detected via key heuristic"`); add tests for an error payload carrying `request_id` (now caught) and a legitimate success payload with a `status` field (not caught).
- [ ] **Step 4:** Tests green; `npx tsc --noEmit` clean.
- [ ] **Step 5:** Commit `fix(flows): truncated trace artifacts carry explicit markers`.

### Task 2: Real interpreter step timings (T1) + timing rendered in the Runs panel (T8-UI)

**Files:**
- Modify: `src/features/flows/interpret.ts` (StepOutcome ~15–40 and every producer), `src/features/flows/execute-flow.ts` `onStep` (~725–838: stop writing `startedAt: new Date(), finishedAt: new Date()` at persist time), `src/components/flows/run-panel.tsx` (render per-step duration from `startedAt`/`finishedAt`, which the API already returns)
- Test: interpreter unit test asserting a slow node's outcome carries `finishedAt - startedAt >= actual elapsed` (use a fake node that awaits ~50ms), and that `onStep` persists the outcome's timestamps verbatim (existing engine test harness — find the current execute-flow/interpret tests and extend the smallest one).

**Interfaces:**
- Produces: `StepOutcome` gains `startedAt: Date` and `finishedAt: Date`, measured immediately around node execution in the interpreter. All interpreter-persisted rows (`condition|loop|parallel|stop|data|transform|variable|humanReview|wait|output|merge|filter`) write these values.

- [ ] **Step 1:** Failing test: interpreter outcome for a 50ms fake node reports >=50ms span.
- [ ] **Step 2:** Verify fail. **Step 3:** Implement timing capture in the interpreter loop (one measurement site, not per node type) and thread through `onStep` persistence. **Step 4:** Green + tsc. **Step 5:** In `run-panel.tsx`, render duration (e.g. `1.2s`) beside each step status when both timestamps exist — the panel's own copy already promises timing. **Step 6:** Commit `fix(flows): interpreter steps record real execution timings; runs panel shows them`.

### Task 3: Run duration excludes queue wait (T2)

**Files:**
- Modify: `src/features/flows/execute-flow.ts` worker-adoption path (~456–463): when `runFlowExecution` adopts a prepared `running` row it did not just create, refresh `startedAt: new Date()` — exactly as the resume/patch claims already do (~400, 410).
- Test: engine test (CI-mode/DB-backed) asserting an adopted prepared run's persisted `startedAt` is >= adoption time, not row-creation time.

- [ ] **Step 1:** Failing test. **Step 2:** Verify fail. **Step 3:** Implement (guard: only refresh when the adoption is the first pickup — mirror the resume claim's update shape). **Step 4:** Green + tsc. **Step 5:** Commit `fix(flows): run duration measures execution, not queue wait`.

### Task 4: Retry evidence (T3)

**Files:**
- Modify: `src/features/flows/action-reliability.ts` (`runWithRetries` ~124–180), `src/features/flows/interpret.ts` (`runAgentWithReliability` ~202–233), `src/features/flows/execute-flow.ts` (append to step `warnings`)
- Test: extend the existing action-reliability tests: a function failing twice then succeeding yields a result carrying `attempts: 3` and two attempt-error strings.

**Interfaces:**
- Produces: `runWithRetries` (and the agent variant) resolve with `{ …existing, attempts: number, attemptErrors: string[] }` where `attemptErrors[i]` is `"attempt ${i+1}/${max} failed: ${truncateError(err)}"`. The engine appends each entry to the step's persisted `warnings` array and, on final failure, keeps the last error in `error` as today.

- [ ] **Step 1:** Failing tests (both retry helpers). **Step 2:** Verify fail. **Step 3:** Implement; wire warnings persistence at every adapter `finish` site that has retry context. **Step 4:** Green + tsc. **Step 5:** Commit `feat(flows): retries leave evidence — attempt counts and errors persisted on step warnings`.

### Task 5: Status integrity — no orphans, no dead ends (T5, X4)

**Files:**
- Modify: `src/lib/queue/flow-dead-letter.ts` (~60–64), `src/features/flows/execute-flow.ts` (`failPreparedRun` ~352–359; `onExecutionCreated` ~866–868; `onStep` upserts ~750–812), `src/app/api/flows/[id]/cancel/route.ts` (~26–37), `src/components/flows/node-presentation.ts` (`STATUS_TEXT` ~108–117), `prisma/schema.prisma` (doc-comments for the real status sets)
- Test: DB-backed tests — (a) dead-lettering a run with a `running` step leaves that step `failed`; (b) `failPreparedRun` same; (c) cancelling a `waiting` run lands `cancelled` immediately with steps swept (`running|waiting` → `cancelled`); (d) `onExecutionCreated` update is a no-op when the step is already terminal.

- [ ] **Step 1:** Failing tests. **Step 2:** Verify fail. **Step 3:** Implement: add `flowRunStep.updateMany({ where: { flowRunId, status: 'running' }, data: { status: 'failed', finishedAt: now, error: <cause> } })` to dead-letter + failPreparedRun (mirror the existing end-of-run sweep at ~1826–1834); cancel route: `waiting` runs go straight to `cancelled` + step sweep (only `running` runs pass through `cancelling` for the executor to finish); status-guard `onExecutionCreated` on `status: 'running'`; convert the read-then-act `onStep` sequences into `$transaction`-wrapped upserts. Add `cancelled` to `STATUS_TEXT`. **Step 4:** Green + tsc + CI-mode suite. **Step 5:** Commit `fix(flows): terminal runs never contain running steps; cancelling a waiting run completes`.

### Task 6: Ledger attribution and durability (T6, T7, N8, X6)

**Files:**
- Modify: `src/lib/usage/ledger.ts` (~38–83), `src/lib/llm/model-runner.ts` (~324–336, 478–496), `src/features/flows/execute-flow.ts` (ai-step ledger context ~1148–1152; side channels ~728, 1122, 1167–1185; `keepDetachedWorkAlive` ~1904)
- Test: ledger unit tests with a mocked prisma `$transaction`; model-runner test asserting the recorded `model` equals the resolved/served Qwen id; engine test asserting the ai step's ledger context carries `flowRunStepId` and `surface: 'flow_ai'`.

**Interfaces:**
- Produces: `LlmSurface` union gains `'flow_ai'` and `'eval_bench'` (Task 8 consumes `'eval_bench'`). `recordLlmCall` performs `llmCall.create` + rollup increments in one `prisma.$transaction`. `trackDetached(promise: Promise<unknown>): void` exported from the module owning `keepDetachedWorkAlive`, and every `void`-ed side channel (`recordLlmCall`, `recordTokenUsage`, shadow sampling, PII egress, run-tick broadcast) is registered through it.

- [ ] **Step 1:** Failing tests. **Step 2:** Verify fail. **Step 3:** Implement; headline path records the served model id (`qwenModel(target.model)`), keeping the requested alias in… nothing else needed — attribution must key on served. **Step 4:** Green + tsc. **Step 5:** Commit `fix(usage): ledger writes are transactional, per-step attributed, and survive serverless teardown`.

### Task 7: `FlowRun.degraded` persisted at finalize (T8)

**Files:**
- Modify: `prisma/schema.prisma` (`FlowRun` gains `degraded Boolean @default(false)`), new migration `prisma/migrations/<ts>_flow_run_degraded/migration.sql`, `src/features/flows/execute-flow.ts` (finalize transaction ~1763–1774 computes it from the full step set: any step failed-or-warned while run succeeded), `src/components/flows/run-panel.tsx` (~73–76), `src/lib/flows/execution-log.ts` (~45–49), `src/app/api/flows/runs/route.ts` (return the column)
- Test: DB-backed: run finishing `succeeded` with one warned step persists `degraded: true`; clean run persists `false`. UI helpers prefer the column and fall back to inference only when it's absent (pre-migration rows fetched via older payloads).

- [ ] **Step 1:** Failing test. **Step 2:** Verify fail. **Step 3:** Migration + finalize computation + both readers. **Step 4:** Green + tsc + CI-mode. **Step 5:** Commit `feat(flows): degraded is computed server-side at finalize, not inferred per-client`.

### Task 8: Bench evidence — spend, versioning, samples (N1, N2, N3 + audit B8/B9)

**Files:**
- Modify: `prisma/schema.prisma` (`ModelEvalResult` gains `harnessVersion String @default("pre-2026-08-20")` and `samples Json?`), new migration, `src/lib/eval/bench.ts` (~94–110, 141–220), `src/lib/eval/judge.ts` (~52–81), `src/lib/eval/harness.ts` (accept/forward ledger), `src/app/api/admin/models/route.ts` (~253–306: aggregate WHERE `harnessVersion = CURRENT_HARNESS_VERSION`), `src/app/admin/users/models-panel.tsx` (stale-harness badge on old detail rows; per-sample scores+reasonings in drill-down)
- Test: bench unit tests — ledger invoked for loop and judge calls with `surface: 'eval_bench'`; persisted row carries summed tokens + costUsd (error rows included); `samples` holds 3 `{score, reasoning}` entries and `score` equals their mean; API aggregate excludes rows with a different `harnessVersion`.

**Interfaces:**
- Consumes: `'eval_bench'` surface from Task 6.
- Produces: `CURRENT_HARNESS_VERSION = '2026-08-20'` exported from `src/lib/eval/harness.ts`; bump it whenever fixture dispatch or judging semantics change.

- [ ] **Step 1:** Failing tests. **Step 2:** Verify fail. **Step 3:** Implement (thread a ledger context through `runLoop`'s 4th arg — the seam exists at `model-runner.ts:323`; judge gets one too, as `shadow.ts:98` already does). **Step 4:** Green + tsc. **Step 5:** Commit `fix(eval): bench spend is ledgered, scores are harness-versioned, sample evidence backs the mean`.

### Task 9: Honest admin totals and coverage disclosure (N4, X10, X12, X13, X14)

**Files:**
- Modify: `src/app/api/admin/costs/route.ts` (add unbounded `llmCall.aggregate` for the true total + earliest-`createdAt`-in-window; keep top-50 lists), `src/app/admin/costs/page.tsx` (total from the aggregate; "top 50" labels; "data since {date}"), `src/app/api/admin/models/route.ts` (same total treatment; expose `timedCalls`), `src/app/admin/users/models-panel.tsx` ("runs touched" column label + mixed-run per-run-cost footnote + `succeeded+failed` vs `runs` note + `timedCalls` coverage + `benchRunning === null` renders "status unknown" and keeps polling), `src/app/admin/users/page.tsx` (~168–175, 216–221: tiles labeled with their scope, or aggregate unbounded server-side like People)
- Test: route tests (existing route smoke conventions): totals equal full-table aggregate even with >50 orgs seeded (seed 55 tiny orgs in the DB-backed test); response includes `dataSince`; panel logic unit test for the `benchRunning: null` branch.

- [ ] **Step 1:** Failing tests. **Step 2:** Verify fail. **Step 3:** Implement. **Step 4:** Green + tsc + CI-mode. **Step 5:** Commit `fix(admin): totals are unbounded aggregates; every sampled or scoped number says so`.

### Task 10: Credits and budget truth (N5, N6, N7, X16)

**Files:**
- Modify: `src/lib/usage/budget.ts` (~100–134: `dbUsed` from `llmCall` sums org-wide since month start — covers both planes; expose `monthlyTokenBudgetFor(org)`), `src/app/api/snapshot/route.ts` (~51–76: usage from `llmCall` aggregate + return the enforced budget), `src/components/layout/sidebar.tsx` (~75, 348, 783: denominator = enforced budget from snapshot; delete `CREDIT_TOKENS`), `src/lib/usage/ai-guard.ts` (~123), `src/app/api/agents/draft/route.ts` (~83), `src/app/api/agents/role-labels/route.ts` (~160) — use provider-reported usage when the response exposes it; otherwise call `recordTokenUsage(org, n, { estimated: true })`, which writes to a sibling Redis key `usage:<org>:<YYYY-MM>:est`; enforcement sums both keys.
- Test: budget unit tests — flow-plane-only `LlmCall` rows still count when Redis returns null; estimated and reported keys sum for enforcement; snapshot returns `{usedTokens, budgetTokens}`; sidebar math unit test (extract the % computation to a pure helper if it's inline).

- [ ] **Step 1:** Failing tests. **Step 2:** Verify fail. **Step 3:** Implement. **Step 4:** Green + tsc + CI-mode. **Step 5:** Commit `fix(usage): credits bar and budget enforcement share one evidence-backed number`.

### Task 11: Redaction provenance, waiting honesty, pinned-node evidence (X1, X2)

**Files:**
- Modify: `src/lib/flows/run-data-guard.ts` (~34–42: when redaction changes a value, append `"…redacted at rest"` to the row's `warnings`), `src/lib/flows/run-waiting.ts` (~30–62: missing/unparseable `waiting.kind` yields `kind: 'unknown'`, surfaced as "Waiting (details unavailable)" — never defaults to `'input'`), `src/features/flows/execute-flow.ts` (resume seeding ~566–575: seeding from a redacted output appends a run-level warning; pinData/stateOverrides seeding ~700–706 creates `FlowRunStep` rows `status:'skipped'` with a log entry `"value pinned — node not executed"` / `"state override — node not executed"`), waiting-kind consumers in run-panel for the `'unknown'` case
- Test: unit tests for the guard (warning appended only when redaction changed bytes), run-waiting `'unknown'` fallback, and a DB-backed engine test that a pinned node leaves a skipped step row.

- [ ] **Step 1:** Failing tests. **Step 2:** Verify fail. **Step 3:** Implement. **Step 4:** Green + tsc + CI-mode. **Step 5:** Commit `fix(flows): redaction and pinning leave provenance; unknown waits are not reported as questions`.

### Task 12: Demo workspaces out of admin rollups (X3)

**Files:**
- Modify: `src/app/api/admin/costs/route.ts`, `src/app/api/admin/models/route.ts`, `src/app/api/admin/users/route.ts` — every cross-org aggregate excludes demo-clone organizations. Find the demo marker first: check `src/lib/demo/snapshot.ts` (~467–489) and the Organization model for how demo orgs are flagged (kind/flag/naming); filter on that, not on a name pattern, unless the flag genuinely doesn't exist — if it doesn't, add `isDemo Boolean @default(false)` to Organization with a migration and set it in the snapshot clone path.
- Test: DB-backed — seed a demo org with `LlmCall` rows; admin totals exclude it.

- [ ] **Step 1:** Failing test. **Step 2:** Verify fail. **Step 3:** Implement. **Step 4:** Green + tsc + CI-mode. **Step 5:** Commit `fix(admin): demo-clone traces cannot inflate platform analytics`.

### Task 13: Shadow integrity + reaper/stall messaging (X5, X11)

**Files:**
- Modify: `src/lib/eval/shadow.ts` (~167–193: champion row persists its real tokens/cost/latency, not defaults), `src/app/api/admin/models/route.ts` (~263–331: fetch shadow rows by complete pairs — query distinct `pairId`s in window first, then fetch both rows per pair; no half-pairs dropped), `src/app/admin/users/models-panel.tsx` (label shadow scores "single judge sample" beside bench's "mean of 3"), `src/lib/flows/reap.ts` (~18: reaper failure message includes last completed step name + elapsed, e.g. `"interrupted after 47m; last completed step: enrich-contacts"`), `src/app/flows/[id]/page.tsx` (~1499–1596) + `src/lib/flows/run-stall.ts`: stall banner reads as advisory ("hasn't been picked up yet — still checking") and polling continues until the server reports a terminal status.
- Test: shadow unit test (champion row carries usage); pair-completeness unit test over a mocked row set split at the window edge; reap message test.

- [ ] **Step 1:** Failing tests. **Step 2:** Verify fail. **Step 3:** Implement. **Step 4:** Green + tsc. **Step 5:** Commit `fix(eval,flows): shadow pairs stay whole, champion spend recorded, stall/reap messages state what is known`.

### Task 14: Agent token honesty + roster single-source + sampled labels (X9, X15, N9)

**Files:**
- Modify: `prisma/schema.prisma` (`AgentExecution` gains `cacheReadTokens Int @default(0)`, `cacheWriteTokens Int @default(0)`), new migration, `src/features/agents/execute-agent.ts` (~1217–1218: `inputTokens` increments by fresh input only; cache buckets increment their own columns), usage readers (`src/app/api/usage/route.ts`, `src/app/api/snapshot/route.ts` if still reading these columns after Task 10 — reconcile), `src/lib/agents/roster.ts` (~44–81: counter-fallback rows carry `approximate: true`, are excluded from `successRate` denominators, and `sumStats` reports query-derived and approximate counts separately), `src/app/agents/roster-card.tsx` (~41–42: render approximate as `~N runs`, success rate only from measured rows), `src/lib/templates/usage-profile.ts` + `src/lib/templates/generate-proposals.ts` (~425, 491: when the 500-audit-row cap was hit, the figure reads "N runs from the most recent 500 events"; the generation gate keys on the same qualified truth)
- Test: execute-agent accounting unit test (cache reads no longer inflate `inputTokens`); roster unit tests (approximate exclusion; no mixed-provenance totals); usage-profile label test at exactly 500 rows.

- [ ] **Step 1:** Failing tests. **Step 2:** Verify fail. **Step 3:** Implement. **Step 4:** Green + tsc + CI-mode. **Step 5:** Commit `fix(agents,templates): token columns mean what they say; sampled figures say they are sampled`.

---

## Final gate (after Task 14)

- [ ] Full unit suite, `npx tsc --noEmit`, lint.
- [ ] CI-mode repro against local Postgres (`ci_repro`) — DB-backed tests + build.
- [ ] `git status` re-check (peer sessions), push to main.
- [ ] Report: list migrations added (deploy via `prisma migrate deploy` on next Vercel deploy) and flag **Fly worker redeploy required** (engine + ledger changes).
