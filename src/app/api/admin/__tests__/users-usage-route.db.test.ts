import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'
import { lockedLedgerClient, withUsageAggregateLock } from '@/lib/server/__tests__/usage-aggregate-lock'

/**
 * GET /api/admin/users/[id]/usage — the per-user drill-down behind the
 * operator console's expandable rows.
 *
 * The point of this suite is isolation: the whole surface exists so an
 * operator can ask "what did THIS person spend", so a leak of a sibling
 * user's rows into the totals — even within the same workspace — would
 * defeat the feature. Every assertion is delta/identity-scoped against a
 * freshly seeded pair rather than the shared bs_ci_repro database's global
 * state.
 */
const TEST_DB = process.env.TEST_DATABASE_URL
if (!TEST_DB) test('admin per-user usage route (skipped: TEST_DATABASE_URL not set)', { skip: true }, () => {})

if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'test-key'

  let prisma: any
  let systemPrisma: any
  let recordLlmCall: any
  let usageRoute: any
  let operator: any
  let userA: any
  let userB: any

  const get = (id: string, search = '') =>
    new NextRequest(new URL(`http://test/api/admin/users/${id}/usage${search}`))

  before(async () => {
    ;({ prisma, systemPrisma } = await import('@/lib/prisma'))
    const testAuth = await import('@/lib/server/__tests__/test-auth')
    ;({ recordLlmCall } = await import('@/lib/usage/ledger'))

    operator = await testAuth.seedTestOrg(prisma, { orgKind: 'internal', platformRole: 'reviewer' })
    // Same workspace on purpose: the isolation this route must guarantee is
    // per-USER, not merely per-org — two users sharing an org is the case a
    // naive `where: { organizationId }` would get wrong.
    userA = await testAuth.seedTestOrg(prisma, { orgKind: 'customer' })
    userB = await prisma.user.create({
      data: {
        supabaseId: (await import('node:crypto')).randomUUID(),
        organizationId: userA.organizationId,
        isActive: true,
        role: 'USER',
      },
    })

    testAuth.installTestAuth(operator.auth)
    usageRoute = await import('../users/[id]/usage/route')

    await recordLlmCall({
      organizationId: userA.organizationId,
      userId: userA.userId,
      surface: 'agent_turn',
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      usage: { inputTokens: 100, cacheWriteTokens: 10, cacheReadTokens: 5, outputTokens: 50 },
    }, lockedLedgerClient(systemPrisma))
    await recordLlmCall({
      organizationId: userA.organizationId,
      userId: userA.userId,
      surface: 'flow_ai',
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      usage: { inputTokens: 20, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 10 },
    }, lockedLedgerClient(systemPrisma))
    // User B's own spend — must never bleed into user A's report.
    await recordLlmCall({
      organizationId: userA.organizationId,
      userId: userB.id,
      surface: 'agent_turn',
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      usage: { inputTokens: 9999, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 9999 },
    }, lockedLedgerClient(systemPrisma))
  })

  after(async () => {
    await withUsageAggregateLock(prisma, () => prisma.llmCall.deleteMany({ where: { organizationId: userA.organizationId } }))
    await prisma.user.deleteMany({ where: { id: userB.id } }).catch(() => {})
    await userA?.cleanup()
    await operator?.cleanup()
  })

  test('reports only the requested user\'s rows, not a sibling in the same workspace', async () => {
    const response = await usageRoute.GET(get(userA.userId))
    const body = await response.json()
    assert.equal(response.status, 200, JSON.stringify(body))

    assert.equal(body.userId, userA.userId)
    assert.equal(body.totals.calls, 2, 'only user A\'s two calls')
    assert.equal(body.totals.inputTokens, 120)
    assert.equal(body.totals.outputTokens, 60)
    assert.equal(body.totals.cacheReadTokens, 5)
    assert.equal(body.totals.cacheWriteTokens, 10)
    assert.ok(!body.totals.calls || body.totals.inputTokens < 9999, 'user B\'s huge call must not leak in')
  })

  test('breaks down by model and by surface', async () => {
    const response = await usageRoute.GET(get(userA.userId))
    const body = await response.json()

    assert.equal(body.byModel.length, 2)
    const sonnet = body.byModel.find((row: any) => row.model === 'claude-sonnet-5')
    assert.ok(sonnet)
    assert.equal(sonnet.calls, 1)

    assert.equal(body.bySurface.length, 2)
    const agentTurn = body.bySurface.find((row: any) => row.surface === 'agent_turn')
    assert.ok(agentTurn)
    assert.equal(agentTurn.calls, 1)
  })

  test('a sibling user\'s calls do not appear when querying the OTHER user', async () => {
    const response = await usageRoute.GET(get(userB.id))
    const body = await response.json()
    assert.equal(response.status, 200, JSON.stringify(body))
    assert.equal(body.totals.calls, 1)
    assert.equal(body.totals.inputTokens, 9999)
    assert.ok(!body.byModel.some((row: any) => row.model === 'claude-haiku-4-5'), 'user A\'s model must not appear for user B')
  })

  test('carries a "data since" date and flags org rows that predate per-person attribution', async () => {
    const response = await usageRoute.GET(get(userA.userId))
    const body = await response.json()
    assert.ok(body.dataSince, 'dataSince must be present')
    assert.ok(!Number.isNaN(new Date(body.dataSince).getTime()))

    // No NULL-userId rows seeded for this org yet.
    assert.equal(body.hasUnattributedOrgUsage, false)

    await withUsageAggregateLock(prisma, () => prisma.llmCall.create({
      data: {
        organizationId: userA.organizationId,
        userId: null,
        surface: 'eval_bench',
        provider: 'anthropic',
        model: 'claude-test',
        priceVersion: 'test-2026-08',
        costUsd: '1.00',
        inputTokens: 5,
        outputTokens: 5,
      },
    }))
    const after = await usageRoute.GET(get(userA.userId))
    const afterBody = await after.json()
    assert.equal(afterBody.hasUnattributedOrgUsage, true, 'a NULL-userId row in the org must flip the footnote flag')
  })

  test('a user in a demo-clone workspace is not reachable through this drill-down', async () => {
    const testAuth = await import('@/lib/server/__tests__/test-auth')
    const demo = await testAuth.seedTestOrg(prisma, { orgKind: 'demo' })
    try {
      const response = await usageRoute.GET(get(demo.userId))
      assert.equal(response.status, 404)
    } finally {
      // cleanup() clears the auth seam, so reinstalling BEFORE it would leave
      // every later test running unauthenticated (a 500 from `cookies` outside
      // a request scope, not the 4xx it asserts on).
      await demo.cleanup()
      testAuth.installTestAuth(operator.auth)
    }
  })

  test('an unknown user id is a 404, not a crash', async () => {
    const response = await usageRoute.GET(get('nope-not-a-user'))
    assert.equal(response.status, 404)
  })
}
