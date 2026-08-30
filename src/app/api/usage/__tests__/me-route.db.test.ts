import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'
import { lockedLedgerClient, withUsageAggregateLock } from '@/lib/server/__tests__/usage-aggregate-lock'

/**
 * GET /api/usage/me — the self-serve "what did I spend" view.
 *
 * The negative case is the point of this suite: a caller must see ONLY their
 * own rows, never a colleague's, even inside the same organization. A route
 * that scoped by organizationId alone (the ordinary tenant guard's habit)
 * would pass every other test here and still leak.
 */
const TEST_DB = process.env.TEST_DATABASE_URL
if (!TEST_DB) test('usage/me route (skipped: TEST_DATABASE_URL not set)', { skip: true }, () => {})

if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'test-key'
  process.env.AGENT_MONTHLY_TOKEN_LIMIT = process.env.AGENT_MONTHLY_TOKEN_LIMIT || '1000000000'

  let prisma: any
  let systemPrisma: any
  let recordLlmCall: any
  let meRoute: any
  let installTestAuth: any
  let self: any
  let colleague: any

  const get = () => new NextRequest(new URL('http://test/api/usage/me'))

  before(async () => {
    ;({ prisma, systemPrisma } = await import('@/lib/prisma'))
    const testAuth = await import('@/lib/server/__tests__/test-auth')
    installTestAuth = testAuth.installTestAuth
    ;({ recordLlmCall } = await import('@/lib/usage/ledger'))

    self = await testAuth.seedTestOrg(prisma, { orgKind: 'customer' })
    const colleagueUser = await prisma.user.create({
      data: {
        supabaseId: (await import('node:crypto')).randomUUID(),
        organizationId: self.organizationId,
        isActive: true,
        role: 'USER',
      },
    })
    colleague = colleagueUser

    installTestAuth(self.auth)
    meRoute = await import('../me/route')

    await recordLlmCall({
      organizationId: self.organizationId,
      userId: self.userId,
      surface: 'agent_turn',
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      usage: { inputTokens: 100, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 50 },
    }, lockedLedgerClient(systemPrisma))
    await recordLlmCall({
      organizationId: self.organizationId,
      userId: self.userId,
      surface: 'flow_ai',
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      usage: { inputTokens: 30, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 10 },
    }, lockedLedgerClient(systemPrisma))
    // The colleague's own spend, same org — must never appear in `self`'s view.
    await recordLlmCall({
      organizationId: self.organizationId,
      userId: colleague.id,
      surface: 'agent_turn',
      provider: 'anthropic',
      model: 'claude-opus-4',
      usage: { inputTokens: 12345, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 6789 },
    }, lockedLedgerClient(systemPrisma))
    // Org-level bench spend (userId null) — must not silently vanish into an
    // "other" bucket total; it must be grouped out of the per-user view
    // entirely, which the hasUnattributedOrgUsage footnote then discloses.
    await withUsageAggregateLock(prisma, () => prisma.llmCall.create({
      data: {
        organizationId: self.organizationId,
        userId: null,
        surface: 'eval_bench',
        provider: 'anthropic',
        model: 'claude-test',
        priceVersion: 'test-2026-08',
        costUsd: '3.00',
        inputTokens: 40,
        outputTokens: 40,
      },
    }))
  })

  after(async () => {
    await withUsageAggregateLock(prisma, () => prisma.llmCall.deleteMany({ where: { organizationId: self.organizationId } }))
    await prisma.user.deleteMany({ where: { id: colleague.id } }).catch(() => {})
    await self?.cleanup()
  })

  test('reports only the caller\'s own rows', async () => {
    const response = await meRoute.GET(get())
    const body = await response.json()
    assert.equal(response.status, 200, JSON.stringify(body))

    assert.equal(body.totals.calls, 2)
    assert.equal(body.totals.inputTokens, 130)
    assert.equal(body.totals.outputTokens, 60)
  })

  test('a colleague\'s rows in the same org are excluded (negative isolation)', async () => {
    const response = await meRoute.GET(get())
    const body = await response.json()
    assert.ok(!body.byModel.some((row: any) => row.model === 'claude-opus-4'), 'the colleague\'s model must not appear')
    assert.ok(body.totals.inputTokens < 12345, 'the colleague\'s huge call must not be summed in')
  })

  test('breaks down by surface bucket and by model', async () => {
    const response = await meRoute.GET(get())
    const body = await response.json()
    const agent = body.bySurface.find((row: any) => row.bucket === 'agent')
    const flow = body.bySurface.find((row: any) => row.bucket === 'flow')
    assert.ok(agent)
    assert.ok(flow)
    assert.equal(agent.calls, 1)
    assert.equal(flow.calls, 1)
    assert.equal(body.byModel.length, 2)
  })

  test('org-level bench spend (null userId) never appears in the per-user breakdown, and is disclosed via the footnote flag', async () => {
    const response = await meRoute.GET(get())
    const body = await response.json()
    assert.ok(
      !body.byModel.some((row: any) => row.model === 'claude-test'),
      'the null-userId bench row must not be grouped into any per-user bucket',
    )
    assert.equal(body.hasUnattributedOrgUsage, true)
  })

  test('carries the org\'s credits context alongside the per-user figures', async () => {
    const response = await meRoute.GET(get())
    const body = await response.json()
    assert.equal(typeof body.credits.usedTokens, 'number')
    assert.equal(typeof body.credits.budgetTokens, 'number')
  })
}
