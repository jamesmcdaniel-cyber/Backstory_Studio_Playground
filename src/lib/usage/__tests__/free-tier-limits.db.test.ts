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

  test('a member is allowed up to the ceiling and refused at it', async () => {
    const before = await checkDailyRunAllowance('agent', actor())
    assert.equal(before.over, false)
    assert.equal(before.used, 0)
    assert.equal(before.limit, 5)

    for (let i = 0; i < 4; i++) await runAt(seeded.organizationId, seeded.userId, new Date())
    const under = await checkDailyRunAllowance('agent', actor())
    assert.equal(under.used, 4)
    assert.equal(under.over, false, 'the fifth run must still be allowed')

    await runAt(seeded.organizationId, seeded.userId, new Date())
    const at = await checkDailyRunAllowance('agent', actor())
    assert.equal(at.used, 5)
    assert.equal(at.over, true, 'the sixth run must be refused')
  })

  test('yesterday does not count against today', async () => {
    const yesterday = new Date(Date.now() - 26 * 60 * 60 * 1000)
    await runAt(neighbour.organizationId, neighbour.userId, yesterday)
    const result = await checkDailyRunAllowance('agent', {
      organizationId: neighbour.organizationId,
      userId: neighbour.userId,
      canReview: false,
      email: 'other@customer.example',
    })
    assert.equal(result.used, 0)
    assert.equal(result.over, false)
  })

  test("one person's runs do not consume another's allowance", async () => {
    // `seeded` is already at its ceiling from the first test.
    const mine = await checkDailyRunAllowance('agent', actor())
    assert.equal(mine.over, true)

    const theirs = await checkDailyRunAllowance('agent', {
      organizationId: neighbour.organizationId,
      userId: neighbour.userId,
      canReview: false,
      email: 'other@customer.example',
    })
    assert.equal(theirs.over, false)
  })

  test('a super admin is never blocked, however many runs they have started', async () => {
    const reviewer = await checkDailyRunAllowance('agent', actor({ canReview: true }))
    assert.equal(reviewer.over, false)

    const owner = await checkDailyRunAllowance('agent', actor({ email: 'james.mcdaniel@backstory.ai' }))
    assert.equal(owner.over, false)
  })

  test('flow runs are counted separately from agent runs', async () => {
    // The agent ceiling is already reached; the flow allowance is untouched.
    const flows = await checkDailyRunAllowance('flow', actor())
    assert.equal(flows.used, 0)
    assert.equal(flows.over, false)
  })
}
