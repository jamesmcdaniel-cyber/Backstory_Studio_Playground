import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  isHeartbeatFresh,
  consumerAliveVerdict,
  WORKER_HEARTBEAT_STALE_MS,
  WORKER_HEARTBEAT_INTERVAL_MS,
  EXECUTION_BACKEND_OFFLINE_MESSAGE,
} from '@/lib/queue/heartbeat'

describe('isHeartbeatFresh', () => {
  const now = 1_754_400_000_000

  it('accepts a heartbeat written just now', () => {
    assert.equal(isHeartbeatFresh(String(now - 1_000), now), true)
  })

  it('accepts a heartbeat right at the staleness boundary', () => {
    assert.equal(isHeartbeatFresh(String(now - WORKER_HEARTBEAT_STALE_MS), now), true)
  })

  it('rejects a heartbeat older than the staleness window', () => {
    assert.equal(isHeartbeatFresh(String(now - WORKER_HEARTBEAT_STALE_MS - 1), now), false)
  })

  it('rejects a missing heartbeat — a worker that never booted must read as offline', () => {
    assert.equal(isHeartbeatFresh(null, now), false)
  })

  it('rejects a garbage heartbeat value', () => {
    assert.equal(isHeartbeatFresh('not-a-timestamp', now), false)
  })

  it('accepts a slightly-future heartbeat (clock skew between writer and reader)', () => {
    assert.equal(isHeartbeatFresh(String(now + 5_000), now), true)
  })

  it('staleness window survives several missed write intervals', () => {
    // The gate must not flap during a normal deploy: one or two missed 30s
    // writes (a restarting worker) stay inside the 2-minute window.
    assert.ok(WORKER_HEARTBEAT_STALE_MS >= WORKER_HEARTBEAT_INTERVAL_MS * 3)
  })

  it('offline message names the user-visible failure', () => {
    assert.match(EXECUTION_BACKEND_OFFLINE_MESSAGE, /execution backend is offline/i)
  })
})

describe('consumerAliveVerdict', () => {
  it('a fresh heartbeat is sufficient on its own', () => {
    assert.equal(consumerAliveVerdict(true, null), true)
    assert.equal(consumerAliveVerdict(true, 0), true)
  })

  it('no heartbeat but registered consumers → alive (worker image predating the heartbeat, DR restore)', () => {
    assert.equal(consumerAliveVerdict(false, 1), true)
  })

  it('no heartbeat and zero registered consumers → dead (the stranding outage)', () => {
    assert.equal(consumerAliveVerdict(false, 0), false)
  })

  it('no heartbeat and the consumer probe unreadable → dead (fail closed)', () => {
    assert.equal(consumerAliveVerdict(false, null), false)
  })
})
