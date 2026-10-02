import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mapConcurrent } from '../map-concurrent'
import { withReadCircuit, type Cache } from '../cache'

test('bounded concurrency preserves input order', async () => {
  let active = 0, peak = 0
  const output = await mapConcurrent([1, 2, 3, 4, 5], 2, async value => {
    peak = Math.max(peak, ++active)
    await new Promise(resolve => setTimeout(resolve, 6 - value))
    active--
    return value * 2
  })
  assert.equal(peak, 2)
  assert.deepEqual(output, [2, 4, 6, 8, 10])
})

test('cache outage bypasses reads and fills but never drops invalidation', async () => {
  let now = 100, gets = 0, sets = 0, deletes = 0, failed = true
  const backend: Cache = {
    async get<T>() { gets++; if (failed) throw Error('offline'); return 'fresh' as T },
    async set() { sets++ }, async del() { deletes++ }, async incrBy() { return 1 },
  }
  const cache = withReadCircuit(backend, () => now)
  await assert.rejects(cache.get('key'), /offline/)
  assert.equal(await cache.get('key'), null)
  await cache.set('key', 'value', 1000)
  await cache.del('key')
  assert.deepEqual({ gets, sets, deletes }, { gets: 1, sets: 0, deletes: 1 })
  now += 15_001; failed = false
  assert.equal(await cache.get('key'), 'fresh')
  await cache.set('key', 'value', 1000)
  assert.equal(sets, 1)
})

test('only one recovery cache probe runs at a time', async () => {
  let now = 0, calls = 0
  let finish!: (value: unknown) => void
  const backend: Cache = {
    async get<T>() { if (++calls === 1) throw Error('offline'); return await new Promise<unknown>(resolve => { finish = resolve }) as T },
    async set() {}, async del() {}, async incrBy() { return 1 },
  }
  const cache = withReadCircuit(backend, () => now)
  await assert.rejects(cache.get('key'))
  now = 15_001
  const first = cache.get('key')
  assert.equal(await cache.get('key'), null)
  finish('recovered')
  assert.equal(await first, 'recovered')
  assert.equal(calls, 2)
})
