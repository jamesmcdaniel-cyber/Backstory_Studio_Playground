import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'

/**
 * Self-service authenticator management.
 *
 * The two guards are the point of the route, and both are asserted HERE rather
 * than through the settings component: the UI's disabled button is a courtesy,
 * and a test that only drove the UI would prove nothing about a hand-rolled
 * fetch. Supabase's factor store and the session's assurance level are both
 * driven through their production-inert seams.
 */
const TEST_DB = process.env.TEST_DATABASE_URL
if (!TEST_DB) test('mfa factors route (skipped: TEST_DATABASE_URL not set)', { skip: true }, () => {})

if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'test-key'

  let prisma: any
  let route: any
  let seeded: any
  let supabaseId: string
  let setTestMfaAdmin: any
  let setTestMfaSession: any

  let factors: Array<{ id: string; factor_type: string; status: string; friendly_name?: string }> = []
  const deleted: string[] = []

  const get = () => new NextRequest(new URL('http://test/api/auth/mfa/factors'))
  const del = (factorId: string) =>
    new NextRequest(new URL('http://test/api/auth/mfa/factors'), {
      method: 'DELETE',
      body: JSON.stringify({ factorId }),
      headers: { 'content-type': 'application/json' },
    })

  /** A session that has just passed a TOTP challenge. */
  const steppedUp = () => ({ assuranceLevel: 'aal2', methods: ['password', 'mfa'], verifiedAt: new Date() })

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    const testAuth = await import('@/lib/server/__tests__/test-auth')
    ;({ setTestMfaAdmin } = await import('@/lib/auth/mfa-admin'))
    ;({ setTestMfaSession } = await import('@/lib/auth/mfa-session'))

    setTestMfaAdmin({
      async listFactors() { return factors },
      async deleteFactor(_id: string, factorId: string) {
        deleted.push(factorId)
        factors = factors.filter((factor) => factor.id !== factorId)
      },
    })

    seeded = await testAuth.seedTestOrg(prisma, { orgKind: 'customer' })
    const row = await prisma.user.findUnique({ where: { id: seeded.userId } })
    supabaseId = row.supabaseId
    // seedTestOrg builds dbUser from the bare user row; the route reads the
    // workspace policy off the joined organization, exactly as requireAuthContext
    // resolves it in production.
    seeded.auth.dbUser.organization = { mfaPolicy: 'optional' }
    seeded.auth.dbUser.email = 'member@example.com'
    testAuth.installTestAuth(seeded.auth)
    route = await import('../mfa/factors/route')
  })

  beforeEach(() => {
    factors = [
      { id: 'f1', factor_type: 'totp', status: 'verified', friendly_name: 'Backstory Studio' },
    ]
    deleted.length = 0
    seeded.auth.dbUser.organization = { mfaPolicy: 'optional' }
    setTestMfaSession(steppedUp())
  })

  after(async () => {
    setTestMfaAdmin?.(null)
    setTestMfaSession?.(null)
    await prisma?.auditEvent.deleteMany({ where: { organizationId: seeded?.organizationId } }).catch(() => {})
    await seeded?.cleanup()
  })

  test('the list names each factor and whether it can be removed', async () => {
    const body = await (await route.GET(get())).json()
    assert.equal(body.success, true)
    assert.equal(body.factors.length, 1)
    assert.equal(body.factors[0].friendlyName, 'Backstory Studio')
    assert.equal(body.factors[0].status, 'verified')
    assert.equal(body.factors[0].removable, true)
    assert.equal(body.policyRequired, false)
    assert.equal(body.stepUpSatisfied, true)
  })

  test('a session that has not stepped up cannot remove anything', async () => {
    setTestMfaSession({ assuranceLevel: 'aal1', methods: ['password'], verifiedAt: null })
    const response = await route.DELETE(del('f1'))
    assert.equal(response.status, 403)
    assert.equal((await response.json()).code, 'STEP_UP_REQUIRED')
    assert.deepEqual(deleted, [], 'refused before Supabase is touched')
  })

  test('a stale aal2 session is also refused', async () => {
    setTestMfaSession({
      assuranceLevel: 'aal2',
      methods: ['mfa'],
      verifiedAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
    })
    const response = await route.DELETE(del('f1'))
    assert.equal(response.status, 403)
    assert.equal((await response.json()).code, 'STEP_UP_REQUIRED')
  })

  test('the last factor cannot be removed while the workspace requires MFA', async () => {
    seeded.auth.dbUser.organization = { mfaPolicy: 'required' }

    const listed = await (await route.GET(get())).json()
    assert.equal(listed.policyRequired, true)
    assert.equal(listed.factors[0].removable, false, 'the UI is told before the click')

    const response = await route.DELETE(del('f1'))
    assert.equal(response.status, 400)
    assert.equal((await response.json()).code, 'LAST_FACTOR')
    assert.deepEqual(deleted, [], 'the client gate is not trusted — this is the enforcement')
    assert.equal(factors.length, 1)
  })

  test('a second factor makes removal possible again under the same policy', async () => {
    seeded.auth.dbUser.organization = { mfaPolicy: 'required' }
    factors.push({ id: 'f2', factor_type: 'totp', status: 'verified' })

    const response = await route.DELETE(del('f1'))
    assert.equal(response.status, 200, await response.text())
    assert.deepEqual(deleted, ['f1'])
    assert.deepEqual(factors.map((factor) => factor.id), ['f2'])
  })

  test('removal is audited against the account it happened to', async () => {
    const response = await route.DELETE(del('f1'))
    assert.equal(response.status, 200, await response.text())
    const event = await prisma.auditEvent.findFirst({
      where: { organizationId: seeded.organizationId, action: 'account.mfa.factor_removed' },
      orderBy: { createdAt: 'desc' },
    })
    assert.ok(event)
    assert.equal(event.actorUserId, seeded.userId)
    assert.equal(event.detail?.factorId, 'f1')
  })

  test('a factor id that is not on the account is a 404, not a delete', async () => {
    const response = await route.DELETE(del('someone-elses-factor'))
    assert.equal(response.status, 404)
    assert.deepEqual(deleted, [])
    assert.ok(supabaseId, 'the seeded identity is what listFactors would be called with')
  })
}
