import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'

/**
 * What fires after its owner is gone.
 *
 * The schedule tick already stopped a deprovisioned owner's work, but the other
 * entry points each carried their own attribution and quarantine rules — so the
 * same agent stopped on its schedule and kept running from its webhook, as
 * another member. These pin the shared rule at the database, and the two places
 * that used to leave a dead owner's rows wedged: timer waits and the webhook.
 */
const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  let seeded: any
  let resolveRunOwner: any
  let failOwnerlessWaits: any
  let OWNERLESS_WAIT_ERROR: string
  let hashToken: any
  const ids: Record<string, string> = {}

  const member = (over: Record<string, unknown> = {}) =>
    prisma.user.create({ data: { supabaseId: crypto.randomUUID(), organizationId: seeded.organizationId, isActive: true, ...over } })

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    ;({ resolveRunOwner } = await import('../owners'))
    ;({ failOwnerlessWaits, OWNERLESS_WAIT_ERROR } = await import('@/lib/flows/reap'))
    ;({ hashToken } = await import('@/lib/crypto/secrets'))
    const { seedTestOrg } = await import('@/lib/server/__tests__/test-auth')
    // The seeded user is created first, so it is the org's oldest member — the
    // fallback every shared row resolves to below.
    seeded = await seedTestOrg(prisma)
    const flow = await prisma.flow.create({
      data: { name: 'Owner lifecycle', organizationId: seeded.organizationId, userId: seeded.userId, graph: { nodes: [], edges: [] } },
    })
    ids.flow = flow.id
  })

  after(async () => {
    if (seeded) await seeded.cleanup()
  })

  test('the shared rule: deprovisioned owner stops, moved or absent owner falls back, shared runs as the oldest member', async () => {
    const suspended = await member({ isActive: false })
    const other = await prisma.organization.create({ data: { name: 'Elsewhere', slug: `elsewhere-${crypto.randomUUID()}` } })
    try {
      const moved = await prisma.user.create({ data: { supabaseId: crypto.randomUUID(), organizationId: other.id, isActive: true } })
      const org = seeded.organizationId

      assert.equal(await resolveRunOwner({ id: 'r1', organizationId: org, userId: suspended.id }), null)
      assert.equal(await resolveRunOwner({ id: 'r2', organizationId: org, userId: moved.id }), seeded.userId)
      assert.equal(await resolveRunOwner({ id: 'r3', organizationId: org, userId: null }), seeded.userId)
      assert.equal(await resolveRunOwner({ id: 'r4', organizationId: org, userId: crypto.randomUUID() }), seeded.userId)
    } finally {
      await prisma.organization.delete({ where: { id: other.id } }).catch(() => {})
    }
  })

  test('a timer wait nobody may resume is failed and leaves the resume queue', async () => {
    const gone = await member({ isActive: false })
    const resumeAt = new Date(Date.now() - 60_000)
    const run = await prisma.flowRun.create({
      data: { flowId: ids.flow, status: 'waiting', resumeAt, organizationId: seeded.organizationId, userId: gone.id },
    })
    await prisma.flowRunStep.create({ data: { flowRunId: run.id, nodeId: 'wait-1', status: 'waiting' } })

    assert.equal(await failOwnerlessWaits([{ id: run.id, resumeAt }]), 1)

    const after = await prisma.flowRun.findFirst({ where: { id: run.id, organizationId: seeded.organizationId } })
    assert.equal(after.status, 'failed')
    assert.equal(after.error, OWNERLESS_WAIT_ERROR)
    assert.equal(after.resumeAt, null, 'resumeAt cleared, so the oldest-first read can never pick it again')
    const step = await prisma.flowRunStep.findFirst({ where: { flowRunId: run.id } })
    assert.equal(step.status, 'failed')
  })

  test('a wait that was resumed or rescheduled since the read is left alone', async () => {
    const readAt = new Date(Date.now() - 60_000)
    const run = await prisma.flowRun.create({
      data: { flowId: ids.flow, status: 'waiting', resumeAt: new Date(Date.now() + 3_600_000), organizationId: seeded.organizationId, userId: seeded.userId },
    })

    assert.equal(await failOwnerlessWaits([{ id: run.id, resumeAt: readAt }]), 0)

    const after = await prisma.flowRun.findFirst({ where: { id: run.id, organizationId: seeded.organizationId } })
    assert.equal(after.status, 'waiting')
  })

  test('the webhook-wait callback does not resume a deprovisioned owner’s run', async () => {
    const gone = await member({ isActive: false })
    const token = `tok-${crypto.randomUUID()}`
    const run = await prisma.flowRun.create({
      data: {
        flowId: ids.flow,
        status: 'waiting',
        resumeAt: new Date(Date.now() + 60_000),
        organizationId: seeded.organizationId,
        userId: gone.id,
        resumeTokenHash: hashToken(token),
      },
    })
    await prisma.flowRunStep.create({ data: { flowRunId: run.id, nodeId: 'wait-1', status: 'waiting', output: { waiting: { kind: 'webhook' } } } })
    const { POST } = await import('@/app/api/flows/[id]/runs/[runId]/resume/route')

    const response = await POST(
      new NextRequest(new URL(`http://test/api/flows/${ids.flow}/runs/${run.id}/resume?token=${token}`), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ok: true }),
      }),
    )
    assert.equal(response.status, 409, await response.text())
  })

  test('the agent webhook refuses a quarantined agent, and a deprovisioned owner’s agent, instead of running it as a colleague', async () => {
    const secret = `trig-${crypto.randomUUID()}`
    const gone = await member({ isActive: false })
    const { POST } = await import('@/app/api/agents/[id]/trigger/route')
    const fire = (agentId: string) =>
      POST(
        new NextRequest(new URL(`http://test/api/agents/${agentId}/trigger`), {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-trigger-secret': secret },
          body: JSON.stringify({}),
        } as never),
      )
    const agent = (over: Record<string, unknown>) =>
      prisma.agentTask.create({
        data: {
          description: 'lifecycle',
          objective: 'x',
          status: 'ACTIVE',
          organizationId: seeded.organizationId,
          metadata: { triggerSecretHash: hashToken(secret) },
          ...over,
        },
      })
    const countRuns = () => prisma.agentExecution.count({ where: { organizationId: seeded.organizationId } })
    const before = await countRuns()

    const quarantined = await agent({ userId: gone.id, quarantinedAt: new Date() })
    const quarantinedResponse = await fire(quarantined.id)
    assert.equal(quarantinedResponse.status, 409)
    assert.equal((await quarantinedResponse.json()).code, 'AGENT_QUARANTINED')

    // Deactivated without the revocation spine (the old domain-block path):
    // not quarantined, but its owner is gone. It used to run as the seeded user.
    const orphaned = await agent({ userId: gone.id })
    assert.equal((await fire(orphaned.id)).status, 409)

    assert.equal(await countRuns(), before, 'neither refusal may leave a run behind')
  })
}
