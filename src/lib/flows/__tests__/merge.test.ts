import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mergeAppend, mergeByKey } from '../merge'

test('mergeAppend concatenates list inputs into one flat list', () => {
  assert.deepEqual(mergeAppend([[1, 2], [3, 4]]), [1, 2, 3, 4])
})

test('mergeAppend wraps non-list inputs as single items', () => {
  assert.deepEqual(mergeAppend(['a', [1, 2]]), ['a', 1, 2])
})

test('mergeAppend parses JSON-string list inputs (step outputs arrive structured or as text)', () => {
  assert.deepEqual(mergeAppend(['["a","b"]', ['c']]), ['a', 'b', 'c'])
})

test('mergeByKey full-outer-joins record lists on a shared key, later wins', () => {
  const a = [{ email: 'x@a.com', name: 'X' }, { email: 'y@a.com', name: 'Y' }]
  const b = [{ email: 'x@a.com', phone: '111' }, { email: 'z@a.com', phone: '999' }]
  assert.deepEqual(mergeByKey([a, b], 'email'), [
    { email: 'x@a.com', name: 'X', phone: '111' },
    { email: 'y@a.com', name: 'Y' },
    { email: 'z@a.com', phone: '999' },
  ])
})

test('mergeByKey keeps records missing the key as their own rows', () => {
  const a = [{ id: 1, v: 'a' }]
  const b = [{ v: 'no-key' }]
  assert.deepEqual(mergeByKey([a, b], 'id'), [{ id: 1, v: 'a' }, { v: 'no-key' }])
})

test('mergeByKey preserves first-seen key order', () => {
  const a = [{ k: 'b' }, { k: 'a' }]
  const b = [{ k: 'a', extra: 1 }]
  assert.deepEqual(mergeByKey([a, b], 'k'), [{ k: 'b' }, { k: 'a', extra: 1 }])
})
