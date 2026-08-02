import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  breakerAllows,
  breakerOnFailure,
  breakerOnProbeStart,
  breakerOnSuccess,
  initialBreakerState,
} from '@/lib/rag/circuit-breaker'

const OPTS = { threshold: 2, cooldownMs: 60_000 }

describe('rag circuit breaker', () => {
  it('stays closed below the failure threshold and resets on success', () => {
    let state = initialBreakerState()
    state = breakerOnFailure(state, 1_000, OPTS)
    assert.equal(breakerAllows(state, 1_001).allowed, true)
    state = breakerOnSuccess(state)
    assert.equal(state.consecutiveFailures, 0)
    // A later single failure still doesn't open — the streak restarted.
    state = breakerOnFailure(state, 2_000, OPTS)
    assert.equal(breakerAllows(state, 2_001).allowed, true)
  })

  it('opens at the threshold and refuses calls during the cooldown', () => {
    let state = initialBreakerState()
    state = breakerOnFailure(state, 1_000, OPTS)
    state = breakerOnFailure(state, 2_000, OPTS)
    assert.equal(state.openUntilMs, 62_000)
    assert.deepEqual(breakerAllows(state, 3_000), { allowed: false, probe: false })
    assert.deepEqual(breakerAllows(state, 61_999), { allowed: false, probe: false })
  })

  it('half-opens after the cooldown: one probe, concurrent calls still refused', () => {
    let state = initialBreakerState()
    state = breakerOnFailure(state, 1_000, OPTS)
    state = breakerOnFailure(state, 2_000, OPTS)
    const gate = breakerAllows(state, 62_000)
    assert.deepEqual(gate, { allowed: true, probe: true })
    state = breakerOnProbeStart(state)
    // While the probe is in flight, everyone else fails fast.
    assert.deepEqual(breakerAllows(state, 62_001), { allowed: false, probe: false })
  })

  it('a failed probe re-opens for a fresh cooldown; a successful probe closes fully', () => {
    let state = initialBreakerState()
    state = breakerOnFailure(state, 1_000, OPTS)
    state = breakerOnFailure(state, 2_000, OPTS)
    state = breakerOnProbeStart(state)
    // Probe fails at 70s: open again until 130s even though threshold is 2.
    const reopened = breakerOnFailure(state, 70_000, OPTS)
    assert.equal(reopened.openUntilMs, 130_000)
    assert.equal(reopened.probing, false)
    // Alternate world: probe succeeds — breaker fully closed.
    const closed = breakerOnSuccess(state)
    assert.deepEqual(closed, { consecutiveFailures: 0, openUntilMs: 0, probing: false })
  })
})
