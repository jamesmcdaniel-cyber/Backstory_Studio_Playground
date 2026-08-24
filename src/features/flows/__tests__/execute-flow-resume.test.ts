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

  const emptyGraph = { nodes: [{ id: 'trigger', type: 'trigger', position: { x: 0, y: 0 }, data: {} }], edges: [] }

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    ;({ runFlowExecution } = await import('../execute-flow'))
    const org = await prisma.organization.create({ data: { name: 'ResumeClaim', slug: `resume-claim-${Date.now()}` } })
    ids.org = org.id
    const user = await prisma.user.create({ data: { supabaseId: crypto.randomUUID(), organizationId: org.id } })
    ids.user = user.id
    const flow = await prisma.flow.create({
      data: { name: 'resume-target', organizationId: org.id, status: 'ACTIVE', graph: emptyGraph, publishedGraph: emptyGraph },
    })
    ids.flow = flow.id
  })

  after(async () => {
    await prisma.flow.deleteMany({ where: { organizationId: ids.org } })
    await prisma.organization.delete({ where: { id: ids.org } })
  })

  test('resuming a run that is not `waiting` throws FLOW_RUN_NOT_WAITING and does not re-run it', async () => {
    const run = await prisma.flowRun.create({
      data: { flowId: ids.flow, organizationId: ids.org, userId: ids.user, status: 'succeeded', graphSnapshot: emptyGraph },
    })
    await assert.rejects(
      () => runFlowExecution({ flowId: ids.flow, organizationId: ids.org, userId: ids.user, flowRunId: run.id, reply: 'hi' }),
      (error: any) => error.code === 'FLOW_RUN_NOT_WAITING',
    )
    const after1 = await prisma.flowRun.findUnique({ where: { id: run.id, organizationId: ids.org } })
    assert.equal(after1.status, 'succeeded') // untouched — the claim never fired
  })

  test('resuming a run that IS waiting succeeds and pins execution to graphSnapshot, not the flow\'s current graph', async () => {
    // The run's snapshot routes the trigger to a 'legacy' stop node; the flow's
    // CURRENT (edited-after-pause) graph routes the trigger to a differently
    // named 'current-only' stop node instead. If resume re-derived from
    // flow.graph rather than the snapshot, the persisted step would carry the
    // 'current-only' node id, never 'legacy' — this test observes the actual
    // executed step, not just that the run didn't throw.
    const snapshot = {
      nodes: [...emptyGraph.nodes, { id: 'legacy', type: 'stop', position: { x: 0, y: 0 }, data: { reason: 'marker' } }],
      edges: [{ id: 'e-legacy', source: 'trigger', target: 'legacy' }],
    }
    const currentGraph = {
      nodes: [...emptyGraph.nodes, { id: 'current-only', type: 'stop', position: { x: 0, y: 0 }, data: { reason: 'marker' } }],
      edges: [{ id: 'e-current', source: 'trigger', target: 'current-only' }],
    }
    const run = await prisma.flowRun.create({
      data: { flowId: ids.flow, organizationId: ids.org, userId: ids.user, status: 'waiting', graphSnapshot: snapshot, input: { prompt: '' } },
    })
    // Simulate the flow having been republished (with a distinctly-shaped
    // graph) since the run paused.
    await prisma.flow.update({ where: { id: ids.flow, organizationId: ids.org }, data: { graph: currentGraph, publishedGraph: currentGraph } })

    // Capture the stale startedAt before resume so we can verify it was refreshed.
    const before = await prisma.flowRun.findUnique({ where: { id: run.id, organizationId: ids.org } })
    assert.ok(before?.startedAt)
    const staleStartedAt = before.startedAt

    const result = await runFlowExecution({ flowId: ids.flow, organizationId: ids.org, userId: ids.user, flowRunId: run.id, reply: 'go' })
    assert.equal(result.flowRunId, run.id)

    const claimed = await prisma.flowRun.findUnique({ where: { id: run.id, organizationId: ids.org } })
    assert.notEqual(claimed.status, 'waiting')
    // Resume claim must refresh startedAt so reapStuckFlowRuns does not mark
    // the run failed the instant it resumes after a long approval pause.
    assert.ok(claimed?.startedAt)
    assert.ok(claimed.startedAt > staleStartedAt, 'startedAt must be refreshed on resume')

    const steps: any[] = await prisma.flowRunStep.findMany({ where: { flowRunId: run.id } })
    assert.ok(steps.some((step) => step.nodeId === 'legacy'), 'the snapshot\'s step node must have actually executed')
    assert.ok(!steps.some((step) => step.nodeId === 'current-only'), 'the flow\'s current-graph-only node must never execute on resume')
  })

  test('a resume whose snapshot can never validate again FAILS the run — it does not sit `waiting` swallowing replies', async () => {
    // The snapshot references an agent that no longer exists (deleted while
    // the run waited). A resume runs the PINNED snapshot, so no amount of
    // editing the flow afterwards can make this validate — rolling the claim
    // back to `waiting` left the run accepting replies it could only ever
    // drop in silence. It must stop, with the reason on the row. (The claim
    // must still never be left `running`, which is what the rollback was
    // there to prevent.)
    const snapshot = {
      nodes: [...emptyGraph.nodes, { id: 'agent1', type: 'agent', position: { x: 0, y: 0 }, data: { agentId: 'deleted-agent-id', input: 'hi' } }],
      edges: [{ id: 'e-agent', source: 'trigger', target: 'agent1' }],
    }
    const run = await prisma.flowRun.create({
      data: { flowId: ids.flow, organizationId: ids.org, userId: ids.user, status: 'waiting', graphSnapshot: snapshot, input: { prompt: '' } },
    })
    await assert.rejects(
      () => runFlowExecution({ flowId: ids.flow, organizationId: ids.org, userId: ids.user, flowRunId: run.id, reply: 'go' }),
      (error: any) => error.code === 'FLOW_VALIDATION_ERROR',
    )
    const after2 = await prisma.flowRun.findUnique({ where: { id: run.id, organizationId: ids.org } })
    assert.equal(after2.status, 'failed')
    assert.match(after2.error ?? '', /agent that is not available/)
    assert.ok(after2.finishedAt, 'a terminal run carries a finish time')
  })

  test('a failure the runtime cannot classify still rolls the claim back to `waiting`', async () => {
    // Anything outside the narrow "this can never pass" set keeps the old
    // behaviour: the reply stays retryable rather than being terminalized on
    // what might be a transient fault. Here the snapshot is not a graph at
    // all, so it throws before validation ever runs.
    const run = await prisma.flowRun.create({
      data: { flowId: ids.flow, organizationId: ids.org, userId: ids.user, status: 'waiting', graphSnapshot: { nodes: 'not-a-list' }, input: { prompt: '' } },
    })
    await assert.rejects(() =>
      runFlowExecution({ flowId: ids.flow, organizationId: ids.org, userId: ids.user, flowRunId: run.id, reply: 'go' }),
    )
    const settled = await prisma.flowRun.findUnique({ where: { id: run.id, organizationId: ids.org } })
    assert.equal(settled.status, 'waiting')
  })

  test('a second concurrent resume of the same run loses cleanly after the first claims it', async () => {
    // The snapshot needs at least one non-trigger step or the winning claimant
    // would reject on graph validation (NO_STEPS) instead of fulfilling.
    const snapshot = { nodes: [...emptyGraph.nodes, { id: 'stop', type: 'stop', position: { x: 0, y: 0 }, data: { reason: 'marker' } }], edges: [] }
    const run = await prisma.flowRun.create({
      data: { flowId: ids.flow, organizationId: ids.org, userId: ids.user, status: 'waiting', graphSnapshot: snapshot, input: { prompt: '' } },
    })
    const [first, second] = await Promise.allSettled([
      runFlowExecution({ flowId: ids.flow, organizationId: ids.org, userId: ids.user, flowRunId: run.id, reply: 'a' }),
      runFlowExecution({ flowId: ids.flow, organizationId: ids.org, userId: ids.user, flowRunId: run.id, reply: 'b' }),
    ])
    const outcomes = [first, second]
    const fulfilled = outcomes.filter((o) => o.status === 'fulfilled')
    const rejected = outcomes.filter((o) => o.status === 'rejected')
    assert.equal(fulfilled.length, 1)
    assert.equal(rejected.length, 1)
    assert.equal((rejected[0] as PromiseRejectedResult).reason.code, 'FLOW_RUN_NOT_WAITING')
  })

  test('a humanReview step pauses the run, notifies the owner, and the reply becomes its output on resume', async () => {
    const graph = {
      nodes: [
        ...emptyGraph.nodes,
        { id: 'hr', type: 'humanReview', position: { x: 0, y: 0 }, data: { message: 'What segment should we target?' } },
      ],
      edges: [{ id: 'e-hr', source: 'trigger', target: 'hr' }],
    }
    const flow = await prisma.flow.create({
      data: { name: 'request-info', organizationId: ids.org, status: 'ACTIVE', graph, publishedGraph: graph },
    })
    const paused = await runFlowExecution({ flowId: flow.id, organizationId: ids.org, userId: ids.user, input: 'go' })
    assert.equal(paused.status, 'waiting')

    // The waiting row is interpreter-persisted with the WS8 'input' shape and,
    // unlike an agent pause, has NO agentExecutionId — the flow reply path
    // (execute route -> runFlowExecution) targets the node via this row alone.
    const steps: any[] = await prisma.flowRunStep.findMany({ where: { flowRunId: paused.flowRunId }, orderBy: { order: 'asc' } })
    const waitingRow = steps.find((step) => step.nodeId === 'hr' && step.status === 'waiting')
    assert.ok(waitingRow, 'the humanReview pause must persist a waiting step row')
    assert.equal(waitingRow.agentExecutionId, null)
    assert.deepEqual(waitingRow.output, { waiting: { kind: 'input', question: 'What segment should we target?' } })

    // No assignee configured -> the run owner is notified.
    const note = await prisma.notification.findFirst({ where: { organizationId: ids.org, type: 'flow.needs_input' } })
    assert.ok(note, 'the pause must create a flow.needs_input notification')
    assert.equal(note.userId, ids.user)
    assert.equal(note.level, 'action')

    const resumed = await runFlowExecution({ flowId: flow.id, organizationId: ids.org, userId: ids.user, flowRunId: paused.flowRunId, reply: 'Mid-market' })
    assert.equal(resumed.status, 'succeeded')
    assert.equal(resumed.output, 'Mid-market')
    const after3: any[] = await prisma.flowRunStep.findMany({ where: { flowRunId: paused.flowRunId }, orderBy: { order: 'asc' } })
    const finished = after3.filter((step) => step.nodeId === 'hr').at(-1)
    assert.equal(finished.status, 'succeeded')
    assert.equal(finished.output, 'Mid-market')
    // The original waiting row was resolved by the resume, never left dangling.
    assert.ok(!after3.some((step) => step.status === 'waiting'))
  })

  test('a loop persists a distinct per-iteration step row for every item (real run)', async () => {
    // A loop whose body is a humanReview pauses each item on its own row. The
    // rows are keyed per iteration (`hr#0`, `hr#1`, `hr#2`) — NOT one shared
    // `hr` row that would collide across iterations. This is what lets resume
    // reuse a completed iteration without re-running it.
    const graph = {
      nodes: [
        ...emptyGraph.nodes,
        { id: 'loop', type: 'loop', position: { x: 0, y: 0 }, data: { over: '{{trigger.input}}', body: ['hr'] } },
        { id: 'hr', type: 'humanReview', position: { x: 0, y: 0 }, data: { message: 'Confirm {{item}}' } },
      ],
      edges: [{ id: 'e-loop', source: 'trigger', target: 'loop' }],
    }
    const flow = await prisma.flow.create({
      data: { name: 'loop-persist', organizationId: ids.org, status: 'ACTIVE', graph, publishedGraph: graph },
    })
    const paused = await runFlowExecution({ flowId: flow.id, organizationId: ids.org, userId: ids.user, input: ['A', 'B', 'C'] })
    assert.equal(paused.status, 'waiting')

    const steps: any[] = await prisma.flowRunStep.findMany({ where: { flowRunId: paused.flowRunId }, orderBy: { order: 'asc' } })
    const byNode = (id: string) => steps.find((step) => step.nodeId === id)
    // Every iteration gets its own waiting row under a distinct per-iteration id.
    for (const key of ['hr#0', 'hr#1', 'hr#2']) {
      const row = byNode(key)
      assert.ok(row, `expected a persisted step row for ${key}`)
      assert.equal(row.status, 'waiting')
      assert.deepEqual(row.output.waiting.kind, 'input')
    }
    // No collapsed, shared bare `hr` row (the old collision that lost iterations).
    assert.ok(!byNode('hr'), 'must NOT persist a shared bare `hr` row')
    // The container itself is still reported.
    assert.ok(byNode('loop'), 'the loop container row must be persisted')
  })

  test('resuming a mid-loop pause reuses completed iterations — no prior side effect re-runs', async () => {
    // A real first run that pauses on iteration 1 would need the live agent
    // runtime, so we SEED the exact post-first-run state (the sibling resume
    // tests seed waiting runs the same way) and drive the RESUME end-to-end
    // through runFlowExecution against the real DB.
    //
    // Body = [work(agent), hr(humanReview)] over 3 items. Prior run: items 0
    // and 2 fully completed (agent + review), item 1's agent completed but its
    // review paused. On resume, EVERY `work#i` (adapter step) and the two
    // finished reviews must be reused — not re-executed — and only `hr#1`
    // resumes with the reply.
    const agent = await prisma.agentTask.create({
      data: { organizationId: ids.org, userId: ids.user, description: 'loop worker', objective: 'work an item', status: 'ACTIVE' },
    })
    const snapshot = {
      nodes: [
        ...emptyGraph.nodes,
        { id: 'loop', type: 'loop', position: { x: 0, y: 0 }, data: { over: '{{trigger.input}}', body: ['work', 'hr'] } },
        { id: 'work', type: 'agent', position: { x: 0, y: 0 }, data: { agentId: agent.id, input: 'work {{item}}' } },
        { id: 'hr', type: 'humanReview', position: { x: 0, y: 0 }, data: { message: 'Confirm {{item}}' } },
      ],
      edges: [{ id: 'e-loop', source: 'trigger', target: 'loop' }],
    }
    const flow = await prisma.flow.create({
      data: { name: 'loop-resume', organizationId: ids.org, status: 'ACTIVE', graph: snapshot, publishedGraph: snapshot },
    })
    const run = await prisma.flowRun.create({
      data: { flowId: flow.id, organizationId: ids.org, userId: ids.user, status: 'waiting', graphSnapshot: snapshot, input: { prompt: ['A', 'B', 'C'] } },
    })
    // Seed the paused state, per iteration.
    const seed = [
      { nodeId: 'work#0', status: 'succeeded', output: 'w0', order: 0 },
      { nodeId: 'hr#0', status: 'succeeded', output: 'ans-A', order: 1 },
      { nodeId: 'work#1', status: 'succeeded', output: 'w1', order: 2 },
      { nodeId: 'hr#1', status: 'waiting', output: { waiting: { kind: 'input', question: 'Confirm B' } }, order: 3 },
      { nodeId: 'work#2', status: 'succeeded', output: 'w2', order: 4 },
      { nodeId: 'hr#2', status: 'succeeded', output: 'ans-C', order: 5 },
      { nodeId: 'loop', status: 'waiting', output: null, order: 6 },
    ]
    for (const row of seed) {
      await prisma.flowRunStep.create({ data: { flowRunId: run.id, startedAt: new Date(), ...row } })
    }

    const countRows = async (nodeId: string) => prisma.flowRunStep.count({ where: { flowRunId: run.id, nodeId } })
    assert.equal(await countRows('work#0'), 1)
    assert.equal(await countRows('work#1'), 1)

    const resumed = await runFlowExecution({ flowId: flow.id, organizationId: ids.org, userId: ids.user, flowRunId: run.id, reply: 'ans-B' })

    // The run completes with all three items, in order — item 1 took the reply.
    assert.equal(resumed.status, 'succeeded')
    assert.deepEqual(resumed.output, ['ans-A', 'ans-B', 'ans-C'])

    // The core invariant: NO new adapter row for a prior iteration's work step —
    // item 0 (a completed iteration) AND item 1's already-finished agent step
    // are reused, never re-executed. (A re-run would have created a second row.)
    assert.equal(await countRows('work#0'), 1, 'item 0 agent step must not re-run on resume')
    assert.equal(await countRows('work#1'), 1, 'item 1 agent step (already done before the pause) must not re-run')
    assert.equal(await countRows('work#2'), 1, 'item 2 agent step must not re-run on resume')

    // The paused review resumed with the reply; nothing is left waiting.
    const after: any[] = await prisma.flowRunStep.findMany({ where: { flowRunId: run.id }, orderBy: { order: 'asc' } })
    const resumedReview = after.filter((step) => step.nodeId === 'hr#1' && step.status === 'succeeded').at(-1)
    assert.ok(resumedReview, 'hr#1 must have a resumed succeeded row')
    assert.equal(resumedReview.output, 'ans-B')
    assert.ok(!after.some((step) => step.status === 'waiting'), 'no step may be left waiting after resume')
  })
}
