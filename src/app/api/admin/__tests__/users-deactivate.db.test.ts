import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import http from 'node:http'
import { NextRequest } from 'next/server'

/**
 * The deactivate/reactivate boundary with Supabase, against a stand-in GoTrue.
 *
 * These two actions were the only ones the operator-console suite left to
 * manual verification, on the grounds that a stub "would prove nothing".
 * Manual verification eventually found what it was always going to find: a
 * missing service-role key surfaced as a bare 500 ("Internal server error"),
 * because supabaseAdmin() throws SYNCHRONOUSLY and the .catch() chained onto
 * its return value never existed yet.
 *
 * The stub proves the second, worse one: updateUserById RESOLVES with
 * `{ error }` instead of rejecting — even when the host is unreachable — so a
 * failed ban fell straight through to the isActive flip and reported success.
 * That is exactly the ordering hazard the route's own comment says it avoids.
 * A hand-written fake would have been written to reject and would have hidden
 * it; only a real supabase-js client talking to a real socket shows it.
 */
const TEST_DB = process.env.TEST_DATABASE_URL
if (!TEST_DB) test('admin deactivate (skipped: TEST_DATABASE_URL not set)', { skip: true }, () => {})

if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'test-key'

  let prisma: any
  let systemPrisma: any
  let actionsRoute: any
  let operator: any
  let seedTestOrg: any
  let installTestAuth: any
  let server: http.Server
  let savedUrl: string | undefined
  let savedKey: string | undefined

  /** Every admin call the route made, so a silent no-op cannot pass as a ban. */
  let banRequests: Array<{ path: string; body: string }> = []
  /** Flipped per test to make the stand-in GoTrue reject the update. */
  let goTrueStatus = 200
  let goTrueErrorCode = 'unexpected_failure'

  before(async () => {
    server = http.createServer((request, response) => {
      let body = ''
      request.on('data', (chunk) => (body += chunk))
      request.on('end', () => {
        banRequests.push({ path: request.url ?? '', body })
        response.writeHead(goTrueStatus, { 'content-type': 'application/json' })
        response.end(
          JSON.stringify(
            goTrueStatus === 200
              ? { id: crypto.randomUUID(), email: 'stub@example.com' }
              : { code: goTrueStatus, error_code: goTrueErrorCode, msg: 'stub failure' },
          ),
        )
      })
    })
    await new Promise<void>((resolve) => server.listen(0, resolve))

    savedUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
    savedKey = process.env.SUPABASE_SERVICE_ROLE_KEY
    process.env.NEXT_PUBLIC_SUPABASE_URL = `http://127.0.0.1:${(server.address() as any).port}`
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub-service-role-key'

    ;({ prisma, systemPrisma } = await import('@/lib/prisma'))
    const testAuth = await import('@/lib/server/__tests__/test-auth')
    seedTestOrg = testAuth.seedTestOrg
    installTestAuth = testAuth.installTestAuth

    operator = await seedTestOrg(prisma, { orgKind: 'internal', platformRole: 'reviewer' })
    installTestAuth(operator.auth)
    actionsRoute = await import('../users/[id]/actions/route')
  })

  after(async () => {
    server?.close()
    if (savedUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL
    else process.env.NEXT_PUBLIC_SUPABASE_URL = savedUrl
    if (savedKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY
    else process.env.SUPABASE_SERVICE_ROLE_KEY = savedKey
    await systemPrisma?.auditEvent
      .deleteMany({ where: { organizationId: operator?.organizationId } })
      .catch(() => {})
    await operator?.cleanup()
  })

  /** A subject in ANOTHER workspace, holding a credential worth revoking. */
  async function seedSubject() {
    const subject = await seedTestOrg(prisma, { orgKind: 'customer' })
    await prisma.user.update({
      where: { id: subject.userId },
      data: { email: `subject-${crypto.randomUUID()}@example.com` },
    })
    await systemPrisma.integration.create({
      data: { organizationId: subject.organizationId, userId: subject.userId, provider: 'slack' },
    })
    // seedTestOrg's cleanup clears the injected auth; re-install so the seeding
    // of one test cannot log the next one out.
    installTestAuth(operator.auth)
    banRequests = []
    return subject
  }

  const act = (userId: string, action: string) =>
    actionsRoute.POST(
      new NextRequest(new URL(`http://test/api/admin/users/${userId}/actions`), {
        method: 'POST',
        body: JSON.stringify({ action }),
        headers: { 'content-type': 'application/json' },
      }),
    )

  const isActive = async (userId: string) =>
    (await systemPrisma.user.findUnique({ where: { id: userId }, select: { isActive: true } }))?.isActive

  test('deactivating bans the session, then revokes', async () => {
    const subject = await seedSubject()
    try {
      const response = await act(subject.userId, 'deactivate')
      const body = await response.json()
      assert.equal(response.status, 200, JSON.stringify(body))
      assert.equal(body.isActive, false)
      assert.equal(await isActive(subject.userId), false)
      assert.equal(banRequests.length, 1, 'the route must actually call Supabase')
      assert.match(banRequests[0].body, /"ban_duration":"876000h"/)
      assert.equal(
        await systemPrisma.integration.count({ where: { userId: subject.userId } }),
        0,
        'deactivation must revoke credentials, not just flip the column',
      )
    } finally {
      await subject.cleanup()
    }
  })

  test('a Supabase failure leaves the account ACTIVE rather than reporting success', async () => {
    const subject = await seedSubject()
    goTrueStatus = 500
    try {
      const response = await act(subject.userId, 'deactivate')
      const body = await response.json()
      assert.equal(response.status, 502, JSON.stringify(body))
      assert.equal(body.code, 'SUPABASE_ERROR')
      // The whole point of banning before flipping the column: a half-done
      // deactivation must leave the account still active and still bannable,
      // never marked deactivated here while the session lives on at Supabase.
      assert.equal(await isActive(subject.userId), true)
      assert.equal(
        await systemPrisma.integration.count({ where: { userId: subject.userId } }),
        1,
        'nothing may be revoked when the ban did not land',
      )
    } finally {
      goTrueStatus = 200
      await subject.cleanup()
    }
  })

  test('a missing service-role key is a named error, not a bare 500', async () => {
    const subject = await seedSubject()
    delete process.env.SUPABASE_SERVICE_ROLE_KEY
    try {
      const response = await act(subject.userId, 'deactivate')
      const body = await response.json()
      assert.equal(body.code, 'SUPABASE_UNCONFIGURED', JSON.stringify(body))
      assert.notEqual(body.error, 'Internal server error')
      assert.equal(await isActive(subject.userId), true)
    } finally {
      process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub-service-role-key'
      await subject.cleanup()
    }
  })

  test('a failed unban leaves the account deactivated', async () => {
    const subject = await seedSubject()
    try {
      assert.equal((await act(subject.userId, 'deactivate')).status, 200)
      goTrueStatus = 500
      const response = await act(subject.userId, 'reactivate')
      const body = await response.json()
      assert.equal(response.status, 502, JSON.stringify(body))
      // Mirror of the deactivate invariant: never report someone re-enabled
      // while Supabase still holds the ban that keeps them out.
      assert.equal(await isActive(subject.userId), false)
    } finally {
      goTrueStatus = 200
      await subject.cleanup()
    }
  })

  test('an account already gone from Supabase can still be cleared', async () => {
    const subject = await seedSubject()
    // What an operator who deleted the identity in the Supabase dashboard is
    // left holding: our row, pointing at nothing.
    goTrueStatus = 404
    goTrueErrorCode = 'user_not_found'
    try {
      const response = await act(subject.userId, 'deactivate')
      const body = await response.json()
      // There is no session to ban, so the request is already satisfied.
      // Reporting an outage here would block the operator on exactly the rows
      // they are trying to clear.
      assert.equal(response.status, 200, JSON.stringify(body))
      assert.equal(body.identityMissing, true)
      assert.match(body.notice, /no longer had a Supabase identity/)
      assert.equal(await isActive(subject.userId), false)
      assert.equal(
        await systemPrisma.integration.count({ where: { userId: subject.userId } }),
        0,
        'the orphaned row must still be deprovisioned',
      )
    } finally {
      goTrueStatus = 200
      goTrueErrorCode = 'unexpected_failure'
      await subject.cleanup()
    }
  })

  test('an account already gone from Supabase cannot be reactivated', async () => {
    const subject = await seedSubject()
    try {
      assert.equal((await act(subject.userId, 'deactivate')).status, 200)
      goTrueStatus = 404
      goTrueErrorCode = 'user_not_found'
      const response = await act(subject.userId, 'reactivate')
      const body = await response.json()
      // The mirror of the case above: lifting a ban nobody holds restores no
      // access, so saying "reactivated" would be a lie the operator acts on.
      assert.equal(response.status, 409, JSON.stringify(body))
      assert.equal(body.code, 'SUPABASE_IDENTITY_MISSING')
      assert.equal(await isActive(subject.userId), false)
    } finally {
      goTrueStatus = 200
      goTrueErrorCode = 'unexpected_failure'
      await subject.cleanup()
    }
  })
}
