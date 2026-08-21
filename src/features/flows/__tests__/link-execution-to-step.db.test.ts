import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

/**
 * `onExecutionCreated` (execute-flow.ts) links a live AgentExecution id onto
 * its FlowRunStep the moment the execution row exists — before that step's
 * own terminal write lands. Every OTHER write to a step row is status-guarded
 * to 'running' so a sweep (timeout, dead-letter, cancel) is never clobbered by
 * a late arrival; this one previously used a bare `.update`, which had no
 * such guard and could resurrect an already-terminal row.
 */
const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  let seedTestOrg: any
  let linkExecutionToRunningStep: any
  let seeded: any
  let flowId: string

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    ;({ seedTestOrg } = await import('@/lib/server/__tests__/test-auth'))
    ;({ linkExecutionToRunningStep } = await import('@/features/flows/execute-flow'))
    seeded = await seedTestOrg(prisma)
    const flow = await prisma.flow.create({
      data: { name: 'Link fixture', organizationId: seeded.organizationId, userId: seeded.userId, graph: { nodes: [], edges: [] } },
    })
    flowId = flow.id
  })

  after(async () => {
    if (seeded) await seeded.cleanup()
  })

  test('a running step is linked to its execution', async () => {
    const run = await prisma.flowRun.create({
      data: { flowId, status: 'running', organizationId: seeded.organizationId, userId: seeded.userId },
    })
    const step = await prisma.flowRunStep.create({
      data: { flowRunId: run.id, nodeId: 'agent-1', status: 'running', startedAt: new Date() },
    })

    await linkExecutionToRunningStep(step.id, 'exec-1')

    const reloaded = await prisma.flowRunStep.findFirst({ where: { id: step.id, run: { organizationId: seeded.organizationId } } })
    assert.equal(reloaded.agentExecutionId, 'exec-1')
  })

  test('a step already terminal (e.g. swept to failed by a timeout) is a no-op, never resurrected', async () => {
    const run = await prisma.flowRun.create({
      data: { flowId, status: 'failed', organizationId: seeded.organizationId, userId: seeded.userId, finishedAt: new Date() },
    })
    const step = await prisma.flowRunStep.create({
      data: {
        flowRunId: run.id,
        nodeId: 'agent-1',
        status: 'failed',
        startedAt: new Date(),
        finishedAt: new Date(),
        error: 'step timed out',
      },
    })

    // A late-arriving execution-created callback from the abandoned agent
    // promise, after the sweep already closed the row.
    await linkExecutionToRunningStep(step.id, 'exec-late')

    const reloaded = await prisma.flowRunStep.findFirst({ where: { id: step.id, run: { organizationId: seeded.organizationId } } })
    assert.equal(reloaded.status, 'failed', 'the sweep is authoritative — a late write must not flip it back')
    assert.equal(reloaded.agentExecutionId, null, 'a terminal row must not be written to at all')
  })
}
