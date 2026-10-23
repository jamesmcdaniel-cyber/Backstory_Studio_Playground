/**
 * Per-item approvals end to end, through the real engine, approval service
 * and database: a loop over three records whose MCP write needs sign-off.
 *
 *  - Acme is approved, Globex is rejected, and Initech's write already landed
 *    on an earlier delivery of the same poll item (the replay ledger), so it
 *    needs no sign-off at all;
 *  - each gated item gets its own approval naming the item, and only those
 *    items wait;
 *  - a resume while approvals are pending (a worker restart, a duplicate
 *    delivery) re-attaches to the same approvals — nothing re-queued, nothing
 *    superseded;
 *  - the first decision does not resume the run; the last one does, once;
 *  - the approved write runs exactly once, and the ledgered item never runs.
 *
 * The MCP server is a stubbed fetch behind the real SSRF guard (its resolver
 * is pointed at a public address), so the approved call goes through the
 * production client and is counted.
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
  let decideApproval: any
  let writeLedger: any
  let setSsrfResolver: any
  let clearPins: any
  const ids: Record<string, string> = {}
  const realFetch = globalThis.fetch
  const toolCalls: Array<{ name: string; arguments: Record<string, unknown> }> = []

  const ITEMS = [{ name: 'Acme' }, { name: 'Globex' }, { name: 'Initech' }]
  const position = { x: 0, y: 0 }
  const graphFor = (connectionId: string) => ({
    nodes: [
      { id: 'trigger', type: 'trigger', position, data: { trigger: { type: 'manual' } } },
      { id: 'each', type: 'loop', position, data: { over: '{{trigger.input}}', body: ['send'] } },
      { id: 'send', type: 'tool', position, data: { label: 'Update CRM', connectionId, toolName: 'update_record', args: '{"name":"{{item.name}}"}' } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'each' }],
  })

  /** A minimal streamable-HTTP MCP server: initialize, then count tools/call. */
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

  const approvalsOf = (runId: string) =>
    prisma.approvalRequest.findMany({ where: { organizationId: ids.org, executionId: runId }, orderBy: { createdAt: 'asc' } })
  const job = (extra: Record<string, unknown> = {}) => ({
    flowId: ids.flow,
    organizationId: ids.org,
    userId: ids.user,
    usePublished: true,
    trigger: { type: 'poll', dedupeValue: 'crm-batch-7' },
    ...extra,
  })

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    ;({ runFlowExecution } = await import('../execute-flow'))
    ;({ decideApproval } = await import('@/lib/agents/approval'))
    ;({ writeLedger } = await import('@/lib/flows/side-effect-ledger'))
    const ssrf = await import('@/lib/net/ssrf')
    setSsrfResolver = ssrf.__setSsrfResolver
    clearPins = ssrf.clearPins
    setSsrfResolver(async () => [{ address: '93.184.216.34', family: 4 as const }])
    globalThis.fetch = mcpServer

    const org = await prisma.organization.create({ data: { name: 'PerItemApprovals', slug: `per-item-approvals-${Date.now()}` } })
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
    const graph = graphFor(conn.id)
    const flow = await prisma.flow.create({
      data: { name: 'CRM updates', organizationId: org.id, userId: user.id, status: 'ACTIVE', graph, publishedGraph: graph },
    })
    ids.flow = flow.id
  })

  after(async () => {
    globalThis.fetch = realFetch
    setSsrfResolver(null)
    clearPins()
    await prisma.flowSideEffect.deleteMany({ where: { organizationId: ids.org } })
    await prisma.approvalRequest.deleteMany({ where: { organizationId: ids.org } })
    await prisma.flowRunStep.deleteMany({ where: { run: { organizationId: ids.org } } })
    await prisma.flowRun.deleteMany({ where: { organizationId: ids.org } })
    await prisma.flow.deleteMany({ where: { organizationId: ids.org } })
    await prisma.mcpConnection.deleteMany({ where: { organizationId: ids.org } })
    await prisma.notification.deleteMany({ where: { organizationId: ids.org } }).catch(() => {})
    await prisma.auditEvent.deleteMany({ where: { organizationId: ids.org } }).catch(() => {})
    await prisma.user.deleteMany({ where: { organizationId: ids.org } })
    await prisma.organization.delete({ where: { id: ids.org } })
  })

  test('approved, rejected and ledgered items each end right; the run waits once and resumes once', async () => {
    // Initech's write already landed on an earlier delivery of this poll item.
    await writeLedger({
      scopeKey: `${ids.flow}:crm-batch-7`, iterationKey: 'send#2', page: 0, organizationId: ids.org,
      provider: 'crm', tool: 'update_record', result: { content: [{ type: 'text', text: 'updated Initech (earlier)' }] }, flowRunId: null,
    })

    const first = await runFlowExecution(job({ input: ITEMS }))
    assert.equal(first.status, 'waiting', 'the run waits on its undecided items')
    const runId = first.flowRunId
    const asked = await approvalsOf(runId)
    assert.equal(asked.length, 2, 'one approval per gated item — none for the ledgered one')
    assert.deepEqual(asked.map((a: any) => a.payload.item?.label), ['Acme', 'Globex'])
    assert.deepEqual(asked.map((a: any) => a.payload.item?.stepKey), ['send#0', 'send#1'])
    assert.match(asked[0].summary, /item 1 of 3 · Acme/, 'the inbox names the item')
    assert.equal(toolCalls.length, 0, 'nothing is written before a decision')
    const notices = await prisma.notification.count({ where: { organizationId: ids.org, type: 'flow.needs_approval' } })
    assert.equal(notices, 1, 'one notification per run, not one per item')

    // A worker restart mid-wait: the run is resumed with nothing decided. It
    // must re-attach to the SAME approvals — no new requests, none superseded.
    const restarted = await runFlowExecution(job({ flowRunId: runId, reply: '' }))
    assert.equal(restarted.status, 'waiting')
    const afterRestart = await approvalsOf(runId)
    assert.deepEqual(afterRestart.map((a: any) => [a.id, a.status]), asked.map((a: any) => [a.id, 'pending']), 'idempotent: same approvals, still pending')
    const waitingRows = await prisma.flowRunStep.findMany({ where: { flowRunId: runId, status: 'waiting' } })
    const waitingOn = waitingRows.map((row: any) => row.output?.waiting?.approvalId).filter(Boolean)
    assert.deepEqual(waitingOn.sort(), asked.map((a: any) => a.id).sort(), 'each waiting item points at its own approval')

    // The first decision only records itself: Acme is still undecided.
    const globex = asked.find((a: any) => a.payload.item.label === 'Globex')
    const acme = asked.find((a: any) => a.payload.item.label === 'Acme')
    const rejected = await decideApproval({ approvalId: globex.id, organizationId: ids.org, deciderUserId: ids.user, approve: false })
    assert.equal(rejected.status, 'rejected')
    assert.equal(rejected.resumeFlow, undefined, 'the run does not resume while Acme is undecided')

    // The last decision executes the write — once — and resumes the run.
    const approved = await decideApproval({ approvalId: acme.id, organizationId: ids.org, deciderUserId: ids.user, approve: true })
    assert.equal(approved.status, 'approved')
    assert.equal(approved.executed, true)
    assert.ok(approved.resumeFlow, 'the last decision resumes the run')
    assert.deepEqual(toolCalls.map((call) => call.arguments.name), ['Acme'])

    const done = await runFlowExecution(job({ flowRunId: runId, reply: approved.resumeFlow.reply, usePublished: approved.resumeFlow.usePublished }))
    assert.equal(done.status, 'succeeded')
    const loopRow = await prisma.flowRunStep.findFirst({ where: { flowRunId: runId, nodeId: 'each', status: 'succeeded' }, orderBy: { order: 'desc' } })
    assert.deepEqual(loopRow.output, [
      { content: [{ type: 'text', text: 'updated Acme' }] },
      { content: [{ type: 'text', text: 'updated Initech (earlier)' }] },
    ], 'Acme carries its write result, Globex is skipped, Initech replays the ledger')
    assert.ok(loopRow.warnings.some((w: string) => /1 of 3 items was rejected/.test(w)))
    const globexRow = await prisma.flowRunStep.findFirst({ where: { flowRunId: runId, nodeId: 'send#1' }, orderBy: { order: 'desc' } })
    assert.equal(globexRow.status, 'skipped')
    assert.equal(globexRow.output.skipped, 'approval_rejected')
    assert.equal(toolCalls.length, 1, 'the approved write ran exactly once; the ledgered item never ran')

    // Replays are inert: the run is settled, a second resume is refused, and
    // re-posting the decision neither re-executes nor resumes anything.
    await assert.rejects(runFlowExecution(job({ flowRunId: runId, reply: approved.resumeFlow.reply })), /not waiting/)
    const again = await decideApproval({ approvalId: acme.id, organizationId: ids.org, deciderUserId: ids.user, approve: true })
    assert.equal(again.executed, false)
    assert.equal(again.resumeFlow, undefined)
    assert.equal(toolCalls.length, 1)
  })

  test('decisions that land while the run is still running resume it as soon as it settles', async () => {
    toolCalls.length = 0
    const first = await runFlowExecution(job({ input: [{ name: 'Hooli' }], trigger: { type: 'poll', dedupeValue: 'crm-batch-8' } }))
    assert.equal(first.status, 'waiting')
    const [only] = await approvalsOf(first.flowRunId)
    // Simulate the race: the decision is recorded while the run is `running`
    // (decideApproval then has no waiting run to resume).
    await prisma.flowRun.updateMany({ where: { id: first.flowRunId, organizationId: ids.org }, data: { status: 'running' } })
    const decided = await decideApproval({ approvalId: only.id, organizationId: ids.org, deciderUserId: ids.user, approve: false })
    assert.equal(decided.resumeFlow, undefined)
    await prisma.flowRun.updateMany({ where: { id: first.flowRunId, organizationId: ids.org }, data: { status: 'waiting' } })
    // The run's own settle step picks the decided approval up.
    const { settleRunApprovals } = await import('../approval-settle')
    const settled = await settleRunApprovals({ organizationId: ids.org, runId: first.flowRunId, status: 'waiting' })
    assert.ok(settled.resumeReply, 'a waiting run whose approvals are all decided is resumed')
    const done = await runFlowExecution(job({ flowRunId: first.flowRunId, reply: settled.resumeReply, trigger: { type: 'poll', dedupeValue: 'crm-batch-8' } }))
    assert.equal(done.status, 'succeeded')
    assert.equal(toolCalls.length, 0, 'a rejected item never writes')
  })

  test('a run that ends leaves no approvable request behind', async () => {
    const first = await runFlowExecution(job({ input: [{ name: 'Pied Piper' }], trigger: { type: 'poll', dedupeValue: 'crm-batch-9' } }))
    const { settleRunApprovals } = await import('../approval-settle')
    await settleRunApprovals({ organizationId: ids.org, runId: first.flowRunId, status: 'cancelled' })
    const [left] = await approvalsOf(first.flowRunId)
    assert.equal(left.status, 'superseded')
    const decided = await decideApproval({ approvalId: left.id, organizationId: ids.org, deciderUserId: ids.user, approve: true })
    assert.equal(decided.status, 'superseded')
    assert.equal(decided.executed, false)
  })
}
