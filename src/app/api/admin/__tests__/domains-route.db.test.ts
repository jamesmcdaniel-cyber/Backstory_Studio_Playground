import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'

/**
 * Platform access administration.
 *
 * The case that matters here is the company domain. It is admitted by the
 * hardcoded list in company-domain.ts, and this screen used to refuse it a row
 * on those grounds ("already has permanent access"). But a row does two jobs:
 * it opens the gate AND it names the workspace its people join. With no row,
 * allowedDomainOrg returned null and every employee was provisioned into a solo
 * workspace of their own — so colleagues could not see each other's flows or
 * agents, which are org-scoped by design.
 */
const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  let systemPrisma: any
  let route: any
  let reviewer: any
  const COMPANY_DOMAIN = 'backstory.ai'

  const post = (body: unknown) =>
    new NextRequest(new URL('http://test/api/admin/domains'), {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    })
  const patch = (body: unknown) =>
    new NextRequest(new URL('http://test/api/admin/domains'), {
      method: 'PATCH',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    })

  before(async () => {
    ;({ prisma, systemPrisma } = await import('@/lib/prisma'))
    const testAuth = await import('@/lib/server/__tests__/test-auth')
    // INTERNAL + reviewer. This used to be a partner org, on the grounds that
    // review rights resolve the same either way — no longer true, and that is
    // the point: /api/admin now requires platform.administer, which a partner
    // reviewer deliberately does not hold (see platform-administer.test.ts).
    // Far-future createdAt so this internal org never wins resolveInternalOrgId
    // (oldest internal) out from under a concurrently running catalogue test.
    reviewer = await testAuth.seedTestOrg(prisma, {
      orgKind: 'internal',
      platformRole: 'reviewer',
      orgCreatedAt: new Date('2099-01-01T00:00:00.000Z'),
    })
    testAuth.installTestAuth(reviewer.auth)
    route = await import('../domains/route')
  })

  after(async () => {
    // systemPrisma: platform_allowed_domains is platform-wide and carries no
    // organizationId of its own, which is what the tenant client refuses.
    await systemPrisma.platformAllowedDomain.deleteMany({ where: { domain: COMPANY_DOMAIN } }).catch(() => {})
    await reviewer?.cleanup()
  })

  test('a company domain may be listed, so its people land in one shared workspace', async () => {
    const response = await route.POST(post({ domain: COMPANY_DOMAIN, organizationId: reviewer.organizationId }))
    assert.equal(response.status, 200, await response.text())

    const { allowedDomainOrg } = await import('@/lib/auth/allowed-domain')
    assert.equal(
      await allowedDomainOrg(`employee@${COMPANY_DOMAIN}`),
      reviewer.organizationId,
      'a listed company domain routes its people into the chosen workspace',
    )
  })

  test('blocking a company domain cannot bulk-deactivate its accounts', async () => {
    const row = await systemPrisma.platformAllowedDomain.findUnique({ where: { domain: COMPANY_DOMAIN } })
    assert.ok(row, 'the previous test must have listed the domain')

    const response = await route.PATCH(patch({ id: row.id, disabled: true, deactivateUsers: true }))
    // Their sign-in comes from the hardcoded list, not from this row, so a
    // "block + deactivate" here would strand accounts that can still sign in.
    assert.equal(response.status, 400)
    assert.equal((await response.json()).code, 'COMPANY_DOMAIN_DEACTIVATION')

    const after = await systemPrisma.platformAllowedDomain.findUnique({ where: { domain: COMPANY_DOMAIN } })
    assert.equal(after.disabledAt, null, 'a refused request leaves the row untouched')
  })

  test('blocking a company domain without the sweep stops auto-join only', async () => {
    const row = await systemPrisma.platformAllowedDomain.findUnique({ where: { domain: COMPANY_DOMAIN } })
    const response = await route.PATCH(patch({ id: row.id, disabled: true }))
    assert.equal(response.status, 200)

    const { allowedDomainOrg, isAllowedEmail } = await import('@/lib/auth/allowed-domain')
    assert.equal(await allowedDomainOrg(`employee@${COMPANY_DOMAIN}`), null)
    assert.equal(await isAllowedEmail(`employee@${COMPANY_DOMAIN}`), true, 'admission is hardcoded, not this row')
  })

  test('a public email provider is still refused outright', async () => {
    const response = await route.POST(post({ domain: 'gmail.com', organizationId: reviewer.organizationId }))
    assert.equal(response.status, 400)
    assert.equal((await response.json()).code, 'PUBLIC_EMAIL_PROVIDER')
  })
}
