import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'

/**
 * Cancelling a run has two shapes. A `running` run has a live executor
 * polling for `cancelling` and finishing the job itself, so the route only
 * hands off the flag. A `waiting` run has NO executor — nothing would ever
 * flip `cancelling` to `cancelled` — so leaving it there is a permanent dead
 * end. This pins that a waiting run is cancelled immediately, in the same
 * request, with its open step rows swept.
 */
const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  let seedTestOrg: any
  let installTestAuth: any
  let POST: any
  let seeded: any
  let flowId: string

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    ;({ seedTestOrg, installTestAuth } = await import('@/lib/server/__tests__/test-auth'))
    ;({ POST } = await import('../[id]/cancel/route'))
    seeded = await seedTestOrg(prisma)
    installTestAuth(seeded.auth)
    const flow = await prisma.flow.create({
      data: { name: 'Cancel fixture', organizationId: seeded.organizationId, userId: seeded.userId, graph: { nodes: [], edges: [] } },
    })
    flowId = flow.id
  })

  const post = (flowRunId: string) =>
    POST(
      new NextRequest(new URL(`http://test/api/flows/${flowId}/cancel`), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ flowRunId }),
      }),
    )

  test('cancelling a waiting run lands cancelled immediately, with its open steps swept', async () => {
    const run = await prisma.flowRun.create({
      data: { flowId, status: 'waiting', organizationId: seeded.organizationId, userId: seeded.userId },
    })
    const runningStep = await prisma.flowRunStep.create({
      data: { flowRunId: run.id, nodeId: 'a', status: 'running', startedAt: new Date() },
    })
    const waitingStep = await prisma.flowRunStep.create({
      data: { flowRunId: run.id, nodeId: 'b', status: 'waiting', startedAt: new Date() },
    })
    const doneStep = await prisma.flowRunStep.create({
      data: { flowRunId: run.id, nodeId: 'c', status: 'succeeded', startedAt: new Date(), finishedAt: new Date() },
    })

    const response = await post(run.id)
    const body = await response.json()
    assert.equal(response.status, 200, JSON.stringify(body))
    assert.equal(body.status, 'cancelled', 'a waiting run has no executor, so the route must finish it directly')

    const reloadedRun = await prisma.flowRun.findFirst({ where: { id: run.id, organizationId: seeded.organizationId } })
    assert.equal(reloadedRun.status, 'cancelled')
    assert.ok(reloadedRun.finishedAt)

    const scope = { run: { organizationId: seeded.organizationId } }
    assert.equal((await prisma.flowRunStep.findFirst({ where: { id: runningStep.id, ...scope } })).status, 'cancelled')
    assert.equal((await prisma.flowRunStep.findFirst({ where: { id: waitingStep.id, ...scope } })).status, 'cancelled')
    assert.equal(
      (await prisma.flowRunStep.findFirst({ where: { id: doneStep.id, ...scope } })).status,
      'succeeded',
      'an already-terminal step must not be clobbered',
    )
  })

  test('cancelling a running run still only flips to cancelling, for the executor to finish', async () => {
    const run = await prisma.flowRun.create({
      data: { flowId, status: 'running', organizationId: seeded.organizationId, userId: seeded.userId },
    })

    const response = await post(run.id)
    const body = await response.json()
    assert.equal(response.status, 200, JSON.stringify(body))
    assert.equal(body.status, 'cancelling')

    const reloadedRun = await prisma.flowRun.findFirst({ where: { id: run.id, organizationId: seeded.organizationId } })
    assert.equal(reloadedRun.status, 'cancelling', 'a running run must hand off to the executor, not be finished here')
    assert.equal(reloadedRun.finishedAt, null)
  })

  test('cancelling an already-terminal run is refused', async () => {
    const run = await prisma.flowRun.create({
      data: { flowId, status: 'succeeded', organizationId: seeded.organizationId, userId: seeded.userId, finishedAt: new Date() },
    })

    const response = await post(run.id)
    assert.equal(response.status, 409)
  })
}
