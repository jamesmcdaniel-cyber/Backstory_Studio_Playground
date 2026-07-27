import { test } from 'node:test'
import assert from 'node:assert/strict'
import { unitMs, computeResumeAt } from '../wait'

test('unitMs converts each unit to milliseconds', () => {
  assert.equal(unitMs('seconds'), 1000)
  assert.equal(unitMs('minutes'), 60_000)
  assert.equal(unitMs('hours'), 3_600_000)
  assert.equal(unitMs('days'), 86_400_000)
})

const NOW = Date.parse('2026-07-27T12:00:00.000Z')

test('duration resume time is now + amount*unit', () => {
  const res = computeResumeAt(NOW, { mode: 'duration', amount: '5', unit: 'minutes' })
  assert.deepEqual(res, { resumeAtMs: NOW + 5 * 60_000 })
})

test('duration rejects a non-numeric amount', () => {
  const res = computeResumeAt(NOW, { mode: 'duration', amount: 'soon', unit: 'minutes' })
  assert.ok('error' in res)
})

test('duration rejects a negative amount', () => {
  const res = computeResumeAt(NOW, { mode: 'duration', amount: '-3', unit: 'hours' })
  assert.ok('error' in res)
})

test('until parses a future timestamp', () => {
  const res = computeResumeAt(NOW, { mode: 'until', until: '2026-07-27T18:00:00.000Z' })
  assert.deepEqual(res, { resumeAtMs: Date.parse('2026-07-27T18:00:00.000Z') })
})

test('until in the past clamps to now (resume immediately)', () => {
  const res = computeResumeAt(NOW, { mode: 'until', until: '2020-01-01T00:00:00.000Z' })
  assert.deepEqual(res, { resumeAtMs: NOW })
})

test('until rejects an unparseable timestamp', () => {
  const res = computeResumeAt(NOW, { mode: 'until', until: 'not a date' })
  assert.ok('error' in res)
})
