import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nextPeerAction, recoveryDelayMs, PEER_GRACE_MS, PEER_MAX_RESTARTS } from '../peer-recovery'

test('healthy states never act', () => {
  for (const state of ['new', 'connecting', 'connected'] as const) {
    assert.equal(nextPeerAction(state, 0, true), 'wait', state)
  }
})

test('only the initiator restarts, so both sides never restart at once', () => {
  assert.equal(nextPeerAction('disconnected', 0, true), 'restart-ice')
  assert.equal(nextPeerAction('disconnected', 0, false), 'wait')
  assert.equal(nextPeerAction('failed', 0, true), 'restart-ice')
  assert.equal(nextPeerAction('failed', 0, false), 'wait')
})

test('the peer is closed once restarts are exhausted, whoever we are', () => {
  assert.equal(nextPeerAction('failed', PEER_MAX_RESTARTS, true), 'close')
  assert.equal(nextPeerAction('failed', PEER_MAX_RESTARTS, false), 'close')
})

test('an explicitly closed connection is always closed out', () => {
  assert.equal(nextPeerAction('closed', 0, true), 'close')
})

test('the first disconnect waits out a grace period; later attempts back off', () => {
  assert.equal(recoveryDelayMs('disconnected', 0), PEER_GRACE_MS)
  assert.equal(recoveryDelayMs('failed', 0), 0) // failed is terminal, no point waiting
  assert.equal(recoveryDelayMs('disconnected', 1), 1_000)
  assert.equal(recoveryDelayMs('disconnected', 2), 4_000)
  assert.equal(recoveryDelayMs('disconnected', 9), 4_000)
})
