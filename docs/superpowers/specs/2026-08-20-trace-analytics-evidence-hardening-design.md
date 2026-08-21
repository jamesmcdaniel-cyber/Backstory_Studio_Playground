# Trace & Analytics Evidence Hardening — Design

Date: 2026-08-20
Status: approved for autonomous execution (continuous-execution workflow)

## Goal

Every number and status the platform reports — step timings, run durations, statuses,
token counts, costs, bench scores, credit usage — must be **measured where it happened,
persisted server-side, and traceable to source rows**. Where a value is estimated,
truncated, or sampled, the surface must say so.

Two audits (2026-08-20, full findings in the session transcript) mapped both planes
end-to-end and produced the evidence-backed risk list this spec addresses.

## Out of scope (the only deferrals)

- **Invoice reconciliation.** `pricing.ts` stays a deliberate estimate (Sonnet-5
  over-priced by design, derived cache rates). We surface `priceVersion` and label
  spend as estimated; we do not reconcile against provider invoices.
- **Retention policy change.** The 90-day prune stays; we add coverage disclosure,
  not new retention.

Everything else identified by the 2026-08-20 audits is in scope ("close all
identified gaps" directive).

## Workstream T — Trace plane (engine truth)

**T1. Real interpreter step timings.** `StepOutcome` (interpret.ts) gains
`startedAt`/`finishedAt` measured around node execution; the `onStep` persistence in
execute-flow.ts writes those instead of fabricating `new Date()` twice at write time.
Loops/conditions/transforms stop reporting ~0ms.

**T2. Run duration excludes queue wait.** When the queue worker adopts a prepared
`FlowRun` row, refresh `startedAt` (same as the resume path already does). Duration
becomes execution time on every path.

**T3. Retry evidence.** `runWithRetries` / `runAgentWithReliability` report attempt
count and per-attempt errors; the engine appends them to the step's `warnings`/`logs`
(e.g. `attempt 2/5 failed: …`). A 6-attempt step no longer looks like one clean call.

**T4. Truncation markers.** Every silent `.slice()` on persisted evidence appends an
explicit marker with the dropped size: step errors (300 chars), code-step logs
(200×2000), HTTP `bodyText` (50k), tool output (50k), knowledge extraction (200k).
Shared helper `truncateWithMarker(text, max)`.

**T5. No orphaned/stuck statuses.**
- Dead-letter terminalization and `failPreparedRun` also sweep that run's `running`
  steps to `failed` (mirroring the existing end-of-run sweep).
- Cancelling a `waiting` run terminalizes immediately (`cancelled` + step sweep) —
  a waiting run has no executor to finish the job, so `cancelling` was a dead end.
- `cancelled` gets a `STATUS_TEXT` mapping in node-presentation.
- `onExecutionCreated`'s unguarded step update gains the same `status:'running'` guard
  every other write has.

**T6. Per-step LLM attribution.** The flow `ai` step passes `flowRunStepId` into the
ledger context (the column exists; no caller sets it), and uses a new surface
`flow_ai` instead of mislabeling as `agent_turn`. `LlmSurface` union extended.

**T7. Ledger writes that can't half-land.** `recordLlmCall`'s create + rollup
increments become one transaction; the fire-and-forget promise is registered with
`keepDetachedWorkAlive` so serverless teardown can't drop it. Failure is still
swallowed (latency guarantee) but now logged with the run id.

**T8. Degraded persisted server-side.** `FlowRun.degraded Boolean @default(false)`
computed once at finalize from the full step set; run-panel and execution-log read it
(client inference kept only as fallback for pre-migration rows). Also: run-panel
actually renders per-step timing (it promises "timing" today and shows none).

## Workstream N — Analytics plane (reported numbers)

**N1. Bench spend is real spend.** Bench `runLoop` and the judge get a ledger context
(surface `eval_bench`); `ModelEvalResult` rows persist tokens + `costUsd` — including
error rows (tokens burned before a failure count).

**N2. Score provenance versioning.** `ModelEvalResult.harnessVersion String` stamped
at write; `/api/admin/models` aggregates only the current harness version so pre-fix
rows (the inverted-score era) can't blend into averages. Old rows stay visible in
detail with a stale-harness badge.

**N3. Evidence matches the mean.** Bench stores all judge samples
(`samples Json` — per-sample score + reasoning) instead of the last sample's sentence
posing as evidence for a 3-sample mean.

**N4. Honest totals on /admin/costs and Models.** "Across all workspaces" totals come
from unbounded aggregates; the `take: 50` lists are labeled "top 50". Same for the
Models spend tile.

**N5. Credits bar tells the enforced truth.** Sidebar % uses the org's enforced
monthly budget as denominator (from `budget.ts` tier logic, exposed via
`/api/snapshot`) and a numerator that includes the flow plane.

**N6. Budget fallback covers both planes.** `checkMonthlyTokenBudget`'s DB fallback
sums `LlmCall` tokens (both planes) instead of `agentExecution` only, so a Redis
reset/outage no longer under-counts the entire flow plane.

**N7. No estimates in the enforcement counter without saying so.** The three
`chars/4` call sites (ai-guard, agents/draft, role-labels) switch to provider-reported
usage where the response exposes it; any residual estimate is recorded via an
`estimated: true` variant that budget math still counts but surfaces can distinguish.

**N8. Ledger records the served model.** Headline Qwen calls record the resolved model
id actually sent to the provider, not the requested alias.

**N9. Sampled figures say they're sampled.** Template usage-profile's
"Runs analyzed: N over the last 90 days" is qualified when the 500-audit-row cap was
hit ("N runs from the most recent 500 events").

## Workstream X — Remaining audit findings (close-all sweep)

**X1. Redaction provenance + resume safety.** When `run-data-guard` redacts a step's
`input`/`output`/`logs`/`warnings` at write time, it appends a persisted warning
(`"output redacted at rest"`) to the row. Resume seeding that replays a redacted
output surfaces a run-level warning instead of silently replaying mutated data.
`run-waiting`'s `kind` fallback stops defaulting a missing marker to `'input'` —
unknown is reported as unknown.

**X2. Pinned/overridden nodes leave evidence.** Nodes satisfied by `pinData` or
`stateOverrides` get a `FlowRunStep` row (`status:'skipped'`, log entry naming the
provenance) so downstream inputs are traceable to a fabricated value.

**X3. Demo workspaces excluded from admin rollups.** Cross-org admin aggregates
(/admin/costs, /admin/models, /admin/users) exclude demo-clone organizations so
fabricated demo traces can't inflate platform numbers.

**X4. Interpreter `onStep` writes are atomic.** The read-then-act updateMany/count/
create sequences become transactional upserts; late `onExecutionCreated` write gains
a status guard (also in T5).

**X5. Reaper messages preserve context.** `reapStuckFlowRuns` notes the last
completed step and elapsed time instead of only a generic interruption line; client
stall banner is rephrased as advisory and polling continues until the server is
terminal.

**X6. Side-channel writes tracked.** `recordTokenUsage`, shadow sampling, PII egress
recording, run-tick broadcasts registered with `keepDetachedWorkAlive` (with T7).

**X7. Tool-error heuristic hardened.** `tool-output`'s all-keys-errorish detection
also matches error-shaped payloads carrying benign extra keys (id/trace fields), and
records which heuristic fired in step warnings.

**X8. Code-step persisted input labels its elision.** The prose marker replacing
`context.steps` states explicitly that the executed input differed (with T4 markers).

**X9. Agent token columns stop conflating cache reads.** `AgentExecution` gains
`cacheReadTokens`/`cacheWriteTokens`; `inputTokens` becomes fresh input only; usage
surfaces derive breakdowns from real columns (back-compat: old rows read as-is).

**X10. Models panel arithmetic honesty.** Cross-model run double-counting disclosed
in the column ("runs touched"); `succeeded+failed ≠ runs` gets an in-UI note;
per-run cost divides by the correct population; `timedCalls` coverage rendered.

**X11. Shadow eval integrity.** Champion rows persist real tokens/cost/latency;
pairs fetched by complete `pairId` (no half-pairs dropped from the 4000-row window);
single-sample nature labeled next to bench's 3-sample means.

**X12. Bench polling honesty.** `benchRunning === null` (Redis unreachable) renders
as "status unknown" and still polls, instead of reading as "not running".

**X13. Coverage disclosure for pruned windows.** /admin/costs and Models report the
earliest `LlmCall` timestamp in the window ("data since {date}") so the 90-day
prune edge is visible; denormalized totals labeled as surviving detail pruning.

**X14. Admin tile scope labels.** Tokens/Cost tiles on /admin/users state their
scope (visible page + filters) or aggregate unbounded like People does.

**X15. Per-agent stats single-source.** Roster stops mixing `executionCount`
fallback with KPI query results in one total; counter-derived rows are labeled
approximate and excluded from success-rate denominators explicitly.

**X16. Estimated-vs-reported Redis counter separation** (extends N7): the live
counter tracks provider-reported and estimated contributions under distinct keys;
enforcement sums both, surfaces can show the split.

## Acceptance

- Interpreter-persisted steps show real, non-zero durations for slow nodes.
- No path can leave a `running` step inside a terminal run, or a `cancelling` run
  with no executor.
- Every truncated persisted artifact carries a marker.
- Bench sweeps appear in /admin/costs; bench averages exclude pre-harness-fix rows.
- Sidebar % × enforced budget ≈ tokens actually gating runs, both planes.
- Gates: `tsc`, lint, unit tests, CI-mode repro (DB-backed) before push. Migration via
  `prisma migrate deploy` path. Fly worker redeploy required after engine changes.
