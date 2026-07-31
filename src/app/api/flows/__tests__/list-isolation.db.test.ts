import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'

/**
 * GET /api/flows runs on systemPrisma — the tenant guard is OFF for it.
 *
 * It has to be: the list includes flows shared with you from other workspaces,
 * so its `where` has an OR branch with no organizationId in it. That is exactly
 * the shape an accidental cross-tenant leak takes, and the guard now rejects it
 * for guarded queries, which is why this one is spelled out with systemPrisma.
 *
 * The access boundary is therefore application code, not the client extension.
 * These tests are what stands behind it: a stranger sees nothing, a collaborator
 * sees precisely the flow they were granted and nothing else from that org.
 */

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  process.env.ENTITLEMENT_GATE = 'off'

  let prisma: any
  let seedTestOrg: any
  let installTestAuth: any
  let listRoute: any

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    ;({ seedTestOrg, installTestAuth } = await import('@/lib/server/__tests__/test-auth'))
    listRoute = await import('../route')
  })

  const list = () => listRoute.GET(new NextRequest(new URL('http://test/api/flows')))

  const mkFlow = (organizationId: string, userId: string, name: string) =>
    prisma.flow.create({ data: { organizationId, userId, name, graph: { nodes: [], edges: [] } } })

  test('a user never sees another workspace’s flows', async () => {
    const orgA = await seedTestOrg(prisma)
    const orgB = await seedTestOrg(prisma)
    try {
      const secret = await mkFlow(orgA.organizationId, orgA.userId, 'Org A private business')
      await mkFlow(orgB.organizationId, orgB.userId, 'Org B own flow')

      installTestAuth(orgB.auth)
      const body = await (await list()).json()
      const ids = (body.flows ?? []).map((flow: { id: string }) => flow.id)

      assert.ok(!ids.includes(secret.id), 'org A’s flow must not appear in org B’s list')
      assert.equal(body.flows.length, 1, 'org B sees only its own flow')
    } finally {
      await orgA.cleanup()
      await orgB.cleanup()
    }
  })

  test('a collaborator sees the one flow shared with them — not the rest of that workspace', async () => {
    const ownerOrg = await seedTestOrg(prisma)
    const guestOrg = await seedTestOrg(prisma)
    try {
      const shared = await mkFlow(ownerOrg.organizationId, ownerOrg.userId, 'Shared with guest')
      const notShared = await mkFlow(ownerOrg.organizationId, ownerOrg.userId, 'Not shared')

      // The durable grant a share-link acceptance creates.
      await prisma.flowCollaborator.create({
        data: { flowId: shared.id, userId: guestOrg.userId, role: 'view' },
      })

      installTestAuth(guestOrg.auth)
      const body = await (await list()).json()
      const ids = (body.flows ?? []).map((flow: { id: string }) => flow.id)

      assert.ok(ids.includes(shared.id), 'the shared flow is reachable across workspaces')
      assert.ok(!ids.includes(notShared.id), 'a grant on one flow must not expose the workspace')
    } finally {
      await ownerOrg.cleanup()
      await guestOrg.cleanup()
    }
  })

  test('a private flow stays invisible to the rest of its own workspace', async () => {
    const org = await seedTestOrg(prisma)
    try {
      const owner = await prisma.user.create({
        data: {
          supabaseId: crypto.randomUUID(),
          email: `owner-${Date.now()}@test.local`,
          name: 'Owner',
          organizationId: org.organizationId,
        },
      })
      const hidden = await prisma.flow.create({
        data: {
          organizationId: org.organizationId,
          userId: owner.id,
          name: 'Someone else’s private flow',
          visibility: 'private',
          graph: { nodes: [], edges: [] },
        },
      })

      // The seeded user is a DIFFERENT member of the same workspace.
      installTestAuth(org.auth)
      const body = await (await list()).json()
      const ids = (body.flows ?? []).map((flow: { id: string }) => flow.id)

      assert.ok(!ids.includes(hidden.id), 'private means private to its owner, even inside one org')
    } finally {
      await org.cleanup()
    }
  })
}
