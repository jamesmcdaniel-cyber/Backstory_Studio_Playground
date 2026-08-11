import { test, before } from 'node:test'
import assert from 'node:assert/strict'

/**
 * The regression these guard: `lastExecutedAt` advances BEFORE
 * dispatchAgentExecution, so when that call threw because no worker was alive,
 * the occurrence was consumed and never retried. The agent simply skipped that
 * run, silently, and the next tick saw a freshly-advanced marker.
 *
 * Advancing first is still correct for a run that RAN and failed — otherwise a
 * broken agent re-fires every tick. Only the HANDOFF failure needs undoing.
 */

// DB-gated: runs only under TEST_DATABASE_URL (CI-mode), like sibling DB tests.
const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  let restoreAgentOccurrence: any
  const ids: Record<string, string> = {}

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    ;({ restoreAgentOccurrence } = await import('../dispatch-tick'))

    const stamp = Date.now()
    const org = await prisma.organization.create({ data: { name: 'Occ', slug: `occ-${stamp}` } })
    ids.org = org.id
    const user = await prisma.user.create({
      data: {
        supabaseId: crypto.randomUUID(),
        email: `occ-${stamp}@example.com`,
        name: 'Occ',
        organizationId: org.id,
      },
    })
    ids.user = user.id
  })

  test('a dispatch-layer failure restores lastExecutedAt and removes the orphan row', async () => {
    const previous = new Date('2026-08-11T09:00:00.000Z')
    const agent = await prisma.agentTask.create({
      data: {
        organizationId: ids.org,
        userId: ids.user,
        agentType: 'research',
        objective: 'test',
        description: 'test',
        status: 'ACTIVE',
        schedule: { type: 'hourly', time: '09:00', timezone: 'UTC', isActive: true },
        lastExecutedAt: previous,
        executionCount: 4,
      },
    })

    // Simulate the tick: advance the marker, create the row, then the handoff throws.
    await prisma.agentTask.update({
      where: { id: agent.id, organizationId: ids.org },
      data: { lastExecutedAt: new Date(), executionCount: { increment: 1 } },
    })
    const execution = await prisma.agentExecution.create({
      data: {
        agentType: 'research',
        agentTaskId: agent.id,
        status: 'pending',
        input: { prompt: 'test' },
        trigger: { type: 'schedule' },
        userId: ids.user,
        organizationId: ids.org,
      },
    })

    await restoreAgentOccurrence({
      agentId: agent.id,
      organizationId: ids.org,
      executionId: execution.id,
      previousLastExecutedAt: previous,
      previousExecutionCount: 4,
    })

    // Scoped read: the tenant guard rejects an unscoped findUnique.
    const after = await prisma.agentTask.findFirst({ where: { id: agent.id, organizationId: ids.org } })
    assert.equal(after.lastExecutedAt.toISOString(), previous.toISOString())
    assert.equal(after.executionCount, 4)
    // The never-started pending row is noise, not history — and leaving it would
    // strand the reaper, which would later mark it "exceeded time limit".
    assert.equal(
      await prisma.agentExecution.findFirst({ where: { id: execution.id, organizationId: ids.org } }),
      null,
    )
  })

  test('restoring a never-run agent puts lastExecutedAt back to null', async () => {
    const agent = await prisma.agentTask.create({
      data: {
        organizationId: ids.org,
        userId: ids.user,
        agentType: 'research',
        objective: 'fresh',
        description: 'fresh',
        status: 'ACTIVE',
        schedule: { type: 'hourly', time: '09:00', timezone: 'UTC', isActive: true },
        lastExecutedAt: new Date(),
        executionCount: 1,
      },
    })

    await restoreAgentOccurrence({
      agentId: agent.id,
      organizationId: ids.org,
      executionId: null,
      previousLastExecutedAt: null,
      previousExecutionCount: 0,
    })

    // Scoped read: the tenant guard rejects an unscoped findUnique.
    const after = await prisma.agentTask.findFirst({ where: { id: agent.id, organizationId: ids.org } })
    assert.equal(after.lastExecutedAt, null)
    assert.equal(after.executionCount, 0)
  })

  test('a restore failure never throws at the tick', async () => {
    await assert.doesNotReject(
      restoreAgentOccurrence({
        agentId: 'does-not-exist',
        organizationId: ids.org,
        executionId: 'also-missing',
        previousLastExecutedAt: null,
        previousExecutionCount: 0,
      }),
    )
  })
}
