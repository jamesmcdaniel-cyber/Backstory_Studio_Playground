import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { NextRequest } from 'next/server'

/**
 * Task 10 (activity-event substrate): full-path proof, org-scoped and
 * delta-asserted (shared-DB safe — every row this file touches lives under a
 * dedicated org created in `before`, same convention as
 * src/app/api/slack/events/__tests__/route.db.test.ts and
 * src/lib/activity/__tests__/dispatch.db.test.ts).
 *
 * Traces the REAL path end to end: a signed HTTP POST at `/api/slack/events`
 * (Task 4) → `normalizeSlackEvent` (Task 2) → a persisted `ActivityEvent` row
 * → a durable `activity.dispatch` outbox row → `processOutboxBatch` (src/lib/
 * outbox.ts) draining it for real (not a hand-call to `dispatchActivityEvent`
 * — the topic wiring from receiver to dispatcher is exactly what this file
 * proves) → `dispatchActivityEvent` (Task 6) → an `ActivityTriggerClaim` row
 * → a real `FlowRun` whose `trigger` carries Slack thread context.
 *
 * The flow under test is published the way the real publish route
 * (src/app/api/flows/[id]/publish/route.ts) does its match-column write:
 * via `activityMatchColumns(trigger)` (src/lib/flows/trigger.ts), not
 * hand-rolled `activitySource`/`activityKinds` values — so a drift between
 * the matcher's expectations and the publish path's write would show up
 * here too.
 */

const RUNNABLE_GRAPH = {
  nodes: [
    { id: 'trigger', type: 'trigger', data: { trigger: { type: 'slack' } } },
    { id: 'step', type: 'transform', data: { fields: [{ name: 'ok', value: 'true' }] } },
  ],
  edges: [{ id: 'e1', source: 'trigger', target: 'step' }],
}

const TEST_DB = process.env.TEST_DATABASE_URL
const ENABLED = Boolean(TEST_DB)

if (!ENABLED) {
  test('activity-event substrate e2e (skipped: TEST_DATABASE_URL not set)', { skip: true }, () => {})
}

if (ENABLED) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'test-key'

  let systemPrisma: any
  let encryptSecret: (v: string) => string
  let processOutboxBatch: (limit?: number, now?: Date) => Promise<{ delivered: number; retried: number; failed: number }>
  let activityMatchColumns: (trigger: { type: 'slack'; [key: string]: unknown }) => { activitySource: string | null; activityKinds: string[] }

  const ids: Record<string, string> = {}
  const SIGNING_SECRET = 'e2e-slack-signing-secret'
  const TEAM_ID = 'T_E2E_TEST'
  const BOT_USER_ID = 'U_E2E_BOT'

  before(async () => {
    ;({ systemPrisma } = await import('@/lib/prisma'))
    ;({ encryptSecret } = await import('@/lib/crypto/secrets'))
    ;({ processOutboxBatch } = await import('@/lib/outbox'))
    ;({ activityMatchColumns } = await import('@/lib/flows/trigger'))

    const stamp = Date.now()
    const org = await systemPrisma.organization.create({ data: { name: 'Activity E2E', slug: `activity-e2e-${stamp}` } })
    ids.org = org.id
    const user = await systemPrisma.user.create({
      data: { supabaseId: crypto.randomUUID(), email: `activity-e2e-${stamp}@example.com`, name: 'E2E', organizationId: org.id },
    })
    ids.user = user.id

    await systemPrisma.integrationSecret.create({
      data: {
        organizationId: org.id,
        provider: 'slack',
        authType: 'api_key',
        authConfig: {
          apiKey: encryptSecret('xoxb-e2e-test-token'),
          signingSecret: encryptSecret(SIGNING_SECRET),
          teamId: TEAM_ID,
          botUserId: BOT_USER_ID,
        },
        isActive: true,
      },
    })

    // Published the way the real publish route does: trigger stored on the
    // graph's trigger node, match columns derived through the SAME shared
    // helper the publish route calls (activityMatchColumns), not hand-rolled.
    const slackTrigger = { type: 'slack' as const }
    const flow = await systemPrisma.flow.create({
      data: {
        name: 'Slack thread flow',
        organizationId: org.id,
        userId: user.id,
        status: 'ACTIVE',
        graph: RUNNABLE_GRAPH,
        publishedGraph: RUNNABLE_GRAPH,
        trigger: slackTrigger,
        ...activityMatchColumns(slackTrigger),
      },
    })
    ids.flow = flow.id
  })

  after(async () => {
    if (ids.org) {
      await systemPrisma.flowRun.deleteMany({ where: { organizationId: ids.org } })
      await systemPrisma.activityTriggerClaim.deleteMany({ where: { organizationId: ids.org } })
      await systemPrisma.outboxEvent.deleteMany({ where: { organizationId: ids.org } })
      await systemPrisma.activityEvent.deleteMany({ where: { organizationId: ids.org } })
      await systemPrisma.flow.deleteMany({ where: { organizationId: ids.org } })
      await systemPrisma.integrationSecret.deleteMany({ where: { organizationId: ids.org } })
      await systemPrisma.user.deleteMany({ where: { organizationId: ids.org } })
      await systemPrisma.organization.deleteMany({ where: { id: ids.org } })
    }
  })

  function sign(secret: string, timestamp: string, rawBody: string): string {
    const base = `v0:${timestamp}:${rawBody}`
    return `v0=${crypto.createHmac('sha256', secret).update(base, 'utf8').digest('hex')}`
  }

  let tsSeq = 0
  function nextTs(): string {
    tsSeq += 1
    return `${1750000000 + tsSeq}.000200`
  }
  function slackMsgSourceEventId(channel: string, ts: string): string {
    return `slack:msg:${channel}:${ts}`
  }

  function messageEnvelope(eventId: string, ts: string, overrides: Record<string, unknown> = {}) {
    return {
      token: 'legacy-verification-token',
      team_id: TEAM_ID,
      api_app_id: 'A_E2E',
      type: 'event_callback',
      event_id: eventId,
      event_time: Math.floor(Date.now() / 1000),
      event: {
        type: 'message',
        channel: 'C_E2E',
        user: 'U_HUMAN',
        text: 'hello from the e2e test',
        ts,
        ...overrides,
      },
    }
  }

  async function postSignedEvent(body: Record<string, unknown>) {
    const raw = JSON.stringify(body)
    const timestamp = String(Math.floor(Date.now() / 1000))
    const signature = sign(SIGNING_SECRET, timestamp, raw)
    const { POST } = await import('@/app/api/slack/events/route')
    return POST(
      new NextRequest('https://app.test/api/slack/events', {
        method: 'POST',
        body: raw,
        headers: {
          'content-type': 'application/json',
          'x-slack-request-timestamp': timestamp,
          'x-slack-signature': signature,
        },
      }),
    )
  }

  test('a. signed Slack message -> ActivityEvent -> real outbox drain -> claim -> FlowRun with thread context', async () => {
    const ts = nextTs()
    const eventId = `evt-e2e-a-${Date.now()}`
    const sourceEventId = slackMsgSourceEventId('C_E2E', ts)

    const res = await postSignedEvent(messageEnvelope(eventId, ts, { thread_ts: ts }))
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.ok, true)

    const events = await systemPrisma.activityEvent.findMany({ where: { organizationId: ids.org, source: 'slack', sourceEventId } })
    assert.equal(events.length, 1, 'the route persisted exactly one ActivityEvent')
    const activityEventId = events[0].id

    const outboxBefore = await systemPrisma.outboxEvent.findMany({
      where: { organizationId: ids.org, dedupeKey: `activity-dispatch:slack:${sourceEventId}` },
    })
    assert.equal(outboxBefore.length, 1, 'the route handed the event off through a durable activity.dispatch row')
    assert.equal(outboxBefore[0].status, 'pending')

    // Drain the REAL outbox processor — not a hand-call to
    // dispatchActivityEvent — so the topic wiring (activity.dispatch ->
    // dispatchActivityEvent, wired in src/lib/outbox.ts's deliver()) is
    // itself part of what this test proves.
    const drainResult = await processOutboxBatch(50)
    assert.ok(drainResult.delivered >= 1, 'at least this event\'s outbox row was delivered')

    const outboxAfter = await systemPrisma.outboxEvent.findFirst({ where: { id: outboxBefore[0].id } })
    assert.equal(outboxAfter?.status, 'delivered')

    const claim = await systemPrisma.activityTriggerClaim.findFirst({
      where: { organizationId: ids.org, activityEventId, flowId: ids.flow },
    })
    assert.ok(claim, 'a claim exists for this event+flow pair')
    assert.equal(claim.status, 'dispatched')
    assert.ok(claim.flowRunId, 'the dispatched claim carries a real flowRunId')

    const run = await systemPrisma.flowRun.findFirst({ where: { id: claim.flowRunId, organizationId: ids.org } })
    assert.ok(run, 'the claim\'s flowRunId resolves to a real FlowRun row')
    assert.equal(run.flowId, ids.flow)
    const runTrigger = run.trigger as Record<string, unknown>
    assert.equal(runTrigger.type, 'slack')
    assert.equal(runTrigger.activityEventId, activityEventId)
    const subject = runTrigger.subject as Record<string, unknown>
    assert.equal(subject.channelId, 'C_E2E', 'the run\'s trigger carries the Slack channel')
    assert.equal(subject.threadTs, ts, 'the run\'s trigger carries the thread context for in-thread replies')

    ids.scenarioAActivityEventId = activityEventId
    ids.scenarioAOutboxId = outboxBefore[0].id
    ids.scenarioARunId = claim.flowRunId
  })

  test('b. the identical POST replayed, plus a redelivered outbox row, fires no second run (row-level AND claim-level dedupe)', async () => {
    const ts = nextTs()
    const eventId = `evt-e2e-b-${Date.now()}`
    const sourceEventId = slackMsgSourceEventId('C_E2E', ts)
    const envelope = messageEnvelope(eventId, ts)

    const first = await postSignedEvent(envelope)
    assert.equal(first.status, 200)
    await processOutboxBatch(50)

    const eventsAfterFirst = await systemPrisma.activityEvent.findMany({ where: { organizationId: ids.org, source: 'slack', sourceEventId } })
    assert.equal(eventsAfterFirst.length, 1)
    const activityEventId = eventsAfterFirst[0].id
    const runsAfterFirst = await systemPrisma.flowRun.count({ where: { flowId: ids.flow, organizationId: ids.org, trigger: { path: ['activityEventId'], equals: activityEventId } } })
    assert.equal(runsAfterFirst, 1)

    // Row-level dedupe: the identical raw payload signed again (Slack's own
    // retry behavior) hits the ActivityEvent's [organizationId, source,
    // sourceEventId] unique index — the route swallows the P2002 as an ack
    // and writes no second outbox row either.
    const replay = await postSignedEvent(envelope)
    assert.equal(replay.status, 200)
    const eventsAfterReplay = await systemPrisma.activityEvent.findMany({ where: { organizationId: ids.org, source: 'slack', sourceEventId } })
    assert.equal(eventsAfterReplay.length, 1, 'row-level dedupe: still exactly one ActivityEvent')
    const outboxRows = await systemPrisma.outboxEvent.findMany({
      where: { organizationId: ids.org, dedupeKey: `activity-dispatch:slack:${sourceEventId}` },
    })
    assert.equal(outboxRows.length, 1, 'row-level dedupe: still exactly one outbox row')

    // Claim-level dedupe: simulate a genuine redelivery of the SAME durable
    // outbox row (e.g. a stale-lock reclaim after a worker crash) by putting
    // it back to 'pending' and draining through the real processor again.
    // dispatchActivityEvent must be safe to run twice for the same event —
    // the claim's [organizationId, activityEventId, flowId] unique index is
    // what makes the second attempt a no-op rather than a second run.
    await systemPrisma.outboxEvent.update({ where: { id: outboxRows[0].id }, data: { status: 'pending', lockedAt: null } })
    const redrain = await processOutboxBatch(50)
    assert.ok(redrain.delivered >= 1, 'the redelivered row was picked up and processed again')

    const claims = await systemPrisma.activityTriggerClaim.findMany({
      where: { organizationId: ids.org, activityEventId, flowId: ids.flow },
    })
    assert.equal(claims.length, 1, 'claim-level dedupe: still exactly one claim for this event+flow pair')
    assert.equal(claims[0].status, 'dispatched')

    const runsAfterRedrain = await systemPrisma.flowRun.count({ where: { flowId: ids.flow, organizationId: ids.org, trigger: { path: ['activityEventId'], equals: activityEventId } } })
    assert.equal(runsAfterRedrain, 1, 'no second run from the redelivered outbox row')
  })

  test('c. a bot-self message persists selfOrigin: true and fires no run', async () => {
    const ts = nextTs()
    const eventId = `evt-e2e-c-${Date.now()}`
    const sourceEventId = slackMsgSourceEventId('C_E2E', ts)

    const res = await postSignedEvent(messageEnvelope(eventId, ts, { user: BOT_USER_ID }))
    assert.equal(res.status, 200)

    const events = await systemPrisma.activityEvent.findMany({ where: { organizationId: ids.org, source: 'slack', sourceEventId } })
    assert.equal(events.length, 1)
    assert.equal(events[0].selfOrigin, true, 'authored by the workspace\'s own captured botUserId')
    const activityEventId = events[0].id

    const drained = await processOutboxBatch(50)
    assert.ok(drained.delivered >= 1)

    const claims = await systemPrisma.activityTriggerClaim.findMany({ where: { organizationId: ids.org, activityEventId } })
    assert.equal(claims.length, 0, 'self-origin events never reach the flow-matching loop, so no claim is created')

    const runs = await systemPrisma.flowRun.count({ where: { flowId: ids.flow, organizationId: ids.org, trigger: { path: ['activityEventId'], equals: activityEventId } } })
    assert.equal(runs, 0)
  })

  test('d. a flow already at its hourly cap throttles the next match instead of dispatching a run', async () => {
    // Seed the trailing hour with 60 claims (any status counts toward
    // ACTIVITY_RUNS_PER_FLOW_PER_HOUR's default cap of 60) rather than
    // literally dispatching 60 runs through the HTTP path — the throttle
    // condition in dispatch.ts is `recentClaims >= cap`, so this reproduces
    // exactly the state a real 60-in-an-hour burst would leave behind.
    const seedClaims = Array.from({ length: 60 }, () => ({
      organizationId: ids.org,
      activityEventId: crypto.randomUUID(),
      flowId: ids.flow,
      status: 'dispatched',
    }))
    await systemPrisma.activityTriggerClaim.createMany({ data: seedClaims })

    const claimsBefore = await systemPrisma.activityTriggerClaim.count({ where: { organizationId: ids.org, flowId: ids.flow } })

    const ts = nextTs()
    const eventId = `evt-e2e-d-${Date.now()}`
    const sourceEventId = slackMsgSourceEventId('C_E2E', ts)
    const res = await postSignedEvent(messageEnvelope(eventId, ts))
    assert.equal(res.status, 200)

    const events = await systemPrisma.activityEvent.findMany({ where: { organizationId: ids.org, source: 'slack', sourceEventId } })
    assert.equal(events.length, 1)
    const activityEventId = events[0].id

    const runsBefore = await systemPrisma.flowRun.count({ where: { flowId: ids.flow, organizationId: ids.org } })

    const drained = await processOutboxBatch(50)
    assert.ok(drained.delivered >= 1)

    const claimsAfter = await systemPrisma.activityTriggerClaim.count({ where: { organizationId: ids.org, flowId: ids.flow } })
    assert.equal(claimsAfter, claimsBefore + 1, 'the burst event produced exactly one MORE claim (the throttled one), no run-producing claim')

    const throttledClaim = await systemPrisma.activityTriggerClaim.findFirst({
      where: { organizationId: ids.org, activityEventId, flowId: ids.flow },
    })
    assert.ok(throttledClaim, 'the throttled claim is visible for this specific event')
    assert.equal(throttledClaim.status, 'throttled')
    assert.equal(throttledClaim.flowRunId, null, 'a throttled claim never carries a flowRunId')

    const runsAfter = await systemPrisma.flowRun.count({ where: { flowId: ids.flow, organizationId: ids.org } })
    assert.equal(runsAfter, runsBefore, 'no run was produced for the throttled event — the cap held')
  })
}
