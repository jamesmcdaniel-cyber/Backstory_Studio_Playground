import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { NextRequest } from 'next/server'

/**
 * The operator user console, end to end against a real database.
 *
 * What matters here is the cross-tenant reach (the whole point of the surface)
 * and the guards on the actions, which are the most consequential things anyone
 * can do to someone else's account.
 *
 * Supabase is not reachable from a test run, so the two actions that call it
 * (deactivate/reactivate) are covered by their REFUSALS — owner and self — which
 * are checked before any Supabase call. The happy path is left to manual
 * verification rather than faked with a stub that would prove nothing.
 */
const TEST_DB = process.env.TEST_DATABASE_URL
if (!TEST_DB) test('admin users route (skipped: TEST_DATABASE_URL not set)', { skip: true }, () => {})

if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'test-key'

  let prisma: any
  let systemPrisma: any
  let listRoute: any
  let actionsRoute: any
  let operator: any
  let subject: any
  let installTestAuth: any

  const get = (search = '') => new NextRequest(new URL(`http://test/api/admin/users${search}`))
  const action = (userId: string, body: unknown) =>
    new NextRequest(new URL(`http://test/api/admin/users/${userId}/actions`), {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    })

  before(async () => {
    ;({ prisma, systemPrisma } = await import('@/lib/prisma'))
    const testAuth = await import('@/lib/server/__tests__/test-auth')
    installTestAuth = testAuth.installTestAuth

    operator = await testAuth.seedTestOrg(prisma, {
      orgKind: 'internal',
      platformRole: 'reviewer',
      orgCreatedAt: new Date('2099-01-01T00:00:00.000Z'),
    })
    // A DIFFERENT workspace: reading across tenants is the feature.
    subject = await testAuth.seedTestOrg(prisma, { orgKind: 'customer' })
    await prisma.user.update({
      where: { id: subject.userId },
      data: { email: `subject-${crypto.randomUUID()}@example.com`, name: 'Subject Person' },
    })

    installTestAuth(operator.auth)
    listRoute = await import('../users/route')
    actionsRoute = await import('../users/[id]/actions/route')
  })

  after(async () => {
    await systemPrisma.auditEvent
      .deleteMany({ where: { organizationId: operator?.organizationId } })
      .catch(() => {})
    await subject?.cleanup()
    await operator?.cleanup()
  })

  test('an operator sees users from OTHER workspaces', async () => {
    const response = await listRoute.GET(get())
    // Read the body ONCE: passing `await response.text()` as an assertion
    // message consumes it eagerly, and the json() below then throws instead of
    // reporting the real failure.
    const body = await response.json()
    assert.equal(response.status, 200, JSON.stringify(body))

    const row = body.users.find((user: any) => user.id === subject.userId)
    assert.ok(row, 'a user from another workspace must appear')
    assert.equal(row.organizationId, subject.organizationId)
    assert.equal(row.name, 'Subject Person')
    assert.equal(row.isActive, true)
    assert.equal(typeof row.tokens, 'number')
    assert.equal(typeof row.integrations, 'number')
  })

  test('search narrows by email', async () => {
    const target = await prisma.user.findUnique({ where: { id: subject.userId } })
    const response = await listRoute.GET(get(`?q=${encodeURIComponent(target.email)}`))
    const body = await response.json()
    assert.ok(body.users.some((user: any) => user.id === subject.userId))
    assert.ok(
      body.users.every((user: any) => (user.email ?? '').includes(target.email.split('@')[0])),
      'every returned row should match the query',
    )
  })

  test('viewing writes an audit row naming the operator', async () => {
    await listRoute.GET(get())
    const event = await systemPrisma.auditEvent.findFirst({
      where: { organizationId: operator.organizationId, action: 'platform.users.viewed' },
      orderBy: { createdAt: 'desc' },
    })
    assert.ok(event, 'a view must be audited')
    assert.equal(event.actorUserId, operator.userId)
  })

  test('resetting daily runs stamps a watermark and audits it', async () => {
    const response = await actionsRoute.POST(action(subject.userId, { action: 'reset-daily-runs' }))
    assert.equal(response.status, 200, await response.text())

    const row = await prisma.user.findUnique({ where: { id: subject.userId } })
    assert.ok(row.runAllowanceResetAt, 'the watermark must be stamped')
    assert.ok(Date.now() - row.runAllowanceResetAt.getTime() < 60_000, 'and stamped to now')

    const event = await systemPrisma.auditEvent.findFirst({
      where: { organizationId: operator.organizationId, action: 'platform.users.reset-daily-runs' },
    })
    assert.ok(event)
    assert.equal(event.resourceId, subject.userId)
  })

  test('resetting monthly tokens is accepted and audited', async () => {
    const response = await actionsRoute.POST(action(subject.userId, { action: 'reset-monthly-tokens' }))
    assert.equal(response.status, 200, await response.text())
    const event = await systemPrisma.auditEvent.findFirst({
      where: { organizationId: operator.organizationId, action: 'platform.users.reset-monthly-tokens' },
    })
    assert.ok(event)
    // Recorded as workspace-scoped, because that is what the counter is.
    assert.equal(event.detail?.scope, 'workspace')
  })

  test('an operator cannot deactivate their own account', async () => {
    // Refused before Supabase is touched: it locks the operator out of the
    // console they would need to undo it.
    const response = await actionsRoute.POST(action(operator.userId, { action: 'deactivate' }))
    assert.equal(response.status, 400)
    assert.equal((await response.json()).code, 'SELF_DEACTIVATION')

    const row = await prisma.user.findUnique({ where: { id: operator.userId } })
    assert.equal(row.isActive, true, 'the operator must still be active')
  })

  test('the platform owner cannot be deactivated', async () => {
    const testAuth = await import('@/lib/server/__tests__/test-auth')
    const owner = await testAuth.seedTestOrg(prisma, { orgKind: 'customer', role: 'OWNER' })
    try {
      const response = await actionsRoute.POST(action(owner.userId, { action: 'deactivate' }))
      assert.equal(response.status, 403)
      assert.equal((await response.json()).code, 'OWNER_PROTECTED')

      const row = await prisma.user.findUnique({ where: { id: owner.userId } })
      assert.equal(row.isActive, true)
    } finally {
      // cleanup() clears the auth seam, so reinstalling BEFORE it would leave
      // every later test running unauthenticated (a 500 from `cookies` outside
      // a request scope, not the 4xx they assert on).
      await owner.cleanup()
      installTestAuth(operator.auth)
    }
  })

  test('an unknown user is a 404, not a crash', async () => {
    const response = await actionsRoute.POST(action('nope-not-a-user', { action: 'reset-daily-runs' }))
    assert.equal(response.status, 404)
  })

  test('an unrecognised action is rejected', async () => {
    const response = await actionsRoute.POST(action(subject.userId, { action: 'delete-everything' }))
    assert.ok(response.status >= 400 && response.status < 500, `expected a 4xx, saw ${response.status}`)
  })
}
