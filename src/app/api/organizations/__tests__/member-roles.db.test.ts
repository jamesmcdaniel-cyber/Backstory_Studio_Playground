import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { NextRequest } from 'next/server'

/**
 * Role management against a real database, including the platform-owner
 * protections: OWNER is reserved for the platform owner identities, the owner
 * can never be demoted or removed (by anyone), and the last-admin guard still
 * protects ordinary workspaces.
 */
const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  let installTestAuth: any
  let owner: any
  let adminOrg: any
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
    if (adminOrg) await adminOrg.cleanup()
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

  test('OWNER is not grantable to anyone but the platform owner', async () => {
    const { PATCH } = await import('../members/[id]/route')
    const response = await PATCH(...patch(memberId, 'OWNER'))
    assert.equal(response.status, 403)
    assert.equal((await response.json()).code, 'OWNER_RESERVED')
  })

  test('an OWNER counts as an admin for the last-admin guard', async () => {
    // One OWNER and one ADMIN exist. Demoting the ADMIN must be allowed,
    // because the OWNER can still administer the workspace.
    const { PATCH } = await import('../members/[id]/route')
    const response = await PATCH(...patch(secondAdminId, 'USER'))
    assert.equal(response.status, 200, await response.clone().text())
  })

  test('the platform owner can never be demoted, even as the last administrator', async () => {
    const { PATCH } = await import('../members/[id]/route')
    const response = await PATCH(...patch(owner.userId, 'USER'))
    assert.equal(response.status, 403)
    assert.equal((await response.json()).code, 'OWNER_PROTECTED')
  })

  test('an ADMIN cannot demote or remove the platform owner', async () => {
    // Re-promote the second admin, then act as them — the exact attack this
    // closes: before, members.manage let any ADMIN demote or remove an OWNER.
    const { PATCH, DELETE } = await import('../members/[id]/route')
    await PATCH(...patch(secondAdminId, 'ADMIN'))
    const adminRow = await prisma.user.findUnique({ where: { id: secondAdminId } })
    const { resolvePermissions } = await import('@/lib/authz/permissions')
    const permissions = resolvePermissions({ role: 'ADMIN', platformRole: null }, { kind: 'customer' })
    installTestAuth({
      organizationId: owner.organizationId,
      userId: secondAdminId,
      dbUser: adminRow,
      user: { id: adminRow.supabaseId },
      permissions,
      can: (permission: string) => (permissions as ReadonlySet<string>).has(permission),
    })

    const demote = await PATCH(...patch(owner.userId, 'USER'))
    assert.equal(demote.status, 403)
    assert.equal((await demote.json()).code, 'OWNER_PROTECTED')

    const remove = await DELETE(
      new NextRequest(new URL(`http://test/api/organizations/members/${owner.userId}`), { method: 'DELETE' }),
      { params: Promise.resolve({ id: owner.userId }) },
    )
    assert.equal(remove.status, 403)
    assert.equal((await remove.json()).code, 'OWNER_PROTECTED')

    installTestAuth(owner.auth)
    // Restore the fixture state later tests assume (single administrator).
    await PATCH(...patch(secondAdminId, 'USER'))
  })

  test('the last ordinary administrator cannot be demoted', async () => {
    const testAuth = await import('@/lib/server/__tests__/test-auth')
    adminOrg = await testAuth.seedTestOrg(prisma, { role: 'ADMIN' })
    installTestAuth(adminOrg.auth)
    const { PATCH } = await import('../members/[id]/route')
    const response = await PATCH(...patch(adminOrg.userId, 'USER'))
    assert.equal(response.status, 400)
    assert.equal((await response.json()).code, 'LAST_ADMIN')
    installTestAuth(owner.auth)
  })

  test('an invitation may carry the VIEWER role', async () => {
    const { POST } = await import('../invitations/route')
    const response = await POST(new NextRequest(new URL('http://test/api/organizations/invitations'), {
      method: 'POST',
      body: JSON.stringify({ email: `viewer-${crypto.randomUUID()}@example.com`, role: 'VIEWER' }),
      headers: { 'content-type': 'application/json' },
    }))
    assert.equal(response.status, 200, await response.clone().text())
    assert.equal((await response.json()).invitation.role, 'VIEWER')
  })

  test('an invitation cannot grant OWNER to a non-owner email', async () => {
    const { POST } = await import('../invitations/route')
    const response = await POST(new NextRequest(new URL('http://test/api/organizations/invitations'), {
      method: 'POST',
      body: JSON.stringify({ email: `impostor-${crypto.randomUUID()}@example.com`, role: 'OWNER' }),
      headers: { 'content-type': 'application/json' },
    }))
    assert.equal(response.status, 403)
    assert.equal((await response.json()).code, 'OWNER_RESERVED')
  })
}
