import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scanAll, stalestFirst } from '../scan'

/**
 * The regression these guard: the scheduler used to read one unordered page and
 * treat it as the whole world, so rows outside it were never examined and their
 * schedules silently stopped firing.
 */

function pagedSource(ids: string[]) {
  const calls: Array<{ cursor: string | null; take: number }> = []
  const page = async (cursor: string | null, take: number) => {
    calls.push({ cursor, take })
    const start = cursor === null ? 0 : ids.indexOf(cursor) + 1
    return ids.slice(start, start + take).map((id) => ({ id }))
  }
  return { page, calls }
}

test('every row is examined, across as many pages as it takes', async () => {
  const ids = Array.from({ length: 1207 }, (_, i) => `id-${String(i).padStart(5, '0')}`)
  const { page, calls } = pagedSource(ids)

  const result = await scanAll(page, { pageSize: 100 })

  assert.equal(result.truncated, false)
  assert.equal(result.rows.length, 1207, 'a complete scan means no row is skipped')
  assert.deepEqual(result.rows.map((r) => r.id), ids)
  assert.equal(calls.length, 13, '12 full pages + one short page that ends the scan')
  assert.equal(calls[0].cursor, null)
  assert.equal(calls[1].cursor, 'id-00099', 'each page continues from the last id seen')
})

test('an exactly-full final page still terminates', async () => {
  const ids = Array.from({ length: 200 }, (_, i) => `id-${i}`)
  const { page } = pagedSource(ids)

  const result = await scanAll(page, { pageSize: 100 })

  assert.equal(result.rows.length, 200)
  assert.equal(result.truncated, false, 'the empty page after a full one ends the scan cleanly')
})

test('an empty table scans to nothing without looping', async () => {
  const { page, calls } = pagedSource([])
  const result = await scanAll(page, { pageSize: 50 })

  assert.deepEqual(result.rows, [])
  assert.equal(result.truncated, false)
  assert.equal(calls.length, 1)
})

test('the runaway backstop reports truncation instead of hiding it', async () => {
  const ids = Array.from({ length: 5000 }, (_, i) => `id-${String(i).padStart(5, '0')}`)
  const { page } = pagedSource(ids)

  const result = await scanAll(page, { pageSize: 100, maxRows: 300 })

  assert.equal(result.truncated, true, 'silent truncation is the exact bug being fixed')
  assert.ok(result.rows.length >= 300)
})

test('stalest sorts never-run first, then oldest-run first', () => {
  const rows = [
    { id: 'ran-recently', last: new Date('2026-07-31T10:00:00Z') },
    { id: 'never-run', last: null },
    { id: 'ran-long-ago', last: new Date('2026-07-01T10:00:00Z') },
    { id: 'also-never-run', last: null },
  ]

  const sorted = stalestFirst(rows, (row) => row.last).map((row) => row.id)

  assert.deepEqual(sorted, ['never-run', 'also-never-run', 'ran-long-ago', 'ran-recently'])
})

test('capping the stalest-sorted list rotates the overflow rather than starving it', () => {
  // Three agents, capacity for two per tick. The two stalest go; the third is
  // deferred. Next tick the two that ran have fresh markers, so the deferred one
  // now sorts first — the exact property the old unordered slice(0, N) lacked.
  const agents = [
    { id: 'a', last: new Date('2026-07-31T09:00:00Z') },
    { id: 'b', last: new Date('2026-07-31T08:00:00Z') },
    { id: 'c', last: new Date('2026-07-31T07:00:00Z') },
  ]

  const firstTick = stalestFirst(agents, (a) => a.last).slice(0, 2).map((a) => a.id)
  assert.deepEqual(firstTick, ['c', 'b'])

  const after = agents.map((a) => (firstTick.includes(a.id) ? { ...a, last: new Date('2026-07-31T10:00:00Z') } : a))
  const secondTick = stalestFirst(after, (a) => a.last).slice(0, 2).map((a) => a.id)
  assert.ok(secondTick.includes('a'), 'the deferred agent must win the next tick')
})
