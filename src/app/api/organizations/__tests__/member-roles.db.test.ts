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

  const patch = (id: string, role: string, extra: Record<string, unknown> = {}) => [
    new NextRequest(new URL(`http://test/api/organizations/members/${id}`), {
      method: 'PATCH',
      body: JSON.stringify({ role, ...extra }),
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

  /**
   * Super admin as the top rank of the member role select. It is a PLATFORM
   * tier riding on the workspace role, so members.manage alone must not buy it
   * — otherwise any workspace admin could mint themselves a catalogue reviewer.
   */
  test('members.manage alone cannot grant super admin', async () => {
    const { resolvePermissions } = await import('@/lib/authz/permissions')
    const adminRow = await prisma.user.findUnique({ where: { id: secondAdminId } })
    const permissions = resolvePermissions({ role: 'ADMIN', platformRole: null }, { kind: 'customer' })
    installTestAuth({
      organizationId: owner.organizationId,
      userId: secondAdminId,
      dbUser: adminRow,
      user: { id: adminRow.supabaseId },
      permissions,
      can: (permission: string) => (permissions as ReadonlySet<string>).has(permission),
    })

    const { PATCH } = await import('../members/[id]/route')
    const response = await PATCH(...patch(memberId, 'ADMIN', { platformRole: 'reviewer' }))
    assert.equal(response.status, 403)
    assert.equal((await response.json()).code, 'SUPER_ADMIN_REQUIRED')
    const row = await prisma.user.findUnique({ where: { id: memberId } })
    assert.equal(row.platformRole, null)

    installTestAuth(owner.auth)
  })

  test('a super admin may promote and demote another member', async () => {
    const { PATCH } = await import('../members/[id]/route')
    const promote = await PATCH(...patch(memberId, 'ADMIN', { platformRole: 'reviewer' }))
    assert.equal(promote.status, 200, await promote.clone().text())
    assert.equal((await promote.json()).member.platformRole, 'reviewer')

    const demote = await PATCH(...patch(memberId, 'USER', { platformRole: null }))
    assert.equal(demote.status, 200, await demote.clone().text())
    const row = await prisma.user.findUnique({ where: { id: memberId } })
    assert.equal(row.platformRole, null)
    assert.equal(row.role, 'USER')
  })

  test('an ordinary role change leaves the staff marker alone', async () => {
    // 'staff' marks an employee without granting review. The select never sends
    // platformRole unless the SUPER-ADMIN-ness flips, so this must survive.
    await prisma.user.update({ where: { id: memberId }, data: { platformRole: 'staff' } })
    const { PATCH } = await import('../members/[id]/route')
    const response = await PATCH(...patch(memberId, 'VIEWER'))
    assert.equal(response.status, 200, await response.clone().text())
    const row = await prisma.user.findUnique({ where: { id: memberId } })
    assert.equal(row.platformRole, 'staff')
    await prisma.user.update({ where: { id: memberId }, data: { platformRole: null } })
  })

  test('inviting a super admin parks an unclaimed grant, and revoking takes it back', async () => {
    const { systemPrisma } = await import('@/lib/prisma')
    const email = `super-${crypto.randomUUID()}@example.com`
    const { POST } = await import('../invitations/route')
    const created = await POST(new NextRequest(new URL('http://test/api/organizations/invitations'), {
      method: 'POST',
      body: JSON.stringify({ email, role: 'ADMIN', platformRole: 'reviewer' }),
      headers: { 'content-type': 'application/json' },
    }))
    assert.equal(created.status, 200, await created.clone().text())
    const { invitation } = await created.json()
    assert.ok(await systemPrisma.platformStaffEmail.findUnique({ where: { email } }))

    const { DELETE } = await import('../invitations/[id]/route')
    const revoked = await DELETE(
      new NextRequest(new URL(`http://test/api/organizations/invitations/${invitation.id}`), { method: 'DELETE' }),
      { params: Promise.resolve({ id: invitation.id }) },
    )
    assert.equal(revoked.status, 200, await revoked.clone().text())
    assert.equal(await systemPrisma.platformStaffEmail.findUnique({ where: { email } }), null)
  })

  test('the customer edition has no super admin tier at all', async () => {
    // Settings → Members is a SHARED surface, so unlike the operator console it
    // cannot be gated by internalOnly at the route level. The field is gated
    // instead: the customer edition answers 404, as if the tier did not exist.
    process.env.APP_EDITION = 'customer'
    try {
      const { PATCH } = await import('../members/[id]/route')
      const response = await PATCH(...patch(memberId, 'ADMIN', { platformRole: 'reviewer' }))
      assert.equal(response.status, 404)

      const { POST } = await import('../invitations/route')
      const invite = await POST(new NextRequest(new URL('http://test/api/organizations/invitations'), {
        method: 'POST',
        body: JSON.stringify({ email: `edition-${crypto.randomUUID()}@example.com`, role: 'ADMIN', platformRole: 'reviewer' }),
        headers: { 'content-type': 'application/json' },
      }))
      assert.equal(invite.status, 404)
    } finally { delete process.env.APP_EDITION }
    // Restore the fixture: the refused PATCH left memberId as it was.
    await prisma.user.update({ where: { id: memberId }, data: { role: 'USER', platformRole: null } })
  })

  test('members.manage alone cannot invite a super admin', async () => {
    const testAuth = await import('@/lib/server/__tests__/test-auth')
    const plainAdmin = await testAuth.seedTestOrg(prisma, { role: 'ADMIN' })
    installTestAuth(plainAdmin.auth)
    const { POST } = await import('../invitations/route')
    const response = await POST(new NextRequest(new URL('http://test/api/organizations/invitations'), {
      method: 'POST',
      body: JSON.stringify({ email: `nope-${crypto.randomUUID()}@example.com`, role: 'ADMIN', platformRole: 'reviewer' }),
      headers: { 'content-type': 'application/json' },
    }))
    assert.equal(response.status, 403)
    assert.equal((await response.json()).code, 'SUPER_ADMIN_REQUIRED')
    await plainAdmin.cleanup()
    installTestAuth(owner.auth)
  })
}
