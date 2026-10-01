import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { cached, cacheGet, cacheSet, cacheDelete, cacheConfigured, cacheParse, cacheStringify } from '../cache'

// No REDIS_URL in tests → the in-memory backend is exercised. The cache is a
// process singleton, so each test uses distinct keys to stay independent.
beforeEach(() => {
  delete process.env.REDIS_URL
})

test('cacheConfigured reflects REDIS_URL', () => {
  delete process.env.REDIS_URL
  assert.equal(cacheConfigured(), false)
})

test('set then get returns the value; miss returns null', async () => {
  assert.equal(await cacheGet('t1:missing'), null)
  await cacheSet('t1:k', { a: 1 }, 60_000)
  assert.deepEqual(await cacheGet('t1:k'), { a: 1 })
})

test('expired entries (ttl 0) read as a miss', async () => {
  await cacheSet('t2:k', 'v', 0)
  assert.equal(await cacheGet('t2:k'), null)
})

test('del removes an entry', async () => {
  await cacheSet('t3:k', 'v', 60_000)
  await cacheDelete('t3:k')
  assert.equal(await cacheGet('t3:k'), null)
})

test('cached() runs the fetcher once, then serves from cache', async () => {
  let calls = 0
  const fetcher = async () => { calls++; return { n: 42 } }
  const first = await cached('t4:key', 60_000, fetcher)
  const second = await cached('t4:key', 60_000, fetcher)
  assert.deepEqual(first, { n: 42 })
  assert.deepEqual(second, { n: 42 })
  assert.equal(calls, 1)
})

test('cached() does NOT cache null (negatives re-run)', async () => {
  let calls = 0
  const fetcher = async () => { calls++; return null }
  await cached('t5:key', 60_000, fetcher)
  await cached('t5:key', 60_000, fetcher)
  assert.equal(calls, 2)
})

test('the shared-cache wire format round-trips Prisma BigInt fields', () => {
  const row = {
    id: 'org-1',
    storageBytes: 9_007_199_254_740_993n,
    nested: { values: [1n, '1'] },
  }
  const encoded = cacheStringify(row)
  assert.doesNotThrow(() => JSON.parse(encoded))
  assert.deepEqual(cacheParse(encoded), row)
})

test('ordinary strings and objects that only resemble the BigInt tag stay ordinary', () => {
  const value = {
    storageBytes: '123',
    metadata: { $backstoryCacheBigInt: '456', another: true },
  }
  assert.deepEqual(cacheParse(cacheStringify(value)), value)
})
