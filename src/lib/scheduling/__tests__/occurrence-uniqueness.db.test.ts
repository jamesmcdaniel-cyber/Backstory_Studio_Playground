import { test, before } from 'node:test'
import assert from 'node:assert/strict'

/**
 * The regression these guard: duplicate-occurrence protection was `blocksSchedule`
 * — a read-then-act check on the newest run. Two concurrent ticks (a Vercel
 * retry, an operator hitting the endpoint, or now the worker and cron planes
 * overlapping) both observed "no active run" and both dispatched. Nothing in
 * the database could reject the second.
 *
 * Flows get a new (flowId, scheduledFor) unique index. Agents reuse the
 * EXISTING @@unique([organizationId, idempotencyKey]) that signal-triggered
 * runs already use, so they need no migration.
 */

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  const ids: Record<string, string> = {}

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))

    const stamp = Date.now()
    const org = await prisma.organization.create({ data: { name: 'Occur', slug: `occur-${stamp}` } })
    ids.org = org.id
    const user = await prisma.user.create({
      data: {
        supabaseId: crypto.randomUUID(),
        email: `occur-${stamp}@example.com`,
        name: 'O',
        organizationId: org.id,
      },
    })
    ids.user = user.id
    const flow = await prisma.flow.create({
      data: { name: 'Occur flow', organizationId: org.id, userId: user.id, graph: { nodes: [], edges: [] } },
    })
    ids.flow = flow.id
    const agent = await prisma.agentTask.create({
      data: {
        organizationId: org.id,
        userId: user.id,
        agentType: 'research',
        objective: 'x',
        description: 'x',
        status: 'ACTIVE',
        schedule: { type: 'daily', time: '09:00', timezone: 'UTC', isActive: true },
      },
    })
    ids.agent = agent.id
  })

  test('two dispatches of one flow occurrence create exactly one run', async () => {
    const scheduledFor = new Date('2026-08-11T09:00:00.000Z')
    const create = () =>
      prisma.flowRun.create({
        data: {
          flowId: ids.flow,
          organizationId: ids.org,
          userId: ids.user,
          trigger: { type: 'schedule' },
          scheduledFor,
        },
      })
    const results = await Promise.allSettled([create(), create()])
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1)
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult
    assert.equal(rejected.reason.code, 'P2002')
    const rows = await prisma.flowRun.findMany({ where: { flowId: ids.flow, organizationId: ids.org, scheduledFor } })
    assert.equal(rows.length, 1)
  })

  test('different occurrences of the same flow both create runs', async () => {
    const mk = (iso: string) =>
      prisma.flowRun.create({
        data: {
          flowId: ids.flow,
          organizationId: ids.org,
          userId: ids.user,
          trigger: { type: 'schedule' },
          scheduledFor: new Date(iso),
        },
      })
    await mk('2026-08-11T10:00:00.000Z')
    await mk('2026-08-11T11:00:00.000Z')
    const rows = await prisma.flowRun.findMany({
      where: { flowId: ids.flow, organizationId: ids.org, scheduledFor: { not: null } },
    })
    assert.ok(rows.length >= 3)
  })

  test('unscheduled runs are exempt — many nulls coexist on one flow', async () => {
    for (let i = 0; i < 3; i += 1) {
      await prisma.flowRun.create({
        data: { flowId: ids.flow, organizationId: ids.org, userId: ids.user, trigger: { type: 'manual' } },
      })
    }
    const rows = await prisma.flowRun.findMany({
      where: { flowId: ids.flow, organizationId: ids.org, scheduledFor: null },
    })
    assert.ok(rows.length >= 3, 'Postgres treats NULLs as distinct, so interactive runs never collide')
  })

  test('two dispatches of one agent occurrence create exactly one execution', async () => {
    const key = `schedule:${ids.agent}:2026-08-11T09:00:00.000Z`
    const create = () =>
      prisma.agentExecution.create({
        data: {
          agentType: 'research',
          agentTaskId: ids.agent,
          status: 'pending',
          input: { prompt: 'x' },
          trigger: { type: 'schedule' },
          userId: ids.user,
          organizationId: ids.org,
          idempotencyKey: key,
        },
      })
    const results = await Promise.allSettled([create(), create()])
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1)
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult
    assert.equal(rejected.reason.code, 'P2002')
  })

  test('agent runs without an idempotency key are exempt', async () => {
    for (let i = 0; i < 3; i += 1) {
      await prisma.agentExecution.create({
        data: {
          agentType: 'research',
          agentTaskId: ids.agent,
          status: 'pending',
          input: { prompt: 'x' },
          trigger: { type: 'manual' },
          userId: ids.user,
          organizationId: ids.org,
        },
      })
    }
    const rows = await prisma.agentExecution.findMany({
      where: { agentTaskId: ids.agent, organizationId: ids.org, idempotencyKey: null },
    })
    assert.ok(rows.length >= 3)
  })

  test('the agent occurrence key is derived from dueOccurrence, so two ticks agree', async () => {
    const { dueOccurrence } = await import('../due')
    const schedule = { type: 'daily' as const, time: '09:00', cron: '', timezone: 'UTC', isActive: true }
    const a = dueOccurrence(schedule, null, new Date('2026-08-11T09:03:00.000Z'))
    const b = dueOccurrence(schedule, null, new Date('2026-08-11T09:14:00.000Z'))
    assert.equal(
      `schedule:${ids.agent}:${a!.toISOString()}`,
      `schedule:${ids.agent}:${b!.toISOString()}`,
      'two ticks inside one occurrence must build the same key or the constraint never fires',
    )
  })
}
