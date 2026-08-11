import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isDue, dueOccurrence, type AgentSchedule } from '../due'

/**
 * `dueOccurrence` answers WHICH occurrence is owed, where `isDue` answers only
 * WHETHER one is. Its value becomes FlowRun.scheduledFor and the agent
 * idempotency key, so two concurrent ticks that both see the same owed
 * occurrence must compute the SAME instant — that is what lets the unique index
 * reject the second instead of producing a duplicate run.
 *
 * Lives in its own file: due.test.ts is 43.3KB and a test file crossing ~45KB
 * hangs tsx+node22 forever at module load.
 */

const base: AgentSchedule = { type: 'daily', time: '09:00', cron: '', timezone: 'UTC', isActive: true }

test("daily returns today's scheduled instant in the schedule timezone", () => {
  const now = new Date('2026-08-11T13:00:00.000Z')
  const at = dueOccurrence(base, null, now)
  assert.equal(at?.toISOString(), '2026-08-11T09:00:00.000Z')
})

test('daily is stable across two ticks in the same day — the dedupe property', () => {
  const a = dueOccurrence(base, null, new Date('2026-08-11T09:01:00.000Z'))
  const b = dueOccurrence(base, null, new Date('2026-08-11T09:14:00.000Z'))
  assert.equal(a?.toISOString(), b?.toISOString())
})

test('cron returns the latest matching minute in the window, not the tick time', () => {
  const schedule: AgentSchedule = { ...base, type: 'cron', cron: '0 9 * * *' }
  const at = dueOccurrence(schedule, null, new Date('2026-08-11T13:07:00.000Z'))
  assert.equal(at?.toISOString(), '2026-08-11T09:00:00.000Z')
})

test('every15min cron: two ticks inside one 15-minute slot agree', () => {
  const schedule: AgentSchedule = { ...base, type: 'cron', cron: '*/15 * * * *' }
  const last = new Date('2026-08-11T09:00:00.000Z')
  const a = dueOccurrence(schedule, last, new Date('2026-08-11T09:16:00.000Z'))
  const b = dueOccurrence(schedule, last, new Date('2026-08-11T09:29:00.000Z'))
  assert.equal(a?.toISOString(), '2026-08-11T09:15:00.000Z')
  assert.equal(b?.toISOString(), '2026-08-11T09:15:00.000Z')
})

test('hourly uses the hour-floor of now — documented approximation, stable across ticks', () => {
  const schedule: AgentSchedule = { ...base, type: 'hourly' }
  const last = new Date('2026-08-11T08:00:00.000Z')
  const a = dueOccurrence(schedule, last, new Date('2026-08-11T09:01:00.000Z'))
  const b = dueOccurrence(schedule, last, new Date('2026-08-11T09:59:00.000Z'))
  assert.equal(a?.toISOString(), '2026-08-11T09:00:00.000Z')
  assert.equal(b?.toISOString(), '2026-08-11T09:00:00.000Z')
})

test('once returns the target instant', () => {
  const schedule: AgentSchedule = { ...base, type: 'once', runAt: '2026-08-11', time: '09:00' }
  const at = dueOccurrence(schedule, null, new Date('2026-08-11T10:00:00.000Z'))
  assert.equal(at?.toISOString(), '2026-08-11T09:00:00.000Z')
})

test('manual and inactive schedules never have an occurrence', () => {
  assert.equal(dueOccurrence({ ...base, type: 'manual' }, null, new Date()), null)
  assert.equal(dueOccurrence({ ...base, isActive: false }, null, new Date()), null)
})

test('a schedule that is not yet due has no occurrence', () => {
  // 08:00 UTC is before the 09:00 daily slot.
  assert.equal(dueOccurrence(base, null, new Date('2026-08-11T08:00:00.000Z')), null)
})

test('DST spring-forward: a daily 09:00 America/New_York resolves to one real instant', () => {
  const schedule: AgentSchedule = { ...base, timezone: 'America/New_York' }
  const at = dueOccurrence(schedule, null, new Date('2026-03-08T18:00:00.000Z'))
  assert.equal(at?.toISOString(), '2026-03-08T13:00:00.000Z')
})

test('half-hour zone: Asia/Kolkata daily 09:00 resolves correctly', () => {
  const schedule: AgentSchedule = { ...base, timezone: 'Asia/Kolkata' }
  const at = dueOccurrence(schedule, null, new Date('2026-08-11T12:00:00.000Z'))
  assert.equal(at?.toISOString(), '2026-08-11T03:30:00.000Z')
})

test('PROPERTY: dueOccurrence is non-null exactly when isDue is true', () => {
  const schedules: AgentSchedule[] = [
    { ...base },
    { ...base, type: 'hourly' },
    { ...base, type: 'weekly' },
    { ...base, type: 'cron', cron: '0 9 * * *' },
    { ...base, type: 'cron', cron: '*/15 * * * *' },
    { ...base, type: 'cron', cron: '30 8 * * 1,3,5' },
    { ...base, type: 'once', runAt: '2026-08-11' },
    { ...base, type: 'manual' },
    { ...base, isActive: false },
    { ...base, timezone: 'America/New_York' },
    { ...base, timezone: 'Asia/Kolkata' },
  ]
  const lasts = [null, new Date('2026-08-10T09:00:00.000Z'), new Date('2026-08-11T08:59:00.000Z')]
  const nows = [
    new Date('2026-08-11T08:59:00.000Z'),
    new Date('2026-08-11T09:00:00.000Z'),
    new Date('2026-08-11T09:16:00.000Z'),
    new Date('2026-08-11T23:59:00.000Z'),
    new Date('2026-03-08T13:00:00.000Z'),
  ]
  for (const schedule of schedules) {
    for (const last of lasts) {
      for (const now of nows) {
        const due = isDue(schedule, last, now)
        const at = dueOccurrence(schedule, last, now)
        assert.equal(
          at !== null,
          due,
          `mismatch: ${JSON.stringify(schedule)} last=${last?.toISOString() ?? 'null'} now=${now.toISOString()} isDue=${due} at=${at?.toISOString() ?? 'null'}`,
        )
      }
    }
  }
})
