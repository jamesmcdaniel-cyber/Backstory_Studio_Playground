# Adoption Analytics (`/admin/adoption`) — Design

Date: 2026-08-24
Status: approved for autonomous execution (continuous-execution workflow)
Origin: monday.com AI-first rebuild gap analysis, gap 3 of 4 (build order 3 → 1 → 5 → 6).

## Goal

The platform can measure whether agents create **sustained usage**, not just whether
they run. Today every operational question is answerable — runs, success rate, cost,
latency, queue depth — and no behavioural one is. There is no product analytics of any
kind in the repo: no vendor SDK in `package.json`, no `trackEvent` call anywhere in
`src`. `/api/agents/kpis` returns lifetime run counts per agent, which cannot
distinguish an agent used every day from one used forty times in its first week and
never again.

That distinction is the entire "AI dust" signal: adoption without sustained usage
patterns. This workstream builds the instrument that detects it, operator-side,
before the Slack-teammate work (gap 1) changes the behaviour being measured.

## Constraint that shapes the architecture

`/api/cron/retention` prunes `AgentExecution` by `startedAt` at `RETENTION_DAYS`
(default 90) and cascades its steps/events/messages. Three of the four metrics are
time series over executions, so live-querying caps history at 90 days *permanently*
and makes cohort survival past one quarter structurally unanswerable — not hard,
impossible.

Therefore: weekly aggregates are computed into durable tables ahead of the prune.

This is also what keeps the design privacy-clean. Rollups store **counts only —
never user ids, never payloads**. The retention window exists to bound inputs and
outputs; aggregates carry neither, so they may legitimately outlive it. Organization
deletion cascades both tables.

## Architecture (three layers)

### 1. Rollup tables

Two models, both `ENABLE`+`FORCE` RLS with a `tenant_isolation` policy, both added to
`ORG_SCOPED_MODELS`, copying the `20260818160000_agent_teammates` migration shape.

Both carry a real `organization Organization @relation(fields: [organizationId],
references: [id], onDelete: Cascade)` — not a bare column. Offboarding a workspace must
take its aggregates with it, since that is the one deletion these tables are *not*
designed to survive.

**`AdoptionWeek`** — one row per organization per ISO week.
Unique on `[organizationId, weekStart]`; index on `[weekStart]` for cross-org reads.

| column | meaning |
| --- | --- |
| `weekStart` (`@db.Date`) | ISO week Monday, UTC |
| `agentsCreated` | `AgentTask` rows with `createdAt` in the week |
| `agentsDeleted` | agents whose `status` became `DELETED` in the week |
| `execTotal` | all `AgentExecution` with `startedAt` in the week |
| `execManual` | subset with `trigger->>'type' = 'manual'` |
| `execByTrigger` (`Json`) | full mix, e.g. `{schedule: 40, signal: 9, manual: 61}` |
| `engagedUsers` | distinct engaged humans — a count, never the ids |
| `approvalsApproved` / `approvalsRejected` / `approvalsOther` | `ApprovalRequest` by terminal status, bucketed on `createdAt` |
| `approvalLatencyMedianMs` | `percentile_cont(0.5)` over `decidedAt - createdAt`, null when nothing was decided |
| `computedAt` | `@updatedAt`, so a stale row is visible as stale |

**`AgentCohortWeek`** — one row per agent per week in which it was active.
Unique on `[agentTaskId, activeWeek]`; indexes on `[organizationId, cohortWeek]` and
`[cohortWeek, activeWeek]`.

Columns: `organizationId`, `agentTaskId`, `cohortWeek` (`@db.Date`), `activeWeek`
(`@db.Date`).

`agentTaskId` carries **no foreign key** to `AgentTask`, deliberately. Agent deletion
is soft today (`src/app/api/agents/route.ts` sets `status: 'DELETED'`; the row
survives), so this is not currently load-bearing — but the table's purpose is history
that outlives its source row, and a future hard delete or org teardown with
`onDelete: Cascade` would silently erase exactly the record that proves an agent was
abandoned. Abandonment is the signal; it must not be cascade-deletable.

`cohortWeek` is denormalized onto every row so the survival query is one `groupBy`
that never joins back to `AgentTask`.

Growth is agents × weeks-active — bounded and small; no pruning needed.

### 2. The rollup job

`/api/cron/adoption-rollup`, authorized by `Authorization: Bearer <CRON_SECRET>` with
`timingSafeEqual`, copying `/api/cron/retention`'s `checkAuthorized` exactly, including
its `recordTokenRejection` call on failure.

Schedule: `30 3 * * *` in `vercel.json` — thirty minutes ahead of retention's
`0 4 * * *`. With a 90-day prune window and a two-week lookback the ordering has
enormous margin; the offset is free insurance, not a dependency.

Each run recomputes the **last two complete weeks** and upserts on the unique keys.
Recompute-and-upsert rather than incremental append: a missed day self-heals on the
next run instead of leaving a permanent hole, and the job is safe to re-run by hand.

`?weeks=N` recomputes N complete weeks back. This doubles as the one-time backfill
over the ~13 weeks of live data after deploy — no separate script.

Prisma `groupBy` cannot group by a JSON path or compute a percentile, so the trigger
mix, the engaged-user union, and the approval median use `$queryRaw`. Precedent exists
in the pgvector reads. Everything else stays on `groupBy`, matching
`/api/admin/costs`.

Load-bearing computation lives in `src/lib/adoption/rollup.ts` as pure functions over
already-fetched rows — week-boundary math, cohort assembly, ratio derivation — so it
unit-tests without a database, following the `src/lib/agents/roster.ts` precedent.

### 3. Read surface

`/api/admin/adoption` — `withAuthenticatedApi` with `internalOnly: true`, reading
cross-organization via `systemPrisma`, same shape as `/api/admin/costs`.

`/admin/adoption` page, behind the same edition check, nav entry gated alongside the
existing admin cluster.

Registered in `INTERNAL_ONLY_ROUTES` in `src/app/api/__tests__/edition-gates.test.ts`
**in the same commit** — its completeness test fails the build if the list drifts from
what is gated on disk, and the customer-edition fork is a one-line config mirror, so an
ungated operator surface leaks to customers.

The cron route is added to `UNGATED_ROUTES` (`src/lib/authz/ungated-routes.ts`)
alongside the other crons, since it authenticates by secret rather than session and
`permission-coverage.test.ts` requires every route be one or the other.

The page renders **complete weeks only**. The current partial week is excluded, not
shown, because a partial week always renders as a dip and a dip on an adoption chart
gets read as decay.

## Metric definitions (recorded rulings)

Ambiguity in these definitions is the whole risk of the workstream, so each is fixed
here rather than left to implementation.

1. **Cohort** is the ISO week (UTC) of `AgentTask.createdAt`.

2. **"Active in week X"** means ≥1 `AgentExecution` with `startedAt` in X, **any
   status**. A failing agent someone keeps running is still an agent in use; success
   rate is a separate question already answered by `/api/agents/kpis`.

3. **Survival at offset N** = distinct cohort agents active in week `W+N` ÷ cohort
   size. It is activity *in that week*, not "in that week or later" — a classic
   retention curve, so it may legitimately be non-monotonic.

4. **Agents created and never run stay in the denominator** and score 0 in every
   numerator. This is the "created it, never touched it again" case and it is the
   single most important thing the curve exists to catch. Excluding them would hide it.

5. **Automation ratio** = `trigger->>'type' != 'manual'` ÷ total, per org-week.
   `subflow` counts as automated: one agent delegating to another is precisely the
   woven-into-work behaviour being measured. Observed trigger types are `manual`,
   `schedule`, `webhook`, `signal`, `poll`, `subflow`; the mix is stored whole so a new
   type needs no migration.

6. **Engaged users** = distinct users who either ran an agent manually or sent an
   `AgentChatMessage`, that week, unioned. Explicitly *not* all execution `userId`s:
   a scheduled run attributes to the agent's owner, which would inflate one champion
   with fifty cron agents into a fifty-user team — the exact false signal this metric
   exists to detect.

7. **Acceptance** buckets `ApprovalRequest` on `createdAt` (not `decidedAt`, so a
   week's requests are counted in the week they were asked). `approvalsOther` absorbs
   `pending`, `approving`, `failed`, and `superseded`. Approvals are not pruned by
   retention and could be read live; they are rolled up anyway so the page has one
   read path.

## Reading the results (documented on the page)

An organization that has successfully automated its agents shows **low engaged-user
depth and high automation ratio at the same time**. That is the target state, not
decay. The page must state this next to the depth chart, or the two healthiest
signals in the product will be read as the two worst.

## Out of scope (this workstream)

- Any customer-facing adoption view. Operator-only was chosen deliberately; a
  workspace-admin surface is a separate product decision with its own tenancy and
  permission work.
- Third-party analytics vendors. Shipping behavioural events off-platform would open a
  new PII egress path and contradict the posture in `aiEgressPolicy`; every fact needed
  is already in Postgres.
- Cost, token, and latency metrics — already served by `/admin/costs`, `/admin/models`,
  and `/admin/queue`.
- `AgentMemory.timesUsed` reuse rate. Interesting, too narrow for v1.
- Flow-side adoption (`FlowRun`). The gap identified is about agents; flows can reuse
  the same tables later if the question arises.

## Acceptance

- Cohort survival, automation ratio, engaged-user depth, and acceptance rate all render
  from rollup tables, for complete weeks only, across every workspace.
- Running the rollup job twice over the same window produces identical rows
  (idempotent upsert), and a skipped day is fully repaired by the next run.
- `?weeks=N` backfills the available live history in one call.
- An agent created and never run appears in its cohort denominator at 0% survival.
- A soft-deleted agent keeps its cohort history and is counted in `agentsDeleted`.
- Rollup rows for one organization never include another's counts; no user ids are
  written to either table.
- `/admin/adoption` and `/api/admin/adoption` are not reachable in the customer
  edition, and `edition-gates.test.ts`'s completeness check passes with
  `admin/adoption` declared.
- The cron route is declared in `UNGATED_ROUTES` and `permission-coverage.test.ts`
  passes.
- Gates: tsc, lint, unit, CI-mode DB suite; migration via `prisma migrate deploy`;
  new RLS models covered by the RLS coverage test. No Fly worker redeploy needed —
  this adds no queue jobs and no worker-runtime change.
