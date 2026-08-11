# Flows Reliability Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make scheduled flows fire on time in the background, make their writes replay-safe, make retries distinguish what they are retrying, and make repeated failures produce a proposal instead of silence.

**Architecture:** The dispatch tick becomes a library function (`runDispatchTick`) called by both the Vercel cron and the BullMQ worker behind a Redis lock — one due-check implementation, 60s granularity, either plane surviving alone. A `FlowSideEffect` ledger keyed on `(scopeKey, iterationKey, page)` makes tool writes on every plane replay-safe, and `FlowRun.scheduledFor` + a unique index lets the database — not a racy read-then-act guard — reject a duplicate occurrence. Retry gains error classification, exponential backoff with jitter, and `Retry-After`. A pure pattern detector over `FlowRunStep.warnings` and step errors feeds the existing `process_improvement` proposal surface.

**Tech Stack:** Next.js App Router, Prisma/Postgres, BullMQ + ioredis (Upstash), `node:test` via `tsx` (NOT vitest — the older flow-gap-closure plan says vitest and is stale).

Spec: `docs/superpowers/specs/2026-08-11-flows-reliability-hardening-design.md`

## Global Constraints

- Order: WS1 → WS2 → WS3 → WS4. Commit per task; push per workstream.
- Gate per task: `npx tsc --noEmit` clean, `npx eslint <touched files>` 0 errors, `npm test` green. DB-backed tests (`*.db.test.ts`) run only under `TEST_DATABASE_URL` — reproduce on a fresh `ci_repro` Postgres before pushing any workstream that adds one.
- Test runner is `node:test` via `tsx`: `import { test } from 'node:test'` + `import assert from 'node:assert/strict'`. Run a single file with `npx tsx --test --test-name-pattern '<name>' src/path/to/file.test.ts` (set `TSX_TSCONFIG_PATH=tsconfig.test.json`).
- **tsx file-size cliff:** a single test FILE crossing ~45KB hangs `tsx`+node22 forever at module load. Put new tests in NEW files; never grow `src/lib/flows/__tests__/validate.test.ts` (43.3KB).
- Migrations via `npx prisma migrate dev --create-only` + reviewed SQL; deploy path is `prisma migrate deploy` (baselined). Migration dir format `YYYYMMDDHHMMSS_snake_name`.
- Two migrations total. `AgentExecution` needs NONE — it already carries `@@unique([organizationId, idempotencyKey])` (schema.prisma:547) and the P2002-catch idiom exists at `src/app/api/agents/[id]/trigger/route.ts:99`. This supersedes the spec's third migration.
- Every new unique index is over a nullable column, so existing rows (all null) are exempt in Postgres. No backfill; no deploy-time violation possible.
- No new cadences in `src/lib/scheduling/cadence.ts`. No raw cron or `{{ }}` in any UI copy.
- `EXECUTION_MODE=inline` (dev/CI) behavior must not change anywhere in this plan. Every Redis-touching addition is a pass-through no-op when `inlineExecution` is true.
- The worker must be `fly deploy`ed after WS1 and WS2 — both change worker-resident runtime behavior.
- Customer-edition fork: no new operator-only surfaces here. Everything is engine-internal or lands in the existing proposal UI.

---

## Workstream 1 — One dispatch tick, two callers

Addresses spec A1–A5.

### Task 1.1: `withTickLock`

**Files:**
- Create: `src/lib/queue/tick-lock.ts`
- Test: `src/lib/queue/__tests__/tick-lock.test.ts`

**Interfaces:**
- Consumes: `getRedisConnection` from `@/lib/queue/config`, `inlineExecution` from `@/lib/queue/execution-mode`.
- Produces: `withTickLock<T>(fn: () => Promise<T>): Promise<T | { skipped: 'locked' }>`, `TICK_LOCK_KEY`, `TICK_LOCK_TTL_MS`, and the pure helper `releaseScript` used by tests.

- [ ] **Step 1: Write the failing test**

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runWithLock, TICK_LOCK_TTL_MS } from '../tick-lock'

/** Minimal fake of the two ioredis calls the lock uses. */
function fakeRedis() {
  const store = new Map<string, string>()
  return {
    store,
    async set(key: string, value: string, _px: 'PX', _ttl: number, _nx: 'NX') {
      if (store.has(key)) return null
      store.set(key, value)
      return 'OK'
    },
    async eval(_script: string, _numKeys: number, key: string, token: string) {
      if (store.get(key) === token) {
        store.delete(key)
        return 1
      }
      return 0
    },
  }
}

test('a second concurrent caller is refused while the first holds the lock', async () => {
  const redis = fakeRedis()
  let inner = 0
  let release: (() => void) | null = null
  const held = new Promise<void>((resolve) => {
    release = resolve
  })

  const first = runWithLock(redis as never, 'tok-1', async () => {
    inner += 1
    await held
    return 'first'
  })
  const second = await runWithLock(redis as never, 'tok-2', async () => {
    inner += 1
    return 'second'
  })

  assert.deepEqual(second, { skipped: 'locked' })
  assert.equal(inner, 1)
  release!()
  assert.equal(await first, 'first')
})

test('the lock is released after the body runs, so the next caller acquires it', async () => {
  const redis = fakeRedis()
  assert.equal(await runWithLock(redis as never, 'tok-1', async () => 'a'), 'a')
  assert.equal(redis.store.size, 0)
  assert.equal(await runWithLock(redis as never, 'tok-2', async () => 'b'), 'b')
})

test('a body that throws still releases the lock', async () => {
  const redis = fakeRedis()
  await assert.rejects(runWithLock(redis as never, 'tok-1', async () => { throw new Error('boom') }))
  assert.equal(redis.store.size, 0)
})

test('a token that no longer matches does not delete a successor lock', async () => {
  const redis = fakeRedis()
  // Simulate: our tick overran its TTL, the key expired, a successor took it.
  const slow = runWithLock(redis as never, 'tok-1', async () => {
    redis.store.set('dispatch:tick:lock', 'tok-successor')
    return 'slow'
  })
  assert.equal(await slow, 'slow')
  assert.equal(redis.store.get('dispatch:tick:lock'), 'tok-successor')
})

test('the TTL exceeds the 60s worker interval so an overrunning tick blocks its successor', () => {
  assert.ok(TICK_LOCK_TTL_MS > 60_000)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/queue/__tests__/tick-lock.test.ts`
Expected: FAIL — `Cannot find module '../tick-lock'`.

- [ ] **Step 3: Write the implementation**

```ts
import type IORedis from 'ioredis'
import { getRedisConnection } from '@/lib/queue/config'
import { inlineExecution } from '@/lib/queue/execution-mode'

/**
 * Mutual exclusion for the dispatch tick, which now has two callers: the
 * Vercel cron and the BullMQ worker's 60s timer (see dispatch-tick.ts). Without
 * it the two planes would both scan and both dispatch, and the overlap guard
 * they share is a read-then-act check that cannot stop a true race.
 *
 * TTL exceeds the worker interval on purpose: a tick that overruns 60s BLOCKS
 * its successor rather than overlapping it. Release is a compare-and-delete, so
 * a tick that outlived its TTL can never delete the lock a successor now holds.
 */

export const TICK_LOCK_KEY = 'dispatch:tick:lock'
/** 120s: two worker intervals. A tick slower than this yields to its successor. */
export const TICK_LOCK_TTL_MS = 120_000

/** Compare-and-delete: only the holder releases. */
const RELEASE_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end`

type LockRedis = Pick<IORedis, 'set' | 'eval'>

/** Testable core: the lock protocol against an injected client. */
export async function runWithLock<T>(
  redis: LockRedis,
  token: string,
  fn: () => Promise<T>,
): Promise<T | { skipped: 'locked' }> {
  const acquired = await redis.set(TICK_LOCK_KEY, token, 'PX', TICK_LOCK_TTL_MS, 'NX')
  if (acquired !== 'OK') return { skipped: 'locked' }
  try {
    return await fn()
  } finally {
    // Best effort: a failed release just means the lock ages out on its TTL.
    await (redis.eval as (s: string, n: number, k: string, a: string) => Promise<unknown>)(
      RELEASE_SCRIPT,
      1,
      TICK_LOCK_KEY,
      token,
    ).catch(() => undefined)
  }
}

/**
 * Production entry point. In inline mode (dev/CI) there is no Redis and only
 * one caller exists, so this is a pass-through — behavior there is unchanged.
 */
export async function withTickLock<T>(fn: () => Promise<T>): Promise<T | { skipped: 'locked' }> {
  if (inlineExecution) return fn()
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  return runWithLock(getRedisConnection() as LockRedis, token, fn)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/queue/__tests__/tick-lock.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/queue/tick-lock.ts src/lib/queue/__tests__/tick-lock.test.ts
git commit -m "feat(queue): compare-and-delete Redis lock for the dispatch tick"
```

---

### Task 1.2: Tick liveness key + `/api/health` reporting

**Files:**
- Create: `src/lib/queue/tick-liveness.ts`
- Modify: `src/lib/queue/consumer-probe.ts` (add `tick` to the probe report, next to `heartbeat`)
- Modify: `src/app/api/health/route.ts:70-76` (spread `tick` alongside `heartbeat`)
- Test: `src/lib/queue/__tests__/tick-liveness.test.ts`

**Interfaces:**
- Produces: `TICK_LIVENESS_KEY`, `TICK_STALE_MS`, `writeTickLiveness(summary, now?)`, `readTickLiveness()`, and the pure `tickAge(raw, now)` / `isTickFresh(raw, now, staleMs?)`.

This mirrors `src/lib/queue/heartbeat.ts` exactly — same pure-verdict-plus-IO split, same "logged, never fatal" write policy.

- [ ] **Step 1: Write the failing test**

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isTickFresh, tickAge, TICK_STALE_MS } from '../tick-liveness'

test('a tick written just now is fresh', () => {
  const now = Date.now()
  assert.equal(isTickFresh(JSON.stringify({ at: now }), now), true)
})

test('a tick older than the stale window is not fresh', () => {
  const now = Date.now()
  assert.equal(isTickFresh(JSON.stringify({ at: now - TICK_STALE_MS - 1 }), now), false)
})

test('a missing or unparseable value is not fresh', () => {
  const now = Date.now()
  assert.equal(isTickFresh(null, now), false)
  assert.equal(isTickFresh('not json', now), false)
  assert.equal(isTickFresh(JSON.stringify({ at: 'nope' }), now), false)
})

test('clock skew into the future counts as fresh, matching the heartbeat rule', () => {
  const now = Date.now()
  assert.equal(isTickFresh(JSON.stringify({ at: now + 5_000 }), now), true)
})

test('tickAge reports milliseconds since the write, or null when unreadable', () => {
  const now = Date.now()
  assert.equal(tickAge(JSON.stringify({ at: now - 1_000 }), now), 1_000)
  assert.equal(tickAge(null, now), null)
})

test('the stale window covers several missed cron ticks, not just worker ones', () => {
  // The Vercel cron runs every 15 minutes; a stale verdict must not fire merely
  // because the worker plane is absent and only the cron is driving.
  assert.ok(TICK_STALE_MS >= 45 * 60_000)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/queue/__tests__/tick-liveness.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
import { getRedisConnection } from '@/lib/queue/config'
import { inlineExecution } from '@/lib/queue/execution-mode'

/**
 * Dispatch-tick liveness. /api/health already reports worker heartbeat
 * freshness, but nothing recorded that the SCHEDULING tick ran — so a Vercel
 * cron that was paused, deleted, or plan-limited stopped every scheduled flow
 * with no signal at all. This is that signal.
 *
 * Distinct from worker:heartbeat: the worker can be perfectly healthy while
 * nothing is dispatching, and (before WS1) the cron could be dispatching with
 * no worker at all.
 */

export const TICK_LIVENESS_KEY = 'dispatch:tick:last'
/**
 * How old the last tick may be before health reports it stale. The worker
 * drives every 60s and the cron every 15 min; three missed CRON ticks (45 min)
 * means both planes are down, which is the condition worth alerting on. A
 * shorter window would fire during a routine worker redeploy.
 */
export const TICK_STALE_MS = 45 * 60_000

type TickRecord = { at: number; summary?: unknown }

function parse(raw: string | null): TickRecord | null {
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as TickRecord
    return typeof value?.at === 'number' && Number.isFinite(value.at) ? value : null
  } catch {
    return null
  }
}

/** Pure: milliseconds since the last recorded tick, or null when unreadable. */
export function tickAge(raw: string | null, now: number): number | null {
  const record = parse(raw)
  return record ? now - record.at : null
}

/** Pure staleness verdict. Future timestamps (clock skew) count as fresh. */
export function isTickFresh(raw: string | null, now: number, staleMs: number = TICK_STALE_MS): boolean {
  const age = tickAge(raw, now)
  return age !== null && age <= staleMs
}

/** Record a completed tick. Best effort — a Redis failure never fails a tick. */
export async function writeTickLiveness(summary: unknown, now: number = Date.now()): Promise<void> {
  if (inlineExecution) return
  await getRedisConnection()
    .set(TICK_LIVENESS_KEY, JSON.stringify({ at: now, summary }), 'PX', TICK_STALE_MS * 10)
    .catch(() => undefined)
}

/** Read the raw record, bounded so a hung Redis cannot hang the health probe. */
export async function readTickLiveness(timeoutMs = 3_000): Promise<string | null> {
  if (inlineExecution) return null
  return Promise.race([
    getRedisConnection().get(TICK_LIVENESS_KEY),
    new Promise<null>((resolve) => {
      const timer = setTimeout(() => resolve(null), timeoutMs)
      if (typeof timer === 'object') timer.unref?.()
    }),
  ]).catch(() => null)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/queue/__tests__/tick-liveness.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Wire into the probe and health route**

In `src/lib/queue/consumer-probe.ts`, wherever the probe builds the object that carries `heartbeat`, add a sibling `tick`:

```ts
const tickRaw = await readTickLiveness()
const tick = { ageMs: tickAge(tickRaw, Date.now()), fresh: isTickFresh(tickRaw, Date.now()) }
```

In `src/app/api/health/route.ts`, inside the `queueConsumers` block at lines 70-76, add one spread next to the existing `heartbeat` spread:

```ts
...('tick' in queueConsumers && queueConsumers.tick ? { tick: queueConsumers.tick } : {}),
```

Do NOT fold `tick.fresh` into the top-level `healthy` boolean in this task. A stale tick with a healthy worker is a real alert but not a reason to fail the container health check that Fly uses to recycle machines. It is reported for uptime monitors to alert on.

- [ ] **Step 6: Verify**

Run: `npx tsc --noEmit && npx eslint src/lib/queue/tick-liveness.ts src/lib/queue/consumer-probe.ts src/app/api/health/route.ts`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add src/lib/queue/tick-liveness.ts src/lib/queue/__tests__/tick-liveness.test.ts src/lib/queue/consumer-probe.ts src/app/api/health/route.ts
git commit -m "feat(health): report dispatch-tick liveness so a dead cron is visible"
```

---

### Task 1.3: Extract `runDispatchTick`

**Files:**
- Create: `src/lib/scheduling/dispatch-tick.ts`
- Modify: `src/app/api/cron/dispatch/route.ts` (reduce to auth + delegate)

**Interfaces:**
- Consumes: `withTickLock` (1.1), `writeTickLiveness` (1.2).
- Produces: `runDispatchTick(now?: Date): Promise<DispatchTickSummary>` where

```ts
export type DispatchTickSummary = {
  success: true
  due: number
  ran: string[]
  ranFlows: string[]
  resumedWaits: string[]
  generatedOrgs: string[]
  outbox: { delivered: number; retried: number; failed: number }
  reapedApprovals: number
  mcpHealth: { checked: number; unhealthy: number; changed: number }
} | { skipped: 'locked' }
```

This is a **pure move**, not a rewrite. Behavior changes land in Tasks 1.4 and 1.5.

- [ ] **Step 1: Move the handler body**

Copy everything inside the `try` of `GET` in `src/app/api/cron/dispatch/route.ts` (lines 96-488) into `runDispatchTick`. Move the module-level constants and helpers with it: `FlowTrigger`, `MAX_AGENTS_PER_TICK`, `MAX_FLOWS_PER_TICK`, `STUCK_RUN_TIMEOUT_MS`, `MAX_ERROR_LENGTH`, `capError`, and every import except `timingSafeEqual`. Return the summary object instead of `Response.json(...)`.

Wrap the body in the lock and stamp liveness on completion:

```ts
export async function runDispatchTick(now: Date = new Date()): Promise<DispatchTickSummary> {
  const result = await withTickLock(async () => {
    // ... the moved body, ending with:
    return { success: true as const, due: dueCount, ran: ranIds, ranFlows: ranFlowIds, resumedWaits: resumedWaitIds, generatedOrgs, outbox, reapedApprovals, mcpHealth }
  })
  if (!('skipped' in result)) await writeTickLiveness(result, Date.now())
  return result
}
```

- [ ] **Step 2: Reduce the route to auth + delegate**

`src/app/api/cron/dispatch/route.ts` keeps its file-header comment, `checkAuthorized`, the three route exports (`runtime`, `maxDuration`, `dynamic`), and:

```ts
export async function GET(request: Request) {
  const unauthorized = checkAuthorized(request)
  if (unauthorized) return unauthorized
  try {
    return Response.json(await runDispatchTick())
  } catch (error) {
    apiLogger.error('cron/dispatch: unhandled error', {
      error: error instanceof Error ? error.message : String(error),
    })
    return Response.json({ success: false, error: 'Internal server error' }, { status: 500 })
  }
}
```

Add one line to the file-header comment noting the body now lives in `src/lib/scheduling/dispatch-tick.ts` and is shared with the worker.

- [ ] **Step 3: Verify nothing changed**

Run: `npx tsc --noEmit && npm test`
Expected: clean; the whole suite green with the same counts as before this task. Any existing test that imports from the route must be updated to import from `dispatch-tick` — grep first:

```bash
grep -rn "api/cron/dispatch" --include="*.ts" src | grep -i test
```

- [ ] **Step 4: Commit**

```bash
git add src/lib/scheduling/dispatch-tick.ts src/app/api/cron/dispatch/route.ts
git commit -m "refactor(scheduling): extract runDispatchTick so the worker can drive it too"
```

---

### Task 1.4: Guard the unguarded per-phase prep

**Files:**
- Modify: `src/lib/scheduling/dispatch-tick.ts` (the agent capacity/owner prep, moved from route.ts:209-210; the flow equivalent, moved from 390-391)
- Test: `src/lib/scheduling/__tests__/dispatch-phase-isolation.test.ts`

The bug: `OrgCapacity.forOrgs` and `resolveRunOwners` sit outside every try/catch. A throw in either escapes to the outer catch and kills flow dispatch, wait resumes, and the template sweep for the whole tick.

- [ ] **Step 1: Write the failing test**

The prep calls are not injectable today, so this task also introduces a seam. Give `runDispatchTick` an options bag used only by tests:

```ts
export type DispatchTickDeps = {
  forOrgs?: typeof OrgCapacity.forOrgs
  resolveRunOwners?: typeof resolveRunOwners
}
export async function runDispatchTick(now?: Date, deps: DispatchTickDeps = {}): Promise<DispatchTickSummary>
```

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { preparePhase } from '../dispatch-tick'

test('a throwing capacity read degrades one phase instead of aborting the tick', async () => {
  const result = await preparePhase('agent', [], {
    forOrgs: async () => { throw new Error('pool exhausted') },
    resolveRunOwners: async () => new Map(),
  })
  assert.equal(result, null)
})

test('a throwing owner resolution degrades the same way', async () => {
  const result = await preparePhase('flow', [], {
    forOrgs: async () => ({ tryClaim: () => true, saturatedOrgs: () => [] }) as never,
    resolveRunOwners: async () => { throw new Error('db down') },
  })
  assert.equal(result, null)
})

test('a healthy prep returns both the capacity and the owner map', async () => {
  const capacity = { tryClaim: () => true, saturatedOrgs: () => [] } as never
  const owners = new Map([['flow-1', 'user-1']])
  const result = await preparePhase('flow', [], {
    forOrgs: async () => capacity,
    resolveRunOwners: async () => owners,
  })
  assert.deepEqual(result, { capacity, owners })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/scheduling/__tests__/dispatch-phase-isolation.test.ts`
Expected: FAIL — `preparePhase` is not exported.

- [ ] **Step 3: Implement `preparePhase` and use it in both phases**

```ts
/**
 * Capacity + owner resolution for one dispatch phase. Both reads sat outside
 * every try/catch, so a Prisma pool exhaustion in the AGENT phase's prep took
 * down flow dispatch, wait resumes, and the template sweep for the whole tick.
 * Returning null degrades exactly one phase.
 */
export async function preparePhase<T extends { id: string; organizationId: string }>(
  phase: 'agent' | 'flow',
  rows: T[],
  deps: DispatchTickDeps = {},
): Promise<{ capacity: OrgCapacity; owners: Map<string, string> } | null> {
  const forOrgs = deps.forOrgs ?? OrgCapacity.forOrgs
  const resolve = deps.resolveRunOwners ?? resolveRunOwners
  try {
    const capacity = await forOrgs([...new Set(rows.map((row) => row.organizationId))])
    const owners = await resolve(rows)
    return { capacity, owners }
  } catch (error) {
    apiLogger.error(`cron/dispatch: ${phase} phase prep failed — phase skipped this tick`, {
      error: capError(error),
    })
    captureError(error, { source: `cron.dispatch.${phase}Prep` })
    return null
  }
}
```

Replace both call sites. When `preparePhase` returns null, skip that phase's dispatch loop entirely and leave its result array empty — every deferred row keeps its stale last-run marker and sorts first next tick.

Note the flow phase passes `dueFlows.map((entry) => entry.flow)`, matching today's `resolveRunOwners` argument.

- [ ] **Step 4: Run test to verify it passes**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/scheduling/__tests__/dispatch-phase-isolation.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/scheduling/dispatch-tick.ts src/lib/scheduling/__tests__/dispatch-phase-isolation.test.ts
git commit -m "fix(scheduling): a failing phase prep no longer aborts the whole dispatch tick"
```

---

### Task 1.5: Stop losing agent occurrences on dispatch failure

**Files:**
- Modify: `src/lib/scheduling/dispatch-tick.ts` (agent loop — the `lastExecutedAt` advance moved from route.ts:225, and the dispatch catch at 279-293)
- Test: `src/lib/scheduling/__tests__/agent-occurrence.db.test.ts`

The bug: `lastExecutedAt` advances before `dispatchAgentExecution`. When that throws because `assertQueueConsumerAlive` fails (worker down), the occurrence is consumed and never retried. Advancing first is still correct for a *run* that fails — otherwise a broken agent re-fires every tick. Only the *handoff* failure needs undoing.

- [ ] **Step 1: Write the failing DB test**

```ts
import { test, before } from 'node:test'
import assert from 'node:assert/strict'

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  let restoreAgentOccurrence: any
  const ids: Record<string, string> = {}

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    ;({ restoreAgentOccurrence } = await import('@/lib/scheduling/dispatch-tick'))
    const stamp = Date.now()
    const org = await prisma.organization.create({ data: { name: 'Occ', slug: `occ-${stamp}` } })
    ids.org = org.id
    const user = await prisma.user.create({
      data: { email: `occ-${stamp}@example.com`, name: 'Occ', organizationId: org.id },
    })
    ids.user = user.id
  })

  test('a dispatch-layer failure restores lastExecutedAt and removes the orphan row', async () => {
    const previous = new Date('2026-08-11T09:00:00.000Z')
    const agent = await prisma.agentTask.create({
      data: {
        organizationId: ids.org, userId: ids.user, agentType: 'research',
        objective: 'test', description: 'test', status: 'ACTIVE',
        schedule: { type: 'hourly', time: '09:00', timezone: 'UTC', isActive: true },
        lastExecutedAt: previous, executionCount: 4,
      },
    })
    // Simulate the tick: advance, create the row, then the handoff throws.
    await prisma.agentTask.update({
      where: { id: agent.id, organizationId: ids.org },
      data: { lastExecutedAt: new Date(), executionCount: { increment: 1 } },
    })
    const execution = await prisma.agentExecution.create({
      data: {
        agentType: 'research', agentTaskId: agent.id, status: 'pending',
        input: { prompt: 'test' }, trigger: { type: 'schedule' },
        userId: ids.user, organizationId: ids.org,
      },
    })

    await restoreAgentOccurrence({
      agentId: agent.id, organizationId: ids.org,
      executionId: execution.id, previousLastExecutedAt: previous, previousExecutionCount: 4,
    })

    const after = await prisma.agentTask.findUnique({ where: { id: agent.id } })
    assert.equal(after.lastExecutedAt.toISOString(), previous.toISOString())
    assert.equal(after.executionCount, 4)
    assert.equal(await prisma.agentExecution.findUnique({ where: { id: execution.id } }), null)
  })

  test('restoring a never-run agent puts lastExecutedAt back to null', async () => {
    const agent = await prisma.agentTask.create({
      data: {
        organizationId: ids.org, userId: ids.user, agentType: 'research',
        objective: 'fresh', description: 'fresh', status: 'ACTIVE',
        schedule: { type: 'hourly', time: '09:00', timezone: 'UTC', isActive: true },
        lastExecutedAt: new Date(), executionCount: 1,
      },
    })
    await restoreAgentOccurrence({
      agentId: agent.id, organizationId: ids.org,
      executionId: null, previousLastExecutedAt: null, previousExecutionCount: 0,
    })
    const after = await prisma.agentTask.findUnique({ where: { id: agent.id } })
    assert.equal(after.lastExecutedAt, null)
    assert.equal(after.executionCount, 0)
  })
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TEST_DATABASE_URL=postgresql://localhost:5432/ci_repro TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/scheduling/__tests__/agent-occurrence.db.test.ts`
Expected: FAIL — `restoreAgentOccurrence` is not exported.

- [ ] **Step 3: Implement and wire it**

```ts
/**
 * Undo a consumed occurrence when the HANDOFF failed — the run never began, so
 * the schedule owes it still. Distinct from a run that failed: that one keeps
 * the advanced marker so a persistently broken agent does not re-fire every
 * tick. Best effort; a failure here just means one skipped occurrence.
 */
export async function restoreAgentOccurrence(params: {
  agentId: string
  organizationId: string
  executionId: string | null
  previousLastExecutedAt: Date | null
  previousExecutionCount: number
}): Promise<void> {
  try {
    await prisma.agentTask.update({
      where: { id: params.agentId, organizationId: params.organizationId },
      data: { lastExecutedAt: params.previousLastExecutedAt, executionCount: params.previousExecutionCount },
    })
    if (params.executionId) {
      await prisma.agentExecution.delete({
        where: { id: params.executionId, organizationId: params.organizationId },
      })
    }
  } catch (error) {
    apiLogger.error('cron/dispatch: could not restore a lost agent occurrence', {
      agentId: params.agentId, error: capError(error),
    })
  }
}
```

In the agent loop, capture `agent.lastExecutedAt` and `agent.executionCount` into locals **before** the advance, then replace the existing dispatch catch (route.ts:279-293) with:

```ts
} catch (error) {
  apiLogger.error('cron/dispatch: agent dispatch failed', {
    agentId: agent.id, executionId: execution.id, error: capError(error),
  })
  // Handoff failure (no live consumer, queue unreachable): the run never
  // started, so give the occurrence back instead of consuming it silently.
  await restoreAgentOccurrence({
    agentId: agent.id,
    organizationId: agent.organizationId,
    executionId: execution.id,
    previousLastExecutedAt,
    previousExecutionCount,
  })
}
```

The `agentExecution.update` to `failed` that lived here is replaced by the delete inside `restoreAgentOccurrence` — a `pending` row that never dispatched is noise, not history, and leaving it would also strand the reaper.

- [ ] **Step 4: Run test to verify it passes**

Run: `TEST_DATABASE_URL=postgresql://localhost:5432/ci_repro TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/scheduling/__tests__/agent-occurrence.db.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/scheduling/dispatch-tick.ts src/lib/scheduling/__tests__/agent-occurrence.db.test.ts
git commit -m "fix(scheduling): a dead worker no longer silently eats an agent's scheduled occurrence"
```

---

### Task 1.6: Drive the tick from the worker

**Files:**
- Modify: `src/lib/workers/runtime.ts:110-127` (add a tick timer beside `heartbeatTimer` / `scheduleTimer` / `outboxTimer`, and clear it in the shutdown path)
- Modify: `fly.worker.toml` (document the new interval in the header comment)

**Interfaces:**
- Consumes: `runDispatchTick` (1.3).

- [ ] **Step 1: Add the timer**

Mirror the existing timers exactly. After the `outboxTimer` block:

```ts
// Dispatch tick: the worker plane now drives scheduling too, at 60s instead of
// the Vercel cron's 15 minutes — which is what makes the every15min/every30min
// cadences honest. Both planes call the SAME function behind a Redis lock
// (tick-lock.ts), so running both is safe and either surviving alone keeps
// schedules firing.
this.dispatchTimer = setInterval(() => {
  runDispatchTick().catch((error) => this.server.log.error(error, 'Dispatch tick failed'))
}, DISPATCH_TICK_INTERVAL_MS)
```

Declare `DISPATCH_TICK_INTERVAL_MS = 60_000` next to the other interval constants, add `private dispatchTimer: ReturnType<typeof setInterval> | null = null` beside the sibling fields, and clear it wherever `scheduleTimer` and `outboxTimer` are cleared.

Do **not** run a tick at boot the way `registerAgentSchedules` does. A fleet rolling three machines would fire three ticks within seconds of each other; the lock makes that safe but pointless. The first interval firing is soon enough.

- [ ] **Step 2: Verify the shutdown path clears it**

Run: `grep -n "scheduleTimer\|outboxTimer\|dispatchTimer" src/lib/workers/runtime.ts`
Expected: `dispatchTimer` appears in exactly the same places as its two siblings — declaration, assignment, and clear.

- [ ] **Step 3: Document the interval in the Fly config**

In `fly.worker.toml`'s header comment, after the heartbeat paragraph, add:

```
# The worker also drives the scheduling tick every 60s (dispatch-tick.ts),
# behind a Redis lock shared with the Vercel cron entry in vercel.json. Both
# planes are safe to run together; either surviving alone keeps schedules
# firing. This is what makes the "every 15 minutes" cadence real — the cron
# alone could only ever deliver 15-minute granularity with 15 minutes of drift.
```

- [ ] **Step 4: Verify**

Run: `npx tsc --noEmit && npx eslint src/lib/workers/runtime.ts && npm test`
Expected: clean, suite green.

- [ ] **Step 5: Commit and push WS1**

```bash
git add src/lib/workers/runtime.ts fly.worker.toml
git commit -m "feat(worker): drive the dispatch tick every 60s so flow schedules are honest"
git push origin main
```

- [ ] **Step 6: Deploy the worker**

Run: `fly deploy --config fly.worker.toml`
Then confirm on `/api/health` that `checks.queueConsumers.tick.ageMs` is under 120s and `fresh` is true.

---

## Workstream 2 — Side-effect ledger and occurrence uniqueness

Addresses spec A6–A9 and part of A14.

### Task 2.1: `dueOccurrence`

**Files:**
- Modify: `src/lib/scheduling/due.ts` (add after `isDue`; reuse its private `zoneParts` / `instantForDate` / `todayInstant` / `matchesCron` / `effectiveLast` / `anchorDate` helpers)
- Test: `src/lib/scheduling/__tests__/due-occurrence.test.ts` (NEW file — `due.test.ts` must not grow toward the tsx cliff)

**Interfaces:**
- Produces: `dueOccurrence(schedule: AgentSchedule, lastExecutedAt: Date | null, now: Date): Date | null`.

Contract: `dueOccurrence(...) !== null` **iff** `isDue(...) === true`, for every input. That equivalence is the property test and it is what makes the unique constraint trustworthy.

- [ ] **Step 1: Write the failing test**

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isDue, dueOccurrence, type AgentSchedule } from '../due'

const base: AgentSchedule = { type: 'daily', time: '09:00', cron: '', timezone: 'UTC', isActive: true }

test('daily returns today\'s scheduled instant in the schedule timezone', () => {
  const now = new Date('2026-08-11T13:00:00.000Z')
  const at = dueOccurrence(base, null, now)
  assert.equal(at?.toISOString(), '2026-08-11T09:00:00.000Z')
})

test('daily is stable across two ticks in the same day — the dedupe property', () => {
  const a = dueOccurrence(base, null, new Date('2026-08-11T09:01:00.000Z'))
  const b = dueOccurrence(base, null, new Date('2026-08-11T09:14:00.000Z'))
  assert.equal(a?.toISOString(), b?.toISOString())
})

test('cron returns the latest matching minute in the window, not the tick time', () => {
  const schedule: AgentSchedule = { ...base, type: 'cron', cron: '0 9 * * *' }
  const at = dueOccurrence(schedule, null, new Date('2026-08-11T13:07:00.000Z'))
  assert.equal(at?.toISOString(), '2026-08-11T09:00:00.000Z')
})

test('every15min cron: two ticks inside one 15-minute slot agree', () => {
  const schedule: AgentSchedule = { ...base, type: 'cron', cron: '*/15 * * * *' }
  const last = new Date('2026-08-11T09:00:00.000Z')
  const a = dueOccurrence(schedule, last, new Date('2026-08-11T09:16:00.000Z'))
  const b = dueOccurrence(schedule, last, new Date('2026-08-11T09:29:00.000Z'))
  assert.equal(a?.toISOString(), '2026-08-11T09:15:00.000Z')
  assert.equal(b?.toISOString(), '2026-08-11T09:15:00.000Z')
})

test('hourly uses the hour-floor of now — documented approximation, stable across ticks', () => {
  const schedule: AgentSchedule = { ...base, type: 'hourly' }
  const last = new Date('2026-08-11T08:00:00.000Z')
  const a = dueOccurrence(schedule, last, new Date('2026-08-11T09:01:00.000Z'))
  const b = dueOccurrence(schedule, last, new Date('2026-08-11T09:59:00.000Z'))
  assert.equal(a?.toISOString(), '2026-08-11T09:00:00.000Z')
  assert.equal(b?.toISOString(), '2026-08-11T09:00:00.000Z')
})

test('once returns the target instant', () => {
  const schedule: AgentSchedule = { ...base, type: 'once', runAt: '2026-08-11', time: '09:00' }
  const at = dueOccurrence(schedule, null, new Date('2026-08-11T10:00:00.000Z'))
  assert.equal(at?.toISOString(), '2026-08-11T09:00:00.000Z')
})

test('manual and inactive schedules never have an occurrence', () => {
  assert.equal(dueOccurrence({ ...base, type: 'manual' }, null, new Date()), null)
  assert.equal(dueOccurrence({ ...base, isActive: false }, null, new Date()), null)
})

test('DST spring-forward: a daily 09:00 America/New_York resolves to one real instant', () => {
  const schedule: AgentSchedule = { ...base, timezone: 'America/New_York' }
  const at = dueOccurrence(schedule, null, new Date('2026-03-08T18:00:00.000Z'))
  assert.equal(at?.toISOString(), '2026-03-08T13:00:00.000Z')
})

test('half-hour zone: Asia/Kolkata daily 09:00 resolves correctly', () => {
  const schedule: AgentSchedule = { ...base, timezone: 'Asia/Kolkata' }
  const at = dueOccurrence(schedule, null, new Date('2026-08-11T12:00:00.000Z'))
  assert.equal(at?.toISOString(), '2026-08-11T03:30:00.000Z')
})

test('PROPERTY: dueOccurrence is non-null exactly when isDue is true', () => {
  const schedules: AgentSchedule[] = [
    { ...base },
    { ...base, type: 'hourly' },
    { ...base, type: 'weekly' },
    { ...base, type: 'cron', cron: '0 9 * * *' },
    { ...base, type: 'cron', cron: '*/15 * * * *' },
    { ...base, type: 'cron', cron: '30 8 * * 1,3,5' },
    { ...base, type: 'once', runAt: '2026-08-11' },
    { ...base, type: 'manual' },
    { ...base, isActive: false },
    { ...base, timezone: 'America/New_York' },
    { ...base, timezone: 'Asia/Kolkata' },
  ]
  const lasts = [null, new Date('2026-08-10T09:00:00.000Z'), new Date('2026-08-11T08:59:00.000Z')]
  const nows = [
    new Date('2026-08-11T08:59:00.000Z'),
    new Date('2026-08-11T09:00:00.000Z'),
    new Date('2026-08-11T09:16:00.000Z'),
    new Date('2026-08-11T23:59:00.000Z'),
    new Date('2026-03-08T13:00:00.000Z'),
  ]
  for (const schedule of schedules) {
    for (const last of lasts) {
      for (const now of nows) {
        const due = isDue(schedule, last, now)
        const at = dueOccurrence(schedule, last, now)
        assert.equal(
          at !== null, due,
          `mismatch: ${JSON.stringify(schedule)} last=${last?.toISOString() ?? 'null'} now=${now.toISOString()} isDue=${due} at=${at?.toISOString() ?? 'null'}`,
        )
      }
    }
  }
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/scheduling/__tests__/due-occurrence.test.ts`
Expected: FAIL — `dueOccurrence` is not exported.

- [ ] **Step 3: Implement**

Append to `src/lib/scheduling/due.ts`:

```ts
/**
 * WHICH occurrence is owed, where `isDue` reports only WHETHER one is. Its
 * value becomes FlowRun.scheduledFor / the agent idempotency key, so two
 * concurrent ticks that both see the same owed occurrence compute the same
 * instant and the unique index rejects the second.
 *
 * CONTRACT: returns non-null exactly when `isDue` returns true for the same
 * inputs. A property test pins that equivalence — if you change one, change
 * both.
 *
 * Pure function — no side effects.
 */
export function dueOccurrence(
  schedule: AgentSchedule,
  lastExecutedAt: Date | null,
  now: Date,
): Date | null {
  if (!isDue(schedule, lastExecutedAt, now)) return null
  const MINUTE_MS = 60_000
  const HOUR_MS = 60 * MINUTE_MS

  switch (schedule.type) {
    case 'once': {
      const [y, mo, d] = (schedule.runAt ?? '').split('-').map(Number)
      return instantForDate(y, mo, d, schedule.time || '09:00', schedule.timezone || 'UTC')
    }

    case 'hourly':
      // Hourly has NO grid: isDue defines it as "60 real minutes since the last
      // run", so there is no true occurrence instant. The hour-floor of `now`
      // is stable across ticks minutes apart, which is all the constraint
      // needs. Documented approximation — see the spec.
      return new Date(Math.floor(now.getTime() / HOUR_MS) * HOUR_MS)

    case 'daily':
    case 'weekly':
      return todayInstant(schedule.time || '00:00', schedule.timezone || 'UTC', now)

    case 'cron': {
      // The LATEST matching minute in the same window isDue scanned, so a tick
      // at 13:07 for "0 9 * * *" reports 09:00 — the occurrence — not 13:07.
      const tz = schedule.timezone || 'UTC'
      const DEFAULT_LOOKBACK_MS = 25 * 60 * 60 * 1000
      const MAX_LOOKBACK_MS = 400 * 24 * 60 * 60 * 1000
      const last = effectiveLast(schedule, lastExecutedAt)
      const sinceMs = last ? last.getTime() : now.getTime() - DEFAULT_LOOKBACK_MS
      const flooredSince = Math.max(sinceMs, now.getTime() - MAX_LOOKBACK_MS)
      let cursor = Math.floor(now.getTime() / MINUTE_MS) * MINUTE_MS
      while (cursor > flooredSince) {
        if (matchesCron(schedule.cron, tz, new Date(cursor))) return new Date(cursor)
        cursor -= MINUTE_MS
      }
      return null
    }

    default:
      return null
  }
}
```

The leading `isDue` call is what guarantees the contract by construction: every non-due input returns null before reaching the switch.

- [ ] **Step 4: Run test to verify it passes**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/scheduling/__tests__/due-occurrence.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/scheduling/due.ts src/lib/scheduling/__tests__/due-occurrence.test.ts
git commit -m "feat(scheduling): dueOccurrence reports which occurrence is owed, not just whether"
```

---

### Task 2.2: `FlowSideEffect` model + migration

**Files:**
- Modify: `prisma/schema.prisma` (new model after `FlowRunStep`; add the back-relation `sideEffects FlowSideEffect[]` to `FlowRun`)
- Create: `prisma/migrations/20260811120000_flow_side_effects/migration.sql`

- [ ] **Step 1: Add the model**

```prisma
/// Ledger of completed flow side effects, so a replayed step returns what the
/// first attempt produced instead of firing the write again. Idempotency
/// HEADERS only ever reached HTTP steps and most providers ignore an
/// unrecognized one — this is what makes tool writes on every plane (Nango,
/// MCP, delivery) replay-safe.
model FlowSideEffect {
  id String @id @default(cuid())
  /// The idempotency SCOPE. Normally the flow run id; for poll-triggered runs
  /// `${flowId}:${dedupeValue}`, so two runs for the same polled item share
  /// keys and the second replays instead of re-firing.
  scopeKey       String
  /// Node id, or `${nodeId}#${index}` inside a per-item/loop step.
  iterationKey   String
  /// Pagination index for paged HTTP steps; 0 for everything else.
  page           Int      @default(0)
  organizationId String   @db.Uuid
  provider       String
  tool           String
  result         Json
  createdAt      DateTime @default(now())

  /// Nullable + SetNull: a poll-scoped row must OUTLIVE the run that wrote it,
  /// or deleting that run would silently drop the dedupe protection. Retention
  /// sweeps these on the ledger's own createdAt — see /api/cron/retention.
  flowRunId String?
  run       FlowRun? @relation(fields: [flowRunId], references: [id], onDelete: SetNull)

  @@unique([scopeKey, iterationKey, page])
  @@index([organizationId, createdAt])
  @@map("flow_side_effects")
}
```

Add to `model FlowRun` beside `steps FlowRunStep[]`:

```prisma
  sideEffects FlowSideEffect[]
```

- [ ] **Step 2: Generate the migration**

Run: `npx prisma migrate dev --create-only --name flow_side_effects`
Then review the emitted SQL: it must be `CREATE TABLE` + `CREATE UNIQUE INDEX` + `CREATE INDEX` + one `ALTER TABLE ... ADD CONSTRAINT ... ON DELETE SET NULL`, and nothing else. Any `DROP` or unrelated `ALTER` means the local schema had drifted — reset and regenerate rather than editing it by hand.

- [ ] **Step 3: Verify it deploys clean**

Run: `TEST_DATABASE_URL=postgresql://localhost:5432/ci_repro npx prisma migrate deploy`
Expected: applied, no error.

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/
git commit -m "feat(db): FlowSideEffect ledger keyed on (scopeKey, iterationKey, page)"
```

---

### Task 2.3: Ledger helpers + scoped `flowSideEffectKey`

**Files:**
- Modify: `src/lib/flows/idempotency.ts` (rename the first parameter to `scopeKey`)
- Create: `src/lib/flows/side-effect-ledger.ts`
- Test: `src/lib/flows/__tests__/side-effect-ledger.test.ts`

**Interfaces:**
- Produces:
  - `flowSideEffectKey(scopeKey: string, iterationKey: string, page?: number): string` (unchanged shape; parameter renamed for clarity — every existing caller passes a run id, so no call site changes)
  - `runScopeKey(run: { id: string; flowId: string; trigger: unknown }): string`
  - `readLedger(params: { scopeKey; iterationKey; page }): Promise<{ result: unknown } | null>`
  - `writeLedger(params: { scopeKey; iterationKey; page; organizationId; provider; tool; result; flowRunId }): Promise<void>`
  - `LEDGER_REPLAY_WARNING: string`

- [ ] **Step 1: Write the failing test**

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runScopeKey, LEDGER_REPLAY_WARNING } from '../side-effect-ledger'
import { flowSideEffectKey } from '../idempotency'

test('a normal run scopes by its own run id', () => {
  const key = runScopeKey({ id: 'run-1', flowId: 'flow-1', trigger: { type: 'schedule' } })
  assert.equal(key, 'run-1')
})

test('a poll run scopes by flow + dedupe value, so a re-emitted item shares keys', () => {
  const a = runScopeKey({ id: 'run-1', flowId: 'flow-1', trigger: { type: 'poll', dedupeValue: 'item-42' } })
  const b = runScopeKey({ id: 'run-2', flowId: 'flow-1', trigger: { type: 'poll', dedupeValue: 'item-42' } })
  assert.equal(a, 'flow-1:item-42')
  assert.equal(a, b)
})

test('a poll run with no dedupe value falls back to the run id rather than colliding', () => {
  const key = runScopeKey({ id: 'run-1', flowId: 'flow-1', trigger: { type: 'poll' } })
  assert.equal(key, 'run-1')
})

test('different polled items never share a scope', () => {
  const a = runScopeKey({ id: 'run-1', flowId: 'flow-1', trigger: { type: 'poll', dedupeValue: 'item-1' } })
  const b = runScopeKey({ id: 'run-2', flowId: 'flow-1', trigger: { type: 'poll', dedupeValue: 'item-2' } })
  assert.notEqual(a, b)
})

test('the header key is derived from the same scope, so ledger and header agree', () => {
  const scope = runScopeKey({ id: 'run-1', flowId: 'flow-1', trigger: { type: 'poll', dedupeValue: 'item-42' } })
  assert.equal(flowSideEffectKey(scope, 'send', 0), flowSideEffectKey('flow-1:item-42', 'send', 0))
})

test('existing run-scoped keys are unchanged — no behavior drift for non-poll runs', () => {
  assert.equal(flowSideEffectKey('run-1', 'send', 0), flowSideEffectKey('run-1', 'send'))
  assert.match(flowSideEffectKey('run-1', 'send'), /^bs_[0-9a-f]{64}$/)
})

test('the replay warning names the fact plainly, with no token syntax', () => {
  assert.match(LEDGER_REPLAY_WARNING, /replay/i)
  assert.ok(!LEDGER_REPLAY_WARNING.includes('{{'))
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/flows/__tests__/side-effect-ledger.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

In `src/lib/flows/idempotency.ts`, rename only the parameter and its doc:

```ts
/**
 * Stable, provider-safe key for one logical flow side effect. `scopeKey` is the
 * idempotency scope — the run id for most runs, `${flowId}:${dedupeValue}` for
 * poll-triggered ones (see side-effect-ledger.ts's runScopeKey).
 */
export function flowSideEffectKey(scopeKey: string, iterationKey: string, page = 0): string {
  const digest = createHash('sha256').update(`${scopeKey} ${iterationKey} ${page}`).digest('hex')
  return `bs_${digest}`
}
```

Create `src/lib/flows/side-effect-ledger.ts`:

```ts
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'

/**
 * Read-before-write / write-after-success around every flow side effect.
 *
 * Why a ledger and not just headers: `withIdempotencyHeader` reached exactly
 * one call site (the HTTP step), and most Nango/MCP providers ignore an
 * unrecognized `idempotency-key` anyway. The ledger is provider-agnostic — it
 * makes a replay a local no-op regardless of what the provider supports.
 */

export const LEDGER_REPLAY_WARNING =
  'This step was replayed from an earlier attempt — the recorded result was reused and the action was not run again.'

type TriggerLike = { type?: unknown; dedupeValue?: unknown }

/**
 * The idempotency scope for a run. Poll-triggered runs scope by the polled
 * ITEM, not the run: the poll dispatcher is deliberately at-least-once
 * (dispatch, then persist the cursor), so a crash between the two re-emits the
 * same item as a fresh run. Sharing the scope makes that second run replay.
 */
export function runScopeKey(run: { id: string; flowId: string; trigger: unknown }): string {
  const trigger = (run.trigger && typeof run.trigger === 'object' ? run.trigger : {}) as TriggerLike
  const dedupeValue = typeof trigger.dedupeValue === 'string' ? trigger.dedupeValue.trim() : ''
  if (trigger.type === 'poll' && dedupeValue) return `${run.flowId}:${dedupeValue}`
  return run.id
}

export type LedgerKey = { scopeKey: string; iterationKey: string; page: number }

/** The recorded result of a completed side effect, or null when it is new. */
export async function readLedger(key: LedgerKey): Promise<{ result: unknown } | null> {
  try {
    const row = await prisma.flowSideEffect.findUnique({
      where: { scopeKey_iterationKey_page: key },
      select: { result: true },
    })
    return row ? { result: row.result } : null
  } catch (error) {
    // A ledger read failure must not fail the step: worst case we re-execute,
    // which is exactly today's behavior.
    apiLogger.warn('side-effect ledger read failed', {
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}

/**
 * Record a completed side effect. A conflict means a concurrent attempt won the
 * race and its result stands — not an error.
 */
export async function writeLedger(params: LedgerKey & {
  organizationId: string
  provider: string
  tool: string
  result: unknown
  flowRunId: string | null
}): Promise<void> {
  try {
    await prisma.flowSideEffect.create({
      data: {
        scopeKey: params.scopeKey,
        iterationKey: params.iterationKey,
        page: params.page,
        organizationId: params.organizationId,
        provider: params.provider,
        tool: params.tool,
        result: (params.result ?? Prisma.JsonNull) as Prisma.InputJsonValue,
        flowRunId: params.flowRunId,
      },
    })
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return
    apiLogger.warn('side-effect ledger write failed', {
      error: error instanceof Error ? error.message : String(error),
    })
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/flows/__tests__/side-effect-ledger.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/flows/idempotency.ts src/lib/flows/side-effect-ledger.ts src/lib/flows/__tests__/side-effect-ledger.test.ts
git commit -m "feat(flows): side-effect ledger helpers and poll-aware idempotency scope"
```

---

### Task 2.4: Wire the ledger into the tool step

**Files:**
- Modify: `src/features/flows/execute-flow.ts:923-967` (the `node.kind === 'tool'` branch, between `resolveFlowToolExecutor` and `runWithRetries`)
- Test: `src/features/flows/__tests__/side-effect-replay.db.test.ts`

- [ ] **Step 1: Write the failing DB test**

Follow the `before()` fixture idiom in `src/features/flows/__tests__/state-overrides.db.test.ts` (org + user + flow, `TEST_DATABASE_URL`-gated).

```ts
test('a second attempt at the same tool step replays instead of calling the executor', async () => {
  const scopeKey = `run-replay-${Date.now()}`
  await writeLedger({
    scopeKey, iterationKey: 'send', page: 0,
    organizationId: ids.org, provider: 'slack', tool: 'slack_post_message',
    result: { ok: true, ts: '1234.5678' }, flowRunId: null,
  })
  const hit = await readLedger({ scopeKey, iterationKey: 'send', page: 0 })
  assert.deepEqual(hit, { result: { ok: true, ts: '1234.5678' } })
})

test('a fresh key is a miss, so the first attempt executes normally', async () => {
  const miss = await readLedger({ scopeKey: `run-fresh-${Date.now()}`, iterationKey: 'send', page: 0 })
  assert.equal(miss, null)
})

test('two concurrent writes on one key both settle and the row survives once', async () => {
  const scopeKey = `run-race-${Date.now()}`
  const write = (result: unknown) => writeLedger({
    scopeKey, iterationKey: 'send', page: 0,
    organizationId: ids.org, provider: 'slack', tool: 'slack_post_message',
    result, flowRunId: null,
  })
  await Promise.all([write({ attempt: 1 }), write({ attempt: 2 })])
  const rows = await prisma.flowSideEffect.findMany({ where: { scopeKey } })
  assert.equal(rows.length, 1)
})

test('per-iteration keys do not collide inside a loop', async () => {
  const scopeKey = `run-loop-${Date.now()}`
  for (const iterationKey of ['send#0', 'send#1', 'send#2']) {
    await writeLedger({
      scopeKey, iterationKey, page: 0,
      organizationId: ids.org, provider: 'slack', tool: 'slack_post_message',
      result: { iterationKey }, flowRunId: null,
    })
  }
  const rows = await prisma.flowSideEffect.findMany({ where: { scopeKey } })
  assert.equal(rows.length, 3)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TEST_DATABASE_URL=postgresql://localhost:5432/ci_repro TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/features/flows/__tests__/side-effect-replay.db.test.ts`
Expected: FAIL until Task 2.2's migration is applied and 2.3's helpers exist; then PASS. If it passes immediately, 2.2 and 2.3 already landed — proceed.

- [ ] **Step 3: Wire the tool branch**

Compute the scope once per run, next to where `run` is available (near the `onStep` definition around line 661):

```ts
const scopeKey = runScopeKey({ id: run.id, flowId: job.flowId, trigger: run.trigger })
```

**Verify first:** `runScopeKey` needs `flowId` and `trigger`. The `run` object at
that point may not `select` both — check what `runFlowExecution` actually holds
and widen the select if needed, or take `flowId` from `job.flowId` as above.
Getting this wrong silently degrades poll runs to run-scoped keys, which is the
current behavior, so it will NOT fail a test — confirm it by reading the object,
not by running the suite.

In the tool branch, replace the bare `runWithRetries(...)` call with a ledger-guarded version. `ledgerKey` uses the SAME `iterationKey` the persistence layer uses (`outcome.iterationKey ?? outcome.nodeId`), so a loop iteration gets its own row:

```ts
const ledgerKey = { scopeKey, iterationKey: stepKey, page: 0 }
const recorded = await readLedger(ledgerKey)
if (recorded) {
  // Replayed, not re-executed. Say so in the run panel rather than pretending
  // the call happened again — the warnings channel already renders this.
  await finish({ status: 'succeeded', output: recorded.result, warnings: [LEDGER_REPLAY_WARNING] })
  return { output: recorded.result }
}

// Unchanged from today — same options object, same timeoutMessage string.
const output = await runWithRetries(
  async () => flowToolOutput(await executor.execute(toolName, args)),
  {
    retries,
    retryDelayMs,
    timeoutMs,
    retryOnTimeout: shouldRetryAfterTimeout('tool'),
    timeoutMessage: timeoutMs
      ? `Tool ${toolName} timed out after ${Math.round(timeoutMs / 1000)}s — the call may still be finishing in the background.`
      : undefined,
  },
)

await writeLedger({
  ...ledgerKey,
  organizationId: job.organizationId,
  provider: executor.provider,
  tool: toolName,
  result: output,
  flowRunId: run.id,
})
```

Three things to confirm while wiring this:

- `stepKey` is the per-iteration key the interpreter already threads (see
  `interpret.ts:485`). If it is not in scope in this branch, derive it the same
  way `onStep` does (`outcome.iterationKey ?? outcome.nodeId`) and pass it down.
  Do **not** fall back to `node.id`: every iteration of a loop would then share
  one ledger row and only the first would ever execute — a silent data-loss bug
  that no existing test would catch.
- `finish()` must accept `warnings`. `StepOutcome.warnings` exists (the
  run-truthfulness work added it), but confirm the local `finish` helper forwards
  it rather than dropping it. If it does not, thread it through — the replay
  would otherwise be invisible in the run panel.
- Keep the existing `recordAudit` call exactly where it is, and do **not** record
  an audit entry on the replay path. No tool call happened; logging one would
  put a fictional write in an immutable audit trail.

- [ ] **Step 4: Verify**

Run: `npx tsc --noEmit && TEST_DATABASE_URL=postgresql://localhost:5432/ci_repro TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/features/flows/__tests__/side-effect-replay.db.test.ts && npm test`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add src/features/flows/execute-flow.ts src/features/flows/__tests__/side-effect-replay.db.test.ts
git commit -m "feat(flows): tool-step writes are replay-safe via the side-effect ledger"
```

---

### Task 2.5: Wire the ledger into the HTTP step

**Files:**
- Modify: `src/features/flows/execute-flow.ts:1200-1215` (the paged HTTP branch that already calls `withIdempotencyHeader`)

- [ ] **Step 1: Apply the same guard, keyed by page**

The HTTP branch already computes a `page` inside its pagination loop. Use it as the ledger `page` so each page of a paginated request is its own side effect.

Inside the loop, before the fetch:

```ts
// Safe methods have no side effect to record or replay — skip the ledger
// entirely, matching withIdempotencyHeader's own SAFE_METHODS rule.
const isSafeMethod = ['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase())
const ledgerKey = { scopeKey, iterationKey: stepKey, page }
const recorded = isSafeMethod ? null : await readLedger(ledgerKey)
if (recorded) {
  // Reuse this page's recorded response and continue the pagination loop
  // exactly as a live response would: feed it to the same pageItems /
  // paginationComplete handling below rather than short-circuiting the step,
  // so a partially-replayed paginated request still assembles a full result.
  pageWarnings.push(LEDGER_REPLAY_WARNING)
  return recorded.result as FlowHttpOutput
}
```

Change the existing header call to take the scope rather than the run id:

```ts
headers: withIdempotencyHeader(headers, method, flowSideEffectKey(scopeKey, node.id, page)),
```

After the fetch, record it:

```ts
if (!isSafeMethod && classifyRetry(null, response.status) !== 'retryable') {
  await writeLedger({
    ...ledgerKey,
    organizationId: job.organizationId,
    provider: 'http',
    tool: node.id,
    result: response,
    flowRunId: run.id,
  })
}
```

The `classifyRetry` guard is what keeps a 503 out of the ledger — a status WS3 will retry must never be recorded as a completed side effect, or the retry would replay the failure forever. **WS3 (Task 3.1) has not landed yet at this point in the plan**, so use `if (!isSafeMethod && response.ok)` here and change it to the `classifyRetry` form in Task 3.2 Step 5, which exists precisely to close this loop. Do not import `classifyRetry` before it is defined.

Collect `pageWarnings` into the step's existing `warnings` array so a replayed page is visible in the run panel, the same way Task 2.4's tool replay is.

- [ ] **Step 2: Verify**

Run: `npx tsc --noEmit && npm test`
Expected: clean, suite green.

- [ ] **Step 3: Commit**

```bash
git add src/features/flows/execute-flow.ts
git commit -m "feat(flows): HTTP steps record to the ledger and key headers by scope"
```

---

### Task 2.6: `FlowRun.scheduledFor` + occurrence uniqueness

**Files:**
- Modify: `prisma/schema.prisma` (`model FlowRun`)
- Create: `prisma/migrations/20260811130000_flow_run_scheduled_for/migration.sql`
- Modify: `src/lib/scheduling/dispatch-tick.ts` (flow dispatch pass 2)
- Modify: `src/features/flows/execute-flow.ts` (thread `scheduledFor` through `FlowExecutionJob` to the run row insert)
- Test: `src/lib/scheduling/__tests__/occurrence-uniqueness.db.test.ts`

- [ ] **Step 1: Add the column**

```prisma
  /// The scheduled occurrence this run belongs to (see dueOccurrence). Null for
  /// interactive, signal, webhook, and poll runs — the unique index below binds
  /// only scheduled dispatch, so two ticks racing on one occurrence produce one
  /// run and the loser gets P2002 instead of a duplicate.
  scheduledFor DateTime?
```

and

```prisma
  @@unique([flowId, scheduledFor])
```

- [ ] **Step 2: Generate and review the migration**

Run: `npx prisma migrate dev --create-only --name flow_run_scheduled_for`
The SQL must be exactly one `ALTER TABLE ... ADD COLUMN "scheduledFor" TIMESTAMP(3)` and one `CREATE UNIQUE INDEX`. Every existing row has NULL, and Postgres treats NULLs as distinct in a unique index, so no existing row can violate it.

- [ ] **Step 3: Stamp it at dispatch**

In the flow dispatch pass, compute the occurrence when building `dueFlowsAll` (it needs the same `schedule` and `lastExecuted` already in scope) and carry it on the `DueFlow` entry:

```ts
const occurrence = isPoll ? null : dueOccurrence(schedule, lastExecuted, now)
dueFlowsAll.push({ flow, trigger, isPoll, lastExecuted, occurrence })
```

Pass it into dispatch and catch the conflict:

```ts
try {
  await dispatchFlowExecution({
    flowId: flow.id,
    organizationId: flow.organizationId,
    userId: ownerId,
    input: parseFlowInput(trigger.input ?? ''),
    usePublished: true,
    trigger: { type: 'schedule' },
    scheduledFor: occurrence,
  })
  ranFlowIds.push(flow.id)
} catch (error) {
  // P2002 means another tick already claimed this occurrence. That is the
  // constraint doing its job, not a failure — do not log it as an error.
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') continue
  apiLogger.error('cron/dispatch: flow dispatch failed, skipping', { /* unchanged */ })
  continue
}
```

Add `scheduledFor?: Date | null` to `FlowExecutionJob` in `execute-flow.ts` and set it on the `flowRun.create` data. Every other caller omits it, so it defaults to null and those runs are exempt from the constraint.

- [ ] **Step 4: Write the DB test**

```ts
test('two dispatches of one occurrence create exactly one run', async () => {
  const scheduledFor = new Date('2026-08-11T09:00:00.000Z')
  const create = () => prisma.flowRun.create({
    data: { flowId: ids.flow, organizationId: ids.org, userId: ids.user, trigger: { type: 'schedule' }, scheduledFor },
  })
  const results = await Promise.allSettled([create(), create()])
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1)
  const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult
  assert.equal(rejected.reason.code, 'P2002')
  const rows = await prisma.flowRun.findMany({ where: { flowId: ids.flow, scheduledFor } })
  assert.equal(rows.length, 1)
})

test('different occurrences of the same flow both create runs', async () => {
  const mk = (iso: string) => prisma.flowRun.create({
    data: { flowId: ids.flow, organizationId: ids.org, userId: ids.user, trigger: { type: 'schedule' }, scheduledFor: new Date(iso) },
  })
  await mk('2026-08-11T10:00:00.000Z')
  await mk('2026-08-11T11:00:00.000Z')
  const rows = await prisma.flowRun.findMany({ where: { flowId: ids.flow, scheduledFor: { not: null } } })
  assert.ok(rows.length >= 2)
})

test('unscheduled runs are exempt — many nulls coexist', async () => {
  for (let i = 0; i < 3; i += 1) {
    await prisma.flowRun.create({
      data: { flowId: ids.flow, organizationId: ids.org, userId: ids.user, trigger: { type: 'manual' } },
    })
  }
  const rows = await prisma.flowRun.findMany({ where: { flowId: ids.flow, scheduledFor: null } })
  assert.ok(rows.length >= 3)
})
```

- [ ] **Step 5: Verify**

Run: `TEST_DATABASE_URL=postgresql://localhost:5432/ci_repro npx prisma migrate deploy && TEST_DATABASE_URL=postgresql://localhost:5432/ci_repro TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/scheduling/__tests__/occurrence-uniqueness.db.test.ts`
Expected: migration applies, 3 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/ src/lib/scheduling/dispatch-tick.ts src/features/flows/execute-flow.ts src/lib/scheduling/__tests__/occurrence-uniqueness.db.test.ts
git commit -m "feat(scheduling): the database rejects a duplicate scheduled flow occurrence"
```

---

### Task 2.7: Agent occurrence uniqueness — no migration

**Files:**
- Modify: `src/lib/scheduling/dispatch-tick.ts` (agent loop, the `agentExecution.create`)
- Test: `src/lib/scheduling/__tests__/occurrence-uniqueness.db.test.ts` (extend Task 2.6's file)

`AgentExecution` already carries `@@unique([organizationId, idempotencyKey])` (schema.prisma:547) and the P2002-catch idiom exists at `src/app/api/agents/[id]/trigger/route.ts:99`. Reuse both.

- [ ] **Step 1: Set the key at dispatch**

Compute the occurrence alongside the existing `isDue` filter, keep it on the due-agent entry, and set:

```ts
// Reuses the existing @@unique([organizationId, idempotencyKey]) — the same
// mechanism signal-triggered runs use (`${signalId}:${agentId}`). No migration.
idempotencyKey: occurrence ? `schedule:${agent.id}:${occurrence.toISOString()}` : undefined,
```

Wrap the `create` so a conflict skips the agent for this tick without consuming its occurrence:

```ts
let execution
try {
  execution = await prisma.agentExecution.create({ data: { /* ... */ } })
} catch (error) {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    // Another tick already claimed this occurrence.
    await restoreAgentOccurrence({
      agentId: agent.id, organizationId: agent.organizationId, executionId: null,
      previousLastExecutedAt, previousExecutionCount,
    })
    continue
  }
  throw error
}
```

The restore matters here: this tick advanced `lastExecutedAt` before creating the row, and the run it advanced for belongs to the tick that won.

- [ ] **Step 2: Add the tests**

```ts
test('two dispatches of one agent occurrence create exactly one execution', async () => {
  const key = `schedule:${ids.agent}:2026-08-11T09:00:00.000Z`
  const create = () => prisma.agentExecution.create({
    data: {
      agentType: 'research', agentTaskId: ids.agent, status: 'pending',
      input: { prompt: 'x' }, trigger: { type: 'schedule' },
      userId: ids.user, organizationId: ids.org, idempotencyKey: key,
    },
  })
  const results = await Promise.allSettled([create(), create()])
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1)
})

test('agent runs without an idempotency key are exempt', async () => {
  for (let i = 0; i < 3; i += 1) {
    await prisma.agentExecution.create({
      data: {
        agentType: 'research', agentTaskId: ids.agent, status: 'pending',
        input: { prompt: 'x' }, trigger: { type: 'manual' },
        userId: ids.user, organizationId: ids.org,
      },
    })
  }
  const rows = await prisma.agentExecution.findMany({
    where: { agentTaskId: ids.agent, idempotencyKey: null },
  })
  assert.ok(rows.length >= 3)
})
```

- [ ] **Step 3: Verify and commit**

Run: `TEST_DATABASE_URL=postgresql://localhost:5432/ci_repro TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/scheduling/__tests__/occurrence-uniqueness.db.test.ts`
Expected: 5 tests PASS.

```bash
git add src/lib/scheduling/dispatch-tick.ts src/lib/scheduling/__tests__/occurrence-uniqueness.db.test.ts
git commit -m "feat(scheduling): agent occurrences dedupe on the existing idempotencyKey constraint"
```

---

### Task 2.8: Stamp `dedupeValue` on poll runs

**Files:**
- Modify: `src/features/flows/poll-dispatch.ts` (the per-item dispatch, ~line 68-96)
- Test: `src/features/flows/__tests__/poll-dedupe.db.test.ts`

Task 2.3's `runScopeKey` reads `trigger.dedupeValue`. Nothing writes it yet, so poll runs currently scope by run id and gain nothing.

- [ ] **Step 1: Write the failing test**

```ts
test('a poll-dispatched run carries the item dedupe value on its trigger', async () => {
  const run = await prisma.flowRun.findFirst({
    where: { flowId: ids.flow }, orderBy: { startedAt: 'desc' },
  })
  const trigger = run.trigger as { type?: string; dedupeValue?: string }
  assert.equal(trigger.type, 'poll')
  assert.equal(typeof trigger.dedupeValue, 'string')
})

test('two runs for the same polled item share a ledger scope', async () => {
  const a = runScopeKey({ id: 'run-a', flowId: ids.flow, trigger: { type: 'poll', dedupeValue: 'item-7' } })
  const b = runScopeKey({ id: 'run-b', flowId: ids.flow, trigger: { type: 'poll', dedupeValue: 'item-7' } })
  assert.equal(a, b)
  // And the ledger therefore makes the second one a replay.
  await writeLedger({
    scopeKey: a, iterationKey: 'send', page: 0,
    organizationId: ids.org, provider: 'slack', tool: 'slack_post_message',
    result: { ok: true }, flowRunId: null,
  })
  assert.deepEqual(await readLedger({ scopeKey: b, iterationKey: 'send', page: 0 }), { result: { ok: true } })
})
```

- [ ] **Step 2: Set the value**

In `runFlowPoll`, where each fresh item is dispatched, include the item's dedupe key on the trigger. The dedupe key field name comes from `trigger.dedupeKey` (default `'id'`), already read at line 66:

```ts
trigger: { type: 'poll', dedupeValue: String(item[dedupeKeyField] ?? '') },
```

When the flow dispatches ONCE with the whole batch rather than per item, omit `dedupeValue` — there is no single item to key on, and `runScopeKey` falls back to the run id.

- [ ] **Step 3: Verify and commit**

Run: `TEST_DATABASE_URL=postgresql://localhost:5432/ci_repro TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/features/flows/__tests__/poll-dedupe.db.test.ts && npm test`

```bash
git add src/features/flows/poll-dispatch.ts src/features/flows/__tests__/poll-dedupe.db.test.ts
git commit -m "feat(flows): poll runs carry their item dedupe value so a re-emit replays"
```

---

### Task 2.9: Retention sweep for `flow_side_effects`

**Files:**
- Modify: `src/app/api/cron/retention/route.ts`
- Test: extend `src/features/flows/__tests__/side-effect-replay.db.test.ts`

Poll-scoped ledger rows survive run deletion by design (`onDelete: SetNull`), so run retention never reaches them. Without their own sweep they accumulate forever.

- [ ] **Step 1: Add the sweep**

Follow the existing per-table delete idiom in that route:

```ts
// Ledger rows outlive their run on purpose (poll-scoped rows keep dedupe
// working after the run is gone), so run retention never reaches them. Sweep
// on the ledger's own age instead. The horizon must exceed the longest poll
// cadence the picker offers, or the duplicate window reopens.
const LEDGER_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
const sideEffects = await systemPrisma.flowSideEffect.deleteMany({
  where: { createdAt: { lt: new Date(now.getTime() - LEDGER_RETENTION_MS) } },
})
```

Include `sideEffects: sideEffects.count` in the route's response summary alongside the existing counts.

- [ ] **Step 2: Test**

```ts
test('ledger rows older than the retention horizon are swept', async () => {
  const scopeKey = `run-old-${Date.now()}`
  await writeLedger({
    scopeKey, iterationKey: 'send', page: 0,
    organizationId: ids.org, provider: 'slack', tool: 'slack_post_message',
    result: { ok: true }, flowRunId: null,
  })
  await prisma.flowSideEffect.updateMany({
    where: { scopeKey },
    data: { createdAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000) },
  })
  await prisma.flowSideEffect.deleteMany({
    where: { createdAt: { lt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) } },
  })
  assert.equal(await prisma.flowSideEffect.count({ where: { scopeKey } }), 0)
})

test('a deleted run leaves its poll-scoped ledger row intact', async () => {
  const run = await prisma.flowRun.create({
    data: { flowId: ids.flow, organizationId: ids.org, userId: ids.user, trigger: { type: 'poll' } },
  })
  const scopeKey = `${ids.flow}:item-keep-${Date.now()}`
  await writeLedger({
    scopeKey, iterationKey: 'send', page: 0,
    organizationId: ids.org, provider: 'slack', tool: 'slack_post_message',
    result: { ok: true }, flowRunId: run.id,
  })
  await prisma.flowRun.delete({ where: { id: run.id } })
  const row = await prisma.flowSideEffect.findFirst({ where: { scopeKey } })
  assert.ok(row)
  assert.equal(row.flowRunId, null)
})
```

- [ ] **Step 3: Verify, commit, push WS2**

```bash
git add src/app/api/cron/retention/route.ts src/features/flows/__tests__/side-effect-replay.db.test.ts
git commit -m "feat(retention): sweep the side-effect ledger on its own age"
git push origin main
```

Then `fly deploy --config fly.worker.toml`.

---

### Task 2.10 (CUTTABLE): Relax `attempts` for prepared jobs

**Files:**
- Modify: `src/lib/flows/queue-options.ts:17`
- Modify: `src/features/flows/execute-flow.ts` (the atomic prepared-run claim)
- Test: `src/lib/flows/__tests__/queue-options.test.ts`

**Cut this task if it does not verify cleanly.** Everything above stands without it.

Only *prepared* jobs can safely retry: their run id — and therefore their ledger keys — is stable across attempts. Fresh jobs create a new run row per attempt, so a retry gets fresh keys and the ledger buys nothing; they stay at `attempts: 1`.

The blocker: `runFlowExecution`'s claim refuses a prepared run that already left `running`, which would reject the legitimate BullMQ retry.

- [ ] **Step 1: Make the claim retry-aware**

The claim must distinguish a BullMQ retry of the SAME job from a second concurrent dispatch. BullMQ passes `job.attemptsMade`; thread it onto `FlowExecutionJob` as `attempt?: number` and allow the claim to proceed when `attempt > 0` **and** the run's `startedAt` is older than the job's own lock duration. A run still inside its lock window is a live first attempt, not a retry.

- [ ] **Step 2: Flip prepared jobs**

```ts
if (preparedRunId) return { jobId: `${preparedRunId}-start`, attempts: 2 }
```

Leave the fresh and delivery branches at `attempts: 1` and update the file-header comment to say why the asymmetry exists.

- [ ] **Step 3: Test**

```ts
test('prepared jobs retry; fresh and delivery jobs do not', () => {
  assert.equal(flowJobOptions(undefined, 'prepared-1').attempts, 2)
  assert.equal(flowJobOptions(undefined, undefined, 'delivery-1').attempts, 1)
  assert.equal(flowJobOptions(undefined).attempts, 1)
})

test('a resume job keeps its time-varying jobId so redelivery is not deduped away', () => {
  const a = flowJobOptions('run-1', undefined, undefined, 1_000)
  const b = flowJobOptions('run-1', undefined, undefined, 2_000)
  assert.notEqual(a.jobId, b.jobId)
})
```

- [ ] **Step 4: Verify against a real double-dispatch**

Run the full CI-mode suite. If ANY existing prepared-run test regresses, cut this task, revert to `attempts: 1`, and note it in the ledger. Do not weaken the claim to make a test pass.

```bash
git add src/lib/flows/queue-options.ts src/features/flows/execute-flow.ts src/lib/flows/__tests__/queue-options.test.ts
git commit -m "feat(queue): prepared flow jobs may retry now that the ledger makes replay safe"
```

---

## Workstream 3 — Retry that distinguishes what it is retrying

Addresses spec A10–A13.

### Task 3.1: Classification, backoff, and `Retry-After`

**Files:**
- Modify: `src/features/flows/action-reliability.ts`
- Test: `src/features/flows/__tests__/action-reliability.test.ts` (create if absent — check with `ls src/features/flows/__tests__/`)

**Interfaces:**
- Produces:
  - `classifyRetry(error: unknown, status?: number): 'retryable' | 'terminal' | 'timeout'`
  - `retryBackoffMs(attempt: number, baseMs: number, random?: () => number): number`
  - `parseRetryAfter(header: string | null, now?: number): number | null`
  - `RETRY_MAX_DELAY_MS`, `RETRY_MAX_ELAPSED_MS`

- [ ] **Step 1: Write the failing test**

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  classifyRetry, retryBackoffMs, parseRetryAfter,
  RETRY_MAX_DELAY_MS, FlowTimeoutError, runWithRetries,
} from '../action-reliability'

test('5xx, 429, and 408 are retryable', () => {
  for (const status of [408, 429, 500, 502, 503, 504]) {
    assert.equal(classifyRetry(new Error('x'), status), 'retryable', `status ${status}`)
  }
})

test('auth and validation failures are terminal — retrying them only burns budget', () => {
  for (const status of [400, 401, 403, 404, 422]) {
    assert.equal(classifyRetry(new Error('x'), status), 'terminal', `status ${status}`)
  }
})

test('a timeout classifies as timeout, so the per-kind policy still governs it', () => {
  assert.equal(classifyRetry(new FlowTimeoutError('slow')), 'timeout')
})

test('an unrecognized error stays retryable — the pre-existing default', () => {
  assert.equal(classifyRetry(new Error('ECONNRESET')), 'retryable')
  assert.equal(classifyRetry('something odd'), 'retryable')
})

test('backoff grows exponentially and caps', () => {
  const noJitter = () => 1
  assert.equal(retryBackoffMs(0, 500, noJitter), 500)
  assert.equal(retryBackoffMs(1, 500, noJitter), 1_000)
  assert.equal(retryBackoffMs(2, 500, noJitter), 2_000)
  assert.equal(retryBackoffMs(20, 500, noJitter), RETRY_MAX_DELAY_MS)
})

test('jitter stays within [0.5, 1.0] of the computed delay', () => {
  assert.equal(retryBackoffMs(1, 500, () => 0), 500)
  assert.equal(retryBackoffMs(1, 500, () => 1), 1_000)
})

test('Retry-After in delta-seconds parses to milliseconds', () => {
  assert.equal(parseRetryAfter('30'), 30_000)
  assert.equal(parseRetryAfter('0'), 0)
})

test('Retry-After as an HTTP-date parses relative to now', () => {
  const now = Date.parse('2026-08-11T09:00:00.000Z')
  assert.equal(parseRetryAfter('Tue, 11 Aug 2026 09:00:30 GMT', now), 30_000)
})

test('a past or unparseable Retry-After yields null, not a negative delay', () => {
  const now = Date.parse('2026-08-11T09:00:00.000Z')
  assert.equal(parseRetryAfter('Tue, 11 Aug 2026 08:59:00 GMT', now), 0)
  assert.equal(parseRetryAfter('gibberish', now), null)
  assert.equal(parseRetryAfter(null, now), null)
})

test('a terminal error consumes exactly one attempt', async () => {
  let calls = 0
  await assert.rejects(runWithRetries(
    async () => { calls += 1; const error = new Error('unauthorized'); (error as never as { status: number }).status = 401; throw error },
    { retries: 3, retryDelayMs: 1 },
  ))
  assert.equal(calls, 1)
})

test('a retryable error uses the whole budget', async () => {
  let calls = 0
  await assert.rejects(runWithRetries(
    async () => { calls += 1; throw new Error('ECONNRESET') },
    { retries: 2, retryDelayMs: 1 },
  ))
  assert.equal(calls, 3)
})

test('retries=0 still means exactly one attempt', async () => {
  let calls = 0
  await assert.rejects(runWithRetries(async () => { calls += 1; throw new Error('x') }, { retries: 0 }))
  assert.equal(calls, 1)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/features/flows/__tests__/action-reliability.test.ts`
Expected: FAIL — `classifyRetry` not exported.

- [ ] **Step 3: Implement**

```ts
/** Delay ceiling for one wait between attempts. */
export const RETRY_MAX_DELAY_MS = 30_000
/**
 * Ceiling on TOTAL time spent retrying one step, so a chain can never outrun
 * the step's own timeout or the BullMQ job lock and get the run declared
 * stalled while it sleeps.
 */
export const RETRY_MAX_ELAPSED_MS = 120_000

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504])
const TERMINAL_STATUS = new Set([400, 401, 403, 404, 405, 409, 410, 422])

function statusOf(error: unknown): number | undefined {
  if (error && typeof error === 'object' && 'status' in error) {
    const value = (error as { status: unknown }).status
    if (typeof value === 'number') return value
  }
  return undefined
}

/**
 * What KIND of failure this is. Retrying a 401 the way we retry a 503 burns the
 * budget on something that will never succeed, and (before WS3) the 503 case
 * never reached the retry path at all because the HTTP step returns non-2xx
 * instead of throwing.
 *
 * Unknown failures stay retryable — that is the pre-existing default and
 * narrowing it would silently stop retrying transport errors we do not model.
 */
export function classifyRetry(error: unknown, status?: number): 'retryable' | 'terminal' | 'timeout' {
  if (error instanceof FlowTimeoutError) return 'timeout'
  const code = status ?? statusOf(error)
  if (code !== undefined) {
    if (TERMINAL_STATUS.has(code)) return 'terminal'
    if (RETRYABLE_STATUS.has(code)) return 'retryable'
    if (code >= 400 && code < 500) return 'terminal'
  }
  return 'retryable'
}

/**
 * Exponential backoff with jitter. The old fixed 500ms meant five retries were
 * five hits in 2.5s, and every iteration of a per-item loop retried in
 * lockstep — a synchronized herd against an API that was already struggling.
 */
export function retryBackoffMs(attempt: number, baseMs: number, random: () => number = Math.random): number {
  const exponential = Math.min(baseMs * 2 ** attempt, RETRY_MAX_DELAY_MS)
  return Math.round(exponential * (0.5 + random() * 0.5))
}

/** `Retry-After` as milliseconds: delta-seconds or HTTP-date. Null if absent/unparseable. */
export function parseRetryAfter(header: string | null, now: number = Date.now()): number | null {
  if (!header) return null
  const trimmed = header.trim()
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000
  const at = Date.parse(trimmed)
  if (Number.isNaN(at)) return null
  return Math.max(0, at - now)
}
```

Then rewrite the loop in `runWithRetries`:

```ts
export async function runWithRetries<T>(
  operation: (attempt: number) => Promise<T>,
  options: {
    retries?: number
    timeoutMs?: number
    timeoutMessage?: string
    retryDelayMs?: number
    retryOnTimeout?: boolean
    /** Provider-supplied delay for the NEXT attempt, in ms. */
    retryAfterMs?: (error: unknown) => number | null
  } = {},
): Promise<T> {
  const retries = flowActionRetries(options.retries)
  const timeoutMs = flowActionTimeoutMs(options.timeoutMs)
  const base = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS
  const startedAt = Date.now()
  let lastError: unknown

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await withTimeout(
        operation(attempt),
        timeoutMs,
        options.timeoutMessage ?? `Step timed out after ${timeoutMs}ms`,
      )
    } catch (error) {
      lastError = error
      if (attempt >= retries) break
      const kind = classifyRetry(error)
      // A timeout only ABANDONS the in-flight call; the per-kind policy decides
      // whether retrying could stack a second live execution. Unchanged.
      if (kind === 'timeout' && options.retryOnTimeout === false) break
      if (kind === 'terminal') break
      const suggested = options.retryAfterMs?.(error) ?? null
      const delay = Math.min(suggested ?? retryBackoffMs(attempt, base), RETRY_MAX_DELAY_MS)
      if (Date.now() - startedAt + delay > RETRY_MAX_ELAPSED_MS) break
      await sleep(delay)
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/features/flows/__tests__/action-reliability.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Run the full suite — this changes shared behavior**

Run: `npm test`
Expected: green. `runWithRetries` is called from the tool, ai, subflow, and http branches; a regression here shows up broadly.

- [ ] **Step 6: Commit**

```bash
git add src/features/flows/action-reliability.ts src/features/flows/__tests__/action-reliability.test.ts
git commit -m "feat(flows): classify retryable vs terminal, exponential backoff with jitter, Retry-After"
```

---

### Task 3.2: Make HTTP 429/5xx reachable by the retry path

**Files:**
- Modify: `src/features/flows/execute-flow.ts:1100-1160` (the http branch's `runWithRetries` call)
- Test: `src/features/flows/__tests__/http-retry.test.ts` (NEW file)

The bug: `src/features/flows/http.ts:315` returns `{ ok, status, statusText }` and never throws, so `runWithRetries` never sees a 429 or 503 — the one class of failure retry is unambiguously for.

**Compatibility is the constraint.** Flows branch on `{ ok: false, status }`. That contract does not change.

- [ ] **Step 1: Write the failing test, pinning today's behavior first**

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runHttpWithRetries } from '../execute-flow'

/** Fake HTTP executor returning a scripted sequence of responses. */
function scripted(responses: Array<{ ok: boolean; status: number }>) {
  let index = 0
  const calls: number[] = []
  return {
    calls,
    run: async () => {
      const response = responses[Math.min(index, responses.length - 1)]
      index += 1
      calls.push(response.status)
      return response
    },
  }
}

test('PINNED: retries=0 behaves exactly as before for 200, 404, 429, and 503', async () => {
  for (const status of [200, 404, 429, 503]) {
    const http = scripted([{ ok: status === 200, status }])
    const result = await runHttpWithRetries(http.run, { retries: 0, retryDelayMs: 1 })
    assert.equal(result.status, status, `status ${status}`)
    assert.equal(http.calls.length, 1, `status ${status} must be called exactly once`)
  }
})

test('a retryable 503 with retries=2 retries twice, then returns the response', async () => {
  const http = scripted([{ ok: false, status: 503 }])
  const result = await runHttpWithRetries(http.run, { retries: 2, retryDelayMs: 1 })
  assert.equal(http.calls.length, 3)
  assert.equal(result.status, 503)
  assert.equal(result.ok, false)
})

test('a 429 that then succeeds returns the success and stops retrying', async () => {
  const http = scripted([{ ok: false, status: 429 }, { ok: true, status: 200 }])
  const result = await runHttpWithRetries(http.run, { retries: 3, retryDelayMs: 1 })
  assert.equal(http.calls.length, 2)
  assert.equal(result.status, 200)
})

test('a 404 with retries=3 is NOT retried — terminal', async () => {
  const http = scripted([{ ok: false, status: 404 }])
  const result = await runHttpWithRetries(http.run, { retries: 3, retryDelayMs: 1 })
  assert.equal(http.calls.length, 1)
  assert.equal(result.status, 404)
})

test('the exhausted response is returned, never thrown — flows branch on it', async () => {
  const http = scripted([{ ok: false, status: 503 }])
  const result = await runHttpWithRetries(http.run, { retries: 1, retryDelayMs: 1 })
  assert.equal(result.ok, false)
  assert.equal(result.status, 503)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/features/flows/__tests__/http-retry.test.ts`
Expected: FAIL — `runHttpWithRetries` is not exported.

- [ ] **Step 3: Implement**

Export a small wrapper from `execute-flow.ts` (or a new `src/features/flows/http-retry.ts` if `execute-flow.ts` is already unwieldy — it is over 1600 lines, so a new file is the better home; import it back into the http branch):

```ts
/**
 * The HTTP step returns non-2xx as a VALUE (`{ok:false,status}`) rather than
 * throwing, and flows branch on that — so `retries` never reached a 429 or a
 * 503, the exact failures it exists for. This converts a retryable status into
 * a throw INTERNALLY so the retry loop can see it, then converts the exhausted
 * failure back into the response object callers expect.
 *
 * Compatibility contract: with retries=0 this is a pass-through. No existing
 * flow changes behavior.
 */
export async function runHttpWithRetries<R extends { ok: boolean; status: number; headers?: Record<string, string> }>(
  operation: (attempt: number) => Promise<R>,
  options: { retries?: number; retryDelayMs?: number; timeoutMs?: number; timeoutMessage?: string },
): Promise<R> {
  let lastResponse: R | undefined
  class RetryableStatus extends Error {
    constructor(readonly response: R) {
      super(`HTTP ${response.status}`)
      ;(this as unknown as { status: number }).status = response.status
    }
  }
  try {
    return await runWithRetries(
      async (attempt) => {
        const response = await operation(attempt)
        lastResponse = response
        if (!response.ok && classifyRetry(null, response.status) === 'retryable') {
          throw new RetryableStatus(response)
        }
        return response
      },
      {
        ...options,
        // HTTP timeouts abort the request (AbortController), so retrying them
        // cannot stack live work — the existing per-kind policy.
        retryOnTimeout: shouldRetryAfterTimeout('http'),
        retryAfterMs: (error) =>
          error instanceof RetryableStatus
            ? parseRetryAfter(error.response.headers?.['retry-after'] ?? null)
            : null,
      },
    )
  } catch (error) {
    // Budget exhausted on a retryable status: hand back the response, exactly
    // as the caller has always received it. Only RetryableStatus is converted
    // back — a genuine transport error still throws, as it always did. Do NOT
    // add a `lastResponse` fallback here: it would swallow real errors that
    // happen to carry a `status` property.
    if (error instanceof RetryableStatus) return error.response
    throw error
  }
}
```

`lastResponse` exists only so a future debugging aid has it; if lint flags it as
unused after the fallback is removed, delete the variable rather than keeping a
fallback that changes error semantics.

Replace the http branch's `runWithRetries(...)` call with `runHttpWithRetries(...)`, keeping every existing option value.

Ensure `responseOutput` in `src/features/flows/http.ts` includes lowercased response headers so `retry-after` is reachable; if it does not, add them.

- [ ] **Step 4: Run test to verify it passes**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/features/flows/__tests__/http-retry.test.ts && npm test`
Expected: 5 tests PASS, full suite green.

- [ ] **Step 5: Revisit Task 2.5's ledger condition**

Now that a retryable status is retried, the HTTP ledger write in Task 2.5 can record on any **non-retryable** outcome rather than only `response.ok` — a terminal 404 is a settled result worth recording. Update that condition and the comment.

- [ ] **Step 6: Commit and push WS3**

```bash
git add src/features/flows/http-retry.ts src/features/flows/execute-flow.ts src/features/flows/http.ts src/features/flows/__tests__/http-retry.test.ts
git commit -m "feat(flows): HTTP 429/5xx finally reach the retry path, retries=0 unchanged"
git push origin main
```

---

## Workstream 4 — Pattern-triggered flow reflection

Addresses spec A15–A17.

### Task 4.1: `detectFailurePatterns`

**Files:**
- Create: `src/lib/flows/failure-patterns.ts`
- Test: `src/lib/flows/__tests__/failure-patterns.test.ts`

**Interfaces:**
- Produces:
  - `type FailurePattern = { stepId: string; kind: 'error' | 'warning'; signature: string; occurrences: number; runIds: string[]; firstSeen: Date; lastSeen: Date }`
  - `normalizeErrorSignature(message: string): string`
  - `detectFailurePatterns(runs: PatternRun[], options?: { minOccurrences?: number; minRuns?: number }): FailurePattern[]`
  - `type PatternRun = { id: string; startedAt: Date; steps: Array<{ nodeId: string; status: string; error: string | null; warnings: string[] }> }`

Pure, no I/O. This is where `FlowRunStep.warnings` gets its first consumer.

- [ ] **Step 1: Write the failing test**

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detectFailurePatterns, normalizeErrorSignature, type PatternRun } from '../failure-patterns'

function run(id: string, day: number, steps: PatternRun['steps']): PatternRun {
  return { id, startedAt: new Date(`2026-08-${String(day).padStart(2, '0')}T09:00:00.000Z`), steps }
}
const failed = (nodeId: string, error: string) => ({ nodeId, status: 'failed', error, warnings: [] })

test('ids, urls, uuids, and bare numbers collapse into one signature', () => {
  const a = normalizeErrorSignature('404 Not Found for https://api.example.com/users/abc123')
  const b = normalizeErrorSignature('404 Not Found for https://api.example.com/users/def456')
  assert.equal(a, b)
})

test('genuinely different errors do NOT collapse', () => {
  assert.notEqual(
    normalizeErrorSignature('404 Not Found for /users/1'),
    normalizeErrorSignature('503 Service Unavailable for /users/1'),
  )
})

test('a pattern fires at three occurrences across three runs', () => {
  const runs = [
    run('r1', 1, [failed('fetch', '404 for /users/1')]),
    run('r2', 2, [failed('fetch', '404 for /users/2')]),
    run('r3', 3, [failed('fetch', '404 for /users/3')]),
  ]
  const patterns = detectFailurePatterns(runs)
  assert.equal(patterns.length, 1)
  assert.equal(patterns[0].stepId, 'fetch')
  assert.equal(patterns[0].kind, 'error')
  assert.equal(patterns[0].occurrences, 3)
  assert.deepEqual(patterns[0].runIds, ['r1', 'r2', 'r3'])
})

test('two occurrences is below the threshold — no pattern', () => {
  const runs = [run('r1', 1, [failed('fetch', '404 for /a')]), run('r2', 2, [failed('fetch', '404 for /b')])]
  assert.deepEqual(detectFailurePatterns(runs), [])
})

test('three occurrences inside ONE run is not a pattern — a loop is not a trend', () => {
  const runs = [run('r1', 1, [failed('fetch', '404 for /a'), failed('fetch', '404 for /b'), failed('fetch', '404 for /c')])]
  assert.deepEqual(detectFailurePatterns(runs), [])
})

test('warnings form their own patterns, keyed separately from errors', () => {
  const warn = (nodeId: string, warning: string) => ({ nodeId, status: 'succeeded', error: null, warnings: [warning] })
  const runs = [
    run('r1', 1, [warn('send', 'The tool returned an empty result.')]),
    run('r2', 2, [warn('send', 'The tool returned an empty result.')]),
    run('r3', 3, [warn('send', 'The tool returned an empty result.')]),
  ]
  const patterns = detectFailurePatterns(runs)
  assert.equal(patterns.length, 1)
  assert.equal(patterns[0].kind, 'warning')
})

test('different steps failing the same way are separate patterns', () => {
  const runs = [
    run('r1', 1, [failed('a', '500 x'), failed('b', '500 x')]),
    run('r2', 2, [failed('a', '500 x'), failed('b', '500 x')]),
    run('r3', 3, [failed('a', '500 x'), failed('b', '500 x')]),
  ]
  assert.equal(detectFailurePatterns(runs).length, 2)
})

test('a clean history produces nothing', () => {
  const runs = [run('r1', 1, [{ nodeId: 'fetch', status: 'succeeded', error: null, warnings: [] }])]
  assert.deepEqual(detectFailurePatterns(runs), [])
})

test('firstSeen and lastSeen bracket the pattern', () => {
  const runs = [
    run('r1', 1, [failed('fetch', '404 for /a')]),
    run('r2', 5, [failed('fetch', '404 for /b')]),
    run('r3', 9, [failed('fetch', '404 for /c')]),
  ]
  const [pattern] = detectFailurePatterns(runs)
  assert.equal(pattern.firstSeen.toISOString(), '2026-08-01T09:00:00.000Z')
  assert.equal(pattern.lastSeen.toISOString(), '2026-08-09T09:00:00.000Z')
})

test('patterns come back most-frequent first', () => {
  const runs = [
    run('r1', 1, [failed('a', '500 x'), failed('b', '500 x')]),
    run('r2', 2, [failed('a', '500 x'), failed('b', '500 x')]),
    run('r3', 3, [failed('a', '500 x'), failed('b', '500 x')]),
    run('r4', 4, [failed('a', '500 x')]),
  ]
  const patterns = detectFailurePatterns(runs)
  assert.equal(patterns[0].stepId, 'a')
  assert.equal(patterns[0].occurrences, 4)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/flows/__tests__/failure-patterns.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
/**
 * Cross-run failure detection: the input to flow reflection.
 *
 * Reflection per RUN would be an LLM call every 15 minutes for a flow on a
 * 15-minute cadence, and a single run cannot see a trend anyway. Grouping
 * across a flow's recent runs makes the cost O(flows with a pattern) and makes
 * the signal an actual pattern.
 *
 * This is also the first consumer of FlowRunStep.warnings — the run-truthfulness
 * work built that channel and nothing read it.
 *
 * Pure — no I/O, safe to test directly.
 */

export type PatternRun = {
  id: string
  startedAt: Date
  steps: Array<{ nodeId: string; status: string; error: string | null; warnings: string[] }>
}

export type FailurePattern = {
  stepId: string
  kind: 'error' | 'warning'
  signature: string
  occurrences: number
  runIds: string[]
  firstSeen: Date
  lastSeen: Date
}

/** Default: 3 occurrences spanning at least 2 distinct runs. */
export const MIN_OCCURRENCES = 3
export const MIN_DISTINCT_RUNS = 2

/**
 * Collapse the volatile parts of an error so the same failure in different
 * rows groups together: "404 for /users/abc123" and "404 for /users/def456"
 * are one pattern, but a 404 and a 503 are two.
 *
 * Order matters — URLs before uuids before bare numbers, or a uuid inside a URL
 * gets rewritten twice and the shapes diverge.
 */
export function normalizeErrorSignature(message: string): string {
  return message
    .toLowerCase()
    .replace(/https?:\/\/[^\s"')]+/g, '<url>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, '<uuid>')
    .replace(/\b[a-z0-9]{16,}\b/g, '<id>')
    .replace(/\b\d{4}-\d{2}-\d{2}t[\d:.]+z?\b/g, '<timestamp>')
    .replace(/\b\d+\b/g, (match) => (match.length === 3 && match >= '100' && match <= '599' ? match : '<n>'))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)
}

export function detectFailurePatterns(
  runs: PatternRun[],
  options: { minOccurrences?: number; minRuns?: number } = {},
): FailurePattern[] {
  const minOccurrences = options.minOccurrences ?? MIN_OCCURRENCES
  const minRuns = options.minRuns ?? MIN_DISTINCT_RUNS

  type Bucket = { stepId: string; kind: 'error' | 'warning'; signature: string; runIds: string[]; occurrences: number; times: number[] }
  const buckets = new Map<string, Bucket>()

  const record = (stepId: string, kind: 'error' | 'warning', raw: string, run: PatternRun) => {
    const signature = normalizeErrorSignature(raw)
    if (!signature) return
    const key = `${kind} ${stepId} ${signature}`
    const bucket = buckets.get(key) ?? { stepId, kind, signature, runIds: [], occurrences: 0, times: [] }
    bucket.occurrences += 1
    if (!bucket.runIds.includes(run.id)) bucket.runIds.push(run.id)
    bucket.times.push(run.startedAt.getTime())
    buckets.set(key, bucket)
  }

  for (const run of runs) {
    for (const step of run.steps) {
      if (step.status === 'failed' && step.error) record(step.nodeId, 'error', step.error, run)
      for (const warning of step.warnings) record(step.nodeId, 'warning', warning, run)
    }
  }

  return [...buckets.values()]
    // A loop that failed 30 times in ONE run is one bad run, not a trend.
    .filter((bucket) => bucket.occurrences >= minOccurrences && bucket.runIds.length >= minRuns)
    .map((bucket) => ({
      stepId: bucket.stepId,
      kind: bucket.kind,
      signature: bucket.signature,
      occurrences: bucket.occurrences,
      runIds: bucket.runIds,
      firstSeen: new Date(Math.min(...bucket.times)),
      lastSeen: new Date(Math.max(...bucket.times)),
    }))
    .sort((a, b) => b.occurrences - a.occurrences || a.stepId.localeCompare(b.stepId))
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/flows/__tests__/failure-patterns.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/flows/failure-patterns.ts src/lib/flows/__tests__/failure-patterns.test.ts
git commit -m "feat(flows): cross-run failure-pattern detection over errors and warnings"
```

---

### Task 4.2: The reflection sweep and its proposal

**Files:**
- Create: `src/lib/flows/reflection-sweep.ts`
- Test: `src/lib/flows/__tests__/reflection-sweep.db.test.ts`

**Interfaces:**
- Consumes: `detectFailurePatterns` (4.1), `generateStructured` + `DEFAULT_SUMMARY_MODEL` from `@/lib/llm/model-runner`, `systemPrisma`/`prisma`.
- Produces: `sweepFlowReflection(now: Date, deps?: { generate?: typeof generateStructured }): Promise<string[]>` returning the flow ids that produced a proposal.

Mirrors `sweepTemplateGeneration`'s shape: per-row debounce derived from existing data (no marker table), capped per tick, isolated.

- [ ] **Step 1: Write the failing test**

```ts
test('a flow with a pattern produces one process_improvement proposal', async () => {
  // fixture: 3 runs of ids.flow, each with a failed `fetch` step, 404s
  const calls: string[] = []
  const generate = async ({ user }: { user: string }) => {
    calls.push(user)
    return JSON.stringify({
      title: 'The fetch step is querying a stale endpoint',
      rationale: 'It has returned 404 on every run for three days.',
    })
  }
  const flows = await sweepFlowReflection(new Date(), { generate: generate as never })
  assert.deepEqual(flows, [ids.flow])
  assert.equal(calls.length, 1)

  const proposal = await prisma.templateProposal.findFirst({
    where: { organizationId: ids.org, kind: 'process_improvement' },
    orderBy: { createdAt: 'desc' },
  })
  assert.ok(proposal)
  assert.equal((proposal.configuration as any).targetType, 'flow')
  assert.equal((proposal.configuration as any).targetId, ids.flow)
  assert.equal((proposal.sourceEvidence as any).stepId, 'fetch')
  assert.equal((proposal.sourceEvidence as any).occurrences, 3)
})

test('the proposal opens the flow editor via the existing accept path', async () => {
  const { proposalImprovementTarget } = await import('@/lib/templates/accept-proposal')
  const proposal = await prisma.templateProposal.findFirst({
    where: { organizationId: ids.org, kind: 'process_improvement' },
    orderBy: { createdAt: 'desc' },
  })
  assert.deepEqual(proposalImprovementTarget(proposal), { targetType: 'flow', targetId: ids.flow })
})

test('a second sweep the same day is debounced — no second model call', async () => {
  let calls = 0
  const generate = async () => { calls += 1; return JSON.stringify({ title: 't', rationale: 'r' }) }
  await sweepFlowReflection(new Date(), { generate: generate as never })
  assert.equal(calls, 0)
})

test('a flow with no pattern produces no proposal and no model call', async () => {
  let calls = 0
  const generate = async () => { calls += 1; return '{}' }
  const flows = await sweepFlowReflection(new Date(), { generate: generate as never })
  assert.ok(!flows.includes(ids.cleanFlow))
  assert.equal(calls, 0)
})

test('a throwing generator does not throw out of the sweep', async () => {
  const generate = async () => { throw new Error('model down') }
  await assert.doesNotReject(sweepFlowReflection(new Date(), { generate: generate as never }))
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TEST_DATABASE_URL=postgresql://localhost:5432/ci_repro TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/flows/__tests__/reflection-sweep.db.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
import { z } from 'zod'
import { prisma, systemPrisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { generateStructured, DEFAULT_SUMMARY_MODEL } from '@/lib/llm/model-runner'
import { detectFailurePatterns, type PatternRun, type FailurePattern } from '@/lib/flows/failure-patterns'

/**
 * Flow reflection. Agents have reflected since day one (execute-agent.ts calls
 * reflectAndRemember); flows never did, so a flow that failed the same way
 * every 15 minutes produced 96 identical failed runs a day and no signal.
 *
 * Pattern-triggered, not per-run: one structured call per flow that has a
 * PATTERN, at most once a day. Cost is O(flows with a pattern), not O(runs),
 * and a single run could not see a trend anyway.
 *
 * The output is a process_improvement TemplateProposal — the accept/dismiss
 * surface already exists end to end, and that decision is the outcome signal
 * the agent memory loop never had.
 */

/** One proposal per flow per day. */
export const REFLECTION_DEBOUNCE_MS = 24 * 60 * 60 * 1000
/** Bound the model spend of a single tick. */
export const MAX_REFLECTIONS_PER_TICK = 5
/** How far back a failure must have occurred for the flow to be a candidate. */
const CANDIDATE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
/** How many recent runs the detector reasons over. */
const RUN_WINDOW = 10

const reflectionSchema = z.object({ title: z.string().min(1), rationale: z.string().min(1) })

const REFLECTION_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: { title: { type: 'string' }, rationale: { type: 'string' } },
  required: ['title', 'rationale'],
}

/** FlowRunStep.warnings is Json; the detector wants string[]. */
function warningsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
}

function buildPrompt(flowName: string, pattern: FailurePattern) {
  return {
    system:
      'You review automation run history. Given one recurring failure pattern in a workflow, write a short title naming what is wrong and a rationale explaining the likely cause and the fix. Be concrete and terse. Write plain English only: never output cron expressions, curly-brace token syntax, or code identifiers the user did not write themselves.',
    user: [
      `Workflow: ${flowName}`,
      `Step: ${pattern.stepId}`,
      `Signal: ${pattern.kind === 'error' ? 'the step failed' : 'the step warned'}`,
      `Recurring message: ${pattern.signature}`,
      `Seen ${pattern.occurrences} times across ${pattern.runIds.length} runs, from ${pattern.firstSeen.toISOString()} to ${pattern.lastSeen.toISOString()}.`,
    ].join('\n'),
  }
}

/**
 * Returns the flow ids that produced a proposal. Never throws — a reflection
 * failure must not abort the dispatch tick that calls it.
 */
export async function sweepFlowReflection(
  now: Date,
  deps: { generate?: typeof generateStructured } = {},
): Promise<string[]> {
  const generate = deps.generate ?? generateStructured
  const reflected: string[] = []

  // Candidate scan: only flows with a FAILED run recently. Scanning every flow
  // and loading its history would make this the most expensive thing in the
  // tick. systemPrisma: cross-org sweep by design (CRON_SECRET-gated caller).
  const candidates = await systemPrisma.flowRun.findMany({
    where: { status: 'failed', startedAt: { gte: new Date(now.getTime() - CANDIDATE_WINDOW_MS) } },
    select: { flowId: true },
    distinct: ['flowId'],
    take: 500,
  })

  for (const { flowId } of candidates) {
    if (reflected.length >= MAX_REFLECTIONS_PER_TICK) break
    try {
      const flow = await systemPrisma.flow.findUnique({
        where: { id: flowId },
        select: { id: true, name: true, organizationId: true, userId: true },
      })
      if (!flow) continue

      // Debounce off the proposals themselves — they ARE the ledger, the same
      // reasoning as generation-queue.ts's readLastGeneratedAt. No marker table.
      const recent = await prisma.templateProposal.findFirst({
        where: {
          organizationId: flow.organizationId,
          kind: 'process_improvement',
          createdAt: { gte: new Date(now.getTime() - REFLECTION_DEBOUNCE_MS) },
          configuration: { path: ['targetId'], equals: flow.id },
        },
        select: { id: true },
      })
      if (recent) continue

      const runs = await systemPrisma.flowRun.findMany({
        where: { flowId: flow.id },
        orderBy: { startedAt: 'desc' },
        take: RUN_WINDOW,
        select: {
          id: true,
          startedAt: true,
          steps: { select: { nodeId: true, status: true, error: true, warnings: true } },
        },
      })

      const patternRuns: PatternRun[] = runs.map((run) => ({
        id: run.id,
        startedAt: run.startedAt,
        steps: run.steps.map((step) => ({
          nodeId: step.nodeId,
          status: step.status,
          error: step.error,
          warnings: warningsOf(step.warnings),
        })),
      }))

      const patterns = detectFailurePatterns(patternRuns)
      if (!patterns.length) continue
      // Top pattern only — one proposal per flow per day, not one per pattern.
      const pattern = patterns[0]

      const { system, user } = buildPrompt(flow.name, pattern)
      const raw = await generate({
        system,
        user,
        schema: REFLECTION_JSON_SCHEMA,
        schemaName: 'flow_reflection',
        maxTokens: 800,
        model: process.env.FLOW_REFLECTION_MODEL?.trim() || DEFAULT_SUMMARY_MODEL,
      })
      const parsed = reflectionSchema.safeParse(JSON.parse(raw))
      if (!parsed.success) continue

      await prisma.templateProposal.create({
        data: {
          organizationId: flow.organizationId,
          userId: flow.userId,
          kind: 'process_improvement',
          title: parsed.data.title.slice(0, 200),
          rationale: parsed.data.rationale.slice(0, 2000),
          // targetType/targetId is exactly what proposalImprovementTarget reads
          // (src/lib/templates/accept-proposal.ts:52) — accepting opens the flow
          // editor on the offending flow. Extra keys are ignored by that path.
          configuration: { targetType: 'flow', targetId: flow.id, stepId: pattern.stepId },
          sourceEvidence: {
            stepId: pattern.stepId,
            kind: pattern.kind,
            signature: pattern.signature,
            occurrences: pattern.occurrences,
            runIds: pattern.runIds.slice(0, 10),
            firstSeen: pattern.firstSeen.toISOString(),
            lastSeen: pattern.lastSeen.toISOString(),
          },
        },
      })
      reflected.push(flow.id)
    } catch (error) {
      // Per-flow isolation, mirroring reflectAndRemember: one bad flow never
      // stops the sweep, and the sweep never throws at its caller.
      apiLogger.warn('flow reflection failed for one flow', {
        flowId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return reflected
}
```

Two things to verify against the live code before writing this, because both are
assumptions about neighbouring modules:

- `generateStructured`'s parameter names (`system`, `user`, `schema`,
  `schemaName`, `maxTokens`, `model`) — copy them from the call in
  `src/features/agents/reflection.ts:117`, which is the working reference.
- Prisma's `configuration: { path: ['targetId'], equals: flow.id }` JSON filter
  works on Postgres but the path syntax differs between connectors. If it
  rejects, fall back to fetching the org's recent `process_improvement`
  proposals and filtering `targetId` in JS — the volume is small.

- [ ] **Step 4: Run test to verify it passes**

Run: `TEST_DATABASE_URL=postgresql://localhost:5432/ci_repro TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/flows/__tests__/reflection-sweep.db.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/flows/reflection-sweep.ts src/lib/flows/__tests__/reflection-sweep.db.test.ts
git commit -m "feat(flows): pattern-triggered reflection writes a process_improvement proposal"
```

---

### Task 4.3: Run the sweep in the dispatch tick

**Files:**
- Modify: `src/lib/scheduling/dispatch-tick.ts` (beside the `sweepTemplateGeneration` block)

- [ ] **Step 1: Add the isolated call**

Immediately after the template-generation sweep, matching its shape exactly:

```ts
// Flow reflection: a daily, per-flow-debounced pass that turns a repeated
// failure into ONE proposal instead of N identical failed runs. Isolated so a
// reflection failure never aborts the dispatch tick.
let reflectedFlows: string[] = []
try {
  reflectedFlows = await sweepFlowReflection(now)
} catch (error) {
  apiLogger.error('cron/dispatch: flow reflection sweep failed', { error: capError(error) })
  captureError(error, { source: 'cron.dispatch.flowReflection' })
}
```

Add `reflectedFlows` to the returned `DispatchTickSummary` and to its type.

- [ ] **Step 2: Verify**

Run: `npx tsc --noEmit && npx eslint src/lib/scheduling/dispatch-tick.ts && npm test`
Expected: clean, suite green.

- [ ] **Step 3: Full CI-mode verification before push**

Run on a FRESH `ci_repro` database:

```bash
dropdb ci_repro 2>/dev/null; createdb ci_repro
TEST_DATABASE_URL=postgresql://localhost:5432/ci_repro npx prisma migrate deploy
TEST_DATABASE_URL=postgresql://localhost:5432/ci_repro npm test
npm run build
```

Expected: both migrations apply clean, full suite green, build green.

- [ ] **Step 4: Commit and push WS4**

```bash
git add src/lib/scheduling/dispatch-tick.ts
git commit -m "feat(scheduling): run the flow reflection sweep in the dispatch tick"
git push origin main
```

- [ ] **Step 5: Deploy and verify in production**

```bash
fly deploy --config fly.worker.toml
```

Then confirm on `/api/health`:
- `checks.queueConsumers.tick.fresh` is `true` and `ageMs` is under 120s (the worker plane is driving, not just the 15-minute cron).
- `checks.queueConsumers.heartbeat` is still fresh.

Finally, record the run in `.superpowers/sdd/progress.md` following the existing entry format: what shipped per workstream, the gate results, the commit range, and any cut task (2.10) with the reason.
