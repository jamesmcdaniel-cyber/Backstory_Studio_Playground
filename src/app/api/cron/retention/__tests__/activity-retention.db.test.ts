import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

/**
 * The 90-day retention sweep must reach the two new activity-substrate
 * tables: ActivityEvent rows and terminal ActivityTriggerClaim rows age out
 * exactly like signals/executions/flow runs do, with counters surfaced in
 * both the log line and the JSON response (house convention — see
 * cron/retention/route.ts).
 *
 * A 'claimed' (in-flight) claim must survive the sweep even past the cutoff —
 * only terminal statuses (dispatched/throttled/failed) are history.
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
  })

  after(async () => {
    if (!ids.org) return
    await prisma.activityTriggerClaim.deleteMany({ where: { organizationId: ids.org } })
    await prisma.activityEvent.deleteMany({ where: { organizationId: ids.org } })
    await prisma.organization.delete({ where: { id: ids.org } })
  })

  test('sweep deletes the 91-day-old event, spares the fresh one, and reports the counter', async () => {
    const { GET } = await import('../route')
    const response = await GET(new Request('http://localhost/api/cron/retention', {
      headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
    }))
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

    const claimedClaimStillThere = await prisma.activityTriggerClaim.findFirst({ where: { id: ids.staleClaimedClaim, organizationId: ids.org } })
    assert.ok(claimedClaimStillThere, 'an in-flight "claimed" claim is never swept, however old')
  })
}
