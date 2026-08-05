import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { NextRequest } from 'next/server'

// DB-gated: runs only under TEST_DATABASE_URL (CI-mode), like sibling DB tests.
// First real coverage of POST /api/flows/[id]/trigger — the inbound webhook.
const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  process.env.ENTITLEMENT_GATE = 'off'

  let prisma: any
  let hashToken: any
  let flushDetachedFlowExecutions: any
  let route: any
  const ids: Record<string, string> = {}
  const SECRET = 'test-webhook-secret-value'

  const stopGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', position: { x: 0, y: 0 }, data: {} },
      { id: 'stop', type: 'stop', position: { x: 0, y: 0 }, data: { reason: 'marker' } },
    ],
    edges: [{ id: 'e-stop', source: 'trigger', target: 'stop' }],
  }

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    ;({ hashToken } = await import('@/lib/crypto/secrets'))
    ;({ flushDetachedFlowExecutions } = await import('@/features/flows/execute-flow'))
    route = await import('../[id]/trigger/route')
    const org = await prisma.organization.create({ data: { name: 'TriggerRoute', slug: `trigger-route-${Date.now()}` } })
    ids.org = org.id
    const user = await prisma.user.create({ data: { supabaseId: crypto.randomUUID(), organizationId: org.id } })
    ids.user = user.id
  })

  after(async () => {
    await prisma.flow.deleteMany({ where: { organizationId: ids.org } })
    await prisma.organization.delete({ where: { id: ids.org } })
  })

  const mkFlow = (overrides: Record<string, unknown> = {}) =>
    prisma.flow.create({
      data: {
        name: 'webhook-target',
        organizationId: ids.org,
        userId: ids.user,
        status: 'ACTIVE',
        graph: stopGraph,
        publishedGraph: stopGraph,
        trigger: { type: 'webhook', webhookSecretHash: hashToken(SECRET), responseMode: 'immediately' },
        ...overrides,
      },
    })

  const post = (flowId: string, init: { secret?: string; body?: unknown; headers?: Record<string, string> } = {}) =>
    route.POST(
      new NextRequest(new URL(`http://test/api/flows/${flowId}/trigger`), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(init.secret === undefined ? { 'x-trigger-secret': SECRET } : init.secret ? { 'x-trigger-secret': init.secret } : {}),
          ...init.headers,
        },
        body: JSON.stringify(init.body ?? { hello: 'world' }),
      }),
    )

  test('a valid delivery WITHOUT replay headers starts a run (third-party senders cannot add custom headers)', async () => {
    const flow = await mkFlow()
    const res = await post(flow.id)
    assert.equal(res.status, 202)
    const body = await res.json()
    assert.equal(body.accepted, true)
    assert.ok(body.run.flowRunId)
    await flushDetachedFlowExecutions()
    const run = await prisma.flowRun.findUnique({ where: { id: body.run.flowRunId, organizationId: ids.org } })
    assert.equal(run.status, 'succeeded')
  })

  test('a wrong secret → 401', async () => {
    const flow = await mkFlow()
    assert.equal((await post(flow.id, { secret: 'wrong-secret' })).status, 401)
  })

  test('a valid secret against an UNPUBLISHED flow → 409 naming the arming problem, not 401', async () => {
    // The outage-shaped confusion: an unarmed (DRAFT) flow used to answer
    // 401 "Invalid trigger secret", sending the caller off to rotate
    // credentials when the fix is "publish the flow".
    const flow = await mkFlow({ status: 'DRAFT' })
    const res = await post(flow.id)
    assert.equal(res.status, 409)
    const body = await res.json()
    assert.match(body.error, /publish/i)
  })

  test('a valid secret against a DISABLED flow → 409, and a wrong secret against it → 401', async () => {
    const flow = await mkFlow({ status: 'DISABLED' })
    assert.equal((await post(flow.id)).status, 409)
    assert.equal((await post(flow.id, { secret: 'wrong-secret' })).status, 401)
  })

  test('a filtered delivery answers 200 with filtered:true and creates no run', async () => {
    const flow = await mkFlow({
      trigger: {
        type: 'webhook',
        webhookSecretHash: hashToken(SECRET),
        responseMode: 'immediately',
        condition: { clauses: [{ field: 'kind', op: 'equals', value: 'wanted' }] },
      },
    })
    const res = await post(flow.id, { body: { kind: 'unwanted' } })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.filtered, true)
    assert.equal(await prisma.flowRun.count({ where: { flowId: flow.id, organizationId: ids.org } }), 0)
  })

  test('replay headers, when provided, still dedupe: second identical delivery is duplicate:true with one run', async () => {
    const flow = await mkFlow()
    const replay = { 'x-trigger-delivery-id': 'evt_dup_1', 'x-trigger-timestamp': String(Date.now()) }
    const first = await post(flow.id, { headers: replay })
    assert.equal(first.status, 202)
    await flushDetachedFlowExecutions()
    const second = await post(flow.id, { headers: replay })
    assert.equal(second.status, 200)
    const body = await second.json()
    assert.equal(body.duplicate, true)
    assert.equal(await prisma.flowRun.count({ where: { flowId: flow.id, organizationId: ids.org } }), 1)
  })
}
