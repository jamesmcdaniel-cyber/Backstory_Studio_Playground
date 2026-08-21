import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

/**
 * DB-backed proof that dead-lettering a flow run never leaves an orphaned
 * `running` step behind. The mocked unit suite (dead-letter.test.ts) pins the
 * call shape; this exercises the real Postgres write path end to end.
 */
const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  let systemPrisma: any
  let seedTestOrg: any
  let recordFlowDeadLetter: any
  let seeded: any
  let flowId: string

  before(async () => {
    ;({ prisma, systemPrisma } = await import('@/lib/prisma'))
    ;({ seedTestOrg } = await import('@/lib/server/__tests__/test-auth'))
    ;({ recordFlowDeadLetter } = await import('../flow-dead-letter'))
    seeded = await seedTestOrg(prisma)
    const flow = await prisma.flow.create({
      data: { name: 'Dead-letter fixture', organizationId: seeded.organizationId, userId: seeded.userId, graph: { nodes: [], edges: [] } },
    })
    flowId = flow.id
  })

  after(async () => {
    if (seeded) await seeded.cleanup()
  })

  const stubDeps = () => ({
    db: systemPrisma,
    createQueue: (() => ({ add: async () => ({ id: '1' }) })) as never,
    logger: { error: () => {} } as never,
    capture: (() => {}) as never,
  })

  test('a dead-lettered run with a running step leaves that step failed, not orphaned running', async () => {
    const run = await prisma.flowRun.create({
      data: { flowId, status: 'running', organizationId: seeded.organizationId, userId: seeded.userId },
    })
    const step = await prisma.flowRunStep.create({
      data: { flowRunId: run.id, nodeId: 'agent-1', status: 'running', startedAt: new Date() },
    })

    await recordFlowDeadLetter(
      { queue: 'flow-execution', jobId: 'j1', flowRunId: run.id, organizationId: seeded.organizationId, data: {}, error: 'worker crashed' },
      stubDeps(),
    )

    const reloadedRun = await prisma.flowRun.findFirst({ where: { id: run.id, organizationId: seeded.organizationId } })
    assert.equal(reloadedRun.status, 'failed')

    const reloadedStep = await prisma.flowRunStep.findFirst({ where: { id: step.id, run: { organizationId: seeded.organizationId } } })
    assert.equal(reloadedStep.status, 'failed', 'the running step must not be left orphaned')
    assert.ok(reloadedStep.finishedAt, 'a swept step must record when it finished')
  })

  test('a step already terminal before the dead-letter is untouched', async () => {
    const run = await prisma.flowRun.create({
      data: { flowId, status: 'running', organizationId: seeded.organizationId, userId: seeded.userId },
    })
    const step = await prisma.flowRunStep.create({
      data: { flowRunId: run.id, nodeId: 'agent-1', status: 'succeeded', startedAt: new Date(), finishedAt: new Date() },
    })

    await recordFlowDeadLetter(
      { queue: 'flow-execution', jobId: 'j2', flowRunId: run.id, organizationId: seeded.organizationId, data: {}, error: 'worker crashed' },
      stubDeps(),
    )

    const reloadedStep = await prisma.flowRunStep.findFirst({ where: { id: step.id, run: { organizationId: seeded.organizationId } } })
    assert.equal(reloadedStep.status, 'succeeded', 'an already-terminal step must not be clobbered')
  })
}
