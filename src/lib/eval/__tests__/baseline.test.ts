import test from 'node:test'
import assert from 'node:assert/strict'
import { compareToBaseline, REGRESSION_TOLERANCE, ABSOLUTE_FLOOR } from '@/lib/eval/baseline'

test('a scorecard matching its baseline passes', () => {
  const result = compareToBaseline({ a: 0.9, b: 0.85 }, { a: 0.9, b: 0.85 })
  assert.equal(result.ok, true)
  assert.deepEqual(result.failures, [])
})

test('a drop beyond the tolerance fails and names the fixture', () => {
  const result = compareToBaseline({ a: 0.9 - REGRESSION_TOLERANCE - 0.01 }, { a: 0.9 })
  assert.equal(result.ok, false)
  assert.equal(result.failures.length, 1)
  assert.match(result.failures[0], /^a\b/)
})

test('a drop within the tolerance passes, since judge scores are noisy', () => {
  const result = compareToBaseline({ a: 0.9 - REGRESSION_TOLERANCE + 0.01 }, { a: 0.9 })
  assert.equal(result.ok, true)
})

test('an improvement never fails', () => {
  const result = compareToBaseline({ a: 1 }, { a: 0.7 })
  assert.equal(result.ok, true)
})

test('the corpus mean must clear the absolute floor even with no baseline drop', () => {
  const low = ABSOLUTE_FLOOR - 0.1
  const result = compareToBaseline({ a: low, b: low }, { a: low, b: low })
  assert.equal(result.ok, false)
  assert.ok(result.failures.some((failure) => /corpus mean/i.test(failure)))
})

test('a fixture with no baseline is not a regression but still counts toward the mean', () => {
  const result = compareToBaseline({ a: 0.9, brandNew: 0.95 }, { a: 0.9 })
  assert.equal(result.ok, true)
  assert.ok(Math.abs(result.corpusMean - 0.925) < 1e-9)
})

test('corpusMean is the arithmetic mean of the scorecard', () => {
  const result = compareToBaseline({ a: 0.8, b: 1 }, { a: 0.8, b: 1 })
  assert.ok(Math.abs(result.corpusMean - 0.9) < 1e-9)
})

test('an empty scorecard fails rather than vacuously passing', () => {
  // A broken harness that scores nothing must not read as a clean bill of health.
  const result = compareToBaseline({}, {})
  assert.equal(result.ok, false)
  assert.equal(result.corpusMean, 0)
})
