import assert from 'node:assert/strict'
import { describe, it, beforeEach } from 'node:test'
import { withBreaker, breakerState, resetBreakers, CircuitOpenError } from '@/lib/resilience/circuit-breaker'

const fail = (message = 'boom') => () => Promise.reject(new Error(message))
const succeed = <T>(value: T) => () => Promise.resolve(value)

/**
 * Drive a circuit to open.
 *
 * `openMs` is passed here because the cooldown is captured when the breaker
 * OPENS, not re-read on each subsequent check — so a later call cannot shorten
 * a window that is already running. Tests that want an elapsed cooldown have to
 * trip it with the short window in the first place.
 */
async function trip(key: string, times: number, openMs = 30_000) {
  for (let i = 0; i < times; i += 1) {
    await withBreaker(key, fail(), { failureThreshold: 3, openMs }).catch(() => undefined)
  }
}

describe('withBreaker', () => {
  beforeEach(() => resetBreakers())

  it('passes calls through while closed', async () => {
    assert.equal(await withBreaker('dep', succeed('ok')), 'ok')
    assert.equal(breakerState('dep'), 'closed')
  })

  it('opens after the threshold and then refuses without calling through', async () => {
    await trip('dep', 3)
    assert.equal(breakerState('dep'), 'open')

    let called = false
    await assert.rejects(
      withBreaker('dep', () => { called = true; return Promise.resolve('x') }, { failureThreshold: 3, openMs: 30_000 }),
      CircuitOpenError,
    )
    // The whole point: the dependency is not dialled at all. A breaker that
    // still made the call would save nothing — these dependencies fail by
    // getting slow, and the cost being avoided is the wait, not the error.
    assert.equal(called, false, 'an open circuit must not call through')
  })

  it('reports how long to wait, so callers can surface a Retry-After', async () => {
    await trip('dep', 3)
    const error = await withBreaker('dep', succeed('x'), { failureThreshold: 3, openMs: 30_000 })
      .catch((caught) => caught as CircuitOpenError)
    assert.ok(error instanceof CircuitOpenError)
    assert.ok(error.retryAfterMs > 0 && error.retryAfterMs <= 30_000)
    assert.equal(error.dependency, 'dep')
  })

  it('a single success resets the count, so intermittent errors never accumulate', async () => {
    await trip('dep', 2)
    await withBreaker('dep', succeed('ok'), { failureThreshold: 3 })
    await trip('dep', 2)
    assert.equal(breakerState('dep'), 'closed')
  })

  it('admits one probe after the cooldown, and closes on success', async () => {
    await trip('dep', 3, 0)
    // openMs of 0 means the cooldown has already elapsed by the next call.
    assert.equal(await withBreaker('dep', succeed('ok'), { failureThreshold: 3, openMs: 0 }), 'ok')
    assert.equal(breakerState('dep'), 'closed')
  })

  it('re-opens when the probe fails', async () => {
    await trip('dep', 3, 0)
    await withBreaker('dep', fail(), { failureThreshold: 3, openMs: 0 }).catch(() => undefined)
    assert.notEqual(breakerState('dep', Date.now()), 'closed')
  })

  it('isolates keys — one sick dependency does not refuse another', async () => {
    // The reason Nango is keyed per connection: one workspace's expired
    // credential must not stop Slack for every other workspace.
    await trip('nango:slack:conn_a', 3)
    assert.equal(breakerState('nango:slack:conn_a'), 'open')
    assert.equal(await withBreaker('nango:slack:conn_b', succeed('ok')), 'ok')
  })

  it('does not count errors isFailure rejects', async () => {
    const options = { failureThreshold: 2, isFailure: (error: unknown) => (error as Error).message !== 'not-found' }
    for (let i = 0; i < 5; i += 1) {
      await withBreaker('dep', fail('not-found'), options).catch(() => undefined)
    }
    // A 404 is a fact about the request. Counting it would let one bad flow
    // step take an integration down for the whole workspace.
    assert.equal(breakerState('dep'), 'closed')
  })

  it('releases the probe slot when isFailure rejects the probe error', async () => {
    // Regression guard: an ignored error during a half-open probe must still
    // clear `probing`, or the circuit refuses every call forever afterwards.
    const options = { failureThreshold: 2, openMs: 0, isFailure: (error: unknown) => (error as Error).message !== 'ignored' }
    await withBreaker('dep', fail(), { failureThreshold: 2, openMs: 0 }).catch(() => undefined)
    await withBreaker('dep', fail(), { failureThreshold: 2, openMs: 0 }).catch(() => undefined)
    await withBreaker('dep', fail('ignored'), options).catch(() => undefined)
    assert.equal(await withBreaker('dep', succeed('ok'), options), 'ok')
  })

  it('does not let a nested open circuit trip the outer one', async () => {
    await trip('inner', 3)
    for (let i = 0; i < 10; i += 1) {
      await withBreaker('outer', () => withBreaker('inner', succeed('x'), { failureThreshold: 3 }), { failureThreshold: 3 })
        .catch(() => undefined)
    }
    // Otherwise one sick dependency cascades every breaker wrapping it open,
    // over calls that were never actually attempted.
    assert.equal(breakerState('outer'), 'closed')
  })
})
