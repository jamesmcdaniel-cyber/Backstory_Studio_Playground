import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { registerAgentSchedules, repeatFor, type ScheduleRegistrarDeps } from '../agent-schedule-registrar'
import { attributeOwners } from '@/lib/scheduling/owners'

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

function harness(
  agents: any[],
  users: any[] = [],
  upsertFails = new Set<string>(),
  options: { schedulers?: string[]; existing?: string[] } = {},
) {
  const recorded: Recorded = { removed: [], upserted: [], closed: false }
  const deps: ScheduleRegistrarDeps = {
    agents: {
      findMany: async () => agents,
      existingIds: async (ids) => ids.filter((id) => (options.existing ?? []).includes(id)),
    },
    // The real rule, fed from the fixture — what resolveRunOwners does with
    // its two queries (explicit owners unfiltered, members active + oldest-first).
    owners: async (candidates) => {
      const explicitIds = new Set(candidates.map((c) => c.userId).filter(Boolean))
      const members = users
        .filter((u) => u.isActive)
        .sort((a, b) => Number(a.createdAt) - Number(b.createdAt))
      return attributeOwners(candidates, users.filter((u) => explicitIds.has(u.id)), members)
    },
    queue: () => ({
      removeJobScheduler: async (id) => { recorded.removed.push(id) },
      upsertJobScheduler: async (id, repeat, job) => {
        if (upsertFails.has(id)) throw new Error('invalid cron expression')
        recorded.upserted.push({ id, repeat, job })
      },
      ...(options.schedulers ? { getJobSchedulers: async () => options.schedulers!.map((key) => ({ key })) } : {}),
      close: async () => { recorded.closed = true },
    }),
  }
  return { deps, recorded }
}

const agent = (over: Record<string, unknown> = {}) => ({
  id: 'a1',
  organizationId: 'org-1',
  userId: null,
  description: 'agent',
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

  test('a quarantined agent has its scheduler removed — it never fires as another member', async () => {
    // Quarantine holds a deprovisioned owner's work until someone claims it;
    // falling back to the oldest member would silently re-own it.
    const { deps, recorded } = harness([agent({ userId: 'gone', quarantinedAt: new Date() })], [user()])

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

  test('an owner id with no user row behind it falls back to another active member', async () => {
    const { deps, recorded } = harness(
      [agent({ userId: 'gone' })],
      [user({ id: 'still-here', createdAt: new Date('2021-01-01') })],
    )

    await registerAgentSchedules(deps)

    assert.equal(recorded.upserted[0].job.data.userId, 'still-here')
  })

  test('a DEACTIVATED owner gets no scheduler — never the oldest member', async () => {
    // The bug: the owner lookup filtered isActive in SQL, so a suspended owner
    // looked absent and the agent re-armed under a colleague.
    const { deps, recorded } = harness(
      [agent({ userId: 'suspended' })],
      [
        user({ id: 'suspended', isActive: false, createdAt: new Date('2022-01-01') }),
        user({ id: 'colleague', createdAt: new Date('2019-01-01') }),
      ],
    )

    assert.deepEqual(await registerAgentSchedules(deps), { registered: 0, failed: 0 })
    assert.deepEqual(recorded.upserted, [])
    assert.deepEqual(recorded.removed, ['agent:a1'])
  })

  test('an owner who moved workspaces falls back to this org’s oldest member', async () => {
    const { deps, recorded } = harness(
      [agent({ userId: 'moved' })],
      [user({ id: 'moved', organizationId: 'org-2' }), user({ id: 'stayed', createdAt: new Date('2021-01-01') })],
    )

    await registerAgentSchedules(deps)

    assert.equal(recorded.upserted[0].job.data.userId, 'stayed')
  })

  test('an org with no active member registers nothing and is not counted failed', async () => {
    const { deps, recorded } = harness([agent()], [])

    assert.deepEqual(await registerAgentSchedules(deps), { registered: 0, failed: 0 })
    assert.deepEqual(recorded.upserted, [])
  })

  test('a published agent arms its PUBLISHED schedule and objective, not the draft', async () => {
    const published = agent({
      userId: 'u1',
      objective: 'draft objective',
      schedule: { type: 'hourly', isActive: true },
      publishedConfig: {
        description: 'agent',
        objective: 'published objective',
        schedule: { type: 'daily', time: '06:30', isActive: true },
      },
    })
    const { deps, recorded } = harness([published], [user()])

    await registerAgentSchedules(deps)

    assert.deepEqual(recorded.upserted[0].repeat, { pattern: '30 6 * * *', tz: 'UTC' })
    assert.equal(recorded.upserted[0].job.data.input, 'published objective')
  })

  test('switching a published agent’s live schedule off still disarms it', async () => {
    const published = agent({
      schedule: { type: 'daily', isActive: false },
      publishedConfig: { description: 'agent', objective: 'x', schedule: { type: 'daily', isActive: true } },
    })
    const { deps, recorded } = harness([published], [user()])

    await registerAgentSchedules(deps)

    assert.deepEqual(recorded.upserted, [])
    assert.deepEqual(recorded.removed, ['agent:a1'])
  })

  test('a demo sandbox’s agents are never armed', async () => {
    const { deps, recorded } = harness([agent({ organization: { kind: 'demo' } })], [user()])

    await registerAgentSchedules(deps)

    assert.deepEqual(recorded.upserted, [])
    assert.deepEqual(recorded.removed, ['agent:a1'])
  })

  test('a scheduler whose agent row is gone is removed; foreign and still-existing ones are kept', async () => {
    const { deps, recorded } = harness([agent({ userId: 'u1' })], [user()], new Set(), {
      schedulers: ['agent:a1', 'agent:deleted', 'agent:created-by-another-worker', 'other:thing'],
      existing: ['created-by-another-worker'],
    })

    await registerAgentSchedules(deps)

    assert.deepEqual(recorded.removed, ['agent:deleted'])
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
    deps.owners = async () => { throw new Error('db down') }

    // The owner-read failure is absorbed (and leaves existing schedulers
    // alone), but the finally is what must hold: a leaked Queue keeps a Redis
    // client open on every 60s reconciliation.
    assert.deepEqual(await registerAgentSchedules(deps), { registered: 0, failed: 1 })

    assert.deepEqual(recorded.removed, [])
    assert.equal(recorded.closed, true)
  })

  test('the queue is closed on a clean pass too', async () => {
    const { deps, recorded } = harness([agent({ userId: 'u1' })], [user()])
    await registerAgentSchedules(deps)
    assert.equal(recorded.closed, true)
  })
})
