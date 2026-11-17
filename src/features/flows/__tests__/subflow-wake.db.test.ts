/**
 * A parent flow paused on a subflow whose child then moves on by itself.
 *
 * The child of a subflow step can pause on something the PARENT has no part
 * in: an approval, a timer, a webhook. Deciding the approval resumes the child
 * directly. Nothing ever woke the parent: it sat `waiting` on a child that had
 * already finished, its Runs panel offered a reply box for what was really an
 * approval, and replying failed the step ("no longer waiting").
 *
 * Through the real engine, approval service and database (the MCP server is a
 * stubbed fetch behind the real SSRF guard, as in per-item-approvals):
 *
 *  - the parent's waiting row carries the child's REAL wait kind (approval);
 *  - deciding the child's approval resumes the child, whose finish wakes the
 *    parent, which completes with the child's output — the write ran once;
 *  - a run whose pinned dependencies changed fails visibly on resume instead
 *    of rolling back to `waiting` forever.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { enterTestTenant } from '@/lib/server/__tests__/test-tenant'

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'ci-encryption-key'

  let prisma: any
  let runFlowExecution: any
  let dispatchDetachedFlowExecution: any
  let flushDetachedFlowExecutions: any
  let decideApproval: any
  let buildFlowExecutionManifest: any
  let setSsrfResolver: any
  let clearPins: any
  const ids: Record<string, string> = {}
  const realFetch = globalThis.fetch
  const toolCalls: Array<{ name: string; arguments: Record<string, unknown> }> = []
  const position = { x: 0, y: 0 }

  const mcpServer = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body ?? '{}'))
    const json = (payload: unknown) => new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
    if (body.method === 'initialize') return json({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} } } })
    if (body.method === 'tools/call') {
      toolCalls.push(body.params)
      return json({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: `updated ${body.params.arguments.name}` }] } })
    }
    return new Response('', { status: 202 })
  }) as unknown as typeof fetch

  const childGraph = (connectionId: string) => ({
    nodes: [
      { id: 'trigger', type: 'trigger', position, data: { trigger: { type: 'manual' } } },
      { id: 'send', type: 'tool', position, data: { label: 'Update CRM', connectionId, toolName: 'update_record', args: '{"name":"Acme"}' } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'send' }],
  })

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    ;({ runFlowExecution, dispatchDetachedFlowExecution, flushDetachedFlowExecutions } = await import('../execute-flow'))
    ;({ decideApproval } = await import('@/lib/agents/approval'))
    ;({ buildFlowExecutionManifest } = await import('@/lib/flows/execution-manifest'))
    const ssrf = await import('@/lib/net/ssrf')
    setSsrfResolver = ssrf.__setSsrfResolver
    clearPins = ssrf.clearPins
    setSsrfResolver(async () => [{ address: '93.184.216.34', family: 4 as const }])
    globalThis.fetch = mcpServer

    const org = await prisma.organization.create({ data: { name: 'SubflowWake', slug: `subflow-wake-${Date.now()}` } })
    ids.org = org.id
    enterTestTenant(org.id)
    const user = await prisma.user.create({ data: { supabaseId: crypto.randomUUID(), organizationId: org.id } })
    ids.user = user.id
    const serverUrl = `https://mcp-${crypto.randomUUID().slice(0, 8)}.example.com/mcp`
    const planes = await import('@/features/agents/tool-planes')
    const { cacheSet } = await import('@/lib/cache')
    await cacheSet(planes.toolDiscoveryCacheKey(org.id, serverUrl), [
      { name: 'update_record', description: 'Change a CRM record', inputSchema: { type: 'object', properties: { name: { type: 'string' } } } },
    ], 600_000)
    const conn = await prisma.mcpConnection.create({
      data: { organizationId: org.id, userId: null, name: 'CRM', serverUrl, authType: 'none', isActive: true, toolPolicies: { update_record: 'approve' } },
    })
    ids.conn = conn.id
    const child = await prisma.flow.create({
      data: { name: 'Update CRM', organizationId: org.id, userId: user.id, status: 'ACTIVE', graph: childGraph(conn.id), publishedGraph: childGraph(conn.id) },
    })
    ids.child = child.id
    const parentGraph = {
      nodes: [
        { id: 'trigger', type: 'trigger', position, data: { trigger: { type: 'manual' } } },
        { id: 'sub', type: 'subflow', position, data: { flowId: child.id } },
      ],
      edges: [{ id: 'e1', source: 'trigger', target: 'sub' }],
    }
    const parent = await prisma.flow.create({
      data: { name: 'Parent', organizationId: org.id, userId: user.id, status: 'ACTIVE', graph: parentGraph, publishedGraph: parentGraph },
    })
    ids.parent = parent.id
  })

  after(async () => {
    globalThis.fetch = realFetch
    setSsrfResolver(null)
    clearPins()
    await prisma.flowSideEffect.deleteMany({ where: { organizationId: ids.org } }).catch(() => {})
    await prisma.approvalRequest.deleteMany({ where: { organizationId: ids.org } })
    await prisma.outboxEvent.deleteMany({ where: { organizationId: ids.org } }).catch(() => {})
    await prisma.flowRunStep.deleteMany({ where: { run: { organizationId: ids.org } } })
    await prisma.flowRun.deleteMany({ where: { organizationId: ids.org } })
    await prisma.flow.deleteMany({ where: { organizationId: ids.org } })
    await prisma.mcpConnection.deleteMany({ where: { organizationId: ids.org } })
    await prisma.notification.deleteMany({ where: { organizationId: ids.org } }).catch(() => {})
    await prisma.auditEvent.deleteMany({ where: { organizationId: ids.org } }).catch(() => {})
    await prisma.agentAction.deleteMany({ where: { organizationId: ids.org } }).catch(() => {})
    await prisma.user.deleteMany({ where: { organizationId: ids.org } })
    await prisma.organization.delete({ where: { id: ids.org } })
  })

  const runOf = (id: string) => prisma.flowRun.findFirst({ where: { id, organizationId: ids.org } })
  const stepsOf = (id: string) => prisma.flowRunStep.findMany({ where: { flowRunId: id, run: { organizationId: ids.org } }, orderBy: { order: 'asc' } })

  test('a child resumed by its approval wakes the parent, which finishes with the child’s output', async () => {
    const started = await runFlowExecution({ flowId: ids.parent, organizationId: ids.org, userId: ids.user, input: {} })
    assert.equal(started.status, 'waiting')
    const parentRunId = started.flowRunId

    const parentSteps = await stepsOf(parentRunId)
    const paused = parentSteps.find((step: any) => step.nodeId === 'sub' && step.status === 'waiting')
    assert.ok(paused, 'the parent pauses on its subflow step')
    assert.equal(paused.output.waiting.kind, 'approval', 'the parent carries the child’s real wait — no reply box for an approval')
    const childRunId = paused.output.waiting.childRunId
    assert.ok(childRunId)
    assert.equal(paused.output.waiting.approvalId, undefined, 'the approval stays the child’s')

    const [approval] = await prisma.approvalRequest.findMany({ where: { organizationId: ids.org, executionId: childRunId } })
    assert.ok(approval, 'the child queued the approval')
    assert.equal((await runOf(parentRunId)).status, 'waiting')

    const decided = await decideApproval({ approvalId: approval.id, organizationId: ids.org, deciderUserId: ids.user, approve: true })
    assert.equal(decided.resumeFlow?.flowRunId, childRunId, 'the decision resumes the CHILD')
    // What the approvals route does with it.
    await dispatchDetachedFlowExecution({
      flowId: decided.resumeFlow.flowId,
      organizationId: ids.org,
      userId: decided.resumeFlow.userId,
      flowRunId: childRunId,
      reply: decided.resumeFlow.reply,
      usePublished: decided.resumeFlow.usePublished,
    })
    await flushDetachedFlowExecutions()

    assert.equal((await runOf(childRunId)).status, 'succeeded')
    const parent = await runOf(parentRunId)
    assert.equal(parent.status, 'succeeded', 'the child’s finish woke the parent')
    const finished = (await stepsOf(parentRunId)).filter((step: any) => step.nodeId === 'sub').at(-1)
    assert.equal(finished.status, 'succeeded')
    assert.equal(toolCalls.length, 1, 'the approved write ran exactly once')
  })

  test('a run whose pinned tool schema changed fails visibly on resume, not waiting forever', async () => {
    const graph = childGraph(ids.conn)
    const stale = buildFlowExecutionManifest({
      graph,
      agents: [],
      toolCatalog: [{ id: ids.conn, tools: [{ name: 'update_record', inputSchema: { type: 'object', properties: { id: { type: 'string' } } } }] }],
      agentModel: 'm',
      summaryModel: 's',
    })
    const run = await prisma.flowRun.create({
      data: { flowId: ids.child, status: 'waiting', organizationId: ids.org, userId: ids.user, graphSnapshot: graph, executionManifest: stale },
    })
    await prisma.flowRunStep.create({ data: { flowRunId: run.id, nodeId: 'send', status: 'waiting', startedAt: new Date(), output: { waiting: { kind: 'input', question: 'Go?' } } } })
    const pending = await prisma.approvalRequest.create({
      data: { organizationId: ids.org, executionId: run.id, tool: 'update_record', summary: 's', status: 'pending', payload: { provider: 'mcp:crm', args: {}, userId: ids.user } },
    })

    await assert.rejects(
      runFlowExecution({ flowId: ids.child, organizationId: ids.org, userId: ids.user, flowRunId: run.id, reply: 'yes' }),
      (error: any) => error.code === 'FLOW_DEPENDENCY_DRIFT',
    )
    const after = await runOf(run.id)
    assert.equal(after.status, 'failed', 'drift is terminal: no reply can reconcile it')
    assert.match(after.error, /configuration changed/)
    const steps = await stepsOf(run.id)
    assert.ok(steps.every((step: any) => step.status !== 'waiting'), 'nothing is left looking answerable')
    const approval = await prisma.approvalRequest.findFirst({ where: { id: pending.id, organizationId: ids.org } })
    assert.equal(approval.status, 'superseded', 'the failed run’s approvals are retired')
  })
}
