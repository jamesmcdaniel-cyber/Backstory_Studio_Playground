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

  test('allowedDomainOrg returns the shared workspace, and null without an active row', async () => {
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

  test('a live invitation admits that one address, without opening its domain', async () => {
    const stamp = Date.now()
    const invited = `invitee-${stamp}@outside.example`
    await prisma.invitation.create({
      data: {
        email: invited,
        organizationId: ids.org,
        tokenHash: `hash-live-${stamp}`,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    })

    assert.equal(await isAllowedEmail(invited), true)
    assert.equal(await isAllowedEmail(`INVITEE-${stamp}@OUTSIDE.EXAMPLE`), true, 'match is case-insensitive')
    // Person-scoped, not domain-scoped: a colleague at the same company is not
    // admitted by someone else's invitation.
    assert.equal(await isAllowedEmail(`colleague-${stamp}@outside.example`), false)
  })

  test('an expired or revoked invitation admits nobody', async () => {
    const stamp = Date.now()
    const expired = `expired-${stamp}@outside.example`
    const revoked = `revoked-${stamp}@outside.example`
    const accepted = `accepted-${stamp}@outside.example`

    await prisma.invitation.create({
      data: {
        email: expired,
        organizationId: ids.org,
        tokenHash: `hash-expired-${stamp}`,
        expiresAt: new Date(Date.now() - 60 * 1000),
      },
    })
    await prisma.invitation.create({
      data: {
        email: revoked,
        organizationId: ids.org,
        tokenHash: `hash-revoked-${stamp}`,
        status: 'REVOKED',
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    })
    await prisma.invitation.create({
      data: {
        email: accepted,
        organizationId: ids.org,
        tokenHash: `hash-accepted-${stamp}`,
        status: 'ACCEPTED',
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    })

    assert.equal(await isAllowedEmail(expired), false)
    assert.equal(await isAllowedEmail(revoked), false)
    // Acceptance hands access to the user row; the invitation stops granting it.
    assert.equal(await isAllowedEmail(accepted), false)
  })

  test('an invitation does not make its domain a shared-workspace domain', async () => {
    const stamp = Date.now()
    const invited = `joiner-${stamp}@outside.example`
    await prisma.invitation.create({
      data: {
        email: invited,
        organizationId: ids.org,
        tokenHash: `hash-joiner-${stamp}`,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    })
    // allowedDomainOrg drives auto-join for ALLOWLISTED domains. An invitee
    // joins by accepting their invitation, not by domain.
    assert.equal(await allowedDomainOrg(invited), null)
  })

  test('a company domain with no routing row still gets its people their own workspace', async () => {
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

  // The bug this pins: a company domain is admitted by the hardcoded list, so
  // /admin/domains refused to store a row for it — and with no row,
  // allowedDomainOrg returned null and every employee was provisioned into a
  // solo workspace. Colleagues then could not see each other's flows or agents,
  // which is org-scoped by design. A company domain now takes a routing row
  // like any other, and admission stays hardcoded either way.
  test('a company domain WITH a routing row sends its people to the shared workspace', async () => {
    const { provisionUserForTest } = await import('@/lib/supabase/auth-utils')
    // systemPrisma: platform_allowed_domains is a platform-wide table with no
    // organizationId of its own, which is exactly what the tenant guard refuses
    // on the tenant client — the routes that own it use systemPrisma too.
    const { systemPrisma } = await import('@/lib/prisma')
    const row = await systemPrisma.platformAllowedDomain.create({
      data: { domain: 'people.ai', organizationId: ids.org },
    })
    try {
      assert.equal(await allowedDomainOrg('staff@people.ai'), ids.org)

      const created = await provisionUserForTest({
        id: crypto.randomUUID(),
        email: `routed-${Date.now()}@people.ai`,
        user_metadata: { full_name: 'Routed Staff' },
      } as any)
      assert.ok(created, 'provisioning returned nothing')
      assert.equal(created.organizationId, ids.org, 'company staff join the routed workspace')
      assert.equal(created.role, 'USER', 'joining an existing workspace never makes them its admin')

      // Blocking the row stops auto-join without touching admission — the
      // hardcoded company list is what admits them.
      await systemPrisma.platformAllowedDomain.update({ where: { id: row.id }, data: { disabledAt: new Date() } })
      assert.equal(await allowedDomainOrg('staff@people.ai'), null)
      assert.equal(await isAllowedEmail('staff@people.ai'), true)
    } finally {
      await systemPrisma.platformAllowedDomain.delete({ where: { id: row.id } }).catch(() => {})
    }
  })
}
