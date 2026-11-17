import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'

/**
 * Runs that end OUTSIDE the engine's finalize — reaped, cancelled while
 * paused, stopped from the agent pane — used to end with a bare status write.
 * What a normal ending does never happened: approvals stayed approvable, the
 * flow.failed signal never fired, a `cancelling` run whose worker died read
 * "cancelling" forever, a queued agent run could not be stopped, and stopping
 * a flow's agent step from the agent pane stranded the flow.
 */
const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  let seeded: any
  let reapStuckFlowRuns: any
  let STUCK_FLOW_RUN_TIMEOUT_MS: number
  let REAPED_CANCEL_MESSAGE: string
  let reapStuckAgentExecutions: any
  let AGENT_STALE_AFTER_MS: number
  let flowCancel: any
  let agentRun: any
  const ids: Record<string, string> = {}

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    const { seedTestOrg, installTestAuth } = await import('@/lib/server/__tests__/test-auth')
    ;({ reapStuckFlowRuns, STUCK_FLOW_RUN_TIMEOUT_MS, REAPED_CANCEL_MESSAGE } = await import('../reap'))
    ;({ reapStuckAgentExecutions, AGENT_STALE_AFTER_MS } = await import('@/lib/agents/reap'))
    ;({ POST: flowCancel } = await import('@/app/api/flows/[id]/cancel/route'))
    ;({ POST: agentRun } = await import('@/app/api/agents/[id]/runs/[runId]/route'))
    seeded = await seedTestOrg(prisma)
    installTestAuth(seeded.auth)
    const flow = await prisma.flow.create({ data: { name: 'Effects', organizationId: seeded.organizationId, userId: seeded.userId, graph: { nodes: [], edges: [] } } })
    ids.flow = flow.id
    const agent = await prisma.agentTask.create({ data: { description: 'Agent', objective: 'x', organizationId: seeded.organizationId, userId: seeded.userId } })
    ids.agent = agent.id
  })

  after(async () => {
    const org = seeded.organizationId
    await prisma.approvalRequest.deleteMany({ where: { organizationId: org } })
    await prisma.outboxEvent.deleteMany({ where: { organizationId: org } })
    await prisma.flowRunStep.deleteMany({ where: { run: { organizationId: org } } })
    await prisma.flowRun.deleteMany({ where: { organizationId: org } })
    await prisma.workflowEvent.deleteMany({ where: { execution: { organizationId: org } } }).catch(() => {})
    await prisma.agentExecution.deleteMany({ where: { organizationId: org } })
    await prisma.agentTask.deleteMany({ where: { organizationId: org } })
    await prisma.flow.deleteMany({ where: { organizationId: org } })
    await prisma.notification.deleteMany({ where: { organizationId: org } }).catch(() => {})
    await seeded.cleanup()
  })

  const stale = () => new Date(Date.now() - STUCK_FLOW_RUN_TIMEOUT_MS - 60_000)
  const flowRun = (data: Record<string, unknown>) =>
    prisma.flowRun.create({ data: { flowId: ids.flow, organizationId: seeded.organizationId, userId: seeded.userId, ...data } })
  const execution = (data: Record<string, unknown>) =>
    prisma.agentExecution.create({
      data: { agentType: 'custom', agentTaskId: ids.agent, input: { prompt: 'x' }, trigger: { type: 'manual' }, userId: seeded.userId, organizationId: seeded.organizationId, ...data },
    })
  const pendingApproval = (executionId: string) =>
    prisma.approvalRequest.create({
      data: { organizationId: seeded.organizationId, executionId, tool: 't', summary: 's', status: 'pending', payload: { provider: 'mcp:x', args: {}, userId: seeded.userId } },
    })
  const approvalStatus = async (id: string) => (await prisma.approvalRequest.findFirst({ where: { id, organizationId: seeded.organizationId } })).status
  const runStatus = async (id: string) => (await prisma.flowRun.findFirst({ where: { id, organizationId: seeded.organizationId } })).status
  const executionStatus = async (id: string) => (await prisma.agentExecution.findFirst({ where: { id, organizationId: seeded.organizationId } })).status
  const post = (handler: any, url: string, body: unknown) =>
    handler(new NextRequest(new URL(url), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }))

  test('a reaped flow run retires its approvals and still fires flow.failed', async () => {
    const run = await flowRun({ status: 'running', startedAt: stale(), trigger: { type: 'schedule' } })
    const approval = await pendingApproval(run.id)
    await reapStuckFlowRuns()
    assert.equal(await runStatus(run.id), 'failed')
    assert.equal(await approvalStatus(approval.id), 'superseded')
    const signal = await prisma.outboxEvent.findFirst({ where: { organizationId: seeded.organizationId, dedupeKey: `flow:${run.id}:failed` } })
    assert.ok(signal, 'chained flows hear the run failed')
  })

  test('a cancelling run whose worker died resolves to cancelled', async () => {
    const run = await flowRun({ status: 'cancelling', startedAt: stale() })
    const step = await prisma.flowRunStep.create({ data: { flowRunId: run.id, nodeId: 'a', status: 'running', startedAt: stale() } })
    await reapStuckFlowRuns()
    const after = await prisma.flowRun.findFirst({ where: { id: run.id, organizationId: seeded.organizationId } })
    assert.equal(after.status, 'cancelled')
    assert.equal(after.error, REAPED_CANCEL_MESSAGE)
    assert.equal((await prisma.flowRunStep.findFirst({ where: { id: step.id, run: { organizationId: seeded.organizationId } } })).status, 'cancelled')
  })

  test('cancelling a paused flow run retires its approvals and the agent step paused with it', async () => {
    const run = await flowRun({ status: 'waiting' })
    const paused = await execution({ status: 'waiting_for_input' })
    await prisma.flowRunStep.create({ data: { flowRunId: run.id, nodeId: 'ask', status: 'waiting', agentExecutionId: paused.id, startedAt: new Date() } })
    const approval = await pendingApproval(run.id)
    const response = await post(flowCancel, `http://test/api/flows/${ids.flow}/cancel`, { flowRunId: run.id })
    assert.equal(response.status, 200)
    assert.equal(await runStatus(run.id), 'cancelled')
    assert.equal(await approvalStatus(approval.id), 'superseded')
    assert.equal(await executionStatus(paused.id), 'cancelled', 'the agent pane stops asking a question for a stopped run')
  })

  test('a queued (pending) agent run can be cancelled, and never starts', async () => {
    const queued = await execution({ status: 'pending' })
    const response = await post(agentRun, `http://test/api/agents/${ids.agent}/runs/${queued.id}`, { action: 'cancel' })
    const body = await response.json()
    assert.equal(response.status, 200, JSON.stringify(body))
    assert.equal(body.status, 'cancelled')
    assert.equal(await executionStatus(queued.id), 'cancelled')
  })

  test('cancelling a paused agent run retires its approvals', async () => {
    const paused = await execution({ status: 'waiting_for_approval' })
    const approval = await pendingApproval(paused.id)
    const response = await post(agentRun, `http://test/api/agents/${ids.agent}/runs/${paused.id}`, { action: 'cancel' })
    assert.equal(response.status, 200)
    assert.equal(await approvalStatus(approval.id), 'superseded')
  })

  test('cancelling a flow’s agent step from the agent pane stops the flow run too', async () => {
    const run = await flowRun({ status: 'waiting' })
    const paused = await execution({ status: 'waiting_for_input' })
    await prisma.flowRunStep.create({ data: { flowRunId: run.id, nodeId: 'ask', status: 'waiting', agentExecutionId: paused.id, startedAt: new Date() } })
    const response = await post(agentRun, `http://test/api/agents/${ids.agent}/runs/${paused.id}`, { action: 'cancel' })
    assert.equal(response.status, 200)
    assert.equal(await executionStatus(paused.id), 'cancelled')
    assert.equal(await runStatus(run.id), 'cancelled', 'the flow is not stranded waiting on a step that can never answer')
  })

  test('a reaped agent run retires its approvals and tells its owner', async () => {
    const old = new Date(Date.now() - AGENT_STALE_AFTER_MS - 60_000)
    const dead = await execution({ status: 'running', startedAt: old, lastActiveAt: old })
    const approval = await pendingApproval(dead.id)
    await reapStuckAgentExecutions()
    assert.equal(await executionStatus(dead.id), 'failed')
    assert.equal(await approvalStatus(approval.id), 'superseded')
    const notice = await prisma.notification.count({ where: { organizationId: seeded.organizationId, executionId: dead.id, type: 'agent.error' } })
    assert.equal(notice, 1)
  })
}
