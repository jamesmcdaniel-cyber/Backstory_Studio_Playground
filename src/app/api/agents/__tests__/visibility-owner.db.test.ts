import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'
import { randomBytes } from 'node:crypto'

/**
 * Who can see an agent is its creator's call. 'private' scopes an agent to
 * `userId`, so a teammate who could edit a shared agent and picked Private
 * handed it to its creator and lost it themselves. PUT refuses the change; the
 * list tells each viewer whether the choice is theirs, so the form doesn't
 * offer it.
 */
const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  process.env.ENTITLEMENT_GATE = 'off'

  let prisma: any
  let installTestAuth: any
  let resolvePermissions: any
  let creator: any
  let teammate: any

  const mkAgent = (userId: string | null) =>
    prisma.agentTask.create({
      data: {
        type: 'agent', agentType: 'CUSTOM', priority: 'MEDIUM', description: 'Watcher', objective: 'Watch',
        context: {}, schedule: { type: 'manual' }, status: 'ACTIVE', visibility: 'shared',
        organizationId: creator.organizationId, userId, metadata: { title: 'Watcher' },
      },
    })

  const put = async (body: Record<string, unknown>) => {
    const { PUT } = await import('../route')
    const response = await PUT(new NextRequest(new URL('http://test/api/agents'), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }))
    return { status: response.status, body: await response.json() }
  }

  const listed = async (agentId: string) => {
    const { GET } = await import('../route')
    const body = await (await GET(new NextRequest(new URL('http://test/api/agents')))).json()
    return body.agents.find((agent: { id: string }) => agent.id === agentId)
  }

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    ;({ resolvePermissions } = await import('@/lib/authz/permissions'))
    const testAuth = await import('@/lib/server/__tests__/test-auth')
    installTestAuth = testAuth.installTestAuth
    creator = await testAuth.seedTestOrg(prisma)
    const user = await prisma.user.create({
      data: { supabaseId: randomBytes(16).toString('hex'), organizationId: creator.organizationId, isActive: true, role: 'USER' },
    })
    const permissions = resolvePermissions({ role: user.role, platformRole: null }, { kind: 'customer' })
    teammate = { ...creator.auth, userId: user.id, dbUser: user, user: { id: user.supabaseId }, permissions, can: (p: string) => permissions.has(p) }
  })

  after(async () => {
    if (creator) await creator.cleanup()
  })

  test('a teammate may edit a shared agent but not make it private', async () => {
    const agent = await mkAgent(creator.userId)
    installTestAuth(teammate)
    assert.equal((await listed(agent.id)).canChangeVisibility, false)

    const refused = await put({ id: agent.id, visibility: 'private' })
    assert.equal(refused.status, 403)
    assert.equal(refused.body.code, 'AGENT_OWNER_REQUIRED')
    assert.match(refused.body.error, /created this agent/i, 'the refusal says why, for the form to show')
    const row = await prisma.agentTask.findFirst({ where: { id: agent.id, organizationId: creator.organizationId } })
    assert.equal(row.visibility, 'shared')

    // The form sends its whole draft on save — the unchanged value is fine.
    const saved = await put({ id: agent.id, title: 'Renamed', visibility: 'shared' })
    assert.equal(saved.status, 200)
    assert.equal(saved.body.agent.canChangeVisibility, false)
  })

  test('the creator changes it', async () => {
    const agent = await mkAgent(creator.userId)
    installTestAuth(creator.auth)
    assert.equal((await listed(agent.id)).canChangeVisibility, true)
    const saved = await put({ id: agent.id, visibility: 'private' })
    assert.equal(saved.status, 200)
    assert.equal(saved.body.agent.visibility, 'private')
  })

  test('a creatorless agent stays changeable by its editors', async () => {
    const agent = await mkAgent(null)
    installTestAuth(teammate)
    const saved = await put({ id: agent.id, visibility: 'private' })
    assert.equal(saved.status, 200)
  })
}
