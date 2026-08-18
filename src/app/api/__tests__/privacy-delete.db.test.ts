import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { NextRequest } from 'next/server'

/**
 * The two irreversible deletion routes, and the guards that stand in front of
 * them.
 *
 * Both sat on the SKIPS list in mutating-route-smoke.test.ts citing "privacy
 * service tests" — which did not exist: src/lib/privacy/delete.ts was imported
 * by no test at all, so every refusal branch in it (the platform owner, the
 * last-owner-standing conflict) and both routes' confirmation gates were
 * unexecuted code.
 *
 * What is safe to test is exactly the part that matters: the REFUSALS. Each
 * case drives the real handler or the real service function down a path that
 * ends before anything is destroyed, and then asserts the row is still there.
 * Nothing here ever reaches teardownOrganization or Supabase's deleteUser.
 */

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  process.env.ENTITLEMENT_GATE = 'off'
  // supabaseAdmin() is constructed before the member-count conflict is raised,
  // and refuses to build without these. Constructing a Supabase client opens no
  // socket — the conflict throws before any call is made.
  process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'https://fake.supabase.invalid'
  process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'fake-service-role-key'
}

const skip = TEST_DB ? false : 'requires TEST_DATABASE_URL'

let prisma: any
let installTestAuth: (auth: any) => void
/** The everyday member — enough for the account route. */
let seeded: any
/**
 * A separate workspace whose caller holds `workspace.delete`, which only the
 * OWNER role carries. Separate, not the same fixture, because OWNER is bound to
 * the platform-owner identity by a database trigger — and that identity is
 * precisely what the account route's own guard refuses.
 */
let ownerOrg: any

before(async () => {
  if (!TEST_DB) return
  ;({ prisma } = await import('@/lib/prisma'))
  const testAuth = await import('@/lib/server/__tests__/test-auth')
  installTestAuth = testAuth.installTestAuth
  seeded = await testAuth.seedTestOrg(prisma)
  await prisma.user.update({ where: { id: seeded.userId }, data: { email: 'privacy-fixture@example.test' } })
  seeded.auth.dbUser.email = 'privacy-fixture@example.test'
  ownerOrg = await testAuth.seedTestOrg(prisma, { role: 'OWNER' })
  installTestAuth(seeded.auth)
})

after(async () => {
  if (!TEST_DB) return
  await seeded?.cleanup()
  await ownerOrg?.cleanup()
})

const del = (path: string, payload: unknown) =>
  new NextRequest(new URL(`http://test${path}`), {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  } as never)

/**
 * Pure — no database, no Supabase. The owner check is the FIRST statement in
 * deleteUserAccount, before any client is built or any row is read, which is
 * what makes this assertable without a fixture and what makes it meaningful:
 * the guard cannot be defeated by the environment.
 */
test('deleting the platform owner account is refused outright', async () => {
  const { deleteUserAccount, DeleteConflictError } = await import('@/lib/privacy/delete')
  await assert.rejects(
    () =>
      deleteUserAccount({
        userId: 'irrelevant',
        supabaseId: 'irrelevant',
        organizationId: 'irrelevant',
        email: 'James.McDaniel@people.ai',
        role: 'OWNER',
      }),
    (error: unknown) => {
      assert.ok(error instanceof DeleteConflictError, `expected DeleteConflictError, got ${String(error)}`)
      assert.match(String((error as Error).message), /platform owner/i)
      return true
    },
  )
})

test('the last owner of a shared workspace cannot delete their account', { skip }, async () => {
  const { deleteUserAccount, DeleteConflictError } = await import('@/lib/privacy/delete')
  const colleague = await prisma.user.create({
    data: {
      supabaseId: crypto.randomUUID(),
      organizationId: seeded.organizationId,
      isActive: true,
      role: 'USER',
    },
  })
  try {
    await assert.rejects(
      () =>
        deleteUserAccount({
          userId: seeded.userId,
          supabaseId: seeded.auth.dbUser.supabaseId,
          organizationId: seeded.organizationId,
          email: seeded.auth.dbUser.email,
          // Not the platform owner identity — the workspace-ownership branch.
          role: 'OWNER',
        }),
      (error: unknown) => {
        assert.ok(error instanceof DeleteConflictError, `expected DeleteConflictError, got ${String(error)}`)
        assert.match(String((error as Error).message), /ownership/i)
        return true
      },
    )
    const survivor = await prisma.user.findFirst({
      where: { id: seeded.userId, organizationId: seeded.organizationId },
    })
    assert.ok(survivor, 'a refused deletion must leave the account intact')
  } finally {
    await prisma.user.delete({ where: { id: colleague.id } }).catch(() => {})
  }
})

test('account deletion refuses a confirmation that is not the caller’s email', { skip }, async () => {
  const { DELETE } = await import('../privacy/account/route')
  const response = await DELETE(del('/api/privacy/account', { confirmation: 'not-my-email@example.test' }))
  const body = await response.json()
  assert.equal(response.status, 400, JSON.stringify(body))
  assert.equal(body.code, 'CONFIRMATION_REQUIRED')
  const survivor = await prisma.user.findFirst({
    where: { id: seeded.userId, organizationId: seeded.organizationId },
  })
  assert.ok(survivor, 'the account must survive a failed confirmation')
})

test('workspace deletion refuses a confirmation that is not the workspace name', { skip }, async () => {
  installTestAuth(ownerOrg.auth)
  try {
    const { DELETE } = await import('../privacy/workspace/route')
    const response = await DELETE(del('/api/privacy/workspace', { confirmation: 'Definitely Not The Name' }))
    const body = await response.json()
    assert.equal(response.status, 400, JSON.stringify(body))
    assert.equal(body.code, 'CONFIRMATION_REQUIRED')
    const survivor = await prisma.organization.findUnique({ where: { id: ownerOrg.organizationId } })
    assert.ok(survivor, 'the workspace must survive a failed confirmation')
  } finally {
    installTestAuth(seeded.auth)
  }
})

test('both deletion routes reject a body with no confirmation at all', { skip }, async () => {
  const account = await import('../privacy/account/route')
  const workspace = await import('../privacy/workspace/route')
  assert.equal((await account.DELETE(del('/api/privacy/account', {}))).status, 400)
  installTestAuth(ownerOrg.auth)
  try {
    assert.equal((await workspace.DELETE(del('/api/privacy/workspace', {}))).status, 400)
  } finally {
    installTestAuth(seeded.auth)
  }
})
