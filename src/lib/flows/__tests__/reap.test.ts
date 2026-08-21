import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

test('stuck-run cutoff exceeds the 1800s route budget', async () => {
  const { STUCK_FLOW_RUN_TIMEOUT_MS } = await import('../reap')
  assert.equal(STUCK_FLOW_RUN_TIMEOUT_MS, 45 * 60 * 1000)
  // A cutoff at or below the route's maxDuration reaps runs that are still
  // legitimately executing inside a request.
  assert.ok(STUCK_FLOW_RUN_TIMEOUT_MS > 1800 * 1000)
})

// Regression for the generic "The run was interrupted and timed out." error
// that gave no clue what actually happened. formatReapMessage is pure (no
// Prisma), so its content is tested directly here.
test('formatReapMessage names the last completed step and elapsed time', async () => {
  const { formatReapMessage } = await import('../reap')
  const startedAt = new Date('2026-08-20T10:00:00.000Z')
  const now = new Date('2026-08-20T10:47:00.000Z')
  assert.equal(formatReapMessage(startedAt, now, 'enrich-contacts'), 'interrupted after 47m; last completed step: enrich-contacts')
})

test('formatReapMessage says so when no step ever completed', async () => {
  const { formatReapMessage } = await import('../reap')
  const startedAt = new Date('2026-08-20T10:00:00.000Z')
  const now = new Date('2026-08-20T10:05:00.000Z')
  assert.equal(formatReapMessage(startedAt, now, null), 'interrupted after 5m; no step completed before the timeout')
})

test('formatReapMessage stays inside the error-column budget even with a pathological node id', async () => {
  const { formatReapMessage } = await import('../reap')
  const hugeNodeId = 'x'.repeat(1000)
  const message = formatReapMessage(new Date(0), new Date(60_000), hugeNodeId)
  assert.ok(message.length <= 350, `expected a bounded message, got ${message.length} chars`)
  assert.match(message, /truncated/)
})

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  let reapStuckFlowRuns: any
  let reapNeverPickedUpRuns: any
  let stuckTimeoutMs = 0
  const ids: Record<string, string> = {}

  /**
   * A start time that is unambiguously past the stuck-run cutoff. Derived from
   * STUCK_FLOW_RUN_TIMEOUT_MS rather than hardcoded, so raising the budget (as
   * the 1800s route bump did) can never silently turn these fixtures into
   * not-yet-stale runs that the reaper correctly ignores.
   */
  const staleStart = () => new Date(Date.now() - stuckTimeoutMs - 60 * 1000)

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    let STUCK_FLOW_RUN_TIMEOUT_MS: number
    ;({ reapStuckFlowRuns, reapNeverPickedUpRuns, STUCK_FLOW_RUN_TIMEOUT_MS } = await import('../reap'))
    stuckTimeoutMs = STUCK_FLOW_RUN_TIMEOUT_MS
    const org = await prisma.organization.create({ data: { name: 'Reap', slug: `reap-${Date.now()}` } })
    ids.org = org.id
    const flow = await prisma.flow.create({
      data: { name: 'reap-target', organizationId: org.id, status: 'ACTIVE', graph: { nodes: [], edges: [] } },
    })
    ids.flow = flow.id
    const stale = staleStart()
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
    // States what is known instead of a flat "timed out": elapsed time, and
    // the last step that actually finished before the reaper caught it.
    assert.match(staleRun.error, /^interrupted after \d+m; last completed step: n0$/)
    assert.ok(staleRun.finishedAt)

    const staleStep = await prisma.flowRunStep.findUnique({ where: { id: ids.staleStep } })
    assert.equal(staleStep.status, 'failed')
    assert.match(staleStep.error, /last completed step: n0/)

    const doneStep = await prisma.flowRunStep.findUnique({ where: { id: ids.staleDoneStep } })
    assert.equal(doneStep.status, 'succeeded')

    const freshRun = await prisma.flowRun.findUnique({ where: { id: ids.freshRunning, organizationId: ids.org } })
    assert.equal(freshRun.status, 'running')

    const waitingRun = await prisma.flowRun.findUnique({ where: { id: ids.staleWaiting, organizationId: ids.org } })
    assert.equal(waitingRun.status, 'waiting')
  })

  test('reapStuckFlowRuns never touches steps of a run that legitimately leaves running before the write', async () => {
    const stale = staleStart()
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
    const stale = staleStart()
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
    assert.equal(pickedUpAfter.status, 'running', 'has a step, so it WAS picked up — the stuck-run reaper owns it')

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
