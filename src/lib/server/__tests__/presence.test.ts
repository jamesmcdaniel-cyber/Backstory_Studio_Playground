import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { PRESENCE_WINDOW_MS, resetPresenceCache, shouldRecordPresence } from '../presence'

beforeEach(() => resetPresenceCache())

test('the first sighting of a user always records', () => {
  assert.equal(shouldRecordPresence('user-1', 1_000), true)
})

test('a second request inside the window does not write again', () => {
  const now = 1_000_000
  assert.equal(shouldRecordPresence('user-1', now), true)
  assert.equal(shouldRecordPresence('user-1', now + 1), false)
  assert.equal(shouldRecordPresence('user-1', now + PRESENCE_WINDOW_MS - 1), false)
})

test('a request past the window records again', () => {
  const now = 1_000_000
  assert.equal(shouldRecordPresence('user-1', now), true)
  assert.equal(shouldRecordPresence('user-1', now + PRESENCE_WINDOW_MS), true)
})

test('users are throttled independently', () => {
  const now = 1_000_000
  assert.equal(shouldRecordPresence('user-1', now), true)
  // A busy neighbour must not suppress a different account's first sighting.
  assert.equal(shouldRecordPresence('user-2', now), true)
  assert.equal(shouldRecordPresence('user-1', now + 5), false)
})

test('the cache cannot grow without bound', () => {
  // Far past the 10k cap; the clear-and-continue path must keep answering true
  // rather than throwing or wedging.
  for (let index = 0; index < 10_050; index++) {
    assert.equal(shouldRecordPresence(`user-${index}`, 1_000), true)
  }
})
