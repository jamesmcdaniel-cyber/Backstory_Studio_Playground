import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { NextRequest } from 'next/server'

/**
 * The two new org roles must actually be reachable, and the routes that manage
 * membership must agree with the permission registry.
 *
 * The specific trap: those routes carried an inline `role !== 'ADMIN'` check
 * from before the registry existed. OWNER holds members.manage, so the inline
 * check refused a role the registry grants — the exact contradiction the
 * registry was introduced to remove.
 */
const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  let installTestAuth: any
  let owner: any
  let memberId: string
  let secondAdminId: string

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    const testAuth = await import('@/lib/server/__tests__/test-auth')
    installTestAuth = testAuth.installTestAuth
    owner = await testAuth.seedTestOrg(prisma, { role: 'OWNER' })
    installTestAuth(owner.auth)
    memberId = (await prisma.user.create({
      data: { supabaseId: crypto.randomUUID(), organizationId: owner.organizationId, isActive: true, role: 'USER' },
    })).id
    secondAdminId = (await prisma.user.create({
      data: { supabaseId: crypto.randomUUID(), organizationId: owner.organizationId, isActive: true, role: 'ADMIN' },
    })).id
  })

  after(async () => {
    if (owner) await owner.cleanup()
  })

  const patch = (id: string, role: string) => [
    new NextRequest(new URL(`http://test/api/organizations/members/${id}`), {
      method: 'PATCH',
      body: JSON.stringify({ role }),
      headers: { 'content-type': 'application/json' },
    }),
    { params: Promise.resolve({ id }) },
  ] as const

  test('an OWNER may manage members, not just an ADMIN', async () => {
    const { PATCH } = await import('../members/[id]/route')
    const response = await PATCH(...patch(memberId, 'VIEWER'))
    assert.equal(response.status, 200, await response.clone().text())
  })

  test('VIEWER is assignable', async () => {
    const row = await prisma.user.findFirst({ where: { id: memberId, organizationId: owner.organizationId } })
    assert.equal(row.role, 'VIEWER')
  })

  test('OWNER is assignable', async () => {
    const { PATCH } = await import('../members/[id]/route')
    const response = await PATCH(...patch(memberId, 'OWNER'))
    assert.equal(response.status, 200)
    const row = await prisma.user.findFirst({ where: { id: memberId, organizationId: owner.organizationId } })
    assert.equal(row.role, 'OWNER')
  })

  test('an OWNER counts as an admin for the last-admin guard', async () => {
    // Two OWNERs and one ADMIN exist. Demoting the ADMIN must be allowed,
    // because an OWNER can still administer the workspace.
    const { PATCH } = await import('../members/[id]/route')
    const response = await PATCH(...patch(secondAdminId, 'USER'))
    assert.equal(response.status, 200, await response.clone().text())
  })

  test('the last administrator cannot be demoted', async () => {
    const { PATCH } = await import('../members/[id]/route')
    // Demote the non-acting OWNER, leaving only the acting one.
    await PATCH(...patch(memberId, 'USER'))
    // Now demote the acting OWNER — the workspace would have no administrator.
    const response = await PATCH(...patch(owner.userId, 'USER'))
    assert.equal(response.status, 400)
    assert.equal((await response.json()).code, 'LAST_ADMIN')
  })

  test('an invitation may carry either new role', async () => {
    const { POST } = await import('../invitations/route')
    const response = await POST(new NextRequest(new URL('http://test/api/organizations/invitations'), {
      method: 'POST',
      body: JSON.stringify({ email: `viewer-${crypto.randomUUID()}@example.com`, role: 'VIEWER' }),
      headers: { 'content-type': 'application/json' },
    }))
    assert.equal(response.status, 200, await response.clone().text())
    assert.equal((await response.json()).invitation.role, 'VIEWER')
  })
}
