import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { isRunPickupStalled, NEVER_PICKED_UP_TIMEOUT_MS, NEVER_PICKED_UP_ERROR } from '@/lib/flows/run-stall'

describe('isRunPickupStalled', () => {
  const now = 1_754_400_000_000
  const startedAgo = (ms: number) => new Date(now - ms).toISOString()

  it('a running run with zero steps past the pickup window is stalled', () => {
    assert.equal(
      isRunPickupStalled({ status: 'running', startedAt: startedAgo(NEVER_PICKED_UP_TIMEOUT_MS + 1_000), stepCount: 0 }, now),
      true,
    )
  })

  it('a running run with zero steps inside the window is not stalled yet', () => {
    assert.equal(
      isRunPickupStalled({ status: 'running', startedAt: startedAgo(NEVER_PICKED_UP_TIMEOUT_MS - 1_000), stepCount: 0 }, now),
      false,
    )
  })

  it('a run that recorded any step was picked up — never stalled, however old', () => {
    assert.equal(
      isRunPickupStalled({ status: 'running', startedAt: startedAgo(NEVER_PICKED_UP_TIMEOUT_MS * 4), stepCount: 1 }, now),
      false,
    )
  })

  it('non-running statuses are never pickup-stalled', () => {
    for (const status of ['waiting', 'succeeded', 'failed']) {
      assert.equal(
        isRunPickupStalled({ status, startedAt: startedAgo(NEVER_PICKED_UP_TIMEOUT_MS * 4), stepCount: 0 }, now),
        false,
        status,
      )
    }
  })

  it('an unparseable startedAt is not stalled (fail open — the 30-minute reaper still backstops)', () => {
    assert.equal(isRunPickupStalled({ status: 'running', startedAt: 'garbage', stepCount: 0 }, now), false)
  })

  it('error message explains pickup failure in user terms', () => {
    assert.match(NEVER_PICKED_UP_ERROR, /never picked up/i)
  })
})
