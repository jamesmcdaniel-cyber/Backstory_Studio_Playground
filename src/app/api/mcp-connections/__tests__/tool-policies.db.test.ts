/**
 * The per-tool permission API behind the Integrations detail view, and the
 * personal-row ownership rule PUT and DELETE now share with PATCH.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { NextRequest } from 'next/server'

const TEST_DB = process.env.TEST_DATABASE_URL
const skip = TEST_DB ? false : 'TEST_DATABASE_URL is not set — the MCP tool permission routes need a real database'
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'ci-encryption-key'
}

let prisma: any
let seeded: any
let member: any
let installTestAuth: (auth: any) => void
let routes: typeof import('../[id]/tools/route')
let base: typeof import('../route')

const TOOLS = [
  { name: 'account_company_news', description: 'News about an account', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
  { name: 'update_record', inputSchema: { type: 'object' }, annotations: { readOnlyHint: false, destructiveHint: true } },
]

before(async () => {
  if (!TEST_DB) return
  ;({ prisma } = await import('@/lib/prisma'))
  const testAuth = await import('@/lib/server/__tests__/test-auth')
  installTestAuth = testAuth.installTestAuth
  seeded = await testAuth.seedTestOrg(prisma)
  // A plain member of the same workspace: no integration.manage.
  const memberRow = await prisma.user.create({ data: { supabaseId: crypto.randomUUID(), organizationId: seeded.organizationId, isActive: true, role: 'USER' } })
  const { resolvePermissions } = await import('@/lib/authz/permissions')
  const permissions = resolvePermissions({ role: memberRow.role, platformRole: null }, { kind: 'customer' })
  member = { ...seeded.auth, userId: memberRow.id, dbUser: memberRow, permissions, can: (permission: string) => permissions.has(permission as never) }
  assert.equal(member.can('integration.manage'), false, 'fixture: a member cannot manage integrations')
  routes = await import('../[id]/tools/route')
  base = await import('../route')
})

after(async () => {
  if (seeded) await seeded.cleanup()
})

async function connection(overrides: Record<string, unknown> = {}) {
  const serverUrl = `https://mcp-${crypto.randomUUID()}.invalid.test/mcp`
  const { cacheSet } = await import('@/lib/cache')
  const { toolDiscoveryCacheKey } = await import('@/features/agents/tool-planes')
  await cacheSet(toolDiscoveryCacheKey(seeded.organizationId, serverUrl), TOOLS, 60_000)
  return prisma.mcpConnection.create({
    data: { organizationId: seeded.organizationId, name: 'Backstory Demo', description: 'Sales AI', serverUrl, authType: 'none', isActive: true, ...overrides },
  })
}

const patch = (id: string, tools: unknown) => routes.PATCH(new NextRequest(`https://qa.invalid/api/mcp-connections/${id}/tools`, {
  method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tools }),
}))
const getAll = (id: string) => routes.GET(new NextRequest(`https://qa.invalid/api/mcp-connections/${id}/tools?all=1`))
const policiesOf = async (id: string) => (await prisma.mcpConnection.findFirst({ where: { id, organizationId: seeded.organizationId } })).toolPolicies

test('?all=1 lists every tool with a readable name, its hint and its permission, plus the connection', { skip }, async () => {
  const conn = await connection({ toolPolicies: { update_record: 'off' } })
  installTestAuth(seeded.auth)
  const res = await getAll(conn.id)
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.success, true)
  assert.deepEqual(body.items, [
    { name: 'account_company_news', title: 'Account company news', description: 'News about an account', readOnly: true, policy: 'allow' },
    { name: 'update_record', title: 'Update record', description: '', readOnly: false, destructive: true, policy: 'off' },
  ])
  assert.equal(body.connection.name, 'Backstory Demo')
  assert.equal(body.connection.needsSignIn, false)
  assert.equal(body.connection.canManage, true)
  assert.equal('authConfig' in body.connection, false, 'no credential material')

  // The runtime list (the agent popover) still withholds the blocked tool.
  const runtime = await (await routes.GET(new NextRequest(`https://qa.invalid/api/mcp-connections/${conn.id}/tools`))).json()
  assert.deepEqual(runtime.items.map((item: any) => item.name), ['account_company_news'])
})

test('PATCH sets one or many permissions, "allow" clears the entry, and every change is audited', { skip }, async () => {
  const conn = await connection()
  installTestAuth(seeded.auth)
  assert.equal((await patch(conn.id, { update_record: 'approve' })).status, 200)
  assert.deepEqual(await policiesOf(conn.id), { update_record: 'approve' })
  assert.equal((await patch(conn.id, { update_record: 'allow', account_company_news: 'off' })).status, 200)
  assert.deepEqual(await policiesOf(conn.id), { account_company_news: 'off' })
  const audits = await prisma.auditEvent.findMany({ where: { organizationId: seeded.organizationId, resourceId: conn.id, action: 'mcp_connection.tool_policy_changed' }, orderBy: { createdAt: 'asc' } })
  assert.equal(audits.length, 2)
  assert.deepEqual(audits[1].detail.changes, { update_record: { from: 'approve', to: 'allow' }, account_company_news: { from: 'allow', to: 'off' } })
  // A no-op change writes no audit row.
  assert.equal((await patch(conn.id, { account_company_news: 'off' })).status, 200)
  assert.equal(await prisma.auditEvent.count({ where: { organizationId: seeded.organizationId, resourceId: conn.id, action: 'mcp_connection.tool_policy_changed' } }), 2)
  assert.equal((await patch(conn.id, { update_record: 'sometimes' })).status, 400)
  assert.equal((await patch(conn.id, {})).status, 400)
})

test('concurrent changes to different tools both land', { skip }, async () => {
  const conn = await connection()
  installTestAuth(seeded.auth)
  const results = await Promise.all([patch(conn.id, { update_record: 'off' }), patch(conn.id, { account_company_news: 'approve' })])
  assert.deepEqual(results.map((res) => res.status), [200, 200])
  assert.deepEqual(await policiesOf(conn.id), { update_record: 'off', account_company_news: 'approve' })
})

test('shared servers need integration.manage; personal ones need their owner', { skip }, async () => {
  const shared = await connection()
  const mine = await connection({ userId: member.dbUser.id, name: 'Member own' })
  const theirs = await connection({ userId: seeded.userId, name: 'Admin own' })
  installTestAuth(member)
  assert.equal((await patch(shared.id, { update_record: 'off' })).status, 403, 'a member cannot change a shared server')
  assert.equal((await (await getAll(shared.id)).json()).connection.canManage, false, 'and the view says so')
  assert.equal((await patch(mine.id, { update_record: 'off' })).status, 200, 'a member owns their personal server')
  assert.equal((await patch(theirs.id, { update_record: 'off' })).status, 404, 'another member’s server is not there')
  installTestAuth(seeded.auth)
  assert.equal((await patch(mine.id, { update_record: 'allow' })).status, 404, 'not even an admin edits someone’s personal server')
  assert.deepEqual(await policiesOf(mine.id), { update_record: 'off' })
})

test('platform-managed connections take permissions (policy), though PUT refuses their config', { skip }, async () => {
  const managed = await connection({ provider: 'backstory', userId: seeded.userId, name: 'Backstory' })
  installTestAuth(seeded.auth)
  assert.equal((await patch(managed.id, { update_record: 'approve' })).status, 200)
  assert.deepEqual(await policiesOf(managed.id), { update_record: 'approve' })
})

test('PUT and DELETE refuse another member’s personal connection', { skip }, async () => {
  const theirs = await connection({ userId: member.dbUser.id, name: 'Member private' })
  installTestAuth(seeded.auth)
  const put = await base.PUT(new NextRequest('https://qa.invalid/api/mcp-connections', {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: theirs.id, name: 'hijacked' }),
  }))
  assert.equal(put.status, 404)
  const del = await base.DELETE(new NextRequest(`https://qa.invalid/api/mcp-connections?id=${theirs.id}`, { method: 'DELETE' }))
  assert.equal(del.status, 404)
  const row = await prisma.mcpConnection.findFirst({ where: { id: theirs.id, organizationId: seeded.organizationId } })
  assert.equal(row?.name, 'Member private', 'untouched')

  // Ownership narrows the route; it does not widen it: removing a server still
  // takes integration.manage, which a plain member does not hold — and the
  // detail view's canEdit says exactly that.
  installTestAuth(member)
  const own = await base.DELETE(new NextRequest(`https://qa.invalid/api/mcp-connections?id=${theirs.id}`, { method: 'DELETE' }))
  assert.equal(own.status, 403)
  assert.equal((await (await getAll(theirs.id)).json()).connection.canEdit, false)
  installTestAuth(seeded.auth)
  const adminsOwn = await connection({ userId: seeded.userId, name: 'Admin removable' })
  assert.equal((await (await getAll(adminsOwn.id)).json()).connection.canEdit, true)
  assert.equal((await base.DELETE(new NextRequest(`https://qa.invalid/api/mcp-connections?id=${adminsOwn.id}`, { method: 'DELETE' }))).status, 200)
})
