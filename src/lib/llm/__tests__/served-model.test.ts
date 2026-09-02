import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveServedModel } from '../model-runner'

/**
 * With Anthropic as the only endpoint the UI id IS the wire id, so this is the
 * identity — kept (and pinned) as a named seam because ledger attribution keys
 * on the SERVED id, and a future second endpoint would need the alias→wire
 * mapping back in exactly this spot.
 */
test('the served model IS the requested id', () => {
  assert.equal(resolveServedModel({ target: 'claude', model: 'claude-sonnet-5' }), 'claude-sonnet-5')
  assert.equal(resolveServedModel({ target: 'claude', model: 'claude-opus-4-8' }), 'claude-opus-4-8')
})
