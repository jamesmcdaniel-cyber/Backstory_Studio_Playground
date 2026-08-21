import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { NextRequest } from 'next/server'

/**
 * /api/admin/costs against a real database.
 *
 * The point of this suite: `byOrg` is capped at the top 50 workspaces by
 * spend, but the headline total must never be the sum of that capped list.
 * Seeding 55 organizations — five more than the cap — is what makes "the
 * total equals the top-50 sum" a plausible bug the test can actually catch,
 * rather than one that happens to pass because there were never more than 50
 * rows to begin with.
 */
const TEST_DB = process.env.TEST_DATABASE_URL
if (!TEST_DB) test('admin costs route (skipped: TEST_DATABASE_URL not set)', { skip: true }, () => {})

if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'test-key'

  let prisma: any
  let costsRoute: any
  let operator: any
  const orgIds: string[] = []
  const ORG_COUNT = 55

  const get = () => new NextRequest(new URL('http://test/api/admin/costs?days=90'))

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    const testAuth = await import('@/lib/server/__tests__/test-auth')

    operator = await testAuth.seedTestOrg(prisma, { orgKind: 'internal', platformRole: 'reviewer' })
    testAuth.installTestAuth(operator.auth)

    for (let index = 0; index < ORG_COUNT; index += 1) {
      const org = await prisma.organization.create({
        data: { name: `Cost Org ${index}`, slug: `cost-org-${crypto.randomUUID()}` },
      })
      orgIds.push(org.id)
      // Distinct spend per org so ordering by cost is deterministic and no two
      // organizations tie for the 50th spot.
      await prisma.llmCall.create({
        data: {
          organizationId: org.id,
          surface: 'agent_turn',
          provider: 'anthropic',
          model: 'claude-test',
          priceVersion: 'test-2026-08',
          costUsd: (index + 1).toFixed(2),
          inputTokens: 10,
          outputTokens: 10,
        },
      })
    }

    costsRoute = await import('../costs/route')
  })

  after(async () => {
    await prisma.llmCall.deleteMany({ where: { organizationId: { in: orgIds } } })
    await prisma.organization.deleteMany({ where: { id: { in: orgIds } } })
    await operator?.cleanup()
  })

  test('total is the unbounded aggregate, not the sum of the top-50 byOrg list', async () => {
    const response = await costsRoute.GET(get())
    const body = await response.json()
    assert.equal(response.status, 200, JSON.stringify(body))

    assert.equal(body.byOrg.length, 50, 'byOrg stays capped at the top 50 by spend')
    const top50Sum = body.byOrg.reduce((sum: number, row: any) => sum + row.costUsd, 0)
    // Full sum over 1..55 = 55*56/2 = 1540.00
    const fullSum = (ORG_COUNT * (ORG_COUNT + 1)) / 2
    assert.equal(body.total.costUsd, fullSum, 'total must be the full-table aggregate')
    assert.ok(body.total.costUsd > top50Sum, 'the true total must exceed the capped top-50 sum')
  })

  test('response includes dataSince', async () => {
    const response = await costsRoute.GET(get())
    const body = await response.json()
    assert.ok(body.dataSince, 'dataSince must be present')
    assert.ok(!Number.isNaN(new Date(body.dataSince).getTime()), 'dataSince must be a valid date')
  })
}
