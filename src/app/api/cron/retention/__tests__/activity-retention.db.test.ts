import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

/**
 * The 90-day retention sweep must reach the two new activity-substrate
 * tables: ActivityEvent rows and terminal ActivityTriggerClaim rows age out
 * exactly like signals/executions/flow runs do, with counters surfaced in
 * both the log line and the JSON response (house convention — see
 * cron/retention/route.ts).
 *
 * A 'claimed' claim still WITHIN the retention window survives (it may
 * genuinely be in flight); one OLDER than the cutoff is pruned too — by that
 * age (default 90 days, ~8,600x STALE_CLAIM_MS) it is not "in flight," it is
 * a crashed dispatch nobody ever finished, and leaving it forever meant
 * queue-watch's stale-claim alert re-fired on every single cron tick with no
 * way to clear it. See the fix's doc comment on activityTriggerClaimsPruned
 * in cron/retention/route.ts.
 */

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  process.env.CRON_SECRET = process.env.CRON_SECRET || 'test-cron-secret'

  let prisma: any
  const ids: Record<string, string> = {}

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))

    const stamp = Date.now()
    const org = await prisma.organization.create({ data: { name: 'Activity Retention', slug: `activity-retention-${stamp}` } })
    ids.org = org.id
  })

  /**
   * Seeded from INSIDE the locked critical section, not from `before`.
   *
   * These rows are older than the cutoff, which makes them fair game for any
   * global retention sweep — including a sibling suite's. Seeding them in
   * `before` left them sitting in the shared database, unprotected, for however
   * long the runner took to reach the test body: a sweep landing in that window
   * carried them off, and this test then measured its own sweep finding nothing
   * to delete. Under the lock the window does not exist, because the only other
   * caller of this sweep now waits for the same lock.
   *
   * Writes go through the outer client rather than the lock's `tx` on purpose —
   * the route reads on its own connection and cannot see an uncommitted row.
   */
  async function seedAgedFixtures() {
    const stamp = Date.now()
    const ninetyOneDaysAgo = new Date(Date.now() - 91 * 24 * 60 * 60 * 1000)

    const staleEvent = await prisma.activityEvent.create({
      data: {
        organizationId: ids.org,
        source: 'slack',
        sourceEventId: `stale-${stamp}`,
        kind: 'message.posted',
        occurredAt: ninetyOneDaysAgo,
        payload: { text: 'old message' },
        createdAt: ninetyOneDaysAgo,
      },
    })
    ids.staleEvent = staleEvent.id

    const freshEvent = await prisma.activityEvent.create({
      data: {
        organizationId: ids.org,
        source: 'slack',
        sourceEventId: `fresh-${stamp}`,
        kind: 'message.posted',
        occurredAt: new Date(),
        payload: { text: 'new message' },
      },
    })
    ids.freshEvent = freshEvent.id

    const staleTerminalClaim = await prisma.activityTriggerClaim.create({
      data: {
        organizationId: ids.org,
        activityEventId: staleEvent.id,
        flowId: crypto.randomUUID(),
        status: 'dispatched',
        createdAt: ninetyOneDaysAgo,
      },
    })
    ids.staleTerminalClaim = staleTerminalClaim.id

    // Old enough to be a stranded, crashed-dispatch claim, not "in flight" —
    // this one MUST be pruned now.
    const staleClaimedClaim = await prisma.activityTriggerClaim.create({
      data: {
        organizationId: ids.org,
        activityEventId: freshEvent.id,
        flowId: crypto.randomUUID(),
        status: 'claimed',
        createdAt: ninetyOneDaysAgo,
      },
    })
    ids.staleClaimedClaim = staleClaimedClaim.id

    // Genuinely recent — this one is still plausibly in flight and must
    // survive the sweep.
    const freshClaimedClaim = await prisma.activityTriggerClaim.create({
      data: {
        organizationId: ids.org,
        activityEventId: freshEvent.id,
        flowId: crypto.randomUUID(),
        status: 'claimed',
      },
    })
    ids.freshClaimedClaim = freshClaimedClaim.id
  }

  after(async () => {
    if (!ids.org) return
    await prisma.activityTriggerClaim.deleteMany({ where: { organizationId: ids.org } })
    await prisma.activityEvent.deleteMany({ where: { organizationId: ids.org } })
    await prisma.organization.delete({ where: { id: ids.org } })
  })

  test('sweep deletes the 91-day-old event, spares the fresh one, and reports the counter', async () => {
    // The retention route is a GLOBAL, cross-org sweep (systemPrisma, no
    // organizationId filter on any of its queries) — same shape as the
    // cross-org aggregates costs-route.db.test.ts and models-route-demo.db.
    // test.ts serialize against each other with a shared Postgres advisory
    // lock, for the same reason: this suite runs concurrently against a
    // shared bs_ci_repro database, so this test's own sweep invocation could
    // otherwise interleave with another cross-cutting global sweep touching
    // the same tables from a sibling test file. Holding the lock for the
    // GET call's whole duration keeps this test's own before/after deltas
    // (already org-scoped below) honest even under full-suite parallelism.
    //
    // The seed is inside the lock for the same reason the GET is: aged rows
    // left lying around before the lock is held are exactly what a sibling
    // sweep deletes, and a counter of 0 then reads as "the sweep missed them"
    // rather than "someone else got there first".
    const { GET } = await import('../route')
    const response = await prisma.$transaction(
      async (tx: any) => {
        await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(918273646)')
        await seedAgedFixtures()
        return GET(new Request('http://localhost/api/cron/retention', {
          headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
        }))
      },
      { timeout: 30_000, maxWait: 30_000 },
    )
    const body = await response.json()

    assert.equal(response.status, 200)
    assert.equal(body.success, true)
    assert.ok(typeof body.activityEventsDeleted === 'number', 'activityEventsDeleted counter present in JSON response')
    assert.ok(body.activityEventsDeleted >= 1, 'at least this test\'s stale event was swept')
    assert.ok(typeof body.activityTriggerClaimsPruned === 'number', 'activityTriggerClaimsPruned counter present in JSON response')
    assert.ok(body.activityTriggerClaimsPruned >= 1, 'at least this test\'s terminal claim was swept')

    const staleEventStillThere = await prisma.activityEvent.findFirst({ where: { id: ids.staleEvent, organizationId: ids.org } })
    assert.equal(staleEventStillThere, null, 'the 91-day-old event was deleted')

    const freshEventStillThere = await prisma.activityEvent.findFirst({ where: { id: ids.freshEvent, organizationId: ids.org } })
    assert.ok(freshEventStillThere, 'the fresh event survives the sweep')

    const terminalClaimStillThere = await prisma.activityTriggerClaim.findFirst({ where: { id: ids.staleTerminalClaim, organizationId: ids.org } })
    assert.equal(terminalClaimStillThere, null, 'the terminal claim was pruned')

    const staleClaimedGone = await prisma.activityTriggerClaim.findFirst({ where: { id: ids.staleClaimedClaim, organizationId: ids.org } })
    assert.equal(staleClaimedGone, null, 'a 91-day-old "claimed" row is a stranded crashed dispatch, not in-flight — it is pruned too')

    const freshClaimedStillThere = await prisma.activityTriggerClaim.findFirst({ where: { id: ids.freshClaimedClaim, organizationId: ids.org } })
    assert.ok(freshClaimedStillThere, 'a recent "claimed" row may genuinely be in flight and must survive')
  })
}
