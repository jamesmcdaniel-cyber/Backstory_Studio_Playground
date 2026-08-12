import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { User } from '@supabase/supabase-js'

/**
 * Deactivation must bite on the NEXT request, not when the access token
 * expires, and it must say so.
 *
 * These are DB-backed: the behaviour under test is the interaction between the
 * isActive column, the unique supabaseId, and the self-healing provisioning
 * path — none of which a stub reproduces.
 */
const TEST_DB = process.env.TEST_DATABASE_URL
const ENABLED = Boolean(TEST_DB)

if (!ENABLED) {
  test('deactivated accounts (skipped: TEST_DATABASE_URL not set)', { skip: true }, () => {})
}

if (ENABLED) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'test-key'

  let prisma: any
  let resolveAuthUser: (user: User) => Promise<{ dbUser: any; deactivated: boolean }>
  const ids: { organizationId?: string; activeSupabaseId?: string; inactiveSupabaseId?: string } = {}

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
    ;({ prisma } = await import('@/lib/prisma'))
    ;({ resolveAuthUser } = await import('../auth-utils'))

    const org = await prisma.organization.create({
      data: { name: 'Deactivation', slug: `deact-${Date.now()}` },
    })
    ids.organizationId = org.id
    ids.activeSupabaseId = crypto.randomUUID()
    ids.inactiveSupabaseId = crypto.randomUUID()

    await prisma.user.create({
      data: {
        supabaseId: ids.activeSupabaseId,
        email: `active-${Date.now()}@example.com`,
        organizationId: org.id,
        isActive: true,
      },
    })
    await prisma.user.create({
      data: {
        supabaseId: ids.inactiveSupabaseId,
        email: `inactive-${Date.now()}@example.com`,
        organizationId: org.id,
        isActive: false,
      },
    })
  })

  after(async () => {
    await prisma.user.deleteMany({ where: { organizationId: ids.organizationId } })
    await prisma.organization.delete({ where: { id: ids.organizationId } })
  })

  test('an active account resolves to its row', async () => {
    const result = await resolveAuthUser(identity(ids.activeSupabaseId!, 'active@example.com'))
    assert.equal(result.deactivated, false)
    assert.equal(result.dbUser?.supabaseId, ids.activeSupabaseId)
  })

  test('a deactivated account resolves to no user, flagged as deactivated', async () => {
    const result = await resolveAuthUser(identity(ids.inactiveSupabaseId!, 'inactive@example.com'))
    assert.equal(result.deactivated, true)
    assert.equal(result.dbUser, null)
  })

  test('resolving a deactivated account stays deactivated', async () => {
    await resolveAuthUser(identity(ids.inactiveSupabaseId!, 'inactive@example.com'))
    const row = await prisma.user.findUnique({ where: { supabaseId: ids.inactiveSupabaseId } })
    assert.equal(row.isActive, false, 'resolution must never reactivate an account')
    assert.equal(await prisma.user.count({ where: { supabaseId: ids.inactiveSupabaseId } }), 1)
  })

  test('the deactivation check short-circuits before provisioning', () => {
    // Deliberately a source check, not a behavioural one.
    //
    // The second half of this fix is that a deactivated account no longer
    // reaches provisionUser, which inserts an organization and a user before
    // the unique supabaseId rejects the batch — a rolled-back write transaction
    // on every request from a banned account. That is invisible to assertions:
    // the rollback restores the row counts, and pg_stat_database's counters are
    // snapshot-cached, so they read stale even seconds later (verified — under
    // the old code xact_commit moved by 0 across queries that certainly
    // committed).
    //
    // What can be pinned is the ordering, which is the whole mechanism. If
    // someone moves the isActive check below the provisionUser call, the
    // wasteful path returns and this fails.
    const source = readFileSync('src/lib/supabase/auth-utils.ts', 'utf8')
    const body = source.slice(source.indexOf('export async function resolveAuthUser'))
    const shortCircuit = body.indexOf('deactivated: true')
    const provision = body.indexOf('provisionUser(user)')
    assert.ok(shortCircuit > 0, 'resolveAuthUser must short-circuit on a deactivated row')
    assert.ok(provision > 0, 'resolveAuthUser must still provision unknown identities')
    assert.ok(shortCircuit < provision, 'the deactivated short-circuit must precede provisioning')
  })

  test('requireAuthContext answers ACCOUNT_DEACTIVATED, not the generic org error', async () => {
    const { AuthContextError } = await import('@/lib/server/auth')
    const source = readFileSync('src/lib/server/auth.ts', 'utf8')
    // The gate must precede the dbUser test — both branches are reachable for a
    // deactivated account, and the generic one first would mask this code.
    const deactivatedAt = source.indexOf('ACCOUNT_DEACTIVATED')
    const genericAt = source.indexOf('Organization access required')
    assert.ok(deactivatedAt > 0, 'requireAuthContext must raise ACCOUNT_DEACTIVATED')
    assert.ok(deactivatedAt < genericAt, 'the deactivation check must run before the dbUser check')
    assert.equal(new AuthContextError('x', 403, 'ACCOUNT_DEACTIVATED').status, 403)
  })
}
