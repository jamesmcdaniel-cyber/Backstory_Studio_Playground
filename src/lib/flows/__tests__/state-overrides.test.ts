import test from 'node:test'
import assert from 'node:assert/strict'
import { parseStateOverrides, resolveOverride } from '@/lib/flows/state-overrides'

test('an exact iteration key wins over the bare node key', () => {
  const overrides = { fetch: 'all-iterations', 'fetch#2': 'just-two' }
  assert.deepEqual(resolveOverride(overrides, 'fetch#2'), { hit: true, value: 'just-two' })
})

test('a bare node key applies to every iteration of that node', () => {
  const overrides = { fetch: 'all-iterations' }
  assert.deepEqual(resolveOverride(overrides, 'fetch#0'), { hit: true, value: 'all-iterations' })
  assert.deepEqual(resolveOverride(overrides, 'fetch#7'), { hit: true, value: 'all-iterations' })
  assert.deepEqual(resolveOverride(overrides, 'fetch'), { hit: true, value: 'all-iterations' })
})

test('an unrelated node is not overridden', () => {
  assert.deepEqual(resolveOverride({ fetch: 1 }, 'transform'), { hit: false, value: undefined })
  assert.deepEqual(resolveOverride({ fetch: 1 }, 'fetcher'), { hit: false, value: undefined })
})

test('a null override is a hit, not a miss', () => {
  // Distinguishing "override this to null" from "no override" matters: a step
  // legitimately yielding null must be expressible.
  assert.deepEqual(resolveOverride({ fetch: null }, 'fetch'), { hit: true, value: null })
})

test('resolveOverride tolerates no overrides at all', () => {
  assert.deepEqual(resolveOverride(null, 'fetch'), { hit: false, value: undefined })
})

test('inherited Object properties are not mistaken for overrides', () => {
  // A node genuinely named "constructor" or "toString" must not resolve to
  // Object.prototype's member.
  assert.deepEqual(resolveOverride({ fetch: 1 }, 'constructor'), { hit: false, value: undefined })
  assert.deepEqual(resolveOverride({ fetch: 1 }, 'toString'), { hit: false, value: undefined })
})

test('parseStateOverrides accepts a plain object and rejects everything else', () => {
  assert.deepEqual(parseStateOverrides({ fetch: 1 }), { fetch: 1 })
  assert.equal(parseStateOverrides(null), null)
  assert.equal(parseStateOverrides([1, 2]), null)
  assert.equal(parseStateOverrides('nope'), null)
  assert.equal(parseStateOverrides({}), null)
})
