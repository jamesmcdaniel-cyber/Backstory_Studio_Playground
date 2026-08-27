import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRateLimiter } from '../ratelimit'

test('allows up to the limit inside the window', async () => {
  const now = 1_000_000
  const limiter = createRateLimiter({ now: () => now })
  for (let i = 0; i < 3; i++) {
    const result = await limiter.check('key-a', { limit: 3, windowMs: 60_000 })
    assert.equal(result.ok, true, `call ${i + 1} should pass`)
  }
})

test('rejects the call after the limit with a retry hint', async () => {
  const now = 1_000_000
  const limiter = createRateLimiter({ now: () => now })
  for (let i = 0; i < 3; i++) await limiter.check('key-b', { limit: 3, windowMs: 60_000 })
  const rejected = await limiter.check('key-b', { limit: 3, windowMs: 60_000 })
  assert.equal(rejected.ok, false)
  assert.ok((rejected.retryAfterMs ?? 0) > 0, 'retryAfterMs should be positive')
})

test('window slides: old calls expire and requests pass again', async () => {
  let now = 1_000_000
  const limiter = createRateLimiter({ now: () => now })
  for (let i = 0; i < 3; i++) await limiter.check('key-c', { limit: 3, windowMs: 60_000 })
  now += 60_001
  const result = await limiter.check('key-c', { limit: 3, windowMs: 60_000 })
  assert.equal(result.ok, true)
})

test('keys are independent', async () => {
  const now = 1_000_000
  const limiter = createRateLimiter({ now: () => now })
  for (let i = 0; i < 3; i++) await limiter.check('key-d', { limit: 3, windowMs: 60_000 })
  const other = await limiter.check('key-e', { limit: 3, windowMs: 60_000 })
  assert.equal(other.ok, true)
})
