import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

const TEST_DB = process.env.TEST_DATABASE_URL
const ENABLED = Boolean(TEST_DB)

if (!ENABLED) {
  test('signal receiver (skipped: TEST_DATABASE_URL not set)', { skip: true }, () => {})
}

if (ENABLED) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  process.env.PEOPLE_AI_WEBHOOK_SECRET = 'whsec_receiver_test'
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'test-key'

  let prisma: any
  let POST: any
  let signPayload: any
  const ids: Record<string, string> = {}
  const TEAM = `team-recv-${Date.now()}`

  function requestFor(body: string, header?: string | null) {
    return new Request('https://studio.example.com/api/signals/people-ai', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(header ? { 'x-peopleai-signature': header } : {}),
        'x-forwarded-for': `10.0.0.${Math.floor(Math.random() * 250)}`,
      },
      body,
    }) as any
  }

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    ;({ POST } = await import('../route'))
    ;({ signPayload } = await import('@/lib/signals/verify'))
    const org = await prisma.organization.create({
      data: { name: 'Recv', slug: `recv-${Date.now()}`, peopleAiTeamId: TEAM },
    })
    ids.org = org.id
  })

  after(async () => {
    await prisma.outboxEvent.deleteMany({ where: { organizationId: ids.org } })
    await prisma.signal.deleteMany({ where: { organizationId: ids.org } })
    await prisma.organization.deleteMany({ where: { id: ids.org } })
    await prisma.$disconnect()
  })

  test('valid signed event is persisted and 202-acknowledged', async () => {
    const body = JSON.stringify({
      type: 'deal.risk_detected',
      id: `evt-${Date.now()}`,
      team_id: TEAM,
      data: { opportunity_id: 'opp-9', risk_level: 'high' },
    })
    const response = await POST(requestFor(body, signPayload(body, 'whsec_receiver_test')))
    assert.equal(response.status, 202)
    const json = await response.json()
    assert.equal(json.success, true)
    assert.ok(json.signalId)

    const signal = await prisma.signal.findUnique({ where: { id: json.signalId, organizationId: ids.org } })
    assert.equal(signal.organizationId, ids.org)
    assert.equal(signal.opportunityId, 'opp-9')

    // The event must ALSO reach flow signal triggers — durably, via the
    // outbox (agent routing alone was the gap: flows never saw People.ai
    // events). Delivery is the outbox loop's job; the receiver's contract is
    // the pending row.
    const outbox = await prisma.outboxEvent.findFirst({
      where: { organizationId: ids.org, topic: 'flow.signal', aggregateId: json.signalId },
    })
    assert.ok(outbox, 'accepting a signal must enqueue a durable flow.signal outbox event')
    assert.equal(outbox.payload.signal, 'people-ai.deal.risk_detected')
    assert.equal(outbox.payload.payload.signalId, json.signalId)
  })

  test('replayed event is acknowledged as duplicate without a second row', async () => {
    const body = JSON.stringify({
      type: 'deal.stage_changed',
      id: 'evt-dup-1',
      team_id: TEAM,
      data: {},
    })
    const first = await POST(requestFor(body, signPayload(body, 'whsec_receiver_test')))
    assert.equal(first.status, 202)
    const second = await POST(requestFor(body, signPayload(body, 'whsec_receiver_test')))
    assert.equal(second.status, 200)
    const json = await second.json()
    assert.equal(json.duplicate, true)
    const count = await prisma.signal.count({ where: { dedupeKey: 'evt-dup-1', organizationId: ids.org } })
    assert.equal(count, 1)
  })

  test('bad signature is rejected with 401 and stores nothing', async () => {
    const body = JSON.stringify({ type: 'insight.generated', id: 'evt-bad', team_id: TEAM })
    const response = await POST(requestFor(body, 'deadbeef'.repeat(8)))
    assert.equal(response.status, 401)
    const count = await prisma.signal.count({ where: { dedupeKey: 'evt-bad', organizationId: ids.org } })
    assert.equal(count, 0)
  })

  test('unknown team is acknowledged but dropped', async () => {
    const body = JSON.stringify({ type: 'forecast.updated', id: 'evt-orphan', team_id: 'no-such-team' })
    const response = await POST(requestFor(body, signPayload(body, 'whsec_receiver_test')))
    assert.equal(response.status, 202)
    const json = await response.json()
    assert.equal(json.dropped, true)
  })

  test('unknown event type is acknowledged and ignored', async () => {
    const body = JSON.stringify({ type: 'billing.invoice_paid', id: 'evt-x', team_id: TEAM })
    const response = await POST(requestFor(body, signPayload(body, 'whsec_receiver_test')))
    assert.equal(response.status, 202)
    const json = await response.json()
    assert.equal(json.ignored, true)
  })

  // The next two tests mint/rotate a per-org secret for `ids.org`, so they
  // run last — every earlier test above relies on the global secret alone.

  test('org with a per-org secret accepts only its own signature', async () => {
    const { rotateOrgWebhookSecret } = await import('@/lib/peopleai/webhook-secret')
    const perOrg = await rotateOrgWebhookSecret(ids.org)

    const body = JSON.stringify({
      type: 'deal.risk_detected',
      id: `evt-perorg-${Date.now()}`,
      team_id: TEAM,
      data: { opportunity_id: 'opp-perorg' },
    })
    const okRes = await POST(requestFor(body, signPayload(body, perOrg)))
    assert.equal(okRes.status, 202)

    const body2 = JSON.stringify({
      type: 'deal.risk_detected',
      id: `evt-global-${Date.now()}`,
      team_id: TEAM,
      data: { opportunity_id: 'opp-global' },
    })
    const globalRes = await POST(requestFor(body2, signPayload(body2, 'whsec_receiver_test')))
    assert.equal(globalRes.status, 401) // global secret no longer reaches an org with its own
  })

  test('org without a per-org secret still accepts the global secret', async () => {
    const bareTeam = `team-bare-${Date.now()}`
    const bareOrg = await prisma.organization.create({
      data: { name: 'RecvBare', slug: `recv-bare-${Date.now()}`, peopleAiTeamId: bareTeam },
    })
    try {
      const body = JSON.stringify({
        type: 'deal.risk_detected',
        id: `evt-bare-${Date.now()}`,
        team_id: bareTeam,
        data: { opportunity_id: 'opp-bare' },
      })
      const response = await POST(requestFor(body, signPayload(body, 'whsec_receiver_test')))
      assert.equal(response.status, 202)
      const json = await response.json()
      assert.equal(json.success, true)
    } finally {
      await prisma.signal.deleteMany({ where: { organizationId: bareOrg.id } })
      await prisma.organization.delete({ where: { id: bareOrg.id } })
    }
  })
}
