import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'

/**
 * The regression guard for declaring permissions across every route: a plain
 * USER-role member must still reach everything they could reach before.
 *
 * The risk is specific. Routes that LOOK administrative by name are called by
 * ordinary members — the flow builder lists available integrations, the jam
 * dialog lists workspace members — so mapping them to integration.manage or
 * members.manage would 403 exactly the people who use them. These assertions
 * are what make "no behavior change" a checked claim rather than a hope.
 */
const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let seeded: any
  let prisma: any

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    const { seedTestOrg, installTestAuth } = await import('@/lib/server/__tests__/test-auth')
    // A plain member, NOT an admin.
    seeded = await seedTestOrg(prisma, { role: 'USER' })
    installTestAuth(seeded.auth)
  })

  after(async () => {
    if (seeded) await seeded.cleanup()
  })

  const req = (path: string) => new NextRequest(new URL(`http://test${path}`))

  const reachable: Array<{ name: string; run: () => Promise<Response> }> = [
    { name: 'GET /api/flows', run: async () => (await import('../flows/route')).GET(req('/api/flows')) },
    { name: 'GET /api/agents', run: async () => (await import('../agents/route')).GET(req('/api/agents')) },
    { name: 'GET /api/flow-templates', run: async () => (await import('../flow-templates/route')).GET(req('/api/flow-templates')) },
    { name: 'GET /api/agent-templates', run: async () => (await import('../agent-templates/route')).GET(req('/api/agent-templates')) },
    { name: 'GET /api/skills', run: async () => (await import('../skills/route')).GET(req('/api/skills')) },
    { name: 'GET /api/notifications', run: async () => (await import('../notifications/route')).GET(req('/api/notifications')) },
    { name: 'GET /api/auth/context', run: async () => (await import('../auth/context/route')).GET(req('/api/auth/context')) },
    { name: 'GET /api/snapshot', run: async () => (await import('../snapshot/route')).GET(req('/api/snapshot')) },
    { name: 'GET /api/signals', run: async () => (await import('../signals/route')).GET(req('/api/signals')) },
    { name: 'GET /api/usage', run: async () => (await import('../usage/route')).GET(req('/api/usage')) },
    { name: 'GET /api/setup/status', run: async () => (await import('../setup/status/route')).GET(req('/api/setup/status')) },
    // Administrative BY NAME, member-facing IN FACT:
    { name: 'GET /api/integrations/available', run: async () => (await import('../integrations/available/route')).GET(req('/api/integrations/available')) },
    { name: 'GET /api/integrations/count', run: async () => (await import('../integrations/count/route')).GET(req('/api/integrations/count')) },
    { name: 'GET /api/organizations/members', run: async () => (await import('../organizations/members/route')).GET(req('/api/organizations/members')) },
    { name: 'GET /api/mcp-connections', run: async () => (await import('../mcp-connections/route')).GET(req('/api/mcp-connections')) },
  ]

  for (const route of reachable) {
    test(`a plain member still reaches ${route.name}`, async () => {
      const response = await route.run()
      assert.notEqual(response.status, 403, `${route.name} now 403s for an ordinary member`)
    })
  }

  test('a plain member is still refused admin-only routes', async () => {
    const { GET } = await import('../audit/export/route')
    const response = await GET(req('/api/audit/export'))
    assert.equal(response.status, 403)
    assert.equal((await response.json()).code, 'PERMISSION_DENIED')
  })

  test('a plain member cannot manage workspace invitations', async () => {
    const { GET } = await import('../organizations/invitations/route')
    const response = await GET(req('/api/organizations/invitations'))
    assert.equal(response.status, 403)
  })
}
