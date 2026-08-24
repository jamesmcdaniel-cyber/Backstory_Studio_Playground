import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { NextRequest } from 'next/server'

/**
 * /api/admin/adoption against a real database.
 *
 * Shared CI-mode database, so assertions are delta-scoped: this suite seeds
 * one organization and asserts only about that organization's row inside the
 * response, never about platform totals a sibling suite also writes to.
 */
const TEST_DB = process.env.TEST_DATABASE_URL
if (!TEST_DB) test('admin adoption route (skipped: TEST_DATABASE_URL not set)', { skip: true }, () => {})

if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'test-key'

  let prisma: any
  let adoptionRoute: any
  let operator: any
  let orgId: string
  const WEEK = new Date('2026-06-01T00:00:00Z')

  const get = (weeks: number) =>
    new NextRequest(new URL(`http://test/api/admin/adoption?weeks=${weeks}`))

  const report = async (weeks = 52) => {
    const response = await adoptionRoute.GET(get(weeks))
    const body = await response.json()
    assert.equal(response.status, 200, JSON.stringify(body))
    return body
  }

  before(async () => {
    ;({ systemPrisma: prisma } = await import('@/lib/prisma'))
    const testAuth = await import('@/lib/server/__tests__/test-auth')

    // platform.administer requires BOTH an operating org kind and the reviewer
    // flag — see resolvePermissions. Either alone yields a 403.
    operator = await testAuth.seedTestOrg(prisma, { orgKind: 'internal', platformRole: 'reviewer' })
    testAuth.installTestAuth(operator.auth)

    // Imported AFTER installTestAuth: the wrapper resolves auth at module
    // scope, so importing first captures the un-installed context.
    adoptionRoute = await import('../adoption/route')

    const suffix = crypto.randomUUID().slice(0, 8)
    const org = await prisma.organization.create({
      data: { name: `adopt-read-${suffix}`, slug: `adopt-read-${suffix}` },
    })
    orgId = org.id

    await prisma.adoptionWeek.create({
      data: {
        organizationId: orgId, weekStart: WEEK,
        agentsCreated: 4, execTotal: 10, execManual: 4,
        execByTrigger: { manual: 4, schedule: 6 },
        engagedUsers: 3, approvalsApproved: 8, approvalsRejected: 2,
      },
    })
    // Cohort of 4 created that week; 2 still active a week later.
    for (const agentTaskId of ['ca1', 'ca2']) {
      await prisma.agentCohortWeek.create({
        data: {
          organizationId: orgId, agentTaskId: `${suffix}-${agentTaskId}`,
          cohortWeek: WEEK, activeWeek: new Date('2026-06-08T00:00:00Z'),
        },
      })
    }
  })

  after(async () => {
    // Cascade takes adoption_weeks and agent_cohort_weeks with the org.
    await prisma.organization.delete({ where: { id: orgId } }).catch(() => {})
    await operator?.cleanup()
  })

  test('derives ratios and never divides by zero', async () => {
    const body = await report()

    const row = body.byOrg.find((entry: any) => entry.organizationId === orgId)
    assert.ok(row, 'seeded org must appear in byOrg')
    assert.equal(row.execTotal, 10)
    // 10 total, 4 manual -> 6/10 automated.
    assert.equal(row.automationRatio, 0.6)
    assert.equal(row.acceptanceRate, 0.8)
    assert.equal(row.depthBucket, '2-4')
  })

  test('survival reports the cohort denominator, not just the survivors', async () => {
    const body = await report()

    const cohort = body.survival.find((c: any) => c.cohortWeek === '2026-06-01')
    assert.ok(cohort, 'expected the seeded cohort')
    // Other suites may seed the same week, so assert the invariant rather than
    // an absolute: survivors can never exceed the cohort that created them.
    assert.ok(cohort.size >= 4)
    assert.ok(cohort.cells[1].active >= 2)
    assert.ok(cohort.cells[1].active <= cohort.size)
    assert.ok(cohort.cells[1].rate <= 1)
  })

  test('excludes the in-progress week', async () => {
    const body = await report()

    const currentWeekKey = (() => {
      const now = new Date()
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
      const dow = d.getUTCDay()
      d.setUTCDate(d.getUTCDate() - (dow === 0 ? 6 : dow - 1))
      return d.toISOString().slice(0, 10)
    })()

    assert.equal(
      body.weeks.some((w: any) => w.weekStart === currentWeekKey), false,
      'a partial week renders as a dip and must never be shown',
    )
  })
}
