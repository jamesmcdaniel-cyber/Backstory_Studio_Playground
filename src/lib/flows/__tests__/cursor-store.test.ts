import { test } from 'node:test'
import assert from 'node:assert/strict'
import { upsertCursor, pruneCursors, type RemoteCursor } from '../cursor-store'

const cursor = (clientId: string, ts: number): RemoteCursor => ({ clientId, x: 1, y: 2, name: 'A', color: '#111', space: 'inline', ts })

test('upsertCursor replaces an existing client and appends a new one', () => {
  const a1 = cursor('a', 100)
  const withA = upsertCursor([], a1)
  assert.deepEqual(withA, [a1])
  const a2 = { ...a1, x: 9, ts: 200 }
  const updated = upsertCursor(withA, a2)
  assert.equal(updated.length, 1)
  assert.equal(updated[0].x, 9)
  const withB = upsertCursor(updated, cursor('b', 300))
  assert.equal(withB.length, 2)
})

test('pruneCursors drops idle cursors and departed clients', () => {
  const list = [cursor('fresh', 10_000), cursor('stale', 1_000), cursor('gone', 10_000)]
  const out = pruneCursors(list, 12_000, new Set(['fresh', 'stale']), 5_000)
  assert.deepEqual(out.map((c) => c.clientId), ['fresh'])
})
