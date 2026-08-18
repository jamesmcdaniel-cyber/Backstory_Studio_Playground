/**
 * A loop that pauses SEVERAL "Request information" iterations at once (its
 * items run concurrently) leaves one waiting row per iteration. Each reply must
 * resolve the iteration it was written for — before per-iteration reply keys,
 * every reply landed on whichever row was recorded last.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  let runFlowExecution: any
  const ids: Record<string, string> = {}

  const position = { x: 0, y: 0 }
  // Three items, run concurrently, each asking its own question.
  const loopGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', position, data: { trigger: { type: 'manual' } } },
      { id: 'loop', type: 'loop', position, data: { over: 'alpha, beta, gamma', concurrency: 3, body: ['review'] } },
      { id: 'review', type: 'humanReview', position, data: { message: 'Approve {{item}}?' } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'loop' }],
  }
  const singleGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', position, data: { trigger: { type: 'manual' } } },
      { id: 'ask', type: 'humanReview', position, data: { message: 'Ship it?' } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'ask' }],
  }

  const waitingKeys = async (runId: string): Promise<string[]> => {
    const steps = await prisma.flowRunStep.findMany({ where: { flowRunId: runId }, orderBy: { order: 'asc' } })
    return steps.filter((step: any) => step.status === 'waiting').map((step: any) => step.nodeId).sort()
  }
  const outputOf = async (runId: string, nodeId: string) => {
    const rows = await prisma.flowRunStep.findMany({ where: { flowRunId: runId, nodeId }, orderBy: { order: 'asc' } })
    return rows.filter((row: any) => row.status === 'succeeded').map((row: any) => row.output)
  }

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    ;({ runFlowExecution } = await import('../execute-flow'))
    const org = await prisma.organization.create({ data: { name: 'ReviewRouting', slug: `review-routing-${Date.now()}` } })
    ids.org = org.id
    const user = await prisma.user.create({ data: { supabaseId: crypto.randomUUID(), organizationId: org.id } })
    ids.user = user.id
    const flow = await prisma.flow.create({
      data: { name: 'review-loop', organizationId: org.id, status: 'ACTIVE', graph: loopGraph, publishedGraph: loopGraph },
    })
    ids.flow = flow.id
    const single = await prisma.flow.create({
      data: { name: 'review-single', organizationId: org.id, status: 'ACTIVE', graph: singleGraph, publishedGraph: singleGraph },
    })
    ids.singleFlow = single.id
  })

  after(async () => {
    await prisma.flowRunStep.deleteMany({ where: { run: { organizationId: ids.org } } })
    await prisma.flowRun.deleteMany({ where: { organizationId: ids.org } })
    await prisma.flow.deleteMany({ where: { organizationId: ids.org } })
    await prisma.user.deleteMany({ where: { organizationId: ids.org } })
    await prisma.organization.delete({ where: { id: ids.org } })
  })

  test('each reply resolves its OWN paused iteration, not the last one recorded', async () => {
    const started = await runFlowExecution({ flowId: ids.flow, organizationId: ids.org, userId: ids.user, input: '' })
    assert.equal(started.status, 'waiting')
    // All three iterations are paused at the same time.
    assert.deepEqual(await waitingKeys(started.flowRunId), ['loop', 'review#0', 'review#1', 'review#2'])

    // Answer the MIDDLE one first: under the old routing this reply would have
    // been applied to review#2 (the last waiting row).
    const afterBeta = await runFlowExecution({
      flowId: ids.flow,
      organizationId: ids.org,
      userId: ids.user,
      flowRunId: started.flowRunId,
      reply: 'beta-ok',
      replyStepKey: 'review#1',
    })
    assert.equal(afterBeta.status, 'waiting') // the other two are still asking
    assert.deepEqual(await outputOf(started.flowRunId, 'review#1'), ['beta-ok'])
    assert.deepEqual(await outputOf(started.flowRunId, 'review#2'), []) // untouched
    assert.deepEqual(await waitingKeys(started.flowRunId), ['loop', 'review#0', 'review#2'])

    await runFlowExecution({
      flowId: ids.flow,
      organizationId: ids.org,
      userId: ids.user,
      flowRunId: started.flowRunId,
      reply: 'alpha-ok',
      replyStepKey: 'review#0',
    })
    const done = await runFlowExecution({
      flowId: ids.flow,
      organizationId: ids.org,
      userId: ids.user,
      flowRunId: started.flowRunId,
      reply: 'gamma-ok',
      replyStepKey: 'review#2',
    })
    assert.equal(done.status, 'succeeded')
    // Every answer sits in the slot of the item it was written for.
    assert.deepEqual(await outputOf(started.flowRunId, 'review#0'), ['alpha-ok'])
    assert.deepEqual(await outputOf(started.flowRunId, 'review#1'), ['beta-ok'])
    assert.deepEqual(await outputOf(started.flowRunId, 'review#2'), ['gamma-ok'])
    assert.deepEqual(await outputOf(started.flowRunId, 'loop'), [['alpha-ok', 'beta-ok', 'gamma-ok']])
  })

  test('a reply with no key is refused while several iterations are waiting, and the run stays answerable', async () => {
    const started = await runFlowExecution({ flowId: ids.flow, organizationId: ids.org, userId: ids.user, input: '' })
    assert.equal(started.status, 'waiting')
    await assert.rejects(
      () =>
        runFlowExecution({
          flowId: ids.flow,
          organizationId: ids.org,
          userId: ids.user,
          flowRunId: started.flowRunId,
          reply: 'which one?',
        }),
      (error: any) => error.code === 'FLOW_REPLY_AMBIGUOUS' && /3 reviews at once/.test(error.message),
    )
    // Refused, not consumed: the run is still waiting and no iteration moved.
    const run = await prisma.flowRun.findUnique({ where: { id: started.flowRunId, organizationId: ids.org } })
    assert.equal(run.status, 'waiting')
    assert.deepEqual(await waitingKeys(started.flowRunId), ['loop', 'review#0', 'review#1', 'review#2'])

    // A key for an iteration that is not waiting is refused too.
    await assert.rejects(
      () =>
        runFlowExecution({
          flowId: ids.flow,
          organizationId: ids.org,
          userId: ids.user,
          flowRunId: started.flowRunId,
          reply: 'stale',
          replyStepKey: 'review#7',
        }),
      (error: any) => error.code === 'FLOW_REPLY_TARGET_GONE',
    )
    assert.equal(
      (await prisma.flowRun.findUnique({ where: { id: started.flowRunId, organizationId: ids.org } })).status,
      'waiting',
    )
  })

  test('a single paused review still resumes from a reply that carries no key', async () => {
    const started = await runFlowExecution({ flowId: ids.singleFlow, organizationId: ids.org, userId: ids.user, input: '' })
    assert.equal(started.status, 'waiting')
    assert.deepEqual(await waitingKeys(started.flowRunId), ['ask'])
    const done = await runFlowExecution({
      flowId: ids.singleFlow,
      organizationId: ids.org,
      userId: ids.user,
      flowRunId: started.flowRunId,
      reply: 'ship it',
    })
    assert.equal(done.status, 'succeeded')
    assert.deepEqual(await outputOf(started.flowRunId, 'ask'), ['ship it'])
  })
}
