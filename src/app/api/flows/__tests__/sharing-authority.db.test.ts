import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'
import { randomBytes } from 'node:crypto'

/**
 * Two facts the builder renders from, pinned at the routes that compute them:
 *
 *  - `canEdit` is the sharing role AND the caller's flow.write. A VIEWER member
 *    resolves to role 'edit' on a shared flow; built from the role alone, their
 *    editor autosaved into a silent 403 and could win the jam's persister
 *    election, so the real editors stopped saving.
 *  - visibility is the OWNER's to change. Every non-shared visibility hands the
 *    flow to `flow.userId`, so a non-owner editor choosing "Only me" gave the
 *    flow away and locked themselves and the team out.
 */
const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  let installTestAuth: any
  let resolvePermissions: any
  let owner: any
  let member: any
  let viewer: any

  /** An auth context for another person in the owner's workspace. */
  const asUser = (user: { id: string; supabaseId: string; role: string; platformRole: string | null }) => {
    const permissions = resolvePermissions({ role: user.role, platformRole: user.platformRole }, { kind: 'customer' })
    return {
      ...owner.auth,
      userId: user.id,
      dbUser: user,
      user: { id: user.supabaseId },
      permissions,
      can: (permission: string) => permissions.has(permission),
    }
  }

  const mkUser = (role: 'USER' | 'VIEWER') =>
    prisma.user.create({
      data: { supabaseId: randomBytes(16).toString('hex'), organizationId: owner.organizationId, isActive: true, role },
    })

  const mkFlow = (visibility: string, userId: string | null) =>
    prisma.flow.create({
      data: { name: `${visibility} flow`, visibility, userId, organizationId: owner.organizationId, graph: { nodes: [], edges: [] } },
    })

  const put = async (body: Record<string, unknown>) => {
    const { PUT } = await import('../route')
    const response = await PUT(new NextRequest(new URL('http://test/api/flows'), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }))
    return { status: response.status, body: await response.json() }
  }

  const listed = async (flowId: string) => {
    const { GET } = await import('../route')
    const body = await (await GET(new NextRequest(new URL('http://test/api/flows')))).json()
    return body.flows.find((flow: { id: string }) => flow.id === flowId)
  }

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    ;({ resolvePermissions } = await import('@/lib/authz/permissions'))
    const testAuth = await import('@/lib/server/__tests__/test-auth')
    installTestAuth = testAuth.installTestAuth
    owner = await testAuth.seedTestOrg(prisma)
    member = asUser(await mkUser('USER'))
    viewer = asUser(await mkUser('VIEWER'))
  })

  after(async () => {
    if (owner) await owner.cleanup()
  })

  test('a VIEWER member is served canEdit:false on a shared flow, from both read routes', async () => {
    const flow = await mkFlow('shared', owner.userId)
    installTestAuth(viewer)
    const card = await listed(flow.id)
    assert.equal(card.role, 'edit', 'the sharing role alone would have said edit')
    assert.equal(card.canEdit, false, 'flow.write is folded in')
    assert.equal(card.canChangeSharing, false)

    const { GET } = await import('../[id]/route')
    const single = await (await GET(new NextRequest(new URL(`http://test/api/flows/${flow.id}`)))).json()
    assert.equal(single.flow.canEdit, false)

    // And the write it would have attempted is the one the server refuses.
    const save = await put({ id: flow.id, graph: { nodes: [], edges: [] } })
    assert.equal(save.status, 403)
  })

  test('a member editor may edit a shared flow but not change its sharing', async () => {
    const flow = await mkFlow('shared', owner.userId)
    installTestAuth(member)
    const card = await listed(flow.id)
    assert.equal(card.canEdit, true)
    assert.equal(card.canChangeSharing, false, 'editing is not owning')

    const refused = await put({ id: flow.id, visibility: 'private' })
    assert.equal(refused.status, 403)
    assert.equal(refused.body.code, 'FLOW_OWNER_REQUIRED')
    assert.match(refused.body.error, /owner/i, 'the refusal says why, for the UI to show')
    const after = await prisma.flow.findFirst({ where: { id: flow.id, organizationId: owner.organizationId } })
    assert.equal(after.visibility, 'shared', 'nothing changed')

    // Echoing the CURRENT visibility alongside an edit is not a change.
    const saved = await put({ id: flow.id, name: 'Renamed', visibility: 'shared' })
    assert.equal(saved.status, 200)
  })

  test('the owner changes sharing, and is told they can', async () => {
    const flow = await mkFlow('shared', owner.userId)
    installTestAuth(owner.auth)
    assert.equal((await listed(flow.id)).canChangeSharing, true)
    const saved = await put({ id: flow.id, visibility: 'view' })
    assert.equal(saved.status, 200)
    assert.equal(saved.body.flow.visibility, 'view')
  })

  test('a legacy ownerless flow stays changeable by its editors rather than by no one', async () => {
    const flow = await mkFlow('shared', null)
    installTestAuth(member)
    assert.equal((await listed(flow.id)).canChangeSharing, true)
    const saved = await put({ id: flow.id, visibility: 'view' })
    assert.equal(saved.status, 200)
  })
}
