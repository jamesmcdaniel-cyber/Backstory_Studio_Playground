# Flows Reliability Hardening — Design

Date: 2026-08-11
Status: approved, ready for planning

Four workstreams hardening the flow execution plane: background scheduling in
queue mode (WS1), idempotency (WS2), retry correctness (WS3), and recursive
learning from run history (WS4). They ship in that order — WS2's side-effect
ledger is what WS3's retry relaxation leans on, and WS1 is standalone.

---

## Audit: what is actually broken

Findings that motivated this design, with the evidence for each.

### Scheduling / queue mode

**A1. Flows have no BullMQ JobScheduler; agents do.**
`src/lib/workers/agent-schedule-registrar.ts` registers a repeatable job per
agent, reconciled every 60s on the worker. `src/app/api/cron/dispatch/route.ts`
(the flow-dispatch comment, ~line 310) states there is no equivalent for flows.
Every scheduled flow in production therefore depends on the single Vercel cron
entry `*/15 * * * *` in `vercel.json`.

**A2. The `every15min` cadence cannot be honored.**
`src/lib/scheduling/cadence.ts` offers `every15min` and `every30min`, stored as
`*/15 * * * *` and `*/30 * * * *`. Dispatched from a `*/15` tick, an
`every15min` flow fires with up to 15 minutes of drift and silently degrades to
a ~30 minute period whenever a tick is late. The product promises a cadence the
infrastructure cannot deliver.

**A3. A dead cron is invisible.**
`/api/health` reports `worker:heartbeat` freshness. Nothing records that the
dispatch tick itself ran. If the Vercel cron is paused, deleted, or plan-limited,
every scheduled flow stops and the first signal is a user noticing.

**A4. The tick can abort wholesale.**
The handler runs nine responsibilities in one request under `maxDuration = 800`.
Most are individually try/caught, but `OrgCapacity.forOrgs` and
`resolveRunOwners` (route.ts:209-210 for agents, 390-391 for flows) are not. A
throw there escapes to the outer catch and kills flow dispatch, wait resumes,
and the template sweep for that entire tick.

**A5. Agent occurrences are lost when the worker is down.**
`lastExecutedAt` advances at route.ts:225, *before* `dispatchAgentExecution`. If
that call throws because `assertQueueConsumerAlive` fails, the occurrence has
been consumed and is never retried. Flows get this right — their last-run marker
is the newest `FlowRun.startedAt`, which only moves when a run actually exists.
The asymmetry is the bug.

### Idempotency

**A6. Idempotency keys reach only HTTP steps.**
`withIdempotencyHeader` (src/lib/flows/idempotency.ts) has exactly one call site,
`src/features/flows/execute-flow.ts:1208`. Tool steps — Slack post, Gmail send,
Drive upload, every Nango and MCP write — carry no key. Nothing makes a replay
safe at the provider.

**A7. The key is scoped to `flowRunId`.**
`flowSideEffectKey(flowRunId, iterationKey, page)` protects replay *within* one
run. Two runs of the same scheduled occurrence produce different keys, so it
offers no protection against duplicate dispatch.

**A8. Duplicate-occurrence protection is a racy read-then-act check.**
`blocksSchedule` reads the newest run and decides. Two concurrent ticks (a
Vercel retry, an operator hitting the endpoint, or — after WS1 — worker and cron
overlapping) both observe "no active run" and both dispatch. There is no
`(flowId, scheduledFor)` uniqueness for the database to reject the second.

**A9. The poll trigger is knowingly at-least-once with no downstream dedupe.**
`src/features/flows/poll-dispatch.ts:68` dispatches before persisting the cursor
and comments that "a downstream dedupe is cheaper than silently losing an item."
No downstream dedupe exists. A crash between the two re-emits the item as a
fresh run with a new run id and therefore new idempotency keys.

### Retry

**A10. Fixed delay, no backoff, no jitter.**
`src/features/flows/action-reliability.ts:79` sleeps a constant
`retryDelayMs ?? 500`. Five retries is five hits in 2.5 seconds, and every
iteration of a per-item loop retries in lockstep against the same API.

**A11. Retryable and terminal errors are treated identically.**
A 401 retries exactly like a 503.

**A12. HTTP 429/5xx never reach the retry path at all.**
`src/features/flows/http.ts:315` returns `{ ok, status, statusText }` and does
not throw on non-2xx. `runWithRetries` only sees thrown errors, so the one class
of failure where retry is unambiguously correct is the class that never
triggers it — while permanent auth failures on the tool path do.

**A13. `Retry-After` is parsed nowhere.**

**A14. Queue-level retry is off for flows.**
`src/lib/flows/queue-options.ts` returns `attempts: 1` for fresh and prepared
runs; only resume jobs get the default 2. A worker OOM mid-run is handled by the
reaper marking it failed, never by a retry. This is defensible given uncontrolled
side effects — and A6 is precisely why it cannot be relaxed today.

### Recursive learning

**A15. Flows never reflect.**
`reflectAndRemember` (src/features/agents/reflection.ts) has one caller:
`src/features/agents/execute-agent.ts:1574`. A flow run that failed, came back
degraded, or produced empty results writes nothing back. `StepOutcome.warnings`
— built by the run-truthfulness work and persisted on `FlowRunStep.warnings` —
is a ready-made learning signal with no consumer.

**A16. The loop tracks recurrence and retrieval, not outcome.**
`AgentMemory.timesUsed` is incremented on save-dedupe and on retrieval
(src/lib/memory/agent-memory.ts:86, 276). Nothing records whether a learning
*helped*. `metadata.lastCritique` is a single-slot overwrite with no history,
decay, or confidence.

**A17. No failure-pattern learning.**
Repeated failures of the same step produce N identical failed runs and no
proposal, no checker rule, no auto-disable — although both the checker-rule
machinery and the `TemplateProposal` surface already exist and could be fed from
run history.

---

## WS1 — One dispatch tick, two callers

**Addresses A1–A5.**

### Design

Extract the entire body of `GET /api/cron/dispatch` into
`src/lib/scheduling/dispatch-tick.ts` as `runDispatchTick(now: Date)`, returning
the same summary object the route returns today. The route keeps only its
`checkAuthorized` guard and response shaping. The worker calls the same function
on a 60s timer, alongside the existing heartbeat / schedule / outbox timers in
`src/lib/workers/runtime.ts:115-125`.

Rejected alternative: a BullMQ JobScheduler per flow, mirroring the agent
registrar. It would be minute-accurate but would duplicate the anchor, overlap
guard, trigger-condition, poll-cursor, and org-capacity logic into a second
source of truth, and add a second split-brain of the kind the agent path already
has. One due-check implementation called from two places is strictly less to
reason about.

### Mutual exclusion

`src/lib/queue/tick-lock.ts` provides `withTickLock(fn)`:

- Acquire: `SET dispatch:tick:lock <token> NX PX 120000`.
- Release: delete only when the stored value equals our token (Lua CAS), so a
  slow tick that outlived its TTL never deletes a successor's lock.
- Not acquired: return `{ skipped: 'locked' }` without running.

The 120s TTL exceeds the 60s worker interval, so a tick that overruns blocks the
next one rather than overlapping it. In inline mode (dev/CI) there is no Redis;
`withTickLock` is a pass-through no-op and current behavior is unchanged.

### Tick liveness

Every completed tick writes `dispatch:tick:last` to Redis (ISO timestamp plus
the summary counts), best-effort, on the same failure policy as
`writeWorkerHeartbeat` — logged, never fatal. `/api/health` reports its age
alongside `worker:heartbeat`; an age greater than three times the expected
interval reads unhealthy. This is the missing signal for A3.

### Correctness fixes carried by this workstream

- **A4** — wrap `OrgCapacity.forOrgs` and `resolveRunOwners` (both agent and
  flow call sites) in try/catch. A failure degrades that one phase and logs;
  the tick continues.
- **A5** — `lastExecutedAt` still advances *before* the run, so a persistently
  failing agent does not re-fire every tick. But a *dispatch-layer* throw now
  restores the previous `lastExecutedAt` and deletes the never-started
  `agentExecution` row. Handoff failure and run failure stop being the same
  thing. The restore is safe precisely because the run never began.

### Explicitly out of scope

No new cadences. `src/lib/scheduling/cadence.ts` keeps its current list; the
change is that `every15min` and `every30min` become accurate rather than
aspirational. Adding finer cadences would also collide with the standing
constraint that the UI never exposes raw cron.

### Tests

- `withTickLock` — second concurrent caller is refused; a token that no longer
  matches does not delete the lock; inline mode passes through.
- `runDispatchTick` is callable twice concurrently and the second is a no-op.
- Agent dispatch failure restores `lastExecutedAt` and leaves no orphan
  execution row (DB test).
- A throwing `resolveRunOwners` in the agent phase still lets the flow phase
  dispatch (DB test).
- `/api/health` reports tick age and flags a stale tick.

---

## WS2 — Side-effect ledger and occurrence uniqueness

**Addresses A6–A9, and partially A14.**

### The ledger

New Prisma model:

```prisma
model FlowSideEffect {
  id             String   @id @default(cuid())
  /// The idempotency SCOPE. Normally the flow run id; for poll-triggered runs
  /// it is `${flowId}:${dedupeValue}` so two runs for the same polled item
  /// share ledger keys (see "Poll dedupe" below).
  scopeKey       String
  iterationKey   String   // node id, or `${nodeId}#${index}` inside a loop
  page           Int      @default(0)
  organizationId String   @db.Uuid
  provider       String
  tool           String
  result         Json
  createdAt      DateTime @default(now())

  /// Nullable and SetNull on delete: a poll-scoped ledger row must outlive the
  /// run that wrote it, or deleting that run would silently drop the dedupe
  /// protection. Run retention sweeps these on the ledger's own createdAt.
  flowRunId String?
  run       FlowRun? @relation(fields: [flowRunId], references: [id], onDelete: SetNull)

  @@unique([scopeKey, iterationKey, page])
  @@index([organizationId, createdAt])
  @@map("flow_side_effects")
}
```

`flowSideEffectKey` changes its first parameter from `flowRunId` to the same
`scopeKey`, so the ledger row and the outgoing `idempotency-key` header always
describe the same logical side effect. For every non-poll run `scopeKey` *is*
the run id, so existing behavior and existing keys are unchanged.

The tool-step path (`src/features/flows/execute-flow.ts:923-957`) gains a
read-before-write and a write-after-success:

1. Before `executor.execute`, look up the ledger row. A hit returns the recorded
   result and emits a `warnings` entry (`"replayed — not re-executed"`), so the
   run panel shows the truth rather than pretending the call happened again.
2. After success, insert `ON CONFLICT DO NOTHING`. The conflict case means a
   concurrent attempt won; the result we already have is returned.

HTTP steps use the same ledger with the same key. The header alone is not
enough — most providers ignore an unrecognized `idempotency-key` — so the ledger
is what provides universal coverage and the header is reinforcement.

Idempotency *headers* for tool calls stay opt-in per provider: a new optional
field on `NangoToolSpec` declares that a provider honors a key and names the
header or argument. We never send an unknown header to an API that might reject
the request because of it.

### Occurrence uniqueness

- `FlowRun.scheduledFor DateTime?` with `@@unique([flowId, scheduledFor])`.
  Null for interactive, signal, webhook, and poll-triggered runs, so the
  constraint only binds scheduled dispatch.
- `AgentExecution.scheduledFor DateTime?` with
  `@@unique([agentTaskId, scheduledFor])`. Same pattern, same exposure — agents
  race exactly as flows do.
- New pure function in `src/lib/scheduling/due.ts`:
  `dueOccurrence(schedule, lastExecutedAt, now): Date | null` — returns *which*
  occurrence is owed, where `isDue` returns only whether one is. Semantics per
  type:
  - `cron` — the latest matching minute in `(since, now]`.
  - `daily` / `weekly` — today's scheduled instant in the schedule's timezone.
  - `once` — the target instant.
  - `hourly` — the hour-floor of `now`. Hourly has no grid (`isDue` is
    "60 real minutes since the last run"), so there is no true occurrence
    instant. The hour-floor is stable across ticks minutes apart, which is
    what the constraint needs; it is documented as an approximation.
  - `manual` / inactive — null.

  `dueOccurrence` returning non-null must agree with `isDue` returning true for
  the same inputs; a property test pins that.

Dispatch stamps `scheduledFor` on insert. A `P2002` means another tick already
claimed the occurrence, and we skip it without logging an error. `blocksSchedule`
remains as a cheap pre-filter that avoids consuming a dispatch slot, but the
database becomes the authority.

### Poll dedupe (A9)

Unchanged in mechanism — dispatch-then-persist stays, because losing an item is
worse than repeating one. What changes is that the repeat is absorbed
downstream. A re-emitted poll item produces a fresh run whose writes are
protected by nothing today; instead, `runFlowPoll` stamps the item's dedupe key
onto the run as `trigger.dedupeValue`, and the run's `scopeKey` becomes
`${flowId}:${dedupeValue}` rather than the run id. Two runs for the same polled
item then share ledger keys, so the second replays recorded results instead of
re-firing the writes.

`scheduledFor` stays null for poll runs — their cadence is tracked by
`pollCursor.lastPolledAt`, not by an occurrence grid, so the unique constraint
does not apply to them. The ledger is their protection.

### Relaxing queue attempts (A14) — bounded, and cuttable

Only *prepared* jobs can safely go to `attempts: 2`: their run id — and
therefore their ledger keys — is stable across attempts. Fresh jobs create a new
run row per attempt, so a retry gets fresh keys and the ledger buys nothing;
they stay at `attempts: 1`.

Even for prepared jobs there is a prerequisite: `runFlowExecution`'s atomic claim
currently refuses a prepared run that has already left `running`, which would
reject the legitimate BullMQ retry. The claim must first learn to distinguish a
retry of the same job from a second concurrent dispatch.

This is the last task in WS2 and the one item to cut if it does not verify
cleanly. Everything above it stands on its own.

### Tests

- Ledger hit returns the recorded result and does not call the executor; a
  `warnings` entry is emitted (unit, fake executor).
- Concurrent inserts on the same key — one wins, both return the same result.
- `dueOccurrence` agrees with `isDue` across all types, including DST
  boundaries and half-hour zones (property test reusing the existing due tests).
- Duplicate scheduled dispatch of one occurrence creates one run (DB test).
- Same for `AgentExecution` (DB test).
- Two poll runs for the same `dedupeValue` share ledger keys; the second
  replays (DB test).

---

## WS3 — Retry that distinguishes what it is retrying

**Addresses A10–A13.**

### Classification

New `classifyRetry(error, response?): 'retryable' | 'terminal' | 'timeout'` in
`src/features/flows/action-reliability.ts`:

- **retryable** — network/connection errors, HTTP 408, 429, and 5xx, and the
  rate-limit error shapes Nango and MCP surface.
- **terminal** — 4xx authentication and validation failures (400, 401, 403,
  404, 422). `runWithRetries` breaks immediately rather than burning the budget.
- **timeout** — `FlowTimeoutError`, governed by the existing
  `shouldRetryAfterTimeout(kind)` policy, which is unchanged.

Anything unrecognized classifies as retryable, preserving today's default.

### Backoff

`delay = min(base * 2 ** attempt, 30_000)`, multiplied by a jitter factor in
`[0.5, 1.0]`. `retryDelayMs` becomes the base and still defaults to 500, so a
single retry behaves as it does today. A total-elapsed cap ensures a retry chain
cannot outrun the step's `timeoutMs` or the BullMQ job lock.

A `Retry-After` response header — delta-seconds or HTTP-date — overrides the
computed delay, clamped to the same 30s cap.

Jitter also un-synchronizes per-item loops, which currently retry in lockstep.

### HTTP compatibility — the constraint that shapes this workstream

Today a non-2xx HTTP response is returned as `{ ok: false, status }` and flows
branch on it. That contract must not change.

New behavior:

- `retries === 0` — **identical to today**, in every case. Pinned by test.
- `retries > 0` and the status is retryable — retry internally with the backoff
  above. If the budget exhausts, return the response object exactly as today.
- `retries > 0` and the status is not retryable — return immediately, as today.

So the retry becomes reachable for the case it was always meant for, and no
existing flow that inspects `status` changes behavior.

### Tests

- `classifyRetry` table test across error and status shapes.
- Backoff is monotonic, capped at 30s, and jittered within `[0.5, 1.0]`.
- `Retry-After` in seconds and as an HTTP-date both override, both clamped.
- Terminal errors consume exactly one attempt.
- The total-elapsed cap stops a chain before the step timeout.
- **Pinning test**: `retries = 0` HTTP behavior is byte-identical for 200, 404,
  429, and 503.
- A retryable 503 with `retries = 2` retries twice, then returns the response
  object rather than throwing.

---

## WS4 — Pattern-triggered flow reflection

**Addresses A15–A17.**

### Detection — pure, no I/O

`src/lib/flows/failure-patterns.ts` exports
`detectFailurePatterns(runs): FailurePattern[]`, operating over a flow's last 10
runs and their steps.

- Group by `(stepId, errorClass)` and `(stepId, warningCode)`.
- `errorClass` comes from a normalizer that strips ids, URLs, timestamps, and
  bare numbers, so `"404 on /users/abc123"` and `"404 on /users/def456"` collapse
  to one class.
- A pattern fires at **≥3 occurrences spanning ≥2 distinct runs** — the second
  condition prevents one loop-heavy run from manufacturing a pattern by itself.

This function is where the `FlowRunStep.warnings` column finally gets a consumer.

### Sweep

A daily, per-flow-debounced sweep in the dispatch tick, mirroring
`sweepTemplateGeneration`'s shape and isolation (its own try/catch; a failure
never aborts the tick). For each flow with at least one pattern it makes **one**
structured call on the summary model.

Cost is O(flows with a pattern), not O(runs): a flow failing every 15 minutes
produces one proposal per day, not 96.

### Output — no new table

A `TemplateProposal` row with the existing `kind: 'process_improvement'`:

- `title` / `rationale` — the model's description of the pattern and the fix.
- `sourceEvidence` — the detected pattern: step id, error class, occurrence
  count, run ids, first and last seen.
- `configuration` — `{ targetType: 'flow', targetId: <flowId>, … }`. That
  `targetType`/`targetId` pair is exactly what `proposalImprovementTarget`
  (src/lib/templates/accept-proposal.ts:52) reads, so accepting opens the flow
  editor on the offending flow. Any extra keys are ignored by the accept path
  and are free to carry the suggested change for the editor to render.

The proposal surface already has accept/dismiss wired end to end
(`src/app/api/template-proposals/[id]/accept` and `/dismiss`), and
`process_improvement` is the one kind that creates no template — it returns the
editor target. So this needs a producer and nothing else.

That accept/dismiss decision is also the outcome signal A16 identified as
missing: unlike `timesUsed`, which counts recurrence and retrieval, an accepted
or dismissed proposal records whether the learning was worth anything.

### Tests

- `detectFailurePatterns` — fires at the threshold, not below it; requires 2
  distinct runs; the normalizer collapses id-bearing variants and does not
  collapse genuinely different errors.
- The sweep is debounced per flow (a second same-day call is a no-op) and makes
  exactly one model call per flow with a pattern (DB test, faked generator).
- A flow with no pattern produces no proposal and no model call.
- A thrown sweep does not abort the tick.

---

## Sequencing

1. **WS1** — standalone; delivers honest cadences and cron-death visibility.
2. **WS2** — the ledger; the prerequisite for any retry relaxation.
3. **WS3** — retry correctness; leans on WS2 for the parts that touch writes.
4. **WS4** — depends only on data that already exists.

## Migrations

Four, all additive:

1. `FlowSideEffect` table (WS2).
2. `FlowRun.scheduledFor` + `@@unique([flowId, scheduledFor])` (WS2).
3. `AgentExecution.scheduledFor` + `@@unique([agentTaskId, scheduledFor])` (WS2).

WS1, WS3, and WS4 need no schema change.

Migration 1 creates a new table, so nothing can violate its constraint.
Migrations 2 and 3 add unique indexes over a nullable column, which in Postgres
binds only rows that carry a value — every existing row has `scheduledFor` null
and is therefore exempt. No backfill, and no deploy-time violation is possible.

`flow_side_effects` rows must be swept by the existing retention job
(`/api/cron/retention`) on their own `createdAt`, not by run cascade — the
poll-scoped rows deliberately outlive their run. Retention beyond the poll
cadence is wasted storage; retention shorter than it reopens the duplicate
window, so the sweep horizon is documented against the longest poll cadence the
picker offers.

## Gates

Per repo convention: `tsc` clean, eslint clean on touched files, the full local
suite green, and the CI-mode suite green on a fresh `ci_repro` Postgres with
`prisma migrate deploy` applying cleanly. The worker must be `fly deploy`ed
after WS1 and WS2, since both change worker-resident runtime behavior.

Note the tsx file-size cliff: new tests go in new files rather than growing
`validate.test.ts` or any file approaching ~45KB.
