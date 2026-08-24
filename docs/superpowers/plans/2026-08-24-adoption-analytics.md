# Adoption Analytics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give operators a cross-workspace view of whether agents create sustained usage — cohort survival, automation ratio, engaged-user depth, and acceptance rate — computed into durable weekly rollups that outlive the 90-day execution prune.

**Architecture:** Two RLS-scoped rollup tables (`AdoptionWeek`, `AgentCohortWeek`) are filled by a daily `CRON_SECRET`-gated job that recomputes the last two complete weeks and upserts idempotently. All load-bearing math lives in pure functions in `src/lib/adoption/rollup.ts` so it unit-tests without a database. An `internalOnly` read route assembles the survival matrix and a client page renders it.

**Tech Stack:** Next.js App Router, Prisma + PostgreSQL (raw SQL for JSON-path grouping and percentiles), `node:test` + `node:assert/strict`, Tailwind.

**Spec:** `docs/superpowers/specs/2026-08-24-adoption-analytics-design.md`

## Global Constraints

- Rollups store **counts only — never user ids, never payloads**. This is what lets them outlive `RETENTION_DAYS`.
- Both new models get `ENABLE`+`FORCE` RLS with a `tenant_isolation` policy and must be added to `ORG_SCOPED_MODELS` in `src/lib/tenant-guard.ts`, or `src/lib/__tests__/rls-coverage.db.test.ts` fails.
- Every metric query **excludes organizations with `kind = 'demo'`** — disposable anonymised clones whose history is canned, not real. Copy the exclusion pattern from `src/app/api/admin/costs/route.ts`.
- Weeks are **ISO weeks starting Monday, UTC**. `AgentTask.createdAt`, `AgentExecution.startedAt`, `AgentChatMessage.createdAt` and `ApprovalRequest.createdAt` are Prisma-default naive `timestamp(3)` columns holding UTC, so bare `date_trunc('week', col)` is already UTC-correct — do **not** add `AT TIME ZONE`, which would double-convert.
- The page renders **complete weeks only**. Never render the current partial week.
- A ratio over a zero denominator is `null`, never `0`. A week with no runs has no automation ratio; rendering `0` reads as "fully manual", which is the opposite conclusion.
- DB tests run concurrently against a shared `bs_ci_repro` database. **Every assertion must be delta-scoped** — capture a baseline, seed, assert the delta. Never assert an absolute global count.
- New routes must be registered: read route in `INTERNAL_ONLY_ROUTES` (`src/app/api/__tests__/edition-gates.test.ts`), cron route in `UNGATED_ROUTES` (`src/lib/authz/ungated-routes.ts`). Both lists have completeness tests that fail the build on drift.
- Run a single test file with: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test <path>`

---

### Task 1: Rollup tables, `deletedAt`, and migration

The spec calls for an `agentsDeleted` weekly count. `AgentTask` has no deletion timestamp — deletion is soft (`src/app/api/agents/route.ts:315` sets `status: 'DELETED'`) and `updatedAt` moves on any edit, so the metric is not computable today. This task adds the column and sets it at the one delete site.

**Files:**
- Modify: `prisma/schema.prisma` (add 2 models, add `deletedAt` to `AgentTask`)
- Create: `prisma/migrations/20260824120000_adoption_rollups/migration.sql`
- Modify: `src/lib/tenant-guard.ts:48-70` (add both models to `ORG_SCOPED_MODELS`)
- Modify: `src/app/api/agents/route.ts:315` (stamp `deletedAt`)
- Test: `src/lib/__tests__/rls-coverage.db.test.ts` (existing — must still pass)

**Interfaces:**
- Consumes: nothing (first task)
- Produces: Prisma models `AdoptionWeek` and `AgentCohortWeek`; `AgentTask.deletedAt: DateTime | null`

- [ ] **Step 1: Add the two models and the `deletedAt` column to `prisma/schema.prisma`**

Add `deletedAt` to the existing `AgentTask` model, directly after `quarantinedAt`:

```prisma
  /// Set when the agent is soft-deleted (status -> 'DELETED'). Null for a live
  /// agent AND for anything deleted before this column existed — `updatedAt`
  /// moves on every edit, so historical deletion dates are unrecoverable and
  /// are deliberately left null rather than guessed.
  deletedAt      DateTime? @db.Timestamptz(6)
```

Append both new models at the end of the file:

```prisma
/// Weekly adoption aggregate, one row per organization per ISO week.
///
/// Exists because /api/cron/retention prunes AgentExecution at RETENTION_DAYS
/// (default 90), which makes any longer-horizon behavioural question
/// unanswerable by live query. Stores COUNTS ONLY — no user ids, no payloads —
/// which is precisely why it may outlive the retention window that exists to
/// bound inputs and outputs.
model AdoptionWeek {
  id                      String   @id @default(cuid())
  organizationId          String   @db.Uuid
  /// ISO week Monday, UTC.
  weekStart               DateTime @db.Date
  agentsCreated           Int      @default(0)
  agentsDeleted           Int      @default(0)
  execTotal               Int      @default(0)
  execManual              Int      @default(0)
  /// Full trigger mix, e.g. {"manual":61,"schedule":40,"signal":9}. Stored
  /// whole so a new trigger type needs no migration.
  execByTrigger           Json     @default("{}")
  /// Distinct humans who ran an agent manually or sent an agent chat message.
  /// A COUNT — the ids are deliberately not retained.
  engagedUsers            Int      @default(0)
  approvalsApproved       Int      @default(0)
  approvalsRejected       Int      @default(0)
  /// pending + approving + failed + superseded.
  approvalsOther          Int      @default(0)
  /// Median decidedAt - createdAt over DECIDED requests only; null when none
  /// were decided.
  approvalLatencyMedianMs Int?
  computedAt              DateTime @updatedAt

  organization Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)

  @@unique([organizationId, weekStart])
  @@index([weekStart])
  @@map("adoption_weeks")
}

/// One row per agent per week in which it executed. Feeds the cohort survival
/// curve.
///
/// `agentTaskId` carries NO foreign key to AgentTask, deliberately. This
/// table's whole purpose is history that outlives its source row, and an
/// ON DELETE CASCADE would erase exactly the record proving an agent was
/// abandoned — abandonment being the signal. `cohortWeek` is denormalized onto
/// every row so the survival query never joins back to AgentTask.
model AgentCohortWeek {
  id             String   @id @default(cuid())
  organizationId String   @db.Uuid
  agentTaskId    String
  /// ISO week of AgentTask.createdAt.
  cohortWeek     DateTime @db.Date
  /// ISO week in which this agent executed at least once.
  activeWeek     DateTime @db.Date

  organization Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)

  @@unique([agentTaskId, activeWeek])
  @@index([organizationId, cohortWeek])
  @@index([cohortWeek, activeWeek])
  @@map("agent_cohort_weeks")
}
```

Add the back-relations to the `Organization` model (find it near the top of the file and add these two lines alongside its other relation fields):

```prisma
  adoptionWeeks    AdoptionWeek[]
  agentCohortWeeks AgentCohortWeek[]
```

- [ ] **Step 2: Write the migration**

Create `prisma/migrations/20260824120000_adoption_rollups/migration.sql`. The RLS block copies `20260818160000_agent_teammates` exactly.

```sql
-- Adoption rollups: durable weekly aggregates that outlive the execution prune.
--
-- /api/cron/retention deletes AgentExecution at RETENTION_DAYS (default 90),
-- so cohort survival past a quarter is not merely expensive to compute live —
-- it is impossible, because the rows are gone. These tables are written ahead
-- of the prune and hold counts only: no user ids, no inputs, no outputs. That
-- is what makes outliving the retention window legitimate rather than a leak.

ALTER TABLE "agent_tasks" ADD COLUMN "deletedAt" TIMESTAMPTZ(6);

CREATE TABLE "adoption_weeks" (
  "id"                      TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "organizationId"          UUID NOT NULL,
  "weekStart"               DATE NOT NULL,
  "agentsCreated"           INTEGER NOT NULL DEFAULT 0,
  "agentsDeleted"           INTEGER NOT NULL DEFAULT 0,
  "execTotal"               INTEGER NOT NULL DEFAULT 0,
  "execManual"              INTEGER NOT NULL DEFAULT 0,
  "execByTrigger"           JSONB NOT NULL DEFAULT '{}',
  "engagedUsers"            INTEGER NOT NULL DEFAULT 0,
  "approvalsApproved"       INTEGER NOT NULL DEFAULT 0,
  "approvalsRejected"       INTEGER NOT NULL DEFAULT 0,
  "approvalsOther"          INTEGER NOT NULL DEFAULT 0,
  "approvalLatencyMedianMs" INTEGER,
  "computedAt"              TIMESTAMP(3) NOT NULL,

  CONSTRAINT "adoption_weeks_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "adoption_weeks_organizationId_weekStart_key"
  ON "adoption_weeks"("organizationId", "weekStart");
CREATE INDEX "adoption_weeks_weekStart_idx" ON "adoption_weeks"("weekStart");

ALTER TABLE "adoption_weeks"
  ADD CONSTRAINT "adoption_weeks_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "organizations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "agent_cohort_weeks" (
  "id"             TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "organizationId" UUID NOT NULL,
  "agentTaskId"    TEXT NOT NULL,
  "cohortWeek"     DATE NOT NULL,
  "activeWeek"     DATE NOT NULL,

  CONSTRAINT "agent_cohort_weeks_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "agent_cohort_weeks_agentTaskId_activeWeek_key"
  ON "agent_cohort_weeks"("agentTaskId", "activeWeek");
CREATE INDEX "agent_cohort_weeks_organizationId_cohortWeek_idx"
  ON "agent_cohort_weeks"("organizationId", "cohortWeek");
CREATE INDEX "agent_cohort_weeks_cohortWeek_activeWeek_idx"
  ON "agent_cohort_weeks"("cohortWeek", "activeWeek");

-- Intentionally NO foreign key from "agentTaskId" to "agent_tasks". See the
-- model doc-comment: cascade-deleting an abandoned agent's history would erase
-- the exact evidence this table exists to keep.
ALTER TABLE "agent_cohort_weeks"
  ADD CONSTRAINT "agent_cohort_weeks_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "organizations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Tenant isolation, same shape as every other org-scoped table. Enabling RLS
-- without a policy is deny-all in PostgreSQL, so the policy ships in the same
-- statement block as the enable — see 20260818130000 for the full rationale.
DO $rls$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['adoption_weeks', 'agent_cohort_weeks'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING ("organizationId" = nullif(current_setting(''app.organization_id'', true), '''')::uuid)
         WITH CHECK ("organizationId" = nullif(current_setting(''app.organization_id'', true), '''')::uuid)', t);

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'backstory_app') THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I TO backstory_app', t);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE format('REVOKE ALL ON TABLE %I FROM anon', t);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      EXECUTE format('REVOKE ALL ON TABLE %I FROM authenticated', t);
    END IF;
  END LOOP;
END
$rls$;
```

- [ ] **Step 3: Register both models in the tenant guard**

In `src/lib/tenant-guard.ts`, inside the `ORG_SCOPED_MODELS` set, add a line after the `'ActivityEvent', 'ActivityTriggerClaim', 'ActivitySourceCursor',` entry:

```ts
  'AdoptionWeek', 'AgentCohortWeek',
```

- [ ] **Step 4: Stamp `deletedAt` at the soft-delete site**

In `src/app/api/agents/route.ts`, find the soft-delete write at line ~315 and change its `data`:

```ts
    data: { status: 'DELETED', deletedAt: new Date() },
```

- [ ] **Step 5: Generate the client and apply the migration**

Run: `npx prisma generate && npx prisma migrate deploy`
Expected: migration `20260824120000_adoption_rollups` applied, client regenerated with both models.

- [ ] **Step 6: Verify RLS coverage passes**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json TEST_DATABASE_URL=$TEST_DATABASE_URL npx tsx --test src/lib/__tests__/rls-coverage.db.test.ts`
Expected: PASS. If it reports a model with RLS disabled, the `DO $rls$` block did not run — re-check the migration.

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20260824120000_adoption_rollups src/lib/tenant-guard.ts src/app/api/agents/route.ts
git commit -m "feat(adoption): rollup tables + agent deletedAt

Two RLS-scoped weekly aggregate tables that outlive the 90-day execution
prune, storing counts only so they carry no payload.

AgentCohortWeek deliberately has no FK to AgentTask: the table's purpose
is history that survives its source row, and a cascade would erase the
record proving an agent was abandoned.

Adds AgentTask.deletedAt because soft-deletion left no timestamp and
updatedAt moves on any edit, making the weekly deletion count
uncomputable. Historical deletions stay null rather than guessed.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Pure computation layer

All week math and matrix assembly, testable without a database.

**Files:**
- Create: `src/lib/adoption/rollup.ts`
- Test: `src/lib/adoption/__tests__/rollup.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1 at runtime (pure functions over plain objects)
- Produces:
  - `weekStartUtc(date: Date): Date`
  - `addWeeks(week: Date, n: number): Date`
  - `weekKey(week: Date): string` — `YYYY-MM-DD`
  - `completeWeeksBack(now: Date, count: number): Date[]` — oldest first, excludes the in-progress week
  - `weekOffset(cohortWeek: string, activeWeek: string): number`
  - `ratio(numerator: number, denominator: number): number | null`
  - `automationRatio(execTotal: number, execManual: number): number | null`
  - `acceptanceRate(approved: number, rejected: number): number | null`
  - `buildSurvival(cohortSizes: Map<string, number>, rows: CohortRow[], maxOffset: number): SurvivalRow[]`
  - `depthBucket(users: number): string`
  - types `CohortRow`, `SurvivalCell`, `SurvivalRow`

- [ ] **Step 1: Write the failing test**

Create `src/lib/adoption/__tests__/rollup.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  weekStartUtc, addWeeks, weekKey, completeWeeksBack, weekOffset,
  ratio, automationRatio, acceptanceRate, buildSurvival, depthBucket,
} from '@/lib/adoption/rollup'

test('weekStartUtc snaps to the Monday of the ISO week in UTC', () => {
  // 2026-08-24 is a Monday.
  assert.equal(weekKey(weekStartUtc(new Date('2026-08-24T00:00:00Z'))), '2026-08-24')
  assert.equal(weekKey(weekStartUtc(new Date('2026-08-24T23:59:59Z'))), '2026-08-24')
  // Sunday belongs to the week that STARTED the previous Monday, not the next.
  assert.equal(weekKey(weekStartUtc(new Date('2026-08-23T12:00:00Z'))), '2026-08-17')
  assert.equal(weekKey(weekStartUtc(new Date('2026-08-30T00:00:00Z'))), '2026-08-24')
})

test('weekStartUtc uses UTC, not local time', () => {
  // 23:30 UTC Sunday is Monday in +02:00. It must still snap to the previous
  // Monday, or every rollup silently shifts by a day for half the world.
  assert.equal(weekKey(weekStartUtc(new Date('2026-08-23T23:30:00Z'))), '2026-08-17')
})

test('completeWeeksBack excludes the in-progress week', () => {
  const weeks = completeWeeksBack(new Date('2026-08-26T10:00:00Z'), 2)
  assert.deepEqual(weeks.map(weekKey), ['2026-08-10', '2026-08-17'])
})

test('weekOffset counts whole weeks between cohort and activity', () => {
  assert.equal(weekOffset('2026-06-01', '2026-06-01'), 0)
  assert.equal(weekOffset('2026-06-01', '2026-06-08'), 1)
  assert.equal(weekOffset('2026-06-01', '2026-08-24'), 12)
})

test('ratio returns null on a zero denominator rather than zero', () => {
  // A week with no runs has NO automation ratio. Rendering 0 would read as
  // "fully manual" — the opposite of the truth.
  assert.equal(ratio(0, 0), null)
  assert.equal(automationRatio(0, 0), null)
  assert.equal(acceptanceRate(0, 0), null)
  assert.equal(automationRatio(10, 4), 0.6)
  assert.equal(acceptanceRate(8, 2), 0.8)
})

test('buildSurvival keeps never-run agents in the denominator at zero', () => {
  // Three agents created; only one ever ran. Survival must be 1/3, not 1/1.
  const sizes = new Map([['2026-06-01', 3]])
  const rows = [{ agentTaskId: 'a1', cohortWeek: '2026-06-01', activeWeek: '2026-06-08' }]
  const [cohort] = buildSurvival(sizes, rows, 2)

  assert.equal(cohort.cohortWeek, '2026-06-01')
  assert.equal(cohort.size, 3)
  assert.deepEqual(cohort.cells.map((c) => [c.offset, c.active]), [[0, 0], [1, 1], [2, 0]])
  assert.equal(cohort.cells[1].rate, 1 / 3)
})

test('buildSurvival is non-monotonic — a returning agent counts again', () => {
  // Retention measures activity IN a week, not "ever after". An agent idle in
  // W+1 and active again in W+2 must reappear.
  const sizes = new Map([['2026-06-01', 1]])
  const rows = [
    { agentTaskId: 'a1', cohortWeek: '2026-06-01', activeWeek: '2026-06-01' },
    { agentTaskId: 'a1', cohortWeek: '2026-06-01', activeWeek: '2026-06-15' },
  ]
  const [cohort] = buildSurvival(sizes, rows, 2)
  assert.deepEqual(cohort.cells.map((c) => c.active), [1, 0, 1])
})

test('buildSurvival ignores rows beyond maxOffset and negative offsets', () => {
  const sizes = new Map([['2026-06-01', 1]])
  const rows = [
    { agentTaskId: 'a1', cohortWeek: '2026-06-01', activeWeek: '2026-09-01' }, // far future
    { agentTaskId: 'a2', cohortWeek: '2026-06-01', activeWeek: '2026-05-25' }, // impossible
  ]
  const [cohort] = buildSurvival(sizes, rows, 2)
  assert.deepEqual(cohort.cells.map((c) => c.active), [0, 0, 0])
})

test('buildSurvival returns cohorts oldest first and tolerates an empty cohort', () => {
  const sizes = new Map([['2026-06-08', 1], ['2026-06-01', 0]])
  const out = buildSurvival(sizes, [], 1)
  assert.deepEqual(out.map((c) => c.cohortWeek), ['2026-06-01', '2026-06-08'])
  // Size 0 must not divide by zero.
  assert.equal(out[0].cells[0].rate, 0)
})

test('depthBucket separates a single champion from a real team', () => {
  assert.equal(depthBucket(1), '1')
  assert.equal(depthBucket(4), '2-4')
  assert.equal(depthBucket(9), '5-9')
  assert.equal(depthBucket(10), '10+')
  assert.equal(depthBucket(0), '0')
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/adoption/__tests__/rollup.test.ts`
Expected: FAIL — `Cannot find module '@/lib/adoption/rollup'`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/adoption/rollup.ts`:

```ts
/**
 * Pure adoption maths.
 *
 * Every load-bearing decision in the adoption rollups lives here, deliberately
 * free of Prisma and of I/O, so week boundaries and cohort assembly can be
 * tested exhaustively without a database — the same split as
 * src/lib/agents/roster.ts.
 *
 * Weeks are ISO weeks starting Monday, in UTC. All four source columns
 * (AgentTask.createdAt, AgentExecution.startedAt, AgentChatMessage.createdAt,
 * ApprovalRequest.createdAt) are Prisma-default naive timestamps holding UTC.
 */

const DAY_MS = 24 * 60 * 60 * 1000
const WEEK_MS = 7 * DAY_MS

/** Monday 00:00:00.000 UTC of the ISO week containing `date`. */
export function weekStartUtc(date: Date): Date {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
  const dow = d.getUTCDay() // 0 = Sunday
  // Monday-based: Sunday is the SEVENTH day of its week, not the first.
  d.setUTCDate(d.getUTCDate() - (dow === 0 ? 6 : dow - 1))
  return d
}

export function addWeeks(week: Date, n: number): Date {
  return new Date(week.getTime() + n * WEEK_MS)
}

/** `YYYY-MM-DD`, the canonical key for a week everywhere in this module. */
export function weekKey(week: Date): string {
  return week.toISOString().slice(0, 10)
}

/**
 * The `count` most recent COMPLETE weeks, oldest first. The week containing
 * `now` is excluded: a partial week always renders as a dip, and a dip on an
 * adoption chart gets read as decay.
 */
export function completeWeeksBack(now: Date, count: number): Date[] {
  const current = weekStartUtc(now)
  const weeks: Date[] = []
  for (let i = count; i >= 1; i--) weeks.push(addWeeks(current, -i))
  return weeks
}

/** Whole weeks from `cohortWeek` to `activeWeek`. Both are `YYYY-MM-DD` keys. */
export function weekOffset(cohortWeek: string, activeWeek: string): number {
  const from = Date.parse(`${cohortWeek}T00:00:00Z`)
  const to = Date.parse(`${activeWeek}T00:00:00Z`)
  return Math.round((to - from) / WEEK_MS)
}

/**
 * A rate, or null when there is nothing to rate. Never 0 for an empty
 * denominator — "no runs at all" and "every run was manual" are opposite
 * findings and must not render identically.
 */
export function ratio(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null
  return numerator / denominator
}

export function automationRatio(execTotal: number, execManual: number): number | null {
  return ratio(execTotal - execManual, execTotal)
}

export function acceptanceRate(approved: number, rejected: number): number | null {
  return ratio(approved, approved + rejected)
}

export interface CohortRow {
  agentTaskId: string
  cohortWeek: string
  activeWeek: string
}

export interface SurvivalCell {
  offset: number
  active: number
  /** active / size. 0 for an empty cohort — never NaN. */
  rate: number
}

export interface SurvivalRow {
  cohortWeek: string
  size: number
  cells: SurvivalCell[]
}

/**
 * The retention matrix.
 *
 * `cohortSizes` is every agent CREATED in a week, including agents that never
 * ran once. Those stay in the denominator and score 0 in every cell — that is
 * the "created it, never touched it again" case, and it is the single most
 * important thing this curve exists to catch.
 *
 * Counting rows directly is safe: agent_cohort_weeks is unique on
 * (agentTaskId, activeWeek), and cohortWeek is functionally determined by the
 * agent, so one agent can contribute at most one row per (cohort, offset).
 */
export function buildSurvival(
  cohortSizes: Map<string, number>,
  rows: CohortRow[],
  maxOffset: number,
): SurvivalRow[] {
  const counts = new Map<string, number>() // `${cohortWeek}|${offset}` -> active
  for (const row of rows) {
    const offset = weekOffset(row.cohortWeek, row.activeWeek)
    // An agent cannot run before it exists, and anything past the reported
    // horizon is not part of this matrix.
    if (offset < 0 || offset > maxOffset) continue
    const key = `${row.cohortWeek}|${offset}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }

  return [...cohortSizes.keys()]
    .sort()
    .map((cohortWeek) => {
      const size = cohortSizes.get(cohortWeek) ?? 0
      const cells: SurvivalCell[] = []
      for (let offset = 0; offset <= maxOffset; offset++) {
        const active = counts.get(`${cohortWeek}|${offset}`) ?? 0
        cells.push({ offset, active, rate: size > 0 ? active / size : 0 })
      }
      return { cohortWeek, size, cells }
    })
}

/**
 * Engaged-user buckets. The 1-vs-many split is the whole point: an org where
 * one person runs everything is a pilot, not an adoption.
 */
export function depthBucket(users: number): string {
  if (users <= 0) return '0'
  if (users === 1) return '1'
  if (users <= 4) return '2-4'
  if (users <= 9) return '5-9'
  return '10+'
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/adoption/__tests__/rollup.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/adoption/rollup.ts src/lib/adoption/__tests__/rollup.test.ts
git commit -m "feat(adoption): pure week maths and survival matrix

Week boundaries, cohort offsets and retention assembly as pure functions
so they test without a database.

Two rulings pinned by test: a zero denominator yields null rather than 0
(no runs and all-manual are opposite findings), and agents created but
never run stay in the survival denominator at 0 — the case the curve
exists to catch.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: The rollup job

**Files:**
- Create: `src/lib/adoption/compute.ts` (DB queries + upsert; separate from the pure layer)
- Create: `src/app/api/cron/adoption-rollup/route.ts`
- Modify: `src/lib/authz/ungated-routes.ts` (add `cron/adoption-rollup`)
- Modify: `vercel.json` (add the cron entry)
- Test: `src/lib/adoption/__tests__/compute.db.test.ts`

**Interfaces:**
- Consumes: `completeWeeksBack`, `weekKey`, `addWeeks` from `@/lib/adoption/rollup`; Prisma models from Task 1
- Produces: `rollupWeek(weekStart: Date): Promise<{ organizations: number }>` and `runAdoptionRollup(now: Date, weeks: number): Promise<{ weeks: string[]; organizations: number }>` from `@/lib/adoption/compute`

- [ ] **Step 1: Write the failing DB test**

Create `src/lib/adoption/__tests__/compute.db.test.ts`:

```ts
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

/**
 * The rollup job against a real database.
 *
 * Runs concurrently against a shared bs_ci_repro database, so every assertion
 * is scoped to organizations this suite created. Absolute global counts are
 * flaky by construction here — sibling suites leave residue.
 *
 * The load-bearing cases: the job must be idempotent (it re-runs daily over
 * the same window, so a second pass must not double anything), demo orgs must
 * be excluded (their history is canned, not real), and an agent that never ran
 * must still land in its cohort denominator.
 */
const TEST_DB = process.env.TEST_DATABASE_URL
if (!TEST_DB) test('adoption rollup (skipped: TEST_DATABASE_URL not set)', { skip: true }, () => {})

if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'test-key'

  let prisma: any
  let rollupWeek: (weekStart: Date) => Promise<{ organizations: number }>
  let realOrgId: string
  let demoOrgId: string
  let userId: string

  // A Monday well in the past, so no sibling suite's fresh rows land in it.
  const WEEK = new Date('2026-06-01T00:00:00Z')
  const inWeek = (dayOffset: number) =>
    new Date(WEEK.getTime() + dayOffset * 24 * 60 * 60 * 1000 + 3600_000)

  before(async () => {
    ;({ systemPrisma: prisma } = await import('@/lib/prisma'))
    ;({ rollupWeek } = await import('@/lib/adoption/compute'))

    const suffix = crypto.randomUUID().slice(0, 8)
    const realOrg = await prisma.organization.create({
      data: { name: `adoption-real-${suffix}`, slug: `adoption-real-${suffix}` },
    })
    const demoOrg = await prisma.organization.create({
      data: { name: `adoption-demo-${suffix}`, slug: `adoption-demo-${suffix}`, kind: 'demo' },
    })
    realOrgId = realOrg.id
    demoOrgId = demoOrg.id

    // supabaseId is REQUIRED and @unique @db.Uuid — omitting it fails the
    // create with a missing-argument error, not a null.
    const user = await prisma.user.create({
      data: {
        supabaseId: crypto.randomUUID(),
        email: `adoption-${suffix}@example.test`,
        organizationId: realOrgId,
      },
    })
    userId = user.id

    // Two agents created in the window; only ONE of them ever runs.
    const ran = await prisma.agentTask.create({
      data: {
        organizationId: realOrgId, userId, description: 'ran', objective: 'o',
        createdAt: inWeek(0),
      },
    })
    await prisma.agentTask.create({
      data: {
        organizationId: realOrgId, userId, description: 'never ran', objective: 'o',
        createdAt: inWeek(0),
      },
    })

    // 3 executions: 2 manual, 1 scheduled -> automation ratio 1/3.
    //
    // One is deliberately `failed`. Activity counts runs of ANY status: an
    // agent someone keeps re-running despite failures is still an agent in
    // use, and success rate is a separate question already answered by
    // /api/agents/kpis. Seeding only successes would let a status filter creep
    // in unnoticed.
    const seeded = [
      { trigger: { type: 'manual' }, status: 'completed' },
      { trigger: { type: 'manual' }, status: 'failed' },
      { trigger: { type: 'schedule' }, status: 'completed' },
    ]
    for (const { trigger, status } of seeded) {
      await prisma.agentExecution.create({
        data: {
          organizationId: realOrgId, userId, agentTaskId: ran.id, agentType: 'CUSTOM',
          status, input: {}, trigger, startedAt: inWeek(1),
        },
      })
    }

    // A demo-org agent + execution that must NOT appear anywhere.
    const demoUser = await prisma.user.create({
      data: {
        supabaseId: crypto.randomUUID(),
        email: `adoption-demo-${suffix}@example.test`,
        organizationId: demoOrgId,
      },
    })
    const demoAgent = await prisma.agentTask.create({
      data: {
        organizationId: demoOrgId, userId: demoUser.id, description: 'demo', objective: 'o',
        createdAt: inWeek(0),
      },
    })
    await prisma.agentExecution.create({
      data: {
        organizationId: demoOrgId, userId: demoUser.id, agentTaskId: demoAgent.id,
        agentType: 'CUSTOM', status: 'completed', input: {}, trigger: { type: 'manual' },
        startedAt: inWeek(1),
      },
    })

    await prisma.approvalRequest.create({
      data: {
        organizationId: realOrgId, executionId: 'exec-x', tool: 'send_email', summary: 's',
        payload: {}, status: 'approved', decidedById: userId,
        createdAt: inWeek(2), decidedAt: new Date(inWeek(2).getTime() + 60_000),
      },
    })
  })

  after(async () => {
    // Org delete cascades to agents, executions, approvals and both rollup
    // tables, so the shared ci_repro database keeps no residue from this suite.
    for (const id of [realOrgId, demoOrgId]) {
      await prisma.organization.delete({ where: { id } }).catch(() => {})
    }
  })

  test('rolls the week up into one row per real organization', async () => {
    await rollupWeek(WEEK)

    const row = await prisma.adoptionWeek.findUnique({
      where: { organizationId_weekStart: { organizationId: realOrgId, weekStart: WEEK } },
    })
    assert.ok(row, 'expected a rollup row for the seeded org')
    assert.equal(row.agentsCreated, 2)
    assert.equal(row.execTotal, 3)
    assert.equal(row.execManual, 2)
    assert.deepEqual(row.execByTrigger, { manual: 2, schedule: 1 })
    assert.equal(row.engagedUsers, 1)
    assert.equal(row.approvalsApproved, 1)
    assert.equal(row.approvalsRejected, 0)
    assert.ok(row.approvalLatencyMedianMs !== null && row.approvalLatencyMedianMs >= 59_000)
  })

  test('excludes demo organizations entirely', async () => {
    await rollupWeek(WEEK)
    const row = await prisma.adoptionWeek.findUnique({
      where: { organizationId_weekStart: { organizationId: demoOrgId, weekStart: WEEK } },
    })
    assert.equal(row, null, 'demo org history is canned and must never be rolled up')
  })

  test('is idempotent — a second pass changes no counts', async () => {
    await rollupWeek(WEEK)
    const first = await prisma.adoptionWeek.findUnique({
      where: { organizationId_weekStart: { organizationId: realOrgId, weekStart: WEEK } },
    })
    const cohortsFirst = await prisma.agentCohortWeek.count({ where: { organizationId: realOrgId } })

    await rollupWeek(WEEK)
    const second = await prisma.adoptionWeek.findUnique({
      where: { organizationId_weekStart: { organizationId: realOrgId, weekStart: WEEK } },
    })
    const cohortsSecond = await prisma.agentCohortWeek.count({ where: { organizationId: realOrgId } })

    assert.equal(second.execTotal, first.execTotal)
    assert.equal(second.agentsCreated, first.agentsCreated)
    assert.equal(cohortsSecond, cohortsFirst, 'cohort rows must not duplicate on re-run')
  })

  test('writes a cohort row only for the agent that actually ran', async () => {
    await rollupWeek(WEEK)
    const rows = await prisma.agentCohortWeek.findMany({ where: { organizationId: realOrgId } })
    assert.equal(rows.length, 1, 'the never-run agent must not get an active-week row')
    assert.equal(rows[0].cohortWeek.toISOString().slice(0, 10), '2026-06-01')
    assert.equal(rows[0].activeWeek.toISOString().slice(0, 10), '2026-06-01')
  })

  // MUST run last: it mutates agentsDeleted, which the idempotency test above
  // asserts against. node:test runs a file's tests in declaration order.
  test('a soft-deleted agent keeps its cohort history and is counted as deleted', async () => {
    await prisma.agentTask.updateMany({
      where: { organizationId: realOrgId, description: 'ran' },
      data: { status: 'DELETED', deletedAt: inWeek(3) },
    })
    await rollupWeek(WEEK)

    const row = await prisma.adoptionWeek.findUnique({
      where: { organizationId_weekStart: { organizationId: realOrgId, weekStart: WEEK } },
    })
    assert.equal(row.agentsDeleted, 1)
    // Still 2: deletion is soft, so createdAt survives and the cohort
    // denominator does not shrink when an agent is abandoned.
    assert.equal(row.agentsCreated, 2)

    const rows = await prisma.agentCohortWeek.findMany({ where: { organizationId: realOrgId } })
    assert.equal(rows.length, 1, 'cohort history must survive the agent being deleted')
  })
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json TEST_DATABASE_URL=$TEST_DATABASE_URL npx tsx --test src/lib/adoption/__tests__/compute.db.test.ts`
Expected: FAIL — `Cannot find module '@/lib/adoption/compute'`.

- [ ] **Step 3: Write the compute layer**

Create `src/lib/adoption/compute.ts`:

```ts
/**
 * Adoption rollup: reads a week of raw activity and writes one aggregate row
 * per organization, plus a cohort row per agent that ran.
 *
 * Recompute-and-upsert rather than incremental append. The job runs daily over
 * a two-week window, so it must be safe to run repeatedly over the same days —
 * and a missed day then self-heals on the next run instead of leaving a
 * permanent hole.
 *
 * systemPrisma throughout: this is a cross-org platform sweep by design, the
 * same justification as /api/cron/retention.
 */

import { systemPrisma } from '@/lib/prisma'
import { addWeeks, completeWeeksBack, weekKey } from '@/lib/adoption/rollup'

/** Prisma returns bigint from count(*) in raw SQL. */
const toInt = (value: unknown): number => Number(value ?? 0)

async function demoOrganizationIds(): Promise<string[]> {
  // Demo orgs are disposable anonymised clones (src/lib/demo/snapshot.ts).
  // Their history is canned data the clone wrote for itself, so counting it
  // would report imaginary adoption.
  const rows = await systemPrisma.organization.findMany({
    where: { kind: 'demo' },
    select: { id: true },
  })
  return rows.map((row) => row.id)
}

interface WeekTotals {
  agentsCreated: number
  agentsDeleted: number
  execTotal: number
  execManual: number
  execByTrigger: Record<string, number>
  engagedUsers: number
  approvalsApproved: number
  approvalsRejected: number
  approvalsOther: number
  approvalLatencyMedianMs: number | null
}

const emptyTotals = (): WeekTotals => ({
  agentsCreated: 0, agentsDeleted: 0, execTotal: 0, execManual: 0, execByTrigger: {},
  engagedUsers: 0, approvalsApproved: 0, approvalsRejected: 0, approvalsOther: 0,
  approvalLatencyMedianMs: null,
})

/**
 * Recompute one complete week and upsert its rows.
 *
 * `weekStart` must already be a Monday UTC — callers get it from
 * completeWeeksBack().
 */
export async function rollupWeek(weekStart: Date): Promise<{ organizations: number }> {
  const weekEnd = addWeeks(weekStart, 1)
  const demoIds = await demoOrganizationIds()
  const byOrg = new Map<string, WeekTotals>()
  const totals = (organizationId: string): WeekTotals => {
    const existing = byOrg.get(organizationId)
    if (existing) return existing
    const fresh = emptyTotals()
    byOrg.set(organizationId, fresh)
    return fresh
  }

  const [created, deleted] = await Promise.all([
    systemPrisma.agentTask.groupBy({
      by: ['organizationId'],
      where: { createdAt: { gte: weekStart, lt: weekEnd }, organizationId: { notIn: demoIds } },
      _count: { _all: true },
    }),
    systemPrisma.agentTask.groupBy({
      by: ['organizationId'],
      where: { deletedAt: { gte: weekStart, lt: weekEnd }, organizationId: { notIn: demoIds } },
      _count: { _all: true },
    }),
  ])
  for (const row of created) totals(row.organizationId).agentsCreated = row._count._all
  for (const row of deleted) totals(row.organizationId).agentsDeleted = row._count._all

  // Raw SQL: Prisma groupBy cannot group by a JSON path. `<> ALL('{}')` is
  // true for every row, so an empty demo list correctly excludes nothing.
  const triggerRows = await systemPrisma.$queryRaw<Array<{ organizationId: string; t: string | null; n: bigint }>>`
    SELECT e."organizationId", e.trigger->>'type' AS t, count(*) AS n
    FROM agent_executions e
    WHERE e."startedAt" >= ${weekStart} AND e."startedAt" < ${weekEnd}
      AND e."organizationId" <> ALL(${demoIds}::uuid[])
    GROUP BY 1, 2
  `
  for (const row of triggerRows) {
    const entry = totals(row.organizationId)
    const type = row.t ?? 'unknown'
    const n = toInt(row.n)
    entry.execByTrigger[type] = (entry.execByTrigger[type] ?? 0) + n
    entry.execTotal += n
    if (type === 'manual') entry.execManual += n
  }

  // Engaged humans: manual runs OR a chat message they wrote. Deliberately not
  // every execution — a scheduled run attributes to the agent's owner, which
  // would inflate one champion with fifty cron agents into a fifty-user team.
  // role = 'user' excludes the agent's own replies.
  const engagedRows = await systemPrisma.$queryRaw<Array<{ organizationId: string; n: bigint }>>`
    SELECT s."organizationId", count(DISTINCT s."userId") AS n
    FROM (
      SELECT e."organizationId", e."userId"
      FROM agent_executions e
      WHERE e."startedAt" >= ${weekStart} AND e."startedAt" < ${weekEnd}
        AND e.trigger->>'type' = 'manual'
      UNION
      SELECT m."organizationId", m."userId"
      FROM agent_chat_messages m
      WHERE m."createdAt" >= ${weekStart} AND m."createdAt" < ${weekEnd}
        AND m.role = 'user'
    ) s
    WHERE s."organizationId" <> ALL(${demoIds}::uuid[])
    GROUP BY 1
  `
  for (const row of engagedRows) totals(row.organizationId).engagedUsers = toInt(row.n)

  // Bucketed on createdAt, so a week's requests are counted in the week they
  // were ASKED. percentile_cont has no Prisma equivalent.
  const approvalRows = await systemPrisma.$queryRaw<Array<{
    organizationId: string; approved: bigint; rejected: bigint; other: bigint; median_ms: number | null
  }>>`
    SELECT a."organizationId",
      count(*) FILTER (WHERE a.status = 'approved') AS approved,
      count(*) FILTER (WHERE a.status = 'rejected') AS rejected,
      count(*) FILTER (WHERE a.status NOT IN ('approved', 'rejected')) AS other,
      percentile_cont(0.5) WITHIN GROUP (
        ORDER BY EXTRACT(EPOCH FROM (a."decidedAt" - a."createdAt")) * 1000
      ) FILTER (WHERE a."decidedAt" IS NOT NULL) AS median_ms
    FROM approval_requests a
    WHERE a."createdAt" >= ${weekStart} AND a."createdAt" < ${weekEnd}
      AND a."organizationId" <> ALL(${demoIds}::uuid[])
    GROUP BY 1
  `
  for (const row of approvalRows) {
    const entry = totals(row.organizationId)
    entry.approvalsApproved = toInt(row.approved)
    entry.approvalsRejected = toInt(row.rejected)
    entry.approvalsOther = toInt(row.other)
    entry.approvalLatencyMedianMs = row.median_ms === null ? null : Math.round(Number(row.median_ms))
  }

  // Cohort rows for every agent that ran this week. ON CONFLICT DO NOTHING is
  // what makes the daily re-run free. date_trunc('week') is Monday-based and
  // the column is a naive timestamp holding UTC, so no timezone cast belongs
  // here — adding one would shift every cohort by hours.
  await systemPrisma.$executeRaw`
    INSERT INTO agent_cohort_weeks ("organizationId", "agentTaskId", "cohortWeek", "activeWeek")
    SELECT t."organizationId", t.id, date_trunc('week', t."createdAt")::date, ${weekStart}::date
    FROM agent_tasks t
    WHERE t."organizationId" <> ALL(${demoIds}::uuid[])
      AND EXISTS (
        SELECT 1 FROM agent_executions e
        WHERE e."agentTaskId" = t.id
          AND e."startedAt" >= ${weekStart} AND e."startedAt" < ${weekEnd}
      )
    ON CONFLICT ("agentTaskId", "activeWeek") DO NOTHING
  `

  for (const [organizationId, entry] of byOrg) {
    await systemPrisma.adoptionWeek.upsert({
      where: { organizationId_weekStart: { organizationId, weekStart } },
      create: { organizationId, weekStart, ...entry },
      update: { ...entry },
    })
  }

  return { organizations: byOrg.size }
}

/**
 * Recompute the last `weeks` COMPLETE weeks. Two on the daily schedule; more
 * when backfilling.
 */
export async function runAdoptionRollup(
  now: Date,
  weeks: number,
): Promise<{ weeks: string[]; organizations: number }> {
  const targets = completeWeeksBack(now, weeks)
  let organizations = 0
  for (const week of targets) {
    const result = await rollupWeek(week)
    organizations += result.organizations
  }
  return { weeks: targets.map(weekKey), organizations }
}
```

- [ ] **Step 4: Run the DB test to verify it passes**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json TEST_DATABASE_URL=$TEST_DATABASE_URL npx tsx --test src/lib/adoption/__tests__/compute.db.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Write the cron route**

Create `src/app/api/cron/adoption-rollup/route.ts`:

```ts
/**
 * /api/cron/adoption-rollup — daily recompute of the adoption rollups.
 *
 * Scheduled at 03:30 UTC, half an hour ahead of the 04:00 retention prune.
 * With a 90-day prune window and a two-week lookback the ordering has enormous
 * margin; the offset is insurance, not a dependency.
 *
 * `?weeks=N` recomputes N complete weeks instead of 2 — this doubles as the
 * one-time backfill over whatever live history exists after deploy.
 *
 * Auth (fail closed): requires Authorization: Bearer <CRON_SECRET>.
 */

import { timingSafeEqual } from 'crypto'
import { runAdoptionRollup } from '@/lib/adoption/compute'
import { apiLogger } from '@/lib/logger'
import { recordTokenRejection } from '@/lib/security/events'

export const runtime = 'nodejs'
export const maxDuration = 300
export const dynamic = 'force-dynamic'

const DEFAULT_WEEKS = 2
const MAX_WEEKS = 104

async function checkAuthorized(request: Request): Promise<Response | null> {
  const secret = process.env.CRON_SECRET
  if (!secret) return Response.json({ success: false, error: 'CRON_SECRET not configured' }, { status: 503 })
  const authHeader = request.headers.get('authorization') || ''
  const provided = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  const a = Buffer.from(provided)
  const b = Buffer.from(secret)
  if (!(a.length === b.length && timingSafeEqual(a, b))) {
    await recordTokenRejection(request, { surface: 'cron', reason: 'invalid_cron_secret' })
    return Response.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }
  return null
}

export async function GET(request: Request) {
  const unauthorized = await checkAuthorized(request)
  if (unauthorized) return unauthorized

  const requested = Number(new URL(request.url).searchParams.get('weeks'))
  const weeks = Math.min(MAX_WEEKS, Math.max(1, Number.isFinite(requested) && requested > 0 ? requested : DEFAULT_WEEKS))

  try {
    const result = await runAdoptionRollup(new Date(), weeks)
    apiLogger.info('adoption rollup complete', { weeks: result.weeks.length, organizations: result.organizations })
    return Response.json({ success: true, ...result })
  } catch (error) {
    apiLogger.error('adoption rollup failed', { error: error instanceof Error ? error.message : String(error) })
    return Response.json({ success: false, error: 'Rollup failed' }, { status: 500 })
  }
}
```

- [ ] **Step 6: Declare the route as ungated**

In `src/lib/authz/ungated-routes.ts`, add after the `'cron/indexer-sweep'` line:

```ts
  'cron/adoption-rollup',                 // CRON_SECRET header
```

- [ ] **Step 7: Add the cron schedule**

In `vercel.json`, add to the `crons` array:

```json
    {
      "path": "/api/cron/adoption-rollup",
      "schedule": "30 3 * * *"
    }
```

- [ ] **Step 8: Verify the route inventories pass**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/app/api/__tests__/permission-coverage.test.ts src/app/api/__tests__/route-smoke.test.ts`
Expected: PASS. A failure naming `cron/adoption-rollup` means Step 6 was missed.

- [ ] **Step 9: Typecheck and commit**

Run: `npm run typecheck`
Expected: clean.

```bash
git add src/lib/adoption/compute.ts src/lib/adoption/__tests__/compute.db.test.ts src/app/api/cron/adoption-rollup src/lib/authz/ungated-routes.ts vercel.json
git commit -m "feat(adoption): daily rollup job with ?weeks=N backfill

Recompute-and-upsert over the last two complete weeks, so a missed day
self-heals on the next run rather than leaving a permanent hole.

Demo organizations are excluded everywhere: their history is canned data
a clone wrote for itself, and counting it would report imaginary
adoption.

Engaged users counts manual runs and human chat messages only —
scheduled runs attribute to the agent owner and would inflate one
champion with fifty cron agents into a fifty-user team.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: The read route

**Files:**
- Create: `src/app/api/admin/adoption/route.ts`
- Modify: `src/app/api/__tests__/edition-gates.test.ts` (add to `INTERNAL_ONLY_ROUTES`)
- Test: `src/app/api/admin/__tests__/adoption-route.db.test.ts`

**Interfaces:**
- Consumes: `buildSurvival`, `automationRatio`, `acceptanceRate`, `depthBucket`, `weekKey`, `completeWeeksBack` from `@/lib/adoption/rollup`; the two Prisma models
- Produces: `GET /api/admin/adoption?weeks=N` returning `AdoptionReport` (shape below)

- [ ] **Step 1: Write the failing DB test**

Create `src/app/api/admin/__tests__/adoption-route.db.test.ts`:

```ts
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { NextRequest } from 'next/server'

/**
 * /api/admin/adoption against a real database.
 *
 * Shared bs_ci_repro, so assertions are delta-scoped: this suite seeds one
 * organization and asserts only about that organization's row inside the
 * response, never about platform totals a sibling suite also writes to.
 */
const TEST_DB = process.env.TEST_DATABASE_URL
if (!TEST_DB) test('admin adoption route (skipped: TEST_DATABASE_URL not set)', { skip: true }, () => {})

if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'test-key'

  let prisma: any
  let adoptionRoute: any
  let operator: any
  let orgId: string
  const WEEK = new Date('2026-06-01T00:00:00Z')

  const get = (weeks: number) =>
    new NextRequest(new URL(`http://test/api/admin/adoption?weeks=${weeks}`))

  const report = async (weeks = 52) => {
    const response = await adoptionRoute.GET(get(weeks))
    const body = await response.json()
    assert.equal(response.status, 200, JSON.stringify(body))
    return body
  }

  before(async () => {
    ;({ systemPrisma: prisma } = await import('@/lib/prisma'))
    const testAuth = await import('@/lib/server/__tests__/test-auth')

    // platform.administer requires BOTH an operating org kind and the reviewer
    // flag — see resolvePermissions. Either alone yields a 403.
    operator = await testAuth.seedTestOrg(prisma, { orgKind: 'internal', platformRole: 'reviewer' })
    testAuth.installTestAuth(operator.auth)

    // Imported AFTER installTestAuth: the wrapper resolves auth at module
    // scope, so importing first captures the un-installed context.
    adoptionRoute = await import('../adoption/route')

    const suffix = crypto.randomUUID().slice(0, 8)
    const org = await prisma.organization.create({
      data: { name: `adopt-read-${suffix}`, slug: `adopt-read-${suffix}` },
    })
    orgId = org.id

    await prisma.adoptionWeek.create({
      data: {
        organizationId: orgId, weekStart: WEEK,
        agentsCreated: 4, execTotal: 10, execManual: 4,
        execByTrigger: { manual: 4, schedule: 6 },
        engagedUsers: 3, approvalsApproved: 8, approvalsRejected: 2,
      },
    })
    // Cohort of 4 created that week; 2 still active a week later.
    for (const agentTaskId of ['ca1', 'ca2']) {
      await prisma.agentCohortWeek.create({
        data: {
          organizationId: orgId, agentTaskId: `${suffix}-${agentTaskId}`,
          cohortWeek: WEEK, activeWeek: new Date('2026-06-08T00:00:00Z'),
        },
      })
    }
  })

  after(async () => {
    // Cascade takes adoption_weeks and agent_cohort_weeks with the org.
    await prisma.organization.delete({ where: { id: orgId } }).catch(() => {})
    await operator?.cleanup()
  })

  test('derives ratios and never divides by zero', async () => {
    const body = await report()

    const row = body.byOrg.find((entry: any) => entry.organizationId === orgId)
    assert.ok(row, 'seeded org must appear in byOrg')
    assert.equal(row.execTotal, 10)
    // 10 total, 4 manual -> 6/10 automated.
    assert.equal(row.automationRatio, 0.6)
    assert.equal(row.acceptanceRate, 0.8)
    assert.equal(row.depthBucket, '2-4')
  })

  test('survival reports the cohort denominator, not just the survivors', async () => {
    const body = await report()

    const cohort = body.survival.find((c: any) => c.cohortWeek === '2026-06-01')
    assert.ok(cohort, 'expected the seeded cohort')
    // Other suites may seed the same week, so assert the invariant rather than
    // an absolute: survivors can never exceed the cohort that created them.
    assert.ok(cohort.size >= 4)
    assert.ok(cohort.cells[1].active >= 2)
    assert.ok(cohort.cells[1].active <= cohort.size)
    assert.ok(cohort.cells[1].rate <= 1)
  })

  test('excludes the in-progress week', async () => {
    const body = await report()

    const currentWeekKey = (() => {
      const now = new Date()
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
      const dow = d.getUTCDay()
      d.setUTCDate(d.getUTCDate() - (dow === 0 ? 6 : dow - 1))
      return d.toISOString().slice(0, 10)
    })()

    assert.equal(
      body.weeks.some((w: any) => w.weekStart === currentWeekKey), false,
      'a partial week renders as a dip and must never be shown',
    )
  })
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json TEST_DATABASE_URL=$TEST_DATABASE_URL npx tsx --test src/app/api/admin/__tests__/adoption-route.db.test.ts`
Expected: FAIL — `Cannot find module '@/app/api/admin/adoption/route'`.

- [ ] **Step 3: Write the route**

Create `src/app/api/admin/adoption/route.ts`:

```ts
import { systemPrisma } from '@/lib/prisma'
import { withAuthenticatedApi } from '@/lib/server/api-handler'
import {
  acceptanceRate, automationRatio, buildSurvival, completeWeeksBack, depthBucket, weekKey,
} from '@/lib/adoption/rollup'

/**
 * Cross-workspace adoption report for internal ops.
 *
 * Reads the rollup tables rather than raw executions: /api/cron/retention
 * prunes AgentExecution at 90 days, so anything longer-horizon is only
 * answerable from the aggregates. Never exposed to customer org admins — this
 * reaches across every workspace, which is why it sits behind
 * platform.administer alongside the rest of /admin.
 *
 * systemPrisma: cross-org aggregate by design.
 */

/** How many weeks of survival to report per cohort. */
const MAX_OFFSET = 12

export const GET = withAuthenticatedApi(async (request) => {
  const requested = Number(request.nextUrl.searchParams.get('weeks'))
  const weeks = Math.min(104, Math.max(4, Number.isFinite(requested) && requested > 0 ? requested : 26))

  const window = completeWeeksBack(new Date(), weeks)
  const since = window[0]

  const rows = await systemPrisma.adoptionWeek.findMany({
    where: { weekStart: { gte: since } },
    orderBy: { weekStart: 'asc' },
  })

  // Platform totals per week, summed across workspaces.
  const byWeek = new Map<string, {
    weekStart: string; agentsCreated: number; agentsDeleted: number
    execTotal: number; execManual: number; execByTrigger: Record<string, number>
    engagedUsers: number; approvalsApproved: number; approvalsRejected: number; approvalsOther: number
  }>()
  for (const row of rows) {
    const key = weekKey(row.weekStart)
    const entry = byWeek.get(key) ?? {
      weekStart: key, agentsCreated: 0, agentsDeleted: 0, execTotal: 0, execManual: 0,
      execByTrigger: {}, engagedUsers: 0, approvalsApproved: 0, approvalsRejected: 0, approvalsOther: 0,
    }
    entry.agentsCreated += row.agentsCreated
    entry.agentsDeleted += row.agentsDeleted
    entry.execTotal += row.execTotal
    entry.execManual += row.execManual
    // engagedUsers sums DISTINCT-per-org counts. A human in two workspaces is
    // counted twice; that is deliberate — this measures adopting seats, not
    // unique humans, and the per-org distinctness is what the depth chart uses.
    entry.engagedUsers += row.engagedUsers
    entry.approvalsApproved += row.approvalsApproved
    entry.approvalsRejected += row.approvalsRejected
    entry.approvalsOther += row.approvalsOther
    for (const [type, n] of Object.entries((row.execByTrigger ?? {}) as Record<string, number>)) {
      entry.execByTrigger[type] = (entry.execByTrigger[type] ?? 0) + n
    }
    byWeek.set(key, entry)
  }

  // Cohort sizes come from agentsCreated, so agents that never ran once stay in
  // the denominator — the case the curve exists to catch.
  const cohortSizes = new Map<string, number>()
  for (const row of rows) {
    const key = weekKey(row.weekStart)
    cohortSizes.set(key, (cohortSizes.get(key) ?? 0) + row.agentsCreated)
  }

  const cohortRows = await systemPrisma.agentCohortWeek.findMany({
    where: { cohortWeek: { gte: since } },
    select: { agentTaskId: true, cohortWeek: true, activeWeek: true },
  })

  const survival = buildSurvival(
    cohortSizes,
    cohortRows.map((row) => ({
      agentTaskId: row.agentTaskId,
      cohortWeek: weekKey(row.cohortWeek),
      activeWeek: weekKey(row.activeWeek),
    })),
    MAX_OFFSET,
  )

  // Per-workspace view of the most recent complete week that has data.
  const latestKey = [...byWeek.keys()].sort().pop() ?? null
  const latestRows = latestKey ? rows.filter((row) => weekKey(row.weekStart) === latestKey) : []

  const organizations = await systemPrisma.organization.findMany({
    where: { id: { in: latestRows.map((row) => row.organizationId) } },
    select: { id: true, name: true },
  })
  const nameById = new Map(organizations.map((org) => [org.id, org.name]))

  const byOrg = latestRows
    .map((row) => ({
      organizationId: row.organizationId,
      name: nameById.get(row.organizationId) ?? 'unknown',
      execTotal: row.execTotal,
      automationRatio: automationRatio(row.execTotal, row.execManual),
      acceptanceRate: acceptanceRate(row.approvalsApproved, row.approvalsRejected),
      engagedUsers: row.engagedUsers,
      depthBucket: depthBucket(row.engagedUsers),
    }))
    .sort((a, b) => b.execTotal - a.execTotal)
    .slice(0, 50)

  const depthDistribution = ['0', '1', '2-4', '5-9', '10+'].map((bucket) => ({
    bucket,
    organizations: latestRows.filter((row) => depthBucket(row.engagedUsers) === bucket).length,
  }))

  return {
    success: true,
    latestWeek: latestKey,
    weeks: [...byWeek.values()]
      .sort((a, b) => a.weekStart.localeCompare(b.weekStart))
      .map((entry) => ({
        ...entry,
        automationRatio: automationRatio(entry.execTotal, entry.execManual),
        acceptanceRate: acceptanceRate(entry.approvalsApproved, entry.approvalsRejected),
      })),
    survival,
    depthDistribution,
    byOrg,
  }
}, { permission: 'platform.administer', internalOnly: true })
```

- [ ] **Step 4: Declare the route internal-only**

In `src/app/api/__tests__/edition-gates.test.ts`, add to `INTERNAL_ONLY_ROUTES` after the `'admin/models/bench',` entry:

```ts
  // Cross-workspace adoption rollups — the same cross-tenant read as costs,
  // aggregating every workspace's agent usage into one operator view.
  'admin/adoption',
```

- [ ] **Step 5: Run the tests**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json TEST_DATABASE_URL=$TEST_DATABASE_URL npx tsx --test src/app/api/admin/__tests__/adoption-route.db.test.ts src/app/api/__tests__/edition-gates.test.ts src/app/api/__tests__/permission-coverage.test.ts`
Expected: PASS. A failure in `edition-gates` naming `admin/adoption` means Step 4 was missed.

- [ ] **Step 6: Typecheck and commit**

Run: `npm run typecheck`
Expected: clean.

```bash
git add src/app/api/admin/adoption src/app/api/admin/__tests__/adoption-route.db.test.ts src/app/api/__tests__/edition-gates.test.ts
git commit -m "feat(adoption): internal-only cross-workspace read route

Reads the rollups rather than raw executions, since retention prunes
AgentExecution at 90 days and the longer-horizon questions only exist in
the aggregates.

Cohort denominators come from agentsCreated, so an agent created and
never run stays in the curve at 0% instead of vanishing from it.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: The page

**Files:**
- Create: `src/app/admin/adoption/page.tsx`
- Modify: `src/app/admin/users/page.tsx` or the shared admin tab strip — add an "Adoption" tab alongside People / Models / Costs (locate the existing tab component first with `grep -rn "admin/costs" src/app/admin src/components`)

**Interfaces:**
- Consumes: `GET /api/admin/adoption` returning the shape produced by Task 4
- Produces: nothing consumed by later tasks

- [ ] **Step 1: Load the dataviz skill**

This task writes charts. Invoke the `dataviz` skill **before** writing any chart code or choosing any colours — it defines the palette, the form heuristic, and the accessibility rules this codebase's charts follow.

- [ ] **Step 2: Locate the admin tab strip**

Run: `grep -rn "admin/costs" src/app/admin src/components --include="*.tsx"`
Expected: the shared nav/tab component used by the existing admin pages. Add an `Adoption` entry pointing at `/admin/adoption` in the same shape as the existing entries. Do not create a new sidebar item — `/admin` already has one, gated on `platform.administer`.

- [ ] **Step 3: Write the page scaffold and the survival matrix logic**

Create `src/app/admin/adoption/page.tsx` as a client component following `src/app/admin/costs/page.tsx`. Everything below is fixed; only the **palette and mark styling** come from the dataviz skill loaded in Step 1.

```tsx
'use client'

import { useEffect, useState } from 'react'

type Week = {
  weekStart: string
  agentsCreated: number
  agentsDeleted: number
  execTotal: number
  execManual: number
  execByTrigger: Record<string, number>
  engagedUsers: number
  approvalsApproved: number
  approvalsRejected: number
  approvalsOther: number
  automationRatio: number | null
  acceptanceRate: number | null
}

type SurvivalRow = {
  cohortWeek: string
  size: number
  cells: { offset: number; active: number; rate: number }[]
}

type Report = {
  latestWeek: string | null
  weeks: Week[]
  survival: SurvivalRow[]
  depthDistribution: { bucket: string; organizations: number }[]
  byOrg: {
    organizationId: string
    name: string
    execTotal: number
    automationRatio: number | null
    acceptanceRate: number | null
    engagedUsers: number
    depthBucket: string
  }[]
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000

/** null renders as an em dash, never as 0% — they mean opposite things. */
const pct = (value: number | null) => (value === null ? '—' : `${Math.round(value * 100)}%`)

/**
 * Has the week at `offset` after this cohort actually happened yet?
 *
 * A cohort created three weeks ago has no week-12 cell. Rendering that as 0%
 * would report total abandonment for an agent population that simply has not
 * had twelve weeks to live yet — the most misreadable cell on the page.
 */
function hasElapsed(cohortWeek: string, offset: number, latestWeek: string | null): boolean {
  if (!latestWeek) return false
  const cell = new Date(Date.parse(`${cohortWeek}T00:00:00Z`) + offset * WEEK_MS)
  return cell.toISOString().slice(0, 10) <= latestWeek
}

export default function AdoptionPage() {
  const [report, setReport] = useState<Report | null>(null)
  const [weeks, setWeeks] = useState(26)

  useEffect(() => {
    void (async () => {
      const response = await fetch(`/api/admin/adoption?weeks=${weeks}`, { cache: 'no-store' })
      if (response.ok) setReport(await response.json())
    })()
  }, [weeks])

  const maxOffset = 12

  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-baseline justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Adoption</h1>
          {/* A stalled rollup job must be visible here rather than silently
              serving last month's numbers as if they were current. */}
          <p className="text-sm text-graphite-500">
            {report?.latestWeek
              ? `Complete weeks through ${report.latestWeek}. The in-progress week is excluded.`
              : 'No rollups yet — run /api/cron/adoption-rollup.'}
          </p>
        </div>
        <select
          value={weeks}
          onChange={(event) => setWeeks(Number(event.target.value))}
          className="rounded border px-2 py-1 text-sm"
        >
          <option value={13}>13 weeks</option>
          <option value={26}>26 weeks</option>
          <option value={52}>52 weeks</option>
        </select>
      </header>

      <section className="space-y-2">
        <h2 className="text-lg font-medium">Agent survival by cohort</h2>
        <p className="text-sm text-graphite-500">
          Share of agents created in a week that were still running N weeks later.
          Agents created and never run stay in the denominator — that is the case
          this table exists to catch.
        </p>
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm tabular-nums">
            <thead>
              <tr>
                <th className="px-2 py-1 text-left">Cohort</th>
                <th className="px-2 py-1 text-right">Agents</th>
                {Array.from({ length: maxOffset + 1 }, (_, offset) => (
                  <th key={offset} className="px-2 py-1 text-right">W+{offset}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(report?.survival ?? []).map((row) => (
                <tr key={row.cohortWeek}>
                  <td className="px-2 py-1">{row.cohortWeek}</td>
                  <td className="px-2 py-1 text-right">{row.size}</td>
                  {row.cells.map((cell) => (
                    <td
                      key={cell.offset}
                      className="px-2 py-1 text-right"
                      /* Shading by cell.rate — take the scale from the dataviz skill. */
                    >
                      {hasElapsed(row.cohortWeek, cell.offset, report?.latestWeek ?? null)
                        ? pct(row.size > 0 ? cell.rate : null)
                        : '—'}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Charts below — build with the dataviz skill's palette and mark specs. */}
    </div>
  )
}
```

- [ ] **Step 4: Add the three charts**

Using the dataviz skill's palette and mark guidance, add to the page:

1. **Automation ratio over time** — a line over `report.weeks[].automationRatio`. A `null` week **breaks the line**; it must not plot as zero, and it must not be interpolated across.
2. **Engaged-user depth** — a bar over `report.depthDistribution` for the latest complete week.
3. **Acceptance** — approved / rejected / other over `report.weeks[]`.

Place this note directly adjacent to the depth chart. It is a spec requirement, not decoration:

```tsx
<p className="text-sm text-graphite-500">
  Low engaged-user depth alongside a high automation ratio is the target state,
  not decay: it means the work runs without anyone having to ask. Read the two
  charts together — depth falling while automation rises is success.
</p>
```

- [ ] **Step 5: Add the per-workspace table**

Render `report.byOrg` as a table — name, runs, automation ratio, acceptance rate, engaged users, depth bucket — sorted as the route returns it (runs descending, capped at 50). Note the cap in the caption so a truncated list never reads as the complete set.

- [ ] **Step 6: Verify the page builds and lints**

Run: `npm run typecheck && npm run lint`
Expected: clean, no new warnings. `jsx-a11y` is enforced in lint — the table needs a caption or `aria-label`, and the select needs a label.

- [ ] **Step 7: Commit**

```bash
git add src/app/admin/adoption
git commit -m "feat(adoption): operator adoption dashboard

Survival matrix, automation ratio, engaged-user depth and acceptance,
reading the rollups.

The depth chart carries an explicit reading note: low depth with high
automation is the target state, and without saying so the two healthiest
signals in the product get read as the two worst.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Backfill and full gate

**Files:** none created; this is verification and the one-time backfill.

- [ ] **Step 1: Run the full gate**

Run: `npm run typecheck && npm run lint && npm test`
Expected: tsc clean, 0 lint errors (pre-existing warnings only), 0 test failures.

- [ ] **Step 2: Run the CI-mode DB suite**

Run the suite with `TEST_DATABASE_URL` pointed at the local `ci_repro` Postgres, per `docs/runbooks`. The local gate skips DB-backed tests; CI does not, and this workstream adds three DB suites.
Expected: 0 failures.

- [ ] **Step 3: Backfill after deploy**

Once deployed, run the backfill once against production:

```bash
curl -sS -H "Authorization: Bearer $CRON_SECRET" \
  "https://<prod-host>/api/cron/adoption-rollup?weeks=14"
```

Expected: `{"success":true,"weeks":[...14 keys...],"organizations":N}`.

14 weeks is deliberate: `RETENTION_DAYS` is 90 (≈12.8 weeks), so anything older has no execution rows left to roll up and would write zeros that look like real inactivity. Do not raise this number to "get more history" — the history is gone.

- [ ] **Step 4: Record in the ledger**

Append the outcome to `.superpowers/sdd/progress.md`, including the final gate line and the backfill result.

- [ ] **Step 5: Commit any ledger change**

```bash
git add .superpowers/sdd/progress.md
git commit -m "docs(adoption): ledger entry for the adoption analytics workstream

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Notes for the executor

- **No Fly worker redeploy is needed.** This adds no queue jobs and no worker-runtime change.
- **The survival curve is not useful immediately.** The backfill gives ~13 weeks of history, but offsets past that are structurally empty until real time passes. The first genuinely informative read on the north-star metric is roughly a month out. Do not "fix" empty far-offset cells — they are honest.
- **If `$queryRaw` with `${demoIds}::uuid[]` errors** on an empty array in the local Postgres version, the fallback is `AND (${demoIds.length} = 0 OR e."organizationId" <> ALL(${demoIds}::uuid[]))`. Verify against the real database rather than assuming.
