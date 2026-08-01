import { test } from 'node:test'
import assert from 'node:assert/strict'
import { reduceHuddleSignal } from '../huddle-signals'

test('a re-offer from a known peer is applied to the existing connection', () => {
  // The ICE-restart path: we already have `peer-a`, and it re-offers.
  const instructions = reduceHuddleSignal('self', true, ['peer-a'], {
    kind: 'offer',
    from: 'peer-a',
    to: 'self',
    sdp: { type: 'offer' },
  })
  assert.deepEqual(instructions, [{ action: 'apply-offer', peerId: 'peer-a', sdp: { type: 'offer' } }])
})

test('a restart offer addressed to someone else is ignored', () => {
  assert.deepEqual(
    reduceHuddleSignal('self', true, ['peer-a'], { kind: 'offer', from: 'peer-a', to: 'peer-b', sdp: {} }),
    [],
  )
})
