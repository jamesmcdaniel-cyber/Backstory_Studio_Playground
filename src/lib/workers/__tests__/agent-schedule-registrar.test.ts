import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { registerAgentSchedules, repeatFor, type ScheduleRegistrarDeps } from '../agent-schedule-registrar'

/**
 * Schedule reconciliation is the worker's other job, and it fails silently: a
 * cadence that stops translating produces no error, just an agent that never
 * runs again. These tests drive it with the DB and queue edges stubbed.
 */

describe('repeatFor', () => {
  test('a raw cron pattern passes through with its timezone', () => {
    assert.deepEqual(repeatFor({ type: 'cron', cron: '*/5 * * * *', timezone: 'America/New_York' }), {
      pattern: '*/5 * * * *',
      tz: 'America/New_York',
    })
  })

  test('hourly is top of the hour', () => {
    assert.deepEqual(repeatFor({ type: 'hourly' }), { pattern: '0 * * * *', tz: 'UTC' })
  })

  test('daily uses the stored time', () => {
    assert.deepEqual(repeatFor({ type: 'daily', time: '14:30' }), { pattern: '30 14 * * *', tz: 'UTC' })
  })

  test('weekly pins Monday', () => {
    assert.deepEqual(repeatFor({ type: 'weekly', time: '07:15' }), { pattern: '15 7 * * 1', tz: 'UTC' })
  })

  test('leading zeros are normalised away, not emitted into the pattern', () => {
    // '09:05' must not become '05 09 * * *' — cron tolerates it, but the stored
    // value is user-entered and Number() is what keeps it canonical.
    assert.deepEqual(repeatFor({ type: 'daily', time: '09:05' }), { pattern: '5 9 * * *', tz: 'UTC' })
  })

  test('a missing time falls back to 09:00', () => {
    assert.deepEqual(repeatFor({ type: 'daily' }), { pattern: '0 9 * * *', tz: 'UTC' })
  })

  test('an absent timezone defaults to UTC', () => {
    assert.equal(repeatFor({ type: 'hourly', timezone: '' })?.tz, 'UTC')
  })

  test('cron type with no expression yields no schedule', () => {
    assert.equal(repeatFor({ type: 'cron' }), null)
  })

  test('an unknown or absent type yields no schedule', () => {
    assert.equal(repeatFor({ type: 'fortnightly' }), null)
    assert.equal(repeatFor({}), null)
  })
})

interface Recorded {
  removed: string[]
  upserted: { id: string; repeat: unknown; job: any }[]
  closed: boolean
}

function harness(agents: any[], users: any[] = [], upsertFails = new Set<string>()) {
  const recorded: Recorded = { removed: [], upserted: [], closed: false }
  const deps: ScheduleRegistrarDeps = {
    agents: { findMany: async () => agents },
    users: {
      findFirst: async (args: any) => {
        const where = args.where ?? {}
        const matches = users.filter(
          (user) =>
            (where.id === undefined || user.id === where.id) &&
            (where.organizationId === undefined || user.organizationId === where.organizationId) &&
            (where.isActive === undefined || user.isActive === where.isActive),
        )
        if (args.orderBy?.createdAt === 'asc') {
          matches.sort((a, b) => Number(a.createdAt) - Number(b.createdAt))
        }
        return matches[0] ?? null
      },
    },
    queue: () => ({
      removeJobScheduler: async (id) => { recorded.removed.push(id) },
      upsertJobScheduler: async (id, repeat, job) => {
        if (upsertFails.has(id)) throw new Error('invalid cron expression')
        recorded.upserted.push({ id, repeat, job })
      },
      close: async () => { recorded.closed = true },
    }),
  }
  return { deps, recorded }
}

const agent = (over: Record<string, unknown> = {}) => ({
  id: 'a1',
  organizationId: 'org-1',
  userId: null,
  objective: 'do the thing',
  status: 'ACTIVE',
  schedule: { type: 'daily', time: '09:00', isActive: true },
  ...over,
})

const user = (over: Record<string, unknown> = {}) => ({
  id: 'u1',
  organizationId: 'org-1',
  isActive: true,
  createdAt: new Date('2020-01-01'),
  ...over,
})

describe('registerAgentSchedules', () => {
  test('an active, scheduled agent is registered with its owner and objective', async () => {
    const { deps, recorded } = harness([agent({ userId: 'u1' })], [user()])

    assert.deepEqual(await registerAgentSchedules(deps), { registered: 1, failed: 0 })
    assert.equal(recorded.upserted.length, 1)
    assert.equal(recorded.upserted[0].id, 'agent:a1')
    assert.deepEqual(recorded.upserted[0].repeat, { pattern: '0 9 * * *', tz: 'UTC' })
    assert.equal(recorded.upserted[0].job.name, 'execute-scheduled-agent')
    assert.deepEqual(recorded.upserted[0].job.data, {
      agentId: 'a1',
      organizationId: 'org-1',
      userId: 'u1',
      input: 'do the thing',
    })
  })

  test('a paused agent has its scheduler REMOVED, not left behind', async () => {
    // The bug this guards: flipping an agent inactive without removing the
    // scheduler leaves it firing forever off a row nobody looks at again.
    const { deps, recorded } = harness([agent({ status: 'PAUSED' })], [user()])

    assert.deepEqual(await registerAgentSchedules(deps), { registered: 0, failed: 0 })
    assert.deepEqual(recorded.removed, ['agent:a1'])
    assert.deepEqual(recorded.upserted, [])
  })

  test('an ACTIVE agent whose schedule is switched off is also removed', async () => {
    const { deps, recorded } = harness([agent({ schedule: { type: 'daily', isActive: false } })], [user()])

    await registerAgentSchedules(deps)

    assert.deepEqual(recorded.removed, ['agent:a1'])
  })

  test('an untranslatable schedule is removed rather than guessed at', async () => {
    const { deps, recorded } = harness([agent({ schedule: { type: 'cron', isActive: true } })], [user()])

    await registerAgentSchedules(deps)

    assert.deepEqual(recorded.removed, ['agent:a1'])
    assert.deepEqual(recorded.upserted, [])
  })

  test('an ownerless agent runs as the org’s oldest active member', async () => {
    const { deps, recorded } = harness(
      [agent({ userId: null })],
      [
        user({ id: 'newer', createdAt: new Date('2024-01-01') }),
        user({ id: 'oldest', createdAt: new Date('2019-01-01') }),
      ],
    )

    await registerAgentSchedules(deps)

    assert.equal(recorded.upserted[0].job.data.userId, 'oldest')
  })

  test('a deactivated owner falls back to another active member', async () => {
    const { deps, recorded } = harness(
      [agent({ userId: 'gone' })],
      [user({ id: 'still-here', createdAt: new Date('2021-01-01') })],
    )

    await registerAgentSchedules(deps)

    assert.equal(recorded.upserted[0].job.data.userId, 'still-here')
  })

  test('an org with no active member registers nothing and is not counted failed', async () => {
    const { deps, recorded } = harness([agent()], [])

    assert.deepEqual(await registerAgentSchedules(deps), { registered: 0, failed: 0 })
    assert.deepEqual(recorded.upserted, [])
  })

  test('one bad agent does not stop the rest of the fleet reconciling', async () => {
    const { deps, recorded } = harness(
      [agent({ id: 'bad' }), agent({ id: 'good' })],
      [user()],
      new Set(['agent:bad']),
    )

    assert.deepEqual(await registerAgentSchedules(deps), { registered: 1, failed: 1 })
    assert.deepEqual(recorded.upserted.map((entry) => entry.id), ['agent:good'])
  })

  test('the queue connection is closed even when reconciliation throws', async () => {
    const { deps, recorded } = harness([])
    deps.agents.findMany = async () => [agent()]
    deps.users.findFirst = async () => { throw new Error('db down') }

    // The per-agent catch absorbs it, but the finally is what must hold: a
    // leaked Queue keeps a Redis client open on every 60s reconciliation.
    await registerAgentSchedules(deps)

    assert.equal(recorded.closed, true)
  })

  test('the queue is closed on a clean pass too', async () => {
    const { deps, recorded } = harness([agent({ userId: 'u1' })], [user()])
    await registerAgentSchedules(deps)
    assert.equal(recorded.closed, true)
  })
})
