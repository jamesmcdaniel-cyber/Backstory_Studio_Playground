import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'

/**
 * Super-admin management by email: an existing account is promoted directly, an
 * unknown address becomes a pending grant that provisioning claims on first
 * sign-in, and the built-in platform admin cannot be revoked.
 */
const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  let systemPrisma: any
  let installTestAuth: any
  let partner: any
  let backstory: any

  const patch = (body: unknown) =>
    new NextRequest(new URL('http://test/api/catalogue/staff'), {
      method: 'PATCH',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    })

  before(async () => {
    ;({ prisma, systemPrisma } = await import('@/lib/prisma'))
    const testAuth = await import('@/lib/server/__tests__/test-auth')
    installTestAuth = testAuth.installTestAuth
    partner = await testAuth.seedTestOrg(prisma, { orgKind: 'partner' })
    backstory = await testAuth.seedTestOrg(prisma, { orgKind: 'internal', platformRole: 'reviewer' })
    await prisma.user.update({ where: { id: partner.userId }, data: { email: 'author@people.ai' } })
  })

  after(async () => {
    await systemPrisma.platformStaffEmail.deleteMany({ where: { email: { contains: '@staff-email-test' } } })
    if (backstory) await backstory.cleanup()
    if (partner) await partner.cleanup()
  })

  test('a non-reviewer cannot touch super-admin grants', async () => {
    installTestAuth(partner.auth)
    const { PATCH } = await import('../staff/route')
    const response = await PATCH(patch({ email: 'author@people.ai', platformRole: 'reviewer' }))
    assert.equal(response.status, 403)
  })

  test('granting by email promotes an existing account immediately', async () => {
    installTestAuth(backstory.auth)
    const { PATCH } = await import('../staff/route')
    const response = await PATCH(patch({ email: 'Author@People.AI', platformRole: 'reviewer' }))
    assert.equal(response.status, 200)
    assert.equal((await response.json()).grant, 'updated')
    const user = await systemPrisma.user.findUnique({ where: { id: partner.userId } })
    assert.equal(user.platformRole, 'reviewer')
  })

  test('an unknown email becomes a pending grant listed by GET', async () => {
    installTestAuth(backstory.auth)
    const { GET, PATCH } = await import('../staff/route')
    const response = await PATCH(patch({ email: 'new-admin@staff-email-test.dev', platformRole: 'reviewer' }))
    assert.equal(response.status, 200)
    assert.equal((await response.json()).grant, 'pending')

    const listed = await (await GET(new NextRequest(new URL('http://test/api/catalogue/staff')))).json()
    assert.ok(listed.pendingStaff.some((row: any) => row.email === 'new-admin@staff-email-test.dev'))
  })

  test('provisioning a new account claims the pending grant as reviewer + internal org', async () => {
    const { provisionUserForTest } = await import('@/lib/supabase/auth-utils')
    const supabaseId = crypto.randomUUID()
    const created = await provisionUserForTest({
      id: supabaseId,
      email: 'new-admin@staff-email-test.dev',
      user_metadata: { full_name: 'New Admin' },
      app_metadata: {},
      aud: 'authenticated',
      created_at: '',
    } as any)
    assert.ok(created, 'provisioning must return the created user')
    assert.ok(created.organization, 'provisioning must include the organization')
    try {
      assert.equal(created.platformRole, 'reviewer')
      assert.equal(created.organization.kind, 'internal')
      const grant = await systemPrisma.platformStaffEmail.findUnique({
        where: { email: 'new-admin@staff-email-test.dev' },
      })
      assert.ok(grant.claimedAt)
      assert.equal(grant.claimedByUserId, created.id)
    } finally {
      await systemPrisma.organization.delete({ where: { id: created.organizationId } }).catch(() => {})
    }
  })

  test('revoking an unclaimed pending grant removes it', async () => {
    installTestAuth(backstory.auth)
    const { GET, PATCH } = await import('../staff/route')
    await PATCH(patch({ email: 'undo-me@staff-email-test.dev', platformRole: 'reviewer' }))
    const response = await PATCH(patch({ email: 'undo-me@staff-email-test.dev', platformRole: null }))
    assert.equal(response.status, 200)
    const listed = await (await GET(new NextRequest(new URL('http://test/api/catalogue/staff')))).json()
    assert.ok(!listed.pendingStaff.some((row: any) => row.email === 'undo-me@staff-email-test.dev'))
  })

  test('the built-in platform admin cannot be revoked', async () => {
    installTestAuth(backstory.auth)
    const { PATCH } = await import('../staff/route')
    const response = await PATCH(patch({ email: 'james.mcdaniel@people.ai', platformRole: null }))
    assert.equal(response.status, 409)
    assert.equal((await response.json()).code, 'BUILTIN_STAFF')
  })
}
