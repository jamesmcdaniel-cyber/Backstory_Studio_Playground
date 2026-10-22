/**
 * The action ledger and Undo against a real database.
 *
 * Writes are recorded where they execute (withActionLedger, an approved write
 * in decideApproval, a flow tool step); Undo goes back through the recorded
 * connection, as the person asking, at most once.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { NextRequest } from 'next/server'

const TEST_DB = process.env.TEST_DATABASE_URL
const skip = TEST_DB ? false : 'TEST_DATABASE_URL is not set — the action ledger needs a real database'
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'ci-encryption-key'
  process.env.ENTITLEMENT_GATE = 'off'
}

let prisma: any
let seeded: { organizationId: string; userId: string; auth: any; cleanup: () => Promise<void> }
let ledger: typeof import('../action-ledger')
let undo: typeof import('../action-undo')
let agentId: string
let executionId: string

before(async () => {
  if (!TEST_DB) return
  ;({ prisma } = await import('@/lib/prisma'))
  const { seedTestOrg, installTestAuth } = await import('@/lib/server/__tests__/test-auth')
  seeded = await seedTestOrg(prisma)
  installTestAuth(seeded.auth)
  ledger = await import('../action-ledger')
  undo = await import('../action-undo')
  agentId = (await prisma.agentTask.create({
    data: { description: 'Ledger agent', objective: 'o', status: 'ACTIVE', visibility: 'shared', organizationId: seeded.organizationId, userId: seeded.userId },
  })).id
  executionId = (await prisma.agentExecution.create({
    data: { agentTaskId: agentId, organizationId: seeded.organizationId, userId: seeded.userId, status: 'running', trigger: 'manual', agentType: 'CUSTOM', input: {} },
  })).id
})

after(async () => {
  if (seeded) await seeded.cleanup()
})

async function nangoConnection(userId: string | null) {
  const connectionId = `conn-${crypto.randomUUID()}`
  await prisma.nangoConnection.create({
    data: { organizationId: seeded.organizationId, userId, connectionId, providerConfigKey: 'slack', status: 'connected' },
  })
  return { connectionId, providerConfigKey: 'slack', scope: userId ? ('user' as const) : ('org' as const) }
}

/** Record a Slack post through the real wrapper, as the agent loop does. */
async function recordSlackPost(connection: { connectionId: string; providerConfigKey: string; scope: 'user' | 'org' }, ts = `${Date.now()}.0001`) {
  await ledger.withActionLedger(
    {
      organizationId: seeded.organizationId,
      source: { kind: 'agent', agentTaskId: agentId, runId: executionId, stepRef: 'step-1' },
      actorUserId: seeded.userId,
      provider: 'nango:slack',
      plane: 'nango',
      tool: 'slack_post_message',
      args: { channel: '#revenue', text: 'Q3 is closed', token: 'xoxp-secret' },
      isWrite: true,
      credential: { actsAs: connection.scope === 'user' ? 'user' : 'workspace', nango: connection },
    },
    async () => ({ ok: true, channel: 'C42', ts }),
  )
  return prisma.agentAction.findFirst({ where: { organizationId: seeded.organizationId, resultRef: { path: ['ts'], equals: ts } } })
}

function fakeProxy(respond: () => unknown = () => ({ ok: true })) {
  const calls: Array<{ endpoint: string; data: unknown; connectionId: string }> = []
  return {
    calls,
    proxy: async (request: { endpoint: string; data?: unknown; connectionId: string }) => {
      calls.push({ endpoint: request.endpoint, data: request.data, connectionId: request.connectionId })
      return { data: respond() }
    },
  }
}

test('a write is recorded with a redacted summary, the provider reference and the connection it used', { skip }, async () => {
  const connection = await nangoConnection(seeded.userId)
  const row = await recordSlackPost(connection)
  assert.equal(row.status, 'done')
  assert.equal(row.sourceKind, 'agent')
  assert.equal(row.agentTaskId, agentId)
  assert.equal(row.runId, executionId)
  assert.equal(row.argsSummary.token, '[REDACTED]')
  assert.equal(row.argsSummary.text, 'Q3 is closed')
  assert.deepEqual({ channel: row.resultRef.channel, label: row.resultRef.label }, { channel: 'C42', label: '#revenue' })
  assert.deepEqual(row.connectionRef, { actsAs: 'user', nango: connection })
})

test('a failed write is recorded as failed and the error still reaches the caller', { skip }, async () => {
  await assert.rejects(ledger.withActionLedger(
    { organizationId: seeded.organizationId, source: { kind: 'agent', agentTaskId: agentId, runId: executionId }, actorUserId: seeded.userId, provider: 'nango:gmail', plane: 'nango', tool: 'gmail_send_email', args: { to: 'a@b.co' }, isWrite: true },
    async () => { throw new Error('Gmail said no') },
  ), /Gmail said no/)
  const row = await prisma.agentAction.findFirst({ where: { organizationId: seeded.organizationId, tool: 'gmail_send_email' } })
  assert.equal(row.status, 'failed')
  assert.match(row.error, /Gmail said no/)
})

test('undo deletes the message through the recorded connection, once, and is audited', { skip }, async () => {
  const connection = await nangoConnection(seeded.userId)
  const row = await recordSlackPost(connection)
  const { calls, proxy } = fakeProxy()
  const first = await undo.undoAgentAction({ organizationId: seeded.organizationId, actionId: row.id, requesterUserId: seeded.userId, canManageIntegrations: false, deps: { proxy } })
  assert.deepEqual(first, { status: 'undone', alreadyUndone: false, alreadyGone: false })
  assert.deepEqual(calls, [{ endpoint: '/chat.delete', data: { channel: 'C42', ts: row.resultRef.ts }, connectionId: connection.connectionId }])
  const again = await undo.undoAgentAction({ organizationId: seeded.organizationId, actionId: row.id, requesterUserId: seeded.userId, canManageIntegrations: false, deps: { proxy } })
  assert.equal(again.alreadyUndone, true)
  assert.equal(calls.length, 1, 'a second undo never calls the provider again')
  const after = await prisma.agentAction.findFirst({ where: { id: row.id, organizationId: seeded.organizationId } })
  assert.equal(after.status, 'undone')
  assert.equal(after.undoneById, seeded.userId)
  const audit = await prisma.auditEvent.findFirst({ where: { organizationId: seeded.organizationId, action: 'tool.undo', resourceId: row.id } })
  assert.ok(audit, 'undo is audited')
})

test("only a personal connection's owner may undo through it; a workspace connection needs integration.manage", { skip }, async () => {
  const other = await prisma.user.create({ data: { supabaseId: crypto.randomUUID(), organizationId: seeded.organizationId, isActive: true } })
  const personal = await recordSlackPost(await nangoConnection(seeded.userId))
  await assert.rejects(
    undo.undoAgentAction({ organizationId: seeded.organizationId, actionId: personal.id, requesterUserId: other.id, canManageIntegrations: true, deps: { proxy: fakeProxy().proxy } }),
    (error: any) => error.status === 403 && /someone else's own account/.test(error.message),
  )
  const shared = await recordSlackPost(await nangoConnection(null))
  await assert.rejects(
    undo.undoAgentAction({ organizationId: seeded.organizationId, actionId: shared.id, requesterUserId: other.id, canManageIntegrations: false, deps: { proxy: fakeProxy().proxy } }),
    (error: any) => error.status === 403 && /manage integrations/.test(error.message),
  )
  const ok = await undo.undoAgentAction({ organizationId: seeded.organizationId, actionId: shared.id, requesterUserId: other.id, canManageIntegrations: true, deps: { proxy: fakeProxy().proxy } })
  assert.equal(ok.status, 'undone')
})

test('a message the provider says is already gone counts as undone; a real failure leaves it undoable', { skip }, async () => {
  const connection = await nangoConnection(seeded.userId)
  const gone = await recordSlackPost(connection)
  const goneResult = await undo.undoAgentAction({ organizationId: seeded.organizationId, actionId: gone.id, requesterUserId: seeded.userId, canManageIntegrations: false, deps: { proxy: fakeProxy(() => ({ ok: false, error: 'message_not_found' })).proxy } })
  assert.equal(goneResult.alreadyGone, true)

  const failing = await recordSlackPost(connection)
  await assert.rejects(
    undo.undoAgentAction({ organizationId: seeded.organizationId, actionId: failing.id, requesterUserId: seeded.userId, canManageIntegrations: false, deps: { proxy: fakeProxy(() => ({ ok: false, error: 'cant_delete_message' })).proxy } }),
    (error: any) => error.status === 502,
  )
  const row = await prisma.agentAction.findFirst({ where: { id: failing.id, organizationId: seeded.organizationId } })
  assert.equal(row.status, 'done', 'still undoable after a failed attempt')
  assert.match(row.undoError, /cant_delete_message/)
})

test('an approved warehouse write is recorded at decideApproval, with its approver, and says it cannot be undone', { skip }, async () => {
  const { warehouseCredentialStore } = await import('@/lib/warehouse/credentials')
  const { warehouseRequests } = await import('@/lib/warehouse/tools')
  const { fakeWarehouse } = await import('@/lib/warehouse/__tests__/fake-warehouse')
  const original = { rows: warehouseCredentialStore.rows, resolve: warehouseCredentialStore.resolve, snowflake: warehouseRequests.snowflake }
  warehouseCredentialStore.rows = async () => [{ id: 'cred', allowedHost: 'acme.snowflakecomputing.com', userId: null, status: 'verified', lastVerifiedAt: new Date(0) }]
  warehouseCredentialStore.resolve = async () => ({ id: 'cred', name: 'cred', authType: 'bearer', allowedHost: 'acme.snowflakecomputing.com', config: { token: 't' } }) as never
  const fake = fakeWarehouse([{ match: /statements\?/, body: { statementHandle: 'h', resultSetMetaData: { numRows: 0, rowType: [] }, data: [] } }])
  warehouseRequests.snowflake = () => fake.request
  try {
    const approval = await prisma.approvalRequest.create({
      data: {
        organizationId: seeded.organizationId, executionId, tool: 'snowflake_sql_query', summary: 's', status: 'pending',
        payload: { provider: 'snowflake', capability: null, args: { statement: 'DELETE FROM stale_rows' }, userId: seeded.userId },
      },
    })
    const { decideApproval } = await import('../approval')
    const decision = await decideApproval({ approvalId: approval.id, organizationId: seeded.organizationId, deciderUserId: seeded.userId, approve: true })
    assert.equal(decision.executed, true)
    const row = await prisma.agentAction.findFirst({ where: { organizationId: seeded.organizationId, approvalId: approval.id } })
    assert.equal(row.status, 'done')
    assert.equal(row.agentTaskId, agentId, 'the run id resolves back to its agent')
    assert.equal(row.approvedById, seeded.userId)
    assert.equal(row.provider, 'snowflake')

    const { listLedgerEntries } = await import('../action-ledger-query')
    const { items } = await listLedgerEntries({ organizationId: seeded.organizationId, userId: seeded.userId, canManageIntegrations: true }, { organizationId: seeded.organizationId, approvalId: approval.id })
    assert.equal(items[0].undo.possible, false)
    assert.match(items[0].undo.reason ?? '', /Time Travel/)
  } finally {
    warehouseCredentialStore.rows = original.rows
    warehouseCredentialStore.resolve = original.resolve
    warehouseRequests.snowflake = original.snowflake
  }
})

test('a flow tool step that writes is recorded against its flow and run', { skip }, async () => {
  const graph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'table', type: 'tool', data: { connectionId: 'native:data_tables', toolName: 'data_table_create_table', args: JSON.stringify({ name: `Ledger ${Date.now()}`, columns: [{ name: 'account', type: 'string' }] }) } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'table' }],
  }
  const flow = await prisma.flow.create({ data: { name: 'Ledger flow', organizationId: seeded.organizationId, userId: seeded.userId, status: 'ACTIVE', graph, publishedGraph: graph } })
  const { runFlowExecution } = await import('@/features/flows/execute-flow')
  const result = await runFlowExecution({ flowId: flow.id, organizationId: seeded.organizationId, userId: seeded.userId, input: {}, usePublished: true })
  assert.equal(result.status, 'succeeded')
  const row = await prisma.agentAction.findFirst({ where: { organizationId: seeded.organizationId, flowId: flow.id } })
  assert.equal(row.sourceKind, 'flow')
  assert.equal(row.runId, result.flowRunId)
  assert.equal(row.stepRef, 'table')
  assert.equal(row.status, 'done')
})

test('the ledger routes list an agent\'s entries with an undo verdict, and refuse what cannot be undone', { skip }, async () => {
  const list = await (await import('@/app/api/agent-actions/route')).GET(new NextRequest(`http://localhost/api/agent-actions?agentId=${agentId}`))
  assert.equal(list.status, 200)
  const body = await list.json()
  assert.ok(body.items.length >= 3)
  const gmail = body.items.find((item: any) => item.tool === 'gmail_send_email')
  assert.equal(gmail.undo.possible, false)
  const post = body.items.find((item: any) => item.tool === 'slack_post_message' && item.status === 'done')
  assert.equal(post.undo.possible, true)
  assert.equal(post.actsAs, 'user')

  const byRun = await (await import('@/app/api/agent-actions/route')).GET(new NextRequest(`http://localhost/api/agent-actions?runId=${executionId}`))
  assert.equal((await byRun.json()).items.length, body.items.length)

  const refuse = await (await import('@/app/api/agent-actions/[id]/undo/route')).POST(new NextRequest(`http://localhost/api/agent-actions/${gmail.id}/undo`, { method: 'POST' }))
  assert.equal(refuse.status, 400)
  const unknown = await (await import('@/app/api/agent-actions/[id]/undo/route')).POST(new NextRequest('http://localhost/api/agent-actions/nope/undo', { method: 'POST' }))
  assert.equal(unknown.status, 404)
  const noFilter = await (await import('@/app/api/agent-actions/route')).GET(new NextRequest('http://localhost/api/agent-actions'))
  assert.equal(noFilter.status, 400)
})
