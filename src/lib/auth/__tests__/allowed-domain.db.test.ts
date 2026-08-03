import { test, before } from 'node:test'
import assert from 'node:assert/strict'

// DB-gated: runs only under TEST_DATABASE_URL (CI-mode), like sibling DB tests.
const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  let isAllowedEmail: any
  let allowedDomainOrg: any
  const ids: Record<string, string> = {}

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    ;({ isAllowedEmail, allowedDomainOrg } = await import('@/lib/auth/allowed-domain'))

    const stamp = Date.now()
    const org = await prisma.organization.create({
      data: { name: 'Customer Co', slug: `customer-${stamp}` },
    })
    ids.org = org.id

    await prisma.platformAllowedDomain.create({
      data: { domain: `active-${stamp}.example`, organizationId: org.id },
    })
    await prisma.platformAllowedDomain.create({
      data: { domain: `disabled-${stamp}.example`, organizationId: org.id, disabledAt: new Date() },
    })
    ids.activeDomain = `active-${stamp}.example`
    ids.disabledDomain = `disabled-${stamp}.example`
  })

  test('hardcoded company domains are allowed without a table row', async () => {
    assert.equal(await isAllowedEmail('person@people.ai'), true)
    assert.equal(await isAllowedEmail('PERSON@BACKSTORY.AI'), true)
  })

  test('an active allowed domain opens the gate', async () => {
    assert.equal(await isAllowedEmail(`person@${ids.activeDomain}`), true)
  })

  test('a disabled domain is refused', async () => {
    assert.equal(await isAllowedEmail(`person@${ids.disabledDomain}`), false)
  })

  test('an unlisted domain is refused', async () => {
    assert.equal(await isAllowedEmail('person@stranger.example'), false)
    assert.equal(await isAllowedEmail(null), false)
  })

  test('lookalike domains do not inherit access', async () => {
    assert.equal(await isAllowedEmail(`person@${ids.activeDomain}.attacker.example`), false)
    assert.equal(await isAllowedEmail('person@people.ai.attacker.example'), false)
  })

  test('allowedDomainOrg returns the shared workspace, and null for company domains', async () => {
    assert.equal(await allowedDomainOrg(`person@${ids.activeDomain}`), ids.org)
    assert.equal(await allowedDomainOrg('person@people.ai'), null)
    assert.equal(await allowedDomainOrg(`person@${ids.disabledDomain}`), null)
  })

  test('a user from an allowed domain joins the shared workspace as a member', async () => {
    const { provisionUserForTest } = await import('@/lib/supabase/auth-utils')
    const created = await provisionUserForTest({
      id: crypto.randomUUID(),
      email: `newhire@${ids.activeDomain}`,
      user_metadata: { full_name: 'New Hire' },
    } as any)

    assert.ok(created, 'provisioning returned nothing')
    assert.equal(created.organizationId, ids.org)
    assert.equal(created.role, 'USER')
  })

  test('a user from a company domain still gets their own workspace', async () => {
    const { provisionUserForTest } = await import('@/lib/supabase/auth-utils')
    const created = await provisionUserForTest({
      id: crypto.randomUUID(),
      email: `staff-${Date.now()}@people.ai`,
      user_metadata: { full_name: 'Staff Person' },
    } as any)

    assert.ok(created, 'provisioning returned nothing')
    assert.notEqual(created.organizationId, ids.org)
    assert.equal(created.role, 'ADMIN')
  })
}
