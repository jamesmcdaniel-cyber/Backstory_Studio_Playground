import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'
import { randomBytes } from 'node:crypto'

/**
 * A `private` flow belongs to its owner, not to the workspace. Eleven
 * single-flow routes enforced that and three did not — the export route, and
 * the public API's read and write paths. These pin all of them, because "can
 * export it" and "can delete it through an API key" are the same boundary as
 * "can open it".
 */
const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  let hashToken: any
  let installTestAuth: any
  let owner: any
  let colleague: any
  let privateFlowId: string
  let sharedFlowId: string
  let colleagueKey: string

  const mkFlow = (visibility: string, userId: string, organizationId: string) =>
    prisma.flow.create({
      data: { name: `${visibility} flow`, visibility, userId, organizationId, graph: { nodes: [], edges: [] } },
    })

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    ;({ hashToken } = await import('@/lib/crypto/secrets'))
    const testAuth = await import('@/lib/server/__tests__/test-auth')
    installTestAuth = testAuth.installTestAuth

    owner = await testAuth.seedTestOrg(prisma)
    // Same workspace, different person — seedTestOrg makes its own org, so the
    // colleague is created directly against the owner's organization.
    const colleagueUser = await prisma.user.create({
      data: {
        supabaseId: randomBytes(16).toString('hex'),
        organizationId: owner.organizationId,
        isActive: true,
        role: 'ADMIN',
      },
    })
    colleague = { userId: colleagueUser.id, organizationId: owner.organizationId }

    privateFlowId = (await mkFlow('private', owner.userId, owner.organizationId)).id
    sharedFlowId = (await mkFlow('shared', owner.userId, owner.organizationId)).id

    colleagueKey = `bsk_${randomBytes(32).toString('hex')}`
    await prisma.apiKey.create({
      data: {
        name: 'colleague key',
        keyHash: hashToken(colleagueKey),
        prefix: colleagueKey.slice(0, 12),
        scopes: ['flows:read', 'flows:write'],
        organizationId: owner.organizationId,
        userId: colleagueUser.id,
      },
    })
  })

  after(async () => {
    if (owner) await owner.cleanup()
  })

  const exportRequest = (flowId: string) =>
    new NextRequest(new URL(`http://test/api/flows/${flowId}/export`))

  const apiRequest = (path: string, method = 'GET', body?: unknown) =>
    new Request(`http://test/api/v1/flows${path}`, {
      method,
      headers: { authorization: `Bearer ${colleagueKey}`, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })

  test('a colleague cannot export another member’s private flow', async () => {
    const { GET } = await import('../[id]/export/route')

    installTestAuth({ ...owner.auth, dbUser: { ...owner.auth.dbUser, id: colleague.userId }, userId: colleague.userId })
    const refused = await GET(exportRequest(privateFlowId))
    assert.equal(refused.status, 404, 'a private flow must not be exportable by a colleague')

    // The same caller can still export what the workspace shares.
    const allowed = await GET(exportRequest(sharedFlowId))
    assert.equal(allowed.status, 200, 'shared flows stay exportable')
  })

  test('the owner can still export their own private flow', async () => {
    const { GET } = await import('../[id]/export/route')
    installTestAuth(owner.auth)
    const response = await GET(exportRequest(privateFlowId))
    assert.equal(response.status, 200)
  })

  test('an API key does not expose another member’s private flow', async () => {
    const list = await (await import('@/app/api/v1/flows/route')).GET(apiRequest(''))
    const body = await list.json()
    const ids = body.data.map((flow: { id: string }) => flow.id)
    assert.ok(!ids.includes(privateFlowId), 'private flow must not appear in the API listing')
    assert.ok(ids.includes(sharedFlowId), 'shared flows must still be listed')

    const single = await (await import('@/app/api/v1/flows/[id]/route')).GET(apiRequest(`/${privateFlowId}`))
    assert.equal(single.status, 404)
  })

  test('an API key cannot update or delete another member’s private flow', async () => {
    const routes = await import('@/app/api/v1/flows/[id]/route')

    const updated = await routes.PUT(
      apiRequest(`/${privateFlowId}`, 'PUT', {
        format: 'backstory.flow.v1',
        flow: { name: 'hijacked', graph: { nodes: [], edges: [] } },
      }),
    )
    assert.equal(updated.status, 404)

    const deleted = await routes.DELETE(apiRequest(`/${privateFlowId}`, 'DELETE'))
    assert.equal(deleted.status, 404)

    const still = await prisma.flow.findFirst({
      where: { id: privateFlowId, organizationId: owner.organizationId },
    })
    assert.ok(still, 'the private flow must survive')
    assert.equal(still.name, 'private flow', 'and must not have been renamed')
  })
}
