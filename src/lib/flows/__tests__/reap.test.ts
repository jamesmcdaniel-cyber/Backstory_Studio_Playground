import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

test('stuck-run cutoff exceeds the 1800s route budget', async () => {
  const { STUCK_FLOW_RUN_TIMEOUT_MS } = await import('../reap')
  assert.equal(STUCK_FLOW_RUN_TIMEOUT_MS, 45 * 60 * 1000)
  // A cutoff at or below the route's maxDuration reaps runs that are still
  // legitimately executing inside a request.
  assert.ok(STUCK_FLOW_RUN_TIMEOUT_MS > 1800 * 1000)
})

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  let reapStuckFlowRuns: any
  let reapNeverPickedUpRuns: any
  const ids: Record<string, string> = {}

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    ;({ reapStuckFlowRuns, reapNeverPickedUpRuns } = await import('../reap'))
    const org = await prisma.organization.create({ data: { name: 'Reap', slug: `reap-${Date.now()}` } })
    ids.org = org.id
    const flow = await prisma.flow.create({
      data: { name: 'reap-target', organizationId: org.id, status: 'ACTIVE', graph: { nodes: [], edges: [] } },
    })
    ids.flow = flow.id
    const stale = new Date(Date.now() - 31 * 60 * 1000)
    const fresh = new Date(Date.now() - 5 * 60 * 1000)
    ids.staleRunning = (
      await prisma.flowRun.create({
        data: { flowId: flow.id, organizationId: org.id, status: 'running', startedAt: stale },
      })
    ).id
    ids.staleStep = (
      await prisma.flowRunStep.create({
        data: { flowRunId: ids.staleRunning, nodeId: 'n1', status: 'running', startedAt: stale },
      })
    ).id
    ids.staleDoneStep = (
      await prisma.flowRunStep.create({
        data: { flowRunId: ids.staleRunning, nodeId: 'n0', status: 'succeeded', startedAt: stale },
      })
    ).id
    ids.freshRunning = (
      await prisma.flowRun.create({
        data: { flowId: flow.id, organizationId: org.id, status: 'running', startedAt: fresh },
      })
    ).id
    ids.staleWaiting = (
      await prisma.flowRun.create({
        data: { flowId: flow.id, organizationId: org.id, status: 'waiting', startedAt: stale },
      })
    ).id
  })

  after(async () => {
    await prisma.flow.deleteMany({ where: { organizationId: ids.org } })
    await prisma.organization.delete({ where: { id: ids.org } })
  })

  test('reapStuckFlowRuns fails only stale running runs and their live steps', async () => {
    const reaped = await reapStuckFlowRuns()
    assert.equal(reaped, 1)

    const staleRun = await prisma.flowRun.findUnique({ where: { id: ids.staleRunning, organizationId: ids.org } })
    assert.equal(staleRun.status, 'failed')
    assert.equal(staleRun.error, 'The run was interrupted and timed out.')
    assert.ok(staleRun.finishedAt)

    const staleStep = await prisma.flowRunStep.findUnique({ where: { id: ids.staleStep } })
    assert.equal(staleStep.status, 'failed')

    const doneStep = await prisma.flowRunStep.findUnique({ where: { id: ids.staleDoneStep } })
    assert.equal(doneStep.status, 'succeeded')

    const freshRun = await prisma.flowRun.findUnique({ where: { id: ids.freshRunning, organizationId: ids.org } })
    assert.equal(freshRun.status, 'running')

    const waitingRun = await prisma.flowRun.findUnique({ where: { id: ids.staleWaiting, organizationId: ids.org } })
    assert.equal(waitingRun.status, 'waiting')
  })

  test('reapStuckFlowRuns never touches steps of a run that legitimately leaves running before the write', async () => {
    const stale = new Date(Date.now() - 31 * 60 * 1000)
    const racingRun = await prisma.flowRun.create({
      data: { flowId: ids.flow, organizationId: ids.org, status: 'running', startedAt: stale },
    })
    const racingStep = await prisma.flowRunStep.create({
      data: { flowRunId: racingRun.id, nodeId: 'n2', status: 'running', startedAt: stale },
    })

    // racingRun IS a `running` candidate at read time — it enters runIds —
    // but the onAfterRead hook flips it to `waiting` (simulating a legitimate
    // approval pause) before the transaction's write executes. This is the
    // exact race the re-query step in reapStuckFlowRuns exists to handle.
    const reaped = await reapStuckFlowRuns(new Date(), async () => {
      await prisma.flowRun.update({ where: { id: racingRun.id, organizationId: ids.org }, data: { status: 'waiting' } })
    })
    assert.equal(reaped, 0) // racingRun diverted away before the transaction write

    const runAfter = await prisma.flowRun.findUnique({ where: { id: racingRun.id, organizationId: ids.org } })
    assert.equal(runAfter.status, 'waiting')

    const stepAfter = await prisma.flowRunStep.findUnique({ where: { id: racingStep.id } })
    assert.equal(stepAfter.status, 'running')
  })

  test('reapStuckFlowRuns is idempotent — second pass reaps nothing', async () => {
    assert.equal(await reapStuckFlowRuns(), 0)
  })

  test('mixed batch: a diverted run keeps its step, a genuinely-stuck sibling in the same call is reaped', async () => {
    const stale = new Date(Date.now() - 31 * 60 * 1000)
    const divertedRun = await prisma.flowRun.create({
      data: { flowId: ids.flow, organizationId: ids.org, status: 'running', startedAt: stale },
    })
    const divertedStep = await prisma.flowRunStep.create({
      data: { flowRunId: divertedRun.id, nodeId: 'n3', status: 'running', startedAt: stale },
    })
    const stuckRun = await prisma.flowRun.create({
      data: { flowId: ids.flow, organizationId: ids.org, status: 'running', startedAt: stale },
    })
    const stuckStep = await prisma.flowRunStep.create({
      data: { flowRunId: stuckRun.id, nodeId: 'n4', status: 'running', startedAt: stale },
    })

    // Both enter runIds as running+stale candidates; the hook diverts only
    // divertedRun before the transaction's write, leaving stuckRun as the
    // sole genuine reap in this call — proving reapedRuns narrows the batch
    // rather than the step update touching every id in runIds.
    const reaped = await reapStuckFlowRuns(new Date(), async () => {
      await prisma.flowRun.update({ where: { id: divertedRun.id, organizationId: ids.org }, data: { status: 'waiting' } })
    })
    assert.equal(reaped, 1)

    const divertedRunAfter = await prisma.flowRun.findUnique({ where: { id: divertedRun.id, organizationId: ids.org } })
    assert.equal(divertedRunAfter.status, 'waiting')
    const divertedStepAfter = await prisma.flowRunStep.findUnique({ where: { id: divertedStep.id } })
    assert.equal(divertedStepAfter.status, 'running')

    const stuckRunAfter = await prisma.flowRun.findUnique({ where: { id: stuckRun.id, organizationId: ids.org } })
    assert.equal(stuckRunAfter.status, 'failed')
    const stuckStepAfter = await prisma.flowRunStep.findUnique({ where: { id: stuckStep.id } })
    assert.equal(stuckStepAfter.status, 'failed')
  })

  test('reapNeverPickedUpRuns fails only zero-step running runs past the pickup window', async () => {
    // freshRunning (zero steps, seeded ~5 min ago) has aged past the pickup
    // window by now — settle it so this test's counts cover only its own runs.
    await prisma.flowRun.update({ where: { id: ids.freshRunning, organizationId: ids.org }, data: { status: 'succeeded' } })

    const strandedAge = new Date(Date.now() - 6 * 60 * 1000)
    const stranded = await prisma.flowRun.create({
      data: { flowId: ids.flow, organizationId: ids.org, status: 'running', startedAt: strandedAge },
    })
    const justDispatched = await prisma.flowRun.create({
      data: { flowId: ids.flow, organizationId: ids.org, status: 'running', startedAt: new Date(Date.now() - 60 * 1000) },
    })
    const pickedUp = await prisma.flowRun.create({
      data: { flowId: ids.flow, organizationId: ids.org, status: 'running', startedAt: strandedAge },
    })
    await prisma.flowRunStep.create({
      data: { flowRunId: pickedUp.id, nodeId: 'n5', status: 'running', startedAt: strandedAge },
    })

    const reaped = await reapNeverPickedUpRuns()
    assert.equal(reaped, 1)

    const strandedAfter = await prisma.flowRun.findUnique({ where: { id: stranded.id, organizationId: ids.org } })
    assert.equal(strandedAfter.status, 'failed')
    assert.match(strandedAfter.error, /never picked up/i)
    assert.ok(strandedAfter.finishedAt)

    const justDispatchedAfter = await prisma.flowRun.findUnique({ where: { id: justDispatched.id, organizationId: ids.org } })
    assert.equal(justDispatchedAfter.status, 'running', 'inside the pickup window — left alone')

    const pickedUpAfter = await prisma.flowRun.findUnique({ where: { id: pickedUp.id, organizationId: ids.org } })
    assert.equal(pickedUpAfter.status, 'running', 'has a step, so it WAS picked up — the 30-min reaper owns it')

    await prisma.flowRun.update({ where: { id: justDispatched.id, organizationId: ids.org }, data: { status: 'succeeded' } })
    await prisma.flowRun.update({ where: { id: pickedUp.id, organizationId: ids.org }, data: { status: 'succeeded' } })
  })

  test('reapNeverPickedUpRuns spares a run whose first step lands between read and write', async () => {
    const lateRun = await prisma.flowRun.create({
      data: { flowId: ids.flow, organizationId: ids.org, status: 'running', startedAt: new Date(Date.now() - 6 * 60 * 1000) },
    })
    // The worker picks the run up in the gap between the candidate read and
    // the guarded write — the write's re-checked `steps: none` must spare it.
    const reaped = await reapNeverPickedUpRuns(new Date(), async () => {
      await prisma.flowRunStep.create({ data: { flowRunId: lateRun.id, nodeId: 'n6', status: 'running', startedAt: new Date() } })
    })
    assert.equal(reaped, 0)

    const after = await prisma.flowRun.findUnique({ where: { id: lateRun.id, organizationId: ids.org } })
    assert.equal(after.status, 'running')
    await prisma.flowRun.update({ where: { id: lateRun.id, organizationId: ids.org }, data: { status: 'succeeded' } })
  })

  test('reapNeverPickedUpRuns is idempotent — second pass reaps nothing', async () => {
    assert.equal(await reapNeverPickedUpRuns(), 0)
  })
}
