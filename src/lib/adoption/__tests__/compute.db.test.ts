import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

/**
 * The rollup job against a real database.
 *
 * Runs concurrently against a shared CI-mode database, so every assertion is
 * scoped to organizations this suite created. Absolute global counts are flaky
 * by construction here — sibling suites leave residue.
 *
 * The load-bearing cases: the job must be idempotent (it re-runs daily over
 * the same window, so a second pass must not double anything), demo orgs must
 * be excluded (their history is canned, not real), and an agent that never ran
 * must still land in its cohort denominator.
 */
const TEST_DB = process.env.TEST_DATABASE_URL
if (!TEST_DB) test('adoption rollup (skipped: TEST_DATABASE_URL not set)', { skip: true }, () => {})

if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'test-key'

  let prisma: any
  let rollupWeek: (weekStart: Date) => Promise<{ organizations: number }>
  let realOrgId: string
  let demoOrgId: string
  let userId: string

  // A Monday well in the past, so no sibling suite's fresh rows land in it.
  const WEEK = new Date('2026-06-01T00:00:00Z')
  const inWeek = (dayOffset: number) =>
    new Date(WEEK.getTime() + dayOffset * 24 * 60 * 60 * 1000 + 3600_000)

  before(async () => {
    ;({ systemPrisma: prisma } = await import('@/lib/prisma'))
    ;({ rollupWeek } = await import('@/lib/adoption/compute'))

    const suffix = crypto.randomUUID().slice(0, 8)
    const realOrg = await prisma.organization.create({
      data: { name: `adoption-real-${suffix}`, slug: `adoption-real-${suffix}` },
    })
    const demoOrg = await prisma.organization.create({
      data: { name: `adoption-demo-${suffix}`, slug: `adoption-demo-${suffix}`, kind: 'demo' },
    })
    realOrgId = realOrg.id
    demoOrgId = demoOrg.id

    // supabaseId is REQUIRED and @unique @db.Uuid — omitting it fails the
    // create with a missing-argument error, not a null.
    const user = await prisma.user.create({
      data: {
        supabaseId: crypto.randomUUID(),
        email: `adoption-${suffix}@example.test`,
        organizationId: realOrgId,
      },
    })
    userId = user.id

    // Two agents created in the window; only ONE of them ever runs.
    const ran = await prisma.agentTask.create({
      data: {
        organizationId: realOrgId, userId, description: 'ran', objective: 'o',
        createdAt: inWeek(0),
      },
    })
    await prisma.agentTask.create({
      data: {
        organizationId: realOrgId, userId, description: 'never ran', objective: 'o',
        createdAt: inWeek(0),
      },
    })

    // 3 executions: 2 manual, 1 scheduled -> automation ratio 1/3.
    //
    // One is deliberately `failed`. Activity counts runs of ANY status: an
    // agent someone keeps re-running despite failures is still an agent in
    // use, and success rate is a separate question already answered by
    // /api/agents/kpis. Seeding only successes would let a status filter creep
    // in unnoticed.
    const seeded = [
      { trigger: { type: 'manual' }, status: 'completed' },
      { trigger: { type: 'manual' }, status: 'failed' },
      { trigger: { type: 'schedule' }, status: 'completed' },
    ]
    for (const { trigger, status } of seeded) {
      await prisma.agentExecution.create({
        data: {
          organizationId: realOrgId, userId, agentTaskId: ran.id, agentType: 'CUSTOM',
          status, input: {}, trigger, startedAt: inWeek(1),
        },
      })
    }

    // A demo-org agent + execution that must NOT appear anywhere.
    const demoUser = await prisma.user.create({
      data: {
        supabaseId: crypto.randomUUID(),
        email: `adoption-demo-${suffix}@example.test`,
        organizationId: demoOrgId,
      },
    })
    const demoAgent = await prisma.agentTask.create({
      data: {
        organizationId: demoOrgId, userId: demoUser.id, description: 'demo', objective: 'o',
        createdAt: inWeek(0),
      },
    })
    await prisma.agentExecution.create({
      data: {
        organizationId: demoOrgId, userId: demoUser.id, agentTaskId: demoAgent.id,
        agentType: 'CUSTOM', status: 'completed', input: {}, trigger: { type: 'manual' },
        startedAt: inWeek(1),
      },
    })

    await prisma.approvalRequest.create({
      data: {
        organizationId: realOrgId, executionId: 'exec-x', tool: 'send_email', summary: 's',
        payload: {}, status: 'approved', decidedById: userId,
        createdAt: inWeek(2), decidedAt: new Date(inWeek(2).getTime() + 60_000),
      },
    })
  })

  after(async () => {
    // Org delete cascades to agents, executions, approvals and both rollup
    // tables, so the shared CI-mode database keeps no residue from this suite.
    for (const id of [realOrgId, demoOrgId]) {
      await prisma.organization.delete({ where: { id } }).catch(() => {})
    }
  })

  test('rolls the week up into one row per real organization', async () => {
    await rollupWeek(WEEK)

    const row = await prisma.adoptionWeek.findUnique({
      where: { organizationId_weekStart: { organizationId: realOrgId, weekStart: WEEK } },
    })
    assert.ok(row, 'expected a rollup row for the seeded org')
    assert.equal(row.agentsCreated, 2)
    assert.equal(row.execTotal, 3)
    assert.equal(row.execManual, 2)
    assert.deepEqual(row.execByTrigger, { manual: 2, schedule: 1 })
    assert.equal(row.engagedUsers, 1)
    assert.equal(row.approvalsApproved, 1)
    assert.equal(row.approvalsRejected, 0)
    assert.ok(row.approvalLatencyMedianMs !== null && row.approvalLatencyMedianMs >= 59_000)
  })

  test('excludes demo organizations entirely', async () => {
    await rollupWeek(WEEK)
    const row = await prisma.adoptionWeek.findUnique({
      where: { organizationId_weekStart: { organizationId: demoOrgId, weekStart: WEEK } },
    })
    assert.equal(row, null, 'demo org history is canned and must never be rolled up')
  })

  test('is idempotent -- a second pass changes no counts', async () => {
    await rollupWeek(WEEK)
    const first = await prisma.adoptionWeek.findUnique({
      where: { organizationId_weekStart: { organizationId: realOrgId, weekStart: WEEK } },
    })
    const cohortsFirst = await prisma.agentCohortWeek.count({ where: { organizationId: realOrgId } })

    await rollupWeek(WEEK)
    const second = await prisma.adoptionWeek.findUnique({
      where: { organizationId_weekStart: { organizationId: realOrgId, weekStart: WEEK } },
    })
    const cohortsSecond = await prisma.agentCohortWeek.count({ where: { organizationId: realOrgId } })

    assert.equal(second.execTotal, first.execTotal)
    assert.equal(second.agentsCreated, first.agentsCreated)
    assert.equal(cohortsSecond, cohortsFirst, 'cohort rows must not duplicate on re-run')
  })

  test('writes a cohort row only for the agent that actually ran', async () => {
    await rollupWeek(WEEK)
    const rows = await prisma.agentCohortWeek.findMany({ where: { organizationId: realOrgId } })
    assert.equal(rows.length, 1, 'the never-run agent must not get an active-week row')
    assert.equal(rows[0].cohortWeek.toISOString().slice(0, 10), '2026-06-01')
    assert.equal(rows[0].activeWeek.toISOString().slice(0, 10), '2026-06-01')
  })

  // MUST run last: it mutates agentsDeleted, which the idempotency test above
  // asserts against. node:test runs a file's tests in declaration order.
  test('a soft-deleted agent keeps its cohort history and is counted as deleted', async () => {
    await prisma.agentTask.updateMany({
      where: { organizationId: realOrgId, description: 'ran' },
      data: { status: 'DELETED', deletedAt: inWeek(3) },
    })
    await rollupWeek(WEEK)

    const row = await prisma.adoptionWeek.findUnique({
      where: { organizationId_weekStart: { organizationId: realOrgId, weekStart: WEEK } },
    })
    assert.equal(row.agentsDeleted, 1)
    // Still 2: deletion is soft, so createdAt survives and the cohort
    // denominator does not shrink when an agent is abandoned.
    assert.equal(row.agentsCreated, 2)

    const rows = await prisma.agentCohortWeek.findMany({ where: { organizationId: realOrgId } })
    assert.equal(rows.length, 1, 'cohort history must survive the agent being deleted')
  })
}
