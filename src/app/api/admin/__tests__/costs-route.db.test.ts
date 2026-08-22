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
 *
 * The suite runs concurrently against a shared bs_ci_repro database, so an
 * exact global total is flaky by construction — sibling suites (and re-runs
 * of this one) leave residue rows behind. Every assertion below is
 * delta-scoped: capture the route's total before seeding, then assert it
 * grew by exactly what this suite seeded, never asserting the absolute
 * value.
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
  let totalBefore: number
  const orgIds: string[] = []
  const ORG_COUNT = 55
  // Full sum over 1..55 = 55*56/2 = 1540.00
  const SEEDED_SUM = (ORG_COUNT * (ORG_COUNT + 1)) / 2

  const get = () => new NextRequest(new URL('http://test/api/admin/costs?days=90'))
  const total = async () => {
    const response = await costsRoute.GET(get())
    const body = await response.json()
    assert.equal(response.status, 200, JSON.stringify(body))
    return body
  }
  const round2 = (n: number) => Number(n.toFixed(2))

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    const testAuth = await import('@/lib/server/__tests__/test-auth')

    operator = await testAuth.seedTestOrg(prisma, { orgKind: 'internal', platformRole: 'reviewer' })
    testAuth.installTestAuth(operator.auth)

    costsRoute = await import('../costs/route')

    // Baseline captured before this suite seeds anything, so every assertion
    // below can be delta-scoped against it — the shared bs_ci_repro database
    // may already carry residue from sibling suites, and this baseline
    // already reflects that residue.
    totalBefore = (await total()).total.costUsd

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
  })

  after(async () => {
    await prisma.llmCall.deleteMany({ where: { organizationId: { in: orgIds } } })
    await prisma.organization.deleteMany({ where: { id: { in: orgIds } } })
    await operator?.cleanup()
  })

  test('total is the unbounded aggregate, not the sum of the top-50 byOrg list', async () => {
    const body = await total()

    assert.equal(body.byOrg.length, 50, 'byOrg stays capped at the top 50 by spend')
    const top50Sum = body.byOrg.reduce((sum: number, row: any) => sum + row.costUsd, 0)
    const delta = round2(body.total.costUsd - totalBefore)
    assert.equal(delta, SEEDED_SUM, 'total must grow by exactly the seeded 55-org sum')
    // Bug-catching power preserved: with 55+ orgs carrying nonzero spend in
    // the window (our 55 alone already exceed the cap), the capped top-50
    // list can never account for the whole of the unbounded total — an
    // absolute inequality, so it holds regardless of whatever residue the
    // shared database is carrying (residue only ever adds more organizations
    // past the cap, never fewer, which makes the inequality more true, not
    // less).
    assert.ok(body.total.costUsd > top50Sum, 'the true total must exceed the capped top-50 sum')
  })

  test('response includes dataSince', async () => {
    const body = await total()
    assert.ok(body.dataSince, 'dataSince must be present')
    assert.ok(!Number.isNaN(new Date(body.dataSince).getTime()), 'dataSince must be a valid date')
  })

  test('a demo-clone organization cannot inflate the platform totals', async () => {
    // A demo org's LlmCall rows are fabricated (anonymised clones of a real
    // workspace's usage) — see src/lib/demo/snapshot.ts. If they blended into
    // this route's cross-org aggregate, every "top spender" and headline total
    // would count fiction as real spend. Assert the delta, not an absolute
    // value: seeding the demo org must leave the total unchanged.
    //
    // models-route-demo.db.test.ts runs the identical before/seed/after dance
    // against the same cross-org total; a shared Postgres advisory lock
    // serializes the two critical sections instead of merely racing them.
    await prisma.$transaction(async (tx: any) => {
      await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(918273645)')

      const before1 = await total()

      const demoOrg = await prisma.organization.create({
        data: { name: 'Demo Clone Org', slug: `demo-org-${crypto.randomUUID()}`, kind: 'demo' },
      })
      const demoCostUsd = '999999.00'
      await prisma.llmCall.create({
        data: {
          organizationId: demoOrg.id,
          surface: 'agent_turn',
          provider: 'anthropic',
          model: 'claude-test',
          priceVersion: 'test-2026-08',
          costUsd: demoCostUsd,
          inputTokens: 10,
          outputTokens: 10,
        },
      })

      try {
        const body = await total()

        assert.ok(
          !body.byOrg.some((row: any) => row.organizationId === demoOrg.id),
          'the demo org must not appear in byOrg',
        )
        const delta = round2(body.total.costUsd - before1.total.costUsd)
        assert.equal(delta, 0, 'seeding the demo org must leave the unbounded total unchanged')
      } finally {
        await prisma.llmCall.deleteMany({ where: { organizationId: demoOrg.id } })
        await prisma.organization.delete({ where: { id: demoOrg.id } })
      }
    }, { timeout: 20000, maxWait: 20000 })
  })
}
