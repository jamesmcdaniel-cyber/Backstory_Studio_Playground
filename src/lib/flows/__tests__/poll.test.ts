import { test } from 'node:test'
import assert from 'node:assert/strict'
import { newPollItems, pollItemKey } from '../poll'

test('the first poll (no cursor) establishes a baseline and emits nothing', () => {
  const items = [{ id: 'a' }, { id: 'b' }]
  const res = newPollItems(items, 'id', undefined)
  assert.deepEqual(res.fresh, [])
  assert.deepEqual(new Set(res.nextCursor.seen), new Set(['a', 'b']))
})

test('a later poll emits only items whose key was not seen before', () => {
  const res = newPollItems([{ id: 'a' }, { id: 'b' }, { id: 'c' }], 'id', { seen: ['a', 'b'] })
  assert.deepEqual(res.fresh, [{ id: 'c' }])
  assert.ok(res.nextCursor.seen.includes('c'))
})

test('nothing new emits nothing and leaves the baseline intact', () => {
  const res = newPollItems([{ id: 'a' }], 'id', { seen: ['a'] })
  assert.deepEqual(res.fresh, [])
})

test('the seen cursor is bounded (keeps the most recent keys)', () => {
  const cursor = { seen: Array.from({ length: 1000 }, (_, i) => `old${i}`) }
  const res = newPollItems([{ id: 'new' }], 'id', cursor)
  assert.deepEqual(res.fresh, [{ id: 'new' }])
  assert.ok(res.nextCursor.seen.length <= 1000)
  assert.ok(res.nextCursor.seen.includes('new')) // the newest key is retained
})

test('pollItemKey falls back to a stable hash when the key field is absent', () => {
  const k1 = pollItemKey({ name: 'x' }, 'id')
  const k2 = pollItemKey({ name: 'x' }, 'id')
  assert.equal(k1, k2) // deterministic
  assert.notEqual(k1, pollItemKey({ name: 'y' }, 'id'))
})
