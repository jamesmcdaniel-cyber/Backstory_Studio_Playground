import { test, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import http from 'node:http'
import { NextRequest } from 'next/server'

/**
 * Deleting an account from the operator console, and the Supabase sweep that
 * tells an operator which rows are worth deleting.
 *
 * The console's rows are ours alone — nothing prunes them when an identity is
 * removed in the Supabase dashboard — so the orphans it accumulates are the
 * whole reason this action exists. Every case here runs against a stand-in
 * GoTrue on a real socket for the reason the sibling suite documents: a
 * hand-written fake gets written to behave, and the behaviour under test is
 * exactly what the real client does when things are missing.
 */
const TEST_DB = process.env.TEST_DATABASE_URL
if (!TEST_DB) test('admin delete (skipped: TEST_DATABASE_URL not set)', { skip: true }, () => {})

if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'test-key'

  let prisma: any
  let systemPrisma: any
  let actionsRoute: any
  let listRoute: any
  let operator: any
  let seedTestOrg: any
  let installTestAuth: any
  let server: http.Server
  let savedUrl: string | undefined
  let savedKey: string | undefined

  /** Identities the stand-in GoTrue admits to holding. */
  let liveIdentities = new Set<string>()
  /** Of those, the ones it reports as banned — deactivated, but still listed. */
  const bannedIdentities = new Set<string>()
  /** Set to make DELETE report the identity as already gone. */
  let identityDeleteStatus = 200

  before(async () => {
    server = http.createServer((request, response) => {
      request.resume()
      request.on('end', () => {
        const path = (request.url ?? '').split('?')[0]
        const json = (status: number, body: unknown) => {
          response.writeHead(status, { 'content-type': 'application/json' })
          response.end(JSON.stringify(body))
        }
        if (request.method === 'GET' && path === '/auth/v1/admin/users') {
          return json(200, {
            users: [...liveIdentities].map((id) => ({
              id,
              // A banned identity is STILL returned by the admin listing. That
              // is the whole reason the sweep has to read this field.
              ...(bannedIdentities.has(id) ? { banned_until: '2126-01-01T00:00:00.000Z' } : {}),
            })),
            aud: 'authenticated',
          })
        }
        if (request.method === 'DELETE') {
          if (identityDeleteStatus !== 200) {
            return json(identityDeleteStatus, { code: identityDeleteStatus, error_code: 'user_not_found', msg: 'User not found' })
          }
          return json(200, {})
        }
        return json(200, { id: crypto.randomUUID() })
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
    listRoute = await import('../users/route')
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

  // Tearing a fixture down clears the injected auth context, so without this a
  // test is authenticated only if the test before it happened to seed something.
  beforeEach(() => {
    if (operator) installTestAuth(operator.auth)
  })

  async function seedSubject() {
    const subject = await seedTestOrg(prisma, { orgKind: 'customer' })
    await prisma.user.update({
      where: { id: subject.userId },
      data: { email: `subject-${crypto.randomUUID()}@example.com` },
    })
    const row = await systemPrisma.user.findUnique({ where: { id: subject.userId } })
    liveIdentities.add(row.supabaseId)
    installTestAuth(operator.auth)
    return { ...subject, supabaseId: row.supabaseId }
  }

  /** A colleague, so the subject is not the workspace's last member. */
  async function addColleague(organizationId: string) {
    const colleague = await systemPrisma.user.create({
      data: {
        supabaseId: crypto.randomUUID(),
        organizationId,
        role: 'ADMIN',
        email: `colleague-${crypto.randomUUID()}@example.com`,
      },
    })
    liveIdentities.add(colleague.supabaseId)
    return colleague
  }

  const act = (userId: string, action: string) =>
    actionsRoute.POST(
      new NextRequest(new URL(`http://test/api/admin/users/${userId}/actions`), {
        method: 'POST',
        body: JSON.stringify({ action }),
        headers: { 'content-type': 'application/json' },
      }),
    )

  const exists = async (userId: string) =>
    Boolean(await systemPrisma.user.findUnique({ where: { id: userId }, select: { id: true } }))

  test('deleting a colleague removes the row and revokes their grants upstream', async () => {
    const subject = await seedSubject()
    await addColleague(subject.organizationId)
    await systemPrisma.nangoConnection.create({
      data: {
        organizationId: subject.organizationId,
        userId: subject.userId,
        connectionId: `conn-${crypto.randomUUID()}`,
        providerConfigKey: 'slack',
      },
    })
    try {
      const response = await act(subject.userId, 'delete')
      const body = await response.json()
      assert.equal(response.status, 200, JSON.stringify(body))
      assert.equal(body.workspaceDeleted, false)
      assert.equal(await exists(subject.userId), false)
      // The workspace outlives them: they were not its last member.
      assert.ok(await systemPrisma.organization.findUnique({ where: { id: subject.organizationId } }))
      // Deleting the row cascades our RECORD of the grant away. Without a
      // revocation pass first, the grant itself would stay live at the provider
      // with nothing left that remembers to delete it.
      const { OUTBOX_TOPIC_CREDENTIAL_REVOKE } = await import('@/lib/outbox')
      assert.equal(
        await systemPrisma.outboxEvent.count({
          where: { organizationId: subject.organizationId, topic: OUTBOX_TOPIC_CREDENTIAL_REVOKE },
        }),
        1,
        'the upstream OAuth grant must be queued for deletion before the row goes',
      )
    } finally {
      await subject.cleanup().catch(() => {})
    }
  })

  test('deleting the last member takes the workspace with them', async () => {
    const subject = await seedSubject()
    const response = await act(subject.userId, 'delete')
    const body = await response.json()
    assert.equal(response.status, 200, JSON.stringify(body))
    assert.equal(body.workspaceDeleted, true)
    assert.match(body.notice, /last member/)
    assert.equal(await exists(subject.userId), false)
    assert.equal(await systemPrisma.organization.findUnique({ where: { id: subject.organizationId } }), null)
  })

  test('an account already gone from Supabase can be deleted', async () => {
    const subject = await seedSubject()
    // Exactly the row an operator is trying to clear: deleted in the Supabase
    // dashboard, still sitting in the console.
    identityDeleteStatus = 404
    liveIdentities.delete(subject.supabaseId)
    try {
      const response = await act(subject.userId, 'delete')
      const body = await response.json()
      assert.equal(response.status, 200, JSON.stringify(body))
      assert.equal(body.identityMissing, true)
      assert.equal(await exists(subject.userId), false)
    } finally {
      identityDeleteStatus = 200
      await subject.cleanup().catch(() => {})
    }
  })

  test('an operator cannot delete their own account', async () => {
    const response = await act(operator.userId, 'delete')
    const body = await response.json()
    assert.equal(response.status, 400, JSON.stringify(body))
    assert.equal(body.code, 'SELF_DELETION')
    assert.equal(await exists(operator.userId), true)
  })

  test('the platform owner cannot be deleted', async () => {
    const owner = await seedTestOrg(prisma, { orgKind: 'customer', role: 'OWNER' })
    installTestAuth(operator.auth)
    try {
      const response = await act(owner.userId, 'delete')
      const body = await response.json()
      assert.equal(response.status, 403, JSON.stringify(body))
      assert.equal(body.code, 'OWNER_PROTECTED')
      assert.equal(await exists(owner.userId), true)
    } finally {
      await owner.cleanup().catch(() => {})
    }
  })

  test('the list flags rows whose Supabase identity is gone', async () => {
    const live = await seedSubject()
    const orphan = await seedSubject()
    liveIdentities.delete(orphan.supabaseId)
    try {
      const body = await (await listRoute.GET(new NextRequest(new URL('http://test/api/admin/users')))).json()
      assert.equal(body.identitiesReconciled, true)
      const find = (id: string) => body.users.find((user: any) => user.id === id)
      assert.equal(find(orphan.userId).supabaseIdentity, 'missing')
      assert.equal(find(live.userId).supabaseIdentity, 'present')
    } finally {
      await live.cleanup().catch(() => {})
      await orphan.cleanup().catch(() => {})
    }
  })

  test('an account banned in Supabase drops out of the list, and can be recovered', async () => {
    const banned = await seedSubject()
    bannedIdentities.add(banned.supabaseId)
    try {
      const list = async (search = '') =>
        (await (await listRoute.GET(new NextRequest(new URL(`http://test/api/admin/users${search}`)))).json())

      // Deactivated in Supabase alone — our own isActive flag is untouched,
      // which is exactly the case that used to read as a healthy account.
      const shown = await list()
      assert.equal(shown.users.some((user: any) => user.id === banned.userId), false)
      assert.ok(shown.deactivatedHidden >= 1, 'the hidden count must name what was withheld')

      // Recoverable, or the console could never reactivate or delete the row.
      const all = await list('?deactivated=1')
      const row = all.users.find((user: any) => user.id === banned.userId)
      assert.ok(row, 'the account must still be reachable with ?deactivated=1')
      assert.equal(row.supabaseIdentity, 'disabled')
      assert.equal(all.deactivatedHidden, 0)
    } finally {
      bannedIdentities.delete(banned.supabaseId)
      await banned.cleanup().catch(() => {})
    }
  })

  test('an orphaned row stays visible — it is a cleanup task, not a switched-off account', async () => {
    const orphan = await seedSubject()
    liveIdentities.delete(orphan.supabaseId)
    try {
      const body = await (await listRoute.GET(new NextRequest(new URL('http://test/api/admin/users')))).json()
      const row = body.users.find((user: any) => user.id === orphan.userId)
      assert.ok(row, 'hiding orphans by default is how they would stay unresolved')
      assert.equal(row.supabaseIdentity, 'missing')
    } finally {
      await orphan.cleanup().catch(() => {})
    }
  })

  test('an unavailable sweep reports unknown, never a table full of orphans', async () => {
    const subject = await seedSubject()
    delete process.env.SUPABASE_SERVICE_ROLE_KEY
    try {
      const body = await (await listRoute.GET(new NextRequest(new URL('http://test/api/admin/users')))).json()
      // The dangerous failure mode: a sweep that returns nothing must not read
      // as "every account was deleted upstream", or the console invites an
      // operator to delete the entire platform.
      assert.equal(body.identitiesReconciled, false)
      assert.equal(body.users.find((user: any) => user.id === subject.userId).supabaseIdentity, 'unknown')
    } finally {
      process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub-service-role-key'
      await subject.cleanup().catch(() => {})
    }
  })
}
