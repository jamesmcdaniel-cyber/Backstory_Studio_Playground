import { test } from 'node:test'
import assert from 'node:assert/strict'
import { flowTopic, flowOpsTopic, parseFlowTopic, nextJamStatus, worstStatus, retryDelayMs } from '../flow-channels'

test('topics round-trip and reject anything unrecognized', () => {
  assert.equal(flowTopic('f1'), 'flow:f1')
  assert.equal(flowOpsTopic('f1'), 'flow:f1:ops')
  assert.deepEqual(parseFlowTopic('flow:f1'), { flowId: 'f1', kind: 'room' })
  assert.deepEqual(parseFlowTopic('flow:f1:ops'), { flowId: 'f1', kind: 'ops' })
  assert.equal(parseFlowTopic('flow:'), null)
  assert.equal(parseFlowTopic('flow:f1:other'), null)
  assert.equal(parseFlowTopic('agent:f1'), null)
  assert.equal(parseFlowTopic('flow'), null)
})

test('subscribe outcomes map onto a status a human can act on', () => {
  assert.equal(nextJamStatus('connecting', 'SUBSCRIBED'), 'live')
  assert.equal(nextJamStatus('live', 'CHANNEL_ERROR'), 'error')
  assert.equal(nextJamStatus('live', 'TIMED_OUT'), 'degraded')
  assert.equal(nextJamStatus('live', 'CLOSED'), 'degraded')
  assert.equal(nextJamStatus('error', 'SUBSCRIBED'), 'live', 'recovery clears the error')
  assert.equal(nextJamStatus('live', 'SOMETHING_NEW'), 'live', 'unknown statuses change nothing')
})

test('a refused join settles on error rather than flapping', () => {
  let status = nextJamStatus('connecting', 'CHANNEL_ERROR')
  assert.equal(status, 'error')
  status = nextJamStatus(status, 'CHANNEL_ERROR')
  assert.equal(status, 'error')
})

test('the worst of the two channels is what the jam reports', () => {
  assert.equal(worstStatus('live', 'live'), 'live')
  assert.equal(worstStatus('live', 'connecting'), 'connecting')
  assert.equal(worstStatus('degraded', 'connecting'), 'degraded')
  assert.equal(worstStatus('degraded', 'error'), 'error')
  assert.equal(worstStatus('error', 'live'), 'error')
})

test('backoff grows and is capped so a dead channel cannot hot-loop', () => {
  assert.equal(retryDelayMs(0), 1_000)
  assert.equal(retryDelayMs(1), 2_000)
  assert.equal(retryDelayMs(3), 8_000)
  assert.equal(retryDelayMs(10), 30_000)
  assert.ok(retryDelayMs(100) <= 30_000)
})
