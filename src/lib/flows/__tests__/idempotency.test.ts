import { test } from 'node:test'
import assert from 'node:assert/strict'
import { flowSideEffectKey, withIdempotencyHeader } from '../idempotency'

test('flow side-effect keys are stable per run, iteration, and page', () => {
  assert.equal(flowSideEffectKey('run', 'node#1'), flowSideEffectKey('run', 'node#1'))
  assert.notEqual(flowSideEffectKey('run', 'node#1'), flowSideEffectKey('run', 'node#2'))
  assert.notEqual(flowSideEffectKey('run', 'node#1', 0), flowSideEffectKey('run', 'node#1', 1))
})

test('idempotency headers cover writes and preserve explicit caller keys', () => {
  assert.deepEqual(withIdempotencyHeader({}, 'POST', 'generated'), { 'idempotency-key': 'generated' })
  assert.deepEqual(withIdempotencyHeader({}, 'GET', 'generated'), {})
  assert.deepEqual(withIdempotencyHeader({ 'Idempotency-Key': 'mine' }, 'PATCH', 'generated'), { 'Idempotency-Key': 'mine' })
})
