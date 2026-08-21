import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

/**
 * `failPreparedRun` terminalizes a pre-created run whose execution crashed
 * outside the interpreter's own failure paths (e.g. dispatch threw before the
 * interpreter's end-of-run sweep ever ran). Without a matching step sweep, a
 * step left `running` when that happened stays `running` forever even though
 * its run is `failed` — this pins that the sweep closes it out too.
 */
const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  let seedTestOrg: any
  let failPreparedRun: any
  let seeded: any
  let flowId: string

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    ;({ seedTestOrg } = await import('@/lib/server/__tests__/test-auth'))
    ;({ failPreparedRun } = await import('@/features/flows/execute-flow'))
    seeded = await seedTestOrg(prisma)
    const flow = await prisma.flow.create({
      data: { name: 'Fail-prepared fixture', organizationId: seeded.organizationId, userId: seeded.userId, graph: { nodes: [], edges: [] } },
    })
    flowId = flow.id
  })

  after(async () => {
    if (seeded) await seeded.cleanup()
  })

  test('a running step is swept to failed when its prepared run is failed', async () => {
    const run = await prisma.flowRun.create({
      data: { flowId, status: 'running', organizationId: seeded.organizationId, userId: seeded.userId },
    })
    const step = await prisma.flowRunStep.create({
      data: { flowRunId: run.id, nodeId: 'agent-1', status: 'running', startedAt: new Date() },
    })

    await failPreparedRun(run.id, seeded.organizationId, 'dispatch crashed before execution started')

    const reloadedRun = await prisma.flowRun.findFirst({ where: { id: run.id, organizationId: seeded.organizationId } })
    assert.equal(reloadedRun.status, 'failed')

    const reloadedStep = await prisma.flowRunStep.findFirst({ where: { id: step.id, run: { organizationId: seeded.organizationId } } })
    assert.equal(reloadedStep.status, 'failed', 'the running step must not be left orphaned')
    assert.ok(reloadedStep.finishedAt)
  })

  test('a waiting run (not running) is left untouched, and so are its steps', async () => {
    const run = await prisma.flowRun.create({
      data: { flowId, status: 'waiting', organizationId: seeded.organizationId, userId: seeded.userId },
    })
    const step = await prisma.flowRunStep.create({
      data: { flowRunId: run.id, nodeId: 'wait-1', status: 'waiting', startedAt: new Date() },
    })

    await failPreparedRun(run.id, seeded.organizationId, 'should not apply')

    const reloadedRun = await prisma.flowRun.findFirst({ where: { id: run.id, organizationId: seeded.organizationId } })
    assert.equal(reloadedRun.status, 'waiting', 'a paused run must never be clobbered to failed')

    const reloadedStep = await prisma.flowRunStep.findFirst({ where: { id: step.id, run: { organizationId: seeded.organizationId } } })
    assert.equal(reloadedStep.status, 'waiting')
  })
}
