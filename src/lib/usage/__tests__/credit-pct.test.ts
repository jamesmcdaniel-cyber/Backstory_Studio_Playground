import { test } from 'node:test'
import assert from 'node:assert/strict'
import { creditUsagePct } from '../credit-pct'

/**
 * The sidebar's "% of credits" bar, extracted to a pure function so the math
 * — and its edge cases — can be pinned without rendering the component.
 */

test('a normal fraction rounds to the nearest whole percent', () => {
  assert.equal(creditUsagePct(5_000_000, 20_000_000), 25)
  assert.equal(creditUsagePct(1, 3), 33)
})

test('usage at or over the budget clamps to 100, never over', () => {
  assert.equal(creditUsagePct(20_000_000, 20_000_000), 100)
  assert.equal(creditUsagePct(50_000_000, 20_000_000), 100)
})

test('a missing or zero budget renders 0%, never NaN or Infinity', () => {
  assert.equal(creditUsagePct(5_000_000, 0), 0)
  assert.equal(creditUsagePct(5_000_000, null), 0)
  assert.equal(creditUsagePct(5_000_000, undefined), 0)
})

test('zero usage against a real budget is 0%', () => {
  assert.equal(creditUsagePct(0, 20_000_000), 0)
})

test('negative or non-finite inputs never leak through as NaN/Infinity', () => {
  assert.equal(creditUsagePct(-5, 20_000_000), 0)
  assert.equal(creditUsagePct(NaN, 20_000_000), 0)
  assert.equal(creditUsagePct(5, NaN), 0)
})
