/**
 * Per-tool MCP permissions (McpConnection.toolPolicies), end to end against a
 * real database.
 *
 * A tool turned off in Integrations must never reach a model or a server:
 * not through an agent's discovered tools, not through the template/shared
 * copilot path, not through a flow tool step that names it directly. A tool
 * set to "Needs approval" is bound with the approval gate where a person can
 * be asked, and refused where nobody can.
 *
 * Discovery is seeded into the tool cache rather than served by a live MCP
 * server: the SSRF guard refuses every address a test could bind, and the
 * cache is exactly what the loader reads first.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

const TEST_DB = process.env.TEST_DATABASE_URL
const skip = TEST_DB ? false : 'TEST_DATABASE_URL is not set — per-tool MCP permissions need a real database'
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'ci-encryption-key'
}

let prisma: any
let seeded: { organizationId: string; userId: string; auth: any; cleanup: () => Promise<void> }
let planes: typeof import('@/features/agents/tool-planes')
let cacheSet: typeof import('@/lib/cache').cacheSet

const TOOLS = [
  { name: 'account_company_news', description: 'News about an account', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
  { name: 'fetch_records', description: 'Fetch CRM records', inputSchema: { type: 'object', properties: {} } },
  { name: 'update_record', description: 'Change a CRM record', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: false, destructiveHint: true } },
]

before(async () => {
  if (!TEST_DB) return
  ;({ prisma } = await import('@/lib/prisma'))
  const { seedTestOrg } = await import('@/lib/server/__tests__/test-auth')
  seeded = await seedTestOrg(prisma)
  planes = await import('@/features/agents/tool-planes')
  ;({ cacheSet } = await import('@/lib/cache'))
})

after(async () => {
  if (seeded) await seeded.cleanup()
})

/** A connection whose discovery is already cached: fetch_records off, update_record needs approval. */
async function seedConnection(overrides: Record<string, unknown> = {}) {
  const serverUrl = `https://mcp-${crypto.randomUUID()}.invalid.test/mcp`
  await cacheSet(planes.toolDiscoveryCacheKey(seeded.organizationId, serverUrl), TOOLS, 60_000)
  return prisma.mcpConnection.create({
    data: {
      organizationId: seeded.organizationId,
      userId: null,
      name: `Policy CRM ${crypto.randomUUID().slice(0, 6)}`,
      serverUrl,
      authType: 'none',
      isActive: true,
      toolPolicies: { fetch_records: 'off', update_record: 'approve' },
      ...overrides,
    },
  })
}

test('the loader withholds a blocked tool, names it, and keeps it only for the settings view', { skip }, async () => {
  const conn = await seedConnection()
  const [group] = await planes.loadMcpConnectionPlaneGroups(seeded.organizationId, seeded.userId, { connectionIds: [conn.id] })
  assert.deepEqual(group.tools.map((tool: any) => tool.name), ['account_company_news', 'update_record'])
  assert.deepEqual(group.blockedTools, ['fetch_records'])
  assert.equal(group.tools.find((tool: any) => tool.name === 'update_record')?.policy, 'approve')
  assert.equal(group.tools.find((tool: any) => tool.name === 'account_company_news')?.policy, undefined, 'absent = allowed')
  assert.deepEqual(group.tools.find((tool: any) => tool.name === 'account_company_news')?.annotations, { readOnlyHint: true })

  const [settings] = await planes.loadMcpConnectionPlaneGroups(seeded.organizationId, seeded.userId, { connectionIds: [conn.id], includeBlocked: true })
  assert.deepEqual(settings.tools.map((tool: any) => [tool.name, tool.policy ?? 'allow']), [
    ['account_company_news', 'allow'], ['fetch_records', 'off'], ['update_record', 'approve'],
  ])
})

test('an agent never discovers a blocked tool; a needs-approval tool is bound to the gate with its connection', { skip }, async () => {
  const conn = await seedConnection()
  const { loadTools } = await import('@/features/agents/execute-agent')
  const loaded = await loadTools(seeded.organizationId, [], seeded.userId)
  const slug = planes.mcpConnectionSlug(conn.name)
  const names = loaded.tools.map((tool: any) => tool.name)
  assert.ok(names.includes(planes.toolName(slug, 'account_company_news')))
  assert.equal(names.includes(planes.toolName(slug, 'fetch_records')), false, 'a blocked tool must not reach the model')
  const gated = loaded.bindings.get(planes.toolName(slug, 'update_record'))
  assert.equal(gated?.needsApproval, true)
  assert.equal(gated?.mcpConnectionId, conn.id, 'the approval records which connection executes it')
  assert.equal(loaded.bindings.get(planes.toolName(slug, 'account_company_news'))?.needsApproval, undefined)
})

test('the shared/template copilot path gets neither blocked nor needs-approval tools', { skip }, async () => {
  const conn = await seedConnection({ shareableWithCopilots: true })
  const { loadTools } = await import('@/features/agents/execute-agent')
  const loaded = await loadTools(seeded.organizationId, [], seeded.userId, undefined, [], {}, undefined, {
    artifactId: `missing-${crypto.randomUUID()}`, kind: 'report', executionId: 'exec-policy', request: null, templateCopy: true,
  })
  const slug = planes.mcpConnectionSlug(conn.name)
  const names = loaded.tools.map((tool: any) => tool.name)
  assert.ok(names.includes(planes.toolName(slug, 'account_company_news')), 'an allowed shareable tool still loads')
  assert.equal(names.includes(planes.toolName(slug, 'fetch_records')), false, 'blocked')
  assert.equal(names.includes(planes.toolName(slug, 'update_record')), false, 'nobody on a shared link can approve it')
})

test('flow execution refuses a blocked tool by name, before any credential is used', { skip }, async () => {
  const conn = await seedConnection()
  const resolve = (toolName: string, approval?: 'gate' | 'approved') => planes.resolveFlowToolExecutor({
    organizationId: seeded.organizationId, userId: seeded.userId, plane: 'mcp', ref: conn.id, toolName, ...(approval ? { approval } : {}),
  })
  await assert.rejects(resolve('fetch_records'), (error: Error) => error.message === `fetch_records is turned off for ${conn.name} in Integrations`)
  await assert.rejects(resolve('fetch_records', 'approved'), /turned off/, 'even an approval cannot run a blocked tool')
  await assert.rejects(resolve('update_record'), /needs approval/, 'an unattended caller (poll, option lookup) is refused')
  assert.equal((await resolve('update_record', 'gate')).needsApproval, true, 'a flow tool step is told to queue it')
  assert.equal((await resolve('update_record', 'approved')).needsApproval, undefined)
  const allowed = await resolve('account_company_news')
  assert.equal(allowed.needsApproval, undefined)
  await assert.rejects(allowed.execute('fetch_records', {}), /turned off/, 'an executor resolved for one tool cannot be reused for a blocked one')
})

test('an approval queued before its tool was turned off does not execute it', { skip }, async () => {
  const conn = await seedConnection()
  const { createApproval, decideApproval } = await import('@/lib/agents/approval')
  const executionId = `exec-${crypto.randomUUID()}`
  const { id } = await createApproval({
    organizationId: seeded.organizationId, executionId, userId: seeded.userId,
    provider: planes.mcpConnectionSlug(conn.name), tool: 'update_record', args: { id: 1 }, mcpConnectionId: conn.id,
  })
  const stored = await prisma.approvalRequest.findFirst({ where: { id, organizationId: seeded.organizationId } })
  assert.equal(stored.payload.mcpConnectionId, conn.id)
  await prisma.mcpConnection.update({ where: { id: conn.id, organizationId: seeded.organizationId }, data: { toolPolicies: { update_record: 'off' } } })
  const decided = await decideApproval({ approvalId: id, organizationId: seeded.organizationId, deciderUserId: seeded.userId, approve: true })
  assert.equal(decided.status, 'approved')
  assert.equal(decided.executed, false)
  const audit = await prisma.auditEvent.findFirst({ where: { organizationId: seeded.organizationId, resourceId: id, action: { startsWith: 'approval.approved' } } })
  assert.equal(audit?.action, 'approval.approved_noexec')
})

test('the flow catalogue withholds a blocked tool and validation says it was turned off', { skip }, async () => {
  const conn = await seedConnection()
  const { loadFlowToolCatalog } = await import('@/lib/flows/tool-catalog')
  const { validateFlowGraph } = await import('@/lib/flows/validate')
  const catalog = await loadFlowToolCatalog(seeded.organizationId, { userId: seeded.userId, connectionIds: [conn.id] })
  const entry = catalog.find((connection) => connection.id === conn.id)!
  assert.equal(entry.tools.some((tool) => tool.name === 'fetch_records'), false)
  assert.deepEqual(entry.blockedTools, ['fetch_records'])
  const graph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: { trigger: { type: 'manual' } } },
      { id: 'step', type: 'tool', data: { label: 'Fetch', connectionId: conn.id, toolName: 'fetch_records', args: '{}' } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'step' }],
  }
  const { issues } = validateFlowGraph(graph as never, { toolCatalog: catalog })
  const unknown = issues.find((issue) => issue.code === 'UNKNOWN_TOOL')
  assert.match(unknown?.message ?? '', new RegExp(`fetch_records, which is turned off for ${conn.name} in Integrations`))
})

test('a flow tool step pauses on a needs-approval tool and resumes on the decision', { skip }, async () => {
  const conn = await seedConnection()
  const { runFlowExecution } = await import('@/features/flows/execute-flow')
  const { decideApproval } = await import('@/lib/agents/approval')
  const position = { x: 0, y: 0 }
  const graph = {
    nodes: [
      { id: 'trigger', type: 'trigger', position, data: { trigger: { type: 'manual' } } },
      { id: 'step', type: 'tool', position, data: { label: 'Update', connectionId: conn.id, toolName: 'update_record', args: '{"id":"001"}' } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'step' }],
  }
  const flow = await prisma.flow.create({ data: { name: 'policy-flow', organizationId: seeded.organizationId, status: 'ACTIVE', graph, publishedGraph: graph } })
  const started = await runFlowExecution({ flowId: flow.id, organizationId: seeded.organizationId, userId: seeded.userId, input: '' })
  assert.equal(started.status, 'waiting', 'the step is queued for a person, not run')
  const approval = await prisma.approvalRequest.findFirst({ where: { organizationId: seeded.organizationId, executionId: started.flowRunId } })
  assert.equal(approval?.tool, 'update_record')
  assert.equal(approval?.payload.mcpConnectionId, conn.id)

  const decided = await decideApproval({ approvalId: approval.id, organizationId: seeded.organizationId, deciderUserId: seeded.userId, approve: false })
  assert.ok(decided.resumeFlow, 'the paused flow run is handed back to resume')
  const resumed = await runFlowExecution({
    flowId: flow.id, organizationId: seeded.organizationId, userId: seeded.userId,
    flowRunId: started.flowRunId, reply: decided.resumeFlow!.reply,
  })
  assert.equal(resumed.status, 'failed')
  const step = await prisma.flowRunStep.findFirst({ where: { flowRunId: started.flowRunId, nodeId: 'step', status: 'failed' } })
  assert.match(step?.error ?? '', /rejected/)
})

test('turning a tool off never touches the verification hash or health state', { skip }, async () => {
  const conn = await seedConnection({ toolSchemaHash: 'sha-before', healthStatus: 'healthy', toolPolicies: {} })
  const { installTestAuth } = await import('@/lib/server/__tests__/test-auth')
  const { NextRequest } = await import('next/server')
  const { PATCH } = await import('@/app/api/mcp-connections/[id]/tools/route')
  installTestAuth(seeded.auth)
  const res = await PATCH(new NextRequest(`https://qa.invalid/api/mcp-connections/${conn.id}/tools`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tools: { fetch_records: 'off' } }),
  }))
  assert.equal(res.status, 200)
  const row = await prisma.mcpConnection.findFirst({ where: { id: conn.id, organizationId: seeded.organizationId } })
  assert.deepEqual(row.toolPolicies, { fetch_records: 'off' })
  assert.equal(row.toolSchemaHash, 'sha-before')
  assert.equal(row.healthStatus, 'healthy')
})
