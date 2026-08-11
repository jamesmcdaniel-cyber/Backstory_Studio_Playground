import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runWithLock, TICK_LOCK_KEY, TICK_LOCK_TTL_MS } from '../tick-lock'

/**
 * The regression these guard: the dispatch tick now has TWO callers (the Vercel
 * cron and the worker's 60s timer). Without mutual exclusion both planes scan
 * and both dispatch, and the overlap guard they share is a read-then-act check
 * that cannot stop a true race.
 */

/** Minimal fake of the two ioredis calls the lock uses. */
function fakeRedis() {
  const store = new Map<string, string>()
  return {
    store,
    async set(key: string, value: string, _px: 'PX', _ttl: number, _nx: 'NX') {
      if (store.has(key)) return null
      store.set(key, value)
      return 'OK'
    },
    async eval(_script: string, _numKeys: number, key: string, token: string) {
      if (store.get(key) === token) {
        store.delete(key)
        return 1
      }
      return 0
    },
  }
}

test('a second concurrent caller is refused while the first holds the lock', async () => {
  const redis = fakeRedis()
  let inner = 0
  let release: (() => void) | null = null
  const held = new Promise<void>((resolve) => {
    release = resolve
  })

  const first = runWithLock(redis as never, 'tok-1', async () => {
    inner += 1
    await held
    return 'first'
  })
  const second = await runWithLock(redis as never, 'tok-2', async () => {
    inner += 1
    return 'second'
  })

  assert.deepEqual(second, { skipped: 'locked' })
  assert.equal(inner, 1)
  release!()
  assert.equal(await first, 'first')
})

test('the lock is released after the body runs, so the next caller acquires it', async () => {
  const redis = fakeRedis()
  assert.equal(await runWithLock(redis as never, 'tok-1', async () => 'a'), 'a')
  assert.equal(redis.store.size, 0)
  assert.equal(await runWithLock(redis as never, 'tok-2', async () => 'b'), 'b')
})

test('a body that throws still releases the lock', async () => {
  const redis = fakeRedis()
  await assert.rejects(
    runWithLock(redis as never, 'tok-1', async () => {
      throw new Error('boom')
    }),
  )
  assert.equal(redis.store.size, 0)
})

test('a token that no longer matches does not delete a successor lock', async () => {
  const redis = fakeRedis()
  // Simulate: our tick overran its TTL, the key expired, a successor took it.
  const slow = runWithLock(redis as never, 'tok-1', async () => {
    redis.store.set(TICK_LOCK_KEY, 'tok-successor')
    return 'slow'
  })
  assert.equal(await slow, 'slow')
  assert.equal(redis.store.get(TICK_LOCK_KEY), 'tok-successor')
})

test('a failing release never surfaces as a tick failure', async () => {
  const redis = {
    async set() {
      return 'OK'
    },
    async eval() {
      throw new Error('redis gone')
    },
  }
  assert.equal(await runWithLock(redis as never, 'tok-1', async () => 'value'), 'value')
})

test('the TTL exceeds the 60s worker interval so an overrunning tick blocks its successor', () => {
  assert.ok(TICK_LOCK_TTL_MS > 60_000)
})
