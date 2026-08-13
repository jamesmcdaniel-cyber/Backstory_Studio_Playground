import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { User } from '@supabase/supabase-js'

/**
 * Platform admission must be enforced by the session-resolution path, not by one
 * login route.
 *
 * `isAllowedEmail` used to be called only from src/app/auth/callback/route.ts,
 * so it governed exactly one way in. `signInWithPassword` mints its session
 * against Supabase directly and never reaches that callback — and passwords are
 * a live credential here (Settings sets one, the admin console mails resets), so
 * the gate was reachable-around rather than theoretical. Two consequences:
 *
 *   1. a domain whose access had been REVOKED kept minting new sessions forever
 *   2. a non-allowlisted address could be provisioned a fresh ADMIN workspace
 *
 * Both are asserted below against `resolveAuthUser`, which every request goes
 * through regardless of how the session was created.
 *
 * DB-backed for the same reason as deactivated-account.test.ts: the behaviour is
 * the interaction between the platform_allowed_domains rows, the users table,
 * and the self-healing provisioning path. A stub reproduces none of it.
 */
const TEST_DB = process.env.TEST_DATABASE_URL
const ENABLED = Boolean(TEST_DB)

if (!ENABLED) {
  test('platform admission gate (skipped: TEST_DATABASE_URL not set)', { skip: true }, () => {})
}

if (ENABLED) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'test-key'

  let prisma: any
  let systemPrisma: any
  let resolveAuthUser: (user: User) => Promise<{ dbUser: any; deactivated: boolean; accessRevoked: boolean }>
  const ids: Record<string, string> = {}
  const stamp = Date.now()
  const blockedDomain = `blocked-${stamp}.example`
  const activeDomain = `active-${stamp}.example`
  const unlistedDomain = `unlisted-${stamp}.example`

  /** The shape getAuthWithUser hands the resolver after verifying the token. */
  const identity = (supabaseId: string, email: string): User =>
    ({
      id: supabaseId,
      email,
      user_metadata: {},
      app_metadata: {},
      aud: 'authenticated',
      created_at: '',
    }) as User

  before(async () => {
    ;({ prisma, systemPrisma } = await import('@/lib/prisma'))
    ;({ resolveAuthUser } = await import('../auth-utils'))

    const org = await prisma.organization.create({
      data: { name: 'Admission', slug: `admission-${stamp}` },
    })
    ids.organizationId = org.id

    // A live grant and a revoked one, both pointing at the same workspace.
    await systemPrisma.platformAllowedDomain.create({
      data: { domain: activeDomain, organizationId: org.id },
    })
    await systemPrisma.platformAllowedDomain.create({
      data: { domain: blockedDomain, organizationId: org.id, disabledAt: new Date() },
    })

    // Members who already have rows: one on the revoked domain, one on a domain
    // that was never listed at all (an externally invited person, whose
    // admitting invitation was consumed when they were provisioned).
    for (const [key, domain] of [['revoked', blockedDomain], ['invitee', unlistedDomain]] as const) {
      const supabaseId = crypto.randomUUID()
      ids[key] = supabaseId
      await prisma.user.create({
        data: {
          supabaseId,
          email: `person-${stamp}@${domain}`,
          organizationId: org.id,
          isActive: true,
        },
      })
    }
  })

  after(async () => {
    await prisma.user.deleteMany({ where: { organizationId: ids.organizationId } })
    await systemPrisma.platformAllowedDomain.deleteMany({ where: { organizationId: ids.organizationId } })
    await prisma.organization.delete({ where: { id: ids.organizationId } })
  })

  test('a revoked domain refuses an EXISTING member — the password-grant bypass', async () => {
    // The finding, stated as a test: before the fix this returned the user's row,
    // because nothing on the password path ever asked the admission question.
    const result = await resolveAuthUser(identity(ids.revoked, `person-${stamp}@${blockedDomain}`))
    assert.equal(result.accessRevoked, true, 'a blocked domain must not resolve to a user')
    assert.equal(result.dbUser, null)
    assert.equal(result.deactivated, false, 'the account is intact — its DOMAIN lost access')
  })

  test('revocation leaves the account intact, so re-enabling restores it', async () => {
    const row = await prisma.user.findUnique({ where: { supabaseId: ids.revoked } })
    assert.equal(row.isActive, true, 'revoking domain access must not deactivate the account')
    assert.equal(row.organizationId, ids.organizationId, 'nor detach it from its workspace')
  })

  test('an unlisted domain still resolves — accepted invitees are not locked out', async () => {
    // The regression guard. Asking the FULL isAllowedEmail question per request
    // would refuse this account every time: its domain is not listed, and the
    // invitation that admitted it is long since ACCEPTED.
    const result = await resolveAuthUser(identity(ids.invitee, `person-${stamp}@${unlistedDomain}`))
    assert.equal(result.accessRevoked, false)
    assert.equal(result.dbUser?.supabaseId, ids.invitee)
  })

  test('a non-allowlisted stranger is refused AND provisions nothing', async () => {
    const before = {
      users: await prisma.user.count(),
      orgs: await prisma.organization.count(),
    }
    const result = await resolveAuthUser(identity(crypto.randomUUID(), `stranger-${stamp}@nobody-${stamp}.example`))
    assert.equal(result.accessRevoked, true)
    assert.equal(result.dbUser, null)
    // The gate runs BEFORE provisionUser, so a refused identity never creates an
    // organization it would then be ADMIN of.
    assert.equal(await prisma.user.count(), before.users, 'no user row may be created')
    assert.equal(await prisma.organization.count(), before.orgs, 'no organization may be created')
  })

  test('an active allowed domain still provisions a new member normally', async () => {
    const supabaseId = crypto.randomUUID()
    const result = await resolveAuthUser(identity(supabaseId, `newcomer-${stamp}@${activeDomain}`))
    assert.equal(result.accessRevoked, false, 'a live grant must still admit')
    assert.equal(result.dbUser?.organizationId, ids.organizationId, 'and route them to the shared workspace')
    assert.equal(result.dbUser?.role, 'USER', 'joining an existing workspace never makes them its admin')
  })

  test('the admission gate precedes provisioning', () => {
    // Ordering is the mechanism, exactly as in deactivated-account.test.ts: if
    // the gate moves below provisionUser, a refused identity gets a workspace
    // first and the assertion above becomes the only thing catching it.
    const source = readFileSync('src/lib/supabase/auth-utils.ts', 'utf8')
    const body = source.slice(source.indexOf('export async function resolveAuthUser'))
    const gate = body.indexOf('isAllowedEmail')
    const revoked = body.indexOf('isDomainAccessRevoked')
    const provision = body.indexOf('provisionUser(user)')
    assert.ok(gate > 0, 'resolveAuthUser must apply the full admission gate')
    assert.ok(revoked > 0, 'resolveAuthUser must re-check revocation per request')
    assert.ok(gate < provision, 'the admission gate must precede provisioning')
    assert.ok(revoked < provision, 'the revocation check must precede provisioning')
  })

  test('requireAuthContext answers PLATFORM_ACCESS_REVOKED, not the generic org error', async () => {
    const source = readFileSync('src/lib/server/auth.ts', 'utf8')
    const revokedAt = source.indexOf('PLATFORM_ACCESS_REVOKED')
    const genericAt = source.indexOf('Organization access required')
    assert.ok(revokedAt > 0, 'requireAuthContext must raise PLATFORM_ACCESS_REVOKED')
    assert.ok(revokedAt < genericAt, 'it must run before the generic dbUser check')
  })
}
