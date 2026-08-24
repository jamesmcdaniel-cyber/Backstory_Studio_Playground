import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  weekStartUtc, addWeeks, weekKey, completeWeeksBack, weekOffset,
  ratio, automationRatio, acceptanceRate, buildSurvival, depthBucket,
} from '@/lib/adoption/rollup'

test('weekStartUtc snaps to the Monday of the ISO week in UTC', () => {
  // 2026-08-24 is a Monday.
  assert.equal(weekKey(weekStartUtc(new Date('2026-08-24T00:00:00Z'))), '2026-08-24')
  assert.equal(weekKey(weekStartUtc(new Date('2026-08-24T23:59:59Z'))), '2026-08-24')
  // Sunday belongs to the week that STARTED the previous Monday, not the next.
  assert.equal(weekKey(weekStartUtc(new Date('2026-08-23T12:00:00Z'))), '2026-08-17')
  assert.equal(weekKey(weekStartUtc(new Date('2026-08-30T00:00:00Z'))), '2026-08-24')
})

test('weekStartUtc uses UTC, not local time', () => {
  // 23:30 UTC Sunday is Monday in +02:00. It must still snap to the previous
  // Monday, or every rollup silently shifts by a day for half the world.
  assert.equal(weekKey(weekStartUtc(new Date('2026-08-23T23:30:00Z'))), '2026-08-17')
})

test('addWeeks moves whole weeks in both directions', () => {
  const monday = weekStartUtc(new Date('2026-08-24T00:00:00Z'))
  assert.equal(weekKey(addWeeks(monday, 1)), '2026-08-31')
  assert.equal(weekKey(addWeeks(monday, -2)), '2026-08-10')
  assert.equal(weekKey(addWeeks(monday, 0)), '2026-08-24')
})

test('completeWeeksBack excludes the in-progress week', () => {
  const weeks = completeWeeksBack(new Date('2026-08-26T10:00:00Z'), 2)
  assert.deepEqual(weeks.map(weekKey), ['2026-08-10', '2026-08-17'])
})

test('weekOffset counts whole weeks between cohort and activity', () => {
  assert.equal(weekOffset('2026-06-01', '2026-06-01'), 0)
  assert.equal(weekOffset('2026-06-01', '2026-06-08'), 1)
  assert.equal(weekOffset('2026-06-01', '2026-08-24'), 12)
})

test('ratio returns null on a zero denominator rather than zero', () => {
  // A week with no runs has NO automation ratio. Rendering 0 would read as
  // "fully manual" -- the opposite of the truth.
  assert.equal(ratio(0, 0), null)
  assert.equal(automationRatio(0, 0), null)
  assert.equal(acceptanceRate(0, 0), null)
  assert.equal(automationRatio(10, 4), 0.6)
  assert.equal(acceptanceRate(8, 2), 0.8)
})

test('buildSurvival keeps never-run agents in the denominator at zero', () => {
  // Three agents created; only one ever ran. Survival must be 1/3, not 1/1.
  const sizes = new Map([['2026-06-01', 3]])
  const rows = [{ agentTaskId: 'a1', cohortWeek: '2026-06-01', activeWeek: '2026-06-08' }]
  const [cohort] = buildSurvival(sizes, rows, 2)

  assert.equal(cohort.cohortWeek, '2026-06-01')
  assert.equal(cohort.size, 3)
  assert.deepEqual(cohort.cells.map((c) => [c.offset, c.active]), [[0, 0], [1, 1], [2, 0]])
  assert.equal(cohort.cells[1].rate, 1 / 3)
})

test('buildSurvival is non-monotonic -- a returning agent counts again', () => {
  // Retention measures activity IN a week, not "ever after". An agent idle in
  // W+1 and active again in W+2 must reappear.
  const sizes = new Map([['2026-06-01', 1]])
  const rows = [
    { agentTaskId: 'a1', cohortWeek: '2026-06-01', activeWeek: '2026-06-01' },
    { agentTaskId: 'a1', cohortWeek: '2026-06-01', activeWeek: '2026-06-15' },
  ]
  const [cohort] = buildSurvival(sizes, rows, 2)
  assert.deepEqual(cohort.cells.map((c) => c.active), [1, 0, 1])
})

test('buildSurvival ignores rows beyond maxOffset and negative offsets', () => {
  const sizes = new Map([['2026-06-01', 1]])
  const rows = [
    { agentTaskId: 'a1', cohortWeek: '2026-06-01', activeWeek: '2026-09-01' }, // far future
    { agentTaskId: 'a2', cohortWeek: '2026-06-01', activeWeek: '2026-05-25' }, // impossible
  ]
  const [cohort] = buildSurvival(sizes, rows, 2)
  assert.deepEqual(cohort.cells.map((c) => c.active), [0, 0, 0])
})

test('buildSurvival returns cohorts oldest first and tolerates an empty cohort', () => {
  const sizes = new Map([['2026-06-08', 1], ['2026-06-01', 0]])
  const out = buildSurvival(sizes, [], 1)
  assert.deepEqual(out.map((c) => c.cohortWeek), ['2026-06-01', '2026-06-08'])
  // Size 0 must not divide by zero.
  assert.equal(out[0].cells[0].rate, 0)
})

test('depthBucket separates a single champion from a real team', () => {
  assert.equal(depthBucket(1), '1')
  assert.equal(depthBucket(4), '2-4')
  assert.equal(depthBucket(9), '5-9')
  assert.equal(depthBucket(10), '10+')
  assert.equal(depthBucket(0), '0')
})
