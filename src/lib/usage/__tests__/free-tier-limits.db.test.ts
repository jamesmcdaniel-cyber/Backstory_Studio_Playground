import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

/**
 * The counting half of the daily ceilings — what the pure rule tests cannot
 * cover. Proves the count is scoped to ONE person in ONE workspace and to
 * today, and that a super admin is never blocked.
 */
const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  let checkDailyRunAllowance: any
  let seeded: any
  let neighbour: any
  let agentId: string

  const runAt = async (organizationId: string, userId: string, startedAt: Date) =>
    prisma.agentExecution.create({
      data: {
        agentType: 'general',
        agentTaskId: agentId,
        status: 'completed',
        input: {},
        trigger: { type: 'manual' },
        organizationId,
        userId,
        startedAt,
      },
    })

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    ;({ checkDailyRunAllowance } = await import('../free-tier-limits'))
    const { seedTestOrg } = await import('@/lib/server/__tests__/test-auth')
    seeded = await seedTestOrg(prisma)
    neighbour = await seedTestOrg(prisma)
    const agent = await prisma.agentTask.create({
      data: {
        description: 'Limit fixture',
        objective: 'count runs',
        agentType: 'general',
        status: 'ACTIVE',
        organizationId: seeded.organizationId,
        userId: seeded.userId,
      },
    })
    agentId = agent.id
  })

  after(async () => {
    if (neighbour) await neighbour.cleanup()
    if (seeded) await seeded.cleanup()
  })

  const actor = (extra: Record<string, unknown> = {}) => ({
    organizationId: seeded.organizationId,
    userId: seeded.userId,
    canReview: false,
    email: 'member@customer.example',
    ...extra,
  })

  // The daily run caps were lifted for every user on 2026-11-17: the run
  // ceilings are null, so no number of runs refuses anyone.
  test('a member is never refused, however many runs they start in a day', async () => {
    for (let i = 0; i < 12; i++) await runAt(seeded.organizationId, seeded.userId, new Date())
    const agents = await checkDailyRunAllowance('agent', actor())
    assert.equal(agents.over, false, 'twelve runs in a day — more than twice the old cap — still allowed')
    const flows = await checkDailyRunAllowance('flow', actor())
    assert.equal(flows.over, false)
  })

  test('a super admin is never blocked either', async () => {
    assert.equal((await checkDailyRunAllowance('agent', actor({ canReview: true }))).over, false)
    assert.equal((await checkDailyRunAllowance('agent', actor({ email: 'james.mcdaniel@backstory.ai' }))).over, false)
  })
}
