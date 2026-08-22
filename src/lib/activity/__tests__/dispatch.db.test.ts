import { test, before } from 'node:test'
import assert from 'node:assert/strict'

/**
 * DB-backed coverage for the activity-event dispatcher (src/lib/activity/
 * dispatch.ts, Task 6 of the activity-event substrate plan): indexed
 * matching, exactly-once claims, the rolling per-flow throttle, and the two
 * loop guards (selfOrigin / chainDepth cap). Runs only against
 * TEST_DATABASE_URL — CI-mode DB suite, not the local gate.
 */

// Minimal RUNNABLE graph: execute-flow.ts requires at least one real step
// (validateFlowGraph's NO_STEPS check), so a bare trigger node is not enough
// to actually dispatch a run. A single no-op `transform` step (no connection,
// no agent) is the cheapest step that satisfies that check.
const RUNNABLE_GRAPH = {
  nodes: [
    { id: 'trigger', type: 'trigger', data: { trigger: { type: 'manual' } } },
    { id: 'step', type: 'transform', data: { fields: [{ name: 'ok', value: 'true' }] } },
  ],
  edges: [{ id: 'e1', source: 'trigger', target: 'step' }],
}

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  let dispatchActivityEvent: any
  const ids: Record<string, string> = {}

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    ;({ dispatchActivityEvent } = await import('../dispatch'))

    const stamp = Date.now()
    const org = await prisma.organization.create({ data: { name: 'Activity Dispatch', slug: `activity-dispatch-${stamp}` } })
    ids.org = org.id
    const user = await prisma.user.create({
      data: { supabaseId: crypto.randomUUID(), email: `activity-dispatch-${stamp}@example.com`, name: 'A', organizationId: org.id },
    })
    ids.user = user.id

    const flow = await prisma.flow.create({
      data: {
        name: 'GitHub PR flow',
        organizationId: org.id,
        userId: user.id,
        status: 'ACTIVE',
        graph: RUNNABLE_GRAPH,
        publishedGraph: RUNNABLE_GRAPH,
        trigger: { type: 'activity', source: 'github', kinds: ['pr.opened'] },
        activitySource: 'github',
        activityKinds: ['pr.opened'],
      },
    })
    ids.flow = flow.id
  })

  function makeEvent(overrides: Record<string, unknown> = {}) {
    const stamp = `${Date.now()}-${Math.random()}`
    return prisma.activityEvent.create({
      data: {
        organizationId: ids.org,
        source: 'github',
        sourceEventId: `evt-${stamp}`,
        kind: 'pr.opened',
        occurredAt: new Date(),
        payload: { number: 7, action: 'opened' },
        ...overrides,
      },
    })
  }

  test('a matching flow fires exactly once, and a duplicate dispatch call fires zero', async () => {
    const event = await makeEvent()

    const first = await dispatchActivityEvent(event.id)
    assert.equal(first.outcomes.length, 1)
    assert.equal(first.outcomes[0].flowId, ids.flow)
    assert.equal(first.outcomes[0].outcome, 'dispatched')

    const claim = await prisma.activityTriggerClaim.findFirst({
      where: { organizationId: ids.org, activityEventId: event.id, flowId: ids.flow },
    })
    assert.ok(claim)
    assert.equal(claim.status, 'dispatched')
    assert.ok(claim.flowRunId)

    const runsAfterFirst = await prisma.flowRun.count({ where: { flowId: ids.flow, organizationId: ids.org } })
    assert.equal(runsAfterFirst, 1)

    // Redelivery of the same outbox row (crash/stale-lock reclaim) must not
    // fire a second run — the claim's unique index makes the create a P2002.
    const second = await dispatchActivityEvent(event.id)
    assert.equal(second.outcomes.length, 1)
    assert.equal(second.outcomes[0].outcome, 'duplicate')

    const runsAfterSecond = await prisma.flowRun.count({ where: { flowId: ids.flow, organizationId: ids.org } })
    assert.equal(runsAfterSecond, 1)
  })

  test('selfOrigin, backfill, and depth-cap events fire nothing', async () => {
    const selfOriginEvent = await makeEvent({ selfOrigin: true })
    const selfResult = await dispatchActivityEvent(selfOriginEvent.id)
    assert.equal(selfResult.skipped, 'self-origin')
    assert.equal(selfResult.outcomes.length, 0)

    const backfillEvent = await makeEvent({ backfill: true })
    const backfillResult = await dispatchActivityEvent(backfillEvent.id)
    assert.equal(backfillResult.skipped, 'backfill')
    assert.equal(backfillResult.outcomes.length, 0)

    const deepEvent = await makeEvent({ chainDepth: 3 })
    const deepResult = await dispatchActivityEvent(deepEvent.id)
    assert.equal(deepResult.skipped, 'depth-cap')
    assert.equal(deepResult.outcomes.length, 0)

    // None of these produced a claim or a run.
    const claims = await prisma.activityTriggerClaim.count({
      where: {
        organizationId: ids.org,
        flowId: ids.flow,
        activityEventId: { in: [selfOriginEvent.id, backfillEvent.id, deepEvent.id] },
      },
    })
    assert.equal(claims, 0)
  })

  test('a non-matching kind fires nothing (the indexed query excludes the flow)', async () => {
    const event = await makeEvent({ kind: 'pr.merged', sourceEventId: `evt-nonmatch-${Date.now()}` })
    const result = await dispatchActivityEvent(event.id)
    assert.equal(result.outcomes.length, 0)
  })

  test('the 61st claim in an hour is throttled, not dispatched', async () => {
    const stamp = Date.now()
    const org = await prisma.organization.create({ data: { name: 'Throttle Org', slug: `throttle-org-${stamp}` } })
    const user = await prisma.user.create({
      data: { supabaseId: crypto.randomUUID(), email: `throttle-${stamp}@example.com`, name: 'T', organizationId: org.id },
    })
    const flow = await prisma.flow.create({
      data: {
        name: 'Throttled flow',
        organizationId: org.id,
        userId: user.id,
        status: 'ACTIVE',
        graph: RUNNABLE_GRAPH,
        publishedGraph: RUNNABLE_GRAPH,
        trigger: { type: 'activity', source: 'github', kinds: ['pr.opened'] },
        activitySource: 'github',
        activityKinds: ['pr.opened'],
      },
    })

    // Seed 60 claims in the trailing hour — any status counts toward the cap.
    await prisma.activityTriggerClaim.createMany({
      data: Array.from({ length: 60 }, () => ({
        organizationId: org.id,
        activityEventId: crypto.randomUUID(),
        flowId: flow.id,
        status: 'dispatched',
      })),
    })

    const event = await prisma.activityEvent.create({
      data: {
        organizationId: org.id,
        source: 'github',
        sourceEventId: `evt-throttle-${stamp}`,
        kind: 'pr.opened',
        occurredAt: new Date(),
        payload: { number: 61 },
      },
    })

    const result = await dispatchActivityEvent(event.id)
    assert.equal(result.outcomes.length, 1)
    assert.equal(result.outcomes[0].outcome, 'throttled')

    const claim = await prisma.activityTriggerClaim.findFirst({
      where: { organizationId: org.id, activityEventId: event.id, flowId: flow.id },
    })
    assert.equal(claim?.status, 'throttled')

    const runs = await prisma.flowRun.count({ where: { flowId: flow.id, organizationId: org.id } })
    assert.equal(runs, 0)
  })

  test('owner ladder WARN+skip: no active member in the org fails the claim without a run', async () => {
    const stamp = Date.now()
    const org = await prisma.organization.create({ data: { name: 'Ownerless Org', slug: `ownerless-org-${stamp}` } })
    const flow = await prisma.flow.create({
      data: {
        name: 'Ownerless flow',
        organizationId: org.id,
        userId: null,
        status: 'ACTIVE',
        graph: RUNNABLE_GRAPH,
        publishedGraph: RUNNABLE_GRAPH,
        trigger: { type: 'activity', source: 'github', kinds: ['pr.opened'] },
        activitySource: 'github',
        activityKinds: ['pr.opened'],
      },
    })
    const event = await prisma.activityEvent.create({
      data: {
        organizationId: org.id,
        source: 'github',
        sourceEventId: `evt-ownerless-${stamp}`,
        kind: 'pr.opened',
        occurredAt: new Date(),
        payload: {},
      },
    })

    const result = await dispatchActivityEvent(event.id)
    assert.equal(result.outcomes.length, 1)
    assert.equal(result.outcomes[0].outcome, 'skipped')
    assert.equal((result.outcomes[0] as { reason: string }).reason, 'no active owner')

    const claim = await prisma.activityTriggerClaim.findFirst({
      where: { organizationId: org.id, activityEventId: event.id, flowId: flow.id },
    })
    assert.equal(claim?.status, 'failed')

    const runs = await prisma.flowRun.count({ where: { flowId: flow.id, organizationId: org.id } })
    assert.equal(runs, 0)
  })
}
