import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'

/**
 * The admin "Reset MFA" action — the lost-device recovery path.
 *
 * Supabase is not reachable from a test run, so the service-role factor API is
 * driven through the production-inert seam in mfa-admin.ts. That keeps the REAL
 * route logic under test — the permission gate, the audit row, the owner
 * question — and fakes only the transport.
 */
const TEST_DB = process.env.TEST_DATABASE_URL
if (!TEST_DB) test('admin MFA reset (skipped: TEST_DATABASE_URL not set)', { skip: true }, () => {})

if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'test-key'

  let prisma: any
  let systemPrisma: any
  let actionsRoute: any
  let operator: any
  let subject: any
  let installTestAuth: any
  let setTestMfaAdmin: any

  /** supabaseId -> factors, standing in for Supabase's factor store. */
  const store = new Map<string, Array<{ id: string; factor_type: string; status: string }>>()
  const deleted: string[] = []

  const action = (userId: string, body: unknown) =>
    new NextRequest(new URL(`http://test/api/admin/users/${userId}/actions`), {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    })

  before(async () => {
    ;({ prisma, systemPrisma } = await import('@/lib/prisma'))
    const testAuth = await import('@/lib/server/__tests__/test-auth')
    installTestAuth = testAuth.installTestAuth
    ;({ setTestMfaAdmin } = await import('@/lib/auth/mfa-admin'))

    setTestMfaAdmin({
      async listFactors(supabaseId: string) {
        return store.get(supabaseId) ?? []
      },
      async deleteFactor(supabaseId: string, factorId: string) {
        deleted.push(`${supabaseId}:${factorId}`)
        store.set(supabaseId, (store.get(supabaseId) ?? []).filter((factor) => factor.id !== factorId))
      },
    })

    operator = await testAuth.seedTestOrg(prisma, {
      orgKind: 'internal',
      platformRole: 'reviewer',
      orgCreatedAt: new Date('2099-01-01T00:00:00.000Z'),
    })
    subject = await testAuth.seedTestOrg(prisma, { orgKind: 'customer' })
    installTestAuth(operator.auth)
    actionsRoute = await import('../users/[id]/actions/route')
  })

  after(async () => {
    setTestMfaAdmin?.(null)
    await systemPrisma?.auditEvent
      .deleteMany({ where: { organizationId: operator?.organizationId } })
      .catch(() => {})
    await subject?.cleanup()
    await operator?.cleanup()
  })

  test('resetting MFA deletes every factor and audits how many', async () => {
    const target = await prisma.user.findUnique({ where: { id: subject.userId } })
    store.set(target.supabaseId, [
      { id: 'f1', factor_type: 'totp', status: 'verified' },
      { id: 'f2', factor_type: 'totp', status: 'unverified' },
    ])

    const response = await actionsRoute.POST(action(subject.userId, { action: 'reset-mfa' }))
    const body = await response.json()
    assert.equal(response.status, 200, JSON.stringify(body))
    assert.equal(body.factorsRemoved, 2)
    assert.deepEqual(store.get(target.supabaseId), [], 'the stale factor goes too, or enrollment is refused')

    const event = await systemPrisma.auditEvent.findFirst({
      where: { organizationId: operator.organizationId, action: 'platform.users.reset-mfa' },
      orderBy: { createdAt: 'desc' },
    })
    assert.ok(event, 'the most consequential recovery action must be audited')
    assert.equal(event.actorUserId, operator.userId)
    assert.equal(event.resourceId, subject.userId)
    assert.equal(event.detail?.factorsRemoved, 2)
  })

  test('resetting an account with no factors is a no-op, not an error', async () => {
    const response = await actionsRoute.POST(action(subject.userId, { action: 'reset-mfa' }))
    assert.equal(response.status, 200)
    assert.equal((await response.json()).factorsRemoved, 0)
  })

  test('a caller without platform.administer is refused, and nothing is deleted', async () => {
    const testAuth = await import('@/lib/server/__tests__/test-auth')
    const outsider = await testAuth.seedTestOrg(prisma, { orgKind: 'customer' })
    const target = await prisma.user.findUnique({ where: { id: subject.userId } })
    store.set(target.supabaseId, [{ id: 'f9', factor_type: 'totp', status: 'verified' }])
    const before = deleted.length
    try {
      installTestAuth(outsider.auth)
      const response = await actionsRoute.POST(action(subject.userId, { action: 'reset-mfa' }))
      assert.equal(response.status, 403)
      assert.equal((await response.json()).code, 'PERMISSION_DENIED')
      assert.equal(deleted.length, before, 'the gate runs before the handler, so nothing is touched')
      assert.equal(store.get(target.supabaseId)?.length, 1)
    } finally {
      await outsider.cleanup()
      installTestAuth(operator.auth)
      store.delete(target.supabaseId)
    }
  })

  test("the platform owner's MFA can be reset, and their account survives it", async () => {
    const testAuth = await import('@/lib/server/__tests__/test-auth')
    const owner = await testAuth.seedTestOrg(prisma, { orgKind: 'customer', role: 'OWNER' })
    try {
      installTestAuth(operator.auth)
      const ownerRow = await prisma.user.findUnique({ where: { id: owner.userId } })
      store.set(ownerRow.supabaseId, [{ id: 'owner-1', factor_type: 'totp', status: 'verified' }])

      // Allowed on purpose: a lost phone is the one thing that can strand the
      // owner, and this removes a factor — never their access.
      const response = await actionsRoute.POST(action(owner.userId, { action: 'reset-mfa' }))
      assert.equal(response.status, 200, await response.text())

      const after = await prisma.user.findUnique({ where: { id: owner.userId } })
      assert.equal(after.isActive, true, 'the owner invariant: nothing here may remove their access')
      assert.equal(after.role, 'OWNER')

      const event = await systemPrisma.auditEvent.findFirst({
        where: { organizationId: operator.organizationId, action: 'platform.users.reset-mfa', resourceId: owner.userId },
      })
      assert.equal(event?.detail?.isPlatformOwner, true, 'an owner reset must be recognisable in the log')
    } finally {
      await owner.cleanup()
      installTestAuth(operator.auth)
    }
  })

  test('deactivation is still refused for the owner (the invariant is unchanged)', async () => {
    const testAuth = await import('@/lib/server/__tests__/test-auth')
    const owner = await testAuth.seedTestOrg(prisma, { orgKind: 'customer', role: 'OWNER' })
    try {
      installTestAuth(operator.auth)
      const response = await actionsRoute.POST(action(owner.userId, { action: 'deactivate' }))
      assert.equal(response.status, 403)
      assert.equal((await response.json()).code, 'OWNER_PROTECTED')
    } finally {
      await owner.cleanup()
      installTestAuth(operator.auth)
    }
  })
}
