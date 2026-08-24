import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { applyScheduleRecompute, computeNextRunAt, isNotScheduled, NOT_SCHEDULED_AT } from '@/lib/scheduling/next-run'
import { isDue } from '@/lib/scheduling/due'

const NOW = new Date('2026-08-23T12:00:00.000Z')

describe('computeNextRunAt', () => {
  it('marks manual and inactive schedules not-scheduled', () => {
    // The population that makes the index worth having: manual agents are the
    // majority of the table, and folding them into NULL would leave the tick
    // reading nearly everything it reads today.
    assert.ok(isNotScheduled(computeNextRunAt({ type: 'manual', isActive: true }, null, NOW)))
    assert.ok(isNotScheduled(computeNextRunAt({ type: 'daily', isActive: false, time: '09:00' }, null, NOW)))
    assert.ok(isNotScheduled(computeNextRunAt(null, null, NOW)))
    assert.ok(isNotScheduled(computeNextRunAt('not an object', null, NOW)))
  })

  it('returns now for a schedule that is due right now', () => {
    // The case that would otherwise skip a window: a forward-looking
    // computation must never push a row that should fire this minute forward.
    const schedule = { type: 'hourly', isActive: true }
    assert.equal(isDue(schedule as never, null, NOW), true)
    assert.equal(computeNextRunAt(schedule, null, NOW).getTime(), NOW.getTime())
  })

  it('never stamps a never-run relative schedule into the future', () => {
    // nextOccurrence has no execution history, so anchoring at `now` would
    // defer a never-run hourly agent by an hour. Anchoring in the past is what
    // keeps it visible to the very next tick.
    const at = computeNextRunAt({ type: 'hourly', isActive: true }, null, NOW)
    assert.ok(at.getTime() <= NOW.getTime(), `${at.toISOString()} should not be in the future`)
  })

  it('schedules an hourly agent an hour after its last run', () => {
    const lastRun = new Date('2026-08-23T11:30:00.000Z')
    const at = computeNextRunAt({ type: 'hourly', isActive: true }, lastRun, NOW)
    assert.equal(at.toISOString(), '2026-08-23T12:30:00.000Z')
  })

  it('agrees with isDue: nothing it defers is due before the instant it names', () => {
    // The safety property the whole design rests on. A too-early stamp costs a
    // wasted read; a too-late one skips a run. This asserts the second never
    // happens for a representative spread of schedules.
    const cases = [
      { schedule: { type: 'daily', isActive: true, time: '09:00', timezone: 'UTC' }, last: new Date('2026-08-23T09:00:00.000Z') },
      { schedule: { type: 'weekly', isActive: true, time: '09:00', timezone: 'UTC' }, last: new Date('2026-08-23T09:00:00.000Z') },
      { schedule: { type: 'cron', isActive: true, cron: '0 * * * *', timezone: 'UTC' }, last: new Date('2026-08-23T11:00:00.000Z') },
    ]
    for (const { schedule, last } of cases) {
      const at = computeNextRunAt(schedule, last, NOW)
      if (isNotScheduled(at)) continue
      // Step through every minute between now and the stamped instant: none of
      // them may be due, or the tick would have skipped a real occurrence.
      for (let t = NOW.getTime(); t < at.getTime(); t += 60_000) {
        assert.equal(
          isDue(schedule as never, last, new Date(t)),
          false,
          `${schedule.type} became due at ${new Date(t).toISOString()} before its stamp ${at.toISOString()}`,
        )
      }
    }
  })

  it('marks a one-time run not-scheduled once it has fired', () => {
    const schedule = { type: 'once', isActive: true, runAt: '2026-08-20', time: '09:00', timezone: 'UTC' }
    const at = computeNextRunAt(schedule, new Date('2026-08-20T09:00:00.000Z'), NOW)
    assert.ok(isNotScheduled(at))
  })
})

describe('applyScheduleRecompute', () => {
  it('nulls nextRunAt when a write touches the schedule', () => {
    const out = applyScheduleRecompute('AgentTask', 'update', { where: { id: 'a1' }, data: { schedule: { type: 'daily' } } })
    assert.equal((out as { data: { nextRunAt: unknown } }).data.nextRunAt, null)
  })

  it('nulls it when a run advances lastExecutedAt', () => {
    const out = applyScheduleRecompute('AgentTask', 'update', { where: { id: 'a1' }, data: { lastExecutedAt: NOW } })
    assert.equal((out as { data: { nextRunAt: unknown } }).data.nextRunAt, null)
  })

  it('covers the flow trigger and publish fields', () => {
    for (const field of ['trigger', 'status', 'publishedGraph', 'pollCursor']) {
      const out = applyScheduleRecompute('Flow', 'update', { where: { id: 'f1' }, data: { [field]: 'x' } })
      assert.equal((out as { data: { nextRunAt: unknown } }).data.nextRunAt, null, field)
    }
  })

  it('leaves an explicit nextRunAt alone — this is how the tick stamps', () => {
    // Without this the tick's own writes would be nulled straight back out, the
    // read set would never shrink, and the index would silently do nothing.
    const stamp = new Date('2026-08-24T00:00:00.000Z')
    const out = applyScheduleRecompute('AgentTask', 'updateMany', { where: { id: { in: ['a1'] } }, data: { nextRunAt: stamp } })
    assert.equal((out as { data: { nextRunAt: Date } }).data.nextRunAt, stamp)
  })

  it('ignores writes that cannot change dueness', () => {
    const args = { where: { id: 'a1' }, data: { description: 'renamed' } }
    assert.equal(applyScheduleRecompute('AgentTask', 'update', args), args)
    const flow = applyScheduleRecompute('Flow', 'update', { data: { name: 'x' } }) as { data: Record<string, unknown> }
    assert.equal(flow.data.nextRunAt, undefined)
  })

  it('ignores reads and unrelated models', () => {
    const args = { where: { status: 'ACTIVE' } }
    assert.equal(applyScheduleRecompute('AgentTask', 'findMany', args), args)
    const other = applyScheduleRecompute('AgentExecution', 'update', { data: { status: 'x' } }) as { data: Record<string, unknown> }
    assert.equal(other.data.nextRunAt, undefined)
  })

  it('handles a createMany array payload', () => {
    const out = applyScheduleRecompute('AgentTask', 'createMany', { data: [{ schedule: { type: 'daily' } }, { description: 'x' }] })
    const rows = (out as { data: Array<Record<string, unknown>> }).data
    assert.equal(rows[0].nextRunAt, null)
    assert.equal('nextRunAt' in rows[1], false)
  })

  it('marks both halves of an upsert', () => {
    const out = applyScheduleRecompute('Flow', 'upsert', {
      where: { id: 'f1' },
      create: { trigger: {} },
      update: { trigger: {} },
    }) as { create: Record<string, unknown>; update: Record<string, unknown> }
    assert.equal(out.create.nextRunAt, null)
    assert.equal(out.update.nextRunAt, null)
  })
})

describe('NOT_SCHEDULED_AT', () => {
  it('is far enough out that no real schedule reaches it', () => {
    assert.ok(NOT_SCHEDULED_AT.getUTCFullYear() > 9000)
    assert.equal(isNotScheduled(null), false)
    assert.equal(isNotScheduled(undefined), false)
    assert.equal(isNotScheduled(NOW), false)
  })
})
