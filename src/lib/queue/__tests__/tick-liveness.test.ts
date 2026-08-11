import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isTickFresh, tickAge, TICK_STALE_MS } from '../tick-liveness'

/**
 * The gap these guard: /api/health reported worker heartbeat freshness but
 * nothing recorded that the SCHEDULING tick ran. A Vercel cron that was paused,
 * deleted, or plan-limited stopped every scheduled flow with no signal at all —
 * the first indication was a user noticing their flow had not run.
 */

test('a tick written just now is fresh', () => {
  const now = Date.now()
  assert.equal(isTickFresh(JSON.stringify({ at: now }), now), true)
})

test('a tick older than the stale window is not fresh', () => {
  const now = Date.now()
  assert.equal(isTickFresh(JSON.stringify({ at: now - TICK_STALE_MS - 1 }), now), false)
})

test('a missing or unparseable value is not fresh', () => {
  const now = Date.now()
  assert.equal(isTickFresh(null, now), false)
  assert.equal(isTickFresh('not json', now), false)
  assert.equal(isTickFresh(JSON.stringify({ at: 'nope' }), now), false)
  assert.equal(isTickFresh(JSON.stringify({}), now), false)
})

test('clock skew into the future counts as fresh, matching the heartbeat rule', () => {
  const now = Date.now()
  assert.equal(isTickFresh(JSON.stringify({ at: now + 5_000 }), now), true)
})

test('tickAge reports milliseconds since the write, or null when unreadable', () => {
  const now = Date.now()
  assert.equal(tickAge(JSON.stringify({ at: now - 1_000 }), now), 1_000)
  assert.equal(tickAge(null, now), null)
  assert.equal(tickAge('not json', now), null)
})

test('the stale window covers several missed cron ticks, not just worker ones', () => {
  // The Vercel cron runs every 15 minutes; a stale verdict must not fire merely
  // because the worker plane is absent and only the cron is driving.
  assert.ok(TICK_STALE_MS >= 45 * 60_000)
})
