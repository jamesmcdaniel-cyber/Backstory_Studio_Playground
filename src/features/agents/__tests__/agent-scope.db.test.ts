/**
 * The scope card against a real database, through the real loaders — and the
 * runtime's own loadTools on the same agent, so the two are compared, not each
 * checked against an expectation of its own.
 *
 * Discovery is seeded into the tool cache (as in mcp-tool-policy.db.test.ts):
 * the SSRF guard refuses any address a test could bind, and the cache is what
 * the loader reads first.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { NextRequest } from 'next/server'

const TEST_DB = process.env.TEST_DATABASE_URL
const skip = TEST_DB ? false : 'TEST_DATABASE_URL is not set — the scope card needs a real database'
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'ci-encryption-key'
  process.env.ENTITLEMENT_GATE = 'off'
}

let prisma: any
let seeded: { organizationId: string; userId: string; auth: any; cleanup: () => Promise<void> }
let planes: typeof import('@/features/agents/tool-planes')
let connection: { id: string; name: string }

const TOOLS = [
  { name: 'account_company_news', description: 'News', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
  { name: 'fetch_records', description: 'Fetch', inputSchema: { type: 'object', properties: {} } },
  { name: 'update_record', description: 'Change', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: false } },
]

before(async () => {
  if (!TEST_DB) return
  ;({ prisma } = await import('@/lib/prisma'))
  const { seedTestOrg, installTestAuth } = await import('@/lib/server/__tests__/test-auth')
  seeded = await seedTestOrg(prisma)
  installTestAuth(seeded.auth)
  planes = await import('@/features/agents/tool-planes')
  const { cacheSet } = await import('@/lib/cache')
  const serverUrl = `https://mcp-${crypto.randomUUID()}.invalid.test/mcp`
  await cacheSet(planes.toolDiscoveryCacheKey(seeded.organizationId, serverUrl), TOOLS, 60_000)
  connection = await prisma.mcpConnection.create({
    data: {
      organizationId: seeded.organizationId, userId: null, name: `Scope CRM ${crypto.randomUUID().slice(0, 6)}`, serverUrl,
      authType: 'none', isActive: true, toolPolicies: { fetch_records: 'off', update_record: 'approve' },
    },
  })
})

after(async () => {
  if (seeded) await seeded.cleanup()
})

async function agentWith(metadata: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return prisma.agentTask.create({
    data: { description: 'Scope agent', objective: 'o', status: 'ACTIVE', visibility: 'shared', organizationId: seeded.organizationId, userId: seeded.userId, metadata, ...extra },
  })
}

test('a tool blocked in Integrations is shown blocked on the card and is absent from the runtime tool list', { skip }, async () => {
  const agent = await agentWith({ requireApproval: true })
  const { resolveAgentScope } = await import('@/features/agents/agent-scope')
  const { loadTools } = await import('@/features/agents/execute-agent')
  const scope = await resolveAgentScope({ organizationId: seeded.organizationId, agent, viewerUserId: seeded.userId })
  const crm = scope.connections.find((c) => c.name === connection.name)!
  assert.equal(crm.actsAs, 'workspace')
  assert.deepEqual(crm.tools.find((t) => t.name === 'fetch_records'), { name: 'fetch_records', label: 'Fetch records', access: 'unclassified', status: 'blocked', blockedBy: 'integration' })
  assert.equal(crm.tools.find((t) => t.name === 'update_record')?.status, 'needs_approval')
  assert.equal(crm.tools.find((t) => t.name === 'update_record')?.approvalBy, 'integration')
  assert.equal(crm.tools.find((t) => t.name === 'account_company_news')?.access, 'read')

  const loaded = await loadTools(seeded.organizationId, [], seeded.userId)
  const slug = planes.mcpConnectionSlug(connection.name)
  const names = loaded.tools.map((tool: { name: string }) => tool.name)
  assert.equal(names.includes(planes.toolName(slug, 'fetch_records')), false)
  assert.ok(names.includes(planes.toolName(slug, 'account_company_news')))
  assert.equal(loaded.bindings.get(planes.toolName(slug, 'update_record'))?.needsApproval, true)
  // Every non-blocked card tool on this connection is a tool the run binds.
  for (const tool of crm.tools.filter((t) => t.status !== 'blocked')) {
    assert.ok(loaded.bindings.has(planes.toolName(slug, tool.name)), `${tool.name} is on the card but not in the run`)
  }
})

test("a tool left off the agent's own tool list is blocked by the agent, on the card and in the run", { skip }, async () => {
  const toolSettings = { [`mcp:${connection.id}`]: [{ id: 'account_company_news', label: 'account_company_news' }] }
  const agent = await agentWith({ toolSettings })
  const { resolveAgentScope } = await import('@/features/agents/agent-scope')
  const { loadTools } = await import('@/features/agents/execute-agent')
  const { parseAgentToolSettings } = await import('@/lib/connectors/tool-quick-config')
  const scope = await resolveAgentScope({ organizationId: seeded.organizationId, agent, viewerUserId: seeded.userId })
  const update = scope.connections.find((c) => c.name === connection.name)!.tools.find((t) => t.name === 'update_record')
  assert.equal(update?.status, 'blocked')
  assert.equal(update?.blockedBy, 'agent')
  const loaded = await loadTools(seeded.organizationId, [], seeded.userId, undefined, [], parseAgentToolSettings(toolSettings), agent.id)
  assert.equal(loaded.bindings.has(planes.toolName(planes.mcpConnectionSlug(connection.name), 'update_record')), false)
})

test('a published agent is described by its published definition, not its draft', { skip }, async () => {
  const agent = await agentWith(
    { requireApproval: false },
    { publishedConfig: { description: 'Scope agent', objective: 'o', metadata: { requireApproval: true }, connectorKeys: [] }, publishedAt: new Date() },
  )
  const { resolveAgentScope } = await import('@/features/agents/agent-scope')
  const scope = await resolveAgentScope({ organizationId: seeded.organizationId, agent, viewerUserId: seeded.userId })
  assert.equal(scope.approval.agentRequiresApproval, true)
})

test('triggers and the Repository scope come from the agent itself', { skip }, async () => {
  const agent = await agentWith({}, { schedule: { type: 'daily', time: '09:00', timezone: 'America/New_York', isActive: true } })
  await prisma.slackCommandBinding.create({ data: { organizationId: seeded.organizationId, command: `scope${Date.now()}`, agentTaskId: agent.id } })
  const collection = await prisma.knowledgeCollection.create({ data: { organizationId: seeded.organizationId, name: 'Playbooks' } })
  await prisma.agentKnowledgeCollection.create({ data: { organizationId: seeded.organizationId, agentId: agent.id, collectionId: collection.id } })
  const { resolveAgentScope } = await import('@/features/agents/agent-scope')
  const scope = await resolveAgentScope({ organizationId: seeded.organizationId, agent, viewerUserId: seeded.userId })
  assert.deepEqual(scope.triggers[0], { kind: 'schedule', description: 'Runs every day at 09:00 (America/New_York)' })
  assert.ok(scope.triggers.some((trigger) => trigger.kind === 'slack_command'))
  assert.deepEqual(scope.data.collections, [{ id: collection.id, name: 'Playbooks' }])
})

test('the scope routes answer for one agent and for the roster', { skip }, async () => {
  const agent = await agentWith({ requireApproval: true })
  const one = await (await import('@/app/api/agents/[id]/scope/route')).GET(new NextRequest(`http://localhost/api/agents/${agent.id}/scope`))
  assert.equal(one.status, 200)
  const body = await one.json()
  assert.equal(body.scope.agentId, agent.id)
  assert.ok(body.scope.counts.blocked >= 1)

  const missing = await (await import('@/app/api/agents/[id]/scope/route')).GET(new NextRequest('http://localhost/api/agents/nope/scope'))
  assert.equal(missing.status, 404)

  const roster = await (await import('@/app/api/agents/scope/route')).GET(new NextRequest('http://localhost/api/agents/scope'))
  assert.equal(roster.status, 200)
  const summaries = (await roster.json()).scopes
  assert.equal(summaries[agent.id].agentRequiresApproval, true)
  assert.equal(summaries[agent.id].counts.blocked, body.scope.counts.blocked, 'the roster summary and the full card are the same resolution')
})
