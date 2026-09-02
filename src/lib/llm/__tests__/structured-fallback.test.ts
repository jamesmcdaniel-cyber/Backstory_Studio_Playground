import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isProviderAvailabilityError, structuredProviderOrder } from '../model-runner'

test('anthropic configured is the whole order; unconfigured is empty', () => {
  assert.deepEqual(structuredProviderOrder({ defaultModel: 'claude-opus-4-8', anthropic: true }), ['claude'])
  // A non-Claude default has no endpoint of its own any more and still lands on Claude.
  assert.deepEqual(structuredProviderOrder({ defaultModel: 'some-other-model', anthropic: true }), ['claude'])
  assert.deepEqual(structuredProviderOrder({ defaultModel: 'claude-opus-4-8', anthropic: false }), [])
})

test('quota/auth/overload errors are availability failures; schema errors are not', () => {
  assert.equal(isProviderAvailabilityError({ status: 429 }), true) // quota exhausted
  assert.equal(isProviderAvailabilityError({ status: 401 }), true) // bad key
  assert.equal(isProviderAvailabilityError({ status: 529 }), true) // overloaded
  assert.equal(isProviderAvailabilityError({ status: 400 }), false) // our schema/request bug
  assert.equal(isProviderAvailabilityError(new Error('parse failed')), false)
  assert.equal(isProviderAvailabilityError(null), false)
})
